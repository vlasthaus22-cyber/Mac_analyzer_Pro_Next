import json
from pathlib import Path
import tempfile
import unittest

from scripts.optional_diagnostics import run_optional_host_diagnostics
from scripts.optional_sqlite_store import initialize_database
from scripts.optional_storage_paths import initialize_storage


class OptionalDiagnosticsTests(unittest.TestCase):
    def test_optional_host_diagnostics_checks_layout_and_sqlite_without_writing_or_exposing_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_file = root / "MAC-Analyzer-Pro-Next.html"
            app_file.write_text("<!doctype html><title>local app</title>", encoding="utf-8")
            storage = initialize_storage(root)
            database_path = Path(storage["layout"]["database"])
            initialize_database(database_path)
            database_bytes = database_path.read_bytes()

            report = run_optional_host_diagnostics(app_file, database_path, storage)

            self.assertEqual(report["errors"], 0)
            self.assertEqual(report["warnings"], 0)
            self.assertEqual(report["passed"], 3)
            self.assertEqual(database_path.read_bytes(), database_bytes)
            self.assertNotIn(str(root), json.dumps(report, ensure_ascii=False))
            self.assertTrue(any(item["id"] == "host-sqlite" and "quick_check: ok" in item["detail"] for item in report["checks"]))

    def test_optional_host_diagnostics_reports_a_damaged_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_file = root / "app.html"
            app_file.write_text("local", encoding="utf-8")
            storage = initialize_storage(root)
            damaged = Path(storage["layout"]["database"])
            damaged.write_bytes(b"not a SQLite database")

            report = run_optional_host_diagnostics(app_file, damaged, storage)

            self.assertEqual(report["errors"], 1)
            sqlite_check = next(item for item in report["checks"] if item["id"] == "host-sqlite")
            self.assertEqual(sqlite_check["status"], "error")
            self.assertIn("read-only", sqlite_check["detail"])
            self.assertNotIn(str(root), json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
