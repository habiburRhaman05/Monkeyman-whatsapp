"""
Async client for Evolution API v2.3.7.

Verified endpoints (evoapicloud/evolution-api:v2.3.7):
  POST   /instance/create          – create instance, optionally get QR back
  GET    /instance/connect/{name}  – (re)connect, returns QR base64
  GET    /instance/connectionState/{name}
  DELETE /instance/logout/{name}
  DELETE /instance/delete/{name}
  POST   /webhook/set/{name}       – body: { webhook: { enabled, url, ... } }

Auth header: apikey: <key>
"""

import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# Shared client (created once, reused).  Timeout is generous for QR generation.
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            base_url=settings.evolution_api_url,
            headers={"apikey": settings.evolution_api_key},
            timeout=httpx.Timeout(30.0),
        )
    return _client


class EvolutionError(Exception):
    """Raised when Evolution API returns a non-2xx status."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"Evolution {status_code}: {detail}")


async def _request(method: str, path: str, **kwargs) -> dict[str, Any]:
    client = _get_client()
    resp = await client.request(method, path, **kwargs)
    if resp.status_code >= 400:
        try:
            body = resp.json()
        except Exception:
            body = resp.text
        raise EvolutionError(resp.status_code, str(body))
    try:
        return resp.json()
    except Exception:
        return {}


# ── Instance management ───────────────────────────────────

async def create_instance(
    instance_name: str,
    webhook_url: str,
    webhook_events: list[str],
) -> dict[str, Any]:
    """Create a new instance with webhook configured and QR returned."""
    body = {
        "instanceName": instance_name,
        "qrcode": True,
        "integration": "WHATSAPP-BAILEYS",
        "webhook": {
            "url": webhook_url,
            "byEvents": False,
            "base64": False,
            "events": webhook_events,
        },
    }
    return await _request("POST", "/instance/create", json=body)


async def connect_instance(instance_name: str) -> dict[str, Any]:
    """Get a fresh QR code for an existing instance."""
    return await _request("GET", f"/instance/connect/{instance_name}")


async def connection_state(instance_name: str) -> str:
    """Return the connection state string (e.g. 'open', 'close', 'connecting')."""
    data = await _request("GET", f"/instance/connectionState/{instance_name}")
    # { instance: { instanceName, state } }
    return data.get("instance", {}).get("state", "close")


async def logout_instance(instance_name: str) -> dict[str, Any]:
    return await _request("DELETE", f"/instance/logout/{instance_name}")


async def delete_instance(instance_name: str) -> dict[str, Any]:
    return await _request("DELETE", f"/instance/delete/{instance_name}")


# ── Webhook management ────────────────────────────────────

async def set_webhook(
    instance_name: str,
    webhook_url: str,
    events: list[str],
) -> dict[str, Any]:
    body = {
        "webhook": {
            "enabled": True,
            "url": webhook_url,
            "byEvents": False,
            "base64": False,
            "events": events,
        }
    }
    return await _request("POST", f"/webhook/set/{instance_name}", json=body)


async def fetch_owner_jid(instance_name: str) -> str | None:
    """GET /instance/fetchInstances?instanceName=... -> ownerJid of the linked phone."""
    data = await _request("GET", "/instance/fetchInstances", params={"instanceName": instance_name})
    item = data[0] if isinstance(data, list) and data else data
    if not isinstance(item, dict):
        return None
    inner = item.get("instance") if isinstance(item.get("instance"), dict) else {}
    return item.get("ownerJid") or item.get("owner") or inner.get("owner") or inner.get("ownerJid")


# ── Messages ─────────────────────────────────────────────

async def send_text(
    instance_name: str, to: str, text: str, quoted_msg: dict | None = None, mentioned: list[str] | None = None
) -> dict[str, Any]:
    """POST /message/sendText/{instance} {number, text, mentioned?} -> message object with key.id

    `mentioned` is a list of numeric-string phone numbers (no "+", no "@s.whatsapp.net") to ping in a group.
    """
    body: dict[str, Any] = {"number": to, "text": text}
    if quoted_msg:
        body["quoted"] = quoted_msg
    if mentioned:
        body["mentioned"] = mentioned
    return await _request("POST", f"/message/sendText/{instance_name}", json=body)


async def send_audio(instance_name: str, to: str, audio_b64: str) -> dict[str, Any]:
    """POST /message/sendWhatsAppAudio/{instance} {number, audio(base64|url)} -> voice note"""
    return await _request(
        "POST", f"/message/sendWhatsAppAudio/{instance_name}", json={"number": to, "audio": audio_b64}
    )


async def send_media(instance_name: str, to: str, media_type: str, media_b64: str,
                     mimetype: str, filename: str | None = None, caption: str | None = None,
                     quoted_msg: dict | None = None) -> dict[str, Any]:
    """POST /message/sendMedia/{instance} -> send image/video/document with optional caption and quote."""
    body: dict[str, Any] = {
        "number": to,
        "mediatype": media_type,
        "media": media_b64,
        "mimetype": mimetype,
    }
    if filename:
        body["fileName"] = filename
    if caption:
        body["caption"] = caption
    if quoted_msg:
        body["quoted"] = quoted_msg
    return await _request("POST", f"/message/sendMedia/{instance_name}", json=body)


async def send_reaction(instance_name: str, to: str, message_id: str, emoji: str,
                        from_me: bool, participant: str | None = None) -> dict[str, Any]:
    """POST /message/sendReaction/{instance}. `fromMe` is required in the key; emoji '' removes the reaction."""
    key: dict[str, Any] = {"remoteJid": to, "fromMe": from_me, "id": message_id}
    if participant:
        key["participant"] = participant
    return await _request("POST", f"/message/sendReaction/{instance_name}", json={"key": key, "reaction": emoji})


async def delete_message_for_everyone(instance_name: str, to: str, message_id: str,
                                      from_me: bool = True, participant: str | None = None) -> dict[str, Any]:
    """DELETE /chat/deleteMessageForEveryone/{instance} {id, remoteJid, fromMe, participant?}"""
    body: dict[str, Any] = {"id": message_id, "remoteJid": to, "fromMe": from_me}
    if participant:
        body["participant"] = participant
    return await _request("DELETE", f"/chat/deleteMessageForEveryone/{instance_name}", json=body)


async def find_group(instance_name: str, group_jid: str) -> dict[str, Any]:
    """GET /group/findGroupInfos/{instance}?groupJid= -> {id, subject, owner, desc, creation, participants:[...]}"""
    data = await _request("GET", f"/group/findGroupInfos/{instance_name}", params={"groupJid": group_jid})
    return data if isinstance(data, dict) else {}


async def leave_group(instance_name: str, group_jid: str) -> dict[str, Any]:
    """DELETE /group/leaveGroup/{instance}?groupJid="""
    return await _request("DELETE", f"/group/leaveGroup/{instance_name}", params={"groupJid": group_jid})


async def fetch_profile_picture(instance_name: str, number: str) -> str | None:
    """POST /chat/fetchProfilePictureUrl/{instance} {number} -> {wuid, profilePictureUrl}"""
    data = await _request("POST", f"/chat/fetchProfilePictureUrl/{instance_name}", json={"number": number})
    url = data.get("profilePictureUrl") if isinstance(data, dict) else None
    return url if isinstance(url, str) and url else None


async def mark_messages_read(instance_name: str, items: list[dict]) -> dict[str, Any]:
    """POST /chat/markMessageAsRead/{instance} {readMessages:[{remoteJid, fromMe, id, participant?}]}"""
    return await _request("POST", f"/chat/markMessageAsRead/{instance_name}", json={"readMessages": items})


async def edit_message(instance_name: str, to: str, message_id: str, text: str) -> dict[str, Any]:
    """POST /chat/updateMessage/{instance} {number, key:{remoteJid, fromMe, id}, text} (own messages only)"""
    return await _request(
        "POST",
        f"/chat/updateMessage/{instance_name}",
        json={"number": to, "key": {"remoteJid": to, "fromMe": True, "id": message_id}, "text": text},
    )


async def send_presence(instance_name: str, to: str, composing: bool = True) -> dict[str, Any]:
    """POST /chat/sendPresence/{instance} -> typing/recording indicator."""
    return await _request(
        "POST", f"/chat/sendPresence/{instance_name}",
        json={"number": to, "presence": "composing" if composing else "paused"},
    )


async def get_media_base64(instance_name: str, wa_message_id: str) -> dict[str, Any]:
    """POST /chat/getBase64FromMediaMessage/{instance} {message:{key:{id}}} -> {base64, mimetype, ...}"""
    return await _request(
        "POST",
        f"/chat/getBase64FromMediaMessage/{instance_name}",
        json={"message": {"key": {"id": wa_message_id}}, "convertToMp4": False},
    )


# ── WhatsApp number check ──────────────────────────────

async def check_is_on_whatsapp(
    instance_name: str, numbers: list[str]
) -> list[dict[str, Any]]:
    """POST /chat/whatsappNumbers/{instance} {numbers:[...]}

    Returns list of {exists: bool, jid: str, number: str} for each number.
    Evolution API v2 endpoint for checking if phone numbers are on WhatsApp.
    """
    data = await _request(
        "POST",
        f"/chat/whatsappNumbers/{instance_name}",
        json={"numbers": numbers},
    )
    # Response is typically a list of results
    if isinstance(data, list):
        return data
    # Some versions wrap in a key
    if isinstance(data, dict) and isinstance(data.get("result"), list):
        return data["result"]
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        return data["data"]
    return data if isinstance(data, list) else []


# ── Group participant helpers ────────────────────────────

async def find_all_group_participants(instance_name: str, group_jids: list[str]) -> dict[str, str]:
    """Fetch participants from all groups and return a {lid_jid: phone_jid} mapping.

    Each group participant has both ``id`` (@lid) and ``phoneNumber`` (@s.whatsapp.net).
    """
    lid_to_phone: dict[str, str] = {}
    for gjid in group_jids:
        try:
            data = await _request("GET", f"/group/findGroupInfos/{instance_name}", params={"groupJid": gjid})
            if isinstance(data, list):
                data = data[0] if data else {}
            for p in data.get("participants") or []:
                lid = p.get("id", "")
                phone = p.get("phoneNumber", "")
                if lid.endswith("@lid") and phone.endswith("@s.whatsapp.net"):
                    lid_to_phone[lid] = phone
        except Exception as exc:
            logger.debug("findGroupInfos failed for %s: %s", gjid, exc)
    return lid_to_phone


# ── Reading history (sync) ───────────────────────────────

async def find_chats(instance_name: str) -> list[dict]:
    """POST /chat/findChats -> [{remoteJid, pushName, updatedAt, lastMessage, unreadCount, id}]"""
    data = await _request("POST", f"/chat/findChats/{instance_name}", json={})
    return data if isinstance(data, list) else []


async def find_contacts(instance_name: str) -> list[dict]:
    """POST /chat/findContacts -> [{remoteJid, pushName, profilePicUrl, isGroup, ...}]"""
    data = await _request("POST", f"/chat/findContacts/{instance_name}", json={"where": {}})
    return data if isinstance(data, list) else []


async def find_messages(instance_name: str, remote_jid: str, limit: int = 30) -> list[dict]:
    """POST /chat/findMessages -> {messages: {records: [...]}} (newest first)"""
    data = await _request(
        "POST",
        f"/chat/findMessages/{instance_name}",
        json={"where": {"key": {"remoteJid": remote_jid}}, "page": 1, "offset": limit},
    )
    records = (data.get("messages") or {}).get("records") if isinstance(data, dict) else None
    return records if isinstance(records, list) else []
