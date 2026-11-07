from __future__ import annotations

import importlib
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from backend.services.system.engineering_service import authorize_loopback_shutdown
from backend.services.system.legacy_migration_service import initialize_system_storage


class SystemServicesTests(unittest.TestCase):
    def test_legacy_optional_service_imports_resolve_to_package_implementations(self) -> None:
        aliases = {
            "scripts.optional_backup_store": "backend.services.system.backup_store",
            "scripts.optional_diagnostics": "backend.services.system.diagnostics_service",
            "scripts.optional_sqlite_store": "backend.services.system.sqlite_store",
            "scripts.optional_storage_paths": "backend.services.system.storage_paths",
        }

        for legacy_name, package_name in aliases.items():
            with self.subTest(legacy_name=legacy_name):
                legacy_module = importlib.import_module(legacy_name)
                package_module = importlib.import_module(package_name)
                self.assertIs(legacy_module, package_module)

    def test_shutdown_authorization_is_loopback_and_token_bound(self) -> None:
        self.assertTrue(authorize_loopback_shutdown("127.0.0.1", "Bearer secret", "secret"))
        self.assertFalse(authorize_loopback_shutdown("::1", "Bearer secret", "secret"))
        self.assertFalse(authorize_loopback_shutdown("127.0.0.1", "Bearer wrong", "secret"))
        self.assertFalse(authorize_loopback_shutdown("127.0.0.1", "Bearer secret", None))

    def test_system_storage_initialization_returns_additive_database_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            storage_info, database_path, database_info = initialize_system_storage(root)

            self.assertEqual(database_path, Path(storage_info["layout"]["database"]))
            self.assertTrue(database_path.is_file())
            self.assertTrue(Path(storage_info["layout"]["backups"]).is_dir())
            self.assertGreaterEqual(database_info["tableCount"], 1)

    def test_system_startup_moves_and_syncs_legacy_oui_reference_without_replacing_custom_rules(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            reference = root / "oui.txt"
            reference.write_text("00-11-22 (hex) Reference Vendor\n00-11-23\tSecond Vendor\n", encoding="utf-8")

            storage_info, database_path, database_info = initialize_system_storage(root)

            reference_directory = Path(storage_info["layout"]["reference"])
            self.assertFalse(reference.exists())
            self.assertTrue((reference_directory / "oui.txt").is_file())
            self.assertEqual(database_info["ouiReference"]["inserted"], 2)
            with closing(sqlite3.connect(database_path)) as connection:
                rows = connection.execute("SELECT oui, vendor, source FROM vendor_mappings ORDER BY oui").fetchall()
                self.assertEqual(rows, [("001122", "Reference Vendor", "reference"), ("001123", "Second Vendor", "reference")])
                connection.execute("UPDATE vendor_mappings SET vendor = 'User Rule', source = 'custom' WHERE oui = '001122'")
                connection.commit()

            (reference_directory / "oui.txt").write_text(
                "00-11-22 (hex) New Reference Vendor\n00-11-23\tUpdated Vendor\n00-11-24\tThird Vendor\n",
                encoding="utf-8",
            )
            _, _, updated = initialize_system_storage(root)

            self.assertEqual(updated["ouiReference"]["updated"], 1)
            self.assertEqual(updated["ouiReference"]["inserted"], 1)
            self.assertEqual(updated["ouiReference"]["preserved"], 1)
            with closing(sqlite3.connect(database_path)) as connection:
                rows = connection.execute("SELECT oui, vendor, source FROM vendor_mappings ORDER BY oui").fetchall()
            self.assertEqual(rows, [
                ("001122", "User Rule", "custom"),
                ("001123", "Updated Vendor", "reference"),
                ("001124", "Third Vendor", "reference"),
            ])

    def test_system_startup_reports_unchanged_oui_reference_by_content_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            reference = root / "oui.csv"
            reference.write_text("Assignment,Organization Name\n001122,CSV Vendor\n", encoding="utf-8")

            _, _, first = initialize_system_storage(root)
            _, _, second = initialize_system_storage(root)

            self.assertEqual(first["ouiReference"]["inserted"], 1)
            self.assertTrue(second["ouiReference"]["unchanged"])
            with closing(sqlite3.connect(root / "data" / "databases" / "mac_analyzer_web.db")) as connection:
                self.assertEqual(connection.execute("SELECT vendor FROM vendor_mappings WHERE oui = '001122'").fetchone(), ("CSV Vendor",))


if __name__ == "__main__":
    unittest.main()
