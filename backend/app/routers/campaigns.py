"""Campaign CRUD, validation, and run management."""

import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import account_status, campaign_settings
from app.db import get_db
from app.models import Account, Campaign, CampaignEvent, CampaignNodeState, CampaignRun, ImmediateSession, Label, UploadedContact

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/campaigns", tags=["campaigns"])

VALID_STATUSES = {"draft", "active", "paused", "completed"}
VALID_TRIGGERS = {"manual", "tag_added"}
VALID_NODE_TYPES = {"message", "wait", "drip"}


# ── Helpers ──────────────────────────────────────────

def _parse_nodes(raw: str | None) -> list[dict]:
    if not raw:
        return []
    try:
        nodes = json.loads(raw)
        return nodes if isinstance(nodes, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _validate_nodes(nodes: list[dict]) -> list[str]:
    """Return a list of validation errors, empty if valid."""
    errors: list[str] = []
    ids_seen: set[str] = set()
    has_message = False
    for i, node in enumerate(nodes):
        ntype = node.get("type")
        nid = node.get("id")
        if not nid or not isinstance(nid, str):
            errors.append(f"Node {i}: missing id")
        elif nid in ids_seen:
            errors.append(f"Node {i}: duplicate id '{nid}'")
        else:
            ids_seen.add(nid)
        if ntype not in VALID_NODE_TYPES:
            errors.append(f"Node {i}: invalid type '{ntype}'")
            continue
        if ntype == "message":
            has_message = True
            variants = node.get("variants", [])
            if not isinstance(variants, list) or len(variants) < 1:
                errors.append(f"Node {i}: message needs at least 1 variant")
            for vi, v in enumerate(variants):
                if not isinstance(v, str) or not v.strip():
                    errors.append(f"Node {i}: variant {vi} is empty")
        elif ntype == "wait":
            amount = node.get("amount")
            unit = node.get("unit")
            if not isinstance(amount, (int, float)) or amount <= 0:
                errors.append(f"Node {i}: wait amount must be > 0")
            if unit not in ("minutes", "hours", "days"):
                errors.append(f"Node {i}: wait unit must be minutes/hours/days")
        elif ntype == "drip":
            batch_size = node.get("batch_size")
            if not isinstance(batch_size, int) or batch_size < 1:
                errors.append(f"Node {i}: drip batch_size must be >= 1")
            amount = node.get("amount")
            unit = node.get("unit")
            if not isinstance(amount, (int, float)) or amount <= 0:
                errors.append(f"Node {i}: drip interval amount must be > 0")
            if unit not in ("minutes", "hours", "days"):
                errors.append(f"Node {i}: drip interval unit must be minutes/hours/days")
    if not has_message:
        errors.append("Campaign needs at least one Message node")
    return errors


def campaign_out(c: Campaign, db: Session | None = None) -> dict:
    nodes = _parse_nodes(c.nodes)
    sender_ids = json.loads(c.sender_account_ids) if c.sender_account_ids else []
    d: dict[str, Any] = {
        "id": c.id,
        "name": c.name,
        "status": c.status,
        "trigger_type": c.trigger_type,
        "trigger_label_id": c.trigger_label_id,
        "sender_account_ids": sender_ids,
        "nodes": nodes,
        "settings": campaign_settings.normalize(c.settings),
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }
    if c.trigger_type == "tag_added":
        d["tag_cursor"] = c.tag_cursor or 0
        d["tag_last_checked_at"] = c.tag_last_checked_at.isoformat() if c.tag_last_checked_at else None
    if db:
        total = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id).count()
        active = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id, CampaignRun.status.in_(("active", "waiting", "queued"))).count()
        completed = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id, CampaignRun.status == "completed").count()
        replied = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id, CampaignRun.status == "replied").count()
        failed = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id, CampaignRun.status == "failed").count()
        d["counts"] = {"total": total, "active": active, "completed": completed, "replied": replied, "failed": failed}
    return d


# ── CRUD ─────────────────────────────────────────────

class CampaignBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    trigger_type: str = "manual"
    trigger_label_id: int | None = None
    sender_account_ids: list[int] = []
    nodes: list[dict] = []
    settings: dict | None = None


@router.get("/sender-usage")
def sender_usage(tz: str = "UTC", db: Session = Depends(get_db)):
    """Messages each number has sent today (across all campaigns), in the given timezone."""
    st = campaign_settings.normalize({"timezone": tz})
    since = campaign_settings.day_start_utc(st, datetime.now(timezone.utc).replace(tzinfo=None))
    rows = db.query(CampaignEvent.account_id, func.count(CampaignEvent.id)).filter(
        CampaignEvent.kind == "sent", CampaignEvent.at >= since
    ).group_by(CampaignEvent.account_id).all()
    return {"usage": {str(a): n for a, n in rows}}


@router.get("")
def list_campaigns(db: Session = Depends(get_db)):
    camps = db.query(Campaign).order_by(Campaign.updated_at.desc()).all()
    return [campaign_out(c, db) for c in camps]


@router.post("", status_code=201)
def create_campaign(body: CampaignBody, db: Session = Depends(get_db)):
    if body.trigger_type not in VALID_TRIGGERS:
        raise HTTPException(400, f"trigger_type must be one of {VALID_TRIGGERS}")
    if body.trigger_type == "tag_added" and not body.trigger_label_id:
        raise HTTPException(400, "tag_added trigger requires trigger_label_id")
    if body.trigger_label_id:
        if not db.get(Label, body.trigger_label_id):
            raise HTTPException(404, "Label not found")

    c = Campaign(
        name=body.name.strip(),
        trigger_type=body.trigger_type,
        trigger_label_id=body.trigger_label_id,
        sender_account_ids=json.dumps(body.sender_account_ids),
        nodes=json.dumps(body.nodes),
        settings=json.dumps(campaign_settings.normalize(body.settings)),
    )
    db.add(c)
    db.commit()
    return campaign_out(c, db)


@router.get("/{campaign_id}")
def get_campaign(campaign_id: int, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(404, "Campaign not found")
    return campaign_out(c, db)


@router.put("/{campaign_id}")
def update_campaign(campaign_id: int, body: CampaignBody, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(404, "Campaign not found")
    if c.status == "active":
        raise HTTPException(409, "Pause the campaign before editing")
    if body.trigger_type not in VALID_TRIGGERS:
        raise HTTPException(400, f"trigger_type must be one of {VALID_TRIGGERS}")
    if body.trigger_type == "tag_added" and not body.trigger_label_id:
        raise HTTPException(400, "tag_added trigger requires trigger_label_id")

    c.name = body.name.strip()
    c.trigger_type = body.trigger_type
    c.trigger_label_id = body.trigger_label_id
    c.sender_account_ids = json.dumps(body.sender_account_ids)
    c.nodes = json.dumps(body.nodes)
    c.settings = json.dumps(campaign_settings.normalize(body.settings))
    db.commit()
    return campaign_out(c, db)


@router.delete("/{campaign_id}")
def delete_campaign(campaign_id: int, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(404, "Campaign not found")

    active_sess = db.query(ImmediateSession).filter(
        ImmediateSession.campaign_id == c.id,
        ImmediateSession.status.in_(("warmup", "running", "paused")),
    ).first()
    if active_sess:
        from app.immediate_engine import stop_immediate
        stop_immediate(active_sess.id)

    db.query(CampaignEvent).filter(CampaignEvent.campaign_id == c.id).delete()
    db.query(CampaignNodeState).filter(CampaignNodeState.campaign_id == c.id).delete()
    db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id).delete()
    db.query(ImmediateSession).filter(ImmediateSession.campaign_id == c.id).delete()
    db.delete(c)
    db.commit()
    return {"ok": True}


# ── Status ───────────────────────────────────────────

class StatusBody(BaseModel):
    status: str


@router.post("/{campaign_id}/status")
def set_status(campaign_id: int, body: StatusBody, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(404, "Campaign not found")
    if body.status not in ("active", "paused"):
        raise HTTPException(400, "Status must be 'active' or 'paused'")

    if body.status == "active":
        nodes = _parse_nodes(c.nodes)
        errors = _validate_nodes(nodes)
        if errors:
            raise HTTPException(400, f"Cannot activate: {'; '.join(errors)}")
        if c.trigger_type == "tag_added":
            sender_ids = json.loads(c.sender_account_ids) if c.sender_account_ids else []
            if not sender_ids:
                raise HTTPException(400, "tag_added campaigns need at least one default sender number")

    c.status = body.status
    db.commit()
    return campaign_out(c, db)


# ── Stats ────────────────────────────────────────────

@router.get("/{campaign_id}/stats")
def campaign_stats(campaign_id: int, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(404, "Campaign not found")

    runs = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id).all()
    by_status: dict[str, int] = {}
    by_account: dict[int, dict[str, int]] = {}
    for r in runs:
        by_status[r.status] = by_status.get(r.status, 0) + 1
        acct = by_account.setdefault(r.account_id, {})
        acct[r.status] = acct.get(r.status, 0) + 1

    sent_events = db.query(CampaignEvent).filter(
        CampaignEvent.campaign_id == c.id, CampaignEvent.kind == "sent"
    ).count()

    return {
        "by_status": by_status,
        "by_account": by_account,
        "total_sent": sent_events,
        "total_runs": len(runs),
    }


@router.get("/{campaign_id}/tag-stats")
def tag_stats(campaign_id: int, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(404, "Campaign not found")

    total_contacts = 0
    if c.trigger_label_id:
        from app.models import ContactBatch
        batch_ids = [b.id for b in db.query(ContactBatch.id).filter(ContactBatch.label_id == c.trigger_label_id).all()]
        if batch_ids:
            total_contacts = db.query(UploadedContact).filter(UploadedContact.batch_id.in_(batch_ids)).count()

    total_runs = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id).count()
    active_runs = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id, CampaignRun.status.in_(("active", "waiting", "queued"))).count()
    completed_runs = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id, CampaignRun.status == "completed").count()
    failed_runs = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id, CampaignRun.status == "failed").count()
    sent_events = db.query(CampaignEvent).filter(CampaignEvent.campaign_id == c.id, CampaignEvent.kind == "sent").count()

    active_session = db.query(ImmediateSession).filter(
        ImmediateSession.campaign_id == c.id,
        ImmediateSession.status.in_(("warmup", "running", "paused")),
    ).first()

    return {
        "campaign_id": c.id,
        "status": c.status,
        "trigger_type": c.trigger_type,
        "tag_cursor": c.tag_cursor or 0,
        "tag_last_checked_at": c.tag_last_checked_at.isoformat() if c.tag_last_checked_at else None,
        "total_contacts": total_contacts,
        "total_enrolled": total_runs,
        "active_runs": active_runs,
        "completed_runs": completed_runs,
        "failed_runs": failed_runs,
        "total_sent": sent_events,
        "has_active_session": active_session is not None,
        "session_status": active_session.status if active_session else None,
    }


# ── Runs ─────────────────────────────────────────────

def run_out(r: CampaignRun, db: Session | None = None) -> dict:
    d: dict[str, Any] = {
        "id": r.id,
        "campaign_id": r.campaign_id,
        "account_id": r.account_id,
        "phone": r.phone,
        "jid": r.jid,
        "uploaded_contact_id": r.uploaded_contact_id,
        "chat_id": r.chat_id,
        "status": r.status,
        "node_id": r.node_id,
        "next_run_at": r.next_run_at.isoformat() if r.next_run_at else None,
        "last_sent_at": r.last_sent_at.isoformat() if r.last_sent_at else None,
        "enrolled_at": r.enrolled_at.isoformat() if r.enrolled_at else None,
    }
    if db and r.uploaded_contact_id:
        uc = db.get(UploadedContact, r.uploaded_contact_id)
        if uc:
            d["contact_name"] = uc.name or f"{uc.first_name or ''} {uc.last_name or ''}".strip() or None
    return d


def event_out(e: CampaignEvent) -> dict:
    return {
        "id": e.id,
        "run_id": e.run_id,
        "node_id": e.node_id,
        "kind": e.kind,
        "variant_index": e.variant_index,
        "detail": e.detail,
        "at": e.at.isoformat() if e.at else None,
    }


@router.get("/{campaign_id}/runs")
def list_runs(
    campaign_id: int,
    status: str | None = None,
    account_id: int | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(404, "Campaign not found")
    q = db.query(CampaignRun).filter(CampaignRun.campaign_id == c.id)
    if status:
        q = q.filter(CampaignRun.status == status)
    if account_id:
        q = q.filter(CampaignRun.account_id == account_id)
    total = q.count()
    runs = q.order_by(CampaignRun.enrolled_at.desc()).offset(offset).limit(min(limit, 200)).all()
    return {"runs": [run_out(r, db) for r in runs], "total": total}


@router.get("/{campaign_id}/events")
def list_events(
    campaign_id: int,
    run_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(404, "Campaign not found")
    q = db.query(CampaignEvent).filter(CampaignEvent.campaign_id == c.id)
    if run_id:
        q = q.filter(CampaignEvent.run_id == run_id)
    total = q.count()
    events = q.order_by(CampaignEvent.at.desc()).offset(offset).limit(min(limit, 500)).all()
    return {"events": [event_out(e) for e in events], "total": total}


# ── Enrollment ──────────────────────────────────────

class EnrollBody(BaseModel):
    batch_id: int | None = None
    contact_ids: list[int] | None = None

@router.post("/{campaign_id}/enroll")
async def enroll_contacts(campaign_id: int, body: EnrollBody, db: Session = Depends(get_db)):
    """Enroll contacts into a campaign. Creates CampaignRun entries for each contact."""
    from app.models import UploadedContact, ContactSender

    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(404, "Campaign not found")

    sender_ids = json.loads(c.sender_account_ids) if c.sender_account_ids else []
    if not sender_ids:
        raise HTTPException(400, "Campaign has no sender numbers assigned")

    # Ask Evolution which of the chosen numbers are connected right now — the
    # status in the database can be stale if no CONNECTION_UPDATE arrived.
    all_senders = db.query(Account).filter(Account.id.in_(sender_ids)).all()
    for sender in all_senders:
        await account_status.refresh_status(db, sender)
    db.commit()

    senders = [s for s in all_senders if s.status == "connected"]
    if not senders:
        names = ", ".join(s.label for s in all_senders) or "the selected numbers"
        raise HTTPException(
            400,
            f"No connected sender accounts. Not connected: {names}. Connect the number in Numbers, then try again.",
        )

    # Gather contacts
    query = db.query(UploadedContact)
    if body.contact_ids:
        query = query.filter(UploadedContact.id.in_(body.contact_ids))
    elif body.batch_id is not None:
        query = query.filter(UploadedContact.batch_id == body.batch_id)
    else:
        raise HTTPException(400, "Provide batch_id or contact_ids")

    contacts = query.all()
    if not contacts:
        raise HTTPException(400, "No contacts to enroll")

    # Any run for this campaign blocks a second one — campaign_runs has a unique
    # (campaign_id, phone) constraint, so re-enrolling a contact that already
    # finished would otherwise crash with a 500.
    existing = {
        r.phone for r in db.query(CampaignRun.phone).filter(CampaignRun.campaign_id == c.id).all()
    }

    enrolled = 0
    skipped = 0
    sender_idx = 0
    connected_ids = {s.id for s in senders}

    for uc in contacts:
        if uc.phone in existing:
            skipped += 1
            continue

        # Sticky sender assignment: check if this phone already has an assigned sender
        sticky = db.query(ContactSender).filter_by(phone=uc.phone).first()
        if sticky and sticky.account_id in connected_ids:
            account_id = sticky.account_id
        else:
            account_id = senders[sender_idx % len(senders)].id
            sender_idx += 1
            if not sticky:
                db.add(ContactSender(phone=uc.phone, account_id=account_id))

        run = CampaignRun(
            campaign_id=c.id,
            account_id=account_id,
            phone=uc.phone,
            jid=uc.wa_jid,
            uploaded_contact_id=uc.id,
            status="active",
            node_id=None,
        )
        db.add(run)
        enrolled += 1
        existing.add(uc.phone)

    db.commit()
    logger.info("Enrolled %d contacts into campaign %d (skipped %d)", enrolled, c.id, skipped)
    return {"enrolled": enrolled, "skipped": skipped}


@router.post("/{campaign_id}/runs/{run_id}/stop")
def stop_run(campaign_id: int, run_id: int, db: Session = Depends(get_db)):
    r = db.query(CampaignRun).filter(CampaignRun.id == run_id, CampaignRun.campaign_id == campaign_id).first()
    if not r:
        raise HTTPException(404, "Run not found")
    if r.status in ("completed", "replied", "stopped", "failed", "skipped"):
        raise HTTPException(409, f"Run already {r.status}")
    r.status = "stopped"
    r.next_run_at = None
    db.commit()
    return run_out(r, db)


# ── Immediate Start ───────────────────────────────────


class SenderAssignment(BaseModel):
    account_id: int
    contact_ids: list[int]


class ImmediateStartBody(BaseModel):
    sender_assignments: list[SenderAssignment]
    delay: int = Field(default=10, ge=1)


@router.post("/{campaign_id}/immediate-start")
async def immediate_start(campaign_id: int, body: ImmediateStartBody, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(404, "Campaign not found")

    nodes = _parse_nodes(c.nodes)
    if not nodes:
        raise HTTPException(400, "Campaign has no nodes")

    # A contact may only ride with one sender: a duplicate assignment would send
    # it twice and make the per-step sent/failed counters disagree.
    claimed: set[int] = set()
    assignments: list[dict] = []
    for sa in body.sender_assignments:
        acc = db.get(Account, sa.account_id)
        if not acc:
            raise HTTPException(400, f"Account {sa.account_id} not found")
        ids = [cid for cid in dict.fromkeys(sa.contact_ids) if cid not in claimed]
        claimed.update(ids)
        if not ids:
            continue
        # Live check: a stale "connected" in the database would try to send from
        # a number that is not linked and mark every contact as failed.
        status = await account_status.refresh_status(db, acc)
        if status != "connected":
            db.commit()
            raise HTTPException(
                400,
                f"'{acc.label}' is not connected. Connect the number in Numbers, or uncheck it.",
            )
        assignments.append({"account_id": sa.account_id, "contact_ids": ids})

    if not assignments:
        raise HTTPException(400, "No contacts assigned to any sender number")

    existing = db.query(ImmediateSession).filter(
        ImmediateSession.campaign_id == campaign_id,
        ImmediateSession.status.in_(("warmup", "running", "paused")),
    ).order_by(ImmediateSession.id.desc()).first()
    if existing:
        from app.immediate_engine import has_active_task

        if existing.status == "warmup" and not has_active_task(existing.id):
            # Abandoned warmup: the browser's 30s countdown never finished, so the
            # session would sit there forever and block every new start.
            logger.info("Replacing abandoned warmup session %d (campaign %d)", existing.id, campaign_id)
            existing.status = "failed"
            existing.finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.commit()
        else:
            raise HTTPException(409, "An immediate session is already active for this campaign")

    config = {
        "sender_assignments": assignments,
        "delay": body.delay,
    }

    sess = ImmediateSession(
        campaign_id=campaign_id,
        config=json.dumps(config),
        status="warmup",
    )
    db.add(sess)
    db.commit()
    db.refresh(sess)

    return {
        "session_id": sess.id,
        "status": sess.status,
        "campaign_id": campaign_id,
    }


@router.post("/{campaign_id}/immediate-launch/{session_id}")
async def immediate_launch(campaign_id: int, session_id: int, db: Session = Depends(get_db)):
    from app.immediate_engine import has_active_task, start_immediate

    sess = db.get(ImmediateSession, session_id)
    if not sess or sess.campaign_id != campaign_id:
        raise HTTPException(404, "Session not found")
    if sess.status not in ("warmup", "running"):
        raise HTTPException(409, f"Session is {sess.status}")

    if sess.status == "warmup":
        sess.status = "running"
        db.commit()

    # Idempotent: the watchdog may already have started this session.
    if not has_active_task(session_id):
        start_immediate(session_id)

    return {"session_id": session_id, "status": "running"}


@router.post("/{campaign_id}/immediate-pause/{session_id}")
def immediate_pause(campaign_id: int, session_id: int, db: Session = Depends(get_db)):
    from app.immediate_engine import pause_immediate, resume_immediate

    sess = db.get(ImmediateSession, session_id)
    if not sess or sess.campaign_id != campaign_id:
        raise HTTPException(404, "Session not found")

    if sess.status == "running":
        pause_immediate(session_id)
        return {"session_id": session_id, "status": "paused"}
    elif sess.status == "paused":
        resume_immediate(session_id)
        return {"session_id": session_id, "status": "running"}
    else:
        raise HTTPException(409, f"Session is {sess.status}")


@router.post("/{campaign_id}/immediate-stop/{session_id}")
def immediate_stop(campaign_id: int, session_id: int, db: Session = Depends(get_db)):
    from app.immediate_engine import stop_immediate

    sess = db.get(ImmediateSession, session_id)
    if not sess or sess.campaign_id != campaign_id:
        raise HTTPException(404, "Session not found")

    stop_immediate(session_id)
    return {"session_id": session_id, "status": "completed"}


@router.get("/{campaign_id}/immediate-active")
def immediate_active(campaign_id: int, db: Session = Depends(get_db)):
    sess = db.query(ImmediateSession).filter(
        ImmediateSession.campaign_id == campaign_id,
        ImmediateSession.status.in_(("warmup", "running", "paused")),
    ).order_by(ImmediateSession.id.desc()).first()
    if not sess:
        return {"active": False}

    config = json.loads(sess.config)
    return {
        "active": True,
        "session_id": sess.id,
        "status": sess.status,
        "current_node_index": sess.current_node_index,
        "config": config,
        "started_at": sess.started_at.isoformat() if sess.started_at else None,
    }


@router.get("/{campaign_id}/immediate-progress/{session_id}")
def immediate_progress(campaign_id: int, session_id: int, db: Session = Depends(get_db)):
    sess = db.get(ImmediateSession, session_id)
    if not sess or sess.campaign_id != campaign_id:
        raise HTTPException(404, "Session not found")

    campaign = db.get(Campaign, campaign_id)
    nodes = _parse_nodes(campaign.nodes) if campaign else []
    index_by_node_id: dict[str, int] = {
        node["id"]: i for i, node in enumerate(nodes) if node.get("id")
    }

    config = json.loads(sess.config)
    all_contact_ids: list[int] = []
    for sa in config.get("sender_assignments", []):
        all_contact_ids.extend(sa.get("contact_ids", []))

    contacts_by_id = {
        uc.id: uc
        for uc in db.query(UploadedContact).filter(UploadedContact.id.in_(all_contact_ids)).all()
    } if all_contact_ids else {}

    runs = db.query(CampaignRun).filter(CampaignRun.campaign_id == campaign_id).all()
    run_by_id = {r.id: r for r in runs}
    run_by_contact: dict[int, CampaignRun] = {}
    run_by_phone: dict[str, CampaignRun] = {}
    for r in runs:
        if r.uploaded_contact_id:
            run_by_contact.setdefault(r.uploaded_contact_id, r)
        run_by_phone.setdefault(r.phone, r)

    # Only the runs belonging to the contacts of this session may contribute.
    session_run_ids: set[int] = set()
    for cid in all_contact_ids:
        uc = contacts_by_id.get(cid)
        run = run_by_contact.get(cid) or (run_by_phone.get(uc.phone) if uc else None)
        if run:
            session_run_ids.add(run.id)

    # Delivery state comes from the event log only. run.status is workflow state
    # ("active" just means enrolled), so it must never be reported as "sent".
    events = db.query(CampaignEvent).filter(
        CampaignEvent.campaign_id == campaign_id,
        CampaignEvent.kind.in_(("sent", "failed", "skipped")),
        CampaignEvent.run_id.in_(session_run_ids),
    ).order_by(CampaignEvent.at.asc(), CampaignEvent.id.asc()).all() if session_run_ids else []

    node_stats: dict[str, dict[str, int]] = {
        node_id: {"sent": 0, "failed": 0} for node_id in index_by_node_id
    }
    history: dict[int, list[dict]] = {}
    for ev in events:
        run = run_by_id.get(ev.run_id)
        if not run or not ev.node_id or ev.node_id not in index_by_node_id:
            continue
        ni = index_by_node_id[ev.node_id]
        if ev.kind == "sent":
            node_stats[ev.node_id]["sent"] += 1
        elif ev.kind == "failed":
            node_stats[ev.node_id]["failed"] += 1
        if run.uploaded_contact_id:
            hist = history.setdefault(run.uploaded_contact_id, [])
            current = next((h for h in hist if h["node_index"] == ni), None)
            if current is None:
                hist.append({"node_index": ni, "status": ev.kind})
            else:
                current["status"] = ev.kind

    def _stats(node_id: str | None) -> dict[str, int]:
        return node_stats.get(node_id or "", {"sent": 0, "failed": 0})

    # Session progress still holds drip/wait metadata; the sent/failed numbers
    # are recalculated from the event log so they can never drift.
    stored: dict[int, dict] = {}
    if sess.progress:
        try:
            payload = json.loads(sess.progress)
            if isinstance(payload, dict):
                for entry in payload.get("nodes") or []:
                    if isinstance(entry, dict) and entry.get("node_index") is not None:
                        stored[entry["node_index"]] = entry
        except (json.JSONDecodeError, TypeError):
            stored = {}

    progress_nodes = []
    for ni, node in enumerate(nodes):
        entry = dict(stored.get(ni) or {})
        entry["node_index"] = ni
        entry["node_id"] = node.get("id")
        entry["type"] = node.get("type")
        stats = _stats(node.get("id"))
        entry["sent"] = stats["sent"]
        entry["failed"] = stats["failed"]
        entry["senders"] = [dict(stats)]
        progress_nodes.append(entry)

    progress = {"nodes": progress_nodes, "replied_contacts": []}

    contact_statuses = []
    cur_ni = sess.current_node_index if sess.current_node_index is not None else 0
    for cid in all_contact_ids:
        uc = contacts_by_id.get(cid)
        if not uc:
            continue
        hist = history.get(cid, [])
        latest = hist[-1] if hist else None
        run = run_by_contact.get(cid) or run_by_phone.get(uc.phone)
        if latest:
            status = latest["status"]
            node_index = latest["node_index"]
        elif run and run.status == "replied":
            status = "skipped"
            node_index = cur_ni
        else:
            status = "pending"
            node_index = cur_ni
        contact_statuses.append({
            "contact_id": cid,
            "phone": uc.phone,
            "name": uc.name or uc.phone,
            "status": status,
            "node_index": node_index,
            "node_id": nodes[node_index].get("id") if 0 <= node_index < len(nodes) else None,
            "history": hist,
        })

    return {
        "session_id": sess.id,
        "status": sess.status,
        "current_node_index": sess.current_node_index,
        "progress": progress,
        "contacts": contact_statuses,
        "started_at": sess.started_at.isoformat() if sess.started_at else None,
        "finished_at": sess.finished_at.isoformat() if sess.finished_at else None,
    }
