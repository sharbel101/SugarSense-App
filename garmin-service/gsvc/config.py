"""Settings from the environment (and an optional private ./service.env). Nothing secret has a default; nothing is ever printed."""
from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent.parent
ENV_FILE = HERE / "service.env"
STATE_DIR = HERE / "state"
MIN_POLL_INTERVAL_MIN = 5  # configuring less is refused, not clamped silently (the watch only syncs in batches anyway)


class ConfigError(Exception):
    pass


def read_env_file(path: Path) -> dict[str, str]:
    vals: dict[str, str] = {}
    if not path.exists():
        return vals
    if os.name != "nt" and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ConfigError(f"{path} is readable by others. Run: chmod 600 {path}")
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals


def _bool(v: str | None, default: bool) -> bool:
    if v is None or v == "":
        return default
    if v.lower() in {"1", "true", "yes", "on"}:
        return True
    if v.lower() in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"not a boolean: {v!r}")


def _int(v: str | None, default: int, name: str, lo: int, hi: int) -> int:
    if v is None or v == "":
        return default
    try:
        n = int(v)
    except ValueError:
        raise ConfigError(f"{name} must be an integer") from None
    if not lo <= n <= hi:
        raise ConfigError(f"{name} must be between {lo} and {hi}")
    return n


@dataclass(frozen=True)
class Settings:
    worker_db_url: str | None
    api_db_url: str | None
    api_token: str | None
    host: str
    port: int
    cors_origins: tuple[str, ...]
    polling_enabled: bool
    tz: ZoneInfo
    personal_api_key: str | None
    poll_min: int
    history_default_limit: int
    history_max_limit: int
    history_max_span_days: int
    rate_per_minute: int
    state_dir: Path


def load_settings(environ: Mapping[str, str] | None = None, env_file: Path | None = ENV_FILE) -> Settings:
    env = dict(read_env_file(env_file) if env_file else {})
    env.update(os.environ if environ is None else environ)
    g = env.get
    try:
        tz = ZoneInfo(g("GARMIN_LOCAL_TZ") or "Asia/Beirut")
    except Exception:
        raise ConfigError("GARMIN_LOCAL_TZ is not a valid IANA time zone") from None
    cors = tuple(o.strip() for o in (g("GARMIN_CORS_ORIGINS") or "").split(",") if o.strip())
    if "*" in cors:
        raise ConfigError("GARMIN_CORS_ORIGINS must list explicit origins, not *")
    return Settings(
        worker_db_url=g("GARMIN_WORKER_DATABASE_URL") or None,
        api_db_url=g("GARMIN_API_DATABASE_URL") or None,
        api_token=(g("GARMIN_API_TOKEN") or "").strip() or None,
        host=g("GARMIN_API_HOST") or "127.0.0.1",
        port=_int(g("GARMIN_API_PORT"), 8310, "GARMIN_API_PORT", 1024, 65535),
        cors_origins=cors,
        polling_enabled=_bool(g("GARMIN_POLLING_ENABLED"), False),  # off unless switched on explicitly
        tz=tz,
        personal_api_key=(g("GARMIN_PERSONAL_API_KEY") or "").strip() or None,
        poll_min=_int(g("GARMIN_POLL_MIN"), 10, "GARMIN_POLL_MIN", MIN_POLL_INTERVAL_MIN, 240),
        history_default_limit=_int(g("GARMIN_HISTORY_DEFAULT_LIMIT"), 500, "GARMIN_HISTORY_DEFAULT_LIMIT", 1, 5000),
        history_max_limit=_int(g("GARMIN_HISTORY_MAX_LIMIT"), 2000, "GARMIN_HISTORY_MAX_LIMIT", 1, 5000),
        history_max_span_days=_int(g("GARMIN_HISTORY_MAX_SPAN_DAYS"), 14, "GARMIN_HISTORY_MAX_SPAN_DAYS", 1, 90),
        rate_per_minute=_int(g("GARMIN_API_RATE_PER_MIN"), 120, "GARMIN_API_RATE_PER_MIN", 1, 6000),
        state_dir=Path(g("GARMIN_STATE_DIR")) if g("GARMIN_STATE_DIR") else STATE_DIR,
    )
