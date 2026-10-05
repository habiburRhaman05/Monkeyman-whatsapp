"""Background campaign engine — processes active campaign runs every 30s.

Walks each active run through its campaign's node list:
  message → send text via Evolution API
  wait    → schedule next_run_at
  drip    → release batch_size contacts per interval
"""

import asyncio
import json
import logging
import random
from datetime import datetime, timedelta, timezone

from app import campaign_settings, evolution
from app.contact_import import render_template
from app.db import SessionLocal
from app.models import (
    Account,
    Campaign,
    CampaignEvent,
    CampaignNodeState,
    CampaignRun,
    ContactSender,
    Chat,
    ImmediateSession,
    UploadedContact,
)

logger = logging.getLogger(__name__)

MAX_MSG_PER_DAY = 200
TICK_INTERVAL = 30  # seconds between ticks


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _next_node(nodes: list[dict], current_id: str | None) -> dict | None:
    if current_id is None:
        return nodes[0] if nodes else None
    for i, n in enumerate(nodes):
        if n.get("id") == current_id:
            return nodes[i + 1] if i + 1 < len(nodes) else None
    return None


def _wait_delta(amount: int | float, unit: str) -> timedelta:
    if unit == "minutes":
        return timedelta(minutes=amount)
    if unit == "hours":
        return timedelta(hours=amount)
    return timedelta(days=amount)


async def _send_message(
    instance_name: str,
    phone: str,
    text: str,
    run: CampaignRun,
    node: dict,
    variant_idx: int,
    db,
) -> bool:
    """Send a single message. Returns True on success."""
    jid = phone + "@s.whatsapp.net" if "@" not in phone else phone
    try:
        result = await evolution.send_text(instance_name, jid, text)
        wa_msg_id = (result.get("key") or {}).get("id")
        db.add(CampaignEvent(
            run_id=run.id,
            campaign_id=run.campaign_id,
            account_id=run.account_id,
            node_id=node["id"],
            kind="sent",
            variant_index=variant_idx,
            detail=wa_msg_id,
        ))
        run.last_sent_at = _utcnow()
        return True
    except Exception as exc:
        logger.warning("Campaign send failed for run %d: %s", run.id, exc)
        db.add(CampaignEvent(
            run_id=run.id,
            campaign_id=run.campaign_id,
            account_id=run.account_id,
            node_id=node["id"],
            kind="failed",
            detail=str(exc)[:500],
        ))
        return False


def _send_gate(cfg: dict, acc, db, now: datetime) -> datetime | None:
    """None if this number may send right now, else when to look at the run again."""
    if not campaign_settings.in_send_window(cfg, now):
        return campaign_settings.next_window_start(cfg, now)
    sent_today = db.query(CampaignEvent).filter(
        CampaignEvent.account_id == acc.id,
        CampaignEvent.kind == "sent",
        CampaignEvent.at >= campaign_settings.day_start_utc(cfg, now),
    ).count()
    if sent_today >= min(cfg["daily_limit"], MAX_MSG_PER_DAY):
        return now + timedelta(minutes=30)
    return None


def _get_contact_dict(run: CampaignRun, db) -> dict:
    """Build a template-variable dict from the run's uploaded contact (if any)."""
    if run.uploaded_contact_id:
        uc = db.get(UploadedContact, run.uploaded_contact_id)
        if uc:
            return {
                "first_name": uc.first_name or "",
                "last_name": uc.last_name or "",
                "name": uc.name or "",
                "email": uc.email or "",
                "phone": uc.phone or run.phone,
                "country_code": uc.country_code or "",
                "whatsapp_copy": uc.whatsapp_copy or "",
                "extra": uc.extra,
            }
    return {"phone": run.phone, "name": "", "first_name": "", "last_name": "", "email": "", "whatsapp_copy": ""}


async def _process_run(run: CampaignRun, campaign: Campaign, db) -> None:
    """Advance one run by one step."""
    nodes = json.loads(campaign.nodes) if campaign.nodes else []
    if not nodes:
        return

    node = _next_node(nodes, run.node_id)

    if node is None:
        run.status = "completed"
        run.next_run_at = None
        db.add(CampaignEvent(
            run_id=run.id, campaign_id=run.campaign_id,
            account_id=run.account_id, node_id=run.node_id,
            kind="completed",
        ))
        return

    acc = db.get(Account, run.account_id)
    if not acc or acc.status != "connected":
        run.status = "failed"
        run.next_run_at = None
        return

    ntype = node.get("type")

    if ntype == "message":
        variants = node.get("variants", [])
        if not variants:
            run.node_id = node["id"]
            return

        cfg = campaign_settings.normalize(campaign.settings)
        wait_until = _send_gate(cfg, acc, db, _utcnow())
        if wait_until:
            run.next_run_at = wait_until
            return

        # Round-robin variant selection per node per account
        state = db.query(CampaignNodeState).filter_by(
            campaign_id=campaign.id, node_id=node["id"], account_id=acc.id
        ).first()
        if not state:
            state = CampaignNodeState(
                campaign_id=campaign.id, node_id=node["id"],
                account_id=acc.id, variant_counter=0,
            )
            db.add(state)
            db.flush()

        vi = state.variant_counter % len(variants)
        template = variants[vi]
        contact = _get_contact_dict(run, db)
        text = render_template(template, contact)

        # Random delay within the campaign's configured range
        await asyncio.sleep(random.uniform(cfg["delay_min"], cfg["delay_max"]))

        ok = await _send_message(acc.instance_name, run.phone, text, run, node, vi, db)
        state.variant_counter += 1

        if ok:
            run.node_id = node["id"]
            # Check if there's a next node
            nxt = _next_node(nodes, node["id"])
            if nxt is None:
                run.status = "completed"
                run.next_run_at = None
            elif nxt.get("type") == "wait":
                amount = nxt.get("amount", 1)
                unit = nxt.get("unit", "hours")
                run.next_run_at = _utcnow() + _wait_delta(amount, unit)
                run.node_id = nxt["id"]
                run.status = "waiting"
            else:
                run.next_run_at = _utcnow() + timedelta(seconds=random.randint(cfg["delay_min"], cfg["delay_max"]))
        else:
            run.status = "failed"
            run.next_run_at = None

    elif ntype == "wait":
        # Wait node: set the next_run_at and advance
        amount = node.get("amount", 1)
        unit = node.get("unit", "hours")
        run.node_id = node["id"]
        run.next_run_at = _utcnow() + _wait_delta(amount, unit)
        run.status = "waiting"
        db.add(CampaignEvent(
            run_id=run.id, campaign_id=run.campaign_id,
            account_id=run.account_id, node_id=node["id"],
            kind="waited", detail=f"{amount} {unit}",
        ))

    elif ntype == "drip":
        # Drip gate: check if this run can pass through
        batch_size = node.get("batch_size", 50)
        amount = node.get("amount", 1)
        unit = node.get("unit", "hours")
        interval = _wait_delta(amount, unit)

        # Don't release contacts the message step can't send yet, or they'd pile up and burst out together
        wait_until = _send_gate(campaign_settings.normalize(campaign.settings), acc, db, _utcnow())
        if wait_until:
            run.next_run_at = wait_until
            run.status = "queued"
            return

        state = db.query(CampaignNodeState).filter_by(
            campaign_id=campaign.id, node_id=node["id"], account_id=acc.id
        ).first()
        if not state:
            state = CampaignNodeState(
                campaign_id=campaign.id, node_id=node["id"],
                account_id=acc.id, variant_counter=0,
            )
            db.add(state)
            db.flush()

        now = _utcnow()
        if state.last_release_at and (now - state.last_release_at) < interval:
            run.next_run_at = state.last_release_at + interval
            run.status = "queued"
            return

        released_count = db.query(CampaignEvent).filter(
            CampaignEvent.campaign_id == campaign.id,
            CampaignEvent.node_id == node["id"],
            CampaignEvent.account_id == acc.id,
            CampaignEvent.kind == "released",
            CampaignEvent.at >= (state.last_release_at or datetime.min),
        ).count()

        if released_count >= batch_size:
            state.last_release_at = now
            run.next_run_at = now + interval
            run.status = "queued"
            return

        run.node_id = node["id"]
        run.status = "active"
        run.next_run_at = _utcnow() + timedelta(seconds=5)
        db.add(CampaignEvent(
            run_id=run.id, campaign_id=run.campaign_id,
            account_id=run.account_id, node_id=node["id"],
            kind="released",
        ))


async def _tick() -> None:
    """One campaign engine tick: process all due runs."""
    db = SessionLocal()
    try:
        now = _utcnow()

        # Find runs that are ready to process
        runs = db.query(CampaignRun).filter(
            CampaignRun.status.in_(("active", "waiting", "queued")),
            (CampaignRun.next_run_at <= now) | (CampaignRun.next_run_at.is_(None)),
        ).limit(50).all()

        if not runs:
            # Even with no due runs, check if any active campaigns should auto-complete
            _auto_complete_campaigns(db)
            return

        # Skip campaigns that have an active immediate session
        immediate_campaign_ids: set[int] = set()
        active_immediate = db.query(ImmediateSession.campaign_id).filter(
            ImmediateSession.status.in_(("warmup", "running", "paused")),
        ).all()
        for row in active_immediate:
            immediate_campaign_ids.add(row[0])

        campaign_cache: dict[int, Campaign] = {}
        for run in runs:
            if run.campaign_id in immediate_campaign_ids:
                continue

            if run.campaign_id not in campaign_cache:
                camp = db.get(Campaign, run.campaign_id)
                if camp:
                    campaign_cache[run.campaign_id] = camp

            campaign = campaign_cache.get(run.campaign_id)
            if not campaign or campaign.status != "active":
                if campaign and campaign.status == "paused":
                    run.next_run_at = None
                continue

            try:
                await _process_run(run, campaign, db)
                db.commit()
            except Exception as exc:
                logger.exception("Error processing run %d: %s", run.id, exc)
                db.rollback()

        _auto_complete_campaigns(db)

    except Exception as exc:
        logger.exception("Campaign tick error: %s", exc)
    finally:
        db.close()


def _auto_complete_campaigns(db) -> None:
    """Set active campaigns to 'completed' when all their runs are finished."""
    active_campaigns = db.query(Campaign).filter(Campaign.status == "active").all()
    for camp in active_campaigns:
        total = db.query(CampaignRun).filter(CampaignRun.campaign_id == camp.id).count()
        if total == 0:
            continue
        remaining = db.query(CampaignRun).filter(
            CampaignRun.campaign_id == camp.id,
            CampaignRun.status.in_(("active", "waiting", "queued")),
        ).count()
        if remaining == 0:
            camp.status = "completed"
            logger.info("Campaign %d auto-completed (all %d runs finished)", camp.id, total)
            db.commit()


async def campaign_loop() -> None:
    """Main loop — runs forever, ticking every TICK_INTERVAL seconds."""
    logger.info("Campaign engine started (tick every %ds)", TICK_INTERVAL)
    while True:
        try:
            await _tick()
        except Exception as exc:
            logger.exception("Campaign tick failed: %s", exc)
        await asyncio.sleep(TICK_INTERVAL)
