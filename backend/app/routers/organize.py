"""Labels and quick replies. Both live only in this dashboard (WhatsApp never sees them)."""

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Account, Chat, ChatLabel, Label, QuickReply
from app.serializers import chat_out, unread_total
from app.ws import manager

router = APIRouter(tags=["organize"])

_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
PALETTE = ["#00a884", "#53bdeb", "#f59e0b", "#ea4335", "#a855f7", "#ec4899", "#14b8a6", "#6366f1"]


def label_out(lb: Label) -> dict:
    return {"id": lb.id, "name": lb.name, "color": lb.color}


def reply_out(r: QuickReply) -> dict:
    return {"id": r.id, "shortcut": r.shortcut, "text": r.text}


# ── labels ────────────────────────────────────────────────

class LabelBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=40)
    color: str | None = None


@router.get("/labels")
def list_labels(db: Session = Depends(get_db)):
    return [label_out(lb) for lb in db.query(Label).order_by(Label.name).all()]


@router.post("/labels", status_code=201)
def create_label(body: LabelBody, db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name is required")
    if body.color and not _COLOR.match(body.color):
        raise HTTPException(400, "Color must look like #00a884")
    color = body.color or PALETTE[db.query(Label).count() % len(PALETTE)]
    lb = Label(name=name, color=color)
    db.add(lb)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A label with this name already exists")
    return label_out(lb)


@router.delete("/labels/{label_id}")
def delete_label(label_id: int, db: Session = Depends(get_db)):
    lb = db.get(Label, label_id)
    if not lb:
        raise HTTPException(404, "Label not found")
    db.query(ChatLabel).filter(ChatLabel.label_id == lb.id).delete()
    db.delete(lb)
    db.commit()
    return {"ok": True}


class ChatLabelsBody(BaseModel):
    label_ids: list[int]


@router.put("/accounts/{account_id}/chats/{chat_id}/labels")
async def set_chat_labels(account_id: int, chat_id: int, body: ChatLabelsBody, db: Session = Depends(get_db)):
    acc = db.get(Account, account_id)
    chat = db.get(Chat, chat_id)
    if not acc or not chat or chat.account_id != acc.id:
        raise HTTPException(404, "Chat not found")
    wanted = {i for i in body.label_ids}
    valid = {lb.id for lb in db.query(Label).filter(Label.id.in_(wanted)).all()} if wanted else set()
    db.query(ChatLabel).filter(ChatLabel.chat_id == chat.id).delete()
    for lid in sorted(valid):
        db.add(ChatLabel(chat_id=chat.id, label_id=lid))
    db.commit()
    db.refresh(chat)
    out = chat_out(chat)
    await manager.broadcast(
        "chat.updated", {"account_id": acc.id, "data": {"chat": out, "unread_total": unread_total(db, acc.id)}}
    )
    return out


# ── quick replies ─────────────────────────────────────────

class QuickReplyBody(BaseModel):
    shortcut: str = Field(..., min_length=1, max_length=40)
    text: str = Field(..., min_length=1, max_length=4000)


@router.get("/quick-replies")
def list_quick_replies(db: Session = Depends(get_db)):
    return [reply_out(r) for r in db.query(QuickReply).order_by(QuickReply.shortcut).all()]


@router.post("/quick-replies", status_code=201)
def create_quick_reply(body: QuickReplyBody, db: Session = Depends(get_db)):
    shortcut = body.shortcut.strip().lstrip("/").lower()
    text = body.text.strip()
    if not re.fullmatch(r"[a-z0-9_-]{1,40}", shortcut):
        raise HTTPException(400, "Shortcut can only use letters, numbers, - and _")
    if not text:
        raise HTTPException(400, "Text is required")
    r = QuickReply(shortcut=shortcut, text=text)
    db.add(r)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"/{shortcut} already exists")
    return reply_out(r)


@router.delete("/quick-replies/{reply_id}")
def delete_quick_reply(reply_id: int, db: Session = Depends(get_db)):
    r = db.get(QuickReply, reply_id)
    if not r:
        raise HTTPException(404, "Quick reply not found")
    db.delete(r)
    db.commit()
    return {"ok": True}
