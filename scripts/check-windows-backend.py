"""Run the bundled Windows host in a disposable Unicode path, without a browser."""

from __future__ import annotations

import json
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXECUTABLE = ROOT / "dist" / "MAC-Analyzer-Pro-Next-Host.exe"


def unused_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def request(url: str, *, token: str = "", method: str = "GET") -> tuple[int, bytes]:
    headers = {"Cache-Control": "no-store"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    outgoing = urllib.request.Request(url, data=b"" if method == "POST" else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(outgoing, timeout=1) as response:
            return response.status, response.read(32 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        return error.code, error.read(4096)


def main() -> int:
    if not EXECUTABLE.is_file():
        raise RuntimeError(f"Packaged host executable is missing: {EXECUTABLE}")
    binary = EXECUTABLE.read_bytes()
    if b'level="asInvoker"' not in binary and 'level="asInvoker"'.encode("utf-16le") not in binary:
        raise RuntimeError("Packaged host manifest does not request asInvoker execution.")
    if b'level="requireAdministrator"' in binary or 'level="requireAdministrator"'.encode("utf-16le") in binary:
        raise RuntimeError("Packaged host unexpectedly requests administrator privileges.")

    with tempfile.TemporaryDirectory(prefix="MAC Analyzer Проверка ") as temporary:
        data_root = Path(temporary) / "Папка с пробелами"
        data_root.mkdir()
        port = unused_port()
        token = secrets.token_urlsafe(32)
        base_url = f"http://127.0.0.1:{port}"
        process = subprocess.Popen(
            [str(EXECUTABLE), "--server-mode", "--root", str(data_root), "--port", str(port), "--shutdown-token", token],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 25
            health = None
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    status, body = request(f"{base_url}/api/health")
                    if status == 200:
                        health = json.loads(body.decode("utf-8"))
                        break
                except (OSError, urllib.error.URLError, TimeoutError):
                    time.sleep(0.1)
            if health is None:
                details = process.stderr.read(8192).decode("utf-8", errors="replace") if process.poll() is not None and process.stderr else "health check timed out"
                raise RuntimeError(f"Packaged host did not start: {details}")
            if health.get("status") != "ok" or health.get("application") != "MAC Analyzer Pro Next":
                raise RuntimeError(f"Unexpected packaged host health response: {health!r}")
            status, html = request(f"{base_url}/")
            if status != 200 or b"MAC Analyzer Pro Next" not in html or b"__MAC_ANALYZER_IEEE_REGISTRY__" not in html:
                raise RuntimeError("Packaged host did not serve the embedded autonomous application.")
            if not (data_root / "data" / "databases" / "mac_analyzer_web.db").is_file():
                raise RuntimeError("Packaged host did not initialize its SQLite data under the Unicode app path.")
            status, body = request(f"{base_url}/api/shutdown", token=token, method="POST")
            if status != 202 or json.loads(body.decode("utf-8")).get("status") != "stopping":
                raise RuntimeError("Packaged host did not accept its authenticated shutdown request.")
            process.wait(timeout=8)
            if process.returncode != 0:
                raise RuntimeError(f"Packaged host exited with status {process.returncode}.")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=8)
            if process.stderr:
                process.stderr.close()
    print("Packaged Windows host passed asInvoker, Unicode-path, embedded-HTML, SQLite, health, and authenticated-shutdown checks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
