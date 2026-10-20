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
    INDEXES,
    REQUIRED_TABLES,
    _normalized_identity,
    database_summary,
    initialize_database,
    list_resolved_devices,
    list_resolved_history,
    load_settings,
    save_resolved_devices,
    save_resolved_history,
    save_settings,
)


class OptionalSQLiteStoreTests(unittest.TestCase):
    def test_optional_device_api_writes_additively_by_strong_identity_and_pages_all_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "data.db"
            initialize_database(database)
            first = {
                "deviceId": "Device-1", "mac": "00:11:22:33:44:55", "vendor": "Acme", "room": "101",
                "customFields": {"assetTag": "AV-101"},
            }
            second = {"serialNumber": "SN-2", "macFormatted": "AA:BB:CC:DD:EE:66", "model": "Codec"}
            saved = save_resolved_devices(database, [first, second])
            self.assertEqual(saved["savedCount"], 2)
            self.assertEqual(saved["conflictCount"], 0)

            repeated = save_resolved_devices(database, [{"deviceId": "device-1", "mac": "00:11:22:33:44:55", "vendor": ""}])
            self.assertEqual(repeated["saved"], saved["saved"][:1])
            self.assertEqual(repeated["conflicts"], [])
            conflict = save_resolved_devices(database, [{"deviceId": "Device-1", "mac": "00:11:22:33:44:77", "vendor": "Other"}])
            self.assertEqual(conflict["conflictCount"], 1)
            self.assertEqual(conflict["conflicts"][0]["reason"], "conflicting_strong_identity")
            duplicate_batch = save_resolved_devices(database, [
                {"deviceId": "duplicate", "mac": "00:11:22:33:44:88"},
                {"deviceId": "DUPLICATE", "mac": "AA:BB:CC:DD:EE:88"},
                {"serialNumber": "SN-3", "model": "Valid"},
            ])
            self.assertEqual(duplicate_batch["savedCount"], 1)
            self.assertEqual(duplicate_batch["conflicts"][0]["reason"], "duplicate_strong_identity_in_batch")
            with self.assertRaisesRegex(ValueError, "requires internalDeviceId"):
                save_resolved_devices(database, [{"hostname": "room-codec", "ip": "192.0.2.1"}])

            page1 = list_resolved_devices(database, limit=1)
            page2 = list_resolved_devices(database, after=page1["nextCursor"], limit=1)
            page3 = list_resolved_devices(database, after=page2["nextCursor"], limit=1)
            self.assertEqual(page1["total"], 3)
            self.assertEqual(len(page1["devices"]), 1)
            self.assertIsNotNone(page1["nextCursor"])
            self.assertEqual(page2["total"], 3)
            self.assertEqual(len(page2["devices"]), 1)
            self.assertIsNotNone(page2["nextCursor"])
            self.assertEqual(page3["total"], 3)
            self.assertEqual(len(page3["devices"]), 1)
            self.assertIsNone(page3["nextCursor"])
            all_devices = page1["devices"] + page2["devices"] + page3["devices"]
            device = next(item for item in all_devices if item.get("deviceId") == "Device-1")
            self.assertEqual(device["vendor"], "Acme")
            self.assertEqual(device["customFields"], {"assetTag": "AV-101"})
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM resolved_device_inventory").fetchone()[0], 3)
                self.assertEqual(connection.execute("SELECT seen_count FROM resolved_device_inventory WHERE device_id='Device-1'").fetchone()[0], 2)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM device_inventory").fetchone()[0], 0)
            connection.close()
            with sqlite3.connect(database) as connection:
                oversized_id = connection.execute(
                    "SELECT internal_device_id FROM resolved_device_inventory ORDER BY internal_device_id LIMIT 1"
                ).fetchone()[0]
                utf8_oversized_id = connection.execute(
                    "SELECT internal_device_id FROM resolved_device_inventory ORDER BY internal_device_id LIMIT 1 OFFSET 1"
                ).fetchone()[0]
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json=? WHERE internal_device_id=?",
                    (json.dumps({"internalDeviceId": oversized_id, "large": "x" * (300 * 1024)}), oversized_id),
                )
                utf8_payload = json.dumps({"internalDeviceId": utf8_oversized_id, "large": "У" * 140_000}, ensure_ascii=False)
                self.assertLess(len(utf8_payload), 256 * 1024)
                self.assertGreater(len(utf8_payload.encode("utf-8")), 256 * 1024)
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json=? WHERE internal_device_id=?",
                    (utf8_payload, utf8_oversized_id),
                )
            connection.close()
            bounded = list_resolved_devices(database, limit=2)
            omitted_ids = {device["internalDeviceId"] for device in bounded["devices"] if device.get("payloadOmitted")}
            self.assertIn(oversized_id, omitted_ids)
            self.assertIn(utf8_oversized_id, omitted_ids)

    def test_resolved_identity_uses_device_id_then_serial_then_mac_and_rejects_hostname_only(self):
        device_id = _normalized_identity({"deviceId": "Device-7", "mac": "00:11:22:33:44:55"})
        self.assertEqual(device_id, _normalized_identity({"deviceId": " device-7 ", "mac": "AA:BB:CC:DD:EE:FF"}))
        serial_id = _normalized_identity({"serialNumber": "SN-7", "mac": "00:11:22:33:44:55"})
        self.assertEqual(serial_id, _normalized_identity({"serial_number": "sn-7", "mac": "AA:BB:CC:DD:EE:FF"}))
        self.assertNotEqual(device_id, serial_id)
        self.assertTrue(_normalized_identity({"mac": "00:11:22:33:44:55"}).startswith("dev-"))
        self.assertEqual("", _normalized_identity({"hostname": "conference-room"}))
        self.assertEqual("", _normalized_identity({"mac": "00:00:00:00:00:00"}))

    def test_optional_history_api_requires_provenance_deduplicates_and_pages_by_event_id(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "history.db"
            initialize_database(database)
            events = [
                {
                    "sourceFinalId": "final-2026-10-21-a", "observedAt": "2026-10-21T10:00:00+03:00",
                    "internalDeviceId": "device-a", "eventType": "added", "source": "Main",
                    "room": "101", "model": "Room Codec",
                },
                {
                    "sourceFinalId": "final-2026-10-21-b", "observedAt": "2026-10-21T10:05:00Z",
                    "deviceId": "edge-2", "eventType": "modified", "field": "room",
                    "fromValue": "101", "toValue": "202", "source": "SmartRoom",
                },
                {
                    "sourceFinalId": "final-2026-10-21-c", "observedAt": "2026-10-21T10:10:00Z",
                    "mac": "00:11:22:33:44:55", "eventType": "absent",
                },
            ]
            saved = save_resolved_history(database, events)
            self.assertEqual(saved["insertedCount"], 3)
            self.assertEqual(saved["duplicateCount"], 0)
            repeated = save_resolved_history(database, [events[0]])
            self.assertEqual(repeated["insertedCount"], 0)
            self.assertEqual(repeated["duplicateCount"], 1)

            page1 = list_resolved_history(database, limit=1)
            page2 = list_resolved_history(database, after=page1["nextCursor"], limit=1)
            page3 = list_resolved_history(database, after=page2["nextCursor"], limit=1)
            self.assertEqual([page1["total"], page2["total"], page3["total"]], [3, 3, 3])
            self.assertEqual(page1["events"][0]["observedAt"], "2026-10-21T07:00:00.000000Z")
            self.assertEqual((page1["events"][0]["room"], page1["events"][0]["model"]), ("101", "Room Codec"))
            self.assertEqual(page2["events"][0]["sourceFinalId"], "final-2026-10-21-b")
            self.assertEqual((page2["events"][0]["fromValue"], page2["events"][0]["toValue"]), ("101", "202"))
            self.assertIsNotNone(page1["nextCursor"])
            self.assertIsNotNone(page2["nextCursor"])
            self.assertIsNone(page3["nextCursor"])
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM resolved_device_history").fetchone()[0], 3)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM mac_movements").fetchone()[0], 0)
            connection.close()

            invalid_events = [
                {**events[0], "sourceFinalId": ""},
                {**events[0], "observedAt": "2026-02-30T10:00:00Z"},
                {**events[1], "fromValue": "—"},
                {**events[0], "eventType": []},
            ]
            for invalid in invalid_events:
                with self.subTest(invalid=invalid):
                    with self.assertRaises(ValueError):
                        save_resolved_history(database, [invalid])
            self.assertEqual(list_resolved_history(database)["total"], 3)

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
            self.assertEqual(second["schemaVersion"], 4)
            self.assertIsNone(second["backup"])
            self.assertEqual(load_settings(database)["settings"], loaded["settings"])
            self.assertEqual(database_summary(database)["counts"]["device_inventory"], 0)

    def test_identity_conflict_lookup_uses_normalized_sqlite_indexes(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "indexed.db"
            initialize_database(database)
            mac_expression = "replace(replace(replace(replace(upper(mac), ':', ''), '-', ''), '.', ''), ' ', '')"
            queries = (
                ("lower(trim(device_id)) = lower(?)", "idx_resolved_inventory_device_id_normalized"),
                ("lower(trim(serial_number)) = lower(?)", "idx_resolved_inventory_serial_normalized"),
                (f"{mac_expression} = ?", "idx_resolved_inventory_mac_normalized"),
            )
            with sqlite3.connect(database) as connection:
                for predicate, expected_index in queries:
                    details = " ".join(str(row[3]) for row in connection.execute(
                        f"EXPLAIN QUERY PLAN SELECT 1 FROM resolved_device_inventory WHERE {predicate}", ("value",)
                    ))
                    self.assertIn(expected_index, details)
                combined = " OR ".join(predicate for predicate, _ in queries)
                details = " ".join(str(row[3]) for row in connection.execute(
                    f"EXPLAIN QUERY PLAN SELECT 1 FROM resolved_device_inventory WHERE {combined}",
                    ("device", "serial", "001122334455"),
                ))
                for _, expected_index in queries:
                    self.assertIn(expected_index, details)
            connection.close()
            self.assertTrue({
                "idx_resolved_inventory_device_id_normalized",
                "idx_resolved_inventory_serial_normalized",
                "idx_resolved_inventory_mac_normalized",
            }.issubset({statement.split("IF NOT EXISTS ", 1)[1].split(" ", 1)[0] for statement in INDEXES}))

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
                connection.execute("PRAGMA user_version=3")
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
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 4)
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
                connection.execute("PRAGMA user_version=3")
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

    def test_resolved_inventory_detects_strong_conflicts_across_different_preferred_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "cross-field-conflicts.db"
            initialize_database(database)
            with sqlite3.connect(database) as connection:
                connection.executemany(
                    "INSERT INTO device_inventory (mac, mac_formatted, device_id, serial_number, first_seen, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    [("001122334455", "00:11:22:33:44:55", "device-one", "shared-serial", "2024-01-01", "2024-01-02"),
                     ("AABBCCDDEEFF", "AA:BB:CC:DD:EE:FF", "device-two", "shared-serial", "2024-01-01", "2024-01-02")],
                )
                connection.execute("PRAGMA user_version=3")
            connection.close()

            result = initialize_database(database)

            with sqlite3.connect(database) as connection:
                rows = connection.execute(
                    "SELECT internal_device_id, mac, payload_json FROM resolved_device_inventory ORDER BY mac"
                ).fetchall()
            connection.close()
            self.assertEqual(len(rows), 2)
            self.assertEqual({row[1] for row in rows}, {"001122334455", "AABBCCDDEEFF"})
            flagged = [json.loads(row[2]) for row in rows if json.loads(row[2]).get("identityConflicts")]
            self.assertEqual(len(flagged), 1)
            fields = {item["field"] for item in flagged[0]["identityConflicts"]}
            self.assertEqual(fields, {"mac", "deviceId"})
            self.assertEqual(result["schemaVersion"], 4)

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
                connection.execute("PRAGMA user_version=5")
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
