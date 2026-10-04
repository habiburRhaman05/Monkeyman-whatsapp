"""WebSocket connection manager — broadcast events to all connected browsers."""

import json
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        self._connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self._connections.append(ws)
        logger.info("WS connected (%d total)", len(self._connections))

    def disconnect(self, ws: WebSocket):
        self._connections.remove(ws)
        logger.info("WS disconnected (%d total)", len(self._connections))

    async def broadcast(self, event_type: str, data: dict[str, Any]):
        """Send a JSON message to every connected browser."""
        payload = json.dumps({"type": event_type, **data})
        dead: list[WebSocket] = []
        for ws in self._connections:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            try:
                self._connections.remove(ws)
            except ValueError:
                pass


manager = ConnectionManager()
