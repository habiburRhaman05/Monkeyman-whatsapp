"""Webhook receiver for Evolution API events.

Handles CONNECTION_UPDATE, QRCODE_UPDATED, MESSAGES_UPSERT, MESSAGES_UPDATE.
The first payload of each event type is saved (API key redacted, long strings cut)
to docs/payloads/ so parsers can be checked against real data.
"""

import asyncio
import hmac
import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, status

from app import campaign_settings, evolution
from app.config import settings
from app.db import SessionLocal
from app.models import Account, Campaign, CampaignEvent, CampaignRun, Message
from app.normalize import better_status, map_status, parse_edit, parse_message, parse_reaction, parse_revoke
from app.serializers import chat_out, message_out, unread_total
from app.services import apply_edit, apply_reaction, apply_revoke, store_message
from app.sync import sync_account
from app.ws import manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhook", tags=["webhook"])

PAYLOADS_DIR = Path(__file__).resolve().parent.parent.parent.parent / "docs" / "payloads"
PAYLOADS_DIR.mkdir(parents=True, exist_ok=True)
_saved_events: set[str] = set()
_bg_tasks: set[asyncio.Task] = set()


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: ("REDACTED" if k.lower() == "apikey" else _redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value[:5]]
    if isinstance(value, str) and len(value) > 300:
        return value[:300] + "...[cut]"
    return value


def _save_sample(event: str, payload: dict) -> None:
    if event in _saved_events:
        return
    _saved_events.add(event)
    path = PAYLOADS_DIR / f"{event}.json"
    if not path.exists():
        path.write_text(json.dumps(_redact(payload), indent=2, default=str), encoding="utf-8")


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


@router.post("/evolution")
async def evolution_webhook(request: Request, secret: str = Query(...)):
    if not hmac.compare_digest(secret, settings.webhook_secret):
        logger.warning("Webhook rejected: bad secret from %s", request.client.host if request.client else "?")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bad secret")

    body: dict[str, Any] = await request.json()
    event = str(body.get("event", "")).upper().replace(".", "_")
    instance_name = body.get("instance", "")
    logger.info("⚡ Webhook received: %s from %s (ws clients: %d)", event, instance_name, len(manager._connections))
    _save_sample(event, body)

    try:
        if event == "CONNECTION_UPDATE":
            await _handle_connection_update(instance_name, body)
        elif event == "QRCODE_UPDATED":
            await _handle_qrcode_updated(instance_name, body)
        elif event == "MESSAGES_UPSERT":
            await _handle_messages_upsert(instance_name, body)
        elif event == "MESSAGES_UPDATE":
            await _handle_messages_update(instance_name, body)
        elif event == "MESSAGES_DELETE":
            await _handle_messages_delete(instance_name, body)
        elif event == "PRESENCE_UPDATE":
            await _handle_presence_update(instance_name, body)
        else:
            logger.info("Ignoring unhandled webhook event: %s", event)
    except Exception:
        logger.exception("Webhook %s failed", event)
    return {"ok": True}


def _items(data: Any) -> list[dict]:
    if isinstance(data, list):
        return [d for d in data if isinstance(d, dict)]
    return [data] if isinstance(data, dict) else []


async def _delayed_sync(account_id: int) -> None:
    await asyncio.sleep(10)  # let Evolution finish importing history first
    await sync_account(account_id)


async def _handle_connection_update(instance_name: str, body: dict) -> None:
    data = body.get("data") or {}
    state = data.get("state", "")

    db = SessionLocal()
    try:
        acc = db.query(Account).filter_by(instance_name=instance_name).first()
        if not acc:
            return
        was_connected = acc.status == "connected"
        acc.status = "connected" if state == "open" else "disconnected" if state == "close" else "connecting"

        if state == "open":
            try:
                owner = await evolution.fetch_owner_jid(instance_name)
                if owner:
                    acc.phone_number = owner.split("@")[0].split(":")[0]
            except Exception:
                logger.warning("Could not fetch phone number for %s", instance_name)
        db.commit()

        await manager.broadcast(
            "account.status",
            {"account_id": acc.id, "data": {"status": acc.status, "phone_number": acc.phone_number}},
        )
        if acc.status == "connected" and not was_connected:
            _spawn(_delayed_sync(acc.id))
    finally:
        db.close()


async def _handle_qrcode_updated(instance_name: str, body: dict) -> None:
    data = body.get("data") or {}
    qr = data.get("qrcode")
    qr_base64 = qr.get("base64") if isinstance(qr, dict) else qr

    db = SessionLocal()
    try:
        acc = db.query(Account).filter_by(instance_name=instance_name).first()
        if not acc:
            return
        await manager.broadcast(
            "account.status", {"account_id": acc.id, "data": {"status": "connecting", "qr_base64": qr_base64}}
        )
    finally:
        db.close()


async def _handle_messages_upsert(instance_name: str, body: dict) -> None:
    db = SessionLocal()
    try:
        acc = db.query(Account).filter_by(instance_name=instance_name).first()
        if not acc:
            logger.warning("MESSAGES_UPSERT: no account for instance %s", instance_name)
            return
        items = _items(body.get("data"))
        logger.info("MESSAGES_UPSERT: %d item(s) for account %s", len(items), acc.label)
        for item in items:
            reaction = parse_reaction(item)
            if reaction:
                _save_sample("MESSAGES_UPSERT_REACTION", item)
                msg = apply_reaction(db, acc.id, reaction)
                if msg:
                    await manager.broadcast("message.updated", {"account_id": acc.id, "data": {"message": message_out(msg)}})
                continue
            revoked = parse_revoke(item)
            if revoked:
                _save_sample("MESSAGES_UPSERT_REVOKE", item)
                await _announce_revoked(db, acc.id, revoked)
                continue
            edit = parse_edit(item)
            if edit:
                _save_sample("MESSAGES_UPSERT_EDIT", item)
                result = apply_edit(db, acc.id, edit[0], edit[1])
                if result:
                    await manager.broadcast(
                        "message.updated",
                        {"account_id": acc.id, "data": {"message": message_out(result[0]), "chat": chat_out(result[1])}},
                    )
                continue
            p = parse_message(item)
            if not p:
                # Log what we're skipping so we can debug missing message types
                key = item.get("key", {})
                msg_keys = list((item.get("message") or {}).keys()) if isinstance(item.get("message"), dict) else []
                logger.debug("Skipped unparseable message wa_id=%s keys=%s", key.get("id"), msg_keys)
                continue
            chat, msg, created = store_message(db, acc.id, p, bump_unread=True)
            if not created:
                logger.debug("Duplicate message wa_id=%s (already stored)", p.wa_id)
                continue
            logger.info("New message stored: chat=%s type=%s from_me=%s", chat.id, p.type, p.from_me)
            if not p.from_me and chat.jid:
                _check_campaign_reply(db, acc.id, chat.jid)
            total = unread_total(db, acc.id)
            await manager.broadcast(
                "message.new",
                {
                    "account_id": acc.id,
                    "data": {
                        "message": message_out(msg),
                        "chat": chat_out(chat),
                        "account_label": acc.label,
                        "unread_total": total,
                    },
                },
            )
            await manager.broadcast(
                "chat.updated", {"account_id": acc.id, "data": {"chat": chat_out(chat), "unread_total": total}}
            )
    finally:
        db.close()


async def _announce_revoked(db, account_id: int, wa_id: str) -> None:
    result = apply_revoke(db, account_id, wa_id)
    if result:
        msg, chat = result
        await manager.broadcast(
            "message.updated",
            {"account_id": account_id, "data": {"message": message_out(msg), "chat": chat_out(chat)}},
        )


async def _handle_messages_delete(instance_name: str, body: dict) -> None:
    """Evolution's payload shape for this event varies; accept {keys:[...]}, {key:{...}} or {id,...}."""
    db = SessionLocal()
    try:
        acc = db.query(Account).filter_by(instance_name=instance_name).first()
        if not acc:
            return
        for item in _items(body.get("data")):
            keys = item.get("keys") if isinstance(item.get("keys"), list) else [item.get("key") or item]
            for k in keys:
                wa_id = (k.get("id") or k.get("keyId")) if isinstance(k, dict) else None
                if wa_id:
                    await _announce_revoked(db, acc.id, str(wa_id))
    finally:
        db.close()


async def _handle_messages_update(instance_name: str, body: dict) -> None:
    db = SessionLocal()
    try:
        acc = db.query(Account).filter_by(instance_name=instance_name).first()
        if not acc:
            return
        for item in _items(body.get("data")):
            key = item.get("key") if isinstance(item.get("key"), dict) else {}
            wa_id = item.get("keyId") or item.get("messageId") or key.get("id")
            if not wa_id:
                continue
            msg = db.query(Message).filter_by(account_id=acc.id, wa_message_id=str(wa_id)).first()
            if not msg or not msg.from_me:
                continue
            new = map_status(item.get("status"), True)
            if not better_status(msg.status, new):
                continue
            msg.status = new
            db.commit()
            await manager.broadcast(
                "message.status",
                {
                    "account_id": acc.id,
                    "data": {"message_id": msg.id, "chat_id": msg.chat_id, "status": new},
                },
            )
    finally:
        db.close()


def _check_campaign_reply(db, account_id: int, sender_jid: str) -> None:
    """If the sender has any active/waiting campaign runs, mark them as 'replied'."""
    from app.models import ImmediateSession

    phone = sender_jid.split("@")[0].split(":")[0]
    if not phone:
        return

    # Find campaigns with active immediate sessions — replies are always
    # tracked for these regardless of campaign status or stop_on_reply.
    immediate_campaign_ids: set[int] = set()
    active_immediate = db.query(ImmediateSession.campaign_id).filter(
        ImmediateSession.status.in_(("warmup", "running", "paused")),
    ).all()
    for row in active_immediate:
        immediate_campaign_ids.add(row[0])

    # Query by phone — for immediate mode the contact may be assigned to a
    # different sender account than the one receiving the reply, so we cannot
    # restrict to account_id alone.  We still prefer account_id matches, but
    # also pick up any run for an immediate-mode campaign.
    runs = db.query(CampaignRun).filter(
        CampaignRun.phone == phone,
        CampaignRun.status.in_(("active", "waiting", "queued")),
    ).all()
    # Narrow: for regular campaigns keep only runs that match the receiving account
    runs = [
        r for r in runs
        if r.campaign_id in immediate_campaign_ids or r.account_id == account_id
    ]
    changed = False
    for run in runs:
        is_immediate = run.campaign_id in immediate_campaign_ids

        if not is_immediate:
            # Regular campaign: respect campaign status and stop_on_reply
            camp = db.get(Campaign, run.campaign_id)
            if not camp or camp.status != "active":
                continue
            if not campaign_settings.normalize(camp.settings)["stop_on_reply"]:
                continue

        run.status = "replied"
        run.next_run_at = None
        db.add(CampaignEvent(
            run_id=run.id,
            campaign_id=run.campaign_id,
            account_id=run.account_id,
            node_id=run.node_id,
            kind="replied",
            detail=f"Contact replied from {sender_jid}",
        ))
        logger.info("Campaign run %d marked as replied (phone=%s)", run.id, phone)
        changed = True
    if changed:
        db.commit()


async def _handle_presence_update(instance_name: str, body: dict) -> None:
    data = body.get("data") or {}
    jid = data.get("id") or data.get("remoteJid") or ""
    presences = data.get("presences") or {}

    db = SessionLocal()
    try:
        acc = db.query(Account).filter_by(instance_name=instance_name).first()
        if not acc:
            return
        from app.models import Chat
        chat = db.query(Chat).filter_by(account_id=acc.id, jid=jid).first()
        if not chat:
            return
        composing = any(
            p.get("status") in ("composing", "recording")
            for p in (presences.values() if isinstance(presences, dict) else [])
        )
        participant = None
        for pid, p in (presences.items() if isinstance(presences, dict) else []):
            if p.get("status") in ("composing", "recording"):
                participant = p.get("name") or pid.split("@")[0]
                break
        await manager.broadcast(
            "typing",
            {"account_id": acc.id, "data": {"chat_id": chat.id, "composing": composing, "participant": participant}},
        )
    finally:
        db.close()
