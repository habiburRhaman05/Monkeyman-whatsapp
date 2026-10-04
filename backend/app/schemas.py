"""Pydantic request/response schemas."""

from datetime import datetime

from pydantic import BaseModel


# ── Account ───────────────────────────────────────────────
class AccountCreate(BaseModel):
    label: str


class AccountOut(BaseModel):
    id: int
    label: str
    instance_name: str
    phone_number: str | None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class QRResponse(BaseModel):
    status: str
    qr_base64: str | None = None
