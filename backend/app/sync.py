"""Import existing chats, contacts and recent messages from Evolution into SQLite."""

import logging

from app import evolution
from app.db import SessionLocal
from app.models import Account, Chat, Contact, Message
from app.normalize import (
    STATUS_RANK,
    map_status,
    parse_edit,
    parse_message,
    parse_reaction,
    parse_revoke,
    parse_ts,
    phone_from_jid,
    skip_jid,
)
from app.serializers import unread_total
from app.services import apply_edit, apply_reaction, apply_revoke, get_or_create_chat, store_message, touch_chat
from app.ws import manager

logger = logging.getLogger(__name__)
_running: set[int] = set()


def _is_lid_digits(name: str | None, jid: str) -> bool:
    """True if name is just the numeric LID identifier (not a real contact name)."""
    if not name or not jid.endswith("@lid"):
        return False
    return name == jid.split("@")[0].split(":")[0]


def _best_status(record: dict) -> str | None:
    updates = record.get("MessageUpdate")
    if not isinstance(updates, list):
        return None
    ranked = [u.get("status") for u in updates if isinstance(u, dict) and u.get("status")]
    if not ranked:
        return None
    return max(ranked, key=lambda s: STATUS_RANK.get(map_status(s, True), 1))


async def sync_account(account_id: int, chat_limit: int = 30, msg_limit: int = 30) -> None:
    if account_id in _running:
        logger.info("Sync already running for account %s, skipping", account_id)
        return
    _running.add(account_id)
    logger.info("Starting sync for account %s", account_id)
    db = SessionLocal()
    try:
        acc = db.get(Account, account_id)
        if not acc:
            logger.warning("Sync: account %s not found", account_id)
            return
        name = acc.instance_name

        # 1. Chats
        raw_chats = await evolution.find_chats(name)
        logger.info("Sync: fetched %d chats from Evolution for %s", len(raw_chats), acc.label)
        jids: list[str] = []
        for raw in raw_chats:
            jid = raw.get("remoteJid")
            last = raw.get("lastMessage") if isinstance(raw.get("lastMessage"), dict) else None
            # Prefer the real @s.whatsapp.net JID over the opaque @lid identifier
            if isinstance(jid, str) and jid.endswith("@lid"):
                alt = ((last or {}).get("key") or {}).get("remoteJidAlt")
                if alt:
                    orig_lid = jid
                    jid = alt
                    lid_chat = db.query(Chat).filter_by(account_id=account_id, jid=orig_lid).first()
                    real_chat = db.query(Chat).filter_by(account_id=account_id, jid=jid).first()
                    if lid_chat and not real_chat:
                        lid_chat.jid = jid
                        db.flush()
            if skip_jid(jid):
                continue
            last_from_me = bool(((last or {}).get("key") or {}).get("fromMe"))
            is_group = jid.endswith("@g.us")
            push = raw.get("pushName") if isinstance(raw.get("pushName"), str) else None
            if _is_lid_digits(push, jid):
                push = None
            chat_name_field = raw.get("name") if isinstance(raw.get("name"), str) else None
            if _is_lid_digits(chat_name_field, jid):
                chat_name_field = None
            chat_name = chat_name_field or (push if (is_group or not last_from_me) else None)
            pic = raw.get("profilePicUrl") if isinstance(raw.get("profilePicUrl"), str) else None
            is_new = db.query(Chat).filter_by(account_id=account_id, jid=jid).first() is None
            chat = get_or_create_chat(db, account_id, jid, chat_name)
            if pic and not chat.profile_pic_url:
                chat.profile_pic_url = pic
            if is_new and isinstance(raw.get("unreadCount"), int):
                chat.unread_count = max(raw["unreadCount"], 0)
            if last:
                p = parse_message(last)
                if p:
                    touch_chat(chat, p.timestamp, p.type, p.text)
            elif raw.get("updatedAt") and chat.last_message_at is None:
                chat.last_message_at = parse_ts(None)
            db.commit()
            jids.append(jid)

        # 2. Recent messages for the most recently active chats
        recent = (
            db.query(Chat)
            .filter(Chat.account_id == account_id)
            .order_by(Chat.last_message_at.desc())
            .limit(chat_limit)
            .all()
        )
        logger.info("Sync: importing messages for %d recent chats", len(recent))
        for chat in recent:
            try:
                records = await evolution.find_messages(name, chat.jid, msg_limit)
            except evolution.EvolutionError as exc:
                logger.warning("findMessages failed for chat %s (jid=%s): HTTP %s — %s", chat.id, chat.jid, exc.status_code, exc.detail[:100])
                continue
            except Exception as exc:
                logger.warning("findMessages error for chat %s: %s", chat.id, exc)
                continue
            later: list[dict] = []
            for rec in records:
                if not isinstance(rec, dict):
                    continue
                best = _best_status(rec)
                if best and "status" not in rec:
                    rec = {**rec, "status": best}
                p = parse_message(rec)
                if p:
                    store_message(db, account_id, p, bump_unread=False)
                else:
                    later.append(rec)
            # Reactions/deletes refer to stored messages; apply oldest first so the newest reaction wins.
            later.sort(key=lambda r: parse_ts(r.get("messageTimestamp")))
            for rec in later:
                reaction = parse_reaction(rec)
                if reaction:
                    apply_reaction(db, account_id, reaction)
                    continue
                revoked = parse_revoke(rec)
                if revoked:
                    apply_revoke(db, account_id, revoked)
                    continue
                edit = parse_edit(rec)
                if edit:
                    apply_edit(db, account_id, edit[0], edit[1])

        # 3. Contacts
        contacts = await evolution.find_contacts(name)
        known = {c.jid: c for c in db.query(Contact).filter_by(account_id=account_id).all()}
        for raw in contacts:
            jid = raw.get("remoteJid")
            if skip_jid(jid):
                continue
            push = raw.get("pushName") if isinstance(raw.get("pushName"), str) else None
            pic = raw.get("profilePicUrl") if isinstance(raw.get("profilePicUrl"), str) else None
            existing = known.get(jid)
            if existing:
                if push and existing.name != push:
                    existing.name = push
                if pic:
                    existing.profile_pic_url = pic
            else:
                db.add(Contact(account_id=account_id, jid=jid, name=push, profile_pic_url=pic, is_group=jid.endswith("@g.us")))
        db.commit()

        # 4. Build @lid → @s.whatsapp.net mapping from group participants
        group_jids = [
            c.jid for c in db.query(Chat.jid).filter(
                Chat.account_id == account_id, Chat.jid.like("%@g.us")
            ).all()
        ]
        lid_to_phone: dict[str, str] = {}
        if group_jids:
            lid_to_phone = await evolution.find_all_group_participants(name, group_jids)
            logger.info("Sync: built %d @lid→phone mappings from %d groups", len(lid_to_phone), len(group_jids))

        # 5. Fill chat names and profile pics from contacts
        contact_by_jid: dict[str, Contact] = {}
        contact_by_phone: dict[str, Contact] = {}
        for c in db.query(Contact).filter_by(account_id=account_id).all():
            contact_by_jid[c.jid] = c
            phone = phone_from_jid(c.jid)
            if phone and not c.jid.endswith("@g.us"):
                contact_by_phone[phone] = c

        for chat in db.query(Chat).filter(Chat.account_id == account_id).all():
            if chat.is_group:
                continue
            # Clear fake LID-number names (digits that match the JID prefix)
            if chat.name and chat.jid.endswith("@lid"):
                lid_digits = chat.jid.split("@")[0].split(":")[0]
                if chat.name == lid_digits:
                    chat.name = None

            contact = contact_by_jid.get(chat.jid)
            mapped_phone_jid: str | None = None
            # For @lid chats, try the mapped phone JID
            if not contact and chat.jid.endswith("@lid"):
                mapped_phone_jid = lid_to_phone.get(chat.jid)
                if mapped_phone_jid:
                    contact = contact_by_jid.get(mapped_phone_jid)
            if not contact:
                phone = phone_from_jid(chat.jid)
                if phone:
                    contact = contact_by_phone.get(phone)
            if contact:
                if contact.name:
                    chat.name = contact.name
                if contact.profile_pic_url and not chat.profile_pic_url:
                    chat.profile_pic_url = contact.profile_pic_url
            elif mapped_phone_jid and not chat.name:
                chat.name = "+" + mapped_phone_jid.split("@")[0]
            if not chat.name:
                latest = (
                    db.query(Message.sender_name)
                    .filter(Message.chat_id == chat.id, Message.from_me.is_(False), Message.sender_name.is_not(None))
                    .order_by(Message.timestamp.desc())
                    .first()
                )
                if latest and latest[0] and not _is_lid_digits(latest[0], chat.jid):
                    chat.name = latest[0]
        db.commit()

        # 6. Merge duplicate @lid chats into their @s.whatsapp.net counterpart
        if lid_to_phone:
            phone_chat_by_jid = {
                c.jid: c for c in db.query(Chat).filter(
                    Chat.account_id == account_id, Chat.jid.like("%@s.whatsapp.net")
                ).all()
            }
            merged = 0
            for lid_chat in db.query(Chat).filter(
                Chat.account_id == account_id, Chat.jid.like("%@lid"), Chat.is_group.is_(False)
            ).all():
                phone_jid = lid_to_phone.get(lid_chat.jid)
                if not phone_jid:
                    continue
                phone_chat = phone_chat_by_jid.get(phone_jid)
                if not phone_chat:
                    continue
                # Move all messages from the @lid chat to the @s.whatsapp.net chat
                db.query(Message).filter(Message.chat_id == lid_chat.id).update(
                    {Message.chat_id: phone_chat.id}, synchronize_session=False
                )
                # Keep the most recent last_message_at
                if lid_chat.last_message_at and (
                    not phone_chat.last_message_at or lid_chat.last_message_at > phone_chat.last_message_at
                ):
                    phone_chat.last_message_at = lid_chat.last_message_at
                    phone_chat.last_message_preview = lid_chat.last_message_preview
                phone_chat.unread_count = max(phone_chat.unread_count, lid_chat.unread_count)
                if lid_chat.profile_pic_url and not phone_chat.profile_pic_url:
                    phone_chat.profile_pic_url = lid_chat.profile_pic_url
                db.delete(lid_chat)
                merged += 1
            if merged:
                db.commit()
                logger.info("Sync: merged %d duplicate @lid chats into @s.whatsapp.net chats", merged)

        total = unread_total(db, account_id)
        logger.info("Sync completed for account %s (unread_total=%d)", account_id, total)
        await manager.broadcast(
            "sync.done", {"account_id": account_id, "data": {"unread_total": total}}
        )
    except Exception:
        logger.exception("Sync failed for account %s", account_id)
        await manager.broadcast("sync.done", {"account_id": account_id, "data": {"error": True}})
    finally:
        _running.discard(account_id)
        db.close()
