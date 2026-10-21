"""Read-only diagnostics for the optional loopback host."""

from __future__ import annotations

from pathlib import Path
import sqlite3
from typing import Any

from scripts.optional_sqlite_store import REQUIRED_TABLES


def _status(checks: list[dict[str, str]], check_id: str, title: str, status: str, detail: str) -> None:
    checks.append({"id": check_id, "title": title, "status": status, "detail": detail})


def run_optional_host_diagnostics(
    app_path: Path | str,
    database_path: Path | str | None,
    storage_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Report local application, directory, and SQLite health without writing data."""
    checks: list[dict[str, str]] = []

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
