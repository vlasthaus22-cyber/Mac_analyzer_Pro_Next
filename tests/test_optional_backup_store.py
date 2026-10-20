import base64
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))

from scripts.optional_backup_store import MAX_BACKUP_BYTES, export_app_backup, restore_app_backup  # noqa: E402


class OptionalBackupStoreTests(unittest.TestCase):
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
