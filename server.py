#!/usr/bin/env python3
"""Optional loopback host for the autonomous MAC Analyzer Pro Next build.

The optional host serves standalone HTML, local diagnostics, SQLite settings,
bounded resolved-inventory access, and database backups. The browser application
continues to use IndexedDB as its primary database.
"""

from __future__ import annotations

import argparse
import hmac
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlsplit

from scripts.optional_backup_store import backup_sqlite_database, export_app_backup, restore_app_backup
from scripts.optional_storage_paths import initialize_storage
from scripts.optional_sqlite_store import (
    database_summary, initialize_database, list_resolved_devices, load_settings,
    save_resolved_devices, save_settings,
)

APP_NAME = "MAC Analyzer Pro Next"
APP_FILENAME = "MAC-Analyzer-Pro-Next.html"
MAX_SETTINGS_BODY_BYTES = 1024 * 1024


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
            media_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if media_type != "application/json":
                raise ValueError("Content-Type must be application/json")
            raw_length = self.headers.get("Content-Length", "")
            if not raw_length.isdigit():
                raise ValueError("Content-Length is required")
            length = int(raw_length)
            if length > MAX_SETTINGS_BODY_BYTES:
                raise ValueError("Request body exceeds 1 MiB")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Request body ended before Content-Length")
            try:
                return json.loads(raw.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise ValueError("Request body must be valid UTF-8 JSON") from error

        def do_GET(self) -> None:
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
            database_path = getattr(self.server, "database_path", None)
            if route == "/api/database/export":
                backup_directory = getattr(self.server, "backup_directory", None)
                head_request = self.command == "HEAD"
                result = None
                try:
                    if database_path is None or backup_directory is None:
                        raise ValueError("Database or backup directory is unavailable")
                    result = backup_sqlite_database(database_path, backup_directory)
                    source = Path(result["path"]).open("rb")
                except (OSError, sqlite3.Error, ValueError) as error:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
                    return
                try:
                    with source:
                        self.send_response(HTTPStatus.OK)
                        self.send_header("Content-Type", "application/vnd.sqlite3")
                        self.send_header("Content-Length", str(result["bytes"]))
                        self.send_header("Content-Disposition", 'attachment; filename="mac-analyzer-database-backup.db"')
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Content-Type-Options", "nosniff")
                        self.send_header("Referrer-Policy", "no-referrer")
                        self.end_headers()
                        if not head_request:
                            try:
                                while chunk := source.read(64 * 1024):
                                    self.wfile.write(chunk)
                            except OSError:
                                return
                finally:
                    if head_request and result is not None:
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
            route = urlsplit(self.path).path
            if route in {"/api/backup/export", "/api/backup/restore"}:
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
            if (not expected_token or self.client_address[0] != "127.0.0.1"
                    or not hmac.compare_digest(supplied_token, f"Bearer {expected_token}")):
                self._send(HTTPStatus.FORBIDDEN, "text/plain; charset=utf-8", b"Forbidden")
                return

            body = b'{"status":"stopping"}'
            self._send(HTTPStatus.ACCEPTED, "application/json; charset=utf-8", body)
            # BaseServer.shutdown() must run outside the serving thread.
            import threading
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        def do_PUT(self) -> None:
            route = urlsplit(self.path).path
            if route not in {"/api/settings", "/api/devices"}:
                self._method_not_allowed()
                return
            try:
                payload = self._read_json_body()
                database_path = getattr(self.server, "database_path", None)
                if route == "/api/settings":
                    settings = payload.get("settings") if isinstance(payload, dict) else None
                    if not isinstance(settings, dict):
                        raise ValueError("settings must be a JSON object")
                    result = save_settings(database_path, settings)
                else:
                    devices = payload.get("devices") if isinstance(payload, dict) else None
                    result = save_resolved_devices(database_path, devices)
                self._send_json(HTTPStatus.OK, result)
            except (FileNotFoundError, OSError, sqlite3.Error, ValueError) as error:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

        def _method_not_allowed(self) -> None:
            route = urlsplit(self.path).path
            allowed = "GET, HEAD, PUT" if route in {"/api/settings", "/api/devices"} else "GET, HEAD"
            self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
            self.send_header("Allow", allowed)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        do_DELETE = _method_not_allowed
        do_OPTIONS = _method_not_allowed

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent, help="Next project root")
    parser.add_argument("--port", type=int, required=True, help="Previously selected loopback port")
    parser.add_argument("--shutdown-token", required=True, help="One-launch token for the local stop command")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")
    app_file = args.root.resolve() / "dist" / APP_FILENAME
    try:
        handler = create_handler(app_file)
        storage_info = initialize_storage(args.root.resolve())
        database_path = Path(storage_info["layout"]["database"])
        database_info = initialize_database(database_path, Path(storage_info["layout"]["backups"]))
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
