"""Accounts router — connect / manage WhatsApp numbers."""

import logging
import secrets

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import evolution
from app.config import settings
from app.db import get_db
from app.models import Account
from app.schemas import AccountCreate, QRResponse
from app.serializers import account_out

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/accounts", tags=["accounts"])

WEBHOOK_EVENTS = [
    "CONNECTION_UPDATE",
    "QRCODE_UPDATED",
    "MESSAGES_UPSERT",
    "MESSAGES_UPDATE",
    "MESSAGES_DELETE",
    "PRESENCE_UPDATE",
]


def webhook_url() -> str:
    return f"{settings.webhook_base_url}/webhook/evolution?secret={settings.webhook_secret}"


@router.get("")
async def list_accounts(db: Session = Depends(get_db)):
    accounts = db.query(Account).order_by(Account.created_at).all()

    # Refresh status from Evolution for every account
    for acc in accounts:
        try:
            state = await evolution.connection_state(acc.instance_name)
            new_status = "connected" if state == "open" else "disconnected" if state == "close" else "connecting"
            if acc.status != new_status:
                acc.status = new_status
        except evolution.EvolutionError as exc:
            # Only a 404 means the instance is really gone; other errors keep the last known status
            if exc.status_code == 404 and acc.status != "disconnected":
                acc.status = "disconnected"
        except httpx.HTTPError:
            pass  # Evolution unreachable: keep last known status
    db.commit()

    return [account_out(db, a) for a in accounts]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_account(body: AccountCreate, db: Session = Depends(get_db)):
    instance_name = f"acc_{secrets.token_hex(4)}"

    try:
        result = await evolution.create_instance(
            instance_name=instance_name,
            webhook_url=webhook_url(),
            webhook_events=WEBHOOK_EVENTS,
        )
    except evolution.EvolutionError as exc:
        raise HTTPException(status_code=502, detail=f"Evolution API error: {exc.detail}")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Cannot reach Evolution API. Is Docker running?")

    acc = Account(
        label=body.label,
        instance_name=instance_name,
        status="connecting",
    )
    db.add(acc)
    db.commit()
    db.refresh(acc)
    return account_out(db, acc)


@router.get("/{account_id}/qr", response_model=QRResponse)
async def get_qr(account_id: int, db: Session = Depends(get_db)):
    acc = db.get(Account, account_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")

    if acc.status == "connected":
        return QRResponse(status="connected")

    try:
        result = await evolution.connect_instance(acc.instance_name)
    except evolution.EvolutionError as exc:
        raise HTTPException(status_code=502, detail=f"Evolution: {exc.detail}")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Cannot reach Evolution API")

    # QR can be in result.qrcode.base64 or result.base64
    qr = None
    if isinstance(result, dict):
        qr_obj = result.get("qrcode") or result.get("qrCode")
        if isinstance(qr_obj, dict):
            qr = qr_obj.get("base64")
        elif isinstance(qr_obj, str):
            qr = qr_obj
        if not qr:
            qr = result.get("base64")

    return QRResponse(status=acc.status, qr_base64=qr)


@router.post("/{account_id}/disconnect")
async def disconnect_account(account_id: int, db: Session = Depends(get_db)):
    acc = db.get(Account, account_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")

    try:
        await evolution.logout_instance(acc.instance_name)
    except evolution.EvolutionError:
        pass  # Already disconnected
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Cannot reach Evolution API")

    acc.status = "disconnected"
    db.commit()
    return {"ok": True}


@router.delete("/{account_id}")
async def delete_account(account_id: int, db: Session = Depends(get_db)):
    acc = db.get(Account, account_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")

    try:
        await evolution.delete_instance(acc.instance_name)
    except evolution.EvolutionError:
        pass  # Instance may already be gone
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Cannot reach Evolution API")

    db.delete(acc)
    db.commit()
    return {"ok": True}
