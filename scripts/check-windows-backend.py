"""Run the bundled Windows host in a disposable Unicode path, without a browser."""

from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ.get("MAC_ANALYZER_DIST_DIR", ROOT / "dist")).resolve()
EXECUTABLE = OUTPUT / "MAC-Analyzer-Pro-Next-Host.exe"


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


def wait_for_health(base_url: str, process: subprocess.Popen | None, timeout: float = 25.0) -> dict | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and (process is None or process.poll() is None):
        try:
            status, body = request(f"{base_url}/api/health")
            if status == 200:
                return json.loads(body.decode("utf-8"))
        except (OSError, urllib.error.URLError, TimeoutError):
            time.sleep(0.1)
    return None


def test_packaged_launcher() -> None:
    with tempfile.TemporaryDirectory(prefix="MAC Analyzer Перенос ") as temporary:
        app_root = Path(temporary) / "Версия приложения с пробелами"
        dist_root = app_root / "dist"
        dist_root.mkdir(parents=True)
        executable = dist_root / EXECUTABLE.name
        shutil.copy2(EXECUTABLE, executable)
        shutil.copy2(OUTPUT / "MAC-Analyzer-Pro-Next.html", dist_root / "MAC-Analyzer-Pro-Next.html")
        state_file = app_root / "служебные данные" / "local-server-port.txt"
        token_file = state_file.with_name("local-server-stop-token.txt")
        command = [
            str(executable), "--root", str(app_root), "--state-file", str(state_file),
            "--no-browser", "--no-console",
        ]
        launcher_log = app_root / "launcher-check.log"
        launcher_log_handle = launcher_log.open("wb")
        launcher = subprocess.Popen(
            command,
            cwd=app_root,
            stdin=subprocess.DEVNULL,
            stdout=launcher_log_handle,
            stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            try:
                launcher.wait(timeout=30)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("Packaged launcher did not return after starting the host.") from error
            finally:
                launcher_log_handle.close()
            if launcher.returncode != 0:
                details = launcher_log.read_text(encoding="utf-8", errors="replace").strip()
                raise RuntimeError(f"Packaged launcher exited with status {launcher.returncode}: {details}")
            if not state_file.is_file():
                raise RuntimeError("Packaged launcher did not persist the selected host port.")
            if not token_file.is_file():
                raise RuntimeError("Packaged launcher did not persist its host stop token.")
            port = int(state_file.read_text(encoding="ascii").strip())
            if not 1024 <= port <= 65535:
                raise RuntimeError(f"Packaged launcher selected an invalid port: {port}.")
            base_url = f"http://127.0.0.1:{port}"
            health = wait_for_health(base_url, None)
            if not health or health.get("status") != "ok" or health.get("application") != "MAC Analyzer Pro Next":
                raise RuntimeError("Packaged launcher did not expose a healthy local host.")
            status, html = request(f"{base_url}/")
            if status != 200 or b"MAC Analyzer Pro Next" not in html or b"__MAC_ANALYZER_IEEE_REGISTRY__" not in html:
                excerpt = html[:240].decode("utf-8", errors="replace")
                raise RuntimeError(f"Packaged launcher host did not serve the autonomous application (HTTP {status}, {len(html)} bytes): {excerpt!r}")
            if not (app_root / "data" / "databases" / "mac_analyzer_web.db").is_file():
                raise RuntimeError("Packaged launcher host did not initialize SQLite beside the relocated package.")

            stop = subprocess.run(
                [str(executable), "--root", str(app_root), "--state-file", str(state_file), "--stop"],
                cwd=app_root,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
            if stop.returncode != 0:
                raise RuntimeError(f"Packaged launcher stop command exited with status {stop.returncode}: {stop.stdout.strip()}")
            if wait_for_health(base_url, None, timeout=2.0) is not None:
                raise RuntimeError("Packaged launcher stop command left its host responding.")
        finally:
            if state_file.is_file() and token_file.is_file():
                try:
                    subprocess.run(
                        [str(executable), "--root", str(app_root), "--state-file", str(state_file), "--stop"],
                        cwd=app_root,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=8,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                        check=False,
                    )
                except (OSError, subprocess.SubprocessError):
                    pass


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
            [str(EXECUTABLE), "--server-mode", "--root", str(data_root), "--port", str(port), f"--shutdown-token={token}"],
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
            status, body = request(f"{base_url}/api/system/diagnostics")
            if status != 200:
                raise RuntimeError(f"Packaged host diagnostics returned HTTP {status}.")
            diagnostics = json.loads(body.decode("utf-8"))
            parity = next((item for item in diagnostics.get("checks", []) if item.get("id") == "host-parity"), None)
            if not parity or parity.get("status") not in {"ok", "warning"} or "Матрица parity:" not in parity.get("detail", ""):
                raise RuntimeError("Packaged host could not read the embedded parity registry.")
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
    test_packaged_launcher()
    print("Packaged Windows host passed direct-server and launcher startup/shutdown checks, including asInvoker, relocated Unicode paths, embedded/portable HTML, SQLite, and health.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
