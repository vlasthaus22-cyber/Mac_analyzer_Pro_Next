import base64
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))

from scripts.optional_backup_store import MAX_BACKUP_BYTES, backup_sqlite_database, export_app_backup, restore_app_backup, restore_sqlite_database  # noqa: E402


class OptionalBackupStoreTests(unittest.TestCase):
    def test_sqlite_online_backup_is_integrity_checked_and_preserves_source_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "data" / "primary.db"
            database.parent.mkdir()
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)")
                connection.execute("INSERT INTO records(value) VALUES ('keep')")
            connection.close()

            result = backup_sqlite_database(database, Path(directory) / "data" / "backups")

            self.assertEqual(result["integrity"], "ok")
            self.assertGreater(result["bytes"], 0)
            self.assertEqual(Path(result["path"]).parent, (Path(directory) / "data" / "backups").resolve())
            with sqlite3.connect(result["path"]) as connection:
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(connection.execute("SELECT value FROM records").fetchone()[0], "keep")
            connection.close()
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT value FROM records").fetchone()[0], "keep")
            connection.close()

    def test_sqlite_restore_publishes_a_valid_separate_copy_without_replacing_active_database(self):
        with tempfile.TemporaryDirectory() as directory:
            active_database = Path(directory) / "active.db"
            restore_source = Path(directory) / "portable-backup.db"
            restore_directory = Path(directory) / "data" / "backups"
            for database, value in ((active_database, "current"), (restore_source, "restored")):
                connection = sqlite3.connect(database)
                with connection:
                    connection.execute("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)")
                    connection.execute("INSERT INTO records(value) VALUES (?)", (value,))
                    connection.execute("PRAGMA user_version=3")
                connection.close()

            result = restore_sqlite_database(restore_source, restore_directory)

            self.assertEqual(result["integrity"], "ok")
            self.assertEqual(result["userVersion"], 3)
            self.assertEqual(Path(result["path"]).parent, restore_directory.resolve())
            self.assertIn("restored", Path(result["path"]).name)
            restored = sqlite3.connect(result["path"])
            with restored:
                self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(restored.execute("SELECT value FROM records").fetchone()[0], "restored")
            restored.close()
            active = sqlite3.connect(active_database)
            with active:
                self.assertEqual(active.execute("SELECT value FROM records").fetchone()[0], "current")
            active.close()

    def test_sqlite_restore_rejects_non_database_and_corrupt_database_without_publishing(self):
        with tempfile.TemporaryDirectory() as directory:
            restore_directory = Path(directory) / "backups"
            invalid_source = Path(directory) / "invalid.db"
            invalid_source.write_bytes(b"not a database")
            with self.assertRaisesRegex(ValueError, "not a SQLite database"):
                restore_sqlite_database(invalid_source, restore_directory)
            corrupt_source = Path(directory) / "corrupt.db"
            corrupt_source.write_bytes(b"SQLite format 3\x00" + b"x" * 1024)
            with self.assertRaises(sqlite3.DatabaseError):
                restore_sqlite_database(corrupt_source, restore_directory)
            self.assertEqual(list(restore_directory.glob("*.db")) if restore_directory.exists() else [], [])

    def test_generated_path_collision_never_overwrites_an_existing_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            fixed_time = datetime(2026, 10, 21, tzinfo=timezone.utc)
            class FixedDatetime:
                @staticmethod
                def now(_timezone=None):
                    return fixed_time

            class FixedId:
                hex = "fixed"

            with patch("scripts.optional_backup_store.datetime", FixedDatetime), \
                    patch("scripts.optional_backup_store.uuid.uuid4", return_value=FixedId()):
                first = export_app_backup({"value": "first"}, directory)
                original = Path(first["storedPath"]).read_bytes()
                with self.assertRaises(FileExistsError):
                    export_app_backup({"value": "second"}, directory)

            self.assertEqual(Path(first["storedPath"]).read_bytes(), original)
            self.assertEqual(list(Path(directory).glob(".*.tmp")), [])

    def test_export_and_restore_roundtrip_store_unique_local_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            backup_directory = Path(directory) / "data" / "backups"
            state = {"theme": "dark", "visibleColumns": ["mac", "room"]}

            exported = export_app_backup(state, backup_directory)
            self.assertEqual(exported["filename"], "mac-analyzer-backup.json")
            self.assertEqual(exported["mimeType"], "application/json")
            self.assertEqual(exported["bytes"], len(exported["content"].encode("utf-8")))
            self.assertEqual(json.loads(exported["content"])["state"], state)
            self.assertEqual(Path(exported["storedPath"]).parent, backup_directory.resolve())
            self.assertTrue(Path(exported["storedPath"]).is_file())

            restored = restore_app_backup(base64.b64encode(exported["content"].encode("utf-8")).decode("ascii"), backup_directory)
            self.assertEqual(restored["version"], 1)
            self.assertEqual(restored["state"], state)
            self.assertEqual(Path(restored["storedPath"]).parent, backup_directory.resolve())
            self.assertTrue(Path(restored["storedPath"]).is_file())
            self.assertNotEqual(exported["storedPath"], restored["storedPath"])

    def test_restore_accepts_legacy_state_json_without_replacing_any_other_file(self):
        with tempfile.TemporaryDirectory() as directory:
            backup_directory = Path(directory) / "backups"
            original = backup_directory / "keep.json"
            backup_directory.mkdir()
            original.write_text('{"keep":true}', encoding="utf-8")
            legacy = base64.b64encode('{"theme":"light"}'.encode("utf-8")).decode("ascii")

            restored = restore_app_backup(legacy, backup_directory)

            self.assertEqual(restored["version"], 0)
            self.assertEqual(restored["state"], {"theme": "light"})
            self.assertEqual(original.read_text(encoding="utf-8"), '{"keep":true}')

    def test_restore_rejects_invalid_encoding_json_and_future_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            for encoded in ("not base64!", base64.b64encode(b"not json").decode("ascii"),
                            base64.b64encode(b'{"version":2,"state":{}}').decode("ascii"),
                            base64.b64encode(b"[]").decode("ascii")):
                with self.subTest(encoded=encoded), self.assertRaises(ValueError):
                    restore_app_backup(encoded, directory)

    def test_export_and_restore_enforce_the_backup_size_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "512 KiB"):
                export_app_backup({"large": "x" * MAX_BACKUP_BYTES}, directory)
            oversized = base64.b64encode(b" " * (MAX_BACKUP_BYTES + 1)).decode("ascii")
            with self.assertRaisesRegex(ValueError, "Invalid backup JSON"):
                restore_app_backup(oversized, directory)
            self.assertEqual(list(Path(directory).glob("*.json")), [])

    def test_export_rejects_non_json_values_without_creating_a_file(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "valid JSON"):
                export_app_backup({"notJson": float("nan")}, directory)
            self.assertEqual(list(Path(directory).glob("*.json")), [])


if __name__ == "__main__":
    unittest.main()
