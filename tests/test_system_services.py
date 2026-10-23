from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.services.system.engineering_service import authorize_loopback_shutdown
from backend.services.system.legacy_migration_service import initialize_system_storage


class SystemServicesTests(unittest.TestCase):
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
