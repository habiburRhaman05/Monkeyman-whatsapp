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
_main_loop: asyncio.AbstractEventLoop | None = None

WATCHDOG_INTERVAL = 10  # seconds between stuck-session checks
WARMUP_GRACE = 45  # seconds a session may sit in "warmup" before we start it ourselves


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def set_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Remember the app's event loop so sync endpoints can spawn background work."""
    global _main_loop
    _main_loop = loop


def has_active_task(session_id: int) -> bool:
    task = _active_tasks.get(session_id)
    return task is not None and not task.done()


def _record_event(db, run: CampaignRun, node_id: str, kind: str, detail: str | None = None,
                  variant_index: int | None = None) -> None:
    db.add(CampaignEvent(
        run_id=run.id,
        campaign_id=run.campaign_id,
        account_id=run.account_id,
        node_id=node_id,
        kind=kind,
        variant_index=variant_index,
        detail=(detail or "")[:500] or None,
    ))


def _run_for(db, campaign_id: int, uc: UploadedContact, account_id: int) -> CampaignRun:
    """The campaign run for this contact, created on demand.

    If a previous run exists and is completed, reset it to active so the
    contact can be re-processed on a campaign reactivation.
    """
    run = db.query(CampaignRun).filter_by(campaign_id=campaign_id, phone=uc.phone).first()
    if run:
        if run.status == "completed":
            run.status = "active"
            run.node_id = None
            run.next_run_at = None
            db.flush()
        return run
    run = CampaignRun(
        campaign_id=campaign_id,
        account_id=account_id,
        phone=uc.phone,
        jid=uc.wa_jid or (uc.phone + "@s.whatsapp.net"),
        uploaded_contact_id=uc.id,
        status="active",
    )
    db.add(run)
    db.flush()
    return run


def _already_sent(db, run: CampaignRun, node_id: str, since: datetime | None = None) -> bool:
    """Has this run already received this step during the current session?"""
    query = db.query(CampaignEvent.id).filter(
        CampaignEvent.run_id == run.id,
        CampaignEvent.node_id == node_id,
        CampaignEvent.kind == "sent",
    )
    if since is not None:
        query = query.filter(CampaignEvent.at >= since)
    return query.first() is not None


def _set_node_result(progress: dict, entry: dict) -> None:
    """Replace (or add) the result for one node instead of appending duplicates."""
    nodes = progress.setdefault("nodes", [])
    for i, existing in enumerate(nodes):
        if existing.get("node_index") == entry.get("node_index"):
            nodes[i] = entry
            return
    nodes.append(entry)


async def _wait_for_running(session_id: int, db):
    """Wait out a pause. Returns (db, session); session is None when it was deleted.

    The session object must be re-read from a fresh connection after a pause, so
    callers have to use the returned db.
    """
    while True:
        db.expire_all()
        sess = db.get(ImmediateSession, session_id)
        if sess is None or sess.status != "paused":
            return db, sess
        db.close()
        await asyncio.sleep(2)
        db = SessionLocal()


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
) -> tuple[bool, str | None]:
    """Send one message. Returns (delivered, error detail)."""
    jid = phone + "@s.whatsapp.net" if "@" not in phone else phone
    try:
        result = await evolution.send_text(instance_name, jid, text)
        wa_msg_id = evolution.message_id(result)
        _record_event(db, run, node["id"], "sent", wa_msg_id, variant_idx)
        run.last_sent_at = _utcnow()
        return True, None
    except Exception as exc:
        logger.warning("Immediate send failed run %d: %s", run.id, exc)
        _record_event(db, run, node["id"], "failed", str(exc), variant_idx)
        return False, str(exc)


async def _fail_contacts(
    db,
    session_id: int,
    campaign_id: int,
    account_id: int,
    contact_ids: list[int],
    node: dict,
    node_index: int,
    reason: str,
) -> int:
    """Record an explicit failure for contacts that could not be attempted."""
    failed = 0
    for cid in contact_ids:
        uc = db.get(UploadedContact, cid)
        if not uc:
            continue
        run = _run_for(db, campaign_id, uc, account_id)
        if run.status in ("replied", "failed", "stopped", "skipped"):
            continue
        run.status = "failed"
        run.node_id = node["id"]
        _record_event(db, run, node["id"], "failed", reason)
        failed += 1
        await _broadcast_progress(session_id, campaign_id, {
            "kind": "contact_failed",
            "node_index": node_index,
            "account_id": account_id,
            "contact_id": cid,
            "phone": uc.phone,
            "name": uc.name or uc.phone,
            "reason": reason,
        })
    db.commit()
    return failed


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
            failed = await _fail_contacts(
                db, session_id, campaign_id, account_id, contact_ids, node, node_index,
                f"Sender {account_id} is not connected" if acc else f"Sender {account_id} not found",
            )
            return {"sent": 0, "failed": failed, "account_id": account_id}

        variants = node.get("variants", [])
        if not variants:
            failed = await _fail_contacts(
                db, session_id, campaign_id, account_id, contact_ids, node, node_index,
                "Message step has no text",
            )
            return {"sent": 0, "failed": failed, "account_id": account_id}

        for i, cid in enumerate(contact_ids):
            db, sess = await _wait_for_running(session_id, db)
            if sess is None or sess.status != "running":
                break

            # Reload account from the (possibly new) db session
            acc = db.get(Account, account_id)
            if not acc or acc.status != "connected":
                failed += await _fail_contacts(
                    db, session_id, campaign_id, account_id, contact_ids[i:], node, node_index,
                    "Sender number disconnected during the run",
                )
                break

            instance_name = acc.instance_name

            try:
                uc = db.get(UploadedContact, cid)
                if not uc:
                    failed += 1
                    continue

                run = _run_for(db, campaign_id, uc, account_id)

                if run.status in ("replied", "failed", "stopped", "skipped"):
                    if run.status == "replied":
                        _record_event(db, run, node["id"], "skipped", "replied", None)
                        db.commit()
                    await _broadcast_progress(session_id, campaign_id, {
                        "kind": "contact_skipped",
                        "node_index": node_index,
                        "account_id": account_id,
                        "contact_id": cid,
                        "phone": uc.phone,
                        "name": uc.name or uc.phone,
                        "reason": run.status,
                    })
                    continue

                if _already_sent(db, run, node["id"], sess.started_at):
                    # Resumed session: never send the same step to a contact twice.
                    continue

                vi = (variant_counter + i) % len(variants)
                contact = _get_contact_dict(uc, uc.phone)
                text = render_template(variants[vi], contact)

                ok, err = await _send_one(instance_name, uc.phone, text, account_id, run, node, vi, db)
                run.node_id = node["id"]
                if ok:
                    sent += 1
                    run.status = "active"
                else:
                    failed += 1
                    run.status = "failed"
                db.commit()

                await _broadcast_progress(session_id, campaign_id, {
                    "kind": "contact_sent" if ok else "contact_failed",
                    "node_index": node_index,
                    "account_id": account_id,
                    "contact_id": cid,
                    "phone": uc.phone,
                    "name": uc.name or uc.phone,
                    "sent": sent,
                    "failed": failed,
                    "total": len(contact_ids),
                    "reason": err,
                })
            except Exception as exc:
                logger.exception(
                    "Sender lane contact error session=%d account=%d contact=%d: %s",
                    session_id, account_id, cid, exc,
                )
                db.rollback()
                failed += 1
                try:
                    uc = db.get(UploadedContact, cid)
                    if uc:
                        run = _run_for(db, campaign_id, uc, account_id)
                        run.status = "failed"
                        _record_event(db, run, node["id"], "failed", f"Unexpected error: {exc}")
                        db.commit()
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
                            "reason": str(exc),
                        })
                except Exception:
                    db.rollback()

            if i < len(contact_ids) - 1 and delay > 0:
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

        # A contact must belong to exactly one sender for the whole run, otherwise
        # it gets messaged twice and the per-step counters disagree.
        sender_assignments: list[dict] = []
        claimed: set[int] = set()
        for sa in config.get("sender_assignments", []):
            ids = [cid for cid in sa.get("contact_ids", []) if cid not in claimed]
            claimed.update(ids)
            if ids:
                sender_assignments.append({"account_id": sa["account_id"], "contact_ids": ids})

        # Keep whatever an earlier attempt finished, then resume at the node that
        # was in progress (a server restart mid-run must not restart from step 1).
        progress: dict = {"nodes": [], "replied_contacts": []}
        if sess.progress:
            try:
                stored = json.loads(sess.progress)
                if isinstance(stored, dict):
                    progress = {
                        "nodes": list(stored.get("nodes") or []),
                        "replied_contacts": list(stored.get("replied_contacts") or []),
                    }
            except (json.JSONDecodeError, TypeError):
                pass

        resume_at = 0
        if progress["nodes"] and sess.current_node_index is not None:
            resume_at = max(0, min(sess.current_node_index, len(nodes) - 1))

        sess.status = "running"
        campaign.status = "active"
        db.commit()

        await _broadcast_progress(session_id, sess.campaign_id, {
            "kind": "started",
            "total_nodes": len(nodes),
            "resume_at": resume_at,
        })

        variant_counter = 0
        skip_nodes: set[int] = set()

        for ni, node in enumerate(nodes):
            if ni in skip_nodes or ni < resume_at:
                continue

            # Fresh read — previous iteration may have committed from a
            # different path (wait loop, sender lanes) leaving stale cache.
            db.expire_all()
            sess = db.get(ImmediateSession, session_id)
            if not sess or sess.status not in ("running", "paused"):
                break

            sess.current_node_index = ni
            db.commit()

            ntype = node.get("type")

            if ntype == "drip":
                batch_size = node.get("batch_size", 5)
                amount = node.get("amount", 1)
                unit = node.get("unit", "minutes")
                interval_seconds = amount * (60 if unit == "minutes" else 3600 if unit == "hours" else 86400)

                # Find the next message node — drip batches its sends
                next_msg_node = None
                next_msg_ni = None
                for fi in range(ni + 1, len(nodes)):
                    if nodes[fi].get("type") == "message":
                        next_msg_node = nodes[fi]
                        next_msg_ni = fi
                        break

                if not next_msg_node:
                    continue

                skip_nodes.add(next_msg_ni)

                # Gather active contacts across all senders
                flat_contacts: list[tuple[int, int]] = []
                for sa in sender_assignments:
                    db.expire_all()
                    for cid in sa["contact_ids"]:
                        uc = db.get(UploadedContact, cid)
                        if not uc:
                            continue
                        run = db.query(CampaignRun).filter_by(
                            campaign_id=sess.campaign_id, phone=uc.phone
                        ).first()
                        if run and run.status in ("replied", "failed", "stopped", "skipped"):
                            continue
                        flat_contacts.append((sa["account_id"], cid))

                batches = [flat_contacts[i:i + batch_size] for i in range(0, len(flat_contacts), batch_size)]
                if not batches:
                    continue

                await _broadcast_progress(session_id, sess.campaign_id, {
                    "kind": "node_start",
                    "node_index": ni,
                    "node_type": "drip",
                    "node_id": node["id"],
                    "total_batches": len(batches),
                    "batch_size": batch_size,
                    "interval_seconds": interval_seconds,
                })

                drip_total_sent = 0
                drip_total_failed = 0
                batches_done = 0

                for bi, batch in enumerate(batches):
                    db.expire_all()
                    sess = db.get(ImmediateSession, session_id)
                    if not sess or sess.status not in ("running", "paused"):
                        break
                    while sess and sess.status == "paused":
                        db.close()
                        await asyncio.sleep(2)
                        db = SessionLocal()
                        sess = db.get(ImmediateSession, session_id)
                    if not sess or sess.status != "running":
                        break

                    # Group batch contacts by account
                    by_account: dict[int, list[int]] = {}
                    for acc_id, cid in batch:
                        by_account.setdefault(acc_id, []).append(cid)

                    tasks = []
                    for acc_id, cids in by_account.items():
                        tasks.append(_sender_lane(
                            session_id=session_id,
                            campaign_id=sess.campaign_id,
                            account_id=acc_id,
                            contact_ids=cids,
                            node=next_msg_node,
                            node_index=next_msg_ni,
                            delay=delay,
                            variant_counter=variant_counter,
                        ))

                    results = await asyncio.gather(*tasks, return_exceptions=True)

                    batch_sent = sum(r.get("sent", 0) for r in results if isinstance(r, dict))
                    batch_failed = sum(r.get("failed", 0) for r in results if isinstance(r, dict))
                    drip_total_sent += batch_sent
                    drip_total_failed += batch_failed
                    variant_counter += len(batch)
                    batches_done = bi + 1

                    await _broadcast_progress(session_id, sess.campaign_id, {
                        "kind": "drip_batch",
                        "node_index": ni,
                        "batch": bi + 1,
                        "total_batches": len(batches),
                        "sent": batch_sent,
                        "failed": batch_failed,
                    })

                    # Wait the drip interval before next batch
                    if bi < len(batches) - 1:
                        elapsed = 0
                        while elapsed < interval_seconds:
                            db.expire_all()
                            sess = db.get(ImmediateSession, session_id)
                            if not sess or sess.status not in ("running", "paused"):
                                break
                            while sess and sess.status == "paused":
                                db.close()
                                await asyncio.sleep(2)
                                db = SessionLocal()
                                sess = db.get(ImmediateSession, session_id)
                            if not sess or sess.status != "running":
                                break
                            chunk = min(5, interval_seconds - elapsed)
                            await asyncio.sleep(chunk)
                            elapsed += chunk

                            if elapsed % 30 < chunk or elapsed >= interval_seconds:
                                await _broadcast_progress(session_id, sess.campaign_id, {
                                    "kind": "drip_wait",
                                    "node_index": ni,
                                    "batch": bi + 1,
                                    "elapsed": elapsed,
                                    "total": interval_seconds,
                                })

                _set_node_result(progress, {
                    "node_index": ni,
                    "node_id": node["id"],
                    "type": "drip",
                    "batches_completed": batches_done,
                    "total_batches": len(batches),
                    "sent": drip_total_sent,
                    "failed": drip_total_failed,
                })
                _set_node_result(progress, {
                    "node_index": next_msg_ni,
                    "node_id": next_msg_node["id"],
                    "type": "message",
                    "sent": drip_total_sent,
                    "failed": drip_total_failed,
                    "senders": [{"sent": drip_total_sent, "failed": drip_total_failed}],
                })
                db.expire_all()
                sess = db.get(ImmediateSession, session_id)
                if sess:
                    sess.progress = json.dumps(progress)
                    db.commit()

                await _broadcast_progress(session_id, sess.campaign_id if sess else 0, {
                    "kind": "node_complete",
                    "node_index": ni,
                    "node_type": "drip",
                    "node_id": node["id"],
                    "sent": drip_total_sent,
                    "failed": drip_total_failed,
                    "batches_completed": batches_done,
                })

            elif ntype == "message":
                await _broadcast_progress(session_id, sess.campaign_id, {
                    "kind": "node_start",
                    "node_index": ni,
                    "node_type": "message",
                    "node_id": node["id"],
                })

                tasks = []
                for sa in sender_assignments:
                    # Expire again so replied/failed contacts are visible
                    db.expire_all()
                    active_contacts = []
                    for cid in sa["contact_ids"]:
                        uc = db.get(UploadedContact, cid)
                        if not uc:
                            continue
                        run = db.query(CampaignRun).filter_by(
                            campaign_id=sess.campaign_id, phone=uc.phone
                        ).first()
                        if run and run.status in ("replied", "failed", "stopped", "skipped"):
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

                _set_node_result(progress, node_stats)
                if sess:
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

                _set_node_result(progress, {
                    "node_index": ni,
                    "node_id": node["id"],
                    "type": "wait",
                    "wait_seconds": wait_seconds,
                    "replied_during_wait": replied_count,
                })
                if sess:
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

            # Update the campaign status itself
            campaign = db.get(Campaign, sess.campaign_id)
            if campaign:
                campaign.status = "completed"

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


def _launch_task(session_id: int, loop: asyncio.AbstractEventLoop) -> None:
    if has_active_task(session_id):
        return
    _active_tasks[session_id] = loop.create_task(run_immediate(session_id))


def start_immediate(session_id: int) -> None:
    """Start the session's background task, or reuse the one already running.

    Safe to call from sync endpoints (thread pool) as well as async ones.
    """
    if has_active_task(session_id):
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None

    if running is not None:
        _launch_task(session_id, running)
    elif _main_loop is not None and _main_loop.is_running():
        _main_loop.call_soon_threadsafe(_launch_task, session_id, _main_loop)
    else:
        logger.error("Cannot start immediate session %d: no event loop available", session_id)


def _cancel_task(task: asyncio.Task) -> None:
    """Cancel from whichever thread we are on (pause/stop endpoints are sync)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        if _main_loop is not None and _main_loop.is_running():
            _main_loop.call_soon_threadsafe(task.cancel)
            return
    task.cancel()


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
    resumed = False
    try:
        sess = db.get(ImmediateSession, session_id)
        if sess and sess.status == "paused":
            sess.status = "running"
            db.commit()
            resumed = True
    finally:
        db.close()
    if resumed and not has_active_task(session_id):
        # The task died earlier (e.g. the server restarted): pick the run back up.
        start_immediate(session_id)
    return resumed


def stop_immediate(session_id: int) -> bool:
    db = SessionLocal()
    try:
        sess = db.get(ImmediateSession, session_id)
        if sess and sess.status in ("running", "paused", "warmup"):
            sess.status = "completed"
            sess.finished_at = _utcnow()

            campaign = db.get(Campaign, sess.campaign_id)
            if campaign and campaign.status == "active":
                campaign.status = "paused"

            runs = db.query(CampaignRun).filter(
                CampaignRun.campaign_id == sess.campaign_id,
                CampaignRun.status.in_(("active", "waiting")),
            ).all()
            for run in runs:
                run.status = "stopped"
                run.next_run_at = None

            db.commit()
            task = _active_tasks.pop(session_id, None)
            if task:
                _cancel_task(task)
            return True
        return False
    finally:
        db.close()


async def _watchdog_tick() -> None:
    """Keep sessions honest when nobody is driving them.

    - A session stuck in "warmup" (the browser's countdown never finished) is
      started here instead of hanging forever and blocking every new start.
    - A session marked "running" without a live task (server restart) is marked
      paused so the UI shows a resumable state instead of a fake "Sending…".
    """
    db = SessionLocal()
    try:
        now = _utcnow()
        sessions = db.query(ImmediateSession).filter(
            ImmediateSession.status.in_(("warmup", "running")),
        ).all()
        for sess in sessions:
            if has_active_task(sess.id):
                continue
            if sess.status == "warmup":
                started = sess.started_at or now
                if (now - started).total_seconds() < WARMUP_GRACE:
                    continue
                logger.info("Watchdog starting warmup session %d (campaign %d)", sess.id, sess.campaign_id)
                sess.status = "running"
                db.commit()
                start_immediate(sess.id)
            else:
                logger.warning("Session %d is marked running but has no task — pausing it", sess.id)
                sess.status = "paused"
                db.commit()
    finally:
        db.close()


async def immediate_watchdog_loop() -> None:
    logger.info("Immediate watchdog started (every %ds)", WATCHDOG_INTERVAL)
    while True:
        try:
            await _watchdog_tick()
        except Exception as exc:
            logger.exception("Immediate watchdog error: %s", exc)
        await asyncio.sleep(WATCHDOG_INTERVAL)
