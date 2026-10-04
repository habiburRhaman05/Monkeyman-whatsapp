"""Turn Evolution message payloads (webhook or findMessages records) into plain dicts.

Shapes follow Evolution API v2.3.7 source (Baileys WAMessage):
  { key: {id, fromMe, remoteJid, participant?, remoteJidAlt?}, pushName,
    message: {conversation | extendedTextMessage | imageMessage | audioMessage ...},
    messageType, messageTimestamp, status? }
Unknown shapes are skipped (None) rather than guessed.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

PLACEHOLDERS = {
    "image": "[Image]",
    "video": "[Video]",
    "audio": "[Voice message]",
    "document": "[Document]",
    "sticker": "[Sticker]",
    "other": "[Unsupported message]",
}

STATUS_RANK = {"pending": 0, "sent": 1, "delivered": 2, "read": 3}

_WRAPPERS = (
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
    "editedMessage",
)
_IGNORED = {"reactionMessage", "protocolMessage", "senderKeyDistributionMessage", "pollUpdateMessage"}


@dataclass
class ParsedMessage:
    jid: str
    wa_id: str
    from_me: bool
    sender_name: str | None
    type: str
    text: str | None
    timestamp: datetime
    status: str
    chat_name_hint: str | None
    quoted_id: str | None = None
    quoted_sender: str | None = None
    quoted_text: str | None = None
    quoted_type: str | None = None
    media_mimetype: str | None = None
    media_filename: str | None = None
    sender_jid: str | None = None


def preview_for(msg_type: str, text: str | None) -> str:
    if msg_type == "text":
        return (text or "")[:200]
    label = PLACEHOLDERS.get(msg_type, PLACEHOLDERS["other"])
    return f"{label} {text}"[:200] if text else label


def map_status(raw: Any, from_me: bool) -> str:
    if not from_me:
        return "delivered"
    s = str(raw or "").upper()
    if s in ("ERROR", "FAILED"):
        return "failed"
    if s == "PENDING":
        return "pending"
    if s in ("DELIVERY_ACK", "DELIVERED"):
        return "delivered"
    if s in ("READ", "PLAYED", "PLAY"):
        return "read"
    return "sent"


def better_status(old: str, new: str) -> bool:
    """True if `new` should replace `old` (never downgrade)."""
    if new == "failed":
        return old == "pending"
    return STATUS_RANK.get(new, 1) > STATUS_RANK.get(old, 1)


def parse_ts(value: Any) -> datetime:
    if isinstance(value, dict):
        value = value.get("low")
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = 0
    if n > 10**12:
        n //= 1000
    if n <= 0:
        return datetime.now(timezone.utc).replace(tzinfo=None)
    return datetime.fromtimestamp(n, tz=timezone.utc).replace(tzinfo=None)


def _classify(message: Any) -> tuple[str, str | None] | None:
    m = message if isinstance(message, dict) else {}
    for _ in range(3):
        for w in _WRAPPERS:
            inner = m.get(w)
            if isinstance(inner, dict) and isinstance(inner.get("message"), dict):
                m = inner["message"]
                break
        else:
            break
    if not m:
        return None
    if isinstance(m.get("conversation"), str):
        return "text", m["conversation"]
    ext = m.get("extendedTextMessage")
    if isinstance(ext, dict):
        return "text", ext.get("text") or ""
    for key, kind in (("imageMessage", "image"), ("videoMessage", "video"), ("ptvMessage", "video")):
        if isinstance(m.get(key), dict):
            return kind, m[key].get("caption") or None
    if isinstance(m.get("audioMessage"), dict):
        return "audio", None
    doc = m.get("documentMessage")
    if isinstance(doc, dict):
        return "document", doc.get("caption") or doc.get("fileName") or None
    if isinstance(m.get("stickerMessage"), dict):
        return "sticker", None
    if any(k in _IGNORED for k in m):
        return None
    keys = [k for k in m if k != "messageContextInfo"]
    return ("other", None) if keys else None


def skip_jid(jid: str | None) -> bool:
    return (not jid) or jid == "status@broadcast" or jid.endswith("@broadcast") or jid.endswith("@newsletter")


def phone_from_jid(jid: str) -> str | None:
    """Extract digits before @ and strip any :device suffix. Returns None for non-phone JIDs."""
    if not jid or jid.endswith("@g.us"):
        return None
    raw = jid.split("@")[0].split(":")[0]
    return raw if raw.isdigit() and len(raw) >= 6 else None


def _extract_quote(message: Any, top_level_ctx: Any = None) -> tuple[str | None, str | None, str | None, str | None]:
    """Extract quoted message info from contextInfo.

    The reply context normally sits inside the message part (extendedTextMessage.contextInfo, imageMessage...),
    but history records from Evolution also carry it as a separate top-level `contextInfo`.
    """
    m = _unwrap(message)
    ctx = None
    for val in m.values():
        if isinstance(val, dict):
            ci = val.get("contextInfo")
            if isinstance(ci, dict) and ci.get("quotedMessage"):
                ctx = ci
                break
    if not ctx:
        for val in m.values():
            if isinstance(val, dict) and val.get("quotedMessage"):
                ctx = val
                break
    if not ctx and isinstance(top_level_ctx, dict) and top_level_ctx.get("quotedMessage"):
        ctx = top_level_ctx
    if not ctx:
        return None, None, None, None
    qid = ctx.get("stanzaId")
    qsender = ctx.get("participant") or ctx.get("remoteJid")
    qmsg = ctx.get("quotedMessage")
    if isinstance(qmsg, dict):
        c = _classify(qmsg)
        if c:
            qt, qtxt = c
            return qid, qsender, (qtxt or "")[:500], qt
    return qid, qsender, None, None


def _extract_media_meta(message: Any) -> tuple[str | None, str | None]:
    """Extract mimetype and filename from media messages."""
    m = message if isinstance(message, dict) else {}
    for _ in range(3):
        for w in _WRAPPERS:
            inner = m.get(w)
            if isinstance(inner, dict) and isinstance(inner.get("message"), dict):
                m = inner["message"]
                break
        else:
            break
    for key in ("imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"):
        sub = m.get(key)
        if isinstance(sub, dict):
            return sub.get("mimetype"), sub.get("fileName")
    return None, None


def parse_message(data: dict[str, Any]) -> ParsedMessage | None:
    if not isinstance(data, dict):
        return None
    key = data.get("key") or {}
    jid = key.get("remoteJid")
    if isinstance(jid, str) and jid.endswith("@lid") and key.get("remoteJidAlt"):
        jid = key["remoteJidAlt"]
    wa_id = key.get("id")
    if skip_jid(jid) or not wa_id:
        return None
    classified = _classify(data.get("message"))
    if classified is None:
        return None
    msg_type, text = classified
    from_me = bool(key.get("fromMe"))
    push = data.get("pushName") if isinstance(data.get("pushName"), str) else None
    if push and jid.endswith("@lid") and push == jid.split("@")[0].split(":")[0]:
        push = None
    is_group = jid.endswith("@g.us")
    qid, qsender, qtext, qtype = _extract_quote(data.get("message"), data.get("contextInfo"))
    mimetype, filename = _extract_media_meta(data.get("message"))
    return ParsedMessage(
        jid=jid,
        wa_id=str(wa_id),
        from_me=from_me,
        sender_name=None if from_me else push,
        type=msg_type,
        text=text,
        timestamp=parse_ts(data.get("messageTimestamp")),
        status=map_status(data.get("status"), from_me),
        chat_name_hint=push if (not from_me and not is_group) else None,
        quoted_id=qid,
        quoted_sender=qsender,
        quoted_text=qtext,
        quoted_type=qtype,
        media_mimetype=mimetype,
        media_filename=filename,
        sender_jid=None if from_me else (key.get("participant") or key.get("participantAlt")),
    )


def _unwrap(message: Any) -> dict:
    m = message if isinstance(message, dict) else {}
    for _ in range(3):
        for w in _WRAPPERS:
            inner = m.get(w)
            if isinstance(inner, dict) and isinstance(inner.get("message"), dict):
                m = inner["message"]
                break
        else:
            break
    return m


def _chat_jid(key: dict) -> str | None:
    jid = key.get("remoteJid")
    if isinstance(jid, str) and jid.endswith("@lid") and key.get("remoteJidAlt"):
        jid = key["remoteJidAlt"]
    return jid if isinstance(jid, str) else None


def parse_reaction(data: dict[str, Any]) -> dict | None:
    """A reaction event: {jid, target (wa id of the reacted message), emoji ('' = removed), sender}."""
    if not isinstance(data, dict):
        return None
    r = _unwrap(data.get("message")).get("reactionMessage")
    if not isinstance(r, dict):
        return None
    key = data.get("key") or {}
    jid = _chat_jid(key)
    target = (r.get("key") or {}).get("id")
    if not target or skip_jid(jid):
        return None
    sender = "me" if key.get("fromMe") else (key.get("participant") or key.get("participantAlt") or jid)
    return {"jid": jid, "target": str(target), "emoji": r.get("text") or "", "sender": sender}


def parse_edit(data: dict[str, Any]) -> tuple[str, str] | None:
    """(wa id of the edited message, new text) when this event is a message edit."""
    if not isinstance(data, dict):
        return None
    p = _unwrap(data.get("message")).get("protocolMessage")
    if not isinstance(p, dict) or str(p.get("type", "")).upper() not in ("MESSAGE_EDIT", "14"):
        return None
    target = (p.get("key") or {}).get("id")
    classified = _classify(p.get("editedMessage"))
    if not target or classified is None or classified[0] != "text":
        return None
    return str(target), classified[1] or ""


def parse_revoke(data: dict[str, Any]) -> str | None:
    """wa id of the message that was deleted for everyone, if this event is a revoke."""
    if not isinstance(data, dict):
        return None
    p = _unwrap(data.get("message")).get("protocolMessage")
    if not isinstance(p, dict) or str(p.get("type", "")).upper() not in ("REVOKE", "0"):
        return None
    target = (p.get("key") or {}).get("id")
    return str(target) if target else None
