"""Local JSON application backup helpers for the optional loopback host."""

from __future__ import annotations

import base64
import binascii
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

MAX_BACKUP_BYTES = 512 * 1024
SUPPORTED_BACKUP_VERSION = 1


def _backup_path(directory: Path | str, prefix: str) -> Path:
    requested = Path(directory).expanduser()
    if requested.is_symlink():
        raise ValueError("Backup directory must not be a symbolic link")
    backups = requested.resolve()
    backups.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    return backups / f"{prefix}-{stamp}-{uuid.uuid4().hex}.json"


def _write_backup(directory: Path | str, prefix: str, content: str) -> Path:
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_BACKUP_BYTES:
        raise ValueError("Backup exceeds 512 KiB")
    path = _backup_path(directory, prefix)
    temporary = path.with_name(f".{path.name}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        # Hard-link publication is atomic and fails if an existing backup path
        # somehow collides with the generated unique name.
        os.link(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
    return path


def export_app_backup(state: Mapping[str, Any], backup_directory: Path | str) -> dict[str, Any]:
    if not isinstance(state, Mapping):
        raise ValueError("state must be an object")
    payload = {
        "version": SUPPORTED_BACKUP_VERSION,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "state": dict(state),
    }
    try:
        content = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError("Backup state must contain valid JSON values") from error
    path = _write_backup(backup_directory, "mac-analyzer-backup", content)
    return {
        "filename": "mac-analyzer-backup.json",
        "mimeType": "application/json",
        "content": content,
        "bytes": len(content.encode("utf-8")),
        "storedPath": str(path),
    }


def restore_app_backup(content_base64: str, backup_directory: Path | str) -> dict[str, Any]:
    if not isinstance(content_base64, str) or len(content_base64) > ((MAX_BACKUP_BYTES + 2) // 3) * 4:
        raise ValueError("Invalid backup JSON")
    try:
        raw_bytes = base64.b64decode(content_base64, validate=True)
        if len(raw_bytes) > MAX_BACKUP_BYTES:
            raise ValueError("Backup exceeds 512 KiB")
        raw = raw_bytes.decode("utf-8-sig")
        payload = json.loads(raw)
    except (ValueError, UnicodeError, binascii.Error, json.JSONDecodeError) as error:
        raise ValueError("Invalid backup JSON") from error

    if not isinstance(payload, dict):
        raise ValueError("Backup must contain a state object")
    if isinstance(payload.get("state"), dict):
        version = payload.get("version", 1)
        if not isinstance(version, int) or isinstance(version, bool) or not 0 <= version <= SUPPORTED_BACKUP_VERSION:
            raise ValueError("Unsupported backup version")
        state = payload["state"]
    else:
        version = 0
        state = payload

    path = _write_backup(backup_directory, "restored-backup", raw)
    return {"state": state, "version": version, "bytes": len(raw_bytes), "storedPath": str(path)}
