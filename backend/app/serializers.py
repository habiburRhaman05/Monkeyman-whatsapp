"""Dict serializers shared by REST responses and WebSocket events."""

import json
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Account, Chat, Contact, Message


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.isoformat() + "Z"


def unread_total(db: Session, account_id: int) -> int:
    return int(db.query(func.coalesce(func.sum(Chat.unread_count), 0)).filter(Chat.account_id == account_id).scalar() or 0)


def account_out(db: Session, a: Account) -> dict:
    return {
        "id": a.id,
        "label": a.label,
        "instance_name": a.instance_name,
        "phone_number": a.phone_number,
        "status": a.status,
        "created_at": iso(a.created_at),
        "unread_total": unread_total(db, a.id),
    }


def chat_out(c: Chat) -> dict:
    return {
        "id": c.id,
        "account_id": c.account_id,
        "jid": c.jid,
        "name": c.name,
        "custom_name": c.custom_name,
        "profile_pic_url": c.profile_pic_url,
        "is_group": c.is_group,
        "last_message_at": iso(c.last_message_at),
        "last_message_preview": c.last_message_preview,
        "unread_count": c.unread_count,
        "pinned": bool(c.pinned),
        "archived": bool(c.archived),
        "muted": bool(c.muted),
        "note": c.note,
        "label_ids": [link.label_id for link in c.label_links],
    }


def load_reactions(m: Message) -> dict[str, str]:
    try:
        d = json.loads(m.reactions) if m.reactions else {}
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


def reactions_out(m: Message) -> list[dict]:
    counts: dict[str, int] = {}
    mine = None
    for sender, emoji in load_reactions(m).items():
        counts[emoji] = counts.get(emoji, 0) + 1
        if sender == "me":
            mine = emoji
    return [{"emoji": e, "count": n, "mine": e == mine} for e, n in counts.items()]


def message_out(m: Message) -> dict:
    d: dict = {
        "id": m.id,
        "account_id": m.account_id,
        "chat_id": m.chat_id,
        "wa_message_id": m.wa_message_id,
        "client_id": m.client_id,
        "from_me": m.from_me,
        "sender_name": m.sender_name,
        "type": m.type,
        "text": m.text,
        "status": m.status,
        "timestamp": iso(m.timestamp),
        "deleted": bool(m.deleted),
        "edited": bool(m.edited),
        "starred": bool(m.starred),
        "reactions": reactions_out(m),
    }
    if m.quoted_message_id:
        d["quoted"] = {
            "message_id": m.quoted_message_id,
            "sender": m.quoted_sender,
            "text": m.quoted_text,
            "type": m.quoted_type,
        }
    if m.media_mimetype:
        d["media_mimetype"] = m.media_mimetype
    if m.media_filename:
        d["media_filename"] = m.media_filename
    return d


def contact_out(c: Contact) -> dict:
    return {"id": c.id, "account_id": c.account_id, "jid": c.jid, "name": c.name, "profile_pic_url": c.profile_pic_url, "is_group": c.is_group}
