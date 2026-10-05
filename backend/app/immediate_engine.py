"""Immediate-start campaign engine — parallel sender lanes, no limits."""

import asyncio
import json
import logging
from datetime import datetime, timezone

from app import evolution
from app.contact_import import render_template
from app.db import SessionLocal
from app.models import (
    Account,
    Campaign,
    CampaignEvent,
    CampaignRun,
    ImmediateSession,
    UploadedContact,
)
from app.ws import manager

logger = logging.getLogger(__name__)

_active_tasks: dict[int, asyncio.Task] = {}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _get_contact_dict(uc: UploadedContact | None, phone: str) -> dict:
    if uc:
        return {
            "first_name": uc.first_name or "",
            "last_name": uc.last_name or "",
            "name": uc.name or "",
            "email": uc.email or "",
            "phone": uc.phone or phone,
            "country_code": uc.country_code or "",
            "whatsapp_copy": uc.whatsapp_copy or "",
            "extra": uc.extra,
        }
    return {"phone": phone, "name": "", "first_name": "", "last_name": "", "email": "", "whatsapp_copy": ""}


async def _broadcast_progress(session_id: int, campaign_id: int, data: dict):
    await manager.broadcast("immediate.progress", {
        "session_id": session_id,
        "campaign_id": campaign_id,
        "data": data,
    })


async def _send_one(
    instance_name: str,
    phone: str,
    text: str,
    account_id: int,
    run: CampaignRun,
    node: dict,
    variant_idx: int,
    db,
) -> bool:
    jid = phone + "@s.whatsapp.net" if "@" not in phone else phone
    try:
        result = await evolution.send_text(instance_name, jid, text)
        wa_msg_id = (result.get("key") or {}).get("id")
        db.add(CampaignEvent(
            run_id=run.id,
            campaign_id=run.campaign_id,
            account_id=account_id,
            node_id=node["id"],
            kind="sent",
            variant_index=variant_idx,
            detail=wa_msg_id,
        ))
        run.last_sent_at = _utcnow()
        return True
    except Exception as exc:
        logger.warning("Immediate send failed run %d: %s", run.id, exc)
        db.add(CampaignEvent(
            run_id=run.id,
            campaign_id=run.campaign_id,
            account_id=account_id,
            node_id=node["id"],
            kind="failed",
            detail=str(exc)[:500],
        ))
        return False


async def _sender_lane(
    session_id: int,
    campaign_id: int,
    account_id: int,
    contact_ids: list[int],
    node: dict,
    node_index: int,
    delay: int,
    variant_counter: int,
) -> dict:
    """Process one sender's contacts for one message node. Returns stats."""
    db = SessionLocal()
    sent = 0
    failed = 0
    try:
        acc = db.get(Account, account_id)
        if not acc or acc.status != "connected":
            return {"sent": 0, "failed": len(contact_ids), "account_id": account_id}

        variants = node.get("variants", [])
        if not variants:
            return {"sent": 0, "failed": 0, "account_id": account_id}

        for i, cid in enumerate(contact_ids):
            db.expire_all()
            sess = db.get(ImmediateSession, session_id)
            if not sess or sess.status == "paused":
                while sess and sess.status == "paused":
                    db.close()
                    await asyncio.sleep(2)
                    db = SessionLocal()
                    sess = db.get(ImmediateSession, session_id)
                if not sess or sess.status not in ("running", "paused"):
                    break
                # Reload account from the new db session
                acc = db.get(Account, account_id)
                if not acc or acc.status != "connected":
                    return {"sent": sent, "failed": failed + len(contact_ids) - i, "account_id": account_id}

            if sess.status not in ("running",):
                break

            uc = db.get(UploadedContact, cid)
            if not uc:
                failed += 1
                continue

            run = db.query(CampaignRun).filter_by(
                campaign_id=campaign_id, phone=uc.phone
            ).first()

            if run and run.status == "replied":
                await _broadcast_progress(session_id, campaign_id, {
                    "kind": "contact_skipped",
                    "node_index": node_index,
                    "account_id": account_id,
                    "contact_id": cid,
                    "phone": uc.phone,
                    "name": uc.name or uc.phone,
                    "reason": "replied",
                })
                continue

            if not run:
                run = CampaignRun(
                    campaign_id=campaign_id,
                    account_id=account_id,
                    phone=uc.phone,
                    jid=uc.phone + "@s.whatsapp.net",
                    uploaded_contact_id=cid,
                    status="active",
                    node_id=node["id"],
                )
                db.add(run)
                db.flush()

            vi = (variant_counter + i) % len(variants)
            contact = _get_contact_dict(uc, uc.phone)
            text = render_template(variants[vi], contact)

            ok = await _send_one(acc.instance_name, uc.phone, text, account_id, run, node, vi, db)

            if ok:
                sent += 1
                run.node_id = node["id"]
                run.status = "active"
                await _broadcast_progress(session_id, campaign_id, {
                    "kind": "contact_sent",
                    "node_index": node_index,
                    "account_id": account_id,
                    "contact_id": cid,
                    "phone": uc.phone,
                    "name": uc.name or uc.phone,
                    "sent": sent,
                    "failed": failed,
                    "total": len(contact_ids),
                })
            else:
                failed += 1
                run.status = "failed"
                await _broadcast_progress(session_id, campaign_id, {
                    "kind": "contact_failed",
                    "node_index": node_index,
                    "account_id": account_id,
                    "contact_id": cid,
                    "phone": uc.phone,
                    "name": uc.name or uc.phone,
                    "sent": sent,
                    "failed": failed,
                    "total": len(contact_ids),
                })

            db.commit()

            if i < len(contact_ids) - 1:
                await asyncio.sleep(delay)

    except Exception as exc:
        logger.exception("Sender lane error session=%d account=%d: %s", session_id, account_id, exc)
    finally:
        db.close()

    return {"sent": sent, "failed": failed, "account_id": account_id}


async def run_immediate(session_id: int) -> None:
    """Main immediate campaign execution — runs all nodes sequentially, senders in parallel."""
    db = SessionLocal()
    try:
        sess = db.get(ImmediateSession, session_id)
        if not sess:
            return

        config = json.loads(sess.config)
        campaign = db.get(Campaign, sess.campaign_id)
        if not campaign:
            sess.status = "failed"
            db.commit()
            return

        nodes = json.loads(campaign.nodes) if campaign.nodes else []
        delay = config.get("delay", 10)
        sender_assignments = config.get("sender_assignments", [])
        # [{account_id, contact_ids: [int]}]

        progress: dict = {"nodes": [], "replied_contacts": []}
        sess.status = "running"
        db.commit()

        await _broadcast_progress(session_id, sess.campaign_id, {
            "kind": "started",
            "total_nodes": len(nodes),
        })

        variant_counter = 0

        for ni, node in enumerate(nodes):
            # Fresh read — previous iteration may have committed from a
            # different path (wait loop, sender lanes) leaving stale cache.
            db.expire_all()
            sess = db.get(ImmediateSession, session_id)
            if not sess or sess.status not in ("running", "paused"):
                break

            sess.current_node_index = ni
            db.commit()

            ntype = node.get("type")

            if ntype == "message":
                await _broadcast_progress(session_id, sess.campaign_id, {
                    "kind": "node_start",
                    "node_index": ni,
                    "node_type": "message",
                    "node_id": node["id"],
                })

                tasks = []
                for sa in sender_assignments:
                    # Expire again so replied-during-wait contacts are visible
                    db.expire_all()
                    active_contacts = []
                    for cid in sa["contact_ids"]:
                        uc = db.get(UploadedContact, cid)
                        if not uc:
                            continue
                        run = db.query(CampaignRun).filter_by(
                            campaign_id=sess.campaign_id, phone=uc.phone
                        ).first()
                        if run and run.status == "replied":
                            continue
                        active_contacts.append(cid)

                    tasks.append(_sender_lane(
                        session_id=session_id,
                        campaign_id=sess.campaign_id,
                        account_id=sa["account_id"],
                        contact_ids=active_contacts,
                        node=node,
                        node_index=ni,
                        delay=delay,
                        variant_counter=variant_counter,
                    ))

                results = await asyncio.gather(*tasks, return_exceptions=True)

                db.expire_all()
                node_stats = {"node_index": ni, "node_id": node["id"], "type": "message", "senders": []}
                for r in results:
                    if isinstance(r, Exception):
                        logger.error("Lane exception: %s", r)
                        node_stats["senders"].append({"sent": 0, "failed": 0, "error": str(r)})
                    else:
                        node_stats["senders"].append(r)

                progress["nodes"].append(node_stats)
                sess.progress = json.dumps(progress)
                db.commit()

                total_sent = sum(s.get("sent", 0) for s in node_stats["senders"] if isinstance(s, dict))
                total_failed = sum(s.get("failed", 0) for s in node_stats["senders"] if isinstance(s, dict))

                await _broadcast_progress(session_id, sess.campaign_id, {
                    "kind": "node_complete",
                    "node_index": ni,
                    "node_type": "message",
                    "node_id": node["id"],
                    "sent": total_sent,
                    "failed": total_failed,
                })

                variant_counter += max(len(sa.get("contact_ids", [])) for sa in sender_assignments) if sender_assignments else 0

            elif ntype == "wait":
                amount = node.get("amount", 1)
                unit = node.get("unit", "hours")
                wait_seconds = amount * (60 if unit == "minutes" else 3600 if unit == "hours" else 86400)

                await _broadcast_progress(session_id, sess.campaign_id, {
                    "kind": "node_start",
                    "node_index": ni,
                    "node_type": "wait",
                    "node_id": node["id"],
                    "wait_seconds": wait_seconds,
                })

                # Update all active runs to waiting status
                for sa in sender_assignments:
                    for cid in sa["contact_ids"]:
                        uc = db.get(UploadedContact, cid)
                        if not uc:
                            continue
                        run = db.query(CampaignRun).filter_by(
                            campaign_id=sess.campaign_id, phone=uc.phone
                        ).first()
                        if run and run.status == "active":
                            run.status = "waiting"
                            run.node_id = node["id"]
                db.commit()

                elapsed = 0
                while elapsed < wait_seconds:
                    db.expire_all()
                    sess = db.get(ImmediateSession, session_id)
                    if not sess or sess.status not in ("running", "paused"):
                        break

                    while sess and sess.status == "paused":
                        db.close()
                        await asyncio.sleep(2)
                        db = SessionLocal()
                        sess = db.get(ImmediateSession, session_id)

                    if not sess or sess.status not in ("running",):
                        break

                    chunk = min(5, wait_seconds - elapsed)
                    await asyncio.sleep(chunk)
                    elapsed += chunk

                    if elapsed % 30 < chunk or elapsed >= wait_seconds:
                        await _broadcast_progress(session_id, sess.campaign_id, {
                            "kind": "wait_tick",
                            "node_index": ni,
                            "elapsed": elapsed,
                            "total": wait_seconds,
                        })

                # Reactivate waiting runs (except replied ones)
                for sa in sender_assignments:
                    for cid in sa["contact_ids"]:
                        uc = db.get(UploadedContact, cid)
                        if not uc:
                            continue
                        run = db.query(CampaignRun).filter_by(
                            campaign_id=sess.campaign_id, phone=uc.phone
                        ).first()
                        if run and run.status == "waiting":
                            run.status = "active"
                db.commit()

                # Count replied during wait
                replied_count = 0
                for sa in sender_assignments:
                    for cid in sa["contact_ids"]:
                        uc = db.get(UploadedContact, cid)
                        if not uc:
                            continue
                        run = db.query(CampaignRun).filter_by(
                            campaign_id=sess.campaign_id, phone=uc.phone
                        ).first()
                        if run and run.status == "replied":
                            replied_count += 1

                progress["nodes"].append({
                    "node_index": ni,
                    "node_id": node["id"],
                    "type": "wait",
                    "wait_seconds": wait_seconds,
                    "replied_during_wait": replied_count,
                })
                sess.progress = json.dumps(progress)
                db.commit()

                await _broadcast_progress(session_id, sess.campaign_id, {
                    "kind": "node_complete",
                    "node_index": ni,
                    "node_type": "wait",
                    "node_id": node["id"],
                    "replied_during_wait": replied_count,
                })

        # Mark completed
        db.close()
        db = SessionLocal()
        sess = db.get(ImmediateSession, session_id)
        if sess and sess.status == "running":
            sess.status = "completed"
            sess.finished_at = _utcnow()
            sess.progress = json.dumps(progress)

            # Mark remaining active runs as completed
            runs = db.query(CampaignRun).filter(
                CampaignRun.campaign_id == sess.campaign_id,
                CampaignRun.status.in_(("active", "waiting")),
            ).all()
            for run in runs:
                run.status = "completed"
                run.next_run_at = None

            db.commit()

            await _broadcast_progress(session_id, sess.campaign_id, {
                "kind": "completed",
                "progress": progress,
            })

    except Exception as exc:
        logger.exception("Immediate run error session=%d: %s", session_id, exc)
        try:
            sess = db.get(ImmediateSession, session_id)
            if sess:
                sess.status = "failed"
                db.commit()
        except Exception:
            pass
        await _broadcast_progress(session_id, 0, {"kind": "error", "detail": str(exc)[:500]})
    finally:
        db.close()
        _active_tasks.pop(session_id, None)


def start_immediate(session_id: int) -> asyncio.Task:
    task = asyncio.create_task(run_immediate(session_id))
    _active_tasks[session_id] = task
    return task


def pause_immediate(session_id: int) -> bool:
    db = SessionLocal()
    try:
        sess = db.get(ImmediateSession, session_id)
        if sess and sess.status == "running":
            sess.status = "paused"
            db.commit()
            return True
        return False
    finally:
        db.close()


def resume_immediate(session_id: int) -> bool:
    db = SessionLocal()
    try:
        sess = db.get(ImmediateSession, session_id)
        if sess and sess.status == "paused":
            sess.status = "running"
            db.commit()
            return True
        return False
    finally:
        db.close()


def stop_immediate(session_id: int) -> bool:
    db = SessionLocal()
    try:
        sess = db.get(ImmediateSession, session_id)
        if sess and sess.status in ("running", "paused", "warmup"):
            sess.status = "completed"
            sess.finished_at = _utcnow()

            # Mark remaining active/waiting runs as completed so they don't
            # linger in the database with stale status.
            runs = db.query(CampaignRun).filter(
                CampaignRun.campaign_id == sess.campaign_id,
                CampaignRun.status.in_(("active", "waiting")),
            ).all()
            for run in runs:
                run.status = "completed"
                run.next_run_at = None

            db.commit()
            task = _active_tasks.pop(session_id, None)
            if task:
                task.cancel()
            return True
        return False
    finally:
        db.close()
