"""Additive SQLite schema and settings persistence for the optional host."""

from __future__ import annotations

from collections import Counter
from contextlib import closing
import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

REQUIRED_TABLES = (
    "app_settings", "app_autosaves", "engineering_sessions", "vendor_mappings",
    "model_mappings", "mac_history", "device_inventory", "resolved_device_inventory",
    "resolved_device_identity_aliases", "resolved_device_history", "mac_movements", "vendor_model_history", "snapshots",
    "scheduled_tasks", "task_file_queue", "ip_address_mappings", "smartroom_room_mappings",
    "column_preferences", "notification_settings", "api_cache", "app_logs",
    "performance_metrics", "data_quality_reports",
)
DB_SCHEMA_VERSION = 5
MAX_DEVICE_ALTERNATE_MACS = 64

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
        internal_device_id TEXT NOT NULL, source TEXT, payload_json TEXT NOT NULL, recorded_at TEXT NOT NULL)""",
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
    "CREATE INDEX IF NOT EXISTS idx_mac_movements_mac ON mac_movements(mac)",
    "CREATE INDEX IF NOT EXISTS idx_mac_movements_changed_at ON mac_movements(changed_at DESC, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_vendor_model_history_mac ON vendor_model_history(mac)",
    "CREATE INDEX IF NOT EXISTS idx_vendor_model_history_oui ON vendor_model_history(oui)",
    "CREATE INDEX IF NOT EXISTS idx_vendor_model_history_prefix ON vendor_model_history(prefix)",
    "CREATE INDEX IF NOT EXISTS idx_vendor_model_history_observed ON vendor_model_history(observed_at)",
    "CREATE INDEX IF NOT EXISTS idx_snapshots_signature ON snapshots(signature)",
    "CREATE INDEX IF NOT EXISTS idx_task_file_queue_task ON task_file_queue(task_id)",
    "CREATE INDEX IF NOT EXISTS idx_task_file_queue_status ON task_file_queue(status)",
    "CREATE INDEX IF NOT EXISTS idx_data_quality_reports_created ON data_quality_reports(created_at)",
)

MIGRATED_COLUMNS = {
    "mac_history": ("smartroom_id", "hostname", "serial_number", "device_id", "device_name", "field_sources_json", "conflicts_json"),
    "device_inventory": ("hostname", "serial_number", "device_id", "device_name", "field_sources_json", "conflicts_json"),
    "mac_movements": ("ddio_candidate_ip", "ddio_match"),
    "snapshots": ("signature",),
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _normalized_identity(device: Mapping[str, Any]) -> str:
    internal = str(device.get("internalDeviceId") or device.get("internal_device_id") or "").strip()
    if internal:
        return internal
    mac = _primary_mac_identity(device)
    serial = str(device.get("serialNumber") or device.get("serial_number") or "").strip().casefold()
    device_id = str(device.get("deviceId") or device.get("device_id") or "").strip().casefold()
    if device_id:
        strongest = "device:" + device_id
    elif serial:
        strongest = "serial:" + serial
    elif mac:
        strongest = "mac:" + mac
    else:
        alternate_macs = device.get("alternateMacs") or []
        alternate_identity = next((_canonical_mac(value) for value in alternate_macs if isinstance(value, str)), "") if isinstance(alternate_macs, list) else ""
        strongest = "mac:" + alternate_identity if alternate_identity else ""
    if not strongest:
        return ""
    seed = "|" + strongest
    hash_value = 2166136261
    for byte in seed.encode("utf-8"):
        hash_value = ((hash_value ^ byte) * 16777619) & 0xFFFFFFFF
    return f"dev-{hash_value:08x}"


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


def _primary_mac_identity(device: Mapping[str, Any]) -> str:
    return next((_canonical_mac(device.get(key)) for key in ("mac", "macFormatted", "mac_formatted")
                 if _canonical_mac(device.get(key))), "")


def _strong_identity_aliases(device: Mapping[str, Any]) -> set[tuple[str, str]]:
    aliases: set[tuple[str, str]] = set()
    internal = str(device.get("internalDeviceId") or device.get("internal_device_id") or "").strip()
    device_id = str(device.get("deviceId") or device.get("device_id") or "").strip().casefold()
    serial = str(device.get("serialNumber") or device.get("serial_number") or "").strip().casefold()
    if internal:
        aliases.add(("internal", internal))
    if device_id:
        aliases.add(("device", device_id))
    if serial:
        aliases.add(("serial", serial))
    for key in ("mac", "macFormatted", "mac_formatted"):
        mac = _canonical_mac(device.get(key))
        if mac:
            aliases.add(("mac", mac))
    alternate_macs = device.get("alternateMacs")
    if alternate_macs is not None:
        if not isinstance(alternate_macs, list) or any(not isinstance(value, str) for value in alternate_macs):
            raise ValueError("alternateMacs must be an array of text values")
        if len(alternate_macs) > MAX_DEVICE_ALTERNATE_MACS:
            raise ValueError(f"alternateMacs must contain at most {MAX_DEVICE_ALTERNATE_MACS} values")
        aliases.update(("mac", mac) for value in alternate_macs if (mac := _canonical_mac(value)))
    return aliases


def _ensure_columns(connection: sqlite3.Connection) -> None:
    for table, columns in MIGRATED_COLUMNS.items():
        existing = {str(row[1]) for row in connection.execute(f'PRAGMA table_info("{table}")')}
        for column in columns:
            if column not in existing:
                connection.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" TEXT')


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
        previous_key = previous.casefold()
        current_key = current.casefold()
        if previous_key and current_key and previous_key != current_key:
            conflicts.append({"field": field, "existingValue": previous, "incomingValue": current})
    try:
        payload = json.loads(existing["payload_json"])
    except (KeyError, TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    existing_macs = _mac_aliases({
        **payload,
        "mac": existing["mac"] or payload.get("mac"),
        "alternateMacs": payload.get("alternateMacs", []),
    })
    incoming_macs = _mac_aliases(incoming)
    if existing_macs and incoming_macs and existing_macs.isdisjoint(incoming_macs):
        conflicts.append({
            "field": "mac", "existingValue": sorted(existing_macs)[0],
            "incomingValue": sorted(incoming_macs)[0],
        })
    return conflicts


def _mac_aliases(device: Mapping[str, Any]) -> set[str]:
    values = [device.get("mac"), device.get("macFormatted"), device.get("mac_formatted")]
    alternates = device.get("alternateMacs") or []
    if isinstance(alternates, list):
        values.extend(alternates)
    return {mac for value in values if (mac := _canonical_mac(value))}


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
            (internal_id, device["mac"], device["serialNumber"], device["deviceId"], device["hostname"],
             device["smartroomId"], device["room"], device["ip"], device["switchIp"],
             json.dumps(device, ensure_ascii=False, separators=(",", ":")),
             legacy.get("first_seen") or legacy.get("updated_at") or now,
             legacy.get("updated_at") or now, int(legacy.get("seen_count") or 1)),
        )
        _save_identity_aliases(connection, internal_id, device)


def _merge_resolved_inventory_blanks(
    connection: sqlite3.Connection, existing: sqlite3.Row, incoming: Mapping[str, Any]
) -> None:
    """Fill missing legacy fields without replacing any known resolved value."""
    column_values = {
        "mac": incoming.get("mac"), "serial_number": incoming.get("serialNumber"),
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
    if isinstance(payload, dict):
        for key, value in incoming.items():
            if key == "alternateMacs" and isinstance(value, list):
                previous = payload.get(key) if isinstance(payload.get(key), list) else []
                merged_alternates = []
                seen_macs = set()
                for alternate in [*previous, *value]:
                    if not isinstance(alternate, str):
                        continue
                    canonical = _canonical_mac(alternate)
                    alias = canonical or alternate
                    if alias not in seen_macs:
                        seen_macs.add(alias)
                        merged_alternates.append(alternate)
                if merged_alternates != previous:
                    payload[key] = merged_alternates
                continue
            if value and not str(payload.get(key) or "").strip():
                payload[key] = value
        if not payload.get("internalDeviceId"):
            payload["internalDeviceId"] = existing["internal_device_id"]
        serialized_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if serialized_payload != payload_raw:
            updates["payload_json"] = serialized_payload
    if updates:
        assignments = ", ".join(f'"{column}" = ?' for column in updates)
        connection.execute(
            f"UPDATE resolved_device_inventory SET {assignments} WHERE internal_device_id = ?",
            (*updates.values(), existing["internal_device_id"]),
        )


def initialize_database(path: Path | str, backup_directory: Path | str | None = None) -> dict[str, Any]:
    """Create or upgrade the source-compatible schema without replacing user rows."""
    database = Path(path).resolve()
    database.parent.mkdir(parents=True, exist_ok=True)
    existed = database.exists()
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
            if _needs_migration(connection):
                from scripts.optional_backup_store import backup_sqlite_database
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
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    query = "SELECT key, value, updated_at FROM app_settings"
    params: tuple[Any, ...] = ()
    if keys:
        unique = list(dict.fromkeys(key for key in keys if key))
        if not unique:
            return {}
        query += " WHERE key IN (" + ",".join("?" for _ in unique) + ")"
        params = tuple(unique)
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(query + " ORDER BY key", params).fetchall()
    result: dict[str, Any] = {}
    updated_at: dict[str, str] = {}
    for row in rows:
        try:
            result[row["key"]] = json.loads(row["value"])
        except (TypeError, ValueError):
            result[row["key"]] = row["value"]
        updated_at[row["key"]] = row["updated_at"]
    return {"settings": result, "updatedAt": updated_at}


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
    "internalDeviceId", "mac", "macFormatted", "deviceId", "serialNumber", "vendor", "model",
    "ip", "address", "room", "smartroomId", "switchIp", "switchPort", "hostname", "deviceName",
    "source", "sources", "alternateMacs", "customFields", "fieldSources", "conflicts",
)
MAX_DEVICE_BATCH = 500
MAX_DEVICE_RECORD_BYTES = 256 * 1024
MAX_DEVICE_RESPONSE_BYTES = 1024 * 1024
MAX_HISTORY_BATCH = 500
MAX_HISTORY_EVENT_BYTES = 256 * 1024
MAX_HISTORY_RESPONSE_BYTES = 1024 * 1024
MAX_SNAPSHOT_BATCH = 500
MAX_SNAPSHOT_RESPONSE_BYTES = 1024 * 1024
MAX_SNAPSHOT_DEVICES = 150_000
MAX_SNAPSHOT_DEVICE_BYTES = 256 * 1024
HISTORY_EVENT_TYPES = frozenset({"added", "absent", "modified"})
EMPTY_HISTORY_VALUES = frozenset({
    "", "—", "–", "-", "n/a", "na", "null", "none", "не заполнено", "нет данных", "unknown", "неизвестно",
})


def _device_api_record(value: Any) -> tuple[str, dict[str, Any]]:
    if not isinstance(value, dict):
        raise ValueError("Each device must be an object")
    record = {key: value.get(key) for key in DEVICE_API_FIELDS if key in value}
    for key, item in tuple(record.items()):
        if key in {"customFields", "fieldSources"}:
            if item is not None and not isinstance(item, dict):
                raise ValueError(f"{key} must be an object")
        elif key in {"sources", "alternateMacs", "conflicts"}:
            if item is not None and not isinstance(item, list):
                raise ValueError(f"{key} must be an array")
            if key == "alternateMacs" and item is not None and len(item) > MAX_DEVICE_ALTERNATE_MACS:
                raise ValueError(f"alternateMacs must contain at most {MAX_DEVICE_ALTERNATE_MACS} values")
            if key in {"sources", "alternateMacs"} and item is not None and any(
                not isinstance(entry, str) or len(entry) > 8192 for entry in item
            ):
                raise ValueError(f"{key} entries must be text up to 8192 characters")
            if key == "conflicts" and item is not None and any(not isinstance(entry, dict) for entry in item):
                raise ValueError("conflicts entries must be objects")
        elif item is not None and not isinstance(item, (str, int, float, bool)):
            raise ValueError(f"{key} must be a scalar text value")
        if isinstance(item, str) and len(item) > 8192:
            raise ValueError(f"{key} exceeds 8192 characters")
    if "internalDeviceId" in record and isinstance(record["internalDeviceId"], str) and len(record["internalDeviceId"]) > 200:
        raise ValueError("internalDeviceId exceeds 200 characters")
    if not record.get("mac") and record.get("macFormatted"):
        record["mac"] = record["macFormatted"]
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


def save_resolved_devices(path: Path | str, devices: Any) -> dict[str, Any]:
    database = Path(path).resolve()
    if not database.is_file():
        raise FileNotFoundError(database)
    if not isinstance(devices, list) or len(devices) > MAX_DEVICE_BATCH:
        raise ValueError(f"devices must be an array of at most {MAX_DEVICE_BATCH} records")
    prepared = [
        (*_device_api_record(device), bool(
            isinstance(device, dict) and str(device.get("internalDeviceId") or device.get("internal_device_id") or "").strip()
        ))
        for device in devices
    ]
    identity_counts = Counter(identity for identity, _, _ in prepared)
    duplicate_identities = {identity for identity, count in identity_counts.items() if count > 1}
    conflicts: list[dict[str, Any]] = [
        {"internalDeviceId": identity, "reason": "duplicate_strong_identity_in_batch", "count": identity_counts[identity]}
        for identity in sorted(duplicate_identities)
    ]
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
                if conflicting_candidates and (existing is not None or provided_internal_id):
                    conflicts.append({
                        "internalDeviceId": identity, "reason": "conflicting_strong_identity",
                        "candidateInternalDeviceIds": sorted(conflicting_candidates)[:20],
                        "candidateCount": len(conflicting_candidates),
                    })
                    continue
                if existing:
                    mismatches = _strong_identity_conflicts(existing, record)
                    if mismatches:
                        conflicts.append({"internalDeviceId": identity, "reason": "conflicting_strong_identity", "fields": mismatches})
                        continue
                    _merge_resolved_inventory_blanks(connection, existing, record)
                    connection.execute(
                        "UPDATE resolved_device_inventory SET seen_count = seen_count + 1, updated_at = ? "
                        "WHERE internal_device_id = ?", (now, identity),
                    )
                    _save_identity_aliases(connection, identity, record)
                    saved.append(identity)
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
                    mismatches = _strong_identity_conflicts(candidate, record)
                    if mismatches:
                        conflicts.append({
                            "internalDeviceId": identity, "reason": "conflicting_strong_identity",
                            "candidateInternalDeviceId": candidate["internal_device_id"], "fields": mismatches,
                        })
                        continue
                    _merge_resolved_inventory_blanks(connection, candidate, record)
                    connection.execute(
                        "UPDATE resolved_device_inventory SET seen_count = seen_count + 1, updated_at = ? "
                        "WHERE internal_device_id = ?", (now, candidate["internal_device_id"]),
                    )
                    _save_identity_aliases(connection, str(candidate["internal_device_id"]), record)
                    saved.append(str(candidate["internal_device_id"]))
                    continue

                columns = {
                    "mac": record.get("mac") or record.get("macFormatted") or "",
                    "serial_number": record.get("serialNumber") or "",
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
                    "payload_json, first_seen, updated_at, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                    (identity, columns["mac"], columns["serial_number"], columns["device_id"], columns["hostname"],
                     columns["smartroom_id"], columns["room"], columns["ip"], columns["switch_ip"],
                     json.dumps(record, ensure_ascii=False, separators=(",", ":")), now, now),
                )
                _save_identity_aliases(connection, identity, record)
                saved.append(identity)
    return {"saved": saved, "conflicts": conflicts, "savedCount": len(saved), "conflictCount": len(conflicts), "updatedAt": now}


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
    normalized_at = parsed_at.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")

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
        key: item for key, item in normalized_device.items()
        if key not in {"internalDeviceId", "source"}
    })
    if event_type == "modified":
        field = value.get("field")
        before = value.get("fromValue")
        after = value.get("toValue")
        if not isinstance(field, str) or not field.strip() or len(field) > 160:
            raise ValueError("modified events require a field name up to 160 characters")
        if not isinstance(before, str) or not isinstance(after, str):
            raise ValueError("modified events require text fromValue and toValue")
        before = before.strip()
        after = after.strip()
        if (
            before.casefold() in EMPTY_HISTORY_VALUES
            or after.casefold() in EMPTY_HISTORY_VALUES
            or before == after
        ):
            raise ValueError("modified events require two known, different values")
        event.update({"field": field.strip(), "fromValue": before, "toValue": after})
    source = value.get("source", "")
    if source is not None and (not isinstance(source, str) or len(source) > 160):
        raise ValueError("source must be text up to 160 characters")
    if source:
        event["source"] = source.strip()
    payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
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
                    "(observation_key, internal_device_id, source, payload_json, recorded_at) VALUES (?, ?, ?, ?, ?)",
                    (observation_key, identity, event.get("source", ""),
                     json.dumps(event, ensure_ascii=False, separators=(",", ":")), event["observedAt"]),
                )
                if cursor.rowcount:
                    inserted += 1
                else:
                    duplicates += 1
    return {"insertedCount": inserted, "duplicateCount": duplicates, "updatedAt": now}


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
            "SELECT id, internal_device_id, source, "
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
                "internalDeviceId", "internal_device_id", "deviceId", "device_id", "serialNumber", "serial_number",
                "mac", "macFormatted", "mac_formatted",
            ):
                identifier = value.get(key)
                if identifier is not None and (isinstance(identifier, bool) or not isinstance(identifier, (str, int))):
                    raise ValueError(f"Snapshot {key} must be scalar text")
                if isinstance(identifier, str) and len(identifier) > (200 if key in {"internalDeviceId", "internal_device_id"} else 8192):
                    raise ValueError(f"Snapshot {key} exceeds its length limit")
            identity = _normalized_identity(value)
            if not identity:
                raise ValueError("Every snapshot device requires a strong identity")
            for token in _snapshot_identity_tokens(value):
                existing_token = connection.execute(
                    "SELECT ordinal FROM upload_snapshot_identity_tokens WHERE token = ?", (token,)
                ).fetchone()
                if existing_token is not None and int(existing_token[0]) != actual_count:
                    raise ValueError("Snapshot contains duplicate strong device identities")
                if existing_token is None:
                    connection.execute(
                        "INSERT INTO upload_snapshot_identity_tokens (token, ordinal) VALUES (?, ?)",
                        (token, actual_count),
                    )
            device = dict(value)
            if not str(device.get("internalDeviceId") or "").strip():
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
                already_exists = same_metadata and str(existing[4] or "") == signature
                if not already_exists:
                    raise ValueError("A snapshot with this ID already exists and cannot be replaced")
            else:
                connection.execute(
                    "INSERT INTO snapshots (id, name, source, device_count, devices_json, created_at, signature) "
                    "SELECT ?, ?, ?, COUNT(*), json_group_array(json(payload_json)), ?, ? "
                    "FROM (SELECT payload_json FROM upload_snapshot_devices ORDER BY ordinal)",
                    (snapshot_id, metadata["name"], metadata["source"], metadata["createdAt"], signature),
                )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    return {
        "snapshotId": snapshot_id, "deviceCount": actual_count,
        "createdAt": metadata["createdAt"], "signature": signature, "alreadyExists": already_exists,
    }


def database_summary(path: Path | str) -> dict[str, Any]:
    database = Path(path).resolve()
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        tables = [str(row[0]) for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        counts = {
            table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in ("device_inventory", "mac_history", "resolved_device_inventory", "snapshots")
            if table in tables
        }
    return {"path": str(database), "integrity": integrity, "tableCount": len(tables), "counts": counts}
