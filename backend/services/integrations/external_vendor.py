"""Opt-in MAC vendor lookup for the optional same-computer host.

Only normalized MAC addresses are sent to one of the fixed HTTPS providers.
The feature is disabled by default; cache entries remain in the host database.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from contextlib import closing
import json
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_VENDOR_BATCH = 500
MAX_CACHE_ENTRIES = 10_000
REQUEST_TIMEOUT_SECONDS = 8
MIN_REQUEST_INTERVAL_SECONDS = 1.0

PROVIDERS = {
    "macvendors": {
        "description": "macvendors.com",
        "url": "https://api.macvendors.com/{mac}",
    },
    "maclookup": {
        "description": "maclookup.app",
        "url": "https://api.maclookup.app/v2/macs/{mac}/",
    },
    "mac2vendor": {
        "description": "mac2vendor.com",
        "url": "https://mac2vendor.com/api/v1/lookup/{mac}",
    },
}


class _DenyVendorRedirects(HTTPRedirectHandler):
    """Never forward a user's MAC address to a redirect target."""

    def redirect_request(self, _request, _file, _code, _message, _headers, _new_url):
        return None


def urlopen(request: Request, timeout: float = REQUEST_TIMEOUT_SECONDS):
    """Open a fixed-provider request without urllib's default redirect behavior."""
    return build_opener(_DenyVendorRedirects).open(request, timeout=timeout)

_rate_lock = threading.Lock()
_last_request_at = 0.0


def normalize_mac(value: Any) -> str:
    return "".join(character for character in str(value or "").upper() if character in "0123456789ABCDEF")


def normalize_settings(value: Any = None) -> dict[str, Any]:
    settings = value if isinstance(value, dict) else {}
    provider = str(settings.get("provider") or "macvendors").strip().lower()
    if provider not in PROVIDERS:
        provider = "macvendors"
    try:
        rate_limit = int(settings.get("rateLimit") or 25)
    except (TypeError, ValueError):
        rate_limit = 25
    try:
        cache_ttl_days = int(settings.get("cacheTtlDays") or 30)
    except (TypeError, ValueError):
        cache_ttl_days = 30
    return {
        "enabled": settings.get("enabled") is True,
        "provider": provider,
        "rateLimit": max(1, min(rate_limit, MAX_VENDOR_BATCH)),
        "cacheTtlDays": max(1, min(cache_ttl_days, 365)),
        "onlyUnknown": settings.get("onlyUnknown", True) is not False,
    }


def provider_options() -> list[dict[str, str]]:
    return [
        {"key": key, "description": item["description"], "url": item["url"]}
        for key, item in PROVIDERS.items()
    ]


def cache_key(provider: str, mac: str) -> str:
    return f"external_vendor:{provider}:{normalize_mac(mac)}"


def cache_get(database_path: Path | str, key: str) -> dict[str, str] | None:
    with closing(sqlite3.connect(Path(database_path).resolve(), timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT value, cached_at FROM api_cache WHERE cache_key = ?", (key,)
        ).fetchone()
    return dict(row) if row else None


def cache_set(database_path: Path | str, key: str, value: str) -> None:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    with closing(sqlite3.connect(Path(database_path).resolve(), timeout=30)) as connection:
        with connection:
            connection.execute(
                "INSERT INTO api_cache (cache_key, value, cached_at) VALUES (?, ?, ?) "
                "ON CONFLICT(cache_key) DO UPDATE SET value=excluded.value, cached_at=excluded.cached_at",
                (key, value[:500], now),
            )
            connection.execute(
                "DELETE FROM api_cache WHERE cache_key IN ("
                "SELECT cache_key FROM api_cache WHERE cache_key LIKE 'external_vendor:%' "
                "ORDER BY cached_at DESC LIMIT -1 OFFSET ?)",
                (MAX_CACHE_ENTRIES,),
            )


def clear_cache(database_path: Path | str, provider: str = "") -> int:
    if provider and provider not in PROVIDERS:
        raise ValueError("Unknown vendor provider")
    pattern = f"external_vendor:{provider}:*" if provider else "external_vendor:*"
    with closing(sqlite3.connect(Path(database_path).resolve(), timeout=30)) as connection:
        with connection:
            cursor = connection.execute("DELETE FROM api_cache WHERE cache_key GLOB ?", (pattern,))
    return int(cursor.rowcount or 0)


def load_settings(database_path: Path | str) -> dict[str, Any]:
    with closing(sqlite3.connect(Path(database_path).resolve(), timeout=30)) as connection:
        row = connection.execute("SELECT value FROM app_settings WHERE key = 'external_vendor_api'").fetchone()
    if not row:
        return normalize_settings()
    try:
        return normalize_settings(json.loads(row[0]))
    except (TypeError, ValueError, json.JSONDecodeError):
        return normalize_settings()


def save_settings(database_path: Path | str, settings: Any) -> dict[str, Any]:
    normalized = normalize_settings(settings)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    encoded = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
    with closing(sqlite3.connect(Path(database_path).resolve(), timeout=30)) as connection:
        with connection:
            connection.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES ('external_vendor_api', ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (encoded, now),
            )
    return normalized


def _fresh(entry: dict[str, str] | None, ttl_days: int) -> bool:
    if not entry:
        return False
    try:
        cached_at = datetime.fromisoformat(entry["cached_at"].replace("Z", "+00:00"))
        if cached_at.tzinfo is None:
            cached_at = cached_at.replace(tzinfo=timezone.utc)
        return cached_at > datetime.now(timezone.utc) - timedelta(days=ttl_days)
    except (KeyError, TypeError, ValueError):
        return False


def _rate_limit() -> None:
    global _last_request_at
    with _rate_lock:
        delay = MIN_REQUEST_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
        if delay > 0:
            time.sleep(delay)
        _last_request_at = time.monotonic()


def lookup_vendor(mac: str, settings: dict[str, Any]) -> str | None:
    normalized_mac = normalize_mac(mac)
    if len(normalized_mac) != 12:
        return None
    provider = settings["provider"]
    url = PROVIDERS[provider]["url"].format(mac=normalized_mac)
    request = Request(url, headers={"User-Agent": "MAC-Analyzer-Pro-Next/2.x"})
    _rate_limit()
    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return None
            content = response.read(32_768).decode("utf-8", errors="replace").strip()
    except (HTTPError, URLError, TimeoutError, OSError):
        return None
    if provider == "macvendors":
        vendor = content
    else:
        try:
            payload = json.loads(content)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        vendor = str(payload.get("company") or payload.get("vendor") or payload.get("name") or "").strip()
        if provider == "maclookup" and payload.get("found") is False:
            return None
    vendor = re.sub(r"\s+", " ", vendor).strip()
    if not vendor or len(vendor) > 500 or "not found" in vendor.lower():
        return None
    return vendor


def test_vendor_api(database_path: Path | str, mac: Any, force_live: bool = False) -> dict[str, Any]:
    settings = load_settings(database_path)
    normalized_mac = normalize_mac(mac)
    if len(normalized_mac) != 12:
        return {"ok": False, "provider": settings["provider"], "error": "MAC должен содержать 12 шестнадцатеричных знаков.", "cached": False, "lookups": 0}
    key = cache_key(settings["provider"], normalized_mac)
    cached = cache_get(database_path, key)
    if cached and not force_live and _fresh(cached, settings["cacheTtlDays"]):
        return {"ok": True, "provider": settings["provider"], "mac": normalized_mac, "vendor": cached["value"], "source": "cache", "cached": True, "lookups": 0}
    if not settings["enabled"]:
        return {"ok": False, "provider": settings["provider"], "error": "Внешний API выключен. Включите отдельное согласие перед сетевым запросом.", "cached": False, "lookups": 0}
    vendor = lookup_vendor(normalized_mac, settings)
    if not vendor:
        return {"ok": False, "provider": settings["provider"], "error": "Поставщик не вернул название производителя.", "cached": False, "lookups": 1}
    cache_set(database_path, key, vendor)
    return {"ok": True, "provider": settings["provider"], "mac": normalized_mac, "vendor": vendor, "source": "api", "cached": False, "lookups": 1}


def enrich_macs(database_path: Path | str, macs: Any, lookup_budget: Any = None) -> dict[str, Any]:
    settings = load_settings(database_path)
    if not settings["enabled"]:
        raise ValueError("Внешний vendor API выключен")
    if not isinstance(macs, list) or len(macs) > MAX_VENDOR_BATCH:
        raise ValueError(f"macs должен быть массивом не более {MAX_VENDOR_BATCH} адресов")
    try:
        budget = settings["rateLimit"] if lookup_budget is None else max(0, min(int(lookup_budget), settings["rateLimit"]))
    except (TypeError, ValueError):
        raise ValueError("lookupBudget должен быть целым числом от 0 до заданного лимита") from None
    candidates = list(dict.fromkeys(normalize_mac(mac) for mac in macs if len(normalize_mac(mac)) == 12))
    results: dict[str, dict[str, str]] = {}
    cached_count = 0
    lookups = 0
    for mac in candidates:
        key = cache_key(settings["provider"], mac)
        cached = cache_get(database_path, key)
        if cached and _fresh(cached, settings["cacheTtlDays"]):
            vendor = cached["value"]
            source = "external_cache"
            cached_count += 1
        elif lookups < budget:
            vendor = lookup_vendor(mac, settings)
            lookups += 1
            source = "external_api"
            if vendor:
                cache_set(database_path, key, vendor)
        else:
            continue
        if vendor:
            results[mac] = {"vendor": vendor, "source": source, "confidence": "0.95"}
    return {
        "provider": settings["provider"],
        "candidates": len(candidates),
        "lookups": lookups,
        "cached": cached_count,
        "updated": len(results),
        "results": results,
    }
