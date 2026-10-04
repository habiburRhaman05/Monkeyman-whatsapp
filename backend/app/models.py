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
