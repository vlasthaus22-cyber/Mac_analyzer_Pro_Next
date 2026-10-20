import json
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import APP_NAME, create_handler  # noqa: E402
from scripts.optional_server_launcher import choose_port, stop_server, stop_token_file  # noqa: E402
from scripts.optional_sqlite_store import initialize_database  # noqa: E402


class OptionalServerTests(unittest.TestCase):
    def test_health_serves_no_store_metadata_without_cors_or_device_data(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            database_path = Path(directory) / "app.db"
            initialize_database(database_path)
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            server.storage_info = {"layout": {"data": "local-data"}, "moved": [], "skipped": []}
            server.database_path = database_path
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)

            connection.request("GET", "/api/health")
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, {
                "status": "ok",
                "application": APP_NAME,
                "mode": "optional-local-http-host",
                "storage": "browser-indexeddb",
            })
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))

            connection.request("GET", "/")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"<h1>local build</h1>")

            connection.request("GET", "/api/storage/structure")
            response = connection.getresponse()
            structure = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(structure["layout"]["data"], "local-data")

            connection.request("GET", "/api/database/summary")
            response = connection.getresponse()
            summary = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(summary["integrity"], "ok")
            self.assertGreaterEqual(summary["tableCount"], 20)

            connection.request("PUT", "/api/settings", body=b'{"settings":{"theme":"dark"}}', headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            saved = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(saved["saved"], ["theme"])

            connection.request("GET", "/api/settings?key=theme")
            response = connection.getresponse()
            settings = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(settings["settings"], {"theme": "dark"})

            connection.request("GET", "/..%2Fsecret.txt")
            response = connection.getresponse()
            self.assertEqual(response.status, 404)
            response.read()

            connection.request("POST", "/api/health", body=b"{}")
            response = connection.getresponse()
            self.assertEqual(response.status, 405)
            self.assertEqual(response.getheader("Allow"), "GET, HEAD")
            response.read()
            connection.request("PUT", "/api/settings", body=b'{"settings":{"too_big":"x"}}', headers={"Content-Length": str(1024 * 1024 + 1)})
            # Avoid transmitting an oversized body in this integration test; malformed framing must be rejected.
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
            connection.close()

    def test_shutdown_requires_token_and_launcher_stops_only_its_host(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            server.shutdown_token = "secret-test-token"
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            state = Path(directory) / "local-server-port.txt"
            state.write_text(f"{server.server_port}\n", encoding="ascii")
            stop_token_file(state).write_text("secret-test-token\n", encoding="ascii")

            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            connection.request("POST", "/api/shutdown", body=b"", headers={"Authorization": "Bearer wrong"})
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            response.read()
            connection.close()
            self.assertTrue(thread.is_alive())

            self.assertEqual(stop_server(state), 0)
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertTrue(state.exists(), "saved origin port is retained for the next start")
            self.assertFalse(stop_token_file(state).exists())

    def test_handler_requires_existing_html_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            non_html = Path(directory) / "app.txt"
            non_html.write_text("no", encoding="utf-8")
            with self.assertRaises(ValueError):
                create_handler(non_html)
            with self.assertRaises(FileNotFoundError):
                create_handler(Path(directory) / "missing.html")

    def test_saved_origin_port_is_reused_and_first_port_selection_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "port.txt"
            state.write_text("18765\n", encoding="ascii")
            self.assertEqual(choose_port(state, first_port=20000, count=2), 18765)
            state.unlink()
            with patch("scripts.optional_server_launcher.port_is_free", side_effect=[False, True]):
                self.assertEqual(choose_port(state, first_port=20000, count=2), 20001)


if __name__ == "__main__":
    unittest.main()
