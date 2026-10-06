"""Tag-watch campaign engine — monitors tags for new contacts and auto-enrolls them.

When a campaign has trigger_type='tag_added', status='active', and a trigger_label_id,
this engine polls every 15 seconds for new UploadedContacts in batches with that label.
New contacts are enrolled, then either processed by the regular campaign_engine (scheduled mode)
or auto-launched via an ImmediateSession (immediate mode).
"""

import asyncio
import json
import logging
from datetime import datetime, timezone

from app import campaign_settings
from app.db import SessionLocal
from app.models import (
    Account,
    Campaign,
    CampaignRun,
    ContactBatch,
    ContactSender,
    ImmediateSession,
    UploadedContact,
)

logger = logging.getLogger(__name__)

POLL_INTERVAL = 15  # seconds


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _in_schedule_window(campaign: Campaign) -> bool:
    """Check if the campaign's schedule allows sending right now."""
    cfg = campaign_settings.normalize(campaign.settings)
    if cfg["mode"] != "scheduled":
        return True
    return campaign_settings.in_send_window(cfg, _utcnow())


def _find_new_contacts(db, campaign: Campaign) -> list[UploadedContact]:
    """Find UploadedContacts under the campaign's trigger label that haven't been enrolled yet."""
    if not campaign.trigger_label_id:
        return []

    batch_ids = [
        b.id for b in db.query(ContactBatch.id).filter(
            ContactBatch.label_id == campaign.trigger_label_id,
        ).all()
    ]
    if not batch_ids:
        return []

    cursor = campaign.tag_cursor or 0

    new_contacts = db.query(UploadedContact).filter(
        UploadedContact.batch_id.in_(batch_ids),
        UploadedContact.id > cursor,
    ).order_by(UploadedContact.id.asc()).limit(200).all()

    return new_contacts


def _enroll_contacts(
    db,
    campaign: Campaign,
    contacts: list[UploadedContact],
    senders: list[Account],
) -> tuple[int, dict[int, list[int]]]:
    """Enroll contacts into the campaign. Returns (enrolled_count, sender_assignments)."""
    sender_ids = [s.id for s in senders]

    existing_phones = set(
        r.phone for r in db.query(CampaignRun.phone).filter(
            CampaignRun.campaign_id == campaign.id,
            CampaignRun.status.in_(("active", "waiting", "queued")),
        ).all()
    )

    enrolled = 0
    sender_idx = 0
    sender_assignments: dict[int, list[int]] = {s.id: [] for s in senders}

    for uc in contacts:
        if uc.phone in existing_phones:
            continue

        sticky = db.query(ContactSender).filter_by(phone=uc.phone).first()
        if sticky and sticky.account_id in sender_ids:
            account_id = sticky.account_id
        else:
            account_id = senders[sender_idx % len(senders)].id
            sender_idx += 1
            if not sticky:
                db.add(ContactSender(phone=uc.phone, account_id=account_id))

        run = CampaignRun(
            campaign_id=campaign.id,
            account_id=account_id,
            phone=uc.phone,
            jid=uc.phone + "@s.whatsapp.net",
            uploaded_contact_id=uc.id,
            status="active",
            node_id=None,
        )
        db.add(run)
        enrolled += 1
        existing_phones.add(uc.phone)
        sender_assignments.setdefault(account_id, []).append(uc.id)

    return enrolled, sender_assignments


async def _process_campaign(campaign: Campaign, db) -> None:
    """Check one tag_added campaign for new contacts and enroll them."""
    cfg = campaign_settings.normalize(campaign.settings)
    mode = cfg["mode"]

    # For scheduled mode, only check during the send window
    if mode == "scheduled" and not _in_schedule_window(campaign):
        return

    contacts = _find_new_contacts(db, campaign)
    if not contacts:
        return

    sender_ids = json.loads(campaign.sender_account_ids) if campaign.sender_account_ids else []
    if not sender_ids:
        return

    senders = db.query(Account).filter(
        Account.id.in_(sender_ids), Account.status == "connected"
    ).all()
    if not senders:
        return

    enrolled, sender_assignments = _enroll_contacts(db, campaign, contacts, senders)

    # Advance cursor to the highest contact id we processed
    max_id = max(c.id for c in contacts)
    campaign.tag_cursor = max_id
    campaign.tag_last_checked_at = _utcnow()
    db.commit()

    if enrolled == 0:
        logger.debug("Tag-watch: campaign %d '%s' — no new contacts to enroll", campaign.id, campaign.name)
        return

    logger.info("Tag-watch: enrolled %d contacts into campaign %d '%s'", enrolled, campaign.id, campaign.name)

    if mode == "immediate":
        # Check for existing active immediate session
        existing_session = db.query(ImmediateSession).filter(
            ImmediateSession.campaign_id == campaign.id,
            ImmediateSession.status.in_(("warmup", "running", "paused")),
        ).first()
        if existing_session:
            logger.info("Tag-watch: campaign %d already has active session %d — new contacts will be picked up by campaign_engine", campaign.id, existing_session.id)
            return

        sa_list = [
            {"account_id": acc_id, "contact_ids": cids}
            for acc_id, cids in sender_assignments.items()
            if cids
        ]
        if not sa_list:
            return

        sess = ImmediateSession(
            campaign_id=campaign.id,
            config=json.dumps({"sender_assignments": sa_list, "delay": cfg.get("delay_min", 10)}),
            status="warmup",
        )
        db.add(sess)
        db.commit()
        db.refresh(sess)

        sess.status = "running"
        db.commit()

        from app.immediate_engine import start_immediate
        start_immediate(sess.id)
        logger.info("Tag-watch: auto-launched immediate session %d for campaign %d", sess.id, campaign.id)

    # For scheduled mode, the regular campaign_engine._tick() picks up the enrolled runs


async def _tag_tick() -> None:
    """One tag-watch tick: check all active tag_added campaigns."""
    db = SessionLocal()
    try:
        campaigns = db.query(Campaign).filter(
            Campaign.trigger_type == "tag_added",
            Campaign.status == "active",
            Campaign.trigger_label_id.isnot(None),
        ).all()

        for campaign in campaigns:
            try:
                await _process_campaign(campaign, db)
            except Exception as exc:
                logger.exception("Tag-watch error for campaign %d: %s", campaign.id, exc)
                db.rollback()

    except Exception as exc:
        logger.exception("Tag-watch tick error: %s", exc)
    finally:
        db.close()


async def tag_watch_loop() -> None:
    """Main loop — polls every POLL_INTERVAL seconds for new contacts under watched tags."""
    logger.info("Tag-watch engine started (poll every %ds)", POLL_INTERVAL)
    while True:
        try:
            await _tag_tick()
        except Exception as exc:
            logger.exception("Tag-watch tick failed: %s", exc)
        await asyncio.sleep(POLL_INTERVAL)
