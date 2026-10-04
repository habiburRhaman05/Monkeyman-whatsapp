"""Shared persistence helpers for webhook, sync and send paths."""

import json

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Account, Chat, Contact, Message
from app.normalize import ParsedMessage, phone_from_jid, preview_for
from app.serializers import load_reactions

DELETED_PREVIEW = "🚫 This message was deleted"


def set_reaction(msg: Message, sender: str, emoji: str) -> None:
    d = load_reactions(msg)
    if emoji:
        d[sender] = emoji
    else:
        d.pop(sender, None)
    msg.reactions = json.dumps(d) if d else None


def _find(db: Session, account_id: int, wa_id: str) -> Message | None:
    return db.query(Message).filter_by(account_id=account_id, wa_message_id=wa_id).first()


def quoted_sender_label(q: Message, chat: Chat | None) -> str | None:
    if q.from_me:
        return "You"
    return q.sender_name or (chat.name if chat and not chat.is_group else None)


def set_quote_from(msg: Message, q: Message, chat: Chat | None) -> None:
    """Attach `q` (a message in our DB) as the quoted message of `msg`."""
    msg.quoted_message_id = q.wa_message_id
    msg.quoted_sender = quoted_sender_label(q, chat) or q.sender_jid
    msg.quoted_text = (q.text or "")[:500] or None
    msg.quoted_type = q.type


def resolve_quote(db: Session, account_id: int, msg: Message, chat: Chat) -> None:
    """Replace the raw jid in an incoming reply's quote with a readable name, and fill in a missing preview."""
    if not msg.quoted_message_id:
        return
    q = _find(db, account_id, msg.quoted_message_id)
    if q:
        msg.quoted_sender = quoted_sender_label(q, chat) or msg.quoted_sender
        if not msg.quoted_text and q.text:
            msg.quoted_text = q.text[:500]
        if not msg.quoted_type:
            msg.quoted_type = q.type
        return
    acc = db.get(Account, account_id)
    if acc and acc.phone_number and msg.quoted_sender and phone_from_jid(msg.quoted_sender) == acc.phone_number:
        msg.quoted_sender = "You"


def apply_reaction(db: Session, account_id: int, r: dict) -> Message | None:
    msg = _find(db, account_id, r["target"])
    if not msg:
        return None
    set_reaction(msg, r["sender"], r["emoji"])
    db.commit()
    return msg


def apply_edit(db: Session, account_id: int, wa_id: str, text: str) -> tuple[Message, Chat] | None:
    msg = _find(db, account_id, wa_id)
    if not msg or msg.deleted or msg.type != "text":
        return None
    msg.text = text
    msg.edited = True
    chat = db.get(Chat, msg.chat_id)
    newest = db.query(Message).filter(Message.chat_id == chat.id).order_by(Message.timestamp.desc(), Message.id.desc()).first()
    if newest and newest.id == msg.id:
        chat.last_message_preview = preview_for("text", text)
    db.commit()
    return msg, chat


def apply_revoke(db: Session, account_id: int, wa_id: str) -> tuple[Message, Chat] | None:
    """Turn a message into a 'deleted' tombstone. Returns None if unknown or already deleted."""
    msg = _find(db, account_id, wa_id)
    if not msg or msg.deleted:
        return None
    msg.deleted = True
    msg.text = None
    msg.reactions = None
    chat = db.get(Chat, msg.chat_id)
    newest = db.query(Message).filter(Message.chat_id == chat.id).order_by(Message.timestamp.desc(), Message.id.desc()).first()
    if newest and newest.id == msg.id:
        chat.last_message_preview = DELETED_PREVIEW
    db.commit()
    return msg, chat


def get_or_create_chat(db: Session, account_id: int, jid: str, name: str | None = None) -> Chat:
    chat = db.query(Chat).filter_by(account_id=account_id, jid=jid).first()
    if chat:
        if not chat.name and name:
            chat.name = name
        return chat
    chat = Chat(account_id=account_id, jid=jid, is_group=jid.endswith("@g.us"), name=name, unread_count=0)
    db.add(chat)
    db.flush()
    return chat


def touch_chat(chat: Chat, p_time, msg_type: str, text: str | None) -> None:
    if chat.last_message_at is None or p_time >= chat.last_message_at:
        chat.last_message_at = p_time
        chat.last_message_preview = preview_for(msg_type, text)


def _remember_contact(db: Session, account_id: int, jid: str, name: str) -> None:
    """People who message us become contacts under their own WhatsApp profile name."""
    contact = db.query(Contact).filter_by(account_id=account_id, jid=jid).first()
    if contact is None:
        db.add(Contact(account_id=account_id, jid=jid, name=name, is_group=False))
    elif name:
        contact.name = name


def store_message(db: Session, account_id: int, p: ParsedMessage, bump_unread: bool) -> tuple[Chat, Message, bool]:
    """Idempotent on (account, wa_message_id). Returns (chat, message, created)."""
    hint = p.chat_name_hint
    if hint and p.jid.endswith("@lid") and hint == p.jid.split("@")[0].split(":")[0]:
        hint = None
    chat = get_or_create_chat(db, account_id, p.jid, hint)
    if hint and not chat.is_group:
        chat.name = hint
        _remember_contact(db, account_id, p.jid, hint)
    existing = db.query(Message).filter_by(account_id=account_id, wa_message_id=p.wa_id).first()
    if existing:
        db.commit()
        return chat, existing, False
    msg = Message(
        account_id=account_id,
        chat_id=chat.id,
        wa_message_id=p.wa_id,
        from_me=p.from_me,
        sender_name=p.sender_name,
        type=p.type,
        text=p.text,
        status=p.status,
        timestamp=p.timestamp,
        quoted_message_id=p.quoted_id,
        quoted_sender=p.quoted_sender,
        quoted_text=p.quoted_text,
        quoted_type=p.quoted_type,
        media_mimetype=p.media_mimetype,
        media_filename=p.media_filename,
        sender_jid=p.sender_jid,
    )
    resolve_quote(db, account_id, msg, chat)
    db.add(msg)
    touch_chat(chat, p.timestamp, p.type, p.text)
    if bump_unread and not p.from_me:
        chat.unread_count = (chat.unread_count or 0) + 1
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.query(Message).filter_by(account_id=account_id, wa_message_id=p.wa_id).first()
        chat = db.get(Chat, chat.id)
        return chat, existing, False
    db.refresh(msg)
    db.refresh(chat)
    return chat, msg, True
