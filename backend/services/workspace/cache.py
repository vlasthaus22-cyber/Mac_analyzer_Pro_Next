"""Bounded persistent cache for explicitly selected local import files.

Files stay on the same computer in ``data/imports/workspace-cache``. The API
stores opaque-token filenames and returns only bounded metadata; it never logs
file names or contents.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import time
from typing import BinaryIO

MAX_WORKSPACE_FILE_BYTES = 512 * 1024 * 1024
MAX_WORKSPACE_CACHE_BYTES = 2 * 1024 * 1024 * 1024
MAX_WORKSPACE_CACHE_FILES = 100
MAX_NAME_LENGTH = 255
_TOKEN = re.compile(r"^[a-f0-9]{48}$")
_ROLES = {"main", "smartroom", "ddio"}
_EXTENSIONS = {".csv", ".tsv", ".txt", ".json", ".xls", ".xlsx", ".xlsm"}


def _safe_name(name: str) -> str:
    if not isinstance(name, str):
        raise ValueError("File name must be text")
    leaf = name.replace("\\", "/").split("/")[-1]
    leaf = "".join(char for char in leaf if char >= " " and char not in "\x7f\u2028\u2029").strip()
    if not leaf or len(leaf) > MAX_NAME_LENGTH or Path(leaf).suffix.lower() not in _EXTENSIONS:
        raise ValueError("Unsupported workspace file name")
    return leaf


def list_workspace_files(directory: Path | str) -> dict[str, object]:
    root = Path(directory).resolve()
    files: list[dict[str, object]] = []
    total_bytes = 0
    if not root.is_dir():
        return {"files": files, "total": 0, "bytes": 0}
    for metadata_path in root.glob("*.json"):
        token = metadata_path.stem
        if not _TOKEN.fullmatch(token):
            continue
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            content_path = root / f"{token}.bin"
            size = content_path.stat().st_size
            if (not isinstance(metadata, dict) or metadata.get("token") != token
                    or metadata.get("size") != size or metadata.get("role") not in _ROLES):
                continue
        except (OSError, ValueError, TypeError):
            continue
        files.append({key: metadata[key] for key in (
            "token", "name", "role", "type", "lastModified", "size", "sha256", "createdAt",
        )})
        total_bytes += size
    files.sort(key=lambda row: (str(row["createdAt"]), str(row["token"])))
    return {"files": files, "total": len(files), "bytes": total_bytes}


def save_workspace_file(
    directory: Path | str,
    *,
    name: str,
    role: str,
    media_type: str = "",
    last_modified: int = 0,
    source: BinaryIO,
    length: int,
) -> dict[str, object]:
    safe_name = _safe_name(name)
    if role not in _ROLES:
        raise ValueError("Role must be main, smartroom, or ddio")
    if isinstance(length, bool) or not isinstance(length, int) or not 0 <= length <= MAX_WORKSPACE_FILE_BYTES:
        raise ValueError("Workspace file exceeds 512 MiB")
    if isinstance(last_modified, bool) or not isinstance(last_modified, int) or not 0 <= last_modified <= 2**53 - 1:
        raise ValueError("lastModified must be a non-negative safe integer")
    if not isinstance(media_type, str) or len(media_type) > 200 or any(ord(char) < 32 for char in media_type):
        raise ValueError("Invalid workspace file media type")

    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    current = list_workspace_files(root)
    if int(current["total"]) >= MAX_WORKSPACE_CACHE_FILES:
        raise ValueError("Workspace cache already contains 100 files")
    if int(current["bytes"]) + length > MAX_WORKSPACE_CACHE_BYTES:
        raise ValueError("Workspace cache exceeds 2 GiB")

    digest = hashlib.sha256()
    written = 0
    staged_path: Path | None = None
    token = secrets.token_hex(24)
    try:
        with tempfile.NamedTemporaryFile(mode="w+b", dir=root, prefix=".stage-", delete=False) as staged:
            staged_path = Path(staged.name)
            remaining = length
            while remaining:
                block = source.read(min(64 * 1024, remaining))
                if not block:
                    raise ValueError("Workspace upload ended before Content-Length")
                if not isinstance(block, bytes):
                    raise ValueError("Workspace upload must yield binary data")
                written += len(block)
                digest.update(block)
                staged.write(block)
                remaining -= len(block)
            staged.flush()
            os.fsync(staged.fileno())
        content_path = root / f"{token}.bin"
        staged_path.rename(content_path)
        staged_path = None
        metadata: dict[str, object] = {
            "token": token,
            "name": safe_name,
            "role": role,
            "type": media_type,
            "lastModified": last_modified,
            "size": written,
            "sha256": digest.hexdigest(),
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        metadata_path = root / f"{token}.json"
        metadata_temp = root / f".{token}.json.tmp"
        metadata_temp.write_text(json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        metadata_temp.replace(metadata_path)
        return metadata
    except Exception:
        if staged_path is not None:
            staged_path.unlink(missing_ok=True)
        if "metadata_temp" in locals():
            metadata_temp.unlink(missing_ok=True)
        if "content_path" in locals():
            content_path.unlink(missing_ok=True)
        raise


def workspace_file_path(directory: Path | str, token: str) -> tuple[Path, dict[str, object]]:
    if not isinstance(token, str) or not _TOKEN.fullmatch(token):
        raise FileNotFoundError("Workspace file not found")
    root = Path(directory).resolve()
    metadata_path = root / f"{token}.json"
    content_path = root / f"{token}.bin"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if (not isinstance(metadata, dict) or metadata.get("token") != token
                or metadata.get("size") != content_path.stat().st_size):
            raise FileNotFoundError("Workspace file not found")
    except (OSError, ValueError, TypeError) as error:
        raise FileNotFoundError("Workspace file not found") from error
    return content_path, metadata


def delete_workspace_file(directory: Path | str, token: str) -> bool:
    content_path, _ = workspace_file_path(directory, token)
    content_path.unlink()
    (Path(directory).resolve() / f"{token}.json").unlink(missing_ok=True)
    return True
