"""SQLAlchemy models. All datetimes are naive UTC."""

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    instance_name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    phone_number: Mapped[str | None] = mapped_column(String(30), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="connecting")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    chats: Mapped[list["Chat"]] = relationship(back_populates="account", cascade="all, delete-orphan")
    contacts: Mapped[list["Contact"]] = relationship(cascade="all, delete-orphan")


class Chat(Base):
    __tablename__ = "chats"
    __table_args__ = (UniqueConstraint("account_id", "jid"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    jid: Mapped[str] = mapped_column(String(80), nullable=False)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    profile_pic_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    custom_name: Mapped[str | None] = mapped_column(String(200), nullable=True)  # set by you in the dashboard
    is_group: Mapped[bool] = mapped_column(Boolean, default=False)
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_message_preview: Mapped[str | None] = mapped_column(String(200), nullable=True)
    unread_count: Mapped[int] = mapped_column(Integer, default=0)
    # dashboard-only organisation (WhatsApp does not sync these to linked devices)
    pinned: Mapped[bool | None] = mapped_column(Boolean, default=False, nullable=True)
    archived: Mapped[bool | None] = mapped_column(Boolean, default=False, nullable=True)
    muted: Mapped[bool | None] = mapped_column(Boolean, default=False, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)  # private note, dashboard only

    account: Mapped["Account"] = relationship(back_populates="chats")
    messages: Mapped[list["Message"]] = relationship(back_populates="chat", cascade="all, delete-orphan")
    label_links: Mapped[list["ChatLabel"]] = relationship(cascade="all, delete-orphan")


class Label(Base):
    """A colored tag you can put on chats. Shared by all numbers; lives only in this dashboard."""

    __tablename__ = "labels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    color: Mapped[str] = mapped_column(String(9), default="#00a884")


class ChatLabel(Base):
    __tablename__ = "chat_labels"

    chat_id: Mapped[int] = mapped_column(ForeignKey("chats.id"), primary_key=True)
    label_id: Mapped[int] = mapped_column(ForeignKey("labels.id"), primary_key=True)


class QuickReply(Base):
    """Saved text snippet: type /shortcut in the message box to insert it."""

    __tablename__ = "quick_replies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    shortcut: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)


class Contact(Base):
    __tablename__ = "contacts"
    __table_args__ = (UniqueConstraint("account_id", "jid"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    jid: Mapped[str] = mapped_column(String(80), nullable=False)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    profile_pic_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_group: Mapped[bool] = mapped_column(Boolean, default=False)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (UniqueConstraint("account_id", "wa_message_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    chat_id: Mapped[int] = mapped_column(ForeignKey("chats.id"), nullable=False, index=True)
    wa_message_id: Mapped[str] = mapped_column(String(120), nullable=False)
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    from_me: Mapped[bool] = mapped_column(Boolean, default=False)
    sender_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # text | image | video | audio | document | sticker | other
    type: Mapped[str] = mapped_column(String(20), default="text")
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # pending | sent | delivered | read | failed
    status: Mapped[str] = mapped_column(String(20), default="sent")
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    # reply/quote context
    quoted_message_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    quoted_sender: Mapped[str | None] = mapped_column(String(200), nullable=True)
    quoted_text: Mapped[str | None] = mapped_column(String(500), nullable=True)
    quoted_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # sender (group participant jid) of an incoming message; needed to react to / quote it in groups
    sender_jid: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # JSON {sender: emoji}; "me" is this account
    reactions: Mapped[str | None] = mapped_column(Text, nullable=True)
    # deleted for everyone (tombstone) / hidden in this dashboard only
    deleted: Mapped[bool | None] = mapped_column(Boolean, default=False, nullable=True)
    hidden: Mapped[bool | None] = mapped_column(Boolean, default=False, nullable=True)
    edited: Mapped[bool | None] = mapped_column(Boolean, default=False, nullable=True)
    # dashboard-only star
    starred: Mapped[bool | None] = mapped_column(Boolean, default=False, nullable=True)
    # media metadata for sending
    media_mimetype: Mapped[str | None] = mapped_column(String(100), nullable=True)
    media_filename: Mapped[str | None] = mapped_column(String(300), nullable=True)

    chat: Mapped["Chat"] = relationship(back_populates="messages")


class ContactBatch(Base):
    """One CSV/XLSX upload run, tied to a Label (tag)."""

    __tablename__ = "contact_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tag: Mapped[str] = mapped_column(String(40), nullable=False)
    label_id: Mapped[int] = mapped_column(ForeignKey("labels.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String(300), nullable=False)
    total: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    contacts: Mapped[list["UploadedContact"]] = relationship(back_populates="batch", cascade="all, delete-orphan")


class UploadedContact(Base):
    """A contact row from a CSV/XLSX upload. Never synced to the phone."""

    __tablename__ = "uploaded_contacts"
    __table_args__ = (UniqueConstraint("batch_id", "phone"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("contact_batches.id"), nullable=False, index=True)
    first_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    country_code: Mapped[str | None] = mapped_column(String(5), nullable=True)
    phone: Mapped[str] = mapped_column(String(20), nullable=False)
    whatsapp_copy: Mapped[str | None] = mapped_column(Text, nullable=True)
    extra: Mapped[str | None] = mapped_column(Text, nullable=True)
    wa_status: Mapped[str] = mapped_column(String(10), default="unchecked")  # unchecked | yes | no
    wa_jid: Mapped[str | None] = mapped_column(String(80), nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    batch: Mapped["ContactBatch"] = relationship(back_populates="contacts")


# ── Campaigns ────────────────────────────────────────────────

class Campaign(Base):
    __tablename__ = "campaigns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft | active | paused
    trigger_type: Mapped[str] = mapped_column(String(20), default="manual")  # manual | tag_added
    trigger_label_id: Mapped[int | None] = mapped_column(ForeignKey("labels.id"), nullable=True)
    sender_account_ids: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list of account IDs
    nodes: Mapped[str] = mapped_column(Text, default="[]")  # JSON list of node dicts
    settings: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON sending limits
    # Tag-watch: last uploaded_contact id we scanned up to (cursor)
    tag_cursor: Mapped[int] = mapped_column(Integer, default=0)
    # Tag-watch: last time the tag watcher processed contacts
    tag_last_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    runs: Mapped[list["CampaignRun"]] = relationship(back_populates="campaign", cascade="all, delete-orphan")
    events: Mapped[list["CampaignEvent"]] = relationship(cascade="all, delete-orphan")


class ContactSender(Base):
    """Sticky number assignment: once a phone is paired with a number, it stays."""

    __tablename__ = "contact_senders"

    phone: Mapped[str] = mapped_column(String(20), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    first_assigned_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class CampaignNodeState(Base):
    """Per-node per-number state: variant counter and drip release clock."""

    __tablename__ = "campaign_node_state"

    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id"), primary_key=True)
    node_id: Mapped[str] = mapped_column(String(20), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), primary_key=True)
    variant_counter: Mapped[int] = mapped_column(Integer, default=0)
    last_release_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class CampaignRun(Base):
    """One contact progressing through one campaign, bound to one sender number."""

    __tablename__ = "campaign_runs"
    __table_args__ = (UniqueConstraint("campaign_id", "phone"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id"), nullable=False, index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    phone: Mapped[str] = mapped_column(String(20), nullable=False)
    jid: Mapped[str | None] = mapped_column(String(80), nullable=True)
    uploaded_contact_id: Mapped[int | None] = mapped_column(ForeignKey("uploaded_contacts.id"), nullable=True)
    chat_id: Mapped[int | None] = mapped_column(ForeignKey("chats.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | waiting | queued | completed | replied | stopped | failed | skipped
    node_id: Mapped[str | None] = mapped_column(String(20), nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    queued_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_message_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    enrolled_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    campaign: Mapped["Campaign"] = relationship(back_populates="runs")


class ImmediateSession(Base):
    """One immediate-start campaign execution session."""

    __tablename__ = "immediate_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id"), nullable=False, index=True)
    config: Mapped[str] = mapped_column(Text, nullable=False)  # JSON: {sender_assignments, delay, contact_ids}
    status: Mapped[str] = mapped_column(String(20), default="warmup")  # warmup | running | paused | completed | failed
    progress: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON: per-step, per-sender stats
    current_node_index: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class CampaignEvent(Base):
    """Audit log of everything that happened in a campaign run."""

    __tablename__ = "campaign_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("campaign_runs.id"), nullable=False, index=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id"), nullable=False)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    node_id: Mapped[str | None] = mapped_column(String(20), nullable=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # sent | waited | released | replied | skipped | failed | completed | reassigned
    variant_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    message_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
