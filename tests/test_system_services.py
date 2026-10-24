from __future__ import annotations

import importlib
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
