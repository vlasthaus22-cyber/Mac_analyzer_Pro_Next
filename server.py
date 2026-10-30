#!/usr/bin/env python3
"""Optional loopback host for the autonomous MAC Analyzer Pro Next build.

The optional host serves standalone HTML, local diagnostics, SQLite settings,
bounded Inventory, History, and snapshot APIs, and database backups. The browser
application continues to use IndexedDB as its primary database.
"""

from __future__ import annotations

import argparse
from contextlib import closing
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sqlite3
import tempfile
from urllib.parse import parse_qs, unquote, urlsplit

from backend.services.system.backup_store import backup_sqlite_database, export_app_backup, restore_app_backup, restore_sqlite_database
from backend.services.system.batch_folder_metadata import scan_batch_folders
from backend.services.system.diagnostics_service import run_optional_host_diagnostics
from backend.services.system.engineering_service import authorize_loopback_shutdown
from backend.services.system.legacy_migration_service import initialize_system_storage
from backend.services.integrations import external_vendor
from backend.services.integrations import notifications
from backend.services.system.sqlite_store import (
    SettingsResponseTooLarge, database_maintenance, database_summary, delete_snapshot, list_resolved_devices, list_resolved_history, list_resolved_history_for_mac, list_snapshot_devices,
    list_snapshots, load_settings, save_resolved_devices, save_resolved_history, save_settings,
    save_snapshot_stream,
)

APP_NAME = "MAC Analyzer Pro Next"
APP_FILENAME = "MAC-Analyzer-Pro-Next.html"
MAX_SETTINGS_BODY_BYTES = 1024 * 1024
MAX_REJECTED_BODY_DRAIN_BYTES = 64 * 1024
MAX_SNAPSHOT_UPLOAD_BYTES = 256 * 1024 * 1024
MAX_DATABASE_RESTORE_BYTES = 512 * 1024 * 1024
MAX_BATCH_FOLDER_METADATA_RESPONSE_BYTES = 8 * 1024 * 1024


def notification_secret_path(server: ThreadingHTTPServer) -> Path:
    storage_info = getattr(server, "storage_info", None)
    layout = storage_info.get("layout", {}) if isinstance(storage_info, dict) else {}
    config_directory = Path(layout.get("config") or Path(layout.get("root") or Path.cwd()) / "config")
    return config_directory / "protected-notification-secrets.dpapi"


def create_handler(app_file: Path):
    app_path = app_file.resolve(strict=True)
    if not app_path.is_file() or app_path.suffix.lower() != ".html":
        raise ValueError("Standalone application must be an existing HTML file")

    class Handler(BaseHTTPRequestHandler):
        server_version = "MACAnalyzerNextLocal/1.0"

        def log_message(self, _format: str, *args: object) -> None:
            # Do not log request paths or browser queries; the host has no access log.
            return

        def _send(self, status: HTTPStatus, content_type: str, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if self.close_connection:
                self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _send_json(self, status: HTTPStatus, value: object) -> None:
            body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self._send(status, "application/json; charset=utf-8", body)

        def _read_json_body(self) -> object:
            raw_length = self.headers.get("Content-Length", "")
            if not raw_length.isdigit():
                self.close_connection = True
                raise ValueError("Content-Length is required")
            length = int(raw_length)
            if length > MAX_SETTINGS_BODY_BYTES:
                self.close_connection = True
                raise ValueError("Request body exceeds 1 MiB")
            raw = self.rfile.read(length)
            if len(raw) != length:
                self.close_connection = True
                raise ValueError("Request body ended before Content-Length")
            media_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if media_type != "application/json":
                raise ValueError("Content-Type must be application/json")
            try:
                return json.loads(raw.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise ValueError("Request body must be valid UTF-8 JSON") from error

        def _request_origin_is_local(self) -> bool:
            origins = self.headers.get_all("Origin", [])
            if not origins:
                return True
            if len(origins) != 1:
                return False
            origin = origins[0].strip()
            if not origin:
                return False
            parsed = urlsplit(origin)
            try:
                port = parsed.port
            except ValueError:
                return False
            return (
                parsed.scheme == "http"
                and parsed.hostname in {"127.0.0.1", "localhost"}
                and port == self.server.server_port
                and not parsed.username
                and not parsed.password
                and not parsed.path
                and not parsed.query
                and not parsed.fragment
            )

        def _request_host_is_local(self) -> bool:
            hosts = self.headers.get_all("Host", [])
            if len(hosts) != 1:
                return False
            authority = hosts[0].strip()
            if not authority:
                return False
            parsed = urlsplit(f"//{authority}")
            try:
                port = parsed.port
            except ValueError:
                return False
            return (
                parsed.hostname in {"127.0.0.1", "localhost"}
                and port == self.server.server_port
                and not parsed.username
                and not parsed.password
                and not parsed.path
                and not parsed.query
                and not parsed.fragment
            )

        def _reject_nonlocal_host(self) -> bool:
            if self._request_host_is_local():
                return False
            self._discard_rejected_request_body()
            self.close_connection = True
            self._send_json(HTTPStatus.MISDIRECTED_REQUEST, {"error": "Запрос должен быть адресован локальному MAC Analyzer Pro Next"})
            return True

        def _reject_nonlocal_origin(self) -> bool:
            if self._request_origin_is_local():
                return False
            self._discard_rejected_request_body()
            self.close_connection = True
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Изменение локальных данных разрешено только с этой же локальной страницы"})
            return True

        def _discard_rejected_request_body(self) -> None:
            """Drain a small framed body before closing a rejected keep-alive request."""
            if self.headers.get("Transfer-Encoding"):
                self.close_connection = True
                return
            raw_length = self.headers.get("Content-Length", "")
            if not raw_length:
                return
            if not raw_length.isdigit():
                self.close_connection = True
                return
            remaining = int(raw_length)
            if remaining > MAX_REJECTED_BODY_DRAIN_BYTES:
                self.close_connection = True
                return

            previous_timeout = self.connection.gettimeout()
            try:
                self.connection.settimeout(1.0)
                while remaining:
                    chunk = self.rfile.read(min(remaining, 16 * 1024))
                    if not chunk:
                        self.close_connection = True
                        return
                    remaining -= len(chunk)
            except OSError:
                self.close_connection = True
            finally:
                try:
                    self.connection.settimeout(previous_timeout)
                except OSError:
                    self.close_connection = True

        def _stage_snapshot_body(self, destination) -> int:
            transfer_encoding = self.headers.get("Transfer-Encoding", "").strip().lower()
            raw_length = self.headers.get("Content-Length", "")
            if transfer_encoding:
                if transfer_encoding != "chunked" or raw_length:
                    self.close_connection = True
                    raise ValueError("Snapshot upload requires either Content-Length or chunked transfer encoding")
                total = 0
                while True:
                    size_line = self.rfile.readline(129)
                    if len(size_line) > 128 or not size_line.endswith(b"\r\n"):
                        self.close_connection = True
                        raise ValueError("Invalid chunked snapshot upload framing")
                    size_text = size_line[:-2]
                    if b";" in size_text:
                        size_text = size_text.split(b";", 1)[0]
                    if not size_text or any(byte not in b"0123456789abcdefABCDEF" for byte in size_text):
                        self.close_connection = True
                        raise ValueError("Invalid chunk size in snapshot upload")
                    size = int(size_text, 16)
                    if size == 0:
                        trailer_bytes = 0
                        while True:
                            trailer = self.rfile.readline(8193)
                            trailer_bytes += len(trailer)
                            if len(trailer) > 8192 or trailer_bytes > 16_384 or not trailer.endswith(b"\r\n"):
                                self.close_connection = True
                                raise ValueError("Invalid snapshot upload trailers")
                            if trailer == b"\r\n":
                                return total
                            if b":" not in trailer[:-2] or trailer.startswith((b" ", b"\t")):
                                self.close_connection = True
                                raise ValueError("Invalid snapshot upload trailer field")
                    if total + size > MAX_SNAPSHOT_UPLOAD_BYTES:
                        self.close_connection = True
                        raise ValueError("Snapshot upload exceeds 256 MiB")
                    remaining = size
                    while remaining:
                        block = self.rfile.read(min(64 * 1024, remaining))
                        if not block:
                            self.close_connection = True
                            raise ValueError("Snapshot upload ended before its chunk size")
                        destination.write(block)
                        remaining -= len(block)
                        total += len(block)
                    if self.rfile.read(2) != b"\r\n":
                        self.close_connection = True
                        raise ValueError("Invalid chunk boundary in snapshot upload")
            if not raw_length.isdigit():
                self.close_connection = True
                raise ValueError("Content-Length or chunked transfer encoding is required")
            length = int(raw_length)
            if length > MAX_SNAPSHOT_UPLOAD_BYTES:
                self.close_connection = True
                raise ValueError("Snapshot upload exceeds 256 MiB")
            remaining = length
            while remaining:
                block = self.rfile.read(min(64 * 1024, remaining))
                if not block:
                    self.close_connection = True
                    raise ValueError("Snapshot upload ended before Content-Length")
                destination.write(block)
                remaining -= len(block)
            return length

        def do_GET(self) -> None:
            if self._reject_nonlocal_host(): return
            route = urlsplit(self.path).path
            if route == "/api/health":
                payload = json.dumps({
                    "status": "ok",
                    "application": APP_NAME,
                    "mode": "optional-local-http-host",
                    "storage": "browser-indexeddb",
                }, ensure_ascii=False).encode("utf-8")
                self._send(HTTPStatus.OK, "application/json; charset=utf-8", payload)
                return
            if route == "/api/storage/structure":
                storage_info = getattr(self.server, "storage_info", None)
                if storage_info is None:
                    self._send(HTTPStatus.SERVICE_UNAVAILABLE, "application/json; charset=utf-8", b'{"status":"unavailable"}')
                else:
                    body = json.dumps(storage_info, ensure_ascii=False).encode("utf-8")
                    self._send(HTTPStatus.OK, "application/json; charset=utf-8", body)
                return
            if route == "/api/system/diagnostics":
                report = run_optional_host_diagnostics(
                    app_path,
                    getattr(self.server, "database_path", None),
                    getattr(self.server, "storage_info", None),
                    port=self.server.server_port,
                )
                self._send_json(HTTPStatus.OK, report)
                return
            database_path = getattr(self.server, "database_path", None)
            if route == "/api/external-vendor/settings":
                self._send_json(HTTPStatus.OK, {
                    "settings": external_vendor.load_settings(database_path),
                    "providers": external_vendor.provider_options(),
                })
                return
            if route == "/api/notifications/settings":
                self._send_json(HTTPStatus.OK, notifications.settings_payload(
                    database_path, str(notification_secret_path(self.server)),
                ))
                return
            if route == "/api/external-vendor/cache/summary":
                try:
                    with closing(sqlite3.connect(Path(database_path).resolve(), timeout=30)) as connection:
                        total = int(connection.execute(
                            "SELECT COUNT(*) FROM api_cache WHERE cache_key LIKE 'external_vendor:%'"
                        ).fetchone()[0])
                    self._send_json(HTTPStatus.OK, {"total": total})
                except (OSError, sqlite3.Error, TypeError, ValueError) as error:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
                return
            if route == "/api/database/export":
                backup_directory = getattr(self.server, "backup_directory", None)
                head_request = self.command == "HEAD"
                result = None
                try:
                    if database_path is None or backup_directory is None:
                        raise ValueError("Database or backup directory is unavailable")
                    result = backup_sqlite_database(database_path, backup_directory)
                    if head_request:
                        # Remove the generated file before sending the response.
                        # The client can read the headers as soon as end_headers()
                        # flushes them, while this handler is still running.
                        Path(result["path"]).unlink(missing_ok=True)
                        source = None
                    else:
                        source = Path(result["path"]).open("rb")
                except (OSError, sqlite3.Error, ValueError) as error:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
                    return
                try:
                    if source is None:
                        self.send_response(HTTPStatus.OK)
                        self.send_header("Content-Type", "application/vnd.sqlite3")
                        self.send_header("Content-Length", str(result["bytes"]))
                        self.send_header("Content-Disposition", 'attachment; filename="mac-analyzer-database-backup.db"')
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Content-Type-Options", "nosniff")
                        self.send_header("Referrer-Policy", "no-referrer")
                        self.end_headers()
                    else:
                        with source:
                            self.send_response(HTTPStatus.OK)
                            self.send_header("Content-Type", "application/vnd.sqlite3")
                            self.send_header("Content-Length", str(result["bytes"]))
                            self.send_header("Content-Disposition", 'attachment; filename="mac-analyzer-database-backup.db"')
                            self.send_header("Cache-Control", "no-store")
                            self.send_header("X-Content-Type-Options", "nosniff")
                            self.send_header("Referrer-Policy", "no-referrer")
                            self.end_headers()
                            try:
                                while chunk := source.read(64 * 1024):
                                    self.wfile.write(chunk)
                            except OSError:
                                return
                finally:
                    if head_request and result is not None and Path(result["path"]).exists():
                        try:
                            Path(result["path"]).unlink(missing_ok=True)
                        except OSError:
                            pass
                return
            if route == "/api/database/summary":
                try:
                    self._send_json(HTTPStatus.OK, database_summary(database_path))
                except (OSError, sqlite3.Error, ValueError) as error:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
                return
            if route == "/api/settings":
                query = parse_qs(urlsplit(self.path).query)
                keys = [item.strip() for raw in query.get("key", []) for item in raw.split(",") if item.strip()]
                try:
                    self._send_json(HTTPStatus.OK, load_settings(database_path, keys or None))
                except SettingsResponseTooLarge as error:
                    self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": str(error)})
                except (OSError, sqlite3.Error, ValueError) as error:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
                return
            if route == "/api/devices":
                query = parse_qs(urlsplit(self.path).query)
                try:
                    raw_limit = query.get("limit", ["100"])[0]
                    if not raw_limit.isdigit():
                        raise ValueError("limit must be an integer")
                    result = list_resolved_devices(
                        database_path,
                        after=query.get("after", [""])[0],
                        limit=int(raw_limit),
                    )
                    self._send_json(HTTPStatus.OK, result)
                except (FileNotFoundError, OSError, sqlite3.Error, ValueError) as error:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            if route == "/api/history":
                query = parse_qs(urlsplit(self.path).query)
                try:
                    raw_limit = query.get("limit", ["100"])[0]
                    raw_after = query.get("after", ["0"])[0]
                    if not raw_limit.isdigit() or not raw_after.isdigit():
                        raise ValueError("limit and after must be integers")
                    if "mac" in query:
                        result = list_resolved_history_for_mac(
                            database_path, query["mac"][0], after=int(raw_after), limit=int(raw_limit),
                        )
                    else:
                        result = list_resolved_history(database_path, after=int(raw_after), limit=int(raw_limit))
                    self._send_json(HTTPStatus.OK, result)
                except (FileNotFoundError, OSError, sqlite3.Error, ValueError) as error:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            if route == "/api/snapshots":
                query = parse_qs(urlsplit(self.path).query)
                try:
                    raw_limit = query.get("limit", ["100"])[0]
                    if not raw_limit.isdigit():
                        raise ValueError("limit must be an integer")
                    result = list_snapshots(database_path, after=query.get("after", [""])[0], limit=int(raw_limit))
                    self._send_json(HTTPStatus.OK, result)
                except (OSError, sqlite3.Error, ValueError) as error:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            path_parts = route.split("/")
            if len(path_parts) == 5 and path_parts[1:3] == ["api", "snapshots"] and path_parts[4] == "devices":
                query = parse_qs(urlsplit(self.path).query)
                try:
                    raw_limit = query.get("limit", ["100"])[0]
                    raw_after = query.get("after", ["0"])[0]
                    if not raw_limit.isdigit() or not raw_after.isdigit():
                        raise ValueError("limit and after must be integers")
                    result = list_snapshot_devices(database_path, unquote(path_parts[3]), after=int(raw_after), limit=int(raw_limit))
                    self._send_json(HTTPStatus.OK, result)
                except FileNotFoundError as error:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
                except (OSError, sqlite3.Error, ValueError) as error:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            if route not in {"/", f"/{APP_FILENAME}"}:
                self._send(HTTPStatus.NOT_FOUND, "text/plain; charset=utf-8", b"Not found")
                return
            try:
                body = app_path.read_bytes()
            except OSError:
                self._send(HTTPStatus.SERVICE_UNAVAILABLE, "text/plain; charset=utf-8", b"Application artifact is unavailable")
                return
            self._send(HTTPStatus.OK, "text/html; charset=utf-8", body)

        def do_HEAD(self) -> None:
            self.do_GET()

        def do_POST(self) -> None:
            if self._reject_nonlocal_host(): return
            route = urlsplit(self.path).path
            if route == "/api/database/maintenance":
                if self._reject_nonlocal_origin(): return
                try:
                    payload = self._read_json_body()
                    if not isinstance(payload, dict):
                        raise ValueError("Request body must be a JSON object")
                    if set(payload) - {"integrity", "optimize", "vacuum"}:
                        raise ValueError("Unsupported database maintenance option")
                    database_path = getattr(self.server, "database_path", None)
                    result = database_maintenance(
                        database_path,
                        integrity=payload.get("integrity", True),
                        optimize=payload.get("optimize", True),
                        vacuum=payload.get("vacuum", False),
                    )
                    self._send_json(HTTPStatus.OK if result["ok"] else HTTPStatus.CONFLICT, result)
                except ValueError as error:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                except (FileNotFoundError, OSError, sqlite3.Error) as error:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
                return
            if route in {
                "/api/external-vendor/test",
                "/api/external-vendor/lookup",
                "/api/external-vendor/cache/clear",
            }:
                if self._reject_nonlocal_origin(): return
                try:
                    payload = self._read_json_body()
                    if not isinstance(payload, dict):
                        raise ValueError("Request body must be a JSON object")
                    database_path = getattr(self.server, "database_path", None)
                    if route == "/api/external-vendor/test":
                        result = external_vendor.test_vendor_api(
                            database_path, payload.get("mac"), payload.get("forceLive") is True,
                        )
                        status = HTTPStatus.OK if result.get("ok") else HTTPStatus.BAD_GATEWAY
                    elif route == "/api/external-vendor/lookup":
                        result = external_vendor.enrich_macs(database_path, payload.get("macs"), payload.get("lookupBudget"))
                        status = HTTPStatus.OK
                    else:
                        provider = payload.get("provider", "")
                        if not isinstance(provider, str):
                            raise ValueError("provider must be a string")
                        result = {"ok": True, "deleted": external_vendor.clear_cache(database_path, provider)}
                        status = HTTPStatus.OK
                    self._send_json(status, result)
                except ValueError as error:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                except (OSError, sqlite3.Error) as error:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
                return
            if route in {"/api/notifications/test", "/api/notifications/deliver"}:
                if self._reject_nonlocal_origin(): return
                try:
                    payload = self._read_json_body()
                    if not isinstance(payload, dict):
                        raise ValueError("Request body must be a JSON object")
                    database_path = getattr(self.server, "database_path", None)
                    secret_path = str(notification_secret_path(self.server))
                    if route == "/api/notifications/test":
                        result = notifications.send_test(database_path, secret_path, payload.get("channel"))
                        status = HTTPStatus.OK
                    else:
                        event_type = str(payload.get("type") or "")
                        if event_type != "analysis":
                            raise ValueError("Only analysis completion can trigger automatic delivery")
                        result = {"ok": True, "channels": notifications.send_enabled(database_path, secret_path, payload.get("summary"))}
                        status = HTTPStatus.OK
                    self._send_json(status, result)
                except ValueError as error:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                except OSError:
                    self._send_json(HTTPStatus.BAD_GATEWAY, {"error": "Notification delivery failed. Check the saved channel settings."})
                except (sqlite3.Error, TypeError) as error:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
                return
            if route == "/api/batch/folders/scan":
                if self._reject_nonlocal_origin(): return
                try:
                    payload = self._read_json_body()
                    if not isinstance(payload, dict):
                        raise ValueError("Request body must be a JSON object")
                    result = scan_batch_folders(payload.get("paths", {}))
                    body = json.dumps({"ok": True, **result}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                    if len(body) > MAX_BATCH_FOLDER_METADATA_RESPONSE_BYTES:
                        self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Список метаданных папок превышает 8 МиБ; выберите более узкие папки"})
                    else:
                        self._send(HTTPStatus.OK, "application/json; charset=utf-8", body)
                except (OSError, ValueError) as error:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            if route in {"/api/backup/export", "/api/backup/restore"}:
                if self._reject_nonlocal_origin(): return
                try:
                    payload = self._read_json_body()
                    if not isinstance(payload, dict):
                        raise ValueError("Request body must be a JSON object")
                    backup_directory = getattr(self.server, "backup_directory", None)
                    if backup_directory is None:
                        raise ValueError("Backup directory is unavailable")
                    if route == "/api/backup/export":
                        state = payload.get("state", {})
                        if not isinstance(state, dict):
                            raise ValueError("state must be an object")
                        result = export_app_backup(state, backup_directory)
                    else:
                        encoded = payload.get("contentBase64")
                        if not isinstance(encoded, str):
                            raise ValueError("contentBase64 must be a string")
                        result = restore_app_backup(encoded, backup_directory)
                    self._send_json(HTTPStatus.OK, {"ok": True, **result})
                except (OSError, ValueError) as error:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            expected_token = getattr(self.server, "shutdown_token", None)
            supplied_token = self.headers.get("Authorization", "")
            if route != "/api/shutdown":
                self._method_not_allowed()
                return
            if not authorize_loopback_shutdown(self.client_address[0], supplied_token, expected_token):
                self._send(HTTPStatus.FORBIDDEN, "text/plain; charset=utf-8", b"Forbidden")
                return

            body = b'{"status":"stopping"}'
            self._send(HTTPStatus.ACCEPTED, "application/json; charset=utf-8", body)
            # BaseServer.shutdown() must run outside the serving thread.
            import threading
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        def do_PUT(self) -> None:
            if self._reject_nonlocal_host(): return
            route = urlsplit(self.path).path
            path_parts = route.split("/")
            snapshot_upload_id = unquote(path_parts[3]) if len(path_parts) == 4 and path_parts[1:3] == ["api", "snapshots"] else None
            if route not in {"/api/settings", "/api/devices", "/api/history", "/api/database/restore", "/api/external-vendor/settings", "/api/notifications/settings"} and snapshot_upload_id is None:
                self._method_not_allowed()
                return
            if self._reject_nonlocal_origin(): return
            if route == "/api/database/restore":
                staged_path = None
                request_body_consumed = False
                try:
                    media_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                    if media_type != "application/vnd.sqlite3":
                        raise ValueError("Content-Type must be application/vnd.sqlite3")
                    raw_length = self.headers.get("Content-Length", "")
                    if not raw_length.isdigit():
                        raise ValueError("Content-Length is required")
                    length = int(raw_length)
                    if length > MAX_DATABASE_RESTORE_BYTES:
                        raise ValueError("SQLite restore exceeds 512 MiB")
                    backup_directory = getattr(self.server, "backup_directory", None)
                    if backup_directory is None:
                        raise ValueError("Restore directory is unavailable")
                    with tempfile.NamedTemporaryFile(mode="w+b", suffix=".db", delete=False) as staged:
                        staged_path = Path(staged.name)
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(64 * 1024, remaining))
                            if not chunk:
                                raise ValueError("SQLite restore ended before Content-Length")
                            staged.write(chunk)
                            remaining -= len(chunk)
                        staged.flush()
                    request_body_consumed = True
                    result = restore_sqlite_database(staged_path, backup_directory)
                    self._send_json(HTTPStatus.CREATED, {"ok": True, **result})
                except (OSError, sqlite3.Error, ValueError) as error:
                    # Rejected restores can leave request bytes unread (for
                    # example when the media type is unsupported); don't
                    # reuse that HTTP/1.1 connection for another request.
                    if not request_body_consumed:
                        self._discard_rejected_request_body()
                    self.close_connection = True
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                finally:
                    if staged_path is not None:
                        staged_path.unlink(missing_ok=True)
                return
            if snapshot_upload_id is not None:
                try:
                    media_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                    if media_type != "application/x-ndjson":
                        raise ValueError("Content-Type must be application/x-ndjson")
                    database_path = getattr(self.server, "database_path", None)
                    with tempfile.TemporaryFile(mode="w+b") as staged:
                        self._stage_snapshot_body(staged)
                        staged.seek(0)
                        result = save_snapshot_stream(database_path, snapshot_upload_id, staged)
                    status = HTTPStatus.OK if result.get("alreadyExists") else HTTPStatus.CREATED
                    self._send_json(status, result)
                except ValueError as error:
                    status = HTTPStatus.CONFLICT if "cannot be replaced" in str(error) else HTTPStatus.BAD_REQUEST
                    self._send_json(status, {"error": str(error)})
                except (FileNotFoundError, OSError, sqlite3.Error) as error:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            try:
                payload = self._read_json_body()
                database_path = getattr(self.server, "database_path", None)
                if route == "/api/external-vendor/settings":
                    settings = payload.get("settings") if isinstance(payload, dict) else None
                    if not isinstance(settings, dict):
                        raise ValueError("settings must be a JSON object")
                    result = {"settings": external_vendor.save_settings(database_path, settings), "providers": external_vendor.provider_options()}
                elif route == "/api/notifications/settings":
                    channel = payload.get("channel") if isinstance(payload, dict) else None
                    settings = payload.get("settings") if isinstance(payload, dict) else None
                    if not isinstance(channel, str) or not isinstance(settings, dict):
                        raise ValueError("channel and settings are required")
                    result = notifications.update_channel(
                        database_path,
                        str(notification_secret_path(self.server)),
                        channel,
                        settings,
                        payload.get("secret"),
                        payload.get("clearSecret") is True,
                    )
                elif route == "/api/settings":
                    settings = payload.get("settings") if isinstance(payload, dict) else None
                    if not isinstance(settings, dict):
                        raise ValueError("settings must be a JSON object")
                    result = save_settings(database_path, settings)
                else:
                    if route == "/api/devices":
                        devices = payload.get("devices") if isinstance(payload, dict) else None
                        result = save_resolved_devices(database_path, devices)
                    else:
                        events = payload.get("events") if isinstance(payload, dict) else None
                        result = save_resolved_history(database_path, events)
                self._send_json(HTTPStatus.OK, result)
            except (FileNotFoundError, OSError, sqlite3.Error, ValueError) as error:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

        def do_DELETE(self) -> None:
            if self._reject_nonlocal_host(): return
            route = urlsplit(self.path).path
            path_parts = route.split("/")
            if len(path_parts) != 4 or path_parts[1:3] != ["api", "snapshots"]:
                self._method_not_allowed()
                return
            if self._reject_nonlocal_origin(): return
            snapshot_id = unquote(path_parts[3])
            try:
                result = delete_snapshot(getattr(self.server, "database_path", None), snapshot_id)
                self._send_json(HTTPStatus.OK, result)
            except FileNotFoundError as error:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": str(error)})
            except (OSError, sqlite3.Error, ValueError) as error:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

        def _method_not_allowed(self) -> None:
            self._discard_rejected_request_body()
            route = urlsplit(self.path).path
            parts = route.split("/")
            snapshot_upload = len(parts) == 4 and parts[1:3] == ["api", "snapshots"]
            snapshot_delete = len(parts) == 4 and parts[1:3] == ["api", "snapshots"]
            if route in {"/api/external-vendor/test", "/api/external-vendor/lookup", "/api/external-vendor/cache/clear"}:
                allowed = "POST"
            elif route in {"/api/notifications/test", "/api/notifications/deliver"}:
                allowed = "POST"
            elif route == "/api/notifications/settings":
                allowed = "GET, HEAD, PUT"
            elif route == "/api/external-vendor/settings":
                allowed = "GET, HEAD, PUT"
            else:
                allowed = "GET, HEAD, PUT" if route in {"/api/settings", "/api/devices", "/api/history", "/api/database/restore"} or snapshot_upload else "GET, HEAD"
            if snapshot_delete:
                allowed = "PUT, DELETE"
            self.close_connection = True
            self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
            self.send_header("Allow", allowed)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        do_OPTIONS = _method_not_allowed

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent, help="Next project root")
    parser.add_argument("--app-file", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, required=True, help="Previously selected loopback port")
    parser.add_argument("--shutdown-token", required=True, help="One-launch token for the local stop command")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")
    app_file = args.app_file.resolve() if args.app_file else args.root.resolve() / "dist" / APP_FILENAME
    try:
        handler = create_handler(app_file)
        storage_info, database_path, database_info = initialize_system_storage(args.root.resolve())
        storage_info["database"] = database_info
        server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Cannot start optional local host: {error}\n")
    server.daemon_threads = True
    server.storage_info = storage_info
    server.database_path = database_path
    server.backup_directory = Path(storage_info["layout"]["backups"])
    server.shutdown_token = args.shutdown_token
    print(f"Serving {APP_NAME} at http://127.0.0.1:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
