import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.optional_diagnostics import REQUIRED_OPTIONAL_HOST_FILES, _check_optional_host_api, run_optional_host_diagnostics
from scripts.optional_sqlite_store import initialize_database
from scripts.optional_storage_paths import initialize_storage


class OptionalDiagnosticsTests(unittest.TestCase):
    def test_optional_api_diagnostics_reject_non_integer_counts_and_oversized_pages(self):
        cases = (
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
            database_bytes = database_path.read_bytes()

            report = run_optional_host_diagnostics(app_file, database_path, storage, root)

            self.assertEqual(report["errors"], 0)
            self.assertEqual(report["warnings"], 0)
            self.assertEqual(report["passed"], 4)
            self.assertEqual(database_path.read_bytes(), database_bytes)
            self.assertNotIn(str(root), json.dumps(report, ensure_ascii=False))
            self.assertTrue(any(item["id"] == "host-backend-files" and "8 обязательных" in item["detail"] for item in report["checks"]))
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
