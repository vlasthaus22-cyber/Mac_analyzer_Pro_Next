"""Windows DPAPI-backed secret storage for optional notification channels.

Secrets are stored as one user-bound encrypted blob outside SQLite, JSON
backups, and portable database archives. This optional host deliberately fails
closed on platforms where the OS protection API is unavailable.
"""

from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
from typing import Any

MAGIC = b"MACANOTIFY1\0"
CHANNELS = {"email", "telegram", "slack"}
MAX_SECRET_FILE_BYTES = 64 * 1024
MAX_SECRET_VALUE_LENGTH = 8_192


def _crypt(data: bytes, protect: bool) -> bytes:
    if os.name != "nt":
        raise OSError("OS-protected notification secrets require Windows DPAPI")
    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    source_buffer = ctypes.create_string_buffer(data)
    source = DataBlob(len(data), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    destination = DataBlob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    function = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    function.argtypes = [
        ctypes.POINTER(DataBlob),
        wintypes.LPCWSTR,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DataBlob),
    ] if protect else [
        ctypes.POINTER(DataBlob),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DataBlob),
    ]
    function.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    if not function(ctypes.byref(source), "MAC Analyzer Pro Next notification secrets" if protect else None, None, None, None, 0, ctypes.byref(destination)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(destination.pbData, destination.cbData)
    finally:
        kernel32.LocalFree(destination.pbData)


def _normalize(values: Any) -> dict[str, dict[str, str]]:
    if not isinstance(values, dict):
        raise ValueError("Notification secrets must be an object")
    result: dict[str, dict[str, str]] = {}
    for channel in CHANNELS:
        record = values.get(channel, {})
        if not isinstance(record, dict):
            raise ValueError("Notification channel secret must be an object")
        normalized = {
            str(key): str(value).strip()
            for key, value in record.items()
            if key in {"password", "botToken", "webhookUrl"} and isinstance(value, str)
        }
        if any(len(value) > MAX_SECRET_VALUE_LENGTH for value in normalized.values()):
            raise ValueError("Notification secret exceeds the size limit")
        if normalized:
            result[channel] = normalized
    return result


def load_secrets(path: Path | str) -> dict[str, dict[str, str]]:
    secret_path = Path(path)
    try:
        encrypted = secret_path.read_bytes()
    except FileNotFoundError:
        return {}
    if len(encrypted) > MAX_SECRET_FILE_BYTES or not encrypted.startswith(MAGIC):
        raise ValueError("Protected notification secret file is invalid")
    try:
        plaintext = _crypt(encrypted[len(MAGIC):], protect=False)
        return _normalize(json.loads(plaintext.decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Protected notification secret file is invalid") from error


def save_secrets(path: Path | str, values: Any) -> dict[str, bool]:
    normalized = _normalize(values)
    secret_path = Path(path)
    secret_path.parent.mkdir(parents=True, exist_ok=True)
    plaintext = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encrypted = MAGIC + _crypt(plaintext, protect=True)
    if len(encrypted) > MAX_SECRET_FILE_BYTES:
        raise ValueError("Protected notification secret file exceeds the size limit")
    temporary = secret_path.with_name(secret_path.name + ".tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(encrypted)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, secret_path)
    finally:
        temporary.unlink(missing_ok=True)
    return {channel: bool(normalized.get(channel)) for channel in sorted(CHANNELS)}
