"""Additive SQLite schema and settings persistence for the optional host."""

from __future__ import annotations

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
    "resolved_device_history", "mac_movements", "vendor_model_history", "snapshots",
    "scheduled_tasks", "task_file_queue", "ip_address_mappings", "smartroom_room_mappings",
    "column_preferences", "notification_settings", "api_cache", "app_logs",
    "performance_metrics", "data_quality_reports",
)
DB_SCHEMA_VERSION = 4

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
    raw_mac = str(device.get("mac") or device.get("macFormatted") or device.get("mac_formatted") or "").upper()
    match = re.search(r"(?<![0-9A-F])((?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}|(?:[0-9A-F]{4}\.){2}[0-9A-F]{4}|[0-9A-F]{12})(?![0-9A-F])", raw_mac)
    mac = "".join(ch for ch in (match.group(1) if match else raw_mac) if ch in "0123456789ABCDEF")
    if len(mac) == 10:
        mac = "00" + mac
    elif len(mac) == 11:
        mac = "0" + mac
    elif len(mac) == 8:
        mac = "0000" + mac
    serial = str(device.get("serialNumber") or device.get("serial_number") or "").strip().casefold()
    device_id = str(device.get("deviceId") or device.get("device_id") or "").strip().casefold()
    if device_id:
        strongest = "device:" + device_id
    elif serial:
        strongest = "serial:" + serial
    elif len(mac) == 12 and mac not in {"000000000000", "FFFFFFFFFFFF"}:
        strongest = "mac:" + mac
    else:
        strongest = ""
    if not strongest:
        return ""
    seed = "|" + strongest
    hash_value = 2166136261
    for byte in seed.encode("utf-8"):
        hash_value = ((hash_value ^ byte) * 16777619) & 0xFFFFFFFF
    return f"dev-{hash_value:08x}"


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
    for field, column, key in (
        ("mac", "mac", "mac"),
        ("serialNumber", "serial_number", "serialNumber"),
        ("deviceId", "device_id", "deviceId"),
    ):
        previous = str(existing[column] or "").strip()
        current = str(incoming.get(key) or "").strip()
        previous_key = "".join(ch for ch in previous.upper() if ch in "0123456789ABCDEF") if field == "mac" else previous.casefold()
        current_key = "".join(ch for ch in current.upper() if ch in "0123456789ABCDEF") if field == "mac" else current.casefold()
        if previous_key and current_key and previous_key != current_key:
            conflicts.append({"field": field, "existingValue": previous, "incomingValue": current})
    return conflicts


def _shared_strong_identity_rows(connection: sqlite3.Connection, device: Mapping[str, Any]):
    clauses = []
    params: list[str] = []
    for column, value in (("device_id", device.get("deviceId")), ("serial_number", device.get("serialNumber"))):
        normalized = str(value or "").strip()
        if normalized:
            clauses.append(f'lower(trim("{column}")) = lower(?)')
            params.append(normalized)
    mac = "".join(ch for ch in str(device.get("mac") or "").upper() if ch in "0123456789ABCDEF")
    if len(mac) == 12 and mac not in {"000000000000", "FFFFFFFFFFFF"}:
        clauses.append("replace(replace(replace(replace(upper(mac), ':', ''), '-', ''), '.', ''), ' ', '') = ?")
        params.append(mac)
    if not clauses:
        return ()
    query = "SELECT * FROM resolved_device_inventory WHERE " + " OR ".join(clauses)
    return connection.execute(query, params)


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
    with sqlite3.connect(database, timeout=30) as connection:
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
    with sqlite3.connect(database, timeout=30) as connection:
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


def database_summary(path: Path | str) -> dict[str, Any]:
    database = Path(path).resolve()
    with sqlite3.connect(database, timeout=30) as connection:
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
