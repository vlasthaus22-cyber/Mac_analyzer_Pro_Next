"""Read-only diagnostics for the optional loopback host."""

from __future__ import annotations

from http.client import HTTPConnection
import json
from pathlib import Path
import sqlite3
from typing import Any

from backend.services.system.parity_service import MAX_PARITY_REGISTRY_BYTES, _check_parity_registry
from backend.services.system.sqlite_store import REQUIRED_TABLES

REQUIRED_OPTIONAL_HOST_FILES = (
    "server.py",
    "START_MAC_ANALYZER_SERVER.cmd",
    "STOP_MAC_ANALYZER_SERVER.cmd",
    "scripts/optional_server_launcher.py",
    "scripts/optional_storage_paths.py",
    "scripts/optional_sqlite_store.py",
    "scripts/optional_backup_store.py",
    "scripts/optional_diagnostics.py",
    "backend/__init__.py",
    "backend/services/__init__.py",
    "backend/services/system/__init__.py",
    "backend/services/system/batch_folder_metadata.py",
    "backend/services/system/storage_paths.py",
    "backend/services/system/sqlite_store.py",
    "backend/services/system/backup_store.py",
    "backend/services/system/diagnostics_service.py",
    "backend/services/system/legacy_migration_service.py",
    "backend/services/system/engineering_service.py",
    "backend/services/system/parity_service.py",
    "backend/services/integrations/__init__.py",
    "backend/services/integrations/external_vendor.py",
    "backend/services/integrations/notification_secrets.py",
    "backend/services/integrations/notifications.py",
)
MAX_DIAGNOSTIC_API_RESPONSE_BYTES = 1024 * 1024
REQUIRED_STORAGE_LAYOUT_KEYS = (
    "root", "data", "databases", "legacy", "backups", "exports", "imports",
    "reference", "runtime", "logs", "config", "database",
)
SUMMARY_COUNT_KEYS = ("device_inventory", "mac_history", "resolved_device_inventory", "snapshots")


def _check_optional_host_api(port: int, path: str) -> tuple[bool, str]:
    connection = HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read(MAX_DIAGNOSTIC_API_RESPONSE_BYTES + 1)
        if response.status != 200:
            return False, f"HTTP {response.status}"
        if len(body) > MAX_DIAGNOSTIC_API_RESPONSE_BYTES:
            return False, "ответ превышает 1 МиБ"
        payload = json.loads(body.decode("utf-8"))
        if path == "/api/health":
            valid = (
                isinstance(payload, dict)
                and payload.get("status") == "ok"
                and isinstance(payload.get("application"), str)
                and bool(payload["application"].strip())
                and payload.get("mode") == "optional-local-http-host"
                and payload.get("storage") == "browser-indexeddb"
            )
        elif path == "/api/storage/structure":
            layout = payload.get("layout") if isinstance(payload, dict) else None
            valid = (
                isinstance(layout, dict)
                and all(isinstance(layout.get(key), str) and layout[key].strip() for key in REQUIRED_STORAGE_LAYOUT_KEYS)
            )
        elif path.startswith("/api/devices?"):
            valid = (
                isinstance(payload, dict)
                and isinstance(payload.get("devices"), list)
                and len(payload["devices"]) <= 1
                and type(payload.get("total")) is int
                and payload["total"] >= 0
                and (payload.get("nextCursor") is None or isinstance(payload.get("nextCursor"), str))
            )
        elif path.startswith("/api/history?"):
            valid = (
                isinstance(payload, dict)
                and isinstance(payload.get("events"), list)
                and len(payload["events"]) <= 1
                and type(payload.get("total")) is int
                and payload["total"] >= 0
                and (payload.get("nextCursor") is None or type(payload.get("nextCursor")) is int)
            )
        elif path.startswith("/api/snapshots?"):
            valid = (
                isinstance(payload, dict)
                and isinstance(payload.get("snapshots"), list)
                and len(payload["snapshots"]) <= 1
                and type(payload.get("total")) is int
                and payload["total"] >= 0
                and (payload.get("nextCursor") is None or isinstance(payload.get("nextCursor"), str))
            )
        elif path == "/api/database/summary":
            counts = payload.get("counts") if isinstance(payload, dict) else None
            valid = (
                isinstance(payload, dict)
                and payload.get("integrity") == "ok"
                and type(payload.get("tableCount")) is int
                and payload["tableCount"] >= len(REQUIRED_TABLES)
                and isinstance(counts, dict)
                and all(type(counts.get(key)) is int and counts[key] >= 0 for key in SUMMARY_COUNT_KEYS)
            )
        else:
            valid = False
        return (True, "API ответил корректным отчётом") if valid else (False, "неверная структура ответа")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return False, f"{type(error).__name__}"
    finally:
        connection.close()


def _status(checks: list[dict[str, str]], check_id: str, title: str, status: str, detail: str) -> None:
    checks.append({"id": check_id, "title": title, "status": status, "detail": detail})


def run_optional_host_diagnostics(
    app_path: Path | str,
    database_path: Path | str | None,
    storage_info: dict[str, Any] | None = None,
    project_root: Path | str | None = None,
    port: int | None = None,
) -> dict[str, Any]:
    """Report local package, directory, and SQLite health without writing data."""
    checks: list[dict[str, str]] = []
    root = Path(project_root) if project_root is not None else Path(__file__).resolve().parents[3]

    try:
        app = Path(app_path)
        size = app.stat().st_size if app.is_file() else 0
        _status(
            checks,
            "host-application",
            "Автономный HTML",
            "ok" if size > 0 else "error",
            f"Файл приложения доступен, размер {size:,} байт." if size > 0 else "Файл приложения отсутствует или пуст.",
        )
    except OSError:
        _status(checks, "host-application", "Автономный HTML", "error", "Файл приложения недоступен для проверки.")

    missing_files = []
    for relative_path in REQUIRED_OPTIONAL_HOST_FILES:
        try:
            available = (root / Path(relative_path)).is_file()
        except (OSError, ValueError):
            available = False
        if not available:
            missing_files.append(relative_path)
    _status(
        checks,
        "host-backend-files",
        "Файлы optional host",
        "error" if missing_files else "ok",
        f"Отсутствуют обязательные файлы: {', '.join(missing_files[:8])}." if missing_files else f"Проверены {len(REQUIRED_OPTIONAL_HOST_FILES)} обязательных backend-файлов.",
    )

    parity_status, parity_detail = _check_parity_registry(root)
    _status(checks, "host-parity", "Parity с источником PyQt", parity_status, parity_detail)

    if isinstance(port, int) and 1 <= port <= 65535:
        api_checks = (
            ("host-api-health", "GET /api/health", "/api/health"),
            ("host-api-storage", "GET /api/storage/structure", "/api/storage/structure"),
            ("host-api-database", "GET /api/database/summary", "/api/database/summary"),
            ("host-api-inventory", "GET /api/devices?limit=1", "/api/devices?limit=1"),
            ("host-api-history", "GET /api/history?limit=1", "/api/history?limit=1"),
            ("host-api-snapshots", "GET /api/snapshots?limit=1", "/api/snapshots?limit=1"),
        )
        for check_id, title, route in api_checks:
            valid, detail = _check_optional_host_api(port, route)
            _status(checks, check_id, title, "ok" if valid else "error", detail)

    layout = storage_info.get("layout") if isinstance(storage_info, dict) else None
    directory_labels = {
        "root": "корень приложения",
        "data": "данные",
        "databases": "базы данных",
        "legacy": "legacy базы",
        "backups": "резервные копии",
        "exports": "экспорты",
        "imports": "импорты",
        "reference": "справочники",
        "runtime": "runtime",
        "logs": "журналы",
        "config": "настройки",
    }
    if not isinstance(layout, dict):
        _status(checks, "host-storage", "Каталоги optional host", "warning", "Сведения о каталогах хранилища недоступны.")
    else:
        unavailable = []
        for key, label in directory_labels.items():
            raw_path = layout.get(key)
            try:
                available = bool(raw_path) and Path(str(raw_path)).is_dir()
            except (OSError, ValueError):
                available = False
            if not available:
                unavailable.append(label)
        _status(
            checks,
            "host-storage",
            "Каталоги optional host",
            "error" if unavailable else "ok",
            f"Недоступны каталоги: {', '.join(unavailable)}." if unavailable else f"Проверены {len(directory_labels)} структурированных каталогов.",
        )

    if not database_path:
        _status(checks, "host-sqlite", "SQLite optional host", "error", "Путь к локальной SQLite-базе недоступен.")
    else:
        try:
            database = Path(database_path).resolve(strict=True)
            if not database.is_file():
                raise FileNotFoundError("Файл базы данных не найден")
            uri = f"{database.as_uri()}?mode=ro"
            connection = sqlite3.connect(uri, uri=True, timeout=5)
            try:
                integrity = str(connection.execute("PRAGMA quick_check").fetchone()[0])
                tables = {
                    str(row[0])
                    for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
                }
                schema_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            finally:
                connection.close()
            missing = sorted(set(REQUIRED_TABLES) - tables)
            healthy = integrity == "ok" and not missing
            detail = f"SQLite quick_check: {integrity}; схема {schema_version}; таблиц {len(tables)}/{len(REQUIRED_TABLES)}."
            if missing:
                detail += f" Нет таблиц: {', '.join(missing[:8])}"
                if len(missing) > 8:
                    detail += f" и ещё {len(missing) - 8}"
                detail += "."
            _status(checks, "host-sqlite", "SQLite optional host", "ok" if healthy else "error", detail)
        except (OSError, ValueError, sqlite3.Error) as error:
            _status(
                checks,
                "host-sqlite",
                "SQLite optional host",
                "error",
                f"База недоступна для read-only проверки ({type(error).__name__}).",
            )

    return {
        "checks": checks,
        "passed": sum(item["status"] == "ok" for item in checks),
        "warnings": sum(item["status"] == "warning" for item in checks),
        "errors": sum(item["status"] == "error" for item in checks),
    }
