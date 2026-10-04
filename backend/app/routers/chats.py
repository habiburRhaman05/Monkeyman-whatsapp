"""Chats, contacts, messages, sending (text + voice), media, sync."""

import asyncio
import logging
import re
import time
import uuid
from datetime import timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session, selectinload

from app import evolution
from app.config import settings
from app.db import SessionLocal, get_db
from app.models import Account, Chat, Contact, Message, utcnow
from app.normalize import skip_jid
from app.serializers import chat_out, contact_out, message_out, unread_total
from app.services import apply_edit, apply_revoke, get_or_create_chat, set_quote_from, set_reaction, touch_chat
from app.sync import sync_account
from app.ws import manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/accounts/{account_id}", tags=["chats"])

_locks: dict[int, asyncio.Lock] = {}
_last_send: dict[int, float] = {}
_bg_tasks: set[asyncio.Task] = set()
MIN_SEND_GAP = 1.0  # seconds between sends per account


# ── helpers ───────────────────────────────────────────────

def _account(db: Session, account_id: int) -> Account:
    acc = db.get(Account, account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    return acc


def _chat(db: Session, acc: Account, chat_id: int) -> Chat:
    chat = db.get(Chat, chat_id)
    if not chat or chat.account_id != acc.id:
        raise HTTPException(404, "Chat not found")
    return chat


def _jid_from_number(to: str) -> str:
    digits = re.sub(r"\D", "", to)
    if not 6 <= len(digits) <= 15:
        raise HTTPException(400, "Enter the phone number with country code (6-15 digits)")
    return f"{digits}@s.whatsapp.net"


def _resolve_chat(db: Session, acc: Account, chat_id: int | None, to: str | None) -> Chat:
    if chat_id:
        return _chat(db, acc, chat_id)
    if to:
        jid = to if "@" in to else _jid_from_number(to)
        if skip_jid(jid):
            raise HTTPException(400, "Invalid recipient")
        chat = get_or_create_chat(db, acc.id, jid)
        db.commit()
        return chat
    raise HTTPException(400, "chat_id or to is required")


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


# ── read ──────────────────────────────────────────────────

@router.get("/chats")
def list_chats(account_id: int, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    chats = (
        db.query(Chat)
        .options(selectinload(Chat.label_links))
        .filter(Chat.account_id == acc.id)
        .order_by(Chat.last_message_at.is_(None), Chat.last_message_at.desc())
        .all()
    )
    return [chat_out(c) for c in chats]


@router.get("/lid-map")
async def lid_map(account_id: int, db: Session = Depends(get_db)):
    """Return @lid → @s.whatsapp.net mapping from group participants. Cached per page load on the frontend."""
    acc = _account(db, account_id)
    if acc.status != "connected":
        return {}
    group_jids = [
        c.jid for c in db.query(Chat.jid).filter(
            Chat.account_id == acc.id, Chat.jid.like("%@g.us")
        ).all()
    ]
    if not group_jids:
        return {}
    try:
        return await evolution.find_all_group_participants(acc.instance_name, group_jids)
    except Exception as exc:
        logger.warning("lid-map failed for account %s: %s", account_id, exc)
        return {}


@router.get("/contacts")
def list_contacts(account_id: int, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    rows = db.query(Contact).filter(Contact.account_id == acc.id).all()
    rows.sort(key=lambda c: ((c.name or c.jid).lower()))
    return [contact_out(c) for c in rows]


class OpenChatBody(BaseModel):
    to: str


@router.post("/chats")
def open_chat(account_id: int, body: OpenChatBody, db: Session = Depends(get_db)):
    """Get or create a chat from a phone number or jid (used by contacts list and 'New chat')."""
    acc = _account(db, account_id)
    chat = _resolve_chat(db, acc, None, body.to)
    return chat_out(chat)


@router.get("/chats/{chat_id}/messages")
def list_messages(
    account_id: int,
    chat_id: int,
    before: int | None = None,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    acc = _account(db, account_id)
    chat = _chat(db, acc, chat_id)
    q = db.query(Message).filter(Message.chat_id == chat.id, Message.hidden.is_not(True))
    if before:
        ref = db.get(Message, before)
        if ref and ref.chat_id == chat.id:
            q = q.filter(
                or_(Message.timestamp < ref.timestamp, and_(Message.timestamp == ref.timestamp, Message.id < ref.id))
            )
    rows = q.order_by(Message.timestamp.desc(), Message.id.desc()).limit(limit + 1).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    rows.reverse()
    return {"messages": [message_out(m) for m in rows], "has_more": has_more}


async def _send_read_receipts(account_id: int, items: list[dict]) -> None:
    db = SessionLocal()
    try:
        acc = db.get(Account, account_id)
        if not acc or acc.status != "connected":
            return
        await evolution.mark_messages_read(acc.instance_name, items)
    except (evolution.EvolutionError, httpx.HTTPError) as exc:
        logger.warning("Read receipt failed (account %s): %s", account_id, type(exc).__name__)
    finally:
        db.close()


@router.post("/chats/{chat_id}/read")
async def mark_read(account_id: int, chat_id: int, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    chat = _chat(db, acc, chat_id)
    if chat.unread_count:
        if settings.send_read_receipts and acc.status == "connected":
            unread = (
                db.query(Message)
                .filter(Message.chat_id == chat.id, Message.from_me.is_(False), Message.deleted.is_not(True))
                .order_by(Message.timestamp.desc(), Message.id.desc())
                .limit(min(chat.unread_count, 20))
                .all()
            )
            items = []
            for m in unread:
                item = {"remoteJid": chat.jid, "fromMe": False, "id": m.wa_message_id}
                if chat.is_group and m.sender_jid:
                    item["participant"] = m.sender_jid
                items.append(item)
            if items:
                _spawn(_send_read_receipts(acc.id, items))
        chat.unread_count = 0
        db.commit()
        await manager.broadcast(
            "chat.updated",
            {"account_id": acc.id, "data": {"chat": chat_out(chat), "unread_total": unread_total(db, acc.id)}},
        )
    return {"ok": True}


@router.post("/chats/{chat_id}/clear")
async def clear_chat(account_id: int, chat_id: int, db: Session = Depends(get_db)):
    """Hide every message in this chat from the dashboard only (WhatsApp/the other side keep their copy)."""
    acc = _account(db, account_id)
    chat = _chat(db, acc, chat_id)
    db.query(Message).filter(Message.chat_id == chat.id, Message.hidden.is_not(True)).update(
        {Message.hidden: True}, synchronize_session=False
    )
    chat.last_message_preview = None
    db.commit()
    await manager.broadcast("chat.updated", {"account_id": acc.id, "data": {"chat": chat_out(chat)}})
    return {"ok": True}


# ── sync ──────────────────────────────────────────────────

@router.post("/sync")
async def sync(account_id: int, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    _spawn(sync_account(acc.id))
    return {"started": True}


# ── media (on demand) ─────────────────────────────────────

@router.get("/messages/{message_id}/media")
async def message_media(account_id: int, message_id: int, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    msg = db.get(Message, message_id)
    if not msg or msg.account_id != acc.id:
        raise HTTPException(404, "Message not found")
    if msg.type not in ("image", "video", "audio", "sticker", "document"):
        raise HTTPException(400, "Message has no media")
    try:
        data = await evolution.get_media_base64(acc.instance_name, msg.wa_message_id)
    except evolution.EvolutionError as exc:
        raise HTTPException(502, f"Media not available: {exc.detail[:200]}")
    except httpx.HTTPError:
        raise HTTPException(502, "WhatsApp service is unavailable")
    b64 = data.get("base64") if isinstance(data, dict) else None
    if not b64:
        raise HTTPException(502, "Media not available")
    mime = data.get("mimetype") or "application/octet-stream"
    if b64.startswith("data:"):
        return {"data_url": b64}
    return {"data_url": f"data:{mime};base64,{b64}"}


# ── send ──────────────────────────────────────────────────

class SendText(BaseModel):
    chat_id: int | None = None
    to: str | None = None
    text: str
    client_id: str | None = None
    quoted_message_id: str | None = None
    mentioned: list[str] | None = None  # digit-only phone numbers to ping in a group


class SendVoice(BaseModel):
    chat_id: int | None = None
    to: str | None = None
    audio_base64: str
    client_id: str | None = None


class SendMedia(BaseModel):
    chat_id: int | None = None
    to: str | None = None
    media_base64: str
    media_type: str  # image | video | document
    mimetype: str
    filename: str | None = None
    caption: str | None = None
    client_id: str | None = None
    quoted_message_id: str | None = None


class SendReaction(BaseModel):
    emoji: str = Field("", max_length=16)  # empty string removes your reaction


class DeleteBody(BaseModel):
    scope: str = "me"  # "me" (hide in this dashboard) | "everyone"


class ForwardMessage(BaseModel):
    to_chat_id: int | None = None
    to: str | None = None


def _create_pending(db: Session, acc: Account, chat: Chat, msg_type: str, text: str | None, client_id: str | None):
    now = utcnow()
    msg = Message(
        account_id=acc.id,
        chat_id=chat.id,
        wa_message_id=f"pending-{uuid.uuid4().hex}",
        client_id=client_id,
        from_me=True,
        type=msg_type,
        text=text,
        status="pending",
        timestamp=now,
    )
    db.add(msg)
    touch_chat(chat, now, msg_type, text)
    db.commit()
    db.refresh(msg)
    db.refresh(chat)
    return msg


def _attach_quote(db: Session, acc: Account, chat: Chat, msg: Message, quoted_wa_id: str | None) -> None:
    """Remember what this reply quotes, so the dashboard can show it (the phone gets it via Evolution)."""
    if not quoted_wa_id:
        return
    q = db.query(Message).filter_by(account_id=acc.id, wa_message_id=quoted_wa_id, chat_id=chat.id).first()
    if q:
        set_quote_from(msg, q, chat)
        db.commit()
        db.refresh(msg)


def _build_quoted(db: Session, account_id: int, chat: Chat, quoted_wa_id: str | None) -> dict | None:
    """Evolution 'quoted' object: full key (fromMe + group sender) and, for text, the quoted content."""
    if not quoted_wa_id:
        return None
    q = db.query(Message).filter_by(account_id=account_id, wa_message_id=quoted_wa_id, chat_id=chat.id).first()
    if not q:
        return {"key": {"remoteJid": chat.jid, "id": quoted_wa_id, "fromMe": False}}
    key: dict = {"remoteJid": chat.jid, "id": q.wa_message_id, "fromMe": bool(q.from_me)}
    if chat.is_group and not q.from_me and q.sender_jid:
        key["participant"] = q.sender_jid
    quoted: dict = {"key": key}
    if q.type == "text" and q.text:
        quoted["message"] = {"conversation": q.text}
    return quoted


async def _announce_new(db: Session, acc: Account, chat: Chat, msg: Message) -> None:
    total = unread_total(db, acc.id)
    await manager.broadcast(
        "message.new",
        {
            "account_id": acc.id,
            "data": {"message": message_out(msg), "chat": chat_out(chat), "account_label": acc.label, "unread_total": total},
        },
    )
    await manager.broadcast("chat.updated", {"account_id": acc.id, "data": {"chat": chat_out(chat), "unread_total": total}})


async def _deliver(
    account_id: int,
    message_id: int,
    kind: str,
    payload: str,
    quoted_wa_id: str | None = None,
    mentioned: list[str] | None = None,
) -> None:
    """Background sender: throttled to ~1 msg/s per account. Never logs message content."""
    db = SessionLocal()
    try:
        acc = db.get(Account, account_id)
        msg = db.get(Message, message_id)
        if not acc or not msg:
            return
        chat = db.get(Chat, msg.chat_id)
        lock = _locks.setdefault(account_id, asyncio.Lock())
        resp = None
        ok = True
        async with lock:
            gap = time.monotonic() - _last_send.get(account_id, 0.0)
            if gap < MIN_SEND_GAP:
                await asyncio.sleep(MIN_SEND_GAP - gap)
            try:
                quoted = _build_quoted(db, account_id, chat, quoted_wa_id)
                if kind == "text":
                    resp = await evolution.send_text(acc.instance_name, chat.jid, payload, quoted_msg=quoted, mentioned=mentioned)
                else:
                    resp = await evolution.send_audio(acc.instance_name, chat.jid, payload)
            except evolution.EvolutionError as exc:
                ok = False
                logger.warning("Send failed (account %s): HTTP %s", account_id, exc.status_code)
            except httpx.HTTPError:
                ok = False
                logger.warning("Send failed (account %s): Evolution unreachable", account_id)
            _last_send[account_id] = time.monotonic()

        if not ok:
            msg.status = "failed"
            db.commit()
            await manager.broadcast(
                "message.status",
                {"account_id": account_id, "data": {"message_id": msg.id, "chat_id": msg.chat_id, "status": "failed"}},
            )
            return

        wa_id = (((resp or {}).get("key")) or {}).get("id")
        if wa_id:
            echo = db.query(Message).filter(
                Message.account_id == account_id, Message.wa_message_id == wa_id, Message.id != msg.id
            ).first()
            if echo:
                # The webhook echo arrived before the API reply: keep one row, carry the client_id.
                echo.client_id = msg.client_id
                db.delete(msg)
                db.commit()
                db.refresh(echo)
                await _announce_new(db, acc, chat, echo)
                return
            msg.wa_message_id = wa_id
        if msg.status == "pending":
            msg.status = "sent"
        db.commit()
        await manager.broadcast(
            "message.status",
            {"account_id": account_id, "data": {"message_id": msg.id, "chat_id": msg.chat_id, "status": msg.status}},
        )
    except Exception:
        logger.exception("Deliver crashed for message %s", message_id)
    finally:
        db.close()


@router.post("/send")
async def send_text(account_id: int, body: SendText, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Message is empty")
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    chat = _resolve_chat(db, acc, body.chat_id, body.to)
    msg = _create_pending(db, acc, chat, "text", text, body.client_id)
    _attach_quote(db, acc, chat, msg, body.quoted_message_id)
    await _announce_new(db, acc, chat, msg)
    mentioned = [re.sub(r"\D", "", m) for m in body.mentioned] if body.mentioned else None
    mentioned = [m for m in mentioned if m] if mentioned else None
    _spawn(_deliver(acc.id, msg.id, "text", text, quoted_wa_id=body.quoted_message_id, mentioned=mentioned))
    return {"message": message_out(msg), "chat": chat_out(chat)}


@router.post("/send-voice")
async def send_voice(account_id: int, body: SendVoice, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    audio = body.audio_base64
    if audio.startswith("data:"):
        audio = audio.split(",", 1)[-1]
    if len(audio) < 100:
        raise HTTPException(400, "Recording is empty")
    if len(audio) > 20_000_000:
        raise HTTPException(413, "Recording is too long")
    chat = _resolve_chat(db, acc, body.chat_id, body.to)
    msg = _create_pending(db, acc, chat, "audio", None, body.client_id)
    await _announce_new(db, acc, chat, msg)
    _spawn(_deliver(acc.id, msg.id, "audio", audio))
    return {"message": message_out(msg), "chat": chat_out(chat)}


@router.post("/messages/{message_id}/retry")
async def retry_message(account_id: int, message_id: int, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    msg = db.get(Message, message_id)
    if not msg or msg.account_id != acc.id or not msg.from_me:
        raise HTTPException(404, "Message not found")
    if msg.status != "failed" or msg.type != "text" or not msg.text:
        raise HTTPException(400, "Only failed text messages can be retried")
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    msg.status = "pending"
    db.commit()
    await manager.broadcast(
        "message.status",
        {"account_id": acc.id, "data": {"message_id": msg.id, "chat_id": msg.chat_id, "status": "pending"}},
    )
    _spawn(_deliver(acc.id, msg.id, "text", msg.text))
    return {"message": message_out(msg)}


# ── send media (image/video/document) ─────────────────────

async def _deliver_media(account_id: int, message_id: int, payload: dict) -> None:
    db = SessionLocal()
    try:
        acc = db.get(Account, account_id)
        msg = db.get(Message, message_id)
        if not acc or not msg:
            return
        chat = db.get(Chat, msg.chat_id)
        lock = _locks.setdefault(account_id, asyncio.Lock())
        ok = True
        async with lock:
            gap = time.monotonic() - _last_send.get(account_id, 0.0)
            if gap < MIN_SEND_GAP:
                await asyncio.sleep(MIN_SEND_GAP - gap)
            try:
                quoted = _build_quoted(db, account_id, chat, payload.get("quoted_message_id"))
                resp = await evolution.send_media(
                    acc.instance_name, chat.jid,
                    media_type=payload["media_type"],
                    media_b64=payload["media"],
                    mimetype=payload["mimetype"],
                    filename=payload.get("filename"),
                    caption=payload.get("caption"),
                    quoted_msg=quoted,
                )
            except (evolution.EvolutionError, httpx.HTTPError):
                ok = False
            _last_send[account_id] = time.monotonic()

        if not ok:
            msg.status = "failed"
            db.commit()
            await manager.broadcast(
                "message.status",
                {"account_id": account_id, "data": {"message_id": msg.id, "chat_id": msg.chat_id, "status": "failed"}},
            )
            return

        wa_id = (((resp or {}).get("key")) or {}).get("id")
        if wa_id:
            msg.wa_message_id = wa_id
        if msg.status == "pending":
            msg.status = "sent"
        db.commit()
        await manager.broadcast(
            "message.status",
            {"account_id": account_id, "data": {"message_id": msg.id, "chat_id": msg.chat_id, "status": msg.status}},
        )
    except Exception:
        logger.exception("Deliver media crashed for message %s", message_id)
    finally:
        db.close()


@router.post("/send-media")
async def send_media_endpoint(account_id: int, body: SendMedia, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    if body.media_type not in ("image", "video", "document"):
        raise HTTPException(400, "media_type must be image, video or document")
    media = body.media_base64
    if media.startswith("data:"):
        media = media.split(",", 1)[-1]
    if len(media) < 100:
        raise HTTPException(400, "File is empty")
    if len(media) > 50_000_000:
        raise HTTPException(413, "File is too large (max ~37 MB)")
    chat = _resolve_chat(db, acc, body.chat_id, body.to)
    msg = _create_pending(db, acc, chat, body.media_type, body.caption, body.client_id)
    if body.filename:
        msg.media_filename = body.filename
        msg.media_mimetype = body.mimetype
        db.commit()
    _attach_quote(db, acc, chat, msg, body.quoted_message_id)
    await _announce_new(db, acc, chat, msg)
    _spawn(_deliver_media(acc.id, msg.id, {
        "media_type": body.media_type,
        "media": media,
        "mimetype": body.mimetype,
        "filename": body.filename,
        "caption": body.caption,
        "quoted_message_id": body.quoted_message_id,
    }))
    return {"message": message_out(msg), "chat": chat_out(chat)}


# ── reactions ─────────────────────────────────────────────

@router.post("/messages/{message_id}/react")
async def react_to_message(account_id: int, message_id: int, body: SendReaction, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    msg = db.get(Message, message_id)
    if not msg or msg.account_id != acc.id:
        raise HTTPException(404, "Message not found")
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    if msg.deleted:
        raise HTTPException(400, "This message was deleted")
    if msg.wa_message_id.startswith("pending-"):
        raise HTTPException(400, "Message is still sending")
    chat = db.get(Chat, msg.chat_id)
    participant = msg.sender_jid if (chat.is_group and not msg.from_me) else None
    try:
        await evolution.send_reaction(
            acc.instance_name, chat.jid, msg.wa_message_id, body.emoji, from_me=msg.from_me, participant=participant
        )
    except evolution.EvolutionError as exc:
        raise HTTPException(502, f"Reaction failed (HTTP {exc.status_code}): {exc.detail[:200]}")
    except httpx.HTTPError:
        raise HTTPException(502, "WhatsApp service is unavailable")
    set_reaction(msg, "me", body.emoji)
    db.commit()
    out = message_out(msg)
    await manager.broadcast("message.updated", {"account_id": acc.id, "data": {"message": out}})
    return {"message": out}


# ── edit ──────────────────────────────────────────────────

EDIT_WINDOW = timedelta(minutes=15)


class EditBody(BaseModel):
    text: str


@router.post("/messages/{message_id}/edit")
async def edit_message(account_id: int, message_id: int, body: EditBody, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    msg = db.get(Message, message_id)
    if not msg or msg.account_id != acc.id:
        raise HTTPException(404, "Message not found")
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Message is empty")
    if not msg.from_me or msg.type != "text" or msg.deleted:
        raise HTTPException(400, "Only your own text messages can be edited")
    if msg.wa_message_id.startswith("pending-") or msg.status in ("pending", "failed"):
        raise HTTPException(400, "This message was not sent yet")
    if utcnow() - msg.timestamp > EDIT_WINDOW:
        raise HTTPException(400, "WhatsApp only allows editing within 15 minutes of sending")
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    if text == msg.text:
        return {"message": message_out(msg)}
    chat = db.get(Chat, msg.chat_id)
    try:
        await evolution.edit_message(acc.instance_name, chat.jid, msg.wa_message_id, text)
    except evolution.EvolutionError as exc:
        raise HTTPException(502, f"Edit failed (HTTP {exc.status_code}): {exc.detail[:200]}")
    except httpx.HTTPError:
        raise HTTPException(502, "WhatsApp service is unavailable")
    result = apply_edit(db, acc.id, msg.wa_message_id, text)
    if result:
        msg, chat = result
    out = message_out(msg)
    await manager.broadcast("message.updated", {"account_id": acc.id, "data": {"message": out, "chat": chat_out(chat)}})
    return {"message": out}


# ── star (dashboard only) ─────────────────────────────────

class StarBody(BaseModel):
    starred: bool


@router.post("/messages/{message_id}/star")
async def star_message(account_id: int, message_id: int, body: StarBody, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    msg = db.get(Message, message_id)
    if not msg or msg.account_id != acc.id:
        raise HTTPException(404, "Message not found")
    msg.starred = body.starred
    db.commit()
    out = message_out(msg)
    await manager.broadcast("message.updated", {"account_id": acc.id, "data": {"message": out}})
    return {"message": out}


@router.get("/starred")
def list_starred(account_id: int, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    rows = (
        db.query(Message, Chat)
        .join(Chat, Chat.id == Message.chat_id)
        .filter(Message.account_id == acc.id, Message.starred.is_(True), Message.hidden.is_not(True))
        .order_by(Message.timestamp.desc())
        .limit(200)
        .all()
    )
    return [{"message": message_out(m), "chat": chat_out(c)} for m, c in rows]


# ── pin / archive / mute (dashboard only) ─────────────────

class ChatFlags(BaseModel):
    pinned: bool | None = None
    archived: bool | None = None
    muted: bool | None = None
    note: str | None = Field(None, max_length=4000)  # "" clears the note
    custom_name: str | None = Field(None, max_length=200)  # "" clears your name and goes back to WhatsApp's


@router.patch("/chats/{chat_id}")
async def update_chat_flags(account_id: int, chat_id: int, body: ChatFlags, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    chat = _chat(db, acc, chat_id)
    for field in ("pinned", "archived", "muted"):
        value = getattr(body, field)
        if value is not None:
            setattr(chat, field, value)
    if body.custom_name is not None:
        chat.custom_name = body.custom_name.strip() or None
    if body.note is not None:
        chat.note = body.note.strip() or None
    db.commit()
    await manager.broadcast(
        "chat.updated", {"account_id": acc.id, "data": {"chat": chat_out(chat), "unread_total": unread_total(db, acc.id)}}
    )
    return chat_out(chat)


# ── group info ────────────────────────────────────────────

def _digits(jid: str) -> str:
    return re.sub(r"\D", "", jid.split("@")[0].split(":")[0])


@router.get("/chats/{chat_id}/group")
async def group_info(account_id: int, chat_id: int, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    chat = _chat(db, acc, chat_id)
    if not chat.is_group:
        raise HTTPException(400, "Not a group chat")
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    try:
        info = await evolution.find_group(acc.instance_name, chat.jid)
    except evolution.EvolutionError as exc:
        raise HTTPException(502, f"Group info not available (HTTP {exc.status_code})")
    except httpx.HTTPError:
        raise HTTPException(502, "WhatsApp service is unavailable")

    names: dict[str, str] = {}
    for c in db.query(Contact).filter(Contact.account_id == acc.id, Contact.name.is_not(None)).all():
        names[_digits(c.jid)] = c.name
    mine = _digits(acc.phone_number or "")
    people, me_admin = [], False
    for p in info.get("participants") or []:
        if not isinstance(p, dict):
            continue
        raw_id = str(p.get("id") or p.get("jid") or "")
        jid = str(p.get("phoneNumber") or raw_id)
        digits = _digits(jid)
        # hidden "@lid" ids are not phone numbers; only show a number when we really have one
        has_phone = bool(digits) and (bool(p.get("phoneNumber")) or not raw_id.endswith("@lid"))
        admin = p.get("admin") if p.get("admin") in ("admin", "superadmin") else None
        is_me = has_phone and bool(mine) and digits == mine
        me_admin = me_admin or (is_me and admin is not None)
        people.append(
            {
                "jid": jid,
                "name": "You" if is_me else (names.get(digits) if has_phone else None),
                "phone": digits if has_phone else None,
                "admin": admin,
            }
        )
    people.sort(key=lambda x: (x["admin"] is None, (x["name"] or x["phone"] or "").lower()))
    return {
        "subject": info.get("subject"),
        "description": info.get("desc") or info.get("description"),
        "created": info.get("creation"),
        "owner": info.get("owner"),
        "participants": people,
        "me_admin": me_admin,
    }


@router.post("/chats/{chat_id}/leave")
async def leave_group_chat(account_id: int, chat_id: int, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    chat = _chat(db, acc, chat_id)
    if not chat.is_group:
        raise HTTPException(400, "Not a group chat")
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    try:
        await evolution.leave_group(acc.instance_name, chat.jid)
    except evolution.EvolutionError as exc:
        raise HTTPException(502, f"Could not leave the group (HTTP {exc.status_code}): {exc.detail[:200]}")
    except httpx.HTTPError:
        raise HTTPException(502, "WhatsApp service is unavailable")
    return {"ok": True}


# ── media gallery ─────────────────────────────────────────

_URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)


@router.get("/chats/{chat_id}/gallery")
def gallery(
    account_id: int,
    chat_id: int,
    kind: str = Query("media", pattern="^(media|docs|links)$"),
    limit: int = Query(60, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """Media = images and videos, docs = files, links = messages that contain a web address. Newest first."""
    acc = _account(db, account_id)
    chat = _chat(db, acc, chat_id)
    q = db.query(Message).filter(Message.chat_id == chat.id, Message.hidden.is_not(True), Message.deleted.is_not(True))
    if kind == "media":
        rows = q.filter(Message.type.in_(("image", "video"))).order_by(Message.timestamp.desc()).limit(limit).all()
        return {"messages": [message_out(m) for m in rows]}
    if kind == "docs":
        rows = q.filter(Message.type == "document").order_by(Message.timestamp.desc()).limit(limit).all()
        return {"messages": [message_out(m) for m in rows]}
    rows = q.filter(Message.text.ilike("%http%")).order_by(Message.timestamp.desc()).limit(limit * 3).all()
    out = []
    for m in rows:
        urls = _URL_RE.findall(m.text or "")
        if urls:
            out.append({**message_out(m), "links": urls[:5]})
        if len(out) >= limit:
            break
    return {"messages": out}


# ── search across all chats of one number ─────────────────

@router.get("/search")
def search_all(account_id: int, q: str = Query(..., min_length=2, max_length=100), db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    rows = (
        db.query(Message, Chat)
        .join(Chat, Chat.id == Message.chat_id)
        .options(selectinload(Chat.label_links))
        .filter(
            Message.account_id == acc.id,
            Message.hidden.is_not(True),
            Message.deleted.is_not(True),
            Message.text.ilike(f"%{q}%"),
        )
        .order_by(Message.timestamp.desc())
        .limit(40)
        .all()
    )
    return [{"message": message_out(m), "chat": chat_out(c)} for m, c in rows]


# ── profile photo ─────────────────────────────────────────

@router.post("/chats/{chat_id}/photo")
async def refresh_photo(account_id: int, chat_id: int, db: Session = Depends(get_db)):
    """WhatsApp photo links expire, so fetch a fresh one on demand (called when an image fails to load)."""
    acc = _account(db, account_id)
    chat = _chat(db, acc, chat_id)
    if acc.status == "connected":
        try:
            url = await evolution.fetch_profile_picture(acc.instance_name, chat.jid)
        except (evolution.EvolutionError, httpx.HTTPError):
            url = None
        if url and url != chat.profile_pic_url:
            chat.profile_pic_url = url
            db.commit()
    return chat_out(chat)


# ── diagnostics ───────────────────────────────────────────

def _mask(jid: str) -> str:
    user, _, host = jid.partition("@")
    return (user[:3] + "…" + user[-2:] if len(user) > 6 else user) + "@" + host


@router.get("/debug/names")
def debug_names(account_id: int, db: Session = Depends(get_db)):
    """Why do some chats have no name? Counts by id type plus a few masked examples. Open it in the browser."""
    acc = _account(db, account_id)
    chats = db.query(Chat).filter(Chat.account_id == acc.id).all()
    contacts = db.query(Contact).filter(Contact.account_id == acc.id).all()

    def kind(jid: str) -> str:
        return "group" if jid.endswith("@g.us") else "lid" if jid.endswith("@lid") else "phone" if jid.endswith("@s.whatsapp.net") else "other"

    summary: dict = {"chats": {}, "contacts": {}}
    for label, rows in (("chats", chats), ("contacts", contacts)):
        for r in rows:
            k = summary[label].setdefault(kind(r.jid), {"total": 0, "named": 0, "with_photo": 0})
            k["total"] += 1
            k["named"] += 1 if (getattr(r, "custom_name", None) or r.name) else 0
            k["with_photo"] += 1 if r.profile_pic_url else 0
    unnamed = [c for c in chats if not c.is_group and not (c.custom_name or c.name)][:8]
    summary["unnamed_chat_examples"] = [
        {
            "jid": _mask(c.jid),
            "kind": kind(c.jid),
            "messages": db.query(Message).filter(Message.chat_id == c.id).count(),
            "incoming_with_profile_name": db.query(Message)
            .filter(Message.chat_id == c.id, Message.from_me.is_(False), Message.sender_name.is_not(None))
            .count(),
        }
        for c in unnamed
    ]
    return summary


# ── delete ────────────────────────────────────────────────

@router.post("/messages/{message_id}/delete")
async def delete_message(account_id: int, message_id: int, body: DeleteBody, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    msg = db.get(Message, message_id)
    if not msg or msg.account_id != acc.id:
        raise HTTPException(404, "Message not found")

    if body.scope == "me":
        msg.hidden = True
        db.commit()
        await manager.broadcast(
            "message.hidden", {"account_id": acc.id, "data": {"chat_id": msg.chat_id, "message_id": msg.id}}
        )
        return {"ok": True}

    if body.scope != "everyone":
        raise HTTPException(400, "scope must be 'me' or 'everyone'")
    if not msg.from_me:
        raise HTTPException(400, "You can only delete your own messages for everyone")
    if msg.wa_message_id.startswith("pending-") or msg.status in ("pending", "failed"):
        raise HTTPException(400, "This message was not sent; delete it for yourself instead")
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    if msg.deleted:
        return {"message": message_out(msg)}
    chat = db.get(Chat, msg.chat_id)
    try:
        await evolution.delete_message_for_everyone(acc.instance_name, chat.jid, msg.wa_message_id, from_me=True)
    except evolution.EvolutionError as exc:
        raise HTTPException(502, f"Delete failed (HTTP {exc.status_code}): {exc.detail[:200]}")
    except httpx.HTTPError:
        raise HTTPException(502, "WhatsApp service is unavailable")
    result = apply_revoke(db, acc.id, msg.wa_message_id)
    if result:
        msg, chat = result
    out = message_out(msg)
    await manager.broadcast("message.updated", {"account_id": acc.id, "data": {"message": out, "chat": chat_out(chat)}})
    return {"message": out}


# ── forward ───────────────────────────────────────────────

@router.post("/messages/{message_id}/forward")
async def forward_message(account_id: int, message_id: int, body: ForwardMessage, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    msg = db.get(Message, message_id)
    if not msg or msg.account_id != acc.id:
        raise HTTPException(404, "Message not found")
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected")
    target_chat = _resolve_chat(db, acc, body.to_chat_id, body.to)
    if msg.type == "text" and msg.text:
        fwd = _create_pending(db, acc, target_chat, "text", msg.text, None)
        await _announce_new(db, acc, target_chat, fwd)
        _spawn(_deliver(acc.id, fwd.id, "text", msg.text))
        return {"message": message_out(fwd), "chat": chat_out(target_chat)}
    raise HTTPException(400, "Only text messages can be forwarded for now")


# ── search ────────────────────────────────────────────────

@router.get("/chats/{chat_id}/search")
def search_messages(
    account_id: int,
    chat_id: int,
    q: str = Query(..., min_length=1),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    acc = _account(db, account_id)
    chat = _chat(db, acc, chat_id)
    rows = (
        db.query(Message)
        .filter(Message.chat_id == chat.id, Message.hidden.is_not(True), Message.text.ilike(f"%{q}%"))
        .order_by(Message.timestamp.desc())
        .limit(limit)
        .all()
    )
    rows.reverse()
    return {"messages": [message_out(m) for m in rows]}


# ── typing indicator ──────────────────────────────────────

@router.post("/chats/{chat_id}/typing")
async def send_typing(account_id: int, chat_id: int, db: Session = Depends(get_db)):
    acc = _account(db, account_id)
    chat = _chat(db, acc, chat_id)
    if acc.status != "connected":
        return {"ok": False}
    try:
        await evolution.send_presence(acc.instance_name, chat.jid, composing=True)
    except Exception:
        pass
    return {"ok": True}
