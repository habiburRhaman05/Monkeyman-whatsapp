"""Endpoints for CSV/XLSX contact uploads, batches, uploaded-contact listing, and WhatsApp checks."""

import json
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.contact_import import clean_phone, guess_mapping, parse_file, process_rows, COUNTRY_TO_CODE
from app.db import get_db
from app.models import Account, ContactBatch, Label, UploadedContact
from app.routers.organize import PALETTE, label_out
from app import evolution

logger = logging.getLogger(__name__)
router = APIRouter(tags=["contact-uploads"])

MAX_FILE_SIZE = 5 * 1024 * 1024  # 5 MB
MAX_ROWS = 20_000


def batch_out(b: ContactBatch) -> dict:
    return {
        "id": b.id,
        "tag": b.tag,
        "label_id": b.label_id,
        "filename": b.filename,
        "total": b.total,
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }


def contact_out(c: UploadedContact) -> dict:
    return {
        "id": c.id,
        "batch_id": c.batch_id,
        "first_name": c.first_name,
        "last_name": c.last_name,
        "name": c.name,
        "email": c.email,
        "country_code": c.country_code,
        "phone": c.phone,
        "extra": c.extra,
        "wa_status": c.wa_status,
        "wa_jid": c.wa_jid,
        "checked_at": c.checked_at.isoformat() if c.checked_at else None,
    }


def _get_or_create_label(db: Session, name: str) -> Label:
    lb = db.query(Label).filter(Label.name == name).first()
    if lb:
        return lb
    color = PALETTE[db.query(Label).count() % len(PALETTE)]
    lb = Label(name=name, color=color)
    db.add(lb)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        lb = db.query(Label).filter(Label.name == name).first()
        if not lb:
            raise HTTPException(500, "Could not create label")
    return lb


# ── Preview ──────────────────────────────────────────

@router.post("/contact-uploads/preview")
async def preview_upload(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(400, f"File too large (max {MAX_FILE_SIZE // 1024 // 1024} MB)")
    fname = file.filename or "upload.csv"
    try:
        columns, rows = parse_file(data, fname)
    except Exception as exc:
        raise HTTPException(400, f"Could not parse file: {exc}")
    if not columns:
        raise HTTPException(400, "File has no columns")
    mapping = guess_mapping(columns)
    return {
        "columns": columns,
        "rows": [dict(r) for r in rows[:5]],
        "mapping": mapping,
        "total_rows": len(rows),
    }


# ── Upload ───────────────────────────────────────────

@router.post("/contact-uploads", status_code=201)
async def upload_contacts(
    file: UploadFile = File(...),
    tag: str = Form(...),
    mapping_first_name: str | None = Form(None),
    mapping_last_name: str | None = Form(None),
    mapping_name: str | None = Form(None),
    mapping_email: str | None = Form(None),
    mapping_phone: str | None = Form(None),
    mapping_country_code: str | None = Form(None),
    mapping_country_name: str | None = Form(None),
    default_country_code: str | None = Form(None),
    db: Session = Depends(get_db),
):
    tag = tag.strip()
    if not tag or len(tag) > 40:
        raise HTTPException(400, "Tag is required (max 40 chars)")

    data = await file.read()
    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(400, f"File too large (max {MAX_FILE_SIZE // 1024 // 1024} MB)")
    fname = file.filename or "upload.csv"
    try:
        columns, rows = parse_file(data, fname)
    except Exception as exc:
        raise HTTPException(400, f"Could not parse file: {exc}")
    if not rows:
        raise HTTPException(400, "File has no data rows")
    if len(rows) > MAX_ROWS:
        raise HTTPException(400, f"Too many rows ({len(rows)}). Max {MAX_ROWS}.")

    mapping = {
        "first_name": mapping_first_name,
        "last_name": mapping_last_name,
        "name": mapping_name,
        "email": mapping_email,
        "phone": mapping_phone,
        "country_code": mapping_country_code,
        "country_name": mapping_country_name,
    }
    if not mapping["phone"]:
        raise HTTPException(400, "Phone column mapping is required")

    cleaned, dups, invalid = process_rows(rows, mapping, default_country_code)
    if not cleaned:
        raise HTTPException(400, f"No valid contacts found ({invalid} invalid, {dups} duplicates)")

    label = _get_or_create_label(db, tag)
    batch = ContactBatch(tag=tag, label_id=label.id, filename=fname, total=len(cleaned))
    db.add(batch)
    db.flush()

    # Dedupe against existing contacts in this batch
    existing_phones: set[str] = set()
    db_dups = 0
    for row in cleaned:
        if row["phone"] in existing_phones:
            db_dups += 1
            continue
        existing_phones.add(row["phone"])
        db.add(UploadedContact(
            batch_id=batch.id,
            first_name=row["first_name"],
            last_name=row["last_name"],
            name=row["name"],
            email=row["email"],
            country_code=row["country_code"],
            phone=row["phone"],
            extra=row["extra"],
        ))

    batch.total = len(existing_phones)
    db.commit()

    logger.info("Uploaded %d contacts (batch %d, tag=%s, dups=%d, invalid=%d)", batch.total, batch.id, tag, dups + db_dups, invalid)

    return {
        "batch": batch_out(batch),
        "label": label_out(label),
        "inserted": batch.total,
        "duplicates": dups + db_dups,
        "invalid": invalid,
    }


# ── Batches ──────────────────────────────────────────

@router.get("/contact-batches")
def list_batches(db: Session = Depends(get_db)):
    batches = db.query(ContactBatch).order_by(ContactBatch.created_at.desc()).all()
    result = []
    for b in batches:
        d = batch_out(b)
        total = db.query(UploadedContact).filter(UploadedContact.batch_id == b.id).count()
        yes_count = db.query(UploadedContact).filter(UploadedContact.batch_id == b.id, UploadedContact.wa_status == "yes").count()
        no_count = db.query(UploadedContact).filter(UploadedContact.batch_id == b.id, UploadedContact.wa_status == "no").count()
        d["counts"] = {"total": total, "yes": yes_count, "no": no_count, "unchecked": total - yes_count - no_count}
        result.append(d)
    return result


@router.delete("/contact-batches/{batch_id}")
def delete_batch(batch_id: int, db: Session = Depends(get_db)):
    batch = db.get(ContactBatch, batch_id)
    if not batch:
        raise HTTPException(404, "Batch not found")
    db.delete(batch)
    db.commit()
    return {"ok": True}


# ── Uploaded contacts ────────────────────────────────

@router.get("/uploaded-contacts")
def list_uploaded_contacts(
    batch_id: int | None = None,
    wa: str | None = None,
    q: str | None = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    query = db.query(UploadedContact)
    if batch_id is not None:
        query = query.filter(UploadedContact.batch_id == batch_id)
    if wa in ("yes", "no", "unchecked"):
        query = query.filter(UploadedContact.wa_status == wa)
    if q:
        q_like = f"%{q.strip()}%"
        query = query.filter(
            (UploadedContact.name.ilike(q_like))
            | (UploadedContact.first_name.ilike(q_like))
            | (UploadedContact.last_name.ilike(q_like))
            | (UploadedContact.email.ilike(q_like))
            | (UploadedContact.phone.like(q_like))
        )
    total = query.count()
    contacts = query.order_by(UploadedContact.id).offset(offset).limit(min(limit, 500)).all()
    return {
        "contacts": [contact_out(c) for c in contacts],
        "total": total,
    }


# ── WhatsApp number check ───────────────────────────

class WaCheckBody(BaseModel):
    batch_id: int | None = None
    contact_ids: list[int] | None = None
    account_id: int


@router.post("/uploaded-contacts/check-whatsapp")
async def check_whatsapp(body: WaCheckBody, db: Session = Depends(get_db)):
    """Check which uploaded contacts have WhatsApp using Evolution API.

    Provide `batch_id` (checks all unchecked in that batch),
    `contact_ids` (checks specific contacts), or neither (checks ALL unchecked).
    Requires `account_id` of a connected WhatsApp account to use for the lookup.
    """
    acc = db.get(Account, body.account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    if acc.status != "connected":
        raise HTTPException(409, "Account is not connected — connect it first")

    # Gather contacts to check
    query = db.query(UploadedContact)
    if body.contact_ids:
        query = query.filter(UploadedContact.id.in_(body.contact_ids))
    elif body.batch_id is not None:
        query = query.filter(
            UploadedContact.batch_id == body.batch_id,
            UploadedContact.wa_status == "unchecked",
        )
    else:
        query = query.filter(UploadedContact.wa_status == "unchecked")

    contacts = query.limit(500).all()
    if not contacts:
        return {"checked": 0, "yes": 0, "no": 0, "message": "No unchecked contacts to check"}

    # Build phone list and check via Evolution API
    phone_list = [c.phone for c in contacts]
    phone_to_contact = {c.phone: c for c in contacts}

    try:
        results = await evolution.check_is_on_whatsapp(acc.instance_name, phone_list)
    except evolution.EvolutionError as exc:
        raise HTTPException(502, f"Evolution API error: {exc.detail}")

    now = datetime.now(timezone.utc)
    yes_count = 0
    no_count = 0

    # Map results back to contacts
    result_by_number: dict[str, dict] = {}
    for r in results:
        num = re.sub(r"[^\d]", "", str(r.get("number", r.get("jid", ""))))
        result_by_number[num] = r

    for phone, contact in phone_to_contact.items():
        # Try matching by exact phone or by the returned number
        matched = result_by_number.get(phone)
        if not matched:
            # Try matching by partial suffix
            for rnum, rdata in result_by_number.items():
                if phone.endswith(rnum) or rnum.endswith(phone):
                    matched = rdata
                    break

        if matched and matched.get("exists", False):
            contact.wa_status = "yes"
            contact.wa_jid = matched.get("jid", None)
            yes_count += 1
        else:
            contact.wa_status = "no"
            no_count += 1
        contact.checked_at = now

    db.commit()

    return {
        "checked": len(contacts),
        "yes": yes_count,
        "no": no_count,
    }


# ── Country code lookup ─────────────────────────────

@router.get("/country-codes")
def list_country_codes():
    """Return the supported country name → dial code mappings."""
    return {"codes": COUNTRY_TO_CODE}


# ── Contact fields (for template variables) ────────

@router.get("/contact-fields")
def list_contact_fields(db: Session = Depends(get_db)):
    """Return all available template variable names for campaign messages.

    Built-in: first_name, last_name, name, email, phone.
    Extra: discovered from the `extra` JSON of uploaded contacts.
    """
    builtins = ["first_name", "last_name", "name", "email", "phone"]
    extra_keys: set[str] = set()
    rows = db.query(UploadedContact.extra).filter(UploadedContact.extra.isnot(None)).limit(500).all()
    for (raw,) in rows:
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                extra_keys.update(obj.keys())
        except (json.JSONDecodeError, TypeError):
            pass
    all_fields = builtins + sorted(extra_keys - set(builtins))
    return {"fields": all_fields}
