"""Metadata-only scan of user-selected folders for batch pairing dates."""

from __future__ import annotations

import os
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree


SUPPORTED_SUFFIXES = frozenset({".csv", ".tsv", ".txt", ".json", ".xlsx", ".xlsm", ".xls"})
VALID_ROLES = ("main", "smartroom", "ddio")
MAX_FOLDER_PATH_CHARS = 32_768
MAX_BATCH_FOLDER_FILES = 25_000
MAX_XLSX_METADATA_FILE_BYTES = 64 * 1024 * 1024
MAX_XLSX_CORE_PROPERTIES_BYTES = 1024 * 1024


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def _valid_date(year: str, month: str, day: str, hour: str = "", minute: str = "", second: str = "") -> str:
    try:
        value = datetime(
            int(year), int(month), int(day), int(hour or 0), int(minute or 0), int(second or 0), tzinfo=timezone.utc,
        )
    except (TypeError, ValueError):
        return ""
    return value.isoformat().replace("+00:00", "Z")


def date_from_filename(filename: str) -> str:
    patterns = (
        (r"(?:^|\D)(20\d{2})[-_. ](0?[1-9]|1[0-2])[-_. ](0?[1-9]|[12]\d|3[01])(?:[T _-](\d{1,2})[-_.:](\d{2})(?:[-_.:](\d{2}))?)?(?:\D|$)", (1, 2, 3, 4, 5, 6)),
        (r"(?:^|\D)(0?[1-9]|[12]\d|3[01])[-_. ](0?[1-9]|1[0-2])[-_. ](20\d{2})(?:[T _-](\d{1,2})[-_.:](\d{2})(?:[-_.:](\d{2}))?)?(?:\D|$)", (3, 2, 1, 4, 5, 6)),
        (r"(?:^|\D)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[_-]?(\d{2})(\d{2})(\d{2})?)?(?:\D|$)", (1, 2, 3, 4, 5, 6)),
        (r"(?:^|\D)(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])(20\d{2})(?:[_-]?(\d{2})(\d{2})(\d{2})?)?(?:\D|$)", (3, 2, 1, 4, 5, 6)),
    )
    name = str(filename or "")
    for pattern, order in patterns:
        match = re.search(pattern, name)
        if match:
            result = _valid_date(*(match.group(index) or "" for index in order))
            if result:
                return result
    return ""


def xlsx_creation_date(path: Path) -> str:
    if path.suffix.lower() not in {".xlsx", ".xlsm"}:
        return ""
    try:
        if path.stat().st_size > MAX_XLSX_METADATA_FILE_BYTES:
            return ""
        with zipfile.ZipFile(path) as archive:
            try:
                entry = archive.getinfo("docProps/core.xml")
            except KeyError:
                return ""
            if entry.file_size > MAX_XLSX_CORE_PROPERTIES_BYTES:
                return ""
            with archive.open(entry) as stream:
                content = stream.read(MAX_XLSX_CORE_PROPERTIES_BYTES + 1)
            if len(content) > MAX_XLSX_CORE_PROPERTIES_BYTES:
                return ""
            root = ElementTree.fromstring(content)
    except (OSError, ValueError, zipfile.BadZipFile, ElementTree.ParseError):
        return ""
    for local_name in ("created", "modified"):
        for node in root.iter():
            if node.tag.rsplit("}", 1)[-1].lower() != local_name or not (node.text or "").strip():
                continue
            try:
                parsed = datetime.fromisoformat(node.text.strip().replace("Z", "+00:00"))
            except ValueError:
                continue
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return ""


def observation_date(path: Path) -> dict[str, str]:
    filename_date = date_from_filename(path.name)
    if filename_date:
        return {"date": filename_date, "source": "filename"}
    workbook_date = xlsx_creation_date(path)
    if workbook_date:
        return {"date": workbook_date, "source": "xlsx.created"}
    metadata = path.stat()
    use_creation_time = os.name == "nt" and hasattr(metadata, "st_ctime")
    timestamp = metadata.st_ctime if use_creation_time else metadata.st_mtime
    return {"date": _iso(timestamp), "source": "filesystem.created" if use_creation_time else "filesystem.modified"}


def _list_supported_files(root: Path) -> list[Path]:
    pending = [root]
    files: list[Path] = []
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(Path(entry.path))
                    elif entry.is_file(follow_symlinks=False) and Path(entry.name).suffix.lower() in SUPPORTED_SUFFIXES:
                        files.append(Path(entry.path))
                        if len(files) > MAX_BATCH_FOLDER_FILES:
                            raise ValueError(f"В папке больше {MAX_BATCH_FOLDER_FILES:,} поддерживаемых файлов; укажите более узкую папку")
        except OSError as error:
            raise ValueError("Не удалось просканировать выбранную папку") from error
    return sorted(files, key=lambda item: item.relative_to(root).as_posix().casefold())


def scan_batch_folders(paths: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(paths, dict) or set(paths) - set(VALID_ROLES):
        raise ValueError("Для массового сканирования переданы неизвестные роли папок")
    folders: dict[str, dict[str, Any]] = {}
    files: list[dict[str, Any]] = []
    for role in VALID_ROLES:
        raw_path = paths.get(role, "")
        if not isinstance(raw_path, str) or len(raw_path) > MAX_FOLDER_PATH_CHARS:
            raise ValueError(f"Путь папки {role} имеет неверный формат")
        if not raw_path.strip():
            folders[role] = {"folderName": "", "files": 0}
            continue
        try:
            root = Path(raw_path).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            raise ValueError(f"Папка {role} не найдена") from None
        if not root.is_dir():
            raise ValueError(f"Путь {role} не является папкой")
        selected = _list_supported_files(root)
        if len(files) + len(selected) > MAX_BATCH_FOLDER_FILES:
            raise ValueError(f"Во всех папках больше {MAX_BATCH_FOLDER_FILES:,} поддерживаемых файлов; укажите более узкие папки")
        folders[role] = {"folderName": root.name[:255], "files": len(selected)}
        for path in selected:
            try:
                size = path.stat(follow_symlinks=False).st_size
                date_info = observation_date(path)
                relative_path = path.relative_to(root).as_posix()
            except (OSError, ValueError, OverflowError):
                raise ValueError(f"Не удалось прочитать метаданные файла в папке {role}") from None
            if len(relative_path) > 4096:
                raise ValueError(f"Путь вложенного файла в папке {role} слишком длинный")
            files.append({
                "role": role,
                "name": path.name,
                "relativePath": relative_path,
                "size": size,
                "date": date_info["date"],
                "dateSource": date_info["source"],
            })
    if not any(item["role"] == "main" for item in files):
        raise ValueError("В папке Main нет поддерживаемых CSV/XLSX/JSON файлов")
    return {"folders": folders, "files": files, "supportedExtensions": sorted(SUPPORTED_SUFFIXES)}
