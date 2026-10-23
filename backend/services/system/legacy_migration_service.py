"""Initialize the optional host's structured storage and additive DB schema."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.services.system.sqlite_store import initialize_database
from backend.services.system.storage_paths import initialize_storage


def initialize_system_storage(root: Path | str) -> tuple[dict[str, Any], Path, dict[str, Any]]:
    storage_info = initialize_storage(root)
    layout = storage_info["layout"]
    database_path = Path(str(layout["database"]))
    backup_path = Path(str(layout["backups"]))
    database_info = initialize_database(database_path, backup_path)
    return storage_info, database_path, database_info
