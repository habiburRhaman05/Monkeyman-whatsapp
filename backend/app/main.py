"""FastAPI application entry point."""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app import evolution
from app.config import settings
from app.db import Base, SessionLocal, engine, run_migrations
from app.models import Account
from app.routers import accounts, chats, organize, webhook
from app.sync import sync_account
from app.ws import manager

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")
logger = logging.getLogger(__name__)

# Create tables on startup, then add any new columns
Base.metadata.create_all(bind=engine)
run_migrations()


async def _reapply_webhooks_and_sync() -> None:
    """On startup, point every instance's webhook at the current WEBHOOK_BASE_URL, then catch up.

    Evolution stores the webhook address when a number is created. If the address changed since
    (different host, docker network, secret), events would silently stop arriving.
    """
    await asyncio.sleep(2)
    url = accounts.webhook_url()
    # Log the full webhook URL (minus the secret) so misconfigurations are obvious
    safe_url = url.split("?")[0] + "?secret=***"
    logger.info("Registering webhook URL with Evolution: %s", safe_url)
    logger.info("WEBHOOK_BASE_URL=%s  (should be http://host.docker.internal:8000 on Docker Desktop)", settings.webhook_base_url)
    db = SessionLocal()
    try:
        ids = [(a.id, a.instance_name) for a in db.query(Account).all()]
    finally:
        db.close()
    if not ids:
        logger.info("No accounts to register webhooks for")
    for account_id, instance_name in ids:
        try:
            await evolution.set_webhook(instance_name, url, accounts.WEBHOOK_EVENTS)
            logger.info("Webhook registered for account %s (%s)", account_id, instance_name)
        except Exception as exc:
            logger.warning("Could not re-apply webhook for account %s: %s — %s", account_id, type(exc).__name__, exc)
            continue
        db = SessionLocal()
        try:
            acc = db.get(Account, account_id)
            connected = bool(acc and acc.status == "connected")
        finally:
            db.close()
        if connected:
            await sync_account(account_id)


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_reapply_webhooks_and_sync())
    yield
    task.cancel()


app = FastAPI(title="WhatsApp Dashboard", version="0.1.0", lifespan=lifespan)

# CORS — allow only the frontend origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(accounts.router)
app.include_router(chats.router)
app.include_router(organize.router)
app.include_router(webhook.router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "ws_clients": len(manager._connections),
        "webhook_base_url": settings.webhook_base_url,
    }


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            # Keep alive — we only send events, but read to detect disconnects
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(ws)
