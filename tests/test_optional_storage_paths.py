import tempfile
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.optional_storage_paths import build_storage_layout, initialize_storage


class OptionalStoragePathTests(unittest.TestCase):
    def test_layout_supports_configured_data_and_database_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Application"
            external_data = Path(directory) / "Shared Data"
            external_database = Path(directory) / "Databases" / "custom.db"
            layout = build_storage_layout(root, {
                "MAC_ANALYZER_DATA_DIR": str(external_data),
                "MAC_ANALYZER_DATABASE_PATH": str(external_database),
            })

            self.assertEqual(layout.root, root.resolve())
            self.assertEqual(layout.data, external_data.resolve())
            self.assertEqual(layout.database, external_database.resolve())
            self.assertEqual(layout.databases, external_database.parent.resolve())
            self.assertEqual(layout.legacy, external_data.resolve() / "legacy")

    def test_initialization_creates_layout_and_moves_known_files_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Next App"
            data = Path(directory) / "Data"
            root.mkdir()
            (root / "mac_history.db").write_bytes(b"legacy source remains on conflict")
            (root / "vendor_model_history.db").write_bytes(b"legacy vendor history")
            (root / "mac_analyzer_settings.json").write_text('{"theme":"dark"}', encoding="utf-8")
            existing = data / "legacy" / "mac_history.db"
            existing.parent.mkdir(parents=True)
            existing.write_bytes(b"existing destination is preserved")

            report = initialize_storage(root, {"MAC_ANALYZER_DATA_DIR": str(data)})
            layout = build_storage_layout(root, {"MAC_ANALYZER_DATA_DIR": str(data)})
            moved_sources = {Path(item["source"]).name for item in report["moved"]}
            skipped = report["skipped"]

            self.assertEqual(existing.read_bytes(), b"existing destination is preserved")
            self.assertEqual((root / "mac_history.db").read_bytes(), b"legacy source remains on conflict")
            self.assertEqual((layout.legacy / "vendor_model_history.db").read_bytes(), b"legacy vendor history")
            self.assertEqual((layout.config / "mac_analyzer_settings.json").read_text(encoding="utf-8"), '{"theme":"dark"}')
            self.assertIn("vendor_model_history.db", moved_sources)
            self.assertTrue(any(item["reason"] == "destination exists" for item in skipped))
            self.assertTrue(all(directory_path.is_dir() for directory_path in layout.directories()))
            self.assertFalse(layout.database.exists(), "layout setup must not create or replace a SQLite database")

    def test_legacy_oui_reference_moves_to_reference_directory_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Next App"
            data = Path(directory) / "Data"
            root.mkdir()
            source_txt = root / "oui.txt"
            source_csv = root / "oui.csv"
            source_txt.write_bytes(b"00-11-22\tReference Vendor\n")
            source_csv.write_bytes(b"prefix,vendor\n001122,CSV Vendor\n")

            moved = initialize_storage(root, {"MAC_ANALYZER_DATA_DIR": str(data)})
            layout = build_storage_layout(root, {"MAC_ANALYZER_DATA_DIR": str(data)})

            self.assertFalse(source_txt.exists())
            self.assertFalse(source_csv.exists())
            self.assertEqual((layout.reference / "oui.txt").read_bytes(), b"00-11-22\tReference Vendor\n")
            self.assertEqual((layout.reference / "oui.csv").read_bytes(), b"prefix,vendor\n001122,CSV Vendor\n")
            moved_names = {Path(item["source"]).name for item in moved["moved"]}
            self.assertTrue({"oui.txt", "oui.csv"}.issubset(moved_names))

    def test_legacy_oui_reference_conflict_keeps_source_and_existing_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Next App"
            data = Path(directory) / "Data"
            root.mkdir()
            source = root / "oui.txt"
            destination = data / "reference" / "oui.txt"
            source.write_bytes(b"new root reference")
            destination.parent.mkdir(parents=True)
            destination.write_bytes(b"preserve existing reference")

            moved = initialize_storage(root, {"MAC_ANALYZER_DATA_DIR": str(data)})

            self.assertEqual(source.read_bytes(), b"new root reference")
            self.assertEqual(destination.read_bytes(), b"preserve existing reference")
            self.assertTrue(any(
                Path(item["source"]).name == "oui.txt" and Path(item["destination"]) == destination.resolve()
                and item["reason"] == "destination exists"
                for item in moved["skipped"]
            ))


if __name__ == "__main__":
    unittest.main()
