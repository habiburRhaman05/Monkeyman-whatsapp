"""GoHighLevel CRM webhook — receives tagged contacts, auto-enrolls into matching campaign.

GHL workflows fire one POST per contact with this payload:
{
  "id": "{{contact.id}}",
  "name": "{{contact.name}}",
  "email": "{{contact.email}}",
  "phone": "{{contact.phone}}",
  "campaign_name": "new-load-campaign"
}

The `campaign_name` field determines which campaign to enroll the contact into.
Contacts are collected in a staging buffer per campaign_name. After
GHL_BATCH_WAIT_SECONDS of quiet (no new contacts for that campaign), the batch
is auto-enrolled and an ImmediateSession is launched.
"""

import asyncio
import hmac
import json
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.db import SessionLocal
from app.models import (
    Account,
    Campaign,
    CampaignRun,
    ContactBatch,
    ContactSender,
    ImmediateSession,
    Label,
    UploadedContact,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhook", tags=["ghl-webhook"])

# ── In-memory staging buffer ────────────────────────────────────
# Keyed by campaign_name. Each entry holds contacts received so far and a timer handle.
_staging: dict[str, dict] = {}

PALETTE = ["#00a884", "#53bdeb", "#f59e0b", "#ea4335", "#a855f7", "#ec4899", "#14b8a6", "#6366f1"]


def _clean_phone(raw: str | None) -> str | None:
    if not raw:
        return None
    digits = re.sub(r"[^\d]", "", str(raw))
    if not digits or len(digits) < 7:
        return None
    return digits


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _get_or_create_label(db, name: str):
    lb = db.query(Label).filter(Label.name == name).first()
    if lb:
        return lb
    color = PALETTE[db.query(Label).count() % len(PALETTE)]
    lb = Label(name=name, color=color)
    db.add(lb)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        lb = db.query(Label).filter(Label.name == name).first()
    return lb


async def _process_batch(campaign_name: str) -> None:
    """Called after the quiet period. Creates contacts, enrolls, and auto-launches."""
    batch_data = _staging.pop(campaign_name, None)
    if not batch_data or not batch_data["contacts"]:
        return

    contacts_raw = batch_data["contacts"]
    logger.info("GHL batch ready: campaign_name=%s contacts=%d", campaign_name, len(contacts_raw))

    db = SessionLocal()
    try:
        # 1. Find campaign by name
        campaign = db.query(Campaign).filter(Campaign.name == campaign_name).first()
        if not campaign:
            logger.warning("GHL: no campaign named '%s' — skipping %d contacts", campaign_name, len(contacts_raw))
            return

        sender_ids = json.loads(campaign.sender_account_ids) if campaign.sender_account_ids else []
        if not sender_ids:
            logger.warning("GHL: campaign '%s' has no sender numbers — skipping", campaign_name)
            return

        senders = db.query(Account).filter(Account.id.in_(sender_ids), Account.status == "connected").all()
        if not senders:
            logger.warning("GHL: campaign '%s' — no connected sender accounts", campaign_name)
            return

        # 2. Create label + batch
        label = _get_or_create_label(db, f"ghl-{campaign_name}")
        batch = ContactBatch(
            tag=f"ghl-{campaign_name}",
            label_id=label.id,
            filename=f"ghl-webhook-{campaign_name}",
            total=len(contacts_raw),
        )
        db.add(batch)
        db.flush()

        # 3. Create UploadedContacts
        created_contacts: list[UploadedContact] = []
        phones_seen: set[str] = set()

        for c in contacts_raw:
            phone = _clean_phone(c.get("phone"))
            if not phone or phone in phones_seen:
                continue
            phones_seen.add(phone)

            name = c.get("name", "")
            parts = name.split(None, 1) if name else ["", ""]
            first_name = parts[0] if len(parts) > 0 else ""
            last_name = parts[1] if len(parts) > 1 else ""

            uc = UploadedContact(
                batch_id=batch.id,
                first_name=first_name,
                last_name=last_name,
                name=name or None,
                email=c.get("email", ""),
                phone=phone,
                whatsapp_copy=c.get("whatsapp_copy") or None,
                wa_status="unchecked",
            )
            db.add(uc)
            try:
                db.flush()
                created_contacts.append(uc)
            except IntegrityError:
                db.rollback()
                batch = db.query(ContactBatch).get(batch.id)
                label = db.query(Label).filter(Label.name == f"ghl-{campaign_name}").first()

        batch.total = len(created_contacts)
        db.commit()

        if not created_contacts:
            logger.info("GHL: all contacts for campaign '%s' were duplicates or invalid", campaign_name)
            return

        # 4. Enroll into campaign (skip phones already active)
        existing_phones = set(
            r.phone for r in db.query(CampaignRun.phone).filter(
                CampaignRun.campaign_id == campaign.id,
                CampaignRun.status.in_(("active", "waiting", "queued")),
            ).all()
        )

        enrolled = 0
        sender_idx = 0
        sender_assignments: dict[int, list[int]] = {s.id: [] for s in senders}

        for uc in created_contacts:
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

        db.commit()
        logger.info("GHL: enrolled %d contacts into campaign '%s' (id=%d)", enrolled, campaign_name, campaign.id)

        if enrolled == 0:
            logger.info("GHL: no new contacts to enroll for campaign '%s'", campaign_name)
            return

        # 5. Auto-launch ImmediateSession
        existing_session = db.query(ImmediateSession).filter(
            ImmediateSession.campaign_id == campaign.id,
            ImmediateSession.status.in_(("warmup", "running", "paused")),
        ).first()
        if existing_session:
            logger.warning("GHL: campaign '%s' already has active session %d — skipping auto-launch", campaign_name, existing_session.id)
            return

        sa_list = [
            {"account_id": acc_id, "contact_ids": cids}
            for acc_id, cids in sender_assignments.items()
            if cids
        ]

        config = {
            "sender_assignments": sa_list,
            "delay": 10,
        }

        sess = ImmediateSession(
            campaign_id=campaign.id,
            config=json.dumps(config),
            status="warmup",
        )
        db.add(sess)
        db.commit()
        db.refresh(sess)

        sess.status = "running"
        db.commit()

        from app.immediate_engine import start_immediate
        start_immediate(sess.id)

        logger.info("GHL: auto-launched immediate session %d for campaign '%s'", sess.id, campaign_name)

    except Exception:
        logger.exception("GHL batch processing failed for campaign '%s'", campaign_name)
    finally:
        db.close()


def _schedule_batch(campaign_name: str) -> None:
    """(Re)schedule the batch timer for a campaign_name. Resets on each new contact."""
    entry = _staging.get(campaign_name)
    if not entry:
        return

    if entry.get("timer"):
        entry["timer"].cancel()

    loop = asyncio.get_event_loop()
    wait = settings.ghl_batch_wait_seconds

    async def _fire():
        await _process_batch(campaign_name)

    entry["timer"] = loop.call_later(wait, lambda: asyncio.ensure_future(_fire()))


@router.post("/ghl")
async def ghl_webhook(request: Request, secret: str = Query(...)):
    if not settings.ghl_webhook_secret:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="GHL webhook not configured")

    if not hmac.compare_digest(secret, settings.ghl_webhook_secret):
        logger.warning("GHL webhook rejected: bad secret from %s", request.client.host if request.client else "?")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bad secret")

    body = await request.json()

    # GHL custom webhook payload:
    # {
    #   "id": "{{contact.id}}",
    #   "name": "{{contact.name}}",
    #   "email": "{{contact.email}}",
    #   "phone": "{{contact.phone}}",
    #   "campaign_name": "new-load-campaign"
    # }

    phone_raw = body.get("phone") or body.get("Phone") or ""
    phone = _clean_phone(phone_raw)
    if not phone:
        logger.warning("GHL webhook: no valid phone in payload: %s", phone_raw)
        return {"ok": False, "error": "no valid phone"}

    campaign_name = (body.get("campaign_name") or body.get("campaignName") or "").strip()
    if not campaign_name:
        logger.warning("GHL webhook: no campaign_name in payload")
        return {"ok": False, "error": "no campaign_name"}

    contact_data = {
        "phone": phone_raw,
        "name": body.get("name") or "",
        "email": body.get("email") or body.get("Email") or "",
        "ghl_id": body.get("id") or "",
        "whatsapp_copy": body.get("whatsapp_message") or body.get("whatsapp_copy") or "",
    }

    if campaign_name not in _staging:
        _staging[campaign_name] = {"contacts": [], "timer": None}

    # Deduplicate within current staging buffer
    existing_phones = {_clean_phone(c.get("phone")) for c in _staging[campaign_name]["contacts"]}
    if phone not in existing_phones:
        _staging[campaign_name]["contacts"].append(contact_data)

    _schedule_batch(campaign_name)

    buffer_size = len(_staging[campaign_name]["contacts"])
    logger.info("GHL webhook: queued phone=%s for campaign='%s' (buffer: %d contacts)",
                phone, campaign_name, buffer_size)

    return {"ok": True, "queued": True, "campaign_name": campaign_name, "buffer_size": buffer_size}


# ── Second endpoint: collect contacts by tag, optionally trigger campaign ──

_tag_staging: dict[str, dict] = {}


async def _process_tag_batch(contact_tag: str) -> None:
    """Called after quiet period. Creates contacts under the tag batch.
    If any contacts have a campaign_name (not 'none'), also enroll + launch."""
    batch_data = _tag_staging.pop(contact_tag, None)
    if not batch_data or not batch_data["contacts"]:
        return

    contacts_raw = batch_data["contacts"]
    logger.info("GHL-contacts batch ready: tag=%s contacts=%d", contact_tag, len(contacts_raw))

    db = SessionLocal()
    try:
        label = _get_or_create_label(db, contact_tag)

        # Find or create a single reusable batch for this tag
        batch = db.query(ContactBatch).filter(
            ContactBatch.tag == contact_tag,
            ContactBatch.label_id == label.id,
        ).first()
        if not batch:
            batch = ContactBatch(
                tag=contact_tag,
                label_id=label.id,
                filename=f"ghl-tag-{contact_tag}",
                total=0,
            )
            db.add(batch)
            db.flush()

        # Existing phones in this batch (for dedup)
        existing_phones = set(
            r.phone for r in db.query(UploadedContact.phone).filter(
                UploadedContact.batch_id == batch.id,
            ).all()
        )

        created_contacts: list[UploadedContact] = []
        phones_seen: set[str] = set()
        # Contacts that need campaign enrollment, grouped by campaign_name
        campaign_contacts: dict[str, list[UploadedContact]] = {}

        for c in contacts_raw:
            phone = _clean_phone(c.get("phone"))
            if not phone or phone in phones_seen or phone in existing_phones:
                continue
            phones_seen.add(phone)

            name = c.get("name", "")
            parts = name.split(None, 1) if name else ["", ""]
            first_name = parts[0] if len(parts) > 0 else ""
            last_name = parts[1] if len(parts) > 1 else ""

            uc = UploadedContact(
                batch_id=batch.id,
                first_name=first_name,
                last_name=last_name,
                name=name or None,
                email=c.get("email", ""),
                phone=phone,
                whatsapp_copy=c.get("whatsapp_copy") or None,
                wa_status="unchecked",
            )
            db.add(uc)
            try:
                db.flush()
                created_contacts.append(uc)
                cname = (c.get("campaign_name") or "").strip().lower()
                if cname and cname != "none":
                    campaign_contacts.setdefault(c.get("campaign_name", "").strip(), []).append(uc)
            except IntegrityError:
                db.rollback()
                batch = db.query(ContactBatch).filter(
                    ContactBatch.tag == contact_tag, ContactBatch.label_id == label.id,
                ).first()

        batch.total = db.query(UploadedContact).filter(UploadedContact.batch_id == batch.id).count()
        db.commit()

        logger.info("GHL-contacts: added %d contacts to tag '%s' (total now %d)",
                     len(created_contacts), contact_tag, batch.total)

        # Enroll + launch for each campaign_name that isn't "none"
        for camp_name, contacts in campaign_contacts.items():
            campaign = db.query(Campaign).filter(Campaign.name == camp_name).first()
            if not campaign:
                logger.warning("GHL-contacts: no campaign named '%s' — skipping enrollment", camp_name)
                continue

            sender_ids = json.loads(campaign.sender_account_ids) if campaign.sender_account_ids else []
            if not sender_ids:
                logger.warning("GHL-contacts: campaign '%s' has no sender numbers", camp_name)
                continue

            senders = db.query(Account).filter(Account.id.in_(sender_ids), Account.status == "connected").all()
            if not senders:
                logger.warning("GHL-contacts: campaign '%s' — no connected senders", camp_name)
                continue

            active_phones = set(
                r.phone for r in db.query(CampaignRun.phone).filter(
                    CampaignRun.campaign_id == campaign.id,
                    CampaignRun.status.in_(("active", "waiting", "queued")),
                ).all()
            )

            enrolled = 0
            sender_idx = 0
            sender_assignments: dict[int, list[int]] = {s.id: [] for s in senders}

            for uc in contacts:
                if uc.phone in active_phones:
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
                active_phones.add(uc.phone)
                sender_assignments.setdefault(account_id, []).append(uc.id)

            db.commit()
            logger.info("GHL-contacts: enrolled %d into campaign '%s'", enrolled, camp_name)

            if enrolled == 0:
                continue

            existing_session = db.query(ImmediateSession).filter(
                ImmediateSession.campaign_id == campaign.id,
                ImmediateSession.status.in_(("warmup", "running", "paused")),
            ).first()
            if existing_session:
                logger.warning("GHL-contacts: campaign '%s' already has active session %d", camp_name, existing_session.id)
                continue

            sa_list = [
                {"account_id": acc_id, "contact_ids": cids}
                for acc_id, cids in sender_assignments.items()
                if cids
            ]
            sess = ImmediateSession(
                campaign_id=campaign.id,
                config=json.dumps({"sender_assignments": sa_list, "delay": 10}),
                status="warmup",
            )
            db.add(sess)
            db.commit()
            db.refresh(sess)
            sess.status = "running"
            db.commit()

            from app.immediate_engine import start_immediate
            start_immediate(sess.id)
            logger.info("GHL-contacts: auto-launched session %d for campaign '%s'", sess.id, camp_name)

    except Exception:
        logger.exception("GHL-contacts batch processing failed for tag '%s'", contact_tag)
    finally:
        db.close()


def _schedule_tag_batch(contact_tag: str) -> None:
    entry = _tag_staging.get(contact_tag)
    if not entry:
        return
    if entry.get("timer"):
        entry["timer"].cancel()

    loop = asyncio.get_event_loop()
    wait = settings.ghl_batch_wait_seconds

    async def _fire():
        await _process_tag_batch(contact_tag)

    entry["timer"] = loop.call_later(wait, lambda: asyncio.ensure_future(_fire()))


@router.post("/ghl-contacts")
async def ghl_contacts_webhook(request: Request, secret: str = Query(...)):
    """Collect contacts by tag. If campaign_name != 'none', also trigger the campaign."""
    if not settings.ghl_webhook_secret:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="GHL webhook not configured")

    if not hmac.compare_digest(secret, settings.ghl_webhook_secret):
        logger.warning("GHL-contacts webhook rejected: bad secret")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bad secret")

    body = await request.json()

    phone_raw = body.get("phone") or body.get("Phone") or ""
    phone = _clean_phone(phone_raw)
    if not phone:
        logger.warning("GHL-contacts: no valid phone in payload: %s", phone_raw)
        return {"ok": False, "error": "no valid phone"}

    contact_tag = (body.get("contact_tag") or "").strip()
    if not contact_tag:
        logger.warning("GHL-contacts: no contact_tag in payload")
        return {"ok": False, "error": "no contact_tag"}

    campaign_name = (body.get("campaign_name") or body.get("campagin_name") or "").strip()

    contact_data = {
        "phone": phone_raw,
        "name": body.get("name") or "",
        "email": body.get("email") or body.get("Email") or "",
        "ghl_id": body.get("id") or "",
        "whatsapp_copy": body.get("whatsapp_message") or body.get("whatsapp_copy") or "",
        "campaign_name": campaign_name,
    }

    if contact_tag not in _tag_staging:
        _tag_staging[contact_tag] = {"contacts": [], "timer": None}

    existing_phones = {_clean_phone(c.get("phone")) for c in _tag_staging[contact_tag]["contacts"]}
    if phone not in existing_phones:
        _tag_staging[contact_tag]["contacts"].append(contact_data)

    _schedule_tag_batch(contact_tag)

    buffer_size = len(_tag_staging[contact_tag]["contacts"])
    logger.info("GHL-contacts: queued phone=%s tag='%s' campaign='%s' (buffer: %d)",
                phone, contact_tag, campaign_name or "none", buffer_size)

    return {
        "ok": True,
        "queued": True,
        "contact_tag": contact_tag,
        "campaign_name": campaign_name or "none",
        "buffer_size": buffer_size,
    }
