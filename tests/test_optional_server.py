import base64
import json
import sqlite3
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
from scripts.optional_server_launcher import choose_port, health_is_ours, main as launcher_main, stop_server, stop_token_file  # noqa: E402
from scripts.optional_sqlite_store import _normalized_identity, database_summary, initialize_database, save_settings  # noqa: E402
from scripts.optional_storage_paths import initialize_storage  # noqa: E402


class OptionalServerTests(unittest.TestCase):
    def test_launcher_health_probe_connects_directly_to_loopback(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)

            with patch("scripts.optional_server_launcher.urllib.request.urlopen", side_effect=AssertionError("health probes must bypass URL proxy handling")):
                self.assertTrue(health_is_ours(server.server_port))

    def test_read_only_system_diagnostics_route_checks_local_html_storage_and_sqlite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_file = root / "app.html"
            app_file.write_text("<!doctype html><title>local build</title>", encoding="utf-8")
            storage_info = initialize_storage(root)
            database_path = Path(storage_info["layout"]["database"])
            initialize_database(database_path)
            database_bytes = database_path.read_bytes()
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            server.storage_info = storage_info
            server.database_path = database_path
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)

            connection.request("GET", "/api/system/diagnostics")
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))

            self.assertEqual(response.status, 200)
            self.assertEqual(payload["errors"], 0)
            self.assertEqual(payload["warnings"], 0)
            self.assertEqual(payload["passed"], 7)
            api_checks = {item["id"]: item["status"] for item in payload["checks"] if item["id"].startswith("host-api-")}
            self.assertEqual(api_checks, {
                "host-api-health": "ok",
                "host-api-storage": "ok",
                "host-api-database": "ok",
            })
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))
            self.assertNotIn(str(root), json.dumps(payload, ensure_ascii=False))
            self.assertEqual(database_path.read_bytes(), database_bytes)
            connection.close()

    def test_optional_device_api_accepts_strong_identity_batches_and_returns_bounded_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            database_path = Path(directory) / "app.db"
            initialize_database(database_path)
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            server.daemon_threads = False
            server.database_path = database_path
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(thread.join, 2)
            self.addCleanup(server.shutdown)
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            self.addCleanup(connection.close)
            headers = {"Content-Type": "application/json"}

            connection.request("PUT", "/api/devices", body=json.dumps({"devices": [
                {"deviceId": "edge-1", "mac": "00:11:22:33:44:55", "vendor": "Acme"},
                {"serialNumber": "SN-2", "mac": "AA:BB:CC:DD:EE:66", "room": "202"},
            ]}), headers=headers)
            response = connection.getresponse()
            saved = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(saved["savedCount"], 2)
            self.assertEqual(response.getheader("Access-Control-Allow-Origin"), None)

            connection.request("PUT", "/api/devices", body=json.dumps({"devices": [
                {"deviceId": "edge-1", "mac": "00:11:22:33:44:77"},
            ]}), headers=headers)
            response = connection.getresponse()
            conflict = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(conflict["conflicts"][0]["reason"], "conflicting_strong_identity")

            connection.request("GET", "/api/devices?limit=1")
            response = connection.getresponse()
            page1 = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(page1["total"], 2)
            self.assertEqual(len(page1["devices"]), 1)
            self.assertIsNotNone(page1["nextCursor"])
            connection.request("GET", "/api/devices?limit=1&after=" + page1["nextCursor"])
            response = connection.getresponse()
            page2 = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(page2["total"], 2)
            self.assertEqual(len(page2["devices"]), 1)
            self.assertIsNone(page2["nextCursor"])

            connection.request("PUT", "/api/devices", body=b'{"devices":[{"hostname":"no-id"}]}', headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertIn("requires internalDeviceId", response.read().decode("utf-8"))
            connection.close()

    def test_optional_history_api_requires_source_final_is_idempotent_and_pages_events(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            database_path = Path(directory) / "app.db"
            initialize_database(database_path)
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            server.daemon_threads = False
            server.database_path = database_path
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(thread.join, 2)
            self.addCleanup(server.shutdown)
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            self.addCleanup(connection.close)
            headers = {"Content-Type": "application/json"}
            events = [
                {
                    "sourceFinalId": "final-a", "observedAt": "2026-10-21T10:00:00+03:00",
                    "internalDeviceId": "device-a", "eventType": "added", "source": "Main",
                },
                {
                    "sourceFinalId": "final-b", "observedAt": "2026-10-21T10:05:00Z",
                    "mac": "00:11:22:33:44:55", "eventType": "modified", "field": "room",
                    "fromValue": "101", "toValue": "202",
                },
            ]
            with sqlite3.connect(database_path) as sqlite_connection:
                sqlite_connection.executemany(
                    "INSERT INTO snapshots (id, name, device_count, devices_json, created_at) VALUES (?, ?, 0, '[]', ?)",
                    [(f"final-{suffix}", f"Final {suffix}", "2026-10-21T00:00:00Z") for suffix in ("a", "b")],
                )
                sqlite_connection.execute(
                    "UPDATE snapshots SET device_count=2, devices_json=? WHERE id='final-a'",
                    (json.dumps([{"internalDeviceId": "device-a"}, {"internalDeviceId": "device-b"}]),),
                )
            sqlite_connection.close()

            connection.request("GET", "/api/snapshots?limit=1")
            response = connection.getresponse()
            snapshots = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(snapshots["total"], 2)
            self.assertEqual(snapshots["snapshots"][0]["id"], "final-a")
            self.assertEqual(snapshots["nextCursor"], "final-a")
            connection.request("GET", "/api/snapshots/final-a/devices?limit=1")
            response = connection.getresponse()
            device_page1 = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(device_page1["deviceCount"], 2)
            self.assertEqual(device_page1["devices"], [{"internalDeviceId": "device-a"}])
            connection.request("GET", f"/api/snapshots/final-a/devices?limit=1&after={device_page1['nextCursor']}")
            response = connection.getresponse()
            device_page2 = json.loads(response.read().decode("utf-8"))
            self.assertEqual(device_page2["devices"], [{"internalDeviceId": "device-b"}])
            self.assertIsNone(device_page2["nextCursor"])
            connection.request("GET", "/api/snapshots/missing-final/devices")
            response = connection.getresponse()
            self.assertEqual(response.status, 404)
            response.read()

            upload_rows = [
                {
                    "type": "snapshot", "id": "uploaded-final", "name": "Uploaded Final", "source": "Main.csv",
                    "createdAt": "2026-10-21T10:00:00+03:00", "deviceCount": 2,
                },
                {"internalDeviceId": "upload-device-a", "mac": "00:11:22:33:44:51"},
                {"deviceId": "Upload-Device-B", "mac": "00:11:22:33:44:52"},
            ]
            upload_body = "\n".join(json.dumps(row, ensure_ascii=False) for row in upload_rows).encode("utf-8") + b"\n"
            connection.request(
                "PUT", "/api/snapshots/uploaded-final", body=upload_body,
                headers={"Content-Type": "application/x-ndjson"},
            )
            response = connection.getresponse()
            upload_result = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 201)
            self.assertEqual(upload_result["deviceCount"], 2)
            self.assertEqual(len(upload_result["signature"]), 64)
            connection.request("GET", "/api/snapshots/uploaded-final/devices?limit=2")
            response = connection.getresponse()
            uploaded_page = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual([device["internalDeviceId"] for device in uploaded_page["devices"]], [
                "upload-device-a", _normalized_identity({"deviceId": "Upload-Device-B"}),
            ])

            chunked_rows = [
                {
                    "type": "snapshot", "id": "chunked-final", "name": "Chunked Final", "source": "IndexedDB Final",
                    "createdAt": "2026-10-21T10:00:00Z", "deviceCount": 2,
                },
                {"internalDeviceId": "chunked-device-a", "mac": "00:11:22:33:44:71"},
                {"internalDeviceId": "chunked-device-b", "mac": "00:11:22:33:44:72"},
            ]
            chunked_body = ("\n".join(json.dumps(row, ensure_ascii=False) for row in chunked_rows) + "\n").encode("utf-8")
            connection.request(
                "PUT", "/api/snapshots/chunked-final", body=(chunked_body[index:index + 17] for index in range(0, len(chunked_body), 17)),
                headers={"Content-Type": "application/x-ndjson"}, encode_chunked=True,
            )
            response = connection.getresponse()
            chunked_result = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 201)
            self.assertEqual(chunked_result["snapshotId"], "chunked-final")
            self.assertEqual(chunked_result["deviceCount"], 2)
            connection.request("GET", "/api/snapshots/chunked-final/devices?limit=2")
            response = connection.getresponse()
            chunked_page = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual([device["internalDeviceId"] for device in chunked_page["devices"]], ["chunked-device-a", "chunked-device-b"])

            connection.request(
                "PUT", "/api/snapshots/uploaded-final", body=upload_body,
                headers={"Content-Type": "application/x-ndjson"},
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 409)
            response.read()

            conflicting_rows = [
                {"type": "snapshot", "id": "duplicate-device-final", "name": "Duplicate Final",
                 "createdAt": "2026-10-21T10:00:00Z", "deviceCount": 2},
                {"internalDeviceId": "device-a", "deviceId": "shared-id", "mac": "00:11:22:33:44:61"},
                {"internalDeviceId": "device-b", "deviceId": "SHARED-ID", "mac": "00:11:22:33:44:62"},
            ]
            conflicting_body = "\n".join(json.dumps(row) for row in conflicting_rows).encode("utf-8") + b"\n"
            connection.request(
                "PUT", "/api/snapshots/duplicate-device-final", body=conflicting_body,
                headers={"Content-Type": "application/x-ndjson"},
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertIn("duplicate strong", response.read().decode("utf-8"))
            connection.request("GET", "/api/snapshots?limit=10")
            response = connection.getresponse()
            snapshot_page = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertFalse(any(item["id"] == "duplicate-device-final" for item in snapshot_page["snapshots"]))

            body = json.dumps({"events": events})
            connection.request("PUT", "/api/history", body=body, headers=headers)
            response = connection.getresponse()
            saved = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(saved["insertedCount"], 2)
            self.assertEqual(response.getheader("Access-Control-Allow-Origin"), None)

            connection.request("PUT", "/api/history", body=body, headers=headers)
            response = connection.getresponse()
            repeated = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(repeated["insertedCount"], 0)
            self.assertEqual(repeated["duplicateCount"], 2)

            connection.request("GET", "/api/history?limit=1")
            response = connection.getresponse()
            page1 = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(page1["total"], 2)
            self.assertEqual(page1["events"][0]["sourceFinalId"], "final-a")
            connection.request("GET", f"/api/history?limit=1&after={page1['nextCursor']}")
            response = connection.getresponse()
            page2 = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(page2["events"][0]["fromValue"], "101")
            self.assertIsNone(page2["nextCursor"])

            invalid = {"events": [{**events[0], "sourceFinalId": ""}]}
            connection.request("PUT", "/api/history", body=json.dumps(invalid), headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertIn("sourceFinalId", response.read().decode("utf-8"))
            orphan = {"events": [{**events[0], "sourceFinalId": "missing-final"}]}
            connection.request("PUT", "/api/history", body=json.dumps(orphan), headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertIn("existing snapshot", response.read().decode("utf-8"))
            connection.request("GET", "/api/history?limit=10")
            response = connection.getresponse()
            after_orphan = json.loads(response.read().decode("utf-8"))
            self.assertEqual(after_orphan["total"], 2)
            connection.close()

    def test_health_serves_no_store_metadata_without_cors_or_device_data(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            database_path = Path(directory) / "app.db"
            initialize_database(database_path)
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            server.storage_info = {"layout": {"data": "local-data"}, "moved": [], "skipped": []}
            server.database_path = database_path
            server.backup_directory = Path(directory) / "data" / "backups"
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=10)

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
            self.assertEqual(response.getheader("Connection"), "close")
            response.read()
            connection.request("PUT", "/api/settings", body=b'{"settings":{"too_big":"x"}}', headers={"Content-Type": "application/json", "Content-Length": str(1024 * 1024 + 1)})
            # Avoid transmitting an oversized body in this integration test; malformed framing must be rejected.
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
            connection.close()

    def test_backup_routes_export_and_restore_versioned_and_legacy_json_locally(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            database_path = Path(directory) / "app.db"
            initialize_database(database_path)
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            backup_directory = Path(directory) / "data" / "backups"
            server.backup_directory = backup_directory
            server.database_path = database_path
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            headers = {"Content-Type": "application/json"}

            connection.request("POST", "/api/backup/export", body=b'{"state":{"theme":"dark"}}', headers=headers)
            response = connection.getresponse()
            exported = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(exported["filename"], "mac-analyzer-backup.json")
            self.assertEqual(exported["mimeType"], "application/json")
            self.assertEqual(json.loads(exported["content"])["state"], {"theme": "dark"})
            self.assertEqual(Path(exported["storedPath"]).parent, backup_directory.resolve())

            content_base64 = base64.b64encode(exported["content"].encode("utf-8")).decode("ascii")
            restore_body = json.dumps({"contentBase64": content_base64}).encode("utf-8")
            connection.request("POST", "/api/backup/restore", body=restore_body, headers=headers)
            response = connection.getresponse()
            restored = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(restored["state"], {"theme": "dark"})
            self.assertEqual(restored["version"], 1)
            self.assertTrue(Path(restored["storedPath"]).is_file())

            legacy = base64.b64encode(b'{"theme":"light"}').decode("ascii")
            connection.request("POST", "/api/backup/restore", body=json.dumps({"contentBase64": legacy}).encode("utf-8"), headers=headers)
            response = connection.getresponse()
            self.assertEqual(json.loads(response.read().decode("utf-8"))["version"], 0)
            self.assertEqual(database_summary(database_path)["counts"]["device_inventory"], 0)

            connection.request("POST", "/api/backup/export", body=b'{"state":{}}', headers={"Content-Type": "text/plain"})
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(json.loads(response.read().decode("utf-8")), {"error": "Content-Type must be application/json"})
            self.assertEqual(response.getheader("Connection"), "close")
            connection.close()

    def test_sqlite_database_export_streams_a_verified_online_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            database_path = Path(directory) / "app.db"
            initialize_database(database_path)
            save_settings(database_path, {"theme": "dark"})
            backup_directory = Path(directory) / "data" / "backups"
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            server.database_path = database_path
            server.backup_directory = backup_directory
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)

            connection.request("GET", "/api/database/export")
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Type"), "application/vnd.sqlite3")
            self.assertEqual(response.getheader("Content-Disposition"), 'attachment; filename="mac-analyzer-database-backup.db"')
            self.assertEqual(int(response.getheader("Content-Length")), len(body))
            self.assertEqual(body[:16], b"SQLite format 3\x00")
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            exported = list(backup_directory.glob("*.db"))
            self.assertEqual(len(exported), 1)
            self.assertEqual(exported[0].read_bytes(), body)
            with sqlite3.connect(exported[0]) as snapshot:
                self.assertEqual(snapshot.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(snapshot.execute("SELECT value FROM app_settings WHERE key='theme'").fetchone()[0], '"dark"')
            snapshot.close()
            connection.close()

    def test_sqlite_database_restore_stores_verified_copy_without_changing_active_database(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            active_database = Path(directory) / "active.db"
            initialize_database(active_database)
            save_settings(active_database, {"theme": "dark"})
            backup_source = Path(directory) / "source.db"
            initialize_database(backup_source)
            save_settings(backup_source, {"theme": "light"})
            source = sqlite3.connect(backup_source)
            with source:
                source.execute("INSERT INTO device_inventory (mac, mac_formatted, first_seen, updated_at, seen_count) VALUES ('001122334455', '00:11:22:33:44:55', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1)")
            source.close()
            source = sqlite3.connect(backup_source)
            backup_bytes = source.serialize()
            source.close()
            backup_directory = Path(directory) / "data" / "backups"
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            server.database_path = active_database
            server.backup_directory = backup_directory
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)

            connection.request("PUT", "/api/database/restore", body=backup_bytes, headers={"Content-Type": "application/vnd.sqlite3"})
            response = connection.getresponse()
            result = json.loads(response.read().decode("utf-8"))

            self.assertEqual(response.status, 201)
            self.assertEqual(result["integrity"], "ok")
            self.assertEqual(result["userVersion"], 5)
            restored_path = Path(result["path"])
            self.assertEqual(restored_path.parent, backup_directory.resolve())
            restored = sqlite3.connect(restored_path)
            with restored:
                self.assertEqual(restored.execute("SELECT value FROM app_settings WHERE key='theme'").fetchone()[0], '"light"')
                self.assertEqual(restored.execute("SELECT count(*) FROM device_inventory").fetchone()[0], 1)
            restored.close()
            self.assertEqual(database_summary(active_database)["counts"]["device_inventory"], 0)
            self.assertEqual(database_summary(active_database)["integrity"], "ok")
            connection.close()

    def test_sqlite_database_restore_rejects_bad_content_type_and_invalid_file(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            backup_directory = Path(directory) / "data" / "backups"
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            server.backup_directory = backup_directory
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)

            connection.request("PUT", "/api/database/restore", body=b"not sqlite", headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(response.getheader("Connection"), "close")
            response.read()
            connection.request("PUT", "/api/database/restore", body=b"not sqlite", headers={"Content-Type": "application/vnd.sqlite3"})
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
            self.assertEqual(list(backup_directory.glob("*.db")) if backup_directory.exists() else [], [])
            connection.close()

    def test_sqlite_database_export_head_returns_headers_without_retaining_a_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            app_file = Path(directory) / "app.html"
            app_file.write_text("<h1>local build</h1>", encoding="utf-8")
            database_path = Path(directory) / "app.db"
            initialize_database(database_path)
            backup_directory = Path(directory) / "data" / "backups"
            server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(app_file))
            server.database_path = database_path
            server.backup_directory = backup_directory
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)

            connection.request("HEAD", "/api/database/export")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Type"), "application/vnd.sqlite3")
            self.assertGreater(int(response.getheader("Content-Length")), 16)
            self.assertEqual(response.read(), b"")
            self.assertEqual(list(backup_directory.glob("*.db")), [])
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

            with patch("scripts.optional_server_launcher.urllib.request.urlopen", side_effect=AssertionError("loopback shutdown must bypass URL proxy handling")):
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

    def test_launcher_passes_a_shutdown_token_starting_with_dash_as_one_argument(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "dist").mkdir()
            (root / "dist" / "MAC-Analyzer-Pro-Next.html").write_text("app", encoding="utf-8")
            state = root / "local" / "port.txt"
            arguments = ["launcher", "--root", str(root), "--state-file", str(state), "--no-browser", "--no-console"]
            with patch.object(sys, "argv", arguments):
                with patch("scripts.optional_server_launcher.choose_port", return_value=18765):
                    with patch("scripts.optional_server_launcher.health_is_ours", return_value=False):
                        with patch("scripts.optional_server_launcher.port_is_free", return_value=True):
                            with patch("scripts.optional_server_launcher.secrets.token_urlsafe", return_value="-starts-with-dash"):
                                with patch("scripts.optional_server_launcher.subprocess.Popen") as start_server:
                                    with patch("scripts.optional_server_launcher.wait_for_health", return_value=True) as wait_for_health:
                                        self.assertEqual(launcher_main(), 0)
            command = start_server.call_args.args[0]
            self.assertIn("--shutdown-token=-starts-with-dash", command)
            self.assertNotIn("--shutdown-token", command)
            wait_for_health.assert_called_once_with(18765, start_server.return_value, timeout=20.0)


if __name__ == "__main__":
    unittest.main()
