#!/usr/bin/env python3
"""Optional loopback host for the autonomous MAC Analyzer Pro Next build.

This host serves only the generated standalone HTML and a health endpoint.
Application records remain in the browser's IndexedDB for this HTTP origin.
It does not provide shared SQLite storage or accept imported device data.
"""

from __future__ import annotations

import argparse
import hmac
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from scripts.optional_storage_paths import initialize_storage

APP_NAME = "MAC Analyzer Pro Next"
APP_FILENAME = "MAC-Analyzer-Pro-Next.html"


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

        def _method_not_allowed(self) -> None:
            self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
            self.send_header("Allow", "GET, HEAD")
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        do_PUT = _method_not_allowed
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
        server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Cannot start optional local host: {error}\n")
    server.daemon_threads = True
    server.storage_info = storage_info
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
