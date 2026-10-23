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
    delete_snapshot,
    database_summary,
    initialize_database,
    list_resolved_devices,
    list_resolved_history,
    list_resolved_history_for_mac,
    list_snapshot_devices,
    list_snapshots,
    load_settings,
    save_resolved_devices,
    save_resolved_history,
    save_settings,
    save_snapshot_stream,
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

    def test_resolved_inventory_merges_provenance_custom_fields_and_conflicts_additively(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "metadata-merge.db"
            initialize_database(database)
            original_conflict = {"field": "room", "values": ["101", "202"]}
            added_conflict = {"field": "ip", "values": ["192.0.2.1", "192.0.2.2"]}
            save_resolved_devices(database, [{
                "deviceId": "device-a", "mac": "00:11:22:33:44:55", "vendor": "Known Vendor",
                "sources": ["Main"], "fieldSources": {"vendor": "Main"},
                "customFields": {"rack": "A1", "owner": "Operations"},
                "conflicts": [original_conflict], "alternateMacs": ["AA:BB:CC:00:00:01"],
            }])

            save_resolved_devices(database, [{
                "deviceId": "DEVICE-A", "mac": "00:11:22:33:44:55", "vendor": "Replacement Vendor",
                "ip": "192.0.2.10", "sources": ["DDIO", "Main"],
                "fieldSources": {"vendor": "DDIO", "ip": "DDIO"},
                "customFields": {"rack": "B2", "building": "North"},
                "conflicts": [{"values": ["101", "202"], "field": "room"}, added_conflict],
                "alternateMacs": ["aa-bb-cc-00-00-01", "AA:BB:CC:00:00:02"],
            }])

            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["vendor"], "Known Vendor")
            self.assertEqual(device["ip"], "192.0.2.10")
            self.assertEqual(device["sources"], ["Main", "DDIO"])
            self.assertEqual(device["fieldSources"], {"vendor": "Main", "ip": "DDIO"})
            self.assertEqual(device["customFields"], {"rack": "A1", "owner": "Operations", "building": "North"})
            self.assertEqual(device["conflicts"], [original_conflict, added_conflict])
            self.assertEqual(device["alternateMacs"], ["AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02"])

    def test_oversized_metadata_merge_rolls_back_the_entire_inventory_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "metadata-rollback.db"
            initialize_database(database)
            original_value = "A" * (140 * 1024)
            added_value = "B" * (140 * 1024)
            save_resolved_devices(database, [{
                "deviceId": "device-a", "mac": "00:11:22:33:44:55",
                "customFields": {"original": original_value},
            }])

            with self.assertRaisesRegex(ValueError, "exceeds 256 KiB"):
                save_resolved_devices(database, [
                    {
                        "deviceId": "DEVICE-A", "mac": "00:11:22:33:44:55",
                        "customFields": {"added": added_value},
                    },
                    {"deviceId": "device-b", "mac": "00:11:22:33:44:66", "vendor": "Must roll back"},
                ])

            connection = sqlite3.connect(database)
            try:
                rows = connection.execute(
                    "SELECT device_id, payload_json FROM resolved_device_inventory ORDER BY device_id"
                ).fetchall()
            finally:
                connection.close()
            self.assertEqual([row[0] for row in rows], ["device-a"])
            payload = json.loads(rows[0][1])
            self.assertEqual(payload["customFields"], {"original": original_value})

    def test_inventory_copy_observation_count_is_preserved_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "data.db"
            initialize_database(database)
            source = {
                "internalDeviceId": "inventory-device-a", "mac": "00:11:22:33:44:55",
                "vendor": "Acme", "observationCount": 7,
            }
            first = save_resolved_devices(database, [source])
            self.assertEqual(first["savedCount"], 1)
            repeated = save_resolved_devices(database, [source])
            self.assertEqual(repeated["savedCount"], 1)
            newer = save_resolved_devices(database, [{**source, "observationCount": 9}])
            self.assertEqual(newer["savedCount"], 1)
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute(
                    "SELECT seen_count FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("inventory-device-a",),
                ).fetchone()[0], 9)
                payload = json.loads(connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("inventory-device-a",),
                ).fetchone()[0])
                self.assertEqual(payload["observationCount"], 9)
            connection.close()
            with self.assertRaisesRegex(ValueError, "observationCount must be a non-negative integer"):
                save_resolved_devices(database, [{**source, "observationCount": True}])

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
            connection = sqlite3.connect(database)
            with connection:
                connection.executemany(
                    "INSERT INTO snapshots (id, name, device_count, devices_json, created_at) VALUES (?, ?, 0, '[]', ?)",
                    [(f"final-2026-10-21-{suffix}", f"Final {suffix}", "2026-10-21T00:00:00Z") for suffix in "abc"],
                )
            connection.close()
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
                {**events[0], "sourceFinalId": "missing-final"},
                {**events[0], "observedAt": "2026-02-30T10:00:00Z"},
                {**events[1], "fromValue": "—"},
                {**events[0], "eventType": []},
            ]
            for invalid in invalid_events:
                with self.subTest(invalid=invalid):
                    with self.assertRaises(ValueError):
                        save_resolved_history(database, [invalid])
            self.assertEqual(list_resolved_history(database)["total"], 3)

    def test_optional_history_can_page_an_exact_primary_or_inventory_alias_mac(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "history-by-mac.db"
            initialize_database(database)
            connection = sqlite3.connect(database)
            with connection:
                connection.execute(
                    "INSERT INTO snapshots (id, name, device_count, devices_json, created_at) VALUES (?, ?, 0, '[]', ?)",
                    ("final-a", "Final A", "2026-10-22T00:00:00Z"),
                )
            connection.close()
            save_resolved_devices(database, [{
                "internalDeviceId": "device-a", "mac": "00:11:22:33:44:55",
                "alternateMacs": ["AA:BB:CC:DD:EE:66"],
            }])
            save_resolved_history(database, [
                {
                    "sourceFinalId": "final-a", "observedAt": "2026-10-22T10:00:00Z",
                    "internalDeviceId": "device-a", "eventType": "modified", "mac": "00:11:22:33:44:55",
                    "field": "room", "fromValue": "101", "toValue": "202",
                },
                {
                    "sourceFinalId": "final-a", "observedAt": "2026-10-22T10:05:00Z",
                    "internalDeviceId": "device-a", "eventType": "modified", "mac": "00:11:22:33:44:55",
                    "field": "ip", "fromValue": "10.0.0.1", "toValue": "10.0.0.2",
                },
                {
                    "sourceFinalId": "final-a", "observedAt": "2026-10-22T10:10:00Z",
                    "internalDeviceId": "device-b", "eventType": "added", "mac": "00:11:22:33:44:77",
                },
            ])

            first = list_resolved_history_for_mac(database, "aa-bb-cc-dd-ee-66", limit=1)
            self.assertEqual(first["total"], 2)
            self.assertIsNotNone(first["nextCursor"])
            self.assertEqual(first["events"][0]["eventType"], "modified")
            self.assertEqual(first["events"][0]["internalDeviceId"], "device-a")
            next_page = list_resolved_history_for_mac(database, "AABBCCDDEE66", after=first["nextCursor"], limit=1)
            self.assertEqual(next_page["total"], 2)
            self.assertIsNone(next_page["nextCursor"])
            self.assertEqual(next_page["events"][0]["field"], "ip")

            page1 = list_resolved_history_for_mac(database, "00:11:22:33:44:55", limit=1)
            self.assertEqual(page1["total"], 2)
            self.assertEqual(page1["events"][0]["field"], "room")
            direct_mac_page = list_resolved_history_for_mac(database, "001122334477", limit=1)
            self.assertEqual(direct_mac_page["total"], 1)
            self.assertEqual(direct_mac_page["events"][0]["eventType"], "added")
            self.assertEqual(direct_mac_page["events"][0]["id"], 3)
            with self.assertRaisesRegex(ValueError, "valid MAC"):
                list_resolved_history_for_mac(database, "not-a-mac")

    def test_schema_v6_migration_adds_history_mac_index_without_losing_events(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "schema-v6-history.db"
            initialize_database(database)
            connection = sqlite3.connect(database)
            with connection:
                connection.execute(
                    "INSERT INTO snapshots (id, name, device_count, devices_json, created_at) VALUES (?, ?, 0, '[]', ?)",
                    ("final-v6", "Final v6", "2026-10-22T00:00:00Z"),
                )
            connection.close()
            save_resolved_history(database, [{
                "sourceFinalId": "final-v6", "observedAt": "2026-10-22T10:00:00Z",
                "internalDeviceId": "device-v6", "eventType": "added", "mac": "00:11:22:33:44:88",
            }])
            connection = sqlite3.connect(database)
            with connection:
                connection.execute("DROP INDEX idx_resolved_history_mac")
                connection.execute("PRAGMA user_version=6")
            connection.close()

            result = initialize_database(database)

            self.assertEqual(result["schemaVersion"], 7)
            self.assertTrue(Path(result["backup"]["path"]).is_file())
            connection = sqlite3.connect(database)
            with connection:
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 7)
                index_names = {row[1] for row in connection.execute("PRAGMA index_list(resolved_device_history)")}
                self.assertIn("idx_resolved_history_mac", index_names)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM resolved_device_history").fetchone()[0], 1)
            connection.close()
            page = list_resolved_history_for_mac(database, "001122334488")
            self.assertEqual(page["total"], 1)
            self.assertEqual(page["events"][0]["sourceFinalId"], "final-v6")

    def test_optional_snapshot_api_pages_metadata_and_devices_without_exposing_whole_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "snapshots.db"
            initialize_database(database)
            devices = [
                {"internalDeviceId": f"device-{index}", "mac": f"00:11:22:33:44:{index:02X}"}
                for index in range(1, 4)
            ]
            with sqlite3.connect(database) as connection:
                connection.executemany(
                    "INSERT INTO snapshots (id, name, source, device_count, devices_json, created_at, signature) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [
                        ("snapshot-a", "Current", "Main.csv", len(devices), json.dumps(devices), "2026-10-21T00:00:00Z", "sig-a"),
                        ("snapshot-b", "Previous", "Previous.csv", 0, "[]", "2026-10-20T00:00:00Z", "sig-b"),
                    ],
                )
            connection.close()

            first = list_snapshots(database, limit=1)
            second = list_snapshots(database, after=first["nextCursor"], limit=1)
            self.assertEqual(first["total"], 2)
            self.assertEqual(first["snapshots"][0]["id"], "snapshot-a")
            self.assertNotIn("devices_json", first["snapshots"][0])
            self.assertEqual(second["snapshots"][0]["signature"], "sig-b")
            self.assertIsNone(second["nextCursor"])

            page1 = list_snapshot_devices(database, "snapshot-a", limit=2)
            page2 = list_snapshot_devices(database, "snapshot-a", after=page1["nextCursor"], limit=2)
            self.assertEqual(page1["deviceCount"], 3)
            self.assertEqual([row["internalDeviceId"] for row in page1["devices"]], ["device-1", "device-2"])
            self.assertEqual([row["internalDeviceId"] for row in page2["devices"]], ["device-3"])
            self.assertIsNone(page2["nextCursor"])
            with self.assertRaisesRegex(ValueError, "does not match its metadata"):
                with sqlite3.connect(database) as connection:
                    connection.execute("UPDATE snapshots SET device_count=4 WHERE id='snapshot-a'")
                connection.close()
                list_snapshot_devices(database, "snapshot-a", limit=1)

    def test_deleting_optional_snapshot_removes_only_its_history_and_preserves_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "snapshot-delete.db"
            initialize_database(database)
            with sqlite3.connect(database) as connection:
                connection.executemany(
                    "INSERT INTO snapshots (id, name, source, device_count, devices_json, created_at, signature) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [(snapshot_id, snapshot_id, "Main.csv", 0, "[]", "2026-10-22T00:00:00Z", snapshot_id)
                     for snapshot_id in ("delete-me", "keep-me")],
                )
            connection.close()
            history = [
                {"sourceFinalId": "delete-me", "observedAt": "2026-10-22T00:00:00Z", "internalDeviceId": "device-a", "eventType": "added"},
                {"sourceFinalId": "keep-me", "observedAt": "2026-10-22T00:00:01Z", "internalDeviceId": "device-b", "eventType": "added"},
            ]
            save_resolved_history(database, history)
            inventory = save_resolved_devices(database, [{"deviceId": "device-a", "mac": "00:11:22:33:44:55"}])
            result = delete_snapshot(database, "delete-me")

            self.assertEqual(result, {
                "ok": True, "snapshotId": "delete-me", "deletedSnapshotCount": 1,
                "deletedHistoryCount": 1, "inventoryPreserved": True,
            })
            self.assertEqual(list_snapshots(database)["snapshots"], [{
                "id": "keep-me", "name": "keep-me", "source": "Main.csv", "deviceCount": 0,
                "createdAt": "2026-10-22T00:00:00Z", "signature": "keep-me",
            }])
            remaining_history = list_resolved_history(database)["events"]
            self.assertEqual(len(remaining_history), 1)
            self.assertEqual(remaining_history[0]["sourceFinalId"], "keep-me")
            self.assertEqual(list_resolved_devices(database)["total"], inventory["savedCount"])
            with self.assertRaisesRegex(FileNotFoundError, "not found"):
                delete_snapshot(database, "delete-me")

    def test_schema_v5_upgrade_backfills_snapshot_id_index_for_saved_history(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "schema-v5-history.db"
            connection = sqlite3.connect(database)
            with connection:
                connection.execute("""CREATE TABLE resolved_device_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, observation_key TEXT NOT NULL UNIQUE,
                    internal_device_id TEXT NOT NULL, source TEXT, payload_json TEXT NOT NULL,
                    recorded_at TEXT NOT NULL)""")
                payload = {"sourceFinalId": "legacy-final", "internalDeviceId": "device-a", "observedAt": "2026-10-20T00:00:00Z"}
                connection.execute(
                    "INSERT INTO resolved_device_history (observation_key, internal_device_id, source, payload_json, recorded_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    ("old-key", "device-a", "Main.csv", json.dumps(payload), payload["observedAt"]),
                )
                connection.execute("PRAGMA user_version=5")
            connection.close()

            result = initialize_database(database)
            connection = sqlite3.connect(database)
            with connection:
                row = connection.execute("SELECT source_final_id FROM resolved_device_history WHERE id=1").fetchone()
                indexes = {item[1] for item in connection.execute("PRAGMA index_list(resolved_device_history)")}
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 7)
            connection.close()
            self.assertEqual(result["schemaVersion"], 7)
            self.assertEqual(row[0], "legacy-final")
            self.assertIn("idx_resolved_history_source_final", indexes)

    def test_snapshot_stream_write_is_atomic_requires_unique_strong_identity_and_never_replaces(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "snapshot-write.db"
            initialize_database(database)
            metadata = {
                "type": "snapshot", "id": "uploaded-final", "name": "Uploaded Final", "source": "Main.csv",
                "createdAt": "2026-10-21T10:00:00+03:00", "deviceCount": 2,
            }
            devices = [
                {"internalDeviceId": "device-a", "mac": "00:11:22:33:44:55"},
                {"deviceId": "Device-B", "mac": "AA:BB:CC:DD:EE:FF"},
            ]
            lines = [json.dumps(item, ensure_ascii=False).encode("utf-8") for item in [metadata, *devices]]
            saved = save_snapshot_stream(database, "uploaded-final", iter(lines))
            self.assertEqual(saved["deviceCount"], 2)
            self.assertEqual(len(saved["signature"]), 64)
            self.assertFalse(saved["alreadyExists"])
            repeated = save_snapshot_stream(database, "uploaded-final", iter(lines))
            self.assertTrue(repeated["alreadyExists"])
            self.assertEqual(repeated["signature"], saved["signature"])
            self.assertEqual(
                [device["internalDeviceId"] for device in list_snapshot_devices(database, "uploaded-final")["devices"]],
                ["device-a", _normalized_identity(devices[1])],
            )
            with self.assertRaisesRegex(ValueError, "cannot be replaced"):
                save_snapshot_stream(database, "uploaded-final", iter([
                    json.dumps({**metadata, "deviceCount": 0}, ensure_ascii=False).encode("utf-8"),
                ]))
            changed_metadata = {**metadata, "name": "Changed name"}
            with self.assertRaisesRegex(ValueError, "cannot be replaced"):
                save_snapshot_stream(database, "uploaded-final", iter(
                    json.dumps(item, ensure_ascii=False).encode("utf-8")
                    for item in [changed_metadata, *devices]
                ))
            connection = sqlite3.connect(database)
            connection.execute(
                "UPDATE snapshots SET devices_json = ? WHERE id = ?",
                (json.dumps([{"internalDeviceId": "tampered-a"}, json.loads(lines[2])]), "uploaded-final"),
            )
            connection.commit()
            connection.close()
            with self.assertRaisesRegex(ValueError, "cannot be replaced"):
                save_snapshot_stream(database, "uploaded-final", iter(lines))
            duplicate_metadata = {**metadata, "id": "duplicate-final"}
            duplicate_devices = [
                {"deviceId": "duplicate", "mac": "00:11:22:33:44:11"},
                {"deviceId": "DUPLICATE", "mac": "AA:BB:CC:DD:EE:22"},
            ]
            with self.assertRaisesRegex(ValueError, "duplicate strong device identities"):
                save_snapshot_stream(database, "duplicate-final", iter(
                    json.dumps(item, ensure_ascii=False).encode("utf-8")
                    for item in [duplicate_metadata, *duplicate_devices]
                ))
            duplicate_strong_identifiers = (
                (
                    {"internalDeviceId": "device-a", "deviceId": "shared-device", "mac": "00:11:22:33:44:11"},
                    {"internalDeviceId": "device-b", "deviceId": "SHARED-DEVICE", "mac": "AA:BB:CC:DD:EE:22"},
                ),
                (
                    {"internalDeviceId": "device-a", "serialNumber": "shared-serial", "mac": "00:11:22:33:44:11"},
                    {"internalDeviceId": "device-b", "serialNumber": "SHARED-SERIAL", "mac": "AA:BB:CC:DD:EE:22"},
                ),
                (
                    {"internalDeviceId": "device-a", "mac": "00:11:22:33:44:11"},
                    {"internalDeviceId": "device-b", "macFormatted": "0011.2233.4411"},
                ),
                (
                    {"internalDeviceId": "device-a", "mac": "00:11:22:33:44:11"},
                    {"internalDeviceId": "device-b", "alternateMacs": ["00-11-22-33-44-11"]},
                ),
            )
            for index, duplicate_pair in enumerate(duplicate_strong_identifiers, start=1):
                duplicate_id = f"duplicate-strong-{index}"
                duplicate_meta = {**metadata, "id": duplicate_id, "deviceCount": len(duplicate_pair)}
                with self.subTest(identity=index), self.assertRaisesRegex(ValueError, "duplicate strong device identities"):
                    save_snapshot_stream(database, duplicate_id, iter(
                        json.dumps(item, ensure_ascii=False).encode("utf-8")
                        for item in [duplicate_meta, *duplicate_pair]
                    ))
            with self.assertRaisesRegex(ValueError, "alternateMacs"):
                save_snapshot_stream(database, "invalid-alternate-macs", iter([
                    json.dumps({**metadata, "id": "invalid-alternate-macs", "deviceCount": 1}).encode("utf-8"),
                    json.dumps({"internalDeviceId": "device-a", "alternateMacs": "00:11:22:33:44:11"}).encode("utf-8"),
                ]))
            with self.assertRaisesRegex(ValueError, "at most 64"):
                save_snapshot_stream(database, "too-many-alternate-macs", iter([
                    json.dumps({**metadata, "id": "too-many-alternate-macs", "deviceCount": 1}).encode("utf-8"),
                    json.dumps({"internalDeviceId": "device-a", "alternateMacs": [f"00:11:22:33:44:{index:02X}" for index in range(65)]}).encode("utf-8"),
                ]))
            with self.assertRaisesRegex(ValueError, "deviceCount"):
                save_snapshot_stream(database, "wrong-count-final", iter([
                    json.dumps({**metadata, "id": "wrong-count-final", "deviceCount": 1}, ensure_ascii=False).encode("utf-8"),
                ]))
            with self.assertRaisesRegex(ValueError, "duplicate keys"):
                save_snapshot_stream(database, "duplicate-key-final", iter([
                    json.dumps({**metadata, "id": "duplicate-key-final", "deviceCount": 1}, ensure_ascii=False).encode("utf-8"),
                    b'{"internalDeviceId":"a","internalDeviceId":"b"}',
                ]))
            self.assertEqual(list_snapshots(database)["total"], 1)

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
            self.assertEqual(second["schemaVersion"], 7)
            self.assertIsNone(second["backup"])
            self.assertEqual(load_settings(database)["settings"], loaded["settings"])
            self.assertEqual(database_summary(database)["counts"]["device_inventory"], 0)

    def test_identity_conflict_lookup_uses_normalized_sqlite_indexes(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "indexed.db"
            initialize_database(database)
            with sqlite3.connect(database) as connection:
                details = " ".join(str(row[3]) for row in connection.execute(
                    "EXPLAIN QUERY PLAN SELECT internal_device_id FROM resolved_device_identity_aliases "
                    "WHERE identity_type = ? AND identity_value = ?", ("mac", "001122334455"),
                ))
                self.assertIn("idx_resolved_identity_alias_lookup", details)
            connection.close()
            self.assertTrue(any(statement.startswith("CREATE INDEX IF NOT EXISTS idx_resolved_identity_alias_lookup")
                                for statement in INDEXES))

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
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 7)
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
            self.assertEqual(result["schemaVersion"], 7)

    def test_schema_v4_migration_builds_indexed_primary_and_alternate_mac_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "schema-v4.db"
            initialize_database(database)
            with sqlite3.connect(database) as connection:
                connection.execute(
                    "INSERT INTO resolved_device_inventory "
                    "(internal_device_id, mac, device_id, payload_json, first_seen, updated_at, seen_count) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("stable-internal", "00:11:22:33:44:51", "stable-device",
                     json.dumps({"internalDeviceId": "stable-internal", "deviceId": "stable-device",
                                 "mac": "00:11:22:33:44:51", "alternateMacs": ["AA:BB:CC:DD:EE:61"]}),
                     "2026-01-01", "2026-01-02", 7),
                )
                connection.execute("DROP TABLE resolved_device_identity_aliases")
                connection.execute("PRAGMA user_version=4")
            connection.close()
            result = initialize_database(database)
            with sqlite3.connect(database) as connection:
                aliases = set(connection.execute(
                    "SELECT identity_type, identity_value FROM resolved_device_identity_aliases "
                    "WHERE internal_device_id='stable-internal'"
                ))
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 7)
                self.assertEqual(connection.execute(
                    "SELECT seen_count FROM resolved_device_inventory WHERE internal_device_id='stable-internal'"
                ).fetchone()[0], 7)
            connection.close()
            self.assertEqual(aliases, {
                ("internal", "stable-internal"), ("device", "stable-device"),
                ("mac", "001122334451"), ("mac", "AABBCCDDEE61"),
            })
            self.assertTrue(Path(result["backup"]["path"]).is_file())

    def test_alternate_mac_matches_resolved_inventory_and_derives_missing_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "alternate-mac.db"
            initialize_database(database)
            first = save_resolved_devices(database, [{
                "internalDeviceId": "stable-device", "deviceId": "edge-1", "mac": "00:11:22:33:44:51",
                "alternateMacs": ["AA:BB:CC:DD:EE:61"],
            }])
            self.assertEqual(first["savedCount"], 1)
            matched = save_resolved_devices(database, [{
                "deviceId": "edge-1", "mac": "AA-BB-CC-DD-EE-61", "room": "101",
            }])
            self.assertEqual(matched["saved"], ["stable-device"])
            self.assertEqual(matched["conflictCount"], 0)
            expanded_aliases = save_resolved_devices(database, [{
                "deviceId": "edge-1", "mac": "00:11:22:33:44:51",
                "alternateMacs": ["AA:BB:CC:DD:EE:61", "00:11:22:33:44:72"],
            }])
            self.assertEqual(expanded_aliases["saved"], ["stable-device"])
            with sqlite3.connect(database) as connection:
                payload = json.loads(connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id='stable-device'"
                ).fetchone()[0])
                self.assertIn("00:11:22:33:44:72", payload["alternateMacs"])
            connection.close()
            conflict = save_resolved_devices(database, [{
                "internalDeviceId": "different-device", "deviceId": "edge-1", "mac": "AA:BB:CC:DD:EE:61",
            }])
            self.assertEqual(conflict["savedCount"], 0)
            self.assertEqual(conflict["conflicts"][0]["reason"], "conflicting_strong_identity")
            alternate_only = save_resolved_devices(database, [{"alternateMacs": ["00:11:22:33:44:71"]}])
            self.assertEqual(alternate_only["savedCount"], 1)
            self.assertTrue(alternate_only["saved"][0].startswith("dev-"))
            with self.assertRaisesRegex(ValueError, "at most 64"):
                save_resolved_devices(database, [{
                    "internalDeviceId": "too-many-aliases",
                    "alternateMacs": [f"00:11:22:33:45:{index:02X}" for index in range(65)],
                }])

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
                connection.execute("PRAGMA user_version=8")
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
