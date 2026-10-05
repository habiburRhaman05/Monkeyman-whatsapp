"""Application settings loaded from environment / .env file."""

from pathlib import Path

from pydantic_settings import BaseSettings

# The project-root .env (shared with docker compose) and an optional backend/.env override.
_ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"
_BACKEND_ENV = Path(__file__).resolve().parents[1] / ".env"


class Settings(BaseSettings):
    # Evolution API
    evolution_api_url: str = "http://localhost:8080"
    evolution_api_key: str = "change-me"

    # Webhook
    webhook_secret: str = "change-me"
    webhook_base_url: str = "http://host.docker.internal:8000"

    # Database
    database_url: str = "sqlite:///./data/app.db"

    # CORS
    frontend_origin: str = "http://localhost:3001"

    # Opening a chat in the dashboard tells WhatsApp the messages were read (blue ticks for the sender)
    send_read_receipts: bool = True

    # Auth — single shared admin login (no self-signup). Set real values in .env, never commit them.
    admin_email: str = "change-me@example.com"
    admin_password: str = "change-me"
    jwt_secret: str = "change-me-jwt-secret"
    jwt_expire_days: int = 30

    # extra="ignore": the shared .env also holds POSTGRES_* and NEXT_PUBLIC_* keys
    model_config = {
        "env_file": (str(_ROOT_ENV), str(_BACKEND_ENV)),
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()
