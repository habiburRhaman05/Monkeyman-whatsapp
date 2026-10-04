"""Per-campaign sending limits. Always clamped server-side to safe ranges."""

import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HARD_MAX_PER_DAY = 200
MIN_DELAY = 10
MAX_DELAY = 300

DEFAULTS = {
    "daily_limit": 50,
    "delay_min": 10,
    "delay_max": 30,
    "start_hour": 9,
    "end_hour": 17,
    "weekdays_only": True,
    "stop_on_reply": True,
    "timezone": "UTC",
}


def _int(v, default: int) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _tz(name) -> ZoneInfo:
    try:
        return ZoneInfo(str(name))
    except Exception:
        return ZoneInfo("UTC")


def normalize(raw: dict | str | None) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            raw = None
    s = {**DEFAULTS, **(raw if isinstance(raw, dict) else {})}
    s["daily_limit"] = max(1, min(HARD_MAX_PER_DAY, _int(s["daily_limit"], DEFAULTS["daily_limit"])))
    s["delay_min"] = max(MIN_DELAY, min(MAX_DELAY, _int(s["delay_min"], DEFAULTS["delay_min"])))
    s["delay_max"] = max(s["delay_min"], min(MAX_DELAY, _int(s["delay_max"], DEFAULTS["delay_max"])))
    start = max(0, min(23, _int(s["start_hour"], DEFAULTS["start_hour"])))
    end = max(1, min(24, _int(s["end_hour"], DEFAULTS["end_hour"])))
    if end <= start:
        start, end = DEFAULTS["start_hour"], DEFAULTS["end_hour"]
    s["start_hour"], s["end_hour"] = start, end
    s["weekdays_only"] = bool(s["weekdays_only"])
    s["stop_on_reply"] = bool(s["stop_on_reply"])
    s["timezone"] = _tz(s["timezone"]).key
    return s


def local_now(settings: dict, now_utc: datetime) -> datetime:
    return now_utc.replace(tzinfo=timezone.utc).astimezone(_tz(settings["timezone"]))


def in_send_window(settings: dict, now_utc: datetime) -> bool:
    loc = local_now(settings, now_utc)
    if settings["weekdays_only"] and loc.weekday() >= 5:
        return False
    return settings["start_hour"] <= loc.hour < settings["end_hour"]


def next_window_start(settings: dict, now_utc: datetime) -> datetime:
    """Next naive-UTC moment the send window opens."""
    loc = local_now(settings, now_utc)
    day = loc.replace(hour=settings["start_hour"], minute=0, second=0, microsecond=0)
    if day <= loc:
        day += timedelta(days=1)
    while settings["weekdays_only"] and day.weekday() >= 5:
        day += timedelta(days=1)
    return day.astimezone(timezone.utc).replace(tzinfo=None)


def day_start_utc(settings: dict, now_utc: datetime) -> datetime:
    """Start of the current local day, as naive UTC."""
    loc = local_now(settings, now_utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return loc.astimezone(timezone.utc).replace(tzinfo=None)
