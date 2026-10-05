"""Login + session check. No self-signup — one shared admin account."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import auth as auth_lib
from app.config import settings

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginBody(BaseModel):
    email: str
    password: str


@router.post("/login")
def login(body: LoginBody):
    if not auth_lib.verify_credentials(body.email, body.password):
        raise HTTPException(401, "Invalid email or password")
    token = auth_lib.create_token(settings.admin_email)
    return {"token": token, "email": settings.admin_email}


@router.get("/me")
def me(email: str = Depends(auth_lib.require_auth)):
    return {"email": email}
