"""Additive SQLite schema and settings persistence for the optional host."""

from __future__ import annotations

from collections import Counter
from contextlib import closing
from email.utils import parsedate_to_datetime
import hashlib
import ipaddress
import json
import math
import re
import sqlite3
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

REQUIRED_TABLES = (
    "app_settings", "app_autosaves", "engineering_sessions", "vendor_mappings",
    "model_mappings", "mac_history", "device_inventory", "resolved_device_inventory",
    "resolved_device_identity_aliases", "resolved_device_history", "mac_movements", "vendor_model_history", "snapshots",
    "scheduled_tasks", "task_file_queue", "ip_address_mappings", "smartroom_room_mappings",
    "column_preferences", "notification_settings", "api_cache", "app_logs",
    "performance_metrics", "data_quality_reports", "snapshot_devices", "snapshot_device_index",
)
DB_SCHEMA_VERSION = 9
MAX_DEVICE_ALTERNATE_MACS = 100
MAX_DEVICE_POSSIBLE_IPS = 100
_DEVICE_SEARCH_FIELDS = (
    "mac", "macFormatted", "mac_formatted", "alternateMacs", "ip", "possibleIps", "switchIp", "switch_ip",
    "switchPort", "switch_port", "manufacturer", "vendor", "model", "macAddress", "mac_address",
    "CallingStationID", "deviceType", "hostname", "host", "host_name", "serial", "serialNumber",
    "serial_number", "smartroomId", "smartroom_id", "room", "address", "authenticationTime", "id",
    "internalDeviceId", "internal_device_id", "deviceId", "device_id", "asset_id", "deviceName",
    "device_name", "deviceIp", "device_ip", "physicalAddress", "businessUnit", "city", "site", "floor",
)
_DEVICE_SEARCH_MAC_FIELDS = (
    "mac", "macFormatted", "mac_formatted", "macAddress", "mac_address", "CallingStationID",
    "alternateMacs", "secondaryMac", "secondary_mac", "mac2", "additionalMac", "additional_mac",
)
LEGACY_ALTERNATE_MAC_FIELDS = (
    "secondaryMac", "secondary_mac", "mac2", "additionalMac", "additional_mac",
)

TABLES = (
    """CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS app_autosaves (
        slot TEXT PRIMARY KEY, state_json TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS engineering_sessions (
        token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, permissions_json TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT)""",
    """CREATE TABLE IF NOT EXISTS vendor_mappings (
        oui TEXT PRIMARY KEY, vendor TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'custom', updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS model_mappings (
        prefix TEXT PRIMARY KEY, model TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'custom', updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS mac_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT NOT NULL, mac_formatted TEXT NOT NULL,
        oui TEXT, vendor TEXT, model TEXT, ip TEXT, address TEXT, room TEXT, smartroom_id TEXT,
        switch_ip TEXT, switch_port TEXT, hostname TEXT, serial_number TEXT, device_id TEXT,
        device_name TEXT, field_sources_json TEXT, conflicts_json TEXT, source TEXT, recorded_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS device_inventory (
        mac TEXT PRIMARY KEY, mac_formatted TEXT NOT NULL, vendor TEXT, model TEXT, ip TEXT,
        address TEXT, room TEXT, smartroom_id TEXT, switch_ip TEXT, switch_port TEXT,
        hostname TEXT, serial_number TEXT, device_id TEXT, device_name TEXT,
        field_sources_json TEXT, conflicts_json TEXT, source TEXT, first_seen TEXT NOT NULL,
        updated_at TEXT NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1)""",
    """CREATE TABLE IF NOT EXISTS resolved_device_inventory (
        internal_device_id TEXT PRIMARY KEY, mac TEXT, serial_number TEXT, device_id TEXT,
        hostname TEXT, smartroom_id TEXT, room TEXT, ip TEXT, switch_ip TEXT,
        payload_json TEXT NOT NULL, first_seen TEXT NOT NULL, updated_at TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1)""",
    """CREATE TABLE IF NOT EXISTS resolved_device_identity_aliases (
        internal_device_id TEXT NOT NULL, identity_type TEXT NOT NULL, identity_value TEXT NOT NULL,
        FOREIGN KEY(internal_device_id) REFERENCES resolved_device_inventory(internal_device_id) ON DELETE CASCADE)""",
    """CREATE TABLE IF NOT EXISTS resolved_device_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, observation_key TEXT NOT NULL UNIQUE,
        internal_device_id TEXT NOT NULL, source TEXT, payload_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
        source_final_id TEXT)""",
    """CREATE TABLE IF NOT EXISTS mac_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT NOT NULL, field_name TEXT NOT NULL,
        from_value TEXT, to_value TEXT, ddio_candidate_ip TEXT, ddio_match TEXT,
        source TEXT, changed_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS vendor_model_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT NOT NULL, oui TEXT, prefix TEXT,
        vendor TEXT, model TEXT, source TEXT, observed_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT, device_count INTEGER NOT NULL,
        devices_json TEXT NOT NULL, created_at TEXT NOT NULL, signature TEXT)""",
    """CREATE TABLE IF NOT EXISTS snapshot_devices (
        snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, identity TEXT NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, ordinal))""",
    """CREATE TABLE IF NOT EXISTS snapshot_device_index (
        snapshot_id TEXT PRIMARY KEY, device_count INTEGER NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL DEFAULT '{}',
        last_run_at TEXT, next_run_at TEXT, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS task_file_queue (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, filename TEXT NOT NULL, content_base64 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', result_json TEXT, error TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, FOREIGN KEY(task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE)""",
    """CREATE TABLE IF NOT EXISTS ip_address_mappings (
        switch_ip TEXT PRIMARY KEY, physical_address TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual', updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS smartroom_room_mappings (
        smartroom_id TEXT PRIMARY KEY, room TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'auto', updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS column_preferences (
        view_name TEXT PRIMARY KEY, columns_json TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS notification_settings (
        channel TEXT PRIMARY KEY, config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS api_cache (
        cache_key TEXT PRIMARY KEY, value TEXT NOT NULL, cached_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS app_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS performance_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, duration_ms REAL NOT NULL,
        details TEXT, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS data_quality_reports (
        id TEXT PRIMARY KEY, source TEXT, score REAL NOT NULL, grade TEXT NOT NULL,
        report_json TEXT NOT NULL, created_at TEXT NOT NULL)""",
)

INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_engineering_sessions_expires ON engineering_sessions(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_mac_history_mac ON mac_history(mac)",
    "CREATE INDEX IF NOT EXISTS idx_mac_history_oui ON mac_history(oui)",
    "CREATE INDEX IF NOT EXISTS idx_mac_history_switch_ip ON mac_history(switch_ip)",
    "CREATE INDEX IF NOT EXISTS idx_mac_history_recorded_at ON mac_history(recorded_at)",
    "CREATE INDEX IF NOT EXISTS idx_mac_history_mac_recorded_at ON mac_history(mac, recorded_at DESC, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_device_inventory_updated ON device_inventory(updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_inventory_mac ON resolved_device_inventory(mac)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_inventory_serial ON resolved_device_inventory(serial_number)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_inventory_device_id ON resolved_device_inventory(device_id)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_inventory_serial_normalized ON resolved_device_inventory(lower(trim(serial_number)))",
    "CREATE INDEX IF NOT EXISTS idx_resolved_inventory_device_id_normalized ON resolved_device_inventory(lower(trim(device_id)))",
    "CREATE INDEX IF NOT EXISTS idx_resolved_inventory_mac_normalized ON resolved_device_inventory(replace(replace(replace(replace(upper(mac), ':', ''), '-', ''), '.', ''), ' ', ''))",
    "CREATE INDEX IF NOT EXISTS idx_resolved_inventory_hostname ON resolved_device_inventory(hostname)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_inventory_updated ON resolved_device_inventory(updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_identity_alias_lookup ON resolved_device_identity_aliases(identity_type, identity_value, internal_device_id)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_identity_alias_device ON resolved_device_identity_aliases(internal_device_id, identity_type)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_history_device ON resolved_device_history(internal_device_id)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_history_recorded ON resolved_device_history(recorded_at)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_history_source_final ON resolved_device_history(source_final_id, id)",
    "CREATE INDEX IF NOT EXISTS idx_resolved_history_mac ON resolved_device_history(CASE WHEN json_valid(payload_json) THEN replace(replace(replace(replace(upper(json_extract(payload_json, '$.mac')), ':', ''), '-', ''), '.', ''), ' ', '') ELSE '' END)",
    "CREATE INDEX IF NOT EXISTS idx_mac_movements_mac ON mac_movements(mac)",
    "CREATE INDEX IF NOT EXISTS idx_mac_movements_changed_at ON mac_movements(changed_at DESC, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_vendor_model_history_mac ON vendor_model_history(mac)",
    "CREATE INDEX IF NOT EXISTS idx_vendor_model_history_oui ON vendor_model_history(oui)",
    "CREATE INDEX IF NOT EXISTS idx_vendor_model_history_prefix ON vendor_model_history(prefix)",
    "CREATE INDEX IF NOT EXISTS idx_vendor_model_history_observed ON vendor_model_history(observed_at)",
    "CREATE INDEX IF NOT EXISTS idx_snapshots_signature ON snapshots(signature)",
    "CREATE INDEX IF NOT EXISTS idx_snapshot_devices_identity ON snapshot_devices(snapshot_id, identity)",
    "CREATE INDEX IF NOT EXISTS idx_task_file_queue_task ON task_file_queue(task_id)",
    "CREATE INDEX IF NOT EXISTS idx_task_file_queue_status ON task_file_queue(status)",
    "CREATE INDEX IF NOT EXISTS idx_data_quality_reports_created ON data_quality_reports(created_at)",
)

MIGRATED_COLUMNS = {
    "resolved_device_history": ("source_final_id",),
    "mac_history": ("smartroom_id", "hostname", "serial_number", "device_id", "device_name", "field_sources_json", "conflicts_json"),
    "device_inventory": ("hostname", "serial_number", "device_id", "device_name", "field_sources_json", "conflicts_json"),
    "mac_movements": ("ddio_candidate_ip", "ddio_match"),
    "snapshots": ("signature",),
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _browser_number_text(value: int | float) -> str:
    """Match JavaScript String(Number) formatting for finite JSON numbers."""
    try:
        number = float(value)
    except OverflowError:
        return ""
    if not math.isfinite(number):
        return ""
    if number == 0:
        return "0"
    negative = number < 0
    digits_source = repr(abs(number)).lower()
    if "e" in digits_source:
        mantissa, exponent_source = digits_source.split("e", 1)
        exponent = int(exponent_source)
    else:
        mantissa, exponent = digits_source, 0
    decimal_at = mantissa.index(".") if "." in mantissa else len(mantissa)
    digits = mantissa.replace(".", "")
    decimal_at += exponent
    while digits.startswith("0"):
        digits = digits[1:]
        decimal_at -= 1
    digits = digits.rstrip("0") or "0"
    scientific_exponent = decimal_at - 1
    if scientific_exponent < -6 or scientific_exponent >= 21:
        coefficient = digits[0] + (f".{digits[1:]}" if len(digits) > 1 else "")
        rendered = f"{coefficient}e{'+' if scientific_exponent >= 0 else ''}{scientific_exponent}"
    elif decimal_at <= 0:
        rendered = "0." + ("0" * -decimal_at) + digits
    elif decimal_at >= len(digits):
        rendered = digits + ("0" * (decimal_at - len(digits)))
    else:
        rendered = digits[:decimal_at] + "." + digits[decimal_at:]
    return f"-{rendered}" if negative else rendered


def _identity_text(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return ""
    raw = _browser_number_text(value) if isinstance(value, (int, float)) else value
    if not raw:
        return ""
    normalized = " ".join(str(raw).replace("\u00a0", " ").split())
    return "" if normalized.casefold() in _EMPTY_IDENTITY_VALUES else normalized


def _browser_text(value: Any) -> str:
    """Match normalize.text() for scalar Inventory merge fields."""
    if value is None:
        return ""
    if isinstance(value, bool):
        raw = "true" if value else "false"
    elif isinstance(value, (int, float)):
        raw = _browser_number_text(value)
        if not raw:
            return ""
    elif isinstance(value, str):
        raw = str(value)
    else:
        return ""
    normalized = " ".join(raw.replace("\u00a0", " ").split())
    return "" if normalized.casefold() in EMPTY_HISTORY_VALUES else normalized


def _browser_number(value: Any) -> float:
    """Match JavaScript Number() for JSON scalar confidence candidates."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        try:
            return float(value)
        except OverflowError:
            return math.inf if value >= 0 else -math.inf
    if not isinstance(value, str):
        return math.nan
    normalized = value.strip()
    if not normalized:
        return 0.0
    for prefix, base, digits in (
        ("0x", 16, r"[0-9a-fA-F]+"), ("0b", 2, r"[01]+"), ("0o", 8, r"[0-7]+"),
    ):
        if normalized[:2].lower() == prefix and re.fullmatch(digits, normalized[2:]):
            try:
                return float(int(normalized[2:], base))
            except OverflowError:
                return math.inf
    if normalized in {"Infinity", "+Infinity"}:
        return math.inf
    if normalized == "-Infinity":
        return -math.inf
    if normalized in {"NaN", "+NaN", "-NaN"}:
        return math.nan
    if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", normalized):
        return math.nan
    try:
        return float(normalized)
    except (ValueError, OverflowError):
        return math.nan


def _identity_key(value: Any) -> str:
    # Match browser keyText(): NFKC followed by locale-style Unicode lowercase.
    # Python casefold() is more aggressive (for example, it turns ß into ss)
    # and would merge IDs that remain distinct in the browser.
    return unicodedata.normalize("NFKC", _identity_text(value)).lower()


def _browser_search_projection(payload_json: Any) -> dict[str, Any]:
    """Project a stored API record to the canonical fields exposed by normalizeDevice()."""
    try:
        device = json.loads(payload_json) if isinstance(payload_json, str) else None
        if not isinstance(device, dict):
            return {}
        _, normalized = _device_api_record(device)
    except (TypeError, ValueError, RecursionError):
        return {}

    return {
        "id": next((_identity_text(device.get(key)) for key in ("id", "internalDeviceId", "internal_device_id")
                    if _identity_text(device.get(key))), ""),
        "mac": normalized.get("mac", ""),
        "alternateMacs": normalized.get("alternateMacs", []),
        "ip": normalized.get("ip", ""),
        "possibleIps": normalized.get("possibleIps", []),
        "switchIp": normalized.get("switchIp", ""),
        "switchPort": normalized.get("switchPort", ""),
        "manufacturer": normalized.get("manufacturer", ""),
        "model": normalized.get("model", ""),
        "deviceType": normalized.get("deviceType", ""),
        "hostname": normalized.get("hostname", ""),
        "serial": next((_identity_text(device.get(key)) for key in ("serial", "serialNumber", "serial_number")
                         if _identity_text(device.get(key))), ""),
        "deviceId": next((_identity_text(device.get(key)) for key in ("deviceId", "device_id", "asset_id")
                           if _identity_text(device.get(key))), ""),
        "deviceName": normalized.get("deviceName", ""),
        "smartroomId": normalized.get("smartroomId", ""),
        "room": normalized.get("room", ""),
        "address": normalized.get("address", ""),
        "authenticationTime": normalized.get("authenticationTime", ""),
        "physicalAddress": normalized.get("physicalAddress", ""),
        "businessUnit": normalized.get("businessUnit", ""),
        "city": normalized.get("city", ""),
        "site": normalized.get("site", ""),
        "floor": normalized.get("floor", ""),
        # matchesDeviceSearch() walks this explicit map as supplied by the
        # normalized Inventory row, including configured display labels.
        "customFields": device.get("customFields", {}) if isinstance(device.get("customFields"), dict) else {},
    }


def _browser_device_search(payload_json: Any, query: Any) -> int:
    """Match the browser's explicit device fields/custom columns, not arbitrary JSON metadata."""
    needle = _identity_key(query)
    if not needle:
        return 1
    device = _browser_search_projection(payload_json)
    if not device:
        return 0

    for field in _DEVICE_SEARCH_FIELDS:
        value = device.get(field)
        values = value if isinstance(value, list) else [value]
        if any(needle in _identity_key(_browser_text(item)) for item in values):
            return 1

    custom_fields = device.get("customFields")
    if isinstance(custom_fields, dict):
        for name, value in custom_fields.items():
            if needle in _identity_key(_browser_text(name)) or needle in _identity_key(_browser_text(value)):
                return 1

    # The UI additionally searches normalized MAC hex, allowing punctuation-free
    # or differently formatted MAC queries to match the browser's MAC aliases.
    raw_query = _browser_text(query)
    if raw_query and not _browser_normalize_ip(raw_query):
        normalized = _browser_normalize_mac(raw_query)
        if normalized:
            mac_needle = normalized.replace(":", "").lower()
        elif re.fullmatch(r"[0-9a-f:.-]+", raw_query, re.IGNORECASE):
            compact = re.sub(r"[^0-9a-f]", "", raw_query, flags=re.IGNORECASE).lower()
            mac_needle = compact if 6 <= len(compact) <= 12 else ""
        else:
            mac_needle = ""
        if mac_needle:
            primary_fields = ("mac",)
            mac_values: list[Any] = []
            for field in primary_fields:
                value = device.get(field)
                mac_values.extend(value if isinstance(value, list) else [value])
            mac_values.extend(device.get("alternateMacs", []))
            for item in mac_values:
                mac = _browser_normalize_mac(item)
                if mac and mac_needle in mac.replace(":", "").lower():
                    return 1
    return 0


def _browser_unique_text(values: Any) -> list[str]:
    """Match normalize.unique(values, text) for the Inventory source labels."""
    if not isinstance(values, (list, tuple)):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = _browser_text(value)
        key = _identity_key(normalized)
        if normalized and key not in seen:
            seen.add(key)
            result.append(normalized)
    return result


def _browser_conflict_key(conflict: Any) -> str:
    """Match enrichment.addDeviceConflict's conflict de-duplication contract."""
    if not isinstance(conflict, Mapping):
        return json.dumps(conflict, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    field = conflict.get("field")
    if field == "identity":
        parts = (field, conflict.get("identifier"), conflict.get("selected"), conflict.get("alternative"))
    elif field == "customField":
        parts = (field, conflict.get("key"), conflict.get("value"))
    else:
        parts = (field, conflict.get("source"), conflict.get("value"))
    return json.dumps(parts, ensure_ascii=False, separators=(",", ":"))


def _optional_timestamp(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) > 80:
        raise ValueError("Inventory timestamps must be ISO 8601 date-times with a timezone")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("Inventory timestamps must be valid ISO 8601 date-times") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Inventory timestamps must include a timezone")
    return parsed.astimezone(timezone.utc)


def _browser_normalize_date(value: Any) -> str:
    """Normalize the explicit date formats supported by src/core/normalize.js."""
    if isinstance(value, bool) or value is None or not isinstance(value, (str, int, float)):
        return ""
    if isinstance(value, float) and not math.isfinite(value):
        return ""
    normalized = _browser_text(value)
    if not normalized:
        return ""
    canonical = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z", normalized)
    if canonical:
        try:
            datetime(*(int(part) for part in canonical.groups()[:6]), int(canonical.group(7)) * 1000)
        except ValueError:
            return ""
        return normalized
    serial_text = normalized if isinstance(value, str) else ""
    if isinstance(value, (int, float)) or re.fullmatch(r"\d+(?:\.\d+)?", serial_text):
        try:
            serial = float(value if isinstance(value, (int, float)) else serial_text)
        except (TypeError, ValueError, OverflowError):
            serial = math.nan
        if math.isfinite(serial) and 1 <= serial <= 2_958_465:
            instant = datetime(1899, 12, 30, tzinfo=timezone.utc) + timedelta(milliseconds=int(serial * 86_400_000))
            return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    day_first = re.fullmatch(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?", normalized)
    if day_first:
        day, month, year, hour, minute, second = day_first.groups()
        try:
            instant = datetime(int(year), int(month), int(day), int(hour or 0), int(minute or 0), int(second or 0), tzinfo=timezone.utc)
        except ValueError:
            return ""
        return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    unzoned = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?", normalized)
    if unzoned:
        year, month, day, hour, minute, second, fraction = unzoned.groups()
        try:
            instant = datetime(
                int(year), int(month), int(day), int(hour), int(minute), int(second or 0),
                int((fraction or "").ljust(3, "0")) * 1000, tzinfo=timezone.utc,
            )
        except ValueError:
            return ""
        return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    iso_date = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", normalized)
    if iso_date:
        try:
            instant = datetime(*(int(part) for part in iso_date.groups()), tzinfo=timezone.utc)
        except ValueError:
            return ""
        return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    year_first_local_date = re.fullmatch(r"(\d{4})[/.](\d{1,2})[/.](\d{1,2})", normalized)
    if year_first_local_date:
        year, month, day = (int(part) for part in year_first_local_date.groups())
        if not 1 <= month <= 12 or not 1 <= day <= 31:
            return ""
        try:
            # Date.parse treats slash/dot year-first dates as local dates and
            # rolls valid 1..31 day numbers through the month's end.
            local_date = datetime(year, month, 1) + timedelta(days=day - 1)
            instant = local_date.astimezone(timezone.utc)
        except (OverflowError, ValueError):
            return ""
        return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
        try:
            parsed = parsedate_to_datetime(normalized)
        except (TypeError, ValueError, OverflowError):
            for date_format in ("%b %d, %Y", "%B %d, %Y", "%b %d %Y", "%B %d %Y"):
                try:
                    parsed = datetime.strptime(normalized, date_format)
                    break
                except ValueError:
                    continue
        if parsed is None:
            return ""
    if parsed.tzinfo is None:
        # The browser's Date parser interprets accepted non-ISO strings in the
        # local timezone, so the same-computer host must use that offset too.
        parsed = parsed.astimezone()
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _browser_parse_location_path(value: Any) -> dict[str, str] | None:
    if value is None or isinstance(value, (dict, list, bool)):
        return None
    parts = [_browser_text(part) for part in str(value).split(",")]
    if len(parts) < 5:
        return None
    return {
        "businessUnit": parts[0], "city": parts[1], "site": parts[2], "floor": parts[3],
        "room": parts[4], "address": ", ".join(parts[5:]),
    }


def _stored_optional_timestamp(value: Any) -> datetime | None:
    """Read legacy stored timestamps without letting malformed old data block additive writes."""
    try:
        return _optional_timestamp(value)
    except ValueError:
        return None


def _normalized_identity(device: Mapping[str, Any]) -> str:
    internal = _identity_text(device.get("id")) or _identity_text(device.get("internalDeviceId")) or _identity_text(device.get("internal_device_id"))
    if internal:
        return internal
    mac = next((_mac_identity_token(device.get(key)) for key in (
        "mac", "macAddress", "mac_address", "macFormatted", "mac_formatted", "CallingStationID",
    ) if _canonical_mac(device.get(key))), "")
    serial = _identity_key(device.get("serial")) or _identity_key(device.get("serialNumber")) or _identity_key(device.get("serial_number"))
    device_id = _identity_key(device.get("deviceId")) or _identity_key(device.get("device_id")) or _identity_key(device.get("asset_id"))
    if device_id:
        strongest = "deviceId:" + device_id
    elif serial:
        strongest = "serial:" + serial
    elif mac:
        strongest = "mac:" + mac
    else:
        alternate_identity = next((_mac_identity_token(value) for value in _device_alternate_mac_values(device)), "")
        strongest = "alternateMac:" + alternate_identity if alternate_identity else ""
    if not strongest:
        return ""
    # Match src/core/identity.js stableId(): FNV-1a 64-bit over UTF-16 code units.
    hash_value = 0xCBF29CE484222325
    encoded = f"device:{strongest}".encode("utf-16-le", errors="surrogatepass")
    for offset in range(0, len(encoded), 2):
        hash_value ^= int.from_bytes(encoded[offset:offset + 2], "little")
        hash_value = (hash_value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"device-{hash_value:016x}"


def _canonical_mac(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    raw_mac = value.upper()
    match = re.search(
        r"(?<![0-9A-F])((?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}|(?:[0-9A-F]{4}\.){2}[0-9A-F]{4}|[0-9A-F]{12})(?![0-9A-F])",
        raw_mac,
    )
    mac = "".join(ch for ch in (match.group(1) if match else raw_mac) if ch in "0123456789ABCDEF")
    if len(mac) in {8, 10, 11}:
        mac = mac.zfill(12)
    return mac if len(mac) == 12 and mac not in {"000000000000", "FFFFFFFFFFFF"} else ""


def _browser_normalize_mac(value: Any) -> str:
    """Match normalizeMac() for API alternate-MAC payloads, including rejection of embedded text."""
    raw = _browser_text(value)
    if not raw:
        return ""
    candidate = re.search(
        r"(?<![0-9a-f])((?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})(?![0-9a-f])|"
        r"(?<![0-9a-f])((?:[0-9a-f]{2}\s+){5}[0-9a-f]{2})(?![0-9a-f])|"
        r"(?<![0-9a-f])([0-9a-f]{4}(?:\s+[0-9a-f]{4}){2})(?![0-9a-f])|"
        r"(?<![0-9a-f])([0-9a-f]{4}(?:\.[0-9a-f]{4}){2})(?![0-9a-f])|"
        r"(?<![0-9a-f])([0-9a-f]{12})(?![0-9a-f])",
        raw,
        flags=re.IGNORECASE,
    )
    value_text = candidate.group(0) if candidate else raw if re.fullmatch(r"(?:[0-9a-f]{8}|[0-9a-f]{10,12})", raw, re.IGNORECASE) else ""
    hexadecimal = re.sub(r"[^0-9a-f]", "", value_text, flags=re.IGNORECASE)
    if len(hexadecimal) in {8, 10, 11}:
        hexadecimal = hexadecimal.zfill(12)
    if len(hexadecimal) != 12 or hexadecimal.lower() in {"000000000000", "ffffffffffff"}:
        return ""
    return ":".join(hexadecimal[index:index + 2].upper() for index in range(0, 12, 2))


def _browser_normalize_mac_field(value: Any) -> str:
    """Match normalizeMacField(), which preserves displayable zero/broadcast values."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return ""
    if isinstance(value, float) and not math.isfinite(value):
        return ""
    raw = _browser_number_text(value) if isinstance(value, (int, float)) else value
    compact = re.sub(r"[^0-9A-F]", "", raw.strip().upper())
    if len(compact) in {8, 10, 11}:
        compact = compact.zfill(12)
    if not re.fullmatch(r"[0-9A-F]{12}", compact):
        return ""
    return ":".join(compact[index:index + 2] for index in range(0, 12, 2))


def _browser_normalize_ip(value: Any) -> str:
    """Match src/core/normalize.js normalizeIp() for resolved Inventory evidence."""
    raw = _browser_text(value)
    if not raw:
        return ""
    bracketed = raw.startswith("[") and raw.endswith("]")
    if (raw.startswith("[") or raw.endswith("]")) and not bracketed:
        return ""
    source = raw[1:-1] if bracketed else raw
    mac_shaped = bool(re.fullmatch(
        r"(?:(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}|(?:[0-9a-f]{2}\s+){5}[0-9a-f]{2}|"
        r"[0-9a-f]{4}(?:\s+[0-9a-f]{4}){2}|[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}|"
        r"[0-9a-f]{12}|(?:[0-9a-f]{8}|[0-9a-f]{10,12}))",
        source,
        flags=re.IGNORECASE,
    ))
    if not source or (mac_shaped and _canonical_mac(source)):
        return ""
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", source):
        octets = [int(part) for part in source.split(".")]
        return ".".join(str(octet) for octet in octets) if all(octet <= 255 for octet in octets) else ""
    if not re.fullmatch(r"[0-9a-f:.]+", source, flags=re.IGNORECASE) or ":" not in source:
        return ""
    if "." in source:
        separator = source.rfind(":")
        ipv4 = _browser_normalize_ip(source[separator + 1:]) if separator >= 0 else ""
        if not ipv4:
            return ""
        a, b, c, d = (int(part) for part in ipv4.split("."))
        source = f"{source[:separator + 1]}{((a << 8) | b):x}:{((c << 8) | d):x}"
    try:
        address = ipaddress.IPv6Address(source)
    except ipaddress.AddressValueError:
        return ""
    groups = [(int(address) >> (112 - 16 * index)) & 0xFFFF for index in range(8)]
    best_start = -1
    best_length = 1
    index = 0
    while index < len(groups):
        if groups[index] != 0:
            index += 1
            continue
        end = index + 1
        while end < len(groups) and groups[end] == 0:
            end += 1
        if end - index > best_length:
            best_start = index
            best_length = end - index
        index = end
    if best_start < 0:
        return ":".join(f"{group:x}" for group in groups)
    before = ":".join(f"{group:x}" for group in groups[:best_start])
    after = ":".join(f"{group:x}" for group in groups[best_start + best_length:])
    return f"{before}::{after}"


def _mac_identity_token(value: Any) -> str:
    mac = _canonical_mac(value)
    return ":".join(mac[offset:offset + 2] for offset in range(0, 12, 2)) if mac else ""


def _primary_mac_identity(device: Mapping[str, Any]) -> str:
    return next((_canonical_mac(device.get(key)) for key in (
        "mac", "macAddress", "mac_address", "macFormatted", "mac_formatted", "CallingStationID",
    )
                 if _canonical_mac(device.get(key))), "")


def _device_alternate_mac_values(device: Mapping[str, Any]) -> list[str]:
    values: list[str] = []
    alternates = device.get("alternateMacs")
    if isinstance(alternates, list):
        values.extend(value for value in alternates if isinstance(value, str))
    elif isinstance(alternates, str):
        values.extend(alternates.split(","))
    values.extend(
        value for key in LEGACY_ALTERNATE_MAC_FIELDS
        if isinstance((value := device.get(key)), str)
    )
    primary = _primary_mac_identity(device)
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        mac = _canonical_mac(value)
        if mac and mac != primary and mac not in seen:
            seen.add(mac)
            normalized.append(value)
    return normalized


def _strong_identity_aliases(device: Mapping[str, Any]) -> set[tuple[str, str]]:
    aliases: set[tuple[str, str]] = set()
    for key in ("id", "internalDeviceId", "internal_device_id"):
        internal = _identity_text(device.get(key))
        if internal:
            aliases.add(("internal", internal))
            aliases.add(("id", _identity_key(internal)))
    for key in ("deviceId", "device_id", "asset_id"):
        device_id = _identity_key(device.get(key))
        if device_id:
            aliases.add(("device", device_id))
    for key in ("serial", "serialNumber", "serial_number"):
        serial = _identity_key(device.get(key))
        if serial:
            aliases.add(("serial", serial))
    for key in ("mac", "macAddress", "mac_address", "macFormatted", "mac_formatted", "CallingStationID"):
        mac = _canonical_mac(device.get(key))
        if mac:
            aliases.add(("mac", mac))
    alternate_macs = device.get("alternateMacs")
    if alternate_macs is not None:
        if not isinstance(alternate_macs, list) or any(not isinstance(value, str) for value in alternate_macs):
            raise ValueError("alternateMacs must be an array of text values")
        if len(alternate_macs) > MAX_DEVICE_ALTERNATE_MACS:
            raise ValueError(f"alternateMacs must contain at most {MAX_DEVICE_ALTERNATE_MACS} values")
    aliases.update(("mac", mac) for value in _device_alternate_mac_values(device) if (mac := _canonical_mac(value)))
    return aliases


def _identity_alias_conflicts(device: Mapping[str, Any]) -> list[dict[str, str]]:
    conflicts = []
    for identifier, aliases, normalize in (
        ("id", ("id", "internalDeviceId", "internal_device_id"), _identity_text),
        ("deviceId", ("deviceId", "device_id", "asset_id"), _identity_text),
        ("serial", ("serial", "serialNumber", "serial_number"), _identity_text),
        ("mac", ("mac", "macAddress", "mac_address", "macFormatted", "mac_formatted", "CallingStationID"), _browser_normalize_mac),
    ):
        values = []
        for alias in aliases:
            normalized = normalize(device.get(alias))
            if normalized and not any(_identity_key(normalized) == _identity_key(value[1]) for value in values):
                values.append((alias, normalized))
        for alias, alternative in values[1:]:
            conflicts.append({
                "field": "identity", "identifier": identifier, "selected": values[0][1],
                "alternative": alternative, "source": _identity_text(device.get("source")) or "Импорт",
                "reason": f"Конфликтующие алиасы сильного идентификатора ({values[0][0]} / {alias})",
            })
    return conflicts


def _merge_identity_alias_diagnostics(device: dict[str, Any]) -> None:
    existing = device.get("conflicts") if isinstance(device.get("conflicts"), list) else []
    combined = [*existing, *_identity_alias_conflicts(device)]
    unique = []
    signatures = set()
    for conflict in combined:
        signature = json.dumps(conflict, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if signature not in signatures:
            signatures.add(signature)
            unique.append(conflict)
    if unique:
        device["conflicts"] = unique[:MAX_DEVICE_CONFLICTS]
    device["conflictsTruncated"] = bool(
        device.get("conflictsTruncated") or len(unique) > MAX_DEVICE_CONFLICTS
    )


def _ensure_columns(connection: sqlite3.Connection) -> None:
    for table, columns in MIGRATED_COLUMNS.items():
        existing = {str(row[1]) for row in connection.execute(f'PRAGMA table_info("{table}")')}
        for column in columns:
            if column not in existing:
                connection.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" TEXT')


def _backfill_resolved_history_sources(connection: sqlite3.Connection) -> None:
    cursor = connection.execute(
        "SELECT id, payload_json FROM resolved_device_history WHERE source_final_id IS NULL ORDER BY id"
    )
    while rows := cursor.fetchmany(500):
        updates = []
        for row_id, raw_payload in rows:
            try:
                payload = json.loads(raw_payload)
            except (TypeError, ValueError):
                continue
            source_final_id = payload.get("sourceFinalId") if isinstance(payload, dict) else None
            if isinstance(source_final_id, str) and source_final_id.strip() and len(source_final_id) <= 200:
                updates.append((source_final_id.strip(), int(row_id)))
        if updates:
            connection.executemany(
                "UPDATE resolved_device_history SET source_final_id = ? WHERE id = ? AND source_final_id IS NULL",
                updates,
            )


def _backfill_snapshot_devices(connection: sqlite3.Connection) -> None:
    """Add bounded indexed pages while keeping legacy snapshots.devices_json intact."""
    snapshots = connection.execute(
        "SELECT id, device_count, "
        "CASE WHEN json_valid(devices_json) THEN json_type(devices_json) ELSE '' END AS json_type, "
        "CASE WHEN json_valid(devices_json) THEN json_array_length(devices_json) ELSE -1 END AS actual_count "
        "FROM snapshots ORDER BY id"
    )
    for snapshot_id, expected_count, json_type, actual_count in snapshots:
        connection.execute("DELETE FROM snapshot_device_index WHERE snapshot_id = ?", (snapshot_id,))
        if json_type != "array" or int(actual_count) != int(expected_count):
            continue
        indexed_count = int(connection.execute(
            "SELECT COUNT(*) FROM snapshot_devices WHERE snapshot_id = ?", (snapshot_id,),
        ).fetchone()[0])
        if indexed_count == int(expected_count):
            connection.execute(
                "INSERT INTO snapshot_device_index (snapshot_id, device_count) VALUES (?, ?)",
                (snapshot_id, int(expected_count)),
            )
            continue
        connection.execute("SAVEPOINT backfill_snapshot_devices")
        try:
            connection.execute("DELETE FROM snapshot_devices WHERE snapshot_id = ?", (snapshot_id,))
            cursor = connection.execute(
                "SELECT CAST(item.key AS INTEGER), item.value FROM snapshots AS snapshot, "
                "json_each(snapshot.devices_json) AS item WHERE snapshot.id = ? "
                "ORDER BY CAST(item.key AS INTEGER)",
                (snapshot_id,),
            )
            inserted = 0
            while rows := cursor.fetchmany(250):
                prepared = []
                for ordinal, payload_json in rows:
                    try:
                        device = json.loads(payload_json)
                    except (TypeError, ValueError, RecursionError):
                        raise ValueError("Legacy snapshot contains invalid device JSON")
                    if not isinstance(device, dict):
                        raise ValueError("Legacy snapshot devices must be JSON objects")
                    identity = _normalized_identity(device)
                    if not identity:
                        identity = f"legacy-ordinal:{int(ordinal)}"
                    prepared.append((snapshot_id, int(ordinal), identity, payload_json))
                connection.executemany(
                    "INSERT INTO snapshot_devices (snapshot_id, ordinal, identity, payload_json) VALUES (?, ?, ?, ?)",
                    prepared,
                )
                inserted += len(prepared)
            if inserted != int(expected_count):
                raise ValueError("Legacy snapshot device count changed during migration")
            connection.execute(
                "INSERT INTO snapshot_device_index (snapshot_id, device_count) VALUES (?, ?)",
                (snapshot_id, inserted),
            )
            connection.execute("RELEASE SAVEPOINT backfill_snapshot_devices")
        except (sqlite3.Error, ValueError):
            connection.execute("ROLLBACK TO SAVEPOINT backfill_snapshot_devices")
            connection.execute("RELEASE SAVEPOINT backfill_snapshot_devices")


def _needs_migration(connection: sqlite3.Connection) -> bool:
    if int(connection.execute("PRAGMA user_version").fetchone()[0]) < DB_SCHEMA_VERSION:
        return True
    tables = {str(row[0]) for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )}
    if set(REQUIRED_TABLES) - tables:
        return True
    for table, columns in MIGRATED_COLUMNS.items():
        existing = {str(row[1]) for row in connection.execute(f'PRAGMA table_info("{table}")')}
        if set(columns) - existing:
            return True
    existing_indexes = {str(row[0]) for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='index'"
    )}
    expected_indexes = {statement.split("IF NOT EXISTS ", 1)[1].split(" ", 1)[0] for statement in INDEXES}
    if expected_indexes - existing_indexes:
        return True

    inventory_count = int(connection.execute("SELECT COUNT(*) FROM device_inventory").fetchone()[0])
    history_count = int(connection.execute("SELECT COUNT(*) FROM mac_history").fetchone()[0])
    if not inventory_count and history_count:
        return True
    return False


def _backfill_inventory(connection: sqlite3.Connection) -> None:
    if connection.execute("SELECT 1 FROM device_inventory LIMIT 1").fetchone():
        return
    connection.execute("""
        INSERT OR IGNORE INTO device_inventory
            (mac, mac_formatted, vendor, model, ip, address, room, smartroom_id, switch_ip, switch_port,
             hostname, serial_number, device_id, device_name, field_sources_json, conflicts_json, source,
             first_seen, updated_at, seen_count)
        SELECT history.mac, history.mac_formatted, history.vendor, history.model, history.ip, history.address,
               history.room, history.smartroom_id, history.switch_ip, history.switch_port, history.hostname,
               history.serial_number, history.device_id, history.device_name, history.field_sources_json,
               history.conflicts_json, history.source, grouped.first_seen, history.recorded_at, grouped.seen_count
        FROM mac_history AS history
        JOIN (SELECT mac, MAX(id) AS latest_id, MIN(recorded_at) AS first_seen, COUNT(*) AS seen_count
              FROM mac_history GROUP BY mac) AS grouped ON grouped.latest_id = history.id
    """)


def _strong_identity_conflicts(existing: Mapping[str, Any], incoming: Mapping[str, Any]) -> list[dict[str, str]]:
    conflicts = []
    for field, column, key in (("serialNumber", "serial_number", "serialNumber"), ("deviceId", "device_id", "deviceId")):
        previous = str(existing[column] or "").strip()
        current = str(incoming.get(key) or "").strip()
        previous_key = _identity_key(previous)
        current_key = _identity_key(current)
        if previous_key and current_key and previous_key != current_key:
            conflicts.append({"field": field, "existingValue": previous, "incomingValue": current})
    try:
        payload = json.loads(existing["payload_json"])
    except (KeyError, TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    existing_device = {
        **payload,
        "mac": existing["mac"] or payload.get("mac"),
        "alternateMacs": payload.get("alternateMacs", []),
    }
    existing_primary = _primary_mac_identity(existing_device)
    incoming_primary = _primary_mac_identity(incoming)
    existing_macs = _mac_aliases(existing_device)
    incoming_macs = _mac_aliases(incoming)
    primary_conflict = bool(existing_primary and incoming_primary and existing_primary != incoming_primary)
    fallback_conflict = bool(
        (not existing_primary or not incoming_primary)
        and existing_macs and incoming_macs and existing_macs.isdisjoint(incoming_macs)
    )
    if primary_conflict or fallback_conflict:
        conflicts.append({
            "field": "mac",
            "existingValue": existing_primary if primary_conflict else sorted(existing_macs)[0],
            "incomingValue": incoming_primary if primary_conflict else sorted(incoming_macs)[0],
        })
    return conflicts


def _mac_aliases(device: Mapping[str, Any]) -> set[str]:
    values = [
        device.get("mac"), device.get("macAddress"), device.get("mac_address"),
        device.get("macFormatted"), device.get("mac_formatted"), device.get("CallingStationID"),
    ]
    alternates = device.get("alternateMacs") or []
    if isinstance(alternates, list):
        values.extend(alternates)
    return {mac for value in values if (mac := _canonical_mac(value))}


def _identity_match_fields(incoming: Mapping[str, Any], candidate: Mapping[str, Any], *, include_incoming_id: bool) -> dict[str, tuple[int, set[str]]]:
    def values(device: Mapping[str, Any], keys: tuple[str, ...]) -> set[str]:
        return {key for value in (device.get(name) for name in keys) if (key := _identity_key(value))}

    incoming_ids = values(incoming, ("id", "internalDeviceId", "internal_device_id")) if include_incoming_id else set()
    candidate_ids = values(candidate, ("id", "internalDeviceId", "internal_device_id"))
    incoming_device_ids = values(incoming, ("deviceId", "device_id", "asset_id"))
    candidate_device_ids = values(candidate, ("deviceId", "device_id", "asset_id"))
    incoming_serials = values(incoming, ("serial", "serialNumber", "serial_number"))
    candidate_serials = values(candidate, ("serial", "serialNumber", "serial_number"))
    matches: dict[str, tuple[int, set[str]]] = {}
    for field, priority, left, right in (
        ("id", 0, incoming_ids, candidate_ids),
        ("deviceId", 1, incoming_device_ids, candidate_device_ids),
        ("serialNumber", 2, incoming_serials, candidate_serials),
    ):
        shared = left & right
        if shared:
            matches[field] = (priority, shared)

    incoming_primary = _primary_mac_identity(incoming)
    candidate_primary = _primary_mac_identity(candidate)
    candidate_macs = _mac_aliases(candidate)
    incoming_primary_match = {incoming_primary} & candidate_macs if incoming_primary else set()
    if incoming_primary_match:
        priority = 3 if incoming_primary == candidate_primary else 4
        matches["mac"] = (priority, incoming_primary_match)
    incoming_macs = _mac_aliases(incoming)
    incoming_alternates = incoming_macs - ({incoming_primary} if incoming_primary else set())
    shared_alternates = incoming_alternates & candidate_macs
    if shared_alternates:
        matches["alternateMacs"] = (4, shared_alternates)
    return matches


def _row_identity_device(row: Mapping[str, Any]) -> dict[str, Any]:
    try:
        payload = json.loads(row["payload_json"])
    except (KeyError, TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    payload.setdefault("internalDeviceId", row["internal_device_id"])
    for payload_key, row_key in (("mac", "mac"), ("serialNumber", "serial_number"), ("deviceId", "device_id")):
        if not payload.get(payload_key):
            payload[payload_key] = row[row_key] or ""
    return payload


def _without_contested_identity_fields(record: Mapping[str, Any], contested: Mapping[str, set[str]]) -> dict[str, Any]:
    result = dict(record)
    field_aliases = {
        "id": ("id", "internalDeviceId", "internal_device_id"),
        "deviceId": ("deviceId", "device_id", "asset_id"),
        "serialNumber": ("serial", "serialNumber", "serial_number"),
        "mac": ("mac", "macAddress", "mac_address", "macFormatted", "mac_formatted", "CallingStationID"),
    }
    for field, values_by_field in contested.items():
        if field in field_aliases:
            for alias in field_aliases[field]:
                if _identity_key(result.get(alias)) in values_by_field or (
                    field == "mac" and _canonical_mac(result.get(alias)) in values_by_field
                ):
                    result[alias] = ""
        if field in {"mac", "alternateMacs"}:
            mac_values = set(values_by_field)
            aliases = result.get("alternateMacs")
            if isinstance(aliases, list):
                result["alternateMacs"] = [value for value in aliases if _canonical_mac(value) not in mac_values]
            elif isinstance(aliases, str):
                result["alternateMacs"] = [value for value in aliases.split(",") if _canonical_mac(value) not in mac_values]
    return result


def _prepare_priority_safe_merge(
    existing: Mapping[str, Any], incoming: Mapping[str, Any], *, include_incoming_id: bool,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Keep a unique stronger match while quarantining contradictory weaker fields."""
    mismatches = _strong_identity_conflicts(existing, incoming)
    if not mismatches:
        return dict(incoming), None
    existing_device = _row_identity_device(existing)
    matches = _identity_match_fields(incoming, existing_device, include_incoming_id=include_incoming_id)
    selected_priority = min((item[0] for item in matches.values()), default=None)
    field_priority = {"deviceId": 1, "serialNumber": 2, "mac": 3}
    if selected_priority is None or any(
        field_priority.get(item["field"], 0) <= selected_priority for item in mismatches
    ):
        return None, None

    contested: dict[str, set[str]] = {}
    for mismatch in mismatches:
        field = mismatch["field"]
        value = mismatch["incomingValue"]
        normalized = _canonical_mac(value) if field == "mac" else _identity_key(value)
        if normalized:
            contested.setdefault(field, set()).add(normalized)
    safe_record = _without_contested_identity_fields(incoming, contested)
    source = _identity_text(incoming.get("source")) or "Импорт"
    for mismatch in mismatches:
        field = mismatch["field"]
        if field == "mac":
            alternate = _mac_identity_token(mismatch["incomingValue"])
            alternates = safe_record.get("alternateMacs")
            if not isinstance(alternates, list):
                alternates = []
            if alternate and not any(_canonical_mac(value) == _canonical_mac(alternate) for value in alternates):
                alternates.append(alternate)
            safe_record["alternateMacs"] = alternates
            continue
        conflict_field = "serial" if field == "serialNumber" else "deviceId"
        safe_record.setdefault("conflicts", []).append({
            "field": conflict_field,
            "selected": mismatch["existingValue"],
            "value": mismatch["incomingValue"],
            "source": source,
        })
    _merge_identity_alias_diagnostics(safe_record)
    return safe_record, {
        "internalDeviceId": str(existing["internal_device_id"]),
        "reason": "conflicting_strong_identity",
        "selectedInternalDeviceId": str(existing["internal_device_id"]),
        "candidateInternalDeviceIds": [str(existing["internal_device_id"])],
        "selectedPriority": selected_priority,
        "contestedFields": sorted({item["field"] for item in mismatches}),
        "fields": mismatches,
        "resolvedByPriority": True,
    }


def _shared_strong_identity_rows(connection: sqlite3.Connection, device: Mapping[str, Any]):
    aliases = _strong_identity_aliases(device)
    if not aliases:
        return ()
    clauses = []
    params: list[str] = []
    for identity_type, column in (("device", "device_id"), ("serial", "serial_number")):
        value = next((token for token_type, token in aliases if token_type == identity_type), "")
        if value:
            clauses.append(f'lower(trim("{column}")) = ?')
            params.append(value)
    mac = next((token for token_type, token in aliases if token_type == "mac"), "")
    if mac:
        clauses.append("replace(replace(replace(replace(upper(mac), ':', ''), '-', ''), '.', ''), ' ', '') = ?")
        params.append(mac)
    for identity_type, identity_value in sorted(aliases):
        clauses.append(
            "EXISTS (SELECT 1 FROM resolved_device_identity_aliases AS alias "
            "WHERE alias.internal_device_id = resolved_device_inventory.internal_device_id "
            "AND alias.identity_type = ? AND alias.identity_value = ?)"
        )
        params.extend((identity_type, identity_value))
    query = "SELECT * FROM resolved_device_inventory WHERE " + " OR ".join(clauses)
    return connection.execute(query, params)


def _save_identity_aliases(connection: sqlite3.Connection, internal_id: str, device: Mapping[str, Any]) -> None:
    connection.executemany(
        "INSERT OR IGNORE INTO resolved_device_identity_aliases "
        "(internal_device_id, identity_type, identity_value) VALUES (?, ?, ?)",
        ((internal_id, identity_type, identity_value)
         for identity_type, identity_value in _strong_identity_aliases({**device, "internalDeviceId": internal_id})),
    )


def _backfill_identity_aliases(connection: sqlite3.Connection) -> None:
    cursor = connection.execute(
        "SELECT internal_device_id, mac, serial_number, device_id, payload_json FROM resolved_device_inventory "
        "ORDER BY internal_device_id"
    )
    while rows := cursor.fetchmany(500):
        for row in rows:
            try:
                payload = json.loads(row["payload_json"])
            except (TypeError, ValueError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            payload.setdefault("internalDeviceId", row["internal_device_id"])
            if not payload.get("mac"):
                payload["mac"] = row["mac"] or ""
            if not payload.get("serialNumber"):
                payload["serialNumber"] = row["serial_number"] or ""
            if not payload.get("deviceId"):
                payload["deviceId"] = row["device_id"] or ""
            _save_identity_aliases(connection, str(row["internal_device_id"]), payload)
            original = str(row["payload_json"] or "")
            _merge_identity_alias_diagnostics(payload)
            serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            if serialized != original and len(serialized.encode("utf-8")) <= MAX_DEVICE_RECORD_BYTES:
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (serialized, row["internal_device_id"]),
                )


def _backfill_resolved_inventory(connection: sqlite3.Connection) -> None:
    rows = connection.execute("SELECT * FROM device_inventory ORDER BY mac")
    for row in rows:
        legacy = dict(row)
        device = {
            "mac": legacy.get("mac") or "", "macFormatted": legacy.get("mac_formatted") or "",
            "vendor": legacy.get("vendor") or "", "model": legacy.get("model") or "",
            "ip": legacy.get("ip") or "", "address": legacy.get("address") or "",
            "room": legacy.get("room") or "", "smartroomId": legacy.get("smartroom_id") or "",
            "switchIp": legacy.get("switch_ip") or "", "switchPort": legacy.get("switch_port") or "",
            "hostname": legacy.get("hostname") or "", "serialNumber": legacy.get("serial_number") or "",
            "deviceId": legacy.get("device_id") or "", "deviceName": legacy.get("device_name") or "",
            "source": legacy.get("source") or "",
        }
        internal_id = _normalized_identity(device)
        if not internal_id:
            continue
        existing = connection.execute(
            "SELECT * FROM resolved_device_inventory WHERE internal_device_id = ?", (internal_id,)
        ).fetchone()
        if existing:
            conflicts = _strong_identity_conflicts(existing, device)
            if conflicts:
                identity_material = json.dumps(
                    [internal_id, device["mac"], device["serialNumber"], device["deviceId"]],
                    ensure_ascii=False, separators=(",", ":"),
                )
                internal_id = "dev-conflict-" + hashlib.sha256(identity_material.encode("utf-8")).hexdigest()
                device["identityConflicts"] = conflicts
                device["conflicts"] = [{**item, "reason": "conflicting_strong_identity"} for item in conflicts]
                if connection.execute(
                    "SELECT 1 FROM resolved_device_inventory WHERE internal_device_id = ?", (internal_id,)
                ).fetchone():
                    continue
            else:
                _merge_resolved_inventory_blanks(connection, existing, device)
                _save_identity_aliases(connection, str(existing["internal_device_id"]), device)
                continue
        else:
            matches = []
            related_conflicts = []
            match_count = 0
            conflict_count = 0
            for candidate in _shared_strong_identity_rows(connection, device):
                conflicts = _strong_identity_conflicts(candidate, device)
                if conflicts:
                    for conflict in conflicts:
                        conflict_count += 1
                        if len(related_conflicts) < 20:
                            related_conflicts.append({
                                **conflict,
                                "candidateInternalDeviceId": str(candidate["internal_device_id"]),
                            })
                else:
                    match_count += 1
                    if len(matches) < 2:
                        matches.append(candidate)
            if related_conflicts or match_count > 1:
                device["identityConflicts"] = related_conflicts or [{
                    "field": "identity", "reason": "multiple_strong_matches",
                    "candidateInternalDeviceIds": [str(item["internal_device_id"]) for item in matches],
                    "candidateCount": match_count,
                }]
                if conflict_count > len(related_conflicts) or match_count > 2:
                    device["identityConflictsTruncated"] = True
                    device["identityConflictsCount"] = conflict_count or match_count
                device["conflicts"] = [{**item, "reason": "conflicting_strong_identity"}
                                        for item in device["identityConflicts"]]
                identity_material = json.dumps(
                    [internal_id, device["mac"], device["serialNumber"], device["deviceId"],
                     device["identityConflicts"]], ensure_ascii=False, separators=(",", ":"),
                )
                internal_id = "dev-conflict-" + hashlib.sha256(identity_material.encode("utf-8")).hexdigest()
            elif match_count == 1:
                _merge_resolved_inventory_blanks(connection, matches[0], device)
                _save_identity_aliases(connection, str(matches[0]["internal_device_id"]), device)
                continue
            if internal_id.startswith("dev-conflict-") and connection.execute(
                "SELECT 1 FROM resolved_device_inventory WHERE internal_device_id = ?", (internal_id,)
            ).fetchone():
                continue
        device["internalDeviceId"] = internal_id
        now = _now()
        connection.execute(
            "INSERT OR IGNORE INTO resolved_device_inventory "
            "(internal_device_id, mac, serial_number, device_id, hostname, smartroom_id, room, ip, switch_ip, "
            "payload_json, first_seen, updated_at, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (internal_id, device["mac"], device.get("serial") or device["serialNumber"], device["deviceId"], device["hostname"],
             device["smartroomId"], device["room"], device["ip"], device["switchIp"],
             json.dumps(device, ensure_ascii=False, separators=(",", ":")),
             legacy.get("first_seen") or legacy.get("updated_at") or now,
             legacy.get("updated_at") or now, int(legacy.get("seen_count") or 1)),
        )
        _save_identity_aliases(connection, internal_id, device)


def _merge_resolved_inventory_blanks(
    connection: sqlite3.Connection, existing: sqlite3.Row, incoming: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """Fill missing legacy fields without replacing any known resolved value."""
    column_values = {
        "mac": incoming.get("mac"), "serial_number": incoming.get("serial") or incoming.get("serialNumber"),
        "device_id": incoming.get("deviceId"), "hostname": incoming.get("hostname"),
        "smartroom_id": incoming.get("smartroomId"), "room": incoming.get("room"),
        "ip": incoming.get("ip"), "switch_ip": incoming.get("switchIp"),
    }
    updates = {column: value for column, value in column_values.items()
               if value and not str(existing[column] or "").strip()}

    payload_raw = str(existing["payload_json"] or "")
    try:
        payload = json.loads(payload_raw)
    except (TypeError, ValueError):
        payload = None
    new_conflicts: list[dict[str, Any]] = []
    if isinstance(payload, dict):
        def location_inference(source: Mapping[str, Any]) -> tuple[str, dict[str, str] | None]:
            for path_field in ("locationPath", "location", "room", "address"):
                if _identity_text(source.get(path_field)):
                    inferred = _browser_parse_location_path(source.get(path_field))
                    if inferred is not None:
                        return path_field, inferred
            return "", None

        def canonical_field_value(source: Mapping[str, Any], field: str) -> str:
            if field in {"businessUnit", "city", "site", "floor", "room", "address"}:
                source_field, inferred = location_inference(source)
                if inferred is not None:
                    if field in {"businessUnit", "city", "site", "floor"}:
                        return _browser_text(source.get(field)) or inferred[field]
                    explicit = "" if source_field == field else _browser_text(source.get(field))
                    return explicit or inferred[field]
            aliases = DEVICE_MERGE_FIELD_ALIASES.get(field, ())
            normalizer = (
                _browser_normalize_ip if field in {"ip", "switchIp"}
                else _identity_text if field in {"serial", "deviceId"}
                else _browser_normalize_date if field == "authenticationTime"
                else _browser_text
            )
            return next((normalized for name in (field, *aliases)
                         if (normalized := normalizer(source.get(name)))), "")

        # Legacy payloads can store only locationPath even though browser
        # normalizeDevice() exposes the parsed hierarchy on the device record.
        location_source, _ = location_inference(payload)
        location_values = {
            field: canonical_field_value(payload, field)
            for field in ("businessUnit", "city", "site", "floor", "room", "address")
        }
        for field, normalized in location_values.items():
            if normalized and (
                not _browser_text(payload.get(field)) or location_source == field
            ):
                payload[field] = normalized

        vendor_was_empty = not canonical_field_value(payload, "manufacturer")
        model_was_empty = not _browser_text(payload.get("model"))
        stored_conflicts = payload.get("conflicts") if isinstance(payload.get("conflicts"), list) else []
        conflict_signatures = {_browser_conflict_key(item) for item in stored_conflicts}

        def add_conflict(conflict: dict[str, Any]) -> bool:
            signature = _browser_conflict_key(conflict)
            if signature in conflict_signatures:
                return False
            if len(stored_conflicts) >= MAX_DEVICE_CONFLICTS:
                payload["conflictsTruncated"] = True
                return False
            conflict_signatures.add(signature)
            stored_conflicts.append(conflict)
            payload["conflicts"] = stored_conflicts
            new_conflicts.append({"internalDeviceId": str(existing["internal_device_id"]), **conflict})
            return True

        for key in ("firstSeen", "lastSeen", "lastMissing"):
            if key in payload and payload[key] not in (None, "") and _stored_optional_timestamp(payload[key]) is None:
                payload.pop(key, None)
        previous_state_dates = [
            date for date in (_stored_optional_timestamp(payload.get("lastSeen")), _stored_optional_timestamp(payload.get("lastMissing")))
            if date is not None
        ]
        incoming_state_dates = [
            date for date in (_optional_timestamp(incoming.get("lastSeen")), _optional_timestamp(incoming.get("lastMissing")))
            if date is not None
        ]
        previous_state_at = max(previous_state_dates, default=None)
        incoming_state_at = max(incoming_state_dates, default=None)
        for key, value in incoming.items():
            if key == "firstSeen":
                incoming_at = _optional_timestamp(value)
                existing_at = _stored_optional_timestamp(payload.get(key))
                if incoming_at is not None and (existing_at is None or incoming_at < existing_at):
                    payload[key] = value
                continue
            if key in {"lastSeen", "lastMissing"}:
                incoming_at = _optional_timestamp(value)
                existing_at = _stored_optional_timestamp(payload.get(key))
                if incoming_at is not None and (existing_at is None or incoming_at > existing_at):
                    payload[key] = value
                continue
            if key in {"present", "snapshotId"}:
                continue
            if key == "observationCount" and isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                previous_count = payload.get(key)
                payload[key] = max(value, previous_count) if isinstance(previous_count, int) and not isinstance(previous_count, bool) else value
                continue
            if key in {"customFields", "fieldSources", "customFieldSources"} and isinstance(value, dict):
                previous = payload.get(key) if isinstance(payload.get(key), dict) else {}
                merged = dict(previous)
                if key == "customFields":
                    source_map = incoming.get("customFieldSources")
                    source_map = source_map if isinstance(source_map, dict) else {}
                    custom_sources = payload.get("customFieldSources")
                    custom_sources = dict(custom_sources) if isinstance(custom_sources, dict) else {}
                    for name, item in value.items():
                        incoming_text = _browser_text(item)
                        if not incoming_text:
                            continue
                        current = merged.get(name)
                        current_text = _browser_text(current)
                        if not current_text:
                            merged[name] = incoming_text
                            provenance = source_map.get(name) or incoming.get("source")
                            if provenance:
                                custom_sources[name] = provenance
                        elif _identity_key(current_text) != _identity_key(incoming_text):
                            conflict = {
                                "field": "customField", "key": name, "selected": current_text, "value": incoming_text,
                                "source": source_map.get(name) or _identity_text(incoming.get("source")) or "Импорт",
                            }
                            add_conflict(conflict)
                    if custom_sources:
                        payload["customFieldSources"] = custom_sources
                else:
                    for name, item in value.items():
                        if item is not None and not str(merged.get(name) or "").strip():
                            merged[name] = item
                if merged != previous:
                    payload[key] = merged
                continue
            if key == "conflicts" and isinstance(value, list):
                previous = payload.get(key) if isinstance(payload.get(key), list) else []
                merged = list(previous)
                seen = {_browser_conflict_key(item) for item in previous}
                for item in value:
                    signature = _browser_conflict_key(item)
                    if signature not in seen:
                        seen.add(signature)
                        merged.append(item)
                stored_conflicts = merged[:MAX_DEVICE_CONFLICTS]
                payload[key] = stored_conflicts
                conflict_signatures = {_browser_conflict_key(item) for item in stored_conflicts}
                payload["conflictsTruncated"] = bool(
                    payload.get("conflictsTruncated")
                    or incoming.get("conflictsTruncated")
                    or len(merged) > MAX_DEVICE_CONFLICTS
                )
                continue
            if key == "conflictsTruncated":
                payload[key] = bool(payload.get(key) or value)
                continue
            if key == "sources" and isinstance(value, list):
                previous = payload.get(key) if isinstance(payload.get(key), list) else []
                merged = _browser_unique_text([*previous, *value, incoming.get("source")])
                if merged != previous:
                    payload[key] = merged
                continue
            if key == "alternateMacs" and isinstance(value, list):
                previous = payload.get(key) if isinstance(payload.get(key), list) else []
                merged_alternates = []
                seen_macs = set()
                primary_mac = (
                    _browser_normalize_mac(payload.get("mac") or payload.get("macFormatted") or payload.get("mac_formatted"))
                    or _browser_normalize_mac(existing["mac"])
                )
                for alternate in [*previous, *value]:
                    alias = _browser_normalize_mac(alternate)
                    if not alias:
                        continue
                    if alias not in seen_macs:
                        seen_macs.add(alias)
                        if len(merged_alternates) < MAX_DEVICE_ALTERNATE_MACS:
                            merged_alternates.append(alias)
                        else:
                            payload["alternateMacsTruncated"] = True
                merged_alternates = [alias for alias in merged_alternates if alias != primary_mac]
                if merged_alternates != previous:
                    payload[key] = merged_alternates
                continue
            if key == "possibleIps" and isinstance(value, list):
                previous = payload.get(key) if isinstance(payload.get(key), list) else []
                merged_ips = []
                seen_ips = set()
                for address in [*previous, *value]:
                    normalized = _browser_normalize_ip(address)
                    if not normalized or normalized in seen_ips:
                        continue
                    seen_ips.add(normalized)
                    if len(merged_ips) < MAX_DEVICE_POSSIBLE_IPS:
                        merged_ips.append(normalized)
                    else:
                        payload["possibleIpsTruncated"] = True
                if merged_ips != previous:
                    payload[key] = merged_ips
                continue
            if key in {"alternateMacsTruncated", "possibleIpsTruncated"}:
                payload[key] = bool(payload.get(key) or value)
                continue
            if key in {"vendorConfidence", "modelConfidence"}:
                field_was_empty = vendor_was_empty if key == "vendorConfidence" else model_was_empty
                field_name = "manufacturer" if key == "vendorConfidence" else "model"
                label_value = incoming.get(field_name)
                if key == "vendorConfidence" and not _browser_text(label_value):
                    label_value = incoming.get("vendor")
                if field_was_empty and _browser_text(label_value) and value not in (None, ""):
                    try:
                        confidence = float(value)
                    except (TypeError, ValueError, OverflowError):
                        confidence = math.nan
                    if math.isfinite(confidence):
                        payload[key] = max(0.0, min(1.0, confidence))
                continue
            if key in {"vendorSource", "modelSource"}:
                field_was_empty = vendor_was_empty if key == "vendorSource" else model_was_empty
                field_name = "manufacturer" if key == "vendorSource" else "model"
                label_value = incoming.get(field_name)
                if key == "vendorSource" and not _browser_text(label_value):
                    label_value = incoming.get("vendor")
                if field_was_empty and _browser_text(label_value):
                    provenance = value if key in incoming else None
                    if provenance is None:
                        incoming_sources = incoming.get("fieldSources")
                        provenance = incoming_sources.get(field_name) if isinstance(incoming_sources, dict) else None
                    normalized_provenance = _browser_text(provenance)
                    if normalized_provenance:
                        payload[key] = normalized_provenance
                continue
            if key in DEVICE_MERGE_TEXT_FIELDS:
                if key in {"ip", "switchIp"}:
                    incoming_text = canonical_field_value(incoming, key)
                    current_text = canonical_field_value(payload, key)
                    if current_text and not _browser_normalize_ip(payload.get(key)):
                        payload[key] = current_text
                    if incoming_text and not current_text:
                        payload[key] = incoming_text
                        existing_sources = payload.get("fieldSources")
                        field_sources = dict(existing_sources) if isinstance(existing_sources, dict) else {}
                        incoming_sources = incoming.get("fieldSources")
                        incoming_sources = incoming_sources if isinstance(incoming_sources, dict) else {}
                        provenance = _browser_text(incoming_sources.get(key)) or _browser_text(incoming.get("source"))
                        if provenance:
                            field_sources[key] = provenance
                            payload["fieldSources"] = field_sources
                    elif key in DEVICE_ENRICHMENT_MERGE_FIELDS and incoming_text and current_text:
                        if incoming_text != current_text:
                            add_conflict({
                                "field": key, "selected": current_text, "value": incoming_text,
                                "source": _browser_text(incoming.get("source")),
                            })
                        elif payload.get(key) != current_text:
                            payload[key] = current_text
                    continue
                incoming_text = canonical_field_value(incoming, key)
                current_text = canonical_field_value(payload, key)
                if current_text and not _browser_text(payload.get(key)):
                    payload[key] = current_text
                if incoming_text and not current_text:
                    payload[key] = incoming_text
                    existing_sources = payload.get("fieldSources")
                    field_sources = dict(existing_sources) if isinstance(existing_sources, dict) else {}
                    incoming_sources = incoming.get("fieldSources")
                    incoming_sources = incoming_sources if isinstance(incoming_sources, dict) else {}
                    provenance = _browser_text(incoming_sources.get(key)) or _browser_text(incoming.get("source"))
                    if provenance:
                        field_sources[key] = provenance
                        payload["fieldSources"] = field_sources
                elif key in DEVICE_ENRICHMENT_MERGE_FIELDS and incoming_text and current_text:
                    if _identity_key(current_text) != _identity_key(incoming_text):
                        add_conflict({
                            "field": key, "selected": current_text, "value": incoming_text,
                            "source": _browser_text(incoming.get("source")),
                        })
                continue
            if value and not str(payload.get(key) or "").strip():
                payload[key] = value
        if _browser_text(incoming.get("source")):
            previous_sources = payload.get("sources") if isinstance(payload.get("sources"), list) else []
            merged_sources = _browser_unique_text([*previous_sources, incoming.get("source")])
            if merged_sources != previous_sources:
                payload["sources"] = merged_sources
        incoming_present = incoming.get("present")
        state_is_newer = incoming_state_at is not None and (
            previous_state_at is None or incoming_state_at > previous_state_at
        )
        if incoming_state_at is None and previous_state_at is None and "present" not in payload:
            state_is_newer = True
        if isinstance(incoming_present, bool) and state_is_newer:
            payload["present"] = incoming_present
            snapshot_id = incoming.get("snapshotId")
            if incoming_present and isinstance(snapshot_id, str) and snapshot_id.strip():
                payload["snapshotId"] = snapshot_id.strip()
        if not payload.get("internalDeviceId"):
            payload["internalDeviceId"] = existing["internal_device_id"]
        canonical_room = _browser_text(payload.get("room"))
        if canonical_room and existing["room"] != canonical_room:
            # Keep SQLite's query column aligned with the selected browser
            # projection, including a room recovered from a legacy path.
            updates["room"] = canonical_room
        payload_first_seen = _stored_optional_timestamp(payload.get("firstSeen"))
        column_first_seen = _stored_optional_timestamp(existing["first_seen"])
        if column_first_seen is not None and (payload_first_seen is None or column_first_seen < payload_first_seen):
            payload["firstSeen"] = existing["first_seen"]
            payload_first_seen = column_first_seen
        elif payload_first_seen is not None and (column_first_seen is None or payload_first_seen < column_first_seen):
            updates["first_seen"] = payload.get("firstSeen")
        elif payload_first_seen is not None and existing["first_seen"] != payload.get("firstSeen"):
            # Equal instants can have different offsets; keep the legacy query column
            # textually aligned with the canonical payload representation.
            updates["first_seen"] = payload.get("firstSeen")
        serialized_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if len(serialized_payload.encode("utf-8")) > MAX_DEVICE_RECORD_BYTES:
            raise ValueError("Merged device record exceeds 256 KiB")
        if serialized_payload != payload_raw:
            updates["payload_json"] = serialized_payload
    if updates:
        assignments = ", ".join(f'"{column}" = ?' for column in updates)
        connection.execute(
            f"UPDATE resolved_device_inventory SET {assignments} WHERE internal_device_id = ?",
            (*updates.values(), existing["internal_device_id"]),
        )
    return new_conflicts


def initialize_database(path: Path | str, backup_directory: Path | str | None = None) -> dict[str, Any]:
    """Create or upgrade the source-compatible schema without replacing user rows."""
    database = Path(path).resolve()
    database.parent.mkdir(parents=True, exist_ok=True)
    existed = database.exists()
    backfill_snapshot_device_index = not existed
    if existed:
        with database.open("rb") as handle:
            if handle.read(16) != b"SQLite format 3\x00":
                raise ValueError("Configured database is not a SQLite database; existing file was left unchanged")
    connection = sqlite3.connect(database, timeout=30)
    connection.row_factory = sqlite3.Row
    backup_info: dict[str, Any] | None = None
    try:
        connection.execute("PRAGMA busy_timeout=30000")
        if existed:
            integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
            if integrity.lower() != "ok":
                raise ValueError(f"SQLite integrity check failed: {integrity}; existing file was left unchanged")
            schema_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if schema_version > DB_SCHEMA_VERSION:
                raise ValueError(
                    f"SQLite schema version {schema_version} is newer than supported version "
                    f"{DB_SCHEMA_VERSION}; existing file was left unchanged"
                )
            existing_tables = {str(row[0]) for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )}
            backfill_snapshot_device_index = (
                schema_version < DB_SCHEMA_VERSION
                or "snapshot_devices" not in existing_tables
                or "snapshot_device_index" not in existing_tables
            )
            if _needs_migration(connection):
                from backend.services.system.backup_store import backup_sqlite_database
                backup_info = backup_sqlite_database(database, backup_directory or database.parent / "backups")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        with connection:
            # Python's sqlite3 no longer starts a transaction for DDL by itself.
            # Make the schema, indexes, and inventory backfills one rollback unit.
            connection.execute("BEGIN IMMEDIATE")
            for statement in TABLES:
                connection.execute(statement)
            _ensure_columns(connection)
            for statement in INDEXES:
                connection.execute(statement)
            _backfill_inventory(connection)
            _backfill_resolved_inventory(connection)
            _backfill_identity_aliases(connection)
            _backfill_resolved_history_sources(connection)
            if backfill_snapshot_device_index:
                _backfill_snapshot_devices(connection)
            connection.execute(f"PRAGMA user_version={DB_SCHEMA_VERSION}")
        tables = [str(row[0]) for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        missing = sorted(set(REQUIRED_TABLES) - set(tables))
        if missing:
            raise RuntimeError("SQLite schema migration did not create required tables: " + ", ".join(missing))
        counts = {
            table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in ("device_inventory", "mac_history", "resolved_device_inventory", "snapshots")
        }
        final_integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        if final_integrity.lower() != "ok":
            raise RuntimeError("SQLite integrity check failed after additive schema migration: " + final_integrity)
        return {
            "path": str(database), "integrity": final_integrity, "tableCount": len(tables),
            "tables": tables, "counts": counts, "created": not existed, "backup": backup_info,
            "schemaVersion": DB_SCHEMA_VERSION,
        }
    finally:
        connection.close()


def load_settings(path: Path | str, keys: list[str] | None = None) -> dict[str, Any]:
    max_response_bytes = 1024 * 1024
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    query = "SELECT key, value, updated_at FROM app_settings"
    params: tuple[Any, ...] = ()
    if keys:
        unique = list(dict.fromkeys(key for key in keys if key))
        if not unique:
            return {}
        if len(unique) > 500:
            raise ValueError("A settings request can select at most 500 keys")
        query += " WHERE key IN (" + ",".join("?" for _ in unique) + ")"
        params = tuple(unique)
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        cursor = connection.execute(query + " ORDER BY key", params)
        result: dict[str, Any] = {}
        updated_at: dict[str, str] = {}
        response_bytes = len(b'{"settings":{},"updatedAt":{}}')
        for row in cursor:
            key = str(row["key"])
            raw_value = row["value"]
            updated = row["updated_at"]
            if not isinstance(raw_value, str):
                raw_value = str(raw_value)
            if len(raw_value) > max_response_bytes:
                raise SettingsResponseTooLarge("Settings response exceeds 1 MiB; request specific keys")
            try:
                value = json.loads(raw_value)
            except (TypeError, ValueError):
                value = raw_value
            key_json = json.dumps(key, ensure_ascii=False, separators=(",", ":"))
            value_json = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            updated_json = json.dumps(updated, ensure_ascii=False, separators=(",", ":"))
            item_bytes = (
                len(key_json.encode("utf-8")) * 2
                + len(value_json.encode("utf-8"))
                + len(updated_json.encode("utf-8"))
                + 2  # one key/value separator in each JSON object
                + (2 if result else 0)  # one comma in each JSON object
            )
            response_bytes += item_bytes
            if response_bytes > max_response_bytes:
                raise SettingsResponseTooLarge("Settings response exceeds 1 MiB; request specific keys")
            result[key] = value
            updated_at[key] = updated
    return {"settings": result, "updatedAt": updated_at}


class SettingsResponseTooLarge(ValueError):
    """Raised when a full settings read would exceed its bounded JSON response."""


def save_settings(path: Path | str, values: Mapping[str, Any]) -> dict[str, Any]:
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    now = _now()
    saved: dict[str, Any] = {}
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.execute("PRAGMA busy_timeout=30000")
        with connection:
            for key, value in values.items():
                if not isinstance(key, str) or not key.strip() or len(key) > 160:
                    raise ValueError("Setting keys must be non-empty strings up to 160 characters")
                encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                if len(encoded.encode("utf-8")) > 262144:
                    raise ValueError(f"Setting '{key}' exceeds 256 KiB")
                connection.execute(
                    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                    (key.strip(), encoded, now),
                )
                saved[key.strip()] = value
    return {"saved": list(saved), "updatedAt": now}


DEVICE_API_FIELDS = (
    "id", "internalDeviceId", "internal_device_id", "mac", "macAddress", "mac_address",
    "macFormatted", "mac_formatted", "CallingStationID", *LEGACY_ALTERNATE_MAC_FIELDS,
    "deviceId", "device_id", "asset_id",
    "serial", "serialNumber", "serial_number", "vendor", "manufacturer", "model", "oui",
    "vendorConfidence", "vendor_confidence", "modelConfidence", "model_confidence",
    "vendorSource", "vendor_source", "modelSource", "model_source", "deviceType", "type",
    "ip", "deviceIp", "device_ip", "address", "physicalAddress", "room", "location", "locationPath", "smartroomId", "smartroom_id",
    "switchIp", "ipSwitch", "ip_switch", "nasIp", "switchPort", "port", "nasPortId", "hostname", "host", "host_name", "deviceName", "name",
    "businessUnit", "city", "site", "floor", "authenticationTime", "receiptTime", "firstSeen", "lastSeen", "lastMissing",
    "present", "snapshotId", "possibleIps", "possibleIpsTruncated",
    "source", "sources", "alternateMacs", "alternateMacsTruncated", "customFields", "customFieldSources", "fieldSources", "conflicts", "conflictsTruncated",
    "observationCount",
)
DEVICE_NORMALIZED_FIELDS = (
    "mac", "oui", "alternateMacs", "alternateMacsTruncated", "ip", "switchIp", "switchPort",
    "smartroomId", "businessUnit", "city", "site", "floor", "room", "address", "physicalAddress",
    "manufacturer", "model", "deviceType", "hostname", "serial", "deviceId", "deviceName",
    "authenticationTime", "possibleIps", "possibleIpsTruncated", "sources", "fieldSources",
    "vendorConfidence", "modelConfidence", "vendorSource", "modelSource", "customFields",
    "customFieldSources", "conflicts", "conflictsTruncated",
)
DEVICE_MERGE_TEXT_FIELDS = frozenset({
    "oui", "ip", "switchIp", "switchPort", "smartroomId", "smartroom_id", "port", "nasPortId", "businessUnit", "city", "site", "floor",
    "room", "address", "location", "locationPath", "physicalAddress", "manufacturer", "vendor", "model", "deviceType", "type", "hostname", "host", "host_name",
    "serial", "serialNumber", "deviceId", "deviceName", "name", "authenticationTime", "receiptTime",
})
DEVICE_MERGE_FIELD_ALIASES = {
    "ip": ("deviceIp", "device_ip"),
    "switchIp": ("ipSwitch", "ip_switch", "nasIp"),
    "manufacturer": ("vendor",),
    "hostname": ("host", "host_name"),
    "deviceName": ("name",),
    "switchPort": ("port", "nasPortId"),
    "smartroomId": ("smartroom_id",),
    "deviceType": ("type",),
    "serial": ("serialNumber", "serial_number"),
    "deviceId": ("device_id", "asset_id"),
    "authenticationTime": ("receiptTime",),
}
CUSTOM_FIELD_KEY_PATTERN = re.compile(r"^custom_[0-9a-f-]{36}$", re.IGNORECASE)
DEVICE_ENRICHMENT_MERGE_FIELDS = frozenset({
    "oui", "ip", "switchIp", "switchPort", "smartroomId", "businessUnit", "city", "site", "floor",
    "room", "address", "physicalAddress", "manufacturer", "model", "deviceType", "hostname",
    "serial", "deviceId", "deviceName", "authenticationTime",
})
MAX_DEVICE_BATCH = 500
MAX_DEVICE_RECORD_BYTES = 256 * 1024
MAX_DEVICE_CONFLICTS = 100
MAX_DEVICE_WRITE_CONFLICT_SAMPLE_BYTES = 512 * 1024
MAX_DEVICE_RESPONSE_BYTES = 1024 * 1024
MAX_HISTORY_BATCH = 500
MAX_HISTORY_EVENT_BYTES = 256 * 1024
MAX_HISTORY_RESPONSE_BYTES = 1024 * 1024
MAX_SNAPSHOT_BATCH = 500
MAX_SNAPSHOT_RESPONSE_BYTES = 1024 * 1024
MAX_SNAPSHOT_DEVICES = 150_000
MAX_SNAPSHOT_DEVICE_BYTES = 256 * 1024
SNAPSHOT_IDENTITY_TOKEN_BATCH_SIZE = 1_000
HISTORY_EVENT_TYPES = frozenset({"added", "absent", "modified"})
EMPTY_HISTORY_VALUES = frozenset({
    "", "—", "-", "n/a", "na", "null", "none", "undefined", "unknown",
    "unknown vendor", "unknown model", "not found", "not available", "неизвестно", "неизвестен",
    "не определено", "не найдено", "неизвестный вендор", "неизвестная модель", "не указана",
    "не указано", "не задано", "не заполнено", "нет данных", "без помещения",
})
# Identity resolution uses the same empty markers as browser normalize.text().
_EMPTY_IDENTITY_VALUES = EMPTY_HISTORY_VALUES


class _BoundedConflictSamples(list):
    """Retain a bounded diagnostic sample while counting every conflict."""

    def __init__(self) -> None:
        super().__init__()
        self.total_count = 0
        self.sample_bytes = 2  # JSON array brackets.
        self.truncated = False

    def append(self, value: dict[str, Any]) -> None:
        self.total_count += 1
        encoded_size = len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        separator_bytes = 1 if self else 0
        if (len(self) >= MAX_DEVICE_CONFLICTS
                or self.sample_bytes + separator_bytes + encoded_size > MAX_DEVICE_WRITE_CONFLICT_SAMPLE_BYTES):
            self.truncated = True
            return
        super().append(value)
        self.sample_bytes += separator_bytes + encoded_size


def _device_api_record(value: Any) -> tuple[str, dict[str, Any]]:
    if not isinstance(value, dict):
        raise ValueError("Each device must be an object")
    record = {key: value.get(key) for key in DEVICE_API_FIELDS if key in value}
    for key, item in tuple(record.items()):
        if key in {"customFields", "customFieldSources", "fieldSources"}:
            if item is not None and not isinstance(item, dict):
                raise ValueError(f"{key} must be an object")
        elif key in {"sources", "alternateMacs", "possibleIps", "conflicts"}:
            if key == "alternateMacs" and isinstance(item, str):
                # normalizeDevice() supports legacy comma-packed alternate MACs.
                item = item.split(",")
                record[key] = item
            if item is not None and not isinstance(item, list):
                raise ValueError(f"{key} must be an array")
            if key in {"sources", "alternateMacs", "possibleIps"} and item is not None and any(
                entry is not None and not isinstance(entry, (str, int, float, bool))
                or (isinstance(entry, float) and not math.isfinite(entry))
                or (entry is not None and len(str(entry)) > 8192)
                for entry in item
            ):
                raise ValueError(f"{key} entries must be bounded JSON scalars")
            if key == "conflicts" and item is not None and any(not isinstance(entry, dict) for entry in item):
                raise ValueError("conflicts entries must be objects")
        elif item is not None and not isinstance(item, (str, int, float, bool)):
            raise ValueError(f"{key} must be a scalar text value")
        if isinstance(item, str) and len(item) > 8192:
            raise ValueError(f"{key} exceeds 8192 characters")
    for key in DEVICE_MERGE_TEXT_FIELDS:
        if key in record:
            # normalizeDevice() uses identityText()/firstKnown() for these
            # scalar fields, which rejects booleans instead of persisting
            # the strings "true" and "false".
            record[key] = _identity_text(record[key])
    for key in ("ip", "switchIp"):
        if key in record:
            record[key] = _browser_normalize_ip(record[key])
    for key in ("customFields", "customFieldSources", "fieldSources"):
        values = record.get(key)
        if isinstance(values, dict):
            record[key] = {
                str(name): normalized
                for name, item in values.items()
                if (normalized := _browser_text(item))
            }
    custom_fields = record.get("customFields")
    if isinstance(custom_fields, dict):
        record["customFields"] = {
            name: normalized
            for name, item in custom_fields.items()
            if CUSTOM_FIELD_KEY_PATTERN.fullmatch(name)
            and isinstance(item, (str, int, float, bool))
            and (not isinstance(item, float) or math.isfinite(item))
            and (normalized := _browser_text(item))
        }
    custom_sources = record.get("customFieldSources")
    if isinstance(custom_sources, dict):
        record["customFieldSources"] = {
            name: normalized
            for name, item in custom_sources.items()
            if CUSTOM_FIELD_KEY_PATTERN.fullmatch(name)
            and custom_fields
            and name in custom_fields
            and (normalized := _browser_text(item))
        }
    if "source" in record:
        record["source"] = _browser_text(record["source"])
    if "sources" in record or "source" in record:
        record["sources"] = _browser_unique_text([
            *(record.get("sources") if isinstance(record.get("sources"), list) else []),
            record.get("source"),
        ])
    if "possibleIps" in record and isinstance(record["possibleIps"], list):
        normalized_ips = []
        seen_ips = set()
        truncated = bool(record.get("possibleIpsTruncated"))
        for address in record["possibleIps"]:
            normalized = _browser_normalize_ip(address)
            if normalized and normalized not in seen_ips:
                seen_ips.add(normalized)
                if len(normalized_ips) < MAX_DEVICE_POSSIBLE_IPS:
                    normalized_ips.append(normalized)
                else:
                    truncated = True
        record["possibleIps"] = normalized_ips
        record["possibleIpsTruncated"] = truncated
    if "internalDeviceId" in record and isinstance(record["internalDeviceId"], str) and len(record["internalDeviceId"]) > 200:
        raise ValueError("internalDeviceId exceeds 200 characters")
    if "observationCount" in record and (isinstance(record["observationCount"], bool)
            or not isinstance(record["observationCount"], int) or not 0 <= record["observationCount"] <= 2**63 - 1):
        raise ValueError("observationCount must be a non-negative integer")
    if "present" in record and not isinstance(record["present"], bool):
        raise ValueError("present must be a boolean")
    if "snapshotId" in record and record["snapshotId"] is not None and (
        not isinstance(record["snapshotId"], str) or len(record["snapshotId"]) > 200
    ):
        raise ValueError("snapshotId must be text up to 200 characters")
    for key in ("firstSeen", "lastSeen", "lastMissing"):
        if key in record:
            _optional_timestamp(record[key])
    for canonical, aliases in (
        ("internalDeviceId", ("id", "internalDeviceId", "internal_device_id")),
        ("deviceId", ("deviceId", "device_id", "asset_id")),
        ("serialNumber", ("serial", "serialNumber", "serial_number")),
    ):
        if not _identity_text(record.get(canonical)):
            value = next((_identity_text(record.get(key)) for key in aliases if _identity_text(record.get(key))), "")
            if value:
                record[canonical] = value
    for canonical, aliases, normalize in (
        ("ip", ("ip", "deviceIp", "device_ip"), _browser_normalize_ip),
        ("switchIp", ("switchIp", "ipSwitch", "ip_switch", "nasIp"), _browser_normalize_ip),
        ("manufacturer", ("manufacturer", "vendor"), _identity_text),
        ("hostname", ("hostname", "host", "host_name"), _identity_text),
        ("deviceName", ("deviceName", "name"), _identity_text),
        ("switchPort", ("switchPort", "port", "nasPortId"), _identity_text),
        ("smartroomId", ("smartroomId", "smartroom_id"), _identity_text),
        ("deviceType", ("deviceType", "type"), _identity_text),
    ):
        if any(key in record for key in aliases):
            record[canonical] = next((normalized for key in aliases if (normalized := normalize(record.get(key)))), "")
    for canonical, aliases in (
        ("vendorConfidence", ("vendorConfidence", "vendor_confidence")),
        ("modelConfidence", ("modelConfidence", "model_confidence")),
    ):
        for value in (record.get(key) for key in aliases):
            if value is None or value == "":
                continue
            confidence = _browser_number(value)
            if math.isfinite(confidence):
                record[canonical] = max(0.0, min(1.0, confidence))
                break
    for canonical, aliases in (
        ("vendorSource", ("vendorSource", "vendor_source")),
        ("modelSource", ("modelSource", "model_source")),
    ):
        record[canonical] = next((normalized for key in aliases if (normalized := _identity_text(record.get(key)))), "")
    record["alternateMacsTruncated"] = bool(record.get("alternateMacsTruncated"))
    record["possibleIpsTruncated"] = bool(record.get("possibleIpsTruncated"))
    inferred_location = None
    location_source = ""
    for key in ("locationPath", "location", "room", "address"):
        if _identity_text(record.get(key)):
            inferred_location = _browser_parse_location_path(record.get(key))
            if inferred_location is not None:
                location_source = key
                break
    if inferred_location:
        for key in ("businessUnit", "city", "site", "floor"):
            record[key] = _browser_text(record.get(key)) or inferred_location[key]
        for key in ("room", "address"):
            explicit = "" if location_source == key else _browser_text(record.get(key))
            record[key] = explicit or inferred_location[key]
    if "authenticationTime" in record or "receiptTime" in record:
        record["authenticationTime"] = next((normalized for key in ("authenticationTime", "receiptTime")
            if (normalized := _browser_normalize_date(record.get(key)))), "")
    mac_field_values = [
        _browser_normalize_mac_field(record.get(key)) for key in (
            "mac", "macAddress", "mac_address", "macFormatted", "mac_formatted", "CallingStationID",
        )
    ]
    record["mac"] = (
        next((mac for mac in mac_field_values if _browser_normalize_mac(mac)), "")
        or next((mac for mac in mac_field_values if mac), "")
    )
    if isinstance(record.get("alternateMacs"), list) or any(key in record for key in LEGACY_ALTERNATE_MAC_FIELDS):
        primary_mac = _browser_normalize_mac(record.get("mac"))
        alternates = []
        seen_alternates = set()
        truncated = bool(record.get("alternateMacsTruncated"))
        source_alternates = record.get("alternateMacs") if isinstance(record.get("alternateMacs"), list) else []
        candidates = [*source_alternates, *(record.get(key) for key in LEGACY_ALTERNATE_MAC_FIELDS)]
        for value in candidates:
            alternate = _browser_normalize_mac(value)
            if alternate and alternate != primary_mac and alternate not in seen_alternates:
                seen_alternates.add(alternate)
                if len(alternates) < MAX_DEVICE_ALTERNATE_MACS:
                    alternates.append(alternate)
                else:
                    truncated = True
        record["alternateMacs"] = alternates
        record["alternateMacsTruncated"] = truncated
    _merge_identity_alias_diagnostics(record)
    try:
        payload = json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError("Device record must contain valid JSON values") from error
    if len(payload.encode("utf-8")) > MAX_DEVICE_RECORD_BYTES:
        raise ValueError("Device record exceeds 256 KiB")
    identity = _normalized_identity(record)
    if not identity:
        raise ValueError("Device record requires internalDeviceId, deviceId, serialNumber, or a valid MAC")
    record["internalDeviceId"] = identity
    return identity, record


def list_resolved_devices(path: Path | str, *, after: str = "", limit: int = 100) -> dict[str, Any]:
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    if not isinstance(after, str) or len(after) > 200:
        raise ValueError("after must be a cursor up to 200 characters")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_DEVICE_BATCH:
        raise ValueError(f"limit must be between 1 and {MAX_DEVICE_BATCH}")
    devices = []
    response_bytes = 0
    last_id = ""
    has_more = False
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        total = int(connection.execute("SELECT COUNT(*) FROM resolved_device_inventory").fetchone()[0])
        cursor = connection.execute(
            "SELECT internal_device_id, "
            "CASE WHEN length(CAST(payload_json AS BLOB)) <= ? THEN payload_json ELSE NULL END AS payload_json, "
            "mac, serial_number, device_id, hostname, smartroom_id, room, ip, switch_ip "
            "FROM resolved_device_inventory "
            "WHERE internal_device_id > ? ORDER BY internal_device_id LIMIT ?",
            (MAX_DEVICE_RECORD_BYTES, after, limit + 1),
        )
        while True:
            row = cursor.fetchone()
            if row is None:
                break
            if len(devices) >= limit:
                has_more = True
                break
            try:
                payload = json.loads(row["payload_json"])
            except (TypeError, ValueError):
                payload = None
            if not isinstance(payload, dict):
                payload = {"internalDeviceId": row["internal_device_id"], "payloadOmitted": True}
                for key, column in (
                    ("mac", "mac"), ("serialNumber", "serial_number"), ("deviceId", "device_id"),
                    ("hostname", "hostname"), ("smartroomId", "smartroom_id"), ("room", "room"),
                    ("ip", "ip"), ("switchIp", "switch_ip"),
                ):
                    if row[column]:
                        payload[key] = row[column]
            else:
                # Stored pre-normalization payloads are read-only, but REST
                # consumers still receive the same canonical projection as
                # browser normalizeDevice(). Keep extra legacy data intact.
                projection_input = dict(payload)
                projection_input["internalDeviceId"] = str(row["internal_device_id"])
                try:
                    _, normalized = _device_api_record(projection_input)
                except (TypeError, ValueError, RecursionError):
                    normalized = None
                if normalized is not None:
                    payload.update(normalized)
                    payload["internalDeviceId"] = str(row["internal_device_id"])
            encoded_size = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if response_bytes + encoded_size + (1 if devices else 0) > MAX_DEVICE_RESPONSE_BYTES - 512:
                if not devices:
                    raise ValueError("A device response exceeds the 1 MiB page limit")
                has_more = True
                break
            devices.append(payload)
            response_bytes += encoded_size + (1 if len(devices) > 1 else 0)
            last_id = str(row["internal_device_id"])
    return {
        "devices": devices,
        "total": total,
        "nextCursor": last_id if has_more and last_id else None,
    }


def search_database(path: Path | str, query: str = "", *, limit: int = 100) -> dict[str, Any]:
    """Search the optional-host copy with bounded rows and a compact safe projection."""
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    if not isinstance(query, str) or len(query) > 256:
        raise ValueError("query must be text up to 256 characters")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_DEVICE_BATCH:
        raise ValueError(f"limit must be between 1 and {MAX_DEVICE_BATCH}")

    text_query = query.strip()
    search_term = _identity_key(text_query)
    normalized_mac = _canonical_mac(text_query)
    candidates: list[dict[str, str]] = []

    def result(kind: str, mac: Any, title: Any, subtitle: Any, source: Any, updated_at: Any) -> dict[str, str]:
        def compact(value: Any, maximum: int) -> str:
            return str(value or "").strip()[:maximum]

        return {
            "type": kind,
            "mac": compact(mac, 32),
            "title": compact(title, 256),
            "subtitle": compact(subtitle, 512),
            "source": compact(source, 128),
            "updatedAt": compact(updated_at, 64),
        }

    def add_device(record: Any, fallback: Mapping[str, Any]) -> None:
        device = record if isinstance(record, dict) else {}
        mac = device.get("mac") or device.get("macFormatted") or fallback.get("mac") or ""
        vendor = device.get("manufacturer") or device.get("vendor") or ""
        model = device.get("model") or ""
        values = [vendor, model, device.get("ip"), device.get("hostname"), device.get("serialNumber"),
                  device.get("deviceId"), device.get("deviceName"), device.get("address")]
        source_value = device.get("source")
        if not source_value and isinstance(device.get("sources"), list):
            source_value = ", ".join(str(item) for item in device["sources"][:8] if item)
        formatted_mac = device.get("macFormatted") or mac
        candidates.append(result("device", mac, formatted_mac or device.get("internalDeviceId"),
                                 " · ".join(str(value) for value in values if value), source_value,
                                 fallback.get("updated_at") or device.get("updatedAt")))

    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        connection.create_function("browser_key", 1, _identity_key, deterministic=True)
        connection.create_function("browser_device_search", 2, _browser_device_search, deterministic=True)
        if normalized_mac:
            resolved_rows = connection.execute(
                "SELECT internal_device_id, payload_json, updated_at, mac FROM resolved_device_inventory "
                "WHERE browser_device_search(payload_json, ?) > 0 "
                "ORDER BY updated_at DESC, internal_device_id LIMIT ?",
                (text_query, limit),
            ).fetchall()
            legacy_history = connection.execute(
                "SELECT mac, mac_formatted, vendor, model, ip, address, room, smartroom_id, switch_ip, switch_port, "
                "hostname, serial_number, device_id, device_name, source, recorded_at "
                "FROM mac_history WHERE mac = ? ORDER BY recorded_at DESC, id DESC LIMIT ?",
                (normalized_mac, limit),
            ).fetchall()
            vendor_rows = connection.execute(
                "SELECT mac, oui, prefix, vendor, model, source, observed_at FROM vendor_model_history "
                "WHERE mac = ? ORDER BY observed_at DESC, id DESC LIMIT ?",
                (normalized_mac, limit),
            ).fetchall()
            mapping_rows = []
        else:
            resolved_rows = connection.execute(
                "SELECT internal_device_id, payload_json, updated_at, mac FROM resolved_device_inventory "
                "WHERE ? = '' OR browser_device_search(payload_json, ?) > 0 "
                "ORDER BY updated_at DESC, internal_device_id LIMIT ?",
                (search_term, text_query, limit),
            ).fetchall()
            legacy_history = connection.execute(
                "SELECT mac, mac_formatted, vendor, model, ip, address, room, smartroom_id, switch_ip, switch_port, "
                "hostname, serial_number, device_id, device_name, source, recorded_at FROM mac_history "
                "WHERE ? = '' OR instr(browser_key(mac), ?) > 0 OR instr(browser_key(mac_formatted), ?) > 0 "
                "OR instr(browser_key(vendor), ?) > 0 OR instr(browser_key(model), ?) > 0 "
                "OR instr(browser_key(ip), ?) > 0 OR instr(browser_key(address), ?) > 0 OR instr(browser_key(room), ?) > 0 "
                "OR instr(browser_key(smartroom_id), ?) > 0 OR instr(browser_key(switch_ip), ?) > 0 "
                "OR instr(browser_key(switch_port), ?) > 0 OR instr(browser_key(hostname), ?) > 0 "
                "OR instr(browser_key(serial_number), ?) > 0 OR instr(browser_key(device_id), ?) > 0 "
                "OR instr(browser_key(device_name), ?) > 0 OR instr(browser_key(source), ?) > 0 "
                "ORDER BY recorded_at DESC, id DESC LIMIT ?",
                (text_query, *([search_term] * 15), limit),
            ).fetchall()
            vendor_rows = connection.execute(
                "SELECT mac, oui, prefix, vendor, model, source, observed_at FROM vendor_model_history "
                "WHERE ? <> '' AND (instr(browser_key(mac), ?) > 0 OR instr(browser_key(oui), ?) > 0 "
                "OR instr(browser_key(prefix), ?) > 0 OR instr(browser_key(vendor), ?) > 0 "
                "OR instr(browser_key(model), ?) > 0 OR instr(browser_key(source), ?) > 0) "
                "ORDER BY observed_at DESC, id DESC LIMIT ?",
                (text_query, *([search_term] * 6), limit),
            ).fetchall()
            mapping_rows = connection.execute(
                "SELECT switch_ip, physical_address, source, updated_at FROM ip_address_mappings "
                "WHERE ? <> '' AND (instr(browser_key(switch_ip), ?) > 0 "
                "OR instr(browser_key(physical_address), ?) > 0 OR instr(browser_key(source), ?) > 0) "
                "ORDER BY switch_ip LIMIT ?",
                (text_query, search_term, search_term, search_term, limit),
            ).fetchall()

    for row in resolved_rows:
        payload = _browser_search_projection(row["payload_json"])
        add_device(payload, dict(row))
    for row in legacy_history:
        values = [row["vendor"], row["model"], row["ip"], row["hostname"], row["serial_number"],
                  row["device_id"], row["device_name"], row["address"]]
        candidates.append(result("device", row["mac"], row["mac_formatted"],
                                 " · ".join(str(value) for value in values if value), row["source"], row["recorded_at"]))
    for row in vendor_rows:
        subtitle = " · ".join(str(value) for value in (row["model"], row["oui"], row["prefix"]) if value)
        candidates.append(result("vendorModel", row["mac"], row["vendor"] or row["model"] or row["mac"],
                                 subtitle, row["source"], row["observed_at"]))
    for row in mapping_rows:
        candidates.append(result("ipMapping", "", row["switch_ip"], row["physical_address"],
                                 row["source"], row["updated_at"]))

    candidates.sort(key=lambda item: (item["updatedAt"], item["title"]), reverse=True)
    results: list[dict[str, str]] = []
    response_bytes = 0
    for item in candidates:
        item_bytes = len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        if len(results) >= limit or response_bytes + item_bytes + (1 if results else 0) > MAX_DEVICE_RESPONSE_BYTES - 512:
            break
        results.append(item)
        response_bytes += item_bytes + (1 if len(results) > 1 else 0)
    return {"results": results, "count": len(results)}


def save_resolved_devices(path: Path | str, devices: Any) -> dict[str, Any]:
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    if not isinstance(devices, list) or len(devices) > MAX_DEVICE_BATCH:
        raise ValueError(f"devices must be an array of at most {MAX_DEVICE_BATCH} records")
    prepared = [
        (*_device_api_record(device), bool(
            isinstance(device, dict) and str(
                device.get("id") or device.get("internalDeviceId") or device.get("internal_device_id") or ""
            ).strip()
        ))
        for device in devices
    ]
    identity_counts = Counter(identity for identity, _, _ in prepared)
    duplicate_identities = {identity for identity, count in identity_counts.items() if count > 1}
    conflicts = _BoundedConflictSamples()
    for identity in sorted(duplicate_identities):
        conflicts.append({"internalDeviceId": identity, "reason": "duplicate_strong_identity_in_batch", "count": identity_counts[identity]})
    prepared = [(identity, record, provided_internal_id)
                for identity, record, provided_internal_id in prepared if identity not in duplicate_identities]
    now = _now()
    saved: list[str] = []
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=30000")
        with connection:
            for identity, record, provided_internal_id in prepared:
                candidates = list(_shared_strong_identity_rows(connection, record))
                candidate_ids = {str(row["internal_device_id"]) for row in candidates}
                existing = connection.execute(
                    "SELECT * FROM resolved_device_inventory WHERE internal_device_id = ?", (identity,)
                ).fetchone()
                conflicting_candidates = candidate_ids - {identity}
                merge_record = record
                priority_diagnostic = None
                priority_candidate = None
                if conflicting_candidates and (existing is not None or provided_internal_id or len(candidates) > 1):
                    ranked_candidates = []
                    incoming_identity = dict(record)
                    if not provided_internal_id:
                        # _device_api_record adds this derived ID. It is a storage key,
                        # not incoming identity evidence, unless the caller supplied one.
                        incoming_identity.pop("internalDeviceId", None)
                    for candidate in candidates:
                        candidate_id = str(candidate["internal_device_id"])
                        candidate_device = _row_identity_device(candidate)
                        field_matches = _identity_match_fields(
                            incoming_identity, candidate_device, include_incoming_id=provided_internal_id,
                        )
                        priority = min((value[0] for value in field_matches.values()), default=None)
                        if priority is not None:
                            ranked_candidates.append((candidate, candidate_id, priority, field_matches))
                    ranked_ids = {candidate_id for _, candidate_id, _, _ in ranked_candidates}
                    best_priority = min((priority for _, _, priority, _ in ranked_candidates), default=None)
                    best_candidates = [row for row in ranked_candidates if row[2] == best_priority]
                    winner = best_candidates[0] if len(best_candidates) == 1 else None
                    winner_is_allowed = bool(
                        winner
                        and not (candidate_ids - ranked_ids)
                        and (winner[1] == identity if existing is not None else not provided_internal_id)
                    )
                    lower_priority_rows = [row for row in ranked_candidates if winner and row[1] != winner[1]]
                    if winner_is_allowed and lower_priority_rows and all(row[2] > best_priority for row in lower_priority_rows):
                        selected_candidate, selected_id, selected_priority, _ = winner
                        if existing is None:
                            priority_candidate = selected_candidate
                        if existing is not None or not provided_internal_id:
                            contested: dict[str, set[str]] = {}
                            for _, _, _, matches in lower_priority_rows:
                                for field, (field_priority, matched_values) in matches.items():
                                    if field_priority > selected_priority:
                                        contested.setdefault(field, set()).update(matched_values)
                            merge_record = _without_contested_identity_fields(record, contested)
                            priority_diagnostic = {
                                "internalDeviceId": identity,
                                "reason": "conflicting_strong_identity",
                                "selectedInternalDeviceId": selected_id,
                                "candidateInternalDeviceIds": sorted(conflicting_candidates)[:20],
                                "candidateCount": len(conflicting_candidates),
                                "selectedPriority": selected_priority,
                                "contestedFields": sorted(contested),
                            }
                    else:
                        conflicts.append({
                            "internalDeviceId": identity, "reason": "conflicting_strong_identity",
                            "candidateInternalDeviceIds": sorted(conflicting_candidates)[:20],
                            "candidateCount": len(conflicting_candidates),
                        })
                        continue
                if existing:
                    safe_record, strong_conflict = _prepare_priority_safe_merge(
                        existing, merge_record, include_incoming_id=provided_internal_id,
                    )
                    if safe_record is None:
                        mismatches = _strong_identity_conflicts(existing, merge_record)
                        conflicts.append({"internalDeviceId": identity, "reason": "conflicting_strong_identity", "fields": mismatches})
                        continue
                    merge_record = safe_record
                    merge_conflicts = _merge_resolved_inventory_blanks(connection, existing, merge_record)
                    if "observationCount" in merge_record:
                        connection.execute(
                            "UPDATE resolved_device_inventory SET seen_count = MAX(seen_count, ?), updated_at = ? "
                            "WHERE internal_device_id = ?", (merge_record["observationCount"], now, identity),
                        )
                    else:
                        connection.execute(
                            "UPDATE resolved_device_inventory SET seen_count = seen_count + 1, updated_at = ? "
                            "WHERE internal_device_id = ?", (now, identity),
                        )
                    _save_identity_aliases(connection, identity, merge_record)
                    saved.append(identity)
                    if strong_conflict:
                        conflicts.append(strong_conflict)
                    if priority_diagnostic:
                        conflicts.append(priority_diagnostic)
                    for conflict in merge_conflicts:
                        conflicts.append(conflict)
                    continue

                if priority_candidate is not None:
                    selected_id = str(priority_candidate["internal_device_id"])
                    safe_record, strong_conflict = _prepare_priority_safe_merge(
                        priority_candidate, merge_record, include_incoming_id=provided_internal_id,
                    )
                    if safe_record is None:
                        mismatches = _strong_identity_conflicts(priority_candidate, merge_record)
                        conflicts.append({
                            "internalDeviceId": identity, "reason": "conflicting_strong_identity",
                            "candidateInternalDeviceId": selected_id, "fields": mismatches,
                        })
                        continue
                    merge_record = safe_record
                    merge_conflicts = _merge_resolved_inventory_blanks(connection, priority_candidate, merge_record)
                    if "observationCount" in merge_record:
                        connection.execute(
                            "UPDATE resolved_device_inventory SET seen_count = MAX(seen_count, ?), updated_at = ? "
                            "WHERE internal_device_id = ?", (merge_record["observationCount"], now, selected_id),
                        )
                    else:
                        connection.execute(
                            "UPDATE resolved_device_inventory SET seen_count = seen_count + 1, updated_at = ? "
                            "WHERE internal_device_id = ?", (now, selected_id),
                        )
                    _save_identity_aliases(connection, selected_id, merge_record)
                    saved.append(selected_id)
                    if strong_conflict:
                        conflicts.append(strong_conflict)
                    if priority_diagnostic:
                        conflicts.append(priority_diagnostic)
                    for conflict in merge_conflicts:
                        conflicts.append(conflict)
                    continue

                if len(candidates) > 1:
                    conflicts.append({
                        "internalDeviceId": identity, "reason": "multiple_strong_matches",
                        "candidateInternalDeviceIds": [row["internal_device_id"] for row in candidates[:20]],
                        "candidateCount": len(candidates),
                    })
                    continue
                if candidates:
                    candidate = candidates[0]
                    safe_record, strong_conflict = _prepare_priority_safe_merge(
                        candidate, record, include_incoming_id=provided_internal_id,
                    )
                    if safe_record is None:
                        mismatches = _strong_identity_conflicts(candidate, record)
                        conflicts.append({
                            "internalDeviceId": identity, "reason": "conflicting_strong_identity",
                            "candidateInternalDeviceId": candidate["internal_device_id"], "fields": mismatches,
                        })
                        continue
                    record = safe_record
                    merge_conflicts = _merge_resolved_inventory_blanks(connection, candidate, record)
                    if "observationCount" in record:
                        connection.execute(
                            "UPDATE resolved_device_inventory SET seen_count = MAX(seen_count, ?), updated_at = ? "
                            "WHERE internal_device_id = ?", (record["observationCount"], now, candidate["internal_device_id"]),
                        )
                    else:
                        connection.execute(
                            "UPDATE resolved_device_inventory SET seen_count = seen_count + 1, updated_at = ? "
                            "WHERE internal_device_id = ?", (now, candidate["internal_device_id"]),
                        )
                    _save_identity_aliases(connection, str(candidate["internal_device_id"]), record)
                    saved.append(str(candidate["internal_device_id"]))
                    if strong_conflict:
                        conflicts.append(strong_conflict)
                    for conflict in merge_conflicts:
                        conflicts.append(conflict)
                    continue

                columns = {
                    "mac": record.get("mac") or record.get("macFormatted") or "",
                    "serial_number": record.get("serial") or record.get("serialNumber") or "",
                    "device_id": record.get("deviceId") or "",
                    "hostname": record.get("hostname") or "",
                    "smartroom_id": record.get("smartroomId") or "",
                    "room": record.get("room") or "",
                    "ip": record.get("ip") or "",
                    "switch_ip": record.get("switchIp") or "",
                }
                connection.execute(
                    "INSERT INTO resolved_device_inventory "
                    "(internal_device_id, mac, serial_number, device_id, hostname, smartroom_id, room, ip, switch_ip, "
                    "payload_json, first_seen, updated_at, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (identity, columns["mac"], columns["serial_number"], columns["device_id"], columns["hostname"],
                     columns["smartroom_id"], columns["room"], columns["ip"], columns["switch_ip"],
                     json.dumps(record, ensure_ascii=False, separators=(",", ":")), record.get("firstSeen") or now,
                     now, record.get("observationCount", 1)),
                )
                _save_identity_aliases(connection, identity, record)
                saved.append(identity)
    return {
        "saved": saved,
        "conflicts": list(conflicts),
        "savedCount": len(saved),
        "rejectedCount": len(devices) - len(saved),
        "conflictCount": conflicts.total_count,
        "conflictsTruncated": conflicts.truncated,
        "updatedAt": now,
    }


def _resolved_history_event(value: Any) -> tuple[str, str, dict[str, Any]]:
    if not isinstance(value, dict):
        raise ValueError("Each history event must be an object")
    source_final_id = value.get("sourceFinalId")
    if not isinstance(source_final_id, str) or not source_final_id.strip() or len(source_final_id) > 200:
        raise ValueError("sourceFinalId must be non-empty text up to 200 characters")
    observed_at = value.get("observedAt")
    if not isinstance(observed_at, str) or len(observed_at) > 80:
        raise ValueError("observedAt must be an ISO 8601 date-time with a timezone")
    try:
        parsed_at = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("observedAt must be a valid ISO 8601 date-time") from error
    if parsed_at.tzinfo is None or parsed_at.utcoffset() is None:
        raise ValueError("observedAt must include a timezone")
    # Match browser Date/normalizeDate(), whose ISO representation is millisecond precision.
    normalized_at = parsed_at.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    identity, normalized_device = _device_api_record(value)
    event_type = value.get("eventType")
    if not isinstance(event_type, str) or event_type not in HISTORY_EVENT_TYPES:
        raise ValueError("eventType must be added, absent, or modified")
    event: dict[str, Any] = {
        "sourceFinalId": source_final_id.strip(),
        "observedAt": normalized_at,
        "internalDeviceId": identity,
        "eventType": event_type,
    }
    event.update({
        key: normalized_device[key] for key in DEVICE_NORMALIZED_FIELDS if key in normalized_device
    })
    if event_type == "modified":
        field = value.get("field")
        before = value.get("fromValue")
        after = value.get("toValue")
        if not isinstance(field, str) or not field.strip() or len(field) > 160:
            raise ValueError("modified events require a field name up to 160 characters")
        if not isinstance(before, str) or not isinstance(after, str):
            raise ValueError("modified events require text fromValue and toValue")
        before = " ".join(before.replace("\u00a0", " ").split())
        after = " ".join(after.replace("\u00a0", " ").split())
        if (
            before.casefold() in EMPTY_HISTORY_VALUES
            or after.casefold() in EMPTY_HISTORY_VALUES
            or _identity_key(before) == _identity_key(after)
        ):
            raise ValueError("modified events require two known, different values")
        event.update({"field": field.strip(), "fromValue": before, "toValue": after})
    source = value.get("source", "")
    if source is not None and (not isinstance(source, str) or len(source) > 160):
        raise ValueError("source must be text up to 160 characters")
    if source:
        event["source"] = source.strip()
    payload = json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    if len(payload.encode("utf-8")) > MAX_HISTORY_EVENT_BYTES:
        raise ValueError("History event exceeds 256 KiB")
    observation_key = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return observation_key, identity, event


def save_resolved_history(path: Path | str, events: Any) -> dict[str, Any]:
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    if not isinstance(events, list) or len(events) > MAX_HISTORY_BATCH:
        raise ValueError(f"events must be an array of at most {MAX_HISTORY_BATCH} records")
    prepared = [_resolved_history_event(event) for event in events]
    now = _now()
    inserted = 0
    duplicates = 0
    source_final_ids = {event["sourceFinalId"] for _, _, event in prepared}
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.execute("PRAGMA busy_timeout=30000")
        with connection:
            if source_final_ids:
                placeholders = ", ".join("?" for _ in source_final_ids)
                known_final_ids = {
                    str(row[0]) for row in connection.execute(
                        f"SELECT id FROM snapshots WHERE id IN ({placeholders})", tuple(source_final_ids),
                    )
                }
                missing_final_ids = source_final_ids - known_final_ids
                if missing_final_ids:
                    raise ValueError("sourceFinalId must reference an existing snapshot")
            for observation_key, identity, event in prepared:
                cursor = connection.execute(
                    "INSERT OR IGNORE INTO resolved_device_history "
                    "(observation_key, internal_device_id, source, payload_json, recorded_at, source_final_id) VALUES (?, ?, ?, ?, ?, ?)",
                    (observation_key, identity, event.get("source", ""),
                     json.dumps(event, ensure_ascii=False, separators=(",", ":")), event["observedAt"], event["sourceFinalId"]),
                )
                if cursor.rowcount:
                    inserted += 1
                else:
                    duplicates += 1
    return {"insertedCount": inserted, "duplicateCount": duplicates, "updatedAt": now}


def _history_read_projection(event: dict[str, Any], row: sqlite3.Row) -> dict[str, Any]:
    """Project a stored History event like the browser without changing its row."""
    projection_input = dict(event)
    projection_input["internalDeviceId"] = str(row["internal_device_id"])
    event["internalDeviceId"] = str(row["internal_device_id"])
    try:
        _, normalized = _device_api_record(projection_input)
    except (TypeError, ValueError, RecursionError):
        normalized = None
    if normalized is not None:
        event.update({key: normalized[key] for key in DEVICE_NORMALIZED_FIELDS if key in normalized})
    normalized_at = _browser_normalize_date(event.get("observedAt") or row["recorded_at"])
    if normalized_at:
        event["observedAt"] = normalized_at
    if row["source_final_id"]:
        event["sourceFinalId"] = str(row["source_final_id"])
    return event


def list_resolved_history(path: Path | str, *, after: int = 0, limit: int = 100) -> dict[str, Any]:
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    if isinstance(after, bool) or not isinstance(after, int) or after < 0:
        raise ValueError("after must be a non-negative history cursor")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_HISTORY_BATCH:
        raise ValueError(f"limit must be between 1 and {MAX_HISTORY_BATCH}")
    events: list[dict[str, Any]] = []
    response_bytes = 0
    last_id = 0
    has_more = False
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        total = int(connection.execute("SELECT COUNT(*) FROM resolved_device_history").fetchone()[0])
        cursor = connection.execute(
            "SELECT id, internal_device_id, source, source_final_id, "
            "CASE WHEN length(CAST(payload_json AS BLOB)) <= ? THEN payload_json ELSE NULL END AS payload_json, recorded_at "
            "FROM resolved_device_history WHERE id > ? ORDER BY id LIMIT ?",
            (MAX_HISTORY_EVENT_BYTES, after, limit + 1),
        )
        while True:
            row = cursor.fetchone()
            if row is None:
                break
            if len(events) >= limit:
                has_more = True
                break
            try:
                event = json.loads(row["payload_json"])
            except (TypeError, ValueError):
                event = None
            if not isinstance(event, dict):
                event = {
                    "internalDeviceId": row["internal_device_id"],
                    "source": row["source"] or "",
                    "observedAt": row["recorded_at"],
                    "payloadOmitted": True,
                }
            else:
                event = _history_read_projection(event, row)
            event["id"] = int(row["id"])
            encoded_size = len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if response_bytes + encoded_size + (1 if events else 0) > MAX_HISTORY_RESPONSE_BYTES - 512:
                if not events:
                    raise ValueError("A history response exceeds the 1 MiB page limit")
                has_more = True
                break
            events.append(event)
            response_bytes += encoded_size + (1 if len(events) > 1 else 0)
            last_id = int(row["id"])
    return {"events": events, "total": total, "nextCursor": last_id if has_more and last_id else None}


def list_resolved_history_for_mac(
    path: Path | str, mac: str, *, after: int = 0, limit: int = 100,
) -> dict[str, Any]:
    """Read exact-MAC History pages using the MAC expression and identity indexes."""
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    normalized_mac = _canonical_mac(mac)
    if not normalized_mac:
        raise ValueError("mac must be a valid MAC address")
    if isinstance(after, bool) or not isinstance(after, int) or after < 0:
        raise ValueError("after must be a non-negative history cursor")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_HISTORY_BATCH:
        raise ValueError(f"limit must be between 1 and {MAX_HISTORY_BATCH}")

    mac_expression = (
        "CASE WHEN json_valid(payload_json) THEN "
        "replace(replace(replace(replace(upper(json_extract(payload_json, '$.mac')), ':', ''), '-', ''), '.', ''), ' ', '') "
        "ELSE '' END"
    )
    legacy_mac_fields = tuple(field for field in _DEVICE_SEARCH_MAC_FIELDS if field != "alternateMacs")
    def json_text(path: str) -> str:
        value = f"json_extract(payload_json, '$.{path}')"
        return f"CASE WHEN typeof({value}) IN ('integer', 'real') THEN printf('%.0f', {value}) ELSE CAST({value} AS TEXT) END"

    legacy_mac_expressions = [
        f"CASE WHEN json_valid(payload_json) THEN replace(replace(replace(replace(upper({json_text(field)}), ':', ''), '-', ''), '.', ''), ' ', '') ELSE '' END = ?"
        for field in legacy_mac_fields
    ]
    alternate_mac_match = (
        "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(payload_json) "
        "AND json_type(payload_json, '$.alternateMacs') = 'array' "
        "THEN json_extract(payload_json, '$.alternateMacs') ELSE '[]' END) AS alternate "
        "WHERE replace(replace(replace(replace(upper(CASE WHEN typeof(alternate.value) IN ('integer', 'real') "
        "THEN printf('%.0f', alternate.value) ELSE CAST(alternate.value AS TEXT) END), ':', ''), '-', ''), '.', ''), ' ', '') = ?)"
    )
    packed_alternate_mac_match = (
        "EXISTS (WITH RECURSIVE alternate_parts(value, rest) AS ("
        "SELECT '', CASE WHEN json_valid(payload_json) AND json_type(payload_json, '$.alternateMacs') = 'text' "
        "THEN json_extract(payload_json, '$.alternateMacs') || ',' ELSE '' END "
        "UNION ALL SELECT substr(rest, 1, instr(rest, ',') - 1), substr(rest, instr(rest, ',') + 1) "
        "FROM alternate_parts WHERE rest <> ''"
        ") SELECT 1 FROM alternate_parts "
        "WHERE replace(replace(replace(replace(upper(CAST(value AS TEXT)), ':', ''), '-', ''), '.', ''), ' ', '') = ?)"
    )
    legacy_match = " OR ".join([*legacy_mac_expressions, alternate_mac_match, packed_alternate_mac_match])
    matching_ids = (
        "SELECT id FROM resolved_device_history WHERE (" + mac_expression + " = ? OR " + legacy_match + ") "
        "UNION SELECT history.id FROM resolved_device_history AS history "
        "JOIN resolved_device_identity_aliases AS alias "
        "ON alias.internal_device_id = history.internal_device_id "
        "WHERE alias.identity_type = 'mac' AND alias.identity_value = ?"
    )
    events: list[dict[str, Any]] = []
    response_bytes = 0
    last_id = 0
    has_more = False
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        total = int(connection.execute(
            f"SELECT COUNT(*) FROM ({matching_ids})",
            (normalized_mac, *([normalized_mac] * (len(legacy_mac_expressions) + 2)), normalized_mac),
        ).fetchone()[0])
        ids = [int(row[0]) for row in connection.execute(
            f"SELECT id FROM ({matching_ids}) WHERE id > ? ORDER BY id LIMIT ?",
            (normalized_mac, *([normalized_mac] * (len(legacy_mac_expressions) + 2)), normalized_mac, after, limit + 1),
        )]
        if len(ids) > limit:
            ids = ids[:limit]
            has_more = True
        if ids:
            placeholders = ",".join("?" for _ in ids)
            rows = connection.execute(
                "SELECT id, internal_device_id, source, source_final_id, "
                "CASE WHEN length(CAST(payload_json AS BLOB)) <= ? THEN payload_json ELSE NULL END AS payload_json, recorded_at "
                f"FROM resolved_device_history WHERE id IN ({placeholders}) ORDER BY id",
                (MAX_HISTORY_EVENT_BYTES, *ids),
            )
            for row in rows:
                try:
                    event = json.loads(row["payload_json"])
                except (TypeError, ValueError):
                    event = None
                if not isinstance(event, dict):
                    event = {
                        "internalDeviceId": row["internal_device_id"],
                        "source": row["source"] or "",
                        "observedAt": row["recorded_at"],
                        "payloadOmitted": True,
                    }
                else:
                    event = _history_read_projection(event, row)
                event["id"] = int(row["id"])
                encoded_size = len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                if response_bytes + encoded_size + (1 if events else 0) > MAX_HISTORY_RESPONSE_BYTES - 512:
                    if not events:
                        raise ValueError("A history response exceeds the 1 MiB page limit")
                    has_more = True
                    break
                events.append(event)
                response_bytes += encoded_size + (1 if len(events) > 1 else 0)
                last_id = int(row["id"])
    return {"events": events, "total": total, "nextCursor": last_id if has_more and last_id else None}


def list_snapshots(path: Path | str, *, after: str = "", limit: int = 100) -> dict[str, Any]:
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    if not isinstance(after, str) or len(after) > 200:
        raise ValueError("after must be a snapshot ID cursor up to 200 characters")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_SNAPSHOT_BATCH:
        raise ValueError(f"limit must be between 1 and {MAX_SNAPSHOT_BATCH}")
    snapshots: list[dict[str, Any]] = []
    response_bytes = 0
    last_id = ""
    has_more = False
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        total = int(connection.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0])
        cursor = connection.execute(
            "SELECT id, name, source, device_count, created_at, signature "
            "FROM snapshots WHERE id > ? ORDER BY id LIMIT ?",
            (after, limit + 1),
        )
        while True:
            row = cursor.fetchone()
            if row is None:
                break
            if len(snapshots) >= limit:
                has_more = True
                break
            snapshot = {
                "id": str(row["id"]), "name": str(row["name"]), "source": str(row["source"] or ""),
                "deviceCount": int(row["device_count"]), "createdAt": str(row["created_at"]),
                "signature": str(row["signature"] or ""),
            }
            encoded_size = len(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if response_bytes + encoded_size + (1 if snapshots else 0) > MAX_SNAPSHOT_RESPONSE_BYTES - 512:
                if not snapshots:
                    raise ValueError("A snapshot metadata response exceeds the 1 MiB page limit")
                has_more = True
                break
            snapshots.append(snapshot)
            response_bytes += encoded_size + (1 if len(snapshots) > 1 else 0)
            last_id = snapshot["id"]
    return {"snapshots": snapshots, "total": total, "nextCursor": last_id if has_more and last_id else None}


def delete_snapshot(path: Path | str, snapshot_id: str) -> dict[str, Any]:
    """Delete one explicitly selected Final copy and its linked History atomically."""
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    if not isinstance(snapshot_id, str) or not snapshot_id.strip() or len(snapshot_id) > 200:
        raise ValueError("snapshot ID must be non-empty text up to 200 characters")
    snapshot_id = snapshot_id.strip()
    try:
        snapshot_id.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("snapshot ID must be valid Unicode text") from error
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.execute("PRAGMA busy_timeout=30000")
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute("SELECT 1 FROM snapshots WHERE id = ?", (snapshot_id,)).fetchone()
            if existing is None:
                raise FileNotFoundError("Optional host snapshot was not found")
            history = connection.execute(
                "DELETE FROM resolved_device_history WHERE source_final_id = ?", (snapshot_id,),
            )
            connection.execute("DELETE FROM snapshot_devices WHERE snapshot_id = ?", (snapshot_id,))
            connection.execute("DELETE FROM snapshot_device_index WHERE snapshot_id = ?", (snapshot_id,))
            connection.execute("DELETE FROM snapshots WHERE id = ?", (snapshot_id,))
    return {
        "ok": True,
        "snapshotId": snapshot_id,
        "deletedSnapshotCount": 1,
        "deletedHistoryCount": max(0, int(history.rowcount)),
        "inventoryPreserved": True,
    }


def list_snapshot_devices(path: Path | str, snapshot_id: str, *, after: int = 0, limit: int = 100) -> dict[str, Any]:
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    if not isinstance(snapshot_id, str) or not snapshot_id.strip() or len(snapshot_id) > 200:
        raise ValueError("snapshot ID must be non-empty text up to 200 characters")
    if isinstance(after, bool) or not isinstance(after, int) or after < 0:
        raise ValueError("after must be a non-negative device offset")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_SNAPSHOT_BATCH:
        raise ValueError(f"limit must be between 1 and {MAX_SNAPSHOT_BATCH}")
    devices: list[dict[str, Any]] = []
    response_bytes = 0
    next_cursor: int | None = None
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT device_count, CASE WHEN json_valid(devices_json) THEN json_type(devices_json) ELSE '' END AS json_type, "
            "CASE WHEN json_valid(devices_json) THEN json_array_length(devices_json) ELSE -1 END AS actual_count "
            "FROM snapshots WHERE id = ?",
            (snapshot_id.strip(),),
        ).fetchone()
        if not row:
            raise FileNotFoundError("Snapshot not found")
        total = int(row["actual_count"])
        if row["json_type"] != "array" or total < 0 or total != int(row["device_count"]):
            raise ValueError("Snapshot device array does not match its metadata")
        indexed_row = connection.execute(
            "SELECT device_count FROM snapshot_device_index WHERE snapshot_id = ?", (snapshot_id.strip(),),
        ).fetchone()
        if indexed_row is not None and int(indexed_row[0]) == total:
            cursor = connection.execute(
                "SELECT ordinal AS device_offset, payload_json AS device_json FROM snapshot_devices "
                "WHERE snapshot_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?",
                (snapshot_id.strip(), after, limit + 1),
            )
        else:
            # Keep source-compatible access for damaged or legacy rows that could not be normalized.
            cursor = connection.execute(
                "SELECT CAST(item.key AS INTEGER) AS device_offset, item.value AS device_json "
                "FROM snapshots AS snapshot, json_each(snapshot.devices_json) AS item "
                "WHERE snapshot.id = ? AND CAST(item.key AS INTEGER) >= ? "
                "ORDER BY CAST(item.key AS INTEGER) LIMIT ?",
                (snapshot_id.strip(), after, limit + 1),
            )
        while True:
            item = cursor.fetchone()
            if item is None:
                break
            if len(devices) >= limit:
                next_cursor = int(item["device_offset"])
                break
            try:
                device = json.loads(item["device_json"])
            except (TypeError, ValueError) as error:
                raise ValueError("Snapshot contains invalid device JSON") from error
            if not isinstance(device, dict):
                raise ValueError("Snapshot devices must be JSON objects")
            encoded_size = len(json.dumps(device, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if response_bytes + encoded_size + (1 if devices else 0) > MAX_SNAPSHOT_RESPONSE_BYTES - 512:
                if not devices:
                    raise ValueError("A snapshot device exceeds the 1 MiB page limit")
                next_cursor = int(item["device_offset"])
                break
            devices.append(device)
            response_bytes += encoded_size + (1 if len(devices) > 1 else 0)
    return {"snapshotId": snapshot_id.strip(), "deviceCount": total, "devices": devices, "nextCursor": next_cursor}


def _unique_json_object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Snapshot NDJSON objects cannot contain duplicate keys")
        result[key] = value
    return result


def _snapshot_identity_tokens(device: Mapping[str, Any]) -> set[str]:
    """Return normalized strong identifiers used to reject duplicate Final rows."""
    return {f"{identity_type}:{identity_value}" for identity_type, identity_value in _strong_identity_aliases(device)}


def save_snapshot_stream(path: Path | str, snapshot_id: str, lines: Any) -> dict[str, Any]:
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    if not isinstance(snapshot_id, str) or not snapshot_id.strip() or len(snapshot_id) > 200:
        raise ValueError("snapshot ID must be non-empty text up to 200 characters")
    snapshot_id = snapshot_id.strip()
    try:
        snapshot_id.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("snapshot ID must be valid Unicode text") from error
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA temp_store=FILE")
        connection.execute(
            "CREATE TEMP TABLE upload_snapshot_devices (ordinal INTEGER PRIMARY KEY, "
            "identity TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL)"
        )
        connection.execute(
            "CREATE TEMP TABLE upload_snapshot_identity_tokens (token TEXT PRIMARY KEY, ordinal INTEGER NOT NULL)"
        )
        identity_token_batch: list[tuple[str, int]] = []

        def flush_identity_token_batch() -> None:
            if not identity_token_batch:
                return
            try:
                connection.executemany(
                    "INSERT INTO upload_snapshot_identity_tokens (token, ordinal) VALUES (?, ?)",
                    identity_token_batch,
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("Snapshot contains duplicate strong device identities") from error
            identity_token_batch.clear()

        metadata: dict[str, Any] | None = None
        expected_count = -1
        actual_count = 0
        digest = hashlib.sha256()
        for line_number, raw_line in enumerate(lines, start=1):
            if not isinstance(raw_line, bytes):
                raise ValueError("Snapshot NDJSON stream must yield bytes")
            if len(raw_line) > MAX_SNAPSHOT_DEVICE_BYTES + 1:
                raise ValueError("Snapshot NDJSON line exceeds 256 KiB")
            line = raw_line[:-1] if raw_line.endswith(b"\n") else raw_line
            if line.endswith(b"\r"):
                line = line[:-1]
            if not line:
                raise ValueError(f"Snapshot NDJSON line {line_number} is empty")
            try:
                value = json.loads(
                    line.decode("utf-8"),
                    parse_constant=lambda token: (_ for _ in ()).throw(ValueError(token)),
                    object_pairs_hook=_unique_json_object_pairs,
                )
            except (UnicodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
                if "duplicate keys" in str(error):
                    raise ValueError(str(error)) from error
                raise ValueError(f"Snapshot NDJSON line {line_number} is not valid UTF-8 JSON") from error
            if metadata is None:
                if not isinstance(value, dict) or value.get("type") != "snapshot":
                    raise ValueError("The first NDJSON line must contain snapshot metadata")
                if value.get("id") != snapshot_id:
                    raise ValueError("Snapshot metadata ID must match the request path")
                name = value.get("name")
                source = value.get("source", "")
                created_at = value.get("createdAt")
                expected_count = value.get("deviceCount")
                if not isinstance(name, str) or not name.strip() or len(name) > 8192:
                    raise ValueError("Snapshot name must be non-empty text up to 8192 characters")
                if source is not None and (not isinstance(source, str) or len(source) > 8192):
                    raise ValueError("Snapshot source must be text up to 8192 characters")
                try:
                    name.encode("utf-8")
                    (source or "").encode("utf-8")
                except UnicodeEncodeError as error:
                    raise ValueError("Snapshot metadata must be valid Unicode text") from error
                if isinstance(expected_count, bool) or not isinstance(expected_count, int) or not 0 <= expected_count <= MAX_SNAPSHOT_DEVICES:
                    raise ValueError(f"deviceCount must be an integer from 0 to {MAX_SNAPSHOT_DEVICES}")
                if not isinstance(created_at, str) or len(created_at) > 80:
                    raise ValueError("createdAt must be an ISO 8601 date-time with a timezone")
                try:
                    parsed_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                except ValueError as error:
                    raise ValueError("createdAt must be a valid ISO 8601 date-time") from error
                if parsed_at.tzinfo is None or parsed_at.utcoffset() is None:
                    raise ValueError("createdAt must include a timezone")
                metadata = {
                    "name": name.strip(), "source": source.strip() if isinstance(source, str) else "",
                    "createdAt": parsed_at.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z"),
                }
                continue

            if actual_count >= expected_count:
                raise ValueError("Snapshot contains more devices than deviceCount")
            if not isinstance(value, dict):
                raise ValueError("Snapshot devices must be JSON objects")
            for key in (
                "id", "internalDeviceId", "internal_device_id", "deviceId", "device_id", "asset_id",
                "serial", "serialNumber", "serial_number",
                "mac", "macFormatted", "mac_formatted",
            ):
                identifier = value.get(key)
                if identifier is not None and (
                    isinstance(identifier, bool)
                    or not isinstance(identifier, (str, int, float))
                    or isinstance(identifier, float) and not math.isfinite(identifier)
                ):
                    raise ValueError(f"Snapshot {key} must be scalar text")
                if isinstance(identifier, str) and len(identifier) > (200 if key in {"id", "internalDeviceId", "internal_device_id"} else 8192):
                    raise ValueError(f"Snapshot {key} exceeds its length limit")
            identity = _normalized_identity(value)
            if not identity:
                raise ValueError("Every snapshot device requires a strong identity")
            tokens = _snapshot_identity_tokens(value)
            if len(identity_token_batch) + len(tokens) > SNAPSHOT_IDENTITY_TOKEN_BATCH_SIZE:
                flush_identity_token_batch()
            identity_token_batch.extend((token, actual_count) for token in tokens)
            if len(identity_token_batch) >= SNAPSHOT_IDENTITY_TOKEN_BATCH_SIZE:
                flush_identity_token_batch()
            device = dict(value)
            # Persist the same resolved stable ID used by the snapshot index.
            # Empty-marker values such as "Unknown" are truthy strings and used
            # to leak into the payload even though identity resolution correctly
            # selected a Device ID, serial, or MAC fallback.
            device["internalDeviceId"] = identity
            try:
                payload = json.dumps(device, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                encoded = payload.encode("utf-8")
            except (TypeError, ValueError, UnicodeEncodeError) as error:
                raise ValueError("Snapshot devices must contain valid JSON values") from error
            if len(encoded) > MAX_SNAPSHOT_DEVICE_BYTES:
                raise ValueError("Snapshot device exceeds 256 KiB")
            try:
                connection.execute(
                    "INSERT INTO upload_snapshot_devices (ordinal, identity, payload_json) VALUES (?, ?, ?)",
                    (actual_count, identity, payload),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("Snapshot contains duplicate strong device identities") from error
            if actual_count:
                digest.update(b"\n")
            digest.update(encoded)
            actual_count += 1

        if metadata is None:
            raise ValueError("Snapshot upload is missing metadata")
        if actual_count != expected_count:
            raise ValueError(f"Snapshot deviceCount is {expected_count}, but received {actual_count}")
        flush_identity_token_batch()
        signature = digest.hexdigest()
        connection.commit()
        already_exists = False
        try:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT name, source, device_count, created_at, signature FROM snapshots WHERE id = ?",
                (snapshot_id,),
            ).fetchone()
            if existing:
                same_metadata = (
                    str(existing[0]) == metadata["name"]
                    and str(existing[1] or "") == metadata["source"]
                    and int(existing[2]) == actual_count
                    and str(existing[3]) == metadata["createdAt"]
                )
                stored_digest = hashlib.sha256()
                stored_count = 0
                indexed_row = connection.execute(
                    "SELECT device_count FROM snapshot_device_index WHERE snapshot_id = ?", (snapshot_id,),
                ).fetchone()
                if indexed_row is not None and int(indexed_row[0]) == int(existing[2]):
                    stored_cursor = connection.execute(
                        "SELECT payload_json FROM snapshot_devices WHERE snapshot_id = ? ORDER BY ordinal",
                        (snapshot_id,),
                    )
                else:
                    stored_cursor = connection.execute(
                        "SELECT item.value FROM snapshots AS snapshot, json_each(snapshot.devices_json) AS item "
                        "WHERE snapshot.id = ? ORDER BY CAST(item.key AS INTEGER)",
                        (snapshot_id,),
                    )
                for stored_row in stored_cursor:
                    try:
                        stored_device = json.loads(stored_row[0])
                        stored_payload = json.dumps(
                            stored_device, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
                        ).encode("utf-8")
                    except (TypeError, ValueError, UnicodeEncodeError, RecursionError) as error:
                        raise ValueError("Existing snapshot content is invalid") from error
                    if stored_count:
                        stored_digest.update(b"\n")
                    stored_digest.update(stored_payload)
                    stored_count += 1
                stored_signature = str(existing[4] or "")
                existing_content_valid = (
                    stored_count == int(existing[2]) and stored_signature == stored_digest.hexdigest()
                )
                already_exists = (
                    same_metadata and existing_content_valid and stored_signature == signature
                )
                if not already_exists:
                    raise ValueError("A snapshot with this ID already exists and cannot be replaced")
            else:
                connection.execute(
                    "INSERT INTO snapshots (id, name, source, device_count, devices_json, created_at, signature) "
                    "SELECT ?, ?, ?, COUNT(*), json_group_array(json(payload_json)), ?, ? "
                    "FROM (SELECT payload_json FROM upload_snapshot_devices ORDER BY ordinal)",
                    (snapshot_id, metadata["name"], metadata["source"], metadata["createdAt"], signature),
                )
                connection.execute(
                    "INSERT INTO snapshot_devices (snapshot_id, ordinal, identity, payload_json) "
                    "SELECT ?, ordinal, identity, payload_json FROM upload_snapshot_devices ORDER BY ordinal",
                    (snapshot_id,),
                )
                connection.execute(
                    "INSERT INTO snapshot_device_index (snapshot_id, device_count) VALUES (?, ?)",
                    (snapshot_id, actual_count),
                )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    return {
        "snapshotId": snapshot_id, "deviceCount": actual_count,
        "createdAt": metadata["createdAt"], "signature": signature, "alreadyExists": already_exists,
    }


def _database_summary(path: Path | str, *, check_integrity: bool) -> dict[str, Any]:
    database = Path(path).resolve()
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        integrity = "skipped"
        if check_integrity:
            checks = connection.execute("PRAGMA integrity_check(20)").fetchmany(20)
            integrity = " | ".join(str(row[0]) for row in checks) or "unknown"
        tables = [str(row[0]) for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        counts = {
            table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in ("device_inventory", "mac_history", "resolved_device_inventory", "snapshots")
            if table in tables
        }
    return {
        "path": str(database), "integrity": integrity, "tableCount": len(tables), "counts": counts,
        "sizeBytes": database.stat().st_size if database.is_file() else 0,
    }


def database_summary(path: Path | str) -> dict[str, Any]:
    return _database_summary(path, check_integrity=True)


def database_maintenance(
    path: Path | str,
    *,
    integrity: bool = True,
    optimize: bool = True,
    vacuum: bool = False,
) -> dict[str, Any]:
    """Check and optimize the optional-host SQLite copy without changing its records."""
    if not all(isinstance(value, bool) for value in (integrity, optimize, vacuum)):
        raise ValueError("integrity, optimize, and vacuum options must be booleans")
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)

    check_integrity = integrity or vacuum
    before = _database_summary(database, check_integrity=check_integrity)
    integrity_result = before["integrity"]
    can_maintain = integrity_result in {"ok", "skipped"}
    optimized = False
    vacuumed = False
    if can_maintain and (optimize or vacuum):
        with closing(sqlite3.connect(database, timeout=30)) as connection:
            connection.execute("PRAGMA busy_timeout=30000")
            if optimize:
                connection.execute("PRAGMA optimize")
                optimized = True
            if vacuum:
                connection.commit()
                connection.execute("VACUUM")
                vacuumed = True

    after = _database_summary(database, check_integrity=check_integrity)
    return {
        "ok": can_maintain and (not check_integrity or after["integrity"] == "ok"),
        "integrity": integrity_result,
        "afterIntegrity": after["integrity"],
        "optimized": optimized,
        "vacuumed": vacuumed,
        "before": before,
        "after": after,
        "reclaimedBytes": max(0, before["sizeBytes"] - after["sizeBytes"]),
    }
