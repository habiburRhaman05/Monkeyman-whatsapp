"""Database engine and session factory (SQLite file or Postgres such as Neon)."""

import logging
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)

url = settings.database_url
is_sqlite = url.startswith("sqlite")

if is_sqlite:
    Path(url.replace("sqlite:///", "")).parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    url,
    connect_args={"check_same_thread": False} if is_sqlite else {},
    pool_pre_ping=True,
    echo=False,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency that yields a DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def run_migrations() -> None:
    """Add columns that exist in the models but not yet in the DB."""
    _COLUMNS = {
        "chats": [
            ("profile_pic_url", "VARCHAR(500)"),
            ("custom_name", "VARCHAR(200)"),
            ("note", "TEXT"),
            ("pinned", "BOOLEAN DEFAULT FALSE"),
            ("archived", "BOOLEAN DEFAULT FALSE"),
            ("muted", "BOOLEAN DEFAULT FALSE"),
        ],
        "contacts": [("profile_pic_url", "VARCHAR(500)")],
        "messages": [
            ("quoted_message_id", "VARCHAR(120)"),
            ("quoted_sender", "VARCHAR(200)"),
            ("quoted_text", "VARCHAR(500)"),
            ("quoted_type", "VARCHAR(20)"),
            ("sender_jid", "VARCHAR(120)"),
            ("reactions", "TEXT"),
            ("deleted", "BOOLEAN DEFAULT FALSE"),
            ("hidden", "BOOLEAN DEFAULT FALSE"),
            ("edited", "BOOLEAN DEFAULT FALSE"),
            ("starred", "BOOLEAN DEFAULT FALSE"),
            ("media_mimetype", "VARCHAR(100)"),
            ("media_filename", "VARCHAR(300)"),
        ],
    }
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, cols in _COLUMNS.items():
            if not insp.has_table(table):
                continue
            existing = {c["name"] for c in insp.get_columns(table)}
            for col_name, col_type in cols:
                if col_name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}"))
                    logger.info("Added column %s.%s", table, col_name)
