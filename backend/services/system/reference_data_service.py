"""Load explicitly installed local reference files into the optional host DB."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_REFERENCE_BYTES = 64 * 1024 * 1024
SUPPORTED_PREFIX_LENGTHS = {6, 7, 8, 9, 10}
REFERENCE_SIGNATURE_KEY = "oui_reference_signature"


def normalize_prefix(value: Any) -> str:
    prefix = re.sub(r"[^0-9A-Fa-f]", "", str(value or "")).upper()
    return prefix if len(prefix) in SUPPORTED_PREFIX_LENGTHS else ""


def _decode(content: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1251", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def parse_oui_reference(content: bytes, filename: str) -> dict[str, str]:
    if not content:
        raise ValueError("OUI reference file is empty")
    if len(content) > MAX_REFERENCE_BYTES:
        raise ValueError("OUI reference file exceeds the 64 MiB limit")
    text = _decode(content)
    mappings: dict[str, str] = {}
    if Path(filename).suffix.lower() == ".csv":
        reader = csv.DictReader(io.StringIO(text))
        headers = {re.sub(r"[^a-z0-9]", "", name.lower()): name for name in (reader.fieldnames or []) if name}
        prefix_header = next((headers[key] for key in ("assignment", "oui", "prefix", "macprefix") if key in headers), None)
        vendor_header = next((headers[key] for key in ("organizationname", "organization", "vendor", "manufacturer") if key in headers), None)
        if prefix_header and vendor_header:
            for row in reader:
                prefix = normalize_prefix(row.get(prefix_header))
                vendor = str(row.get(vendor_header) or "").strip()
                if prefix and vendor:
                    mappings[prefix] = vendor
    if not mappings:
        for line in text.splitlines():
            if "(hex)" in line:
                prefix_text, vendor_text = line.split("(hex)", 1)
            elif "\t" in line:
                prefix_text, vendor_text = line.split("\t", 1)
            elif ";" in line:
                prefix_text, vendor_text = line.split(";", 1)
            else:
                continue
            prefix = normalize_prefix(prefix_text)
            vendor = vendor_text.strip().strip('"')
            if prefix and vendor:
                mappings[prefix] = vendor
    if not mappings:
        raise ValueError("OUI reference contains no valid Assignment/OUI and Organization/Vendor rows")
    return mappings


def sync_oui_reference(database_path: Path | str, reference_directory: Path | str) -> dict[str, Any] | None:
    """Sync the selected host reference file once by content hash, preserving custom mappings."""
    directory = Path(reference_directory)
    source = next((directory / name for name in ("oui.csv", "oui.txt") if (directory / name).is_file()), None)
    if source is None:
        return None
    size = source.stat().st_size
    if size <= 0:
        raise ValueError(f"OUI reference file is empty: {source.name}")
    if size > MAX_REFERENCE_BYTES:
        raise ValueError(f"OUI reference file exceeds the 64 MiB limit: {source.name}")
    content = source.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    signature = f"{source.name}:{len(content)}:{digest}"
    with closing(sqlite3.connect(Path(database_path).resolve(), timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        saved = connection.execute("SELECT value FROM app_settings WHERE key = ?", (REFERENCE_SIGNATURE_KEY,)).fetchone()
        if saved and saved["value"] == signature:
            return {"filename": source.name, "bytes": len(content), "sha256": digest, "inserted": 0, "updated": 0, "preserved": 0, "unchanged": True}
        mappings = parse_oui_reference(content, source.name)
        inserted = updated = preserved = 0
        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        with connection:
            for prefix, vendor in mappings.items():
                existing = connection.execute("SELECT vendor, source FROM vendor_mappings WHERE oui = ?", (prefix,)).fetchone()
                if existing is None:
                    connection.execute(
                        "INSERT INTO vendor_mappings (oui, vendor, source, updated_at) VALUES (?, ?, 'reference', ?)",
                        (prefix, vendor, now),
                    )
                    inserted += 1
                elif str(existing["source"] or "") in {"builtin", "reference"}:
                    if str(existing["vendor"] or "") != vendor or str(existing["source"] or "") != "reference":
                        connection.execute(
                            "UPDATE vendor_mappings SET vendor = ?, source = 'reference', updated_at = ? WHERE oui = ?",
                            (vendor, now, prefix),
                        )
                        updated += 1
                else:
                    preserved += 1
            connection.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (REFERENCE_SIGNATURE_KEY, signature, now),
            )
            connection.execute(
                "INSERT INTO app_logs (action, details, created_at) VALUES (?, ?, ?)",
                ("OUI reference synchronized", json.dumps({"filename": source.name, "bytes": len(content), "sha256": digest, "count": len(mappings), "inserted": inserted, "updated": updated, "preserved": preserved}, ensure_ascii=False), now),
            )
    return {"filename": source.name, "bytes": len(content), "sha256": digest, "count": len(mappings), "inserted": inserted, "updated": updated, "preserved": preserved, "unchanged": False}
