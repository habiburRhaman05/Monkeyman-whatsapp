"""Keep Account.status in sync with Evolution.

The dashboard shows "connected / not connected" for sender numbers, and campaign
start/enroll refuse numbers that are not connected. That status must come from
Evolution, not from whatever was written the last time a CONNECTION_UPDATE
webhook happened to arrive (it does not arrive at all when the number is linked
outside the app or the webhook URL changed).
"""

import asyncio
import logging

import httpx

from app import evolution
from app.db import SessionLocal
from app.models import Account
from app.ws import manager

logger = logging.getLogger(__name__)

POLL_INTERVAL = 20  # seconds between status sweeps


def state_to_status(state: str) -> str:
    if state == "open":
        return "connected"
    if state == "close":
        return "disconnected"
    return "connecting"


async def refresh_status(db, acc: Account) -> str:
    """Ask Evolution for the instance state and update the row. Returns the status."""
    try:
        state = await evolution.connection_state(acc.instance_name)
    except evolution.EvolutionError as exc:
        # Only a 404 means the instance is really gone; other errors keep the last
        # known status instead of flapping to "disconnected".
        if exc.status_code == 404 and acc.status != "disconnected":
            acc.status = "disconnected"
        return acc.status
    except httpx.HTTPError:
        return acc.status  # Evolution unreachable: keep last known status

    acc.status = state_to_status(state)
    return acc.status


async def refresh_all(db) -> list[Account]:
    accounts = db.query(Account).order_by(Account.created_at).all()
    for acc in accounts:
        await refresh_status(db, acc)
    db.commit()
    return accounts


async def refresh_accounts_by_id(db, account_ids: list[int]) -> dict[int, str]:
    """Refresh just the numbers a campaign is about to send from."""
    accounts = db.query(Account).filter(Account.id.in_(account_ids)).all()
    statuses: dict[int, str] = {}
    for acc in accounts:
        statuses[acc.id] = await refresh_status(db, acc)
    db.commit()
    return statuses


async def account_status_loop() -> None:
    """Sweep every number's state so any page sees the truth, without a webhook."""
    logger.info("Account status watcher started (every %ds)", POLL_INTERVAL)
    while True:
        db = SessionLocal()
        try:
            before = {a.id: a.status for a in db.query(Account).all()}
            accounts = await refresh_all(db)
            for acc in accounts:
                if before.get(acc.id) != acc.status:
                    logger.info(
                        "Account %d (%s) is now %s", acc.id, acc.instance_name, acc.status
                    )
                    await manager.broadcast(
                        "account.status",
                        {"account_id": acc.id, "data": {"status": acc.status, "phone_number": acc.phone_number}},
                    )
        except Exception as exc:
            logger.exception("Account status sweep failed: %s", exc)
        finally:
            db.close()
        await asyncio.sleep(POLL_INTERVAL)
