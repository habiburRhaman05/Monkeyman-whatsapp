"""Single shared admin login (email + password from settings), JWT-based sessions."""

import secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Header, HTTPException, WebSocket

from app.config import settings

ALGORITHM = "HS256"


def create_token(email: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": email, "iat": now, "exp": now + timedelta(days=settings.jwt_expire_days)}
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None


def verify_credentials(email: str, password: str) -> bool:
    email_ok = secrets.compare_digest(email.strip().lower(), settings.admin_email.strip().lower())
    pw_ok = secrets.compare_digest(password, settings.admin_password)
    return email_ok and pw_ok


def require_auth(authorization: str | None = Header(default=None)) -> str:
    """FastAPI dependency — 401s unless a valid bearer token is present. Returns the email."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    payload = decode_token(authorization.removeprefix("Bearer ").strip())
    if not payload:
        raise HTTPException(401, "Invalid or expired session")
    return payload["sub"]


async def require_ws_auth(ws: WebSocket) -> bool:
    """Validates the ?token= query param on a WebSocket connect. Caller must close the socket if False."""
    token = ws.query_params.get("token")
    if not token:
        return False
    return decode_token(token) is not None
