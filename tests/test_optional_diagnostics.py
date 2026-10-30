import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.optional_diagnostics import REQUIRED_OPTIONAL_HOST_FILES, _check_optional_host_api, _check_parity_registry, run_optional_host_diagnostics
from scripts.optional_sqlite_store import initialize_database
from backend.services.system.sqlite_store import REQUIRED_TABLES
from scripts.optional_storage_paths import initialize_storage


class OptionalDiagnosticsTests(unittest.TestCase):
    def test_parity_registry_diagnostic_counts_verified_and_open_requirements(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "PARITY_REGISTRY.md").write_text(
                "| ID | Requirement | Paths | Tests | Status |\n"
                "| 1 | Local feature | src/app.js | tests/app.test.js | Полностью: verified |\n"
                "| 2 | Browser feature | src/app.js | tests/app.test.js | Частично: browser smoke open |\n",
                encoding="utf-8",
            )

            status, detail = _check_parity_registry(root)

            self.assertEqual(status, "warning")
            self.assertEqual(detail, "Матрица parity: полностью проверено 1 из 2; открыто или частично 1.")
            self.assertNotIn(str(root), detail)

    def test_parity_registry_diagnostic_rejects_duplicate_requirement_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "PARITY_REGISTRY.md").write_text(
                "| ID | Requirement | Paths | Tests | Status |\n"
                "| 1 | First | src/app.js | tests/app.test.js | Полностью: verified |\n"
                "| 1 | Duplicate | src/app.js | tests/app.test.js | Частично: open |\n",
                encoding="utf-8",
            )

            status, detail = _check_parity_registry(root)

            self.assertEqual(status, "error")
            self.assertIn("повторяющиеся ID", detail)

    def test_optional_api_diagnostics_reject_non_integer_counts_and_oversized_pages(self):
        cases = (
            ("/api/health", {"status": "ok"}),
            ("/api/storage/structure", {"layout": {"data": "local-data"}}),
            ("/api/database/summary", {"integrity": "ok", "tableCount": True, "counts": {"device_inventory": 0, "mac_history": 0, "resolved_device_inventory": 0, "snapshots": 0}}),
            ("/api/database/summary", {"integrity": "ok", "tableCount": -1, "counts": {"device_inventory": 0, "mac_history": 0, "resolved_device_inventory": 0, "snapshots": 0}}),
            ("/api/database/summary", {"integrity": "ok", "tableCount": len(REQUIRED_TABLES), "counts": {"device_inventory": 0, "mac_history": 0, "resolved_device_inventory": 0}}),
            ("/api/database/summary", {"integrity": "ok", "tableCount": len(REQUIRED_TABLES) - 1, "counts": {"device_inventory": 0, "mac_history": 0, "resolved_device_inventory": 0, "snapshots": 0}}),
            ("/api/devices?limit=1", {"devices": [], "total": True, "nextCursor": None}),
            ("/api/devices?limit=1", {"devices": [{}, {}], "total": 2, "nextCursor": "id-1"}),
            ("/api/history?limit=1", {"events": [], "total": True, "nextCursor": None}),
            ("/api/history?limit=1", {"events": [{}], "total": 1, "nextCursor": True}),
            ("/api/snapshots?limit=1", {"snapshots": [], "total": True, "nextCursor": None}),
            ("/api/snapshots?limit=1", {"snapshots": [{}, {}], "total": 2, "nextCursor": "final-1"}),
        )
        for path, payload in cases:
            with self.subTest(path=path, payload=payload):
                response = Mock(status=200)
                response.read.return_value = json.dumps(payload).encode("utf-8")
                connection = Mock()
                connection.getresponse.return_value = response
                with patch("scripts.optional_diagnostics.HTTPConnection", return_value=connection):
                    valid, detail = _check_optional_host_api(12345, path)
                self.assertFalse(valid)
                self.assertEqual(detail, "неверная структура ответа")
                connection.close.assert_called_once_with()

    def test_optional_api_diagnostics_accepts_complete_health_storage_and_database_reports(self):
        layout_keys = ("root", "data", "databases", "legacy", "backups", "exports", "imports", "reference", "runtime", "logs", "config", "database")
        cases = (
            ("/api/health", {"status": "ok", "application": "MAC Analyzer Pro Next", "mode": "optional-local-http-host", "storage": "browser-indexeddb"}),
            ("/api/storage/structure", {"layout": {key: f"local-{key}" for key in layout_keys}}),
            ("/api/database/summary", {"integrity": "ok", "tableCount": len(REQUIRED_TABLES), "counts": {"device_inventory": 1, "mac_history": 2, "resolved_device_inventory": 3, "snapshots": 4}}),
        )
        for path, payload in cases:
            with self.subTest(path=path):
                response = Mock(status=200)
                response.read.return_value = json.dumps(payload).encode("utf-8")
                connection = Mock()
                connection.getresponse.return_value = response
                with patch("scripts.optional_diagnostics.HTTPConnection", return_value=connection):
                    valid, detail = _check_optional_host_api(12345, path)
                self.assertTrue(valid, detail)
                self.assertEqual(detail, "API ответил корректным отчётом")
                connection.close.assert_called_once_with()

    def test_optional_host_diagnostics_checks_layout_and_sqlite_without_writing_or_exposing_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_file = root / "MAC-Analyzer-Pro-Next.html"
            app_file.write_text("<!doctype html><title>local app</title>", encoding="utf-8")
            storage = initialize_storage(root)
            database_path = Path(storage["layout"]["database"])
            initialize_database(database_path)
            for relative_path in REQUIRED_OPTIONAL_HOST_FILES:
                runtime_file = root / Path(relative_path)
                runtime_file.parent.mkdir(parents=True, exist_ok=True)
                runtime_file.write_text("runtime component", encoding="utf-8")
            (root / "PARITY_REGISTRY.md").write_text(
                "| ID | Requirement | Paths | Tests | Status |\n"
                "| 1 | Local feature | src/app.js | tests/app.test.js | Полностью: verified |\n",
                encoding="utf-8",
            )
            database_bytes = database_path.read_bytes()

            report = run_optional_host_diagnostics(app_file, database_path, storage, root)

            self.assertEqual(report["errors"], 0)
            self.assertEqual(report["warnings"], 0)
            self.assertEqual(report["passed"], 5)
            self.assertEqual(database_path.read_bytes(), database_bytes)
            self.assertNotIn(str(root), json.dumps(report, ensure_ascii=False))
            self.assertTrue(any(item["id"] == "host-backend-files" and "23 обязательных" in item["detail"] for item in report["checks"]))
            self.assertTrue(any(item["id"] == "host-parity" and item["status"] == "ok" for item in report["checks"]))
            self.assertTrue(any(item["id"] == "host-sqlite" and "quick_check: ok" in item["detail"] for item in report["checks"]))

    def test_optional_host_diagnostics_reports_missing_runtime_files_without_absolute_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_file = root / "app.html"
            app_file.write_text("local", encoding="utf-8")
            storage = initialize_storage(root)
            database_path = Path(storage["layout"]["database"])
            initialize_database(database_path)

            report = run_optional_host_diagnostics(app_file, database_path, storage, root)

            file_check = next(item for item in report["checks"] if item["id"] == "host-backend-files")
            self.assertEqual(file_check["status"], "error")
            self.assertIn("server.py", file_check["detail"])
            self.assertEqual(report["errors"], 1)
            self.assertNotIn(str(root), json.dumps(report, ensure_ascii=False))

    def test_optional_host_diagnostics_reports_a_damaged_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_file = root / "app.html"
            app_file.write_text("local", encoding="utf-8")
            storage = initialize_storage(root)
            damaged = Path(storage["layout"]["database"])
            initialize_database(damaged)
            for relative_path in REQUIRED_OPTIONAL_HOST_FILES:
                runtime_file = root / Path(relative_path)
                runtime_file.parent.mkdir(parents=True, exist_ok=True)
                runtime_file.write_text("runtime component", encoding="utf-8")
            damaged.write_bytes(b"not a SQLite database")

            report = run_optional_host_diagnostics(app_file, damaged, storage, root)

            self.assertEqual(report["errors"], 1)
            sqlite_check = next(item for item in report["checks"] if item["id"] == "host-sqlite")
            self.assertEqual(sqlite_check["status"], "error")
            self.assertIn("read-only", sqlite_check["detail"])
            self.assertNotIn(str(root), json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
