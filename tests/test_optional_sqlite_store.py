import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))
from unittest.mock import patch

from scripts.optional_sqlite_store import (  # noqa: E402
    REQUIRED_TABLES,
    _normalized_identity,
    database_summary,
    initialize_database,
    load_settings,
    save_settings,
)


class OptionalSQLiteStoreTests(unittest.TestCase):
    def test_resolved_identity_uses_device_id_then_serial_then_mac_and_rejects_hostname_only(self):
        device_id = _normalized_identity({"deviceId": "Device-7", "mac": "00:11:22:33:44:55"})
        self.assertEqual(device_id, _normalized_identity({"deviceId": " device-7 ", "mac": "AA:BB:CC:DD:EE:FF"}))
        serial_id = _normalized_identity({"serialNumber": "SN-7", "mac": "00:11:22:33:44:55"})
        self.assertEqual(serial_id, _normalized_identity({"serial_number": "sn-7", "mac": "AA:BB:CC:DD:EE:FF"}))
        self.assertNotEqual(device_id, serial_id)
        self.assertTrue(_normalized_identity({"mac": "00:11:22:33:44:55"}).startswith("dev-"))
        self.assertEqual("", _normalized_identity({"hostname": "conference-room"}))
        self.assertEqual("", _normalized_identity({"mac": "00:00:00:00:00:00"}))

    def test_source_compatible_schema_is_idempotent_and_settings_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "data" / "mac_analyzer_web.db"
            first = initialize_database(database)
            self.assertTrue(first["created"])
            self.assertEqual(first["integrity"], "ok")
            self.assertTrue(set(REQUIRED_TABLES).issubset(first["tables"]))

            saved = save_settings(database, {"theme": "dark", "columns": ["mac", "room"]})
            self.assertEqual(saved["saved"], ["theme", "columns"])
            loaded = load_settings(database)
            self.assertEqual(loaded["settings"], {"theme": "dark", "columns": ["mac", "room"]})
            self.assertEqual(load_settings(database, ["theme"])["settings"], {"theme": "dark"})

            second = initialize_database(database)
            self.assertFalse(second["created"])
            self.assertEqual(second["integrity"], "ok")
            self.assertEqual(second["schemaVersion"], 2)
            self.assertIsNone(second["backup"])
            self.assertEqual(load_settings(database)["settings"], loaded["settings"])
            self.assertEqual(database_summary(database)["counts"]["device_inventory"], 0)

    def test_legacy_schema_upgrade_preserves_rows_and_backfills_current_and_resolved_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE preserved_custom_data (value TEXT NOT NULL)")
                connection.execute("INSERT INTO preserved_custom_data VALUES ('keep')")
                connection.execute("""CREATE TABLE mac_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT NOT NULL, mac_formatted TEXT NOT NULL,
                    oui TEXT, vendor TEXT, model TEXT, ip TEXT, address TEXT, room TEXT, smartroom_id TEXT,
                    switch_ip TEXT, switch_port TEXT, source TEXT, recorded_at TEXT NOT NULL)""")
                connection.execute("INSERT INTO mac_history (mac, mac_formatted, vendor, model, room, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                                   ("001122334455", "00:11:22:33:44:55", "Acme", "Unit", "101", "old.csv", "2024-01-01T00:00:00Z"))
            connection.close()

            result = initialize_database(database)
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT value FROM preserved_custom_data").fetchone()[0], "keep")
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM mac_history").fetchone()[0], 1)
                inventory = connection.execute("SELECT mac, vendor, room, seen_count FROM device_inventory").fetchone()
                self.assertEqual(inventory, ("001122334455", "Acme", "101", 1))
                resolved = connection.execute("SELECT mac, payload_json FROM resolved_device_inventory").fetchone()
                self.assertEqual(resolved[0], "001122334455")
                self.assertIn('"internalDeviceId":"dev-', resolved[1])
            connection.close()
            self.assertEqual(result["integrity"], "ok")
            self.assertTrue(result["backup"]["path"].endswith(".db"))
            self.assertTrue(Path(result["backup"]["path"]).is_file())
            self.assertEqual(result["counts"]["device_inventory"], 1)
            self.assertEqual(result["counts"]["resolved_device_inventory"], 1)
            with sqlite3.connect(result["backup"]["path"]) as backup:
                self.assertEqual(backup.execute("SELECT COUNT(*) FROM mac_history").fetchone()[0], 1)
                self.assertEqual(backup.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='device_inventory'").fetchone()[0], 0)
            backup.close()

    def test_partial_resolved_inventory_migration_adds_missing_identity_and_keeps_existing_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "partial.db"
            initialize_database(database)
            with sqlite3.connect(database) as connection:
                connection.executemany(
                    "INSERT INTO device_inventory (mac, mac_formatted, device_id, room, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    [("001122334455", "00:11:22:33:44:55", "unit-one", "101", "2024-01-01", "2024-01-02"),
                     ("AABBCCDDEEFF", "AA:BB:CC:DD:EE:FF", "unit-two", "102", "2024-01-01", "2024-01-02")],
                )
                connection.execute(
                    "INSERT INTO resolved_device_inventory "
                    "(internal_device_id, device_id, payload_json, first_seen, updated_at, seen_count) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (_normalized_identity({"deviceId": "unit-one"}), "unit-one", '{"preserve":true}',
                     "2024-01-01", "2024-01-02", 7),
                )
                connection.execute("PRAGMA user_version=1")
            connection.close()

            result = initialize_database(database)

            with sqlite3.connect(database) as connection:
                rows = connection.execute(
                    "SELECT device_id, mac, room, payload_json, seen_count FROM resolved_device_inventory ORDER BY device_id"
                ).fetchall()
                self.assertEqual(len(rows), 2)
                self.assertEqual(rows[0][0:3], ("unit-one", "001122334455", "101"))
                self.assertEqual(rows[0][4], 7)
                existing_payload = json.loads(rows[0][3])
                self.assertTrue(existing_payload["preserve"])
                self.assertEqual(existing_payload["mac"], "001122334455")
                self.assertEqual(existing_payload["room"], "101")
                self.assertEqual(rows[1][0], "unit-two")
                self.assertIn('"deviceId":"unit-two"', rows[1][3])
                self.assertEqual(rows[1][4], 1)
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
            connection.close()
            self.assertTrue(Path(result["backup"]["path"]).is_file())
            self.assertEqual(result["counts"]["resolved_device_inventory"], 2)

    def test_resolved_inventory_backfill_preserves_conflicting_strong_identities_with_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "conflicts.db"
            initialize_database(database)
            with sqlite3.connect(database) as connection:
                connection.executemany(
                    "INSERT INTO device_inventory (mac, mac_formatted, device_id, first_seen, updated_at) VALUES (?, ?, ?, ?, ?)",
                    [("001122334455", "00:11:22:33:44:55", "duplicate-id", "2024-01-01", "2024-01-02"),
                     ("AABBCCDDEEFF", "AA:BB:CC:DD:EE:FF", "duplicate-id", "2024-01-01", "2024-01-02")],
                )
                connection.execute("PRAGMA user_version=1")
            connection.close()

            result = initialize_database(database)

            with sqlite3.connect(database) as connection:
                rows = connection.execute(
                    "SELECT internal_device_id, mac, payload_json FROM resolved_device_inventory ORDER BY mac"
                ).fetchall()
            connection.close()
            self.assertEqual(len(rows), 2)
            self.assertEqual({row[1] for row in rows}, {"001122334455", "AABBCCDDEEFF"})
            self.assertNotEqual(rows[0][0], rows[1][0])
            diagnostic_payloads = [json.loads(row[2]) for row in rows]
            flagged = [payload for payload in diagnostic_payloads if payload.get("identityConflicts")]
            self.assertEqual(len(flagged), 1)
            self.assertEqual(flagged[0]["identityConflicts"][0]["field"], "mac")
            self.assertEqual(flagged[0]["conflicts"][0]["reason"], "conflicting_strong_identity")
            self.assertEqual(result["counts"]["resolved_device_inventory"], 2)

    def test_failed_schema_migration_keeps_original_file_and_the_prechange_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "old.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE preserved (value TEXT)")
                connection.execute("INSERT INTO preserved VALUES ('before')")
            connection.close()

            with patch("scripts.optional_sqlite_store.TABLES", ("CREATE TABLE introduced (value TEXT)", "INVALID SQL")):
                with self.assertRaises(sqlite3.Error):
                    initialize_database(database)

            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT value FROM preserved").fetchone()[0], "before")
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='introduced'").fetchone()[0], 0)
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 0)
            connection.close()
            backups = list((Path(directory) / "backups").glob("*.db"))
            self.assertEqual(len(backups), 1)
            with sqlite3.connect(backups[0]) as backup:
                self.assertEqual(backup.execute("SELECT value FROM preserved").fetchone()[0], "before")
                self.assertEqual(backup.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='introduced'").fetchone()[0], 0)
                self.assertEqual(backup.execute("PRAGMA user_version").fetchone()[0], 0)
            backup.close()

    def test_non_sqlite_destination_is_rejected_without_changing_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "existing.db"
            original = b"user data that is not an SQLite database"
            database.write_bytes(original)
            with self.assertRaisesRegex(ValueError, "left unchanged"):
                initialize_database(database)
            self.assertEqual(database.read_bytes(), original)

    def test_newer_schema_version_is_rejected_without_changing_database_or_creating_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "newer.db"
            initialize_database(database)
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE future_data (value TEXT)")
                connection.execute("INSERT INTO future_data VALUES ('keep')")
                connection.execute("PRAGMA user_version=3")
            connection.close()
            original = database.read_bytes()

            with self.assertRaisesRegex(ValueError, "newer than supported.*left unchanged"):
                initialize_database(database)

            self.assertEqual(database.read_bytes(), original)
            self.assertFalse((Path(directory) / "backups").exists())

    def test_invalid_settings_are_atomic_and_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "settings.db"
            initialize_database(database)
            save_settings(database, {"theme": "light"})
            with self.assertRaises(ValueError):
                save_settings(database, {"new": "ok", "bad": "x" * (256 * 1024)})
            self.assertEqual(load_settings(database)["settings"], {"theme": "light"})


if __name__ == "__main__":
    unittest.main()
