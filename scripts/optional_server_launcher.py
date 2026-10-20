#!/usr/bin/env python3
"""Start the optional local HTTP host, verify its health, then open the app."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

APP_NAME = "MAC Analyzer Pro Next"
FIRST_PORT = 8765
PORT_COUNT = 32


def state_file() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "MAC Analyzer Pro Next" / "local-server-port.txt"
    return Path.home() / ".mac-analyzer-pro-next" / "local-server-port.txt"


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
        return True


def choose_port(path: Path, *, first_port: int = FIRST_PORT, count: int = PORT_COUNT) -> int:
    if path.exists():
        try:
            saved_port = int(path.read_text(encoding="ascii").strip())
        except (OSError, ValueError) as error:
            raise RuntimeError(f"Saved local-server port file is invalid: {path}") from error
        if not 1024 <= saved_port <= 65535:
            raise RuntimeError(f"Saved local-server port is out of range: {saved_port}")
        return saved_port
    for port in range(first_port, min(first_port + count, 65536)):
        if port_is_free(port):
            return port
    raise RuntimeError(f"No free loopback port in range {first_port}-{first_port + count - 1}")


def health_is_ours(port: int, timeout: float = 0.4) -> bool:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/health", headers={"Cache-Control": "no-store"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read(4096).decode("utf-8"))
        return payload.get("status") == "ok" and payload.get("application") == APP_NAME
    except (OSError, ValueError, urllib.error.URLError):
        return False


def wait_for_health(port: int, process: subprocess.Popen, timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        if health_is_ours(port):
            return True
        time.sleep(0.1)
    return health_is_ours(port)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--state-file", type=Path, default=state_file(), help=argparse.SUPPRESS)
    parser.add_argument("--no-browser", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    root = args.root.resolve()
    app_file = root / "dist" / "MAC-Analyzer-Pro-Next.html"
    if not app_file.is_file():
        parser.exit(1, f"Standalone application not found: {app_file}\nBuild it with pnpm build first.\n")

    state_path = args.state_file.resolve()
    try:
        port = choose_port(state_path)
        url = f"http://127.0.0.1:{port}/"
        if health_is_ours(port):
            if not args.no_browser:
                webbrowser.open(url, new=1, autoraise=True)
            print(url)
            return 0
        if not port_is_free(port):
            parser.exit(1, f"Saved port {port} is occupied by another service. No alternate port was selected to avoid changing the browser database origin.\n")

        server_file = root / "server.py"
        creation_flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
        process = subprocess.Popen(
            [sys.executable, str(server_file), "--root", str(root), "--port", str(port)],
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=None,
            stderr=None,
            creationflags=creation_flags,
        )
        if not wait_for_health(port, process):
            if process.poll() is None:
                process.terminate()
            parser.exit(1, f"The local server did not pass /api/health at {url}; the browser was not opened.\n")
        try:
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text(f"{port}\n", encoding="ascii")
        except OSError:
            if process.poll() is None:
                process.terminate()
            raise
        if not args.no_browser:
            webbrowser.open(url, new=1, autoraise=True)
        print(url)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Cannot start optional local host: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
