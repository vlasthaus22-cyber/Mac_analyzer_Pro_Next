import json
import sqlite3
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))
from unittest.mock import patch

from scripts.optional_sqlite_store import (  # noqa: E402
    INDEXES,
    REQUIRED_TABLES,
    SettingsResponseTooLarge,
    _strong_identity_aliases,
    _normalized_identity,
    database_maintenance,
    database_maintenance,
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
    search_database,
)
from backend.services.system.sqlite_store import EMPTY_HISTORY_VALUES, _EMPTY_IDENTITY_VALUES  # noqa: E402


def _custom_key(label):
    identifier = uuid.uuid5(uuid.NAMESPACE_URL, f"test:{label}")
    return f"custom_{identifier}"


class OptionalSQLiteStoreTests(unittest.TestCase):
    def test_history_empty_value_markers_match_the_shared_browser_fixture(self):
        markers = json.loads((ROOT / "tests" / "fixtures" / "empty-value-markers.json").read_text(encoding="utf-8"))
        self.assertEqual(EMPTY_HISTORY_VALUES, set(markers))

    def test_inventory_identity_ignores_every_browser_empty_marker_before_mac_fallback(self):
        markers = json.loads((ROOT / "tests" / "fixtures" / "empty-value-markers.json").read_text(encoding="utf-8"))
        self.assertEqual(_EMPTY_IDENTITY_VALUES, set(markers))
        mac = "00:11:22:33:44:55"
        expected = _normalized_identity({"mac": mac})

        for marker in markers:
            with self.subTest(marker=marker):
                self.assertEqual(_normalized_identity({"deviceId": marker, "mac": mac}), expected)

    def test_inventory_merge_treats_browser_empty_markers_as_blank_and_preserves_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "placeholder-inventory-merge.db"
            initialize_database(database)
            saved = save_resolved_devices(database, [{"internalDeviceId": "placeholder-merge-device"}])
            self.assertEqual(saved["savedCount"], 1)
            connection = sqlite3.connect(database)
            try:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("placeholder-merge-device",),
                ).fetchone()
                payload = json.loads(row[0])
                payload.update({
                    "manufacturer": "неизвестный вендор", "model": "Unknown Model", "room": "—",
                })
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload, ensure_ascii=False), "placeholder-merge-device"),
                )
                connection.commit()
            finally:
                connection.close()

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "placeholder-merge-device", "manufacturer": " Acme  Devices ",
                "model": "Room Codec", "room": " 101 ", "source": "Main",
                "fieldSources": {"manufacturer": "OUI", "model": "MAC5", "room": "Main"},
            }])
            self.assertEqual(merged["saved"], ["placeholder-merge-device"])
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["manufacturer"], "Acme Devices")
            self.assertEqual(device["model"], "Room Codec")
            self.assertEqual(device["room"], "101")
            self.assertEqual(device["fieldSources"], {"manufacturer": "OUI", "model": "MAC5", "room": "Main"})

            new = save_resolved_devices(database, [{
                "deviceId": "placeholder-only-device", "manufacturer": "неизвестная модель", "model": "unknown model",
            }])
            new_device = next(item for item in list_resolved_devices(database)["devices"] if item["deviceId"] == "placeholder-only-device")
            self.assertEqual(new["savedCount"], 1)
            self.assertEqual(new_device["manufacturer"], "")
            self.assertEqual(new_device["model"], "")

    def test_resolved_inventory_refreshes_stale_provenance_when_a_blank_field_is_filled(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "stale-field-source.db"
            initialize_database(database)
            save_resolved_devices(database, [{"internalDeviceId": "asset-provenance"}])
            connection = sqlite3.connect(database)
            try:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("asset-provenance",),
                ).fetchone()
                payload = json.loads(row[0])
                payload.update({"room": "—", "fieldSources": {"room": "Old import"}})
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload, ensure_ascii=False), "asset-provenance"),
                )
                connection.commit()
            finally:
                connection.close()

            save_resolved_devices(database, [{
                "internalDeviceId": "asset-provenance", "room": "101", "source": "Fresh import",
            }])
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["room"], "101")
            self.assertEqual(device["fieldSources"]["room"], "Fresh import")

    def test_inventory_merge_uses_valid_legacy_vendor_alias_before_replacing_manufacturer(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy-vendor-alias.db"
            initialize_database(database)
            save_resolved_devices(database, [{"internalDeviceId": "legacy-vendor-alias"}])
            connection = sqlite3.connect(database)
            try:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("legacy-vendor-alias",),
                ).fetchone()
                payload = json.loads(row[0])
                payload.update({
                    "manufacturer": "Unknown vendor", "vendor": "Acme",
                    "vendorConfidence": 0.7, "vendorSource": "Legacy OUI",
                })
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload, ensure_ascii=False), "legacy-vendor-alias"),
                )
                connection.commit()
            finally:
                connection.close()

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "legacy-vendor-alias", "manufacturer": "Replacement Vendor",
                "vendorConfidence": 0.95, "vendorSource": "New OUI", "source": "Main",
            }])

            self.assertEqual(merged["saved"], ["legacy-vendor-alias"])
            self.assertIn({
                "internalDeviceId": "legacy-vendor-alias", "field": "manufacturer",
                "selected": "Acme", "value": "Replacement Vendor", "source": "Main",
            }, merged["conflicts"])
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["manufacturer"], "Acme")
            self.assertEqual(device["vendorConfidence"], 0.7)
            self.assertEqual(device["vendorSource"], "Legacy OUI")

    def test_inventory_merge_uses_valid_legacy_device_ip_alias_before_replacing_ip(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy-device-ip-alias.db"
            initialize_database(database)
            save_resolved_devices(database, [{
                "internalDeviceId": "legacy-device-ip-alias", "ip": "192.0.2.10",
            }])
            connection = sqlite3.connect(database)
            try:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("legacy-device-ip-alias",),
                ).fetchone()
                payload = json.loads(row[0])
                payload.update({"ip": "Unknown", "deviceIp": "192.0.2.10"})
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload, ensure_ascii=False), "legacy-device-ip-alias"),
                )
                connection.commit()
            finally:
                connection.close()

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "legacy-device-ip-alias", "ip": "192.0.2.20", "source": "Main",
            }])

            self.assertEqual(merged["saved"], ["legacy-device-ip-alias"])
            self.assertIn({
                "internalDeviceId": "legacy-device-ip-alias", "field": "ip",
                "selected": "192.0.2.10", "value": "192.0.2.20", "source": "Main",
            }, merged["conflicts"])
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["ip"], "192.0.2.10")

    def test_inventory_merge_reports_known_field_conflicts_without_overwriting_values(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "known-field-conflicts.db"
            initialize_database(database)
            first = save_resolved_devices(database, [{
                "internalDeviceId": "known-field-conflicts", "manufacturer": "Acme",
                "room": "101", "source": "Main",
            }])
            self.assertEqual(first["savedCount"], 1)

            incoming = {
                "internalDeviceId": "known-field-conflicts", "manufacturer": "Other",
                "room": "202", "source": "SmartRoom",
            }
            merged = save_resolved_devices(database, [incoming])

            self.assertEqual(merged["saved"], ["known-field-conflicts"])
            self.assertEqual(merged["rejectedCount"], 0)
            self.assertEqual(merged["conflictCount"], 2)
            self.assertEqual(
                {(item["field"], item["selected"], item["value"], item["source"]) for item in merged["conflicts"]},
                {
                    ("manufacturer", "Acme", "Other", "SmartRoom"),
                    ("room", "101", "202", "SmartRoom"),
                },
            )
            stored = list_resolved_devices(database)["devices"][0]
            self.assertEqual(stored["manufacturer"], "Acme")
            self.assertEqual(stored["room"], "101")
            self.assertEqual(len(stored["conflicts"]), 2)

            repeated = save_resolved_devices(database, [incoming])
            self.assertEqual(repeated["conflictCount"], 0)
            self.assertEqual(len(list_resolved_devices(database)["devices"][0]["conflicts"]), 2)

    def test_database_search_matches_resolved_inventory_and_legacy_reference_records_with_bounded_projection(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "search.db"
            initialize_database(database)
            save_resolved_devices(database, [
                {
                    "deviceId": "codec-1", "mac": "00:11:22:33:44:55", "vendor": "Acme",
                    "model": "Room Codec", "ip": "192.0.2.8", "room": "Boardroom", "customFields": {_custom_key("secret"): "not returned"},
                },
                {"serialNumber": "SN-2", "mac": "AA:BB:CC:DD:EE:66", "vendor": "Other", "model": "Camera"},
            ])
            with sqlite3.connect(database) as connection:
                connection.execute(
                    "INSERT INTO vendor_model_history (mac, oui, prefix, vendor, model, source, observed_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("001122334455", "001122", "00112233", "Acme", "Room Codec", "learned", "2026-10-30T10:00:00Z"),
                )
                connection.execute(
                    "INSERT INTO ip_address_mappings (switch_ip, physical_address, source, updated_at) "
                    "VALUES (?, ?, ?, ?)",
                    ("192.0.2.1", "Building A", "manual", "2026-10-30T11:00:00Z"),
                )
            connection.close()

            by_model = search_database(database, "room codec")
            self.assertGreaterEqual(by_model["count"], 2)
            self.assertTrue(any(item["type"] == "device" and item["mac"] == "00:11:22:33:44:55" for item in by_model["results"]))
            self.assertTrue(any(item["type"] == "vendorModel" for item in by_model["results"]))
            self.assertTrue(all("customFields" not in item for item in by_model["results"]))

            exact_mac = search_database(database, "00:11:22:33:44:55", limit=1)
            self.assertEqual(exact_mac["count"], 1)
            self.assertEqual(exact_mac["results"][0]["type"], "device")
            self.assertEqual(exact_mac["results"][0]["mac"], "00:11:22:33:44:55")

            by_mapping = search_database(database, "building a")
            self.assertEqual(by_mapping["results"][0]["type"], "ipMapping")
            self.assertEqual(by_mapping["results"][0]["title"], "192.0.2.1")
            self.assertEqual(search_database(database, "missing")["count"], 0)

            with self.assertRaisesRegex(ValueError, "limit must be between"):
                search_database(database, "room", limit=501)
            with self.assertRaisesRegex(ValueError, "query must be text"):
                search_database(database, "x" * 257)

    def test_database_search_matches_browser_unicode_casefold_and_literal_query_semantics(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "unicode-search.db"
            initialize_database(database)
            save_resolved_devices(database, [
                {"internalDeviceId": "russian-vendor", "manufacturer": "ПРОЕКТОР"},
                {"internalDeviceId": "literal-underscore", "model": "Codec_1"},
                {"internalDeviceId": "no-underscore", "model": "CodecX1"},
            ])

            russian = search_database(database, "проектор")
            self.assertEqual(russian["count"], 1)
            self.assertIn("ПРОЕКТОР", russian["results"][0]["subtitle"])
            compatibility = search_database(database, "ＣＯＤＥＣ＿１")
            self.assertEqual(compatibility["count"], 1)
            self.assertIn("Codec_1", compatibility["results"][0]["subtitle"])
            self.assertEqual(search_database(database, "%")["count"], 0)
            literal_underscore = search_database(database, "_")
            self.assertEqual(literal_underscore["count"], 1)
            self.assertIn("Codec_1", literal_underscore["results"][0]["subtitle"])

    def test_database_search_ignores_unsearchable_device_metadata_like_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "search-fields.db"
            initialize_database(database)
            save_resolved_devices(database, [{
                "internalDeviceId": "asset-21", "mac": "00:11:22:33:44:55", "model": "Room Codec",
                "customFields": {"Rack label": "North closet"},
            }])
            with sqlite3.connect(database) as connection:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = 'asset-21'"
                ).fetchone()
                payload = json.loads(row[0])
                payload["customFields"] = {"Rack label": "North closet"}
                payload["alternateMacs"] = "AA:BB:CC:DD:EE:01,11:22:33:44:55:66"
                payload["privateImportNote"] = "secret-token-987"
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = 'asset-21'",
                    (json.dumps(payload),),
                )
            connection.close()

            self.assertEqual(search_database(database, "secret-token-987")["count"], 0)
            self.assertEqual(search_database(database, "north closet")["count"], 1)
            self.assertEqual(search_database(database, "rack label")["count"], 1)
            self.assertEqual(search_database(database, "001122334455")["count"], 1)
            self.assertEqual(search_database(database, "112233445566")["count"], 1)

    def test_resolved_database_search_uses_canonical_browser_projection_for_conflicting_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "canonical-search.db"
            initialize_database(database)
            save_resolved_devices(database, [{
                "internalDeviceId": "canonical-device",
                "manufacturer": "Known maker",
                "vendor": "Other maker",
                "serial": "SERIAL-A",
                "serialNumber": "SERIAL-B",
                "mac": "00:11:22:33:44:55",
                "mac_address": "AA:BB:CC:DD:EE:FF",
                "alternateMacs": ["AA:BB:CC:DD:EE:01"],
            }])

            self.assertEqual(search_database(database, "Known maker")["count"], 1)
            self.assertEqual(search_database(database, "Other maker")["count"], 0)
            self.assertEqual(search_database(database, "SERIAL-A")["count"], 1)
            self.assertEqual(search_database(database, "SERIAL-B")["count"], 0)
            self.assertEqual(search_database(database, "AA:BB:CC:DD:EE:FF")["count"], 0)
            self.assertEqual(search_database(database, "AA:BB:CC:DD:EE:01")["count"], 1)

    def test_optional_device_api_writes_additively_by_strong_identity_and_pages_all_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "data.db"
            initialize_database(database)
            first = {
                "deviceId": "Device-1", "mac": "00:11:22:33:44:55", "vendor": "Acme", "room": "101",
                "customFields": {_custom_key("assetTag"): "AV-101"},
            }
            second = {"serialNumber": "SN-2", "macFormatted": "AA:BB:CC:DD:EE:66", "model": "Codec"}
            saved = save_resolved_devices(database, [first, second])
            self.assertEqual(saved["savedCount"], 2)
            self.assertEqual(saved["conflictCount"], 0)

            repeated = save_resolved_devices(database, [{"deviceId": "device-1", "mac": "00:11:22:33:44:55", "vendor": ""}])
            self.assertEqual(repeated["saved"], saved["saved"][:1])
            self.assertEqual(repeated["conflicts"], [])
            conflict = save_resolved_devices(database, [{"deviceId": "Device-1", "mac": "00:11:22:33:44:77", "vendor": "Other"}])
            self.assertEqual(conflict["conflictCount"], 2)
            self.assertEqual(conflict["conflicts"][0]["reason"], "conflicting_strong_identity")
            self.assertEqual(conflict["conflicts"][1]["field"], "manufacturer")
            self.assertEqual(conflict["conflicts"][1]["value"], "Other")
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
            self.assertEqual(device["mac"], "00:11:22:33:44:55")
            self.assertIn("00:11:22:33:44:77", device["alternateMacs"])
            self.assertEqual(device["customFields"], {_custom_key("assetTag"): "AV-101"})
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM resolved_device_inventory").fetchone()[0], 3)
                self.assertEqual(connection.execute("SELECT seen_count FROM resolved_device_inventory WHERE device_id='Device-1'").fetchone()[0], 3)
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
                "customFields": {_custom_key("rack"): "A1", _custom_key("owner"): "Operations"},
                "customFieldSources": {_custom_key("rack"): "Main", _custom_key("owner"): "Main"},
                "conflicts": [original_conflict], "alternateMacs": ["AA:BB:CC:00:00:01"],
            }])

            save_resolved_devices(database, [{
                "deviceId": "DEVICE-A", "mac": "00:11:22:33:44:55", "vendor": "Replacement Vendor",
                "ip": "192.0.2.10", "sources": ["DDIO", "Main"],
                "fieldSources": {"vendor": "DDIO", "ip": "DDIO"},
                "customFields": {_custom_key("rack"): "B2", _custom_key("building"): "North"},
                "customFieldSources": {_custom_key("rack"): "DDIO", _custom_key("building"): "DDIO"},
                "conflicts": [{"values": ["101", "202"], "field": "room"}, added_conflict],
                "alternateMacs": ["aa-bb-cc-00-00-01", "AA:BB:CC:00:00:02"],
            }])

            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["vendor"], "Known Vendor")
            self.assertEqual(device["ip"], "192.0.2.10")
            self.assertEqual(device["sources"], ["Main", "DDIO"])
            self.assertEqual(device["fieldSources"], {"vendor": "Main", "ip": "DDIO"})
            self.assertEqual(device["customFields"], {_custom_key("rack"): "A1", _custom_key("owner"): "Operations", _custom_key("building"): "North"})
            self.assertEqual(device["customFieldSources"], {
                _custom_key("rack"): "Main", _custom_key("owner"): "Main", _custom_key("building"): "DDIO",
            })
            self.assertEqual(device["conflicts"], [
                original_conflict,
                {"field": "customField", "key": _custom_key("rack"), "selected": "A1", "value": "B2", "source": "DDIO"},
                added_conflict,
                {"field": "manufacturer", "selected": "Known Vendor", "value": "Replacement Vendor", "source": ""},
            ])
            self.assertEqual(device["alternateMacs"], ["AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02"])

    def test_custom_field_merge_matches_browser_empty_marker_and_text_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "custom-field-normalization.db"
            initialize_database(database)
            saved = save_resolved_devices(database, [{
                "internalDeviceId": "custom-normalization-device",
            }])
            self.assertEqual(saved["savedCount"], 1)
            connection = sqlite3.connect(database)
            try:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("custom-normalization-device",),
                ).fetchone()
                payload = json.loads(row[0])
                payload["customFields"] = {
                    _custom_key("placeholder"): "Unknown", _custom_key("same"): " ACME  ",
                    _custom_key("different"): "Acme", _custom_key("marker"): "—",
                }
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload, ensure_ascii=False), "custom-normalization-device"),
                )
                connection.commit()
            finally:
                connection.close()

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "custom-normalization-device", "source": "SmartRoom",
                "customFields": {
                    _custom_key("placeholder"): "  North   Rack ", _custom_key("same"): "acme",
                    _custom_key("different"): "Other", _custom_key("marker"): "—",
                    _custom_key("incomingPlaceholder"): " неизвестен ",
                },
            }])

            self.assertEqual(merged["conflictCount"], 1)
            self.assertEqual(merged["conflicts"], [{
                "internalDeviceId": "custom-normalization-device", "field": "customField", "key": _custom_key("different"),
                "selected": "Acme", "value": "Other", "source": "SmartRoom",
            }])
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["customFields"], {
                _custom_key("placeholder"): "North Rack", _custom_key("same"): "ACME",
                _custom_key("different"): "Acme",
            })
            self.assertEqual(device["customFieldSources"][_custom_key("placeholder")], "SmartRoom")
            self.assertNotIn(_custom_key("incomingPlaceholder"), device["customFields"])
            connection = sqlite3.connect(database)
            stored_payload = json.loads(connection.execute(
                "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                ("custom-normalization-device",),
            ).fetchone()[0])
            connection.close()
            self.assertEqual(stored_payload["customFields"][_custom_key("same")], " ACME  ")
            self.assertEqual(stored_payload["customFields"][_custom_key("marker")], "—")

    def test_custom_fields_are_browser_normalized_before_first_inventory_insert(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "custom-field-insert-normalization.db"
            initialize_database(database)

            result = save_resolved_devices(database, [{
                "internalDeviceId": "custom-insert-device",
                "customFields": {
                    _custom_key("rack"): "  A1   West ", _custom_key("count"): 7, _custom_key("enabled"): True,
                    _custom_key("placeholder"): " unknown ", _custom_key("nested"): {"untrusted": "value"},
                },
                "customFieldSources": {
                    _custom_key("rack"): " Main ", _custom_key("count"): "OUI",
                    _custom_key("placeholder"): "unknown", _custom_key("nested"): {"secret": True},
                },
                "fieldSources": {"room": "—", "model": " MAC5 "},
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["customFields"], {_custom_key("rack"): "A1 West", _custom_key("count"): "7", _custom_key("enabled"): "true"})
            self.assertEqual(device["customFieldSources"], {_custom_key("rack"): "Main", _custom_key("count"): "OUI"})
            self.assertEqual(device["fieldSources"], {"model": "MAC5"})

    def test_custom_fields_and_sources_require_browser_custom_field_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "custom-field-id-validation.db"
            initialize_database(database)
            valid_key = _custom_key("valid")
            empty_key = _custom_key("empty")
            orphan_key = _custom_key("orphan")

            result = save_resolved_devices(database, [{
                "internalDeviceId": "custom-id-validation-device",
                "customFields": {
                    valid_key: "Rack 4", "legacyName": "must be dropped",
                    empty_key: "Unknown", "nested": {"untrusted": "value"},
                },
                "customFieldSources": {
                    valid_key: " Main ", "legacyName": "ignored", empty_key: "ignored", orphan_key: "orphaned",
                },
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["customFields"], {valid_key: "Rack 4"})
            self.assertEqual(device["customFieldSources"], {valid_key: "Main"})

    def test_possible_ip_evidence_uses_browser_ip_normalization_on_insert(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "possible-ip-normalization.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "internalDeviceId": "possible-ip-device",
                "possibleIps": [
                    "192.000.2.010", "192.0.2.10", "2001:0DB8:0:0::1", "2001:db8::1",
                    "::ffff:192.000.2.1", "not-an-ip", "00:11:22:33:44:55", "[2001:db8::2]",
                ],
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["possibleIps"], [
                "192.0.2.10", "2001:db8::1", "::ffff:c000:201", "2001:db8::2",
            ])

    def test_possible_ip_additive_merge_normalizes_legacy_values_and_ignores_invalid_text(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "possible-ip-legacy-merge.db"
            initialize_database(database)
            save_resolved_devices(database, [{"internalDeviceId": "possible-ip-legacy-device"}])
            connection = sqlite3.connect(database)
            try:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("possible-ip-legacy-device",),
                ).fetchone()
                payload = json.loads(row[0])
                payload["possibleIps"] = ["192.000.2.010", "invalid", "2001:0db8:0:0::1"]
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload), "possible-ip-legacy-device"),
                )
                connection.commit()
            finally:
                connection.close()

            save_resolved_devices(database, [{
                "internalDeviceId": "possible-ip-legacy-device", "possibleIps": ["192.0.2.10", "2001:db8::2"],
            }])

            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["possibleIps"], ["192.0.2.10", "2001:db8::1", "2001:db8::2"])

    def test_alternate_macs_are_normalized_and_validated_like_browser_merge(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "alternate-mac-normalization.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "internalDeviceId": "alternate-normalization-device", "mac": "00:11:22:33:44:55",
                "alternateMacs": [
                    "aa-bb-cc-dd-ee-01", "AABBCCDDEE01", "aabb.ccdd.ee02", "prefix AA:BB:CC:DD:EE:03 suffix",
                    "AA:BB:CC:DD:EE:04", "00:11:22:33:44:55", "00:00:00:00:00:00",
                ],
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["alternateMacs"], [
                "AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02", "AA:BB:CC:DD:EE:03", "AA:BB:CC:DD:EE:04",
            ])

    def test_alternate_mac_additive_merge_canonicalizes_legacy_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "alternate-mac-legacy-merge.db"
            initialize_database(database)
            save_resolved_devices(database, [{"internalDeviceId": "alternate-legacy-device"}])
            connection = sqlite3.connect(database)
            try:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("alternate-legacy-device",),
                ).fetchone()
                payload = json.loads(row[0])
                payload["alternateMacs"] = ["aa-bb-cc-dd-ee-01", "embedded AA:BB:CC:DD:EE:02"]
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload), "alternate-legacy-device"),
                )
                connection.commit()
            finally:
                connection.close()

            save_resolved_devices(database, [{
                "internalDeviceId": "alternate-legacy-device", "alternateMacs": [
                    "AA:BB:CC:DD:EE:01", "aabb.ccdd.ee03",
                ],
            }])

            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["alternateMacs"], [
                "AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02", "AA:BB:CC:DD:EE:03",
            ])

    def test_alternate_mac_additive_merge_never_reintroduces_primary_mac(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "alternate-mac-primary-merge.db"
            initialize_database(database)
            saved = save_resolved_devices(database, [{
                "internalDeviceId": "alternate-primary-device", "mac": "AA:BB:CC:DD:EE:11",
            }])
            self.assertEqual(saved["savedCount"], 1)

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "alternate-primary-device",
                "alternateMacs": ["aa-bb-cc-dd-ee-11", "AA:BB:CC:DD:EE:12"],
            }])

            self.assertEqual(merged["saved"], ["alternate-primary-device"])
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["mac"], "AA:BB:CC:DD:EE:11")
            self.assertEqual(device["alternateMacs"], ["AA:BB:CC:DD:EE:12"])

    def test_alternate_mac_primary_filter_preserves_browser_limit_order(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "alternate-mac-primary-limit-order.db"
            initialize_database(database)
            existing_alternates = [
                f"AA:BB:CC:DD:{index // 256:02X}:{index % 256:02X}" for index in range(99)
            ]
            primary_mac = "AA:BB:CC:EE:FF:01"
            saved = save_resolved_devices(database, [{
                "internalDeviceId": "alternate-primary-limit-device", "mac": primary_mac,
                "alternateMacs": existing_alternates,
            }])
            self.assertEqual(saved["savedCount"], 1)

            save_resolved_devices(database, [{
                "internalDeviceId": "alternate-primary-limit-device",
                "alternateMacs": [primary_mac, "AA:BB:CC:EE:FF:02"],
            }])

            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["alternateMacs"], existing_alternates)
            self.assertTrue(device["alternateMacsTruncated"])

    def test_inventory_sources_match_browser_normalization_on_insert(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "sources-normalization.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "internalDeviceId": "sources-normalization-device", "source": "  Main  ",
                "sources": [" Main ", "main", "", "—", " OUI "],
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["sources"], ["Main", "OUI"])
            self.assertEqual(device["source"], "Main")

    def test_inventory_source_merge_normalizes_legacy_labels_and_adds_current_source(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "sources-legacy-merge.db"
            initialize_database(database)
            save_resolved_devices(database, [{"internalDeviceId": "sources-legacy-device"}])
            connection = sqlite3.connect(database)
            try:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("sources-legacy-device",),
                ).fetchone()
                payload = json.loads(row[0])
                payload["sources"] = [" Main ", "main", "—", "OUI"]
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload, ensure_ascii=False), "sources-legacy-device"),
                )
                connection.commit()
            finally:
                connection.close()

            save_resolved_devices(database, [{
                "internalDeviceId": "sources-legacy-device", "sources": [" ddio ", "DDIO"],
                "source": "SmartRoom",
            }])

            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["sources"], ["Main", "OUI", "ddio", "SmartRoom"])

    def test_device_and_switch_ip_fields_match_browser_normalization_on_insert(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "device-ip-normalization.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "internalDeviceId": "device-ip-normalization", "ip": "192.000.2.010",
                "switchIp": "2001:0DB8:0:0::1",
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["ip"], "192.0.2.10")
            self.assertEqual(device["switchIp"], "2001:db8::1")

    def test_device_and_switch_ip_additive_merge_normalize_legacy_values_without_false_conflicts(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "device-ip-legacy-merge.db"
            initialize_database(database)
            save_resolved_devices(database, [{"internalDeviceId": "device-ip-legacy"}])
            connection = sqlite3.connect(database)
            try:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("device-ip-legacy",),
                ).fetchone()
                payload = json.loads(row[0])
                payload["ip"] = "192.000.2.010"
                payload["switchIp"] = "invalid"
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload), "device-ip-legacy"),
                )
                connection.commit()
            finally:
                connection.close()

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "device-ip-legacy", "ip": "192.0.2.10", "switchIp": "2001:db8::1",
            }])

            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(merged["conflictCount"], 0)
            self.assertEqual(device["ip"], "192.0.2.10")
            self.assertEqual(device["switchIp"], "2001:db8::1")

    def test_resolved_inventory_bounds_merged_mac_and_possible_ip_evidence_at_browser_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "bounded-device-evidence.db"
            initialize_database(database)
            alternate_macs = [f"AA:BB:CC:DD:EE:{index:02X}" for index in range(140)]
            possible_ips = [f"2001:db8::{index:x}" for index in range(140)]
            first = save_resolved_devices(database, [{
                "internalDeviceId": "bounded-evidence-device", "mac": "00:11:22:33:44:55",
                "alternateMacs": alternate_macs[:70], "possibleIps": possible_ips[:70],
            }])
            self.assertEqual(first["savedCount"], 1)

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "bounded-evidence-device", "mac": "00:11:22:33:44:55",
                "alternateMacs": alternate_macs[70:], "possibleIps": possible_ips[70:],
            }])

            self.assertEqual(merged["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(len(device["alternateMacs"]), 100)
            self.assertTrue(device["alternateMacsTruncated"])
            self.assertEqual(len(device["possibleIps"]), 100)
            self.assertTrue(device["possibleIpsTruncated"])
            self.assertEqual(device["possibleIps"][0], "2001:db8::")
            self.assertEqual(device["possibleIps"][-1], possible_ips[99])

    def test_resolved_inventory_observation_state_keeps_newest_presence_and_final_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "inventory-presence-state.db"
            initialize_database(database)
            base = {
                "internalDeviceId": "presence-device", "deviceId": "edge-1",
                "firstSeen": "2026-01-02T00:00:00Z", "lastSeen": "2026-03-02T00:00:00Z",
                "present": True, "snapshotId": "final-2",
            }

            def stored_first_seen():
                connection = sqlite3.connect(database)
                try:
                    return connection.execute(
                        "SELECT first_seen FROM resolved_device_inventory WHERE internal_device_id = ?",
                        ("presence-device",),
                    ).fetchone()[0]
                finally:
                    connection.close()

            self.assertEqual(save_resolved_devices(database, [base])["savedCount"], 1)
            self.assertEqual(stored_first_seen(), "2026-01-02T00:00:00Z")
            absent = {
                **base, "firstSeen": "2025-12-30T00:00:00Z", "lastSeen": "2026-03-03T00:00:00Z",
                "lastMissing": "2026-04-01T00:00:00Z", "present": False,
            }
            save_resolved_devices(database, [absent])
            self.assertEqual(stored_first_seen(), "2025-12-30T00:00:00Z")
            stale = {
                **base, "firstSeen": "2025-12-20T00:00:00Z", "lastSeen": "2026-03-31T00:00:00Z",
                "snapshotId": "stale-final",
            }
            save_resolved_devices(database, [stale])
            self.assertEqual(stored_first_seen(), "2025-12-20T00:00:00Z")
            after_stale = list_resolved_devices(database)["devices"][0]
            self.assertEqual(after_stale["firstSeen"], "2025-12-20T00:00:00Z")
            self.assertEqual(after_stale["lastSeen"], "2026-03-31T00:00:00Z")
            self.assertEqual(after_stale["lastMissing"], "2026-04-01T00:00:00Z")
            self.assertFalse(after_stale["present"])
            self.assertEqual(after_stale["snapshotId"], "final-2")

            reappeared = {
                **base, "lastSeen": "2026-04-02T00:00:00Z", "lastMissing": "2026-04-01T00:00:00Z",
                "present": True, "snapshotId": "final-4",
            }
            save_resolved_devices(database, [reappeared])
            self.assertEqual(stored_first_seen(), "2025-12-20T00:00:00Z")
            after_return = list_resolved_devices(database)["devices"][0]
            self.assertTrue(after_return["present"])
            self.assertEqual(after_return["lastSeen"], "2026-04-02T00:00:00Z")
            self.assertEqual(after_return["snapshotId"], "final-4")

            connection = sqlite3.connect(database)
            try:
                connection.execute(
                    "UPDATE resolved_device_inventory SET first_seen = ? WHERE internal_device_id = ?",
                    ("2025-12-20T03:00:00+03:00", "presence-device"),
                )
                connection.commit()
            finally:
                connection.close()
            save_resolved_devices(database, [reappeared])
            after_timezone_alignment = list_resolved_devices(database)["devices"][0]
            self.assertEqual(after_timezone_alignment["firstSeen"], "2025-12-20T00:00:00Z")
            self.assertEqual(stored_first_seen(), "2025-12-20T00:00:00Z")

            with self.assertRaisesRegex(ValueError, "valid ISO 8601"):
                save_resolved_devices(database, [{**base, "lastSeen": "2026-02-30T00:00:00Z"}])

    def test_legacy_invalid_inventory_timestamps_do_not_block_additive_device_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy-invalid-inventory-time.db"
            initialize_database(database)
            original = {
                "internalDeviceId": "legacy-time-device", "deviceId": "edge-legacy",
                "vendor": "Existing vendor", "firstSeen": "2025-01-01T00:00:00Z",
                "lastSeen": "2025-02-01T00:00:00Z", "present": False,
            }
            save_resolved_devices(database, [original])
            connection = sqlite3.connect(database)
            try:
                payload = json.loads(connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("legacy-time-device",),
                ).fetchone()[0])
                payload.update({"firstSeen": "2025-01-01", "lastSeen": "legacy-date", "lastMissing": "invalid"})
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload), "legacy-time-device"),
                )
                connection.commit()
            finally:
                connection.close()

            save_resolved_devices(database, [{
                "internalDeviceId": "legacy-time-device", "deviceId": "edge-legacy", "ip": "192.0.2.9",
            }])
            after_cleanup = list_resolved_devices(database)["devices"][0]
            self.assertEqual(after_cleanup["vendor"], "Existing vendor")
            self.assertEqual(after_cleanup["ip"], "192.0.2.9")
            self.assertFalse(after_cleanup["present"])
            self.assertEqual(after_cleanup["firstSeen"], "2025-01-01T00:00:00Z")
            self.assertNotIn("lastSeen", after_cleanup)
            self.assertNotIn("lastMissing", after_cleanup)

            incoming = {
                "internalDeviceId": "legacy-time-device", "deviceId": "edge-legacy",
                "ip": "192.0.2.10", "firstSeen": "2024-12-01T00:00:00Z",
                "lastSeen": "2026-01-01T00:00:00Z", "present": True, "snapshotId": "final-legacy-fix",
            }
            save_resolved_devices(database, [incoming])
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["vendor"], "Existing vendor")
            self.assertEqual(device["ip"], "192.0.2.9")
            self.assertEqual(device["firstSeen"], "2024-12-01T00:00:00Z")
            self.assertEqual(device["lastSeen"], "2026-01-01T00:00:00Z")
            self.assertTrue(device["present"])
            self.assertEqual(device["snapshotId"], "final-legacy-fix")

    def test_oversized_metadata_merge_rolls_back_the_entire_inventory_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "metadata-rollback.db"
            initialize_database(database)
            original_value = "A" * (140 * 1024)
            added_value = "B" * (140 * 1024)
            save_resolved_devices(database, [{
                "deviceId": "device-a", "mac": "00:11:22:33:44:55",
                "customFields": {_custom_key("original"): original_value},
            }])

            with self.assertRaisesRegex(ValueError, "exceeds 256 KiB"):
                save_resolved_devices(database, [
                    {
                        "deviceId": "DEVICE-A", "mac": "00:11:22:33:44:55",
                        "customFields": {_custom_key("added"): added_value},
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
            self.assertEqual(payload["customFields"], {_custom_key("original"): original_value})

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
        self.assertEqual(device_id, "device-fb9f993228d3f79c")
        serial_id = _normalized_identity({"serialNumber": "SN-7", "mac": "00:11:22:33:44:55"})
        self.assertEqual(serial_id, _normalized_identity({"serial_number": "sn-7", "mac": "AA:BB:CC:DD:EE:FF"}))
        self.assertEqual(serial_id, "device-b86635f4e62bc2ca")
        self.assertEqual(_normalized_identity({"mac": "00:11:22:33:44:55"}), "device-d5b48b6c9f90d8d8")
        self.assertEqual(_normalized_identity({"alternateMacs": ["AA:BB:CC:DD:EE:FF"]}), "device-5b524c0137ddc198")
        self.assertEqual(_normalized_identity({"deviceId": "Straße"}), "device-de0fbb6f8a3c759c")
        self.assertEqual(_normalized_identity({"deviceId": "İD-1"}), "device-10739d812aaa1e8c")
        self.assertEqual(_normalized_identity({"deviceId": "🚀"}), "device-fb0cd5900b3beb8f")
        self.assertEqual(_normalized_identity({"deviceId": "😀"}), "device-fb0c55900b3b120f")
        self.assertEqual(_normalized_identity({"deviceId": "🧑"}), "device-fb0bd4900b42e057")
        self.assertEqual(len({_normalized_identity({"deviceId": value}) for value in ("🚀", "😀", "🧑")}), 3)
        self.assertEqual(_normalized_identity({"id": "existing-next-id", "mac": "00:11:22:33:44:55"}), "existing-next-id")
        self.assertEqual(_normalized_identity({"id": {"invalid": True}, "hostname": "room"}), "")
        self.assertIn(("id", "straße"), _strong_identity_aliases({"id": "Straße"}))
        self.assertNotIn(("id", "straße"), _strong_identity_aliases({"id": "STRASSE"}))
        self.assertNotEqual(device_id, serial_id)
        self.assertTrue(_normalized_identity({"mac": "00:11:22:33:44:55"}).startswith("device-"))
        self.assertEqual("", _normalized_identity({"hostname": "conference-room"}))
        self.assertEqual("", _normalized_identity({"mac": "00:00:00:00:00:00"}))

    def test_snapshot_upload_preserves_next_stable_id_and_rejects_normalized_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "snapshot-next-identity.db"
            initialize_database(database)
            metadata = {
                "type": "snapshot", "id": "next-final", "name": "Next Final", "source": "IndexedDB Final",
                "createdAt": "2026-11-07T00:00:00Z", "deviceCount": 1,
            }
            stable_id = "device-fb9f993228d3f79c"
            device = {"id": stable_id, "deviceId": "Device-7", "mac": "00:11:22:33:44:55"}
            saved = save_snapshot_stream(database, "next-final", iter(
                json.dumps(row).encode("utf-8") for row in (metadata, device)
            ))
            self.assertEqual(saved["deviceCount"], 1)
            page = list_snapshot_devices(database, "next-final")
            self.assertEqual(page["devices"][0]["id"], stable_id)
            self.assertEqual(page["devices"][0]["internalDeviceId"], stable_id)
            connection = sqlite3.connect(database)
            with connection:
                identity = connection.execute(
                    "SELECT identity FROM snapshot_devices WHERE snapshot_id = ? AND ordinal = 0", ("next-final",),
                ).fetchone()[0]
            connection.close()
            self.assertEqual(identity, stable_id)

            fallback_metadata = {**metadata, "id": "next-final-fallback", "deviceCount": 1}
            fallback_device = {
                "internalDeviceId": "Unknown", "deviceId": "device-fallback",
                "mac": "00:11:22:33:44:57",
            }
            expected_fallback_id = _normalized_identity(fallback_device)
            save_snapshot_stream(database, "next-final-fallback", iter(
                json.dumps(row).encode("utf-8") for row in (fallback_metadata, fallback_device)
            ))
            fallback_page = list_snapshot_devices(database, "next-final-fallback")
            self.assertEqual(fallback_page["devices"][0]["internalDeviceId"], expected_fallback_id)
            connection = sqlite3.connect(database)
            with connection:
                fallback_identity = connection.execute(
                    "SELECT identity FROM snapshot_devices WHERE snapshot_id = ? AND ordinal = 0",
                    ("next-final-fallback",),
                ).fetchone()[0]
            connection.close()
            self.assertEqual(fallback_identity, expected_fallback_id)

            duplicate_metadata = {**metadata, "id": "next-final-duplicate", "deviceCount": 2}
            duplicates = [
                {"id": "Persistent-Next-ID", "mac": "00:11:22:33:44:56"},
                {"id": "persistent-next-id", "mac": "AA:BB:CC:DD:EE:57"},
            ]
            with self.assertRaisesRegex(ValueError, "duplicate strong device identities"):
                save_snapshot_stream(database, "next-final-duplicate", iter(
                    json.dumps(row).encode("utf-8") for row in (duplicate_metadata, *duplicates)
                ))

            invalid_metadata = {**metadata, "id": "next-final-invalid"}
            with self.assertRaisesRegex(ValueError, "Snapshot id must be scalar text"):
                save_snapshot_stream(database, "next-final-invalid", iter(
                    json.dumps(row).encode("utf-8") for row in (invalid_metadata, {"id": {"bad": True}})
                ))

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
                    "sourceFinalId": "final-2026-10-21-c", "observedAt": "2026-10-21T10:10:00.123456Z",
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
            self.assertEqual([page1["events"][0]["id"], page2["events"][0]["id"], page3["events"][0]["id"]], [1, 2, 3])
            self.assertEqual(page1["events"][0]["observedAt"], "2026-10-21T07:00:00.000Z")
            self.assertEqual((page1["events"][0]["room"], page1["events"][0]["model"]), ("101", "Room Codec"))
            self.assertEqual(page2["events"][0]["sourceFinalId"], "final-2026-10-21-b")
            self.assertEqual((page2["events"][0]["fromValue"], page2["events"][0]["toValue"]), ("101", "202"))
            self.assertEqual(page3["events"][0]["observedAt"], "2026-10-21T10:10:00.123Z")
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
                {**events[1], "fromValue": "Unknown vendor", "toValue": "Acme"},
                {**events[1], "fromValue": "Room\u00a0A", "toValue": " room A "},
                {**events[0], "eventType": []},
            ]
            for invalid in invalid_events:
                with self.subTest(invalid=invalid):
                    with self.assertRaises(ValueError):
                        save_resolved_history(database, [invalid])
            self.assertEqual(list_resolved_history(database)["total"], 3)

            en_dash_change = {**events[1], "fromValue": "–", "toValue": "Acme"}
            accepted = save_resolved_history(database, [en_dash_change])
            self.assertEqual(accepted["insertedCount"], 1)
            self.assertEqual(list_resolved_history(database)["total"], 4)

    def test_history_list_projects_legacy_payload_without_mutating_stored_event(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy-history-read-projection.db"
            initialize_database(database)
            connection = sqlite3.connect(database)
            connection.execute(
                "INSERT INTO snapshots (id, name, device_count, devices_json, created_at) VALUES (?, ?, 0, '[]', ?)",
                ("legacy-history-final", "Legacy History Final", "2026-11-08T00:00:00Z"),
            )
            connection.commit()
            connection.close()
            save_resolved_history(database, [{
                "sourceFinalId": "legacy-history-final", "observedAt": "2026-11-08T10:00:00Z",
                "internalDeviceId": "legacy-history-device", "eventType": "added",
                "mac": "00:11:22:33:44:55",
            }])

            connection = sqlite3.connect(database)
            row = connection.execute(
                "SELECT id, payload_json FROM resolved_device_history WHERE internal_device_id = ?",
                ("legacy-history-device",),
            ).fetchone()
            event = json.loads(row[1])
            event["observedAt"] = "2026-11-08T10:00:00.123456Z"
            event["mac"] = "00-11-22-33-44-55"
            event["sourceFinalId"] = "stale-conflicting-final"
            raw_event = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
            connection.execute(
                "UPDATE resolved_device_history SET payload_json = ?, recorded_at = ? WHERE id = ?",
                (raw_event, event["observedAt"], row[0]),
            )
            connection.commit()
            connection.close()

            listed = list_resolved_history(database)["events"][0]

            self.assertEqual(listed["observedAt"], "2026-11-08T10:00:00.123Z")
            self.assertEqual(listed["mac"], "00:11:22:33:44:55")
            self.assertEqual(listed["sourceFinalId"], "legacy-history-final")
            filtered = list_resolved_history_for_mac(database, "00:11:22:33:44:55")["events"][0]
            self.assertEqual((filtered["observedAt"], filtered["mac"]), (listed["observedAt"], listed["mac"]))
            connection = sqlite3.connect(database)
            stored = connection.execute(
                "SELECT payload_json, recorded_at FROM resolved_device_history WHERE id = ?", (row[0],),
            ).fetchone()
            connection.close()
            self.assertEqual((stored[0], stored[1]), (raw_event, "2026-11-08T10:00:00.123456Z"))

    def test_history_api_deduplicates_semantically_identical_alias_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "history-alias-dedupe.db"
            initialize_database(database)
            connection = sqlite3.connect(database)
            with connection:
                connection.execute(
                    "INSERT INTO snapshots (id, name, device_count, devices_json, created_at) VALUES (?, ?, 0, '[]', ?)",
                    ("final-alias-dedupe", "Final alias dedupe", "2026-11-08T00:00:00Z"),
                )
            connection.close()
            rack_key = _custom_key("history-rack")
            owner_key = _custom_key("history-owner")
            canonical_event = {
                "sourceFinalId": "final-alias-dedupe", "observedAt": "2026-11-08T10:00:00Z",
                "deviceId": "edge-alias", "eventType": "added", "mac": "AA:BB:CC:DD:EE:01",
                "manufacturer": "Acme", "source": "Main",
                "customFields": {rack_key: "Rack 2", owner_key: "Network"},
                "customFieldSources": {rack_key: "Main", owner_key: "Main"},
            }
            alias_event = {
                **canonical_event,
                "mac": None, "macAddress": "aa-bb-cc-dd-ee-01",
                "manufacturer": None, "vendor": "Acme",
                "customFields": {owner_key: "Network", rack_key: "Rack 2"},
                "customFieldSources": {owner_key: "Main", rack_key: "Main"},
            }

            first = save_resolved_history(database, [canonical_event])
            duplicate = save_resolved_history(database, [alias_event])

            self.assertEqual(first["insertedCount"], 1)
            self.assertEqual(duplicate["insertedCount"], 0)
            self.assertEqual(duplicate["duplicateCount"], 1)
            event = list_resolved_history(database)["events"][0]
            self.assertEqual(event["mac"], "AA:BB:CC:DD:EE:01")
            self.assertEqual(event["manufacturer"], "Acme")
            self.assertNotIn("macAddress", event)
            self.assertNotIn("vendor", event)

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

    def test_optional_history_mac_lookup_finds_legacy_primary_and_alternate_alias_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "history-legacy-mac-aliases.db"
            initialize_database(database)
            connection = sqlite3.connect(database)
            with connection:
                connection.execute(
                    "INSERT INTO snapshots (id, name, device_count, devices_json, created_at) VALUES (?, ?, 0, '[]', ?)",
                    ("legacy-mac-final", "Legacy MAC Final", "2026-11-09T00:00:00Z"),
                )
                events = [
                    ("legacy-primary", "{\"eventType\":\"modified\",\"macAddress\":\"00-11-22-33-44-55\",\"observedAt\":\"2026-11-09T01:00:00Z\",\"sourceFinalId\":\"legacy-mac-final\"}"),
                    ("legacy-alternate", "{\"eventType\":\"modified\",\"mac\":\"00:11:22:33:44:77\",\"alternateMacs\":[\"AA-BB-CC-DD-EE-66\"],\"observedAt\":\"2026-11-09T02:00:00Z\",\"sourceFinalId\":\"legacy-mac-final\"}"),
                    ("legacy-packed-alternate", "{\"eventType\":\"modified\",\"mac\":\"00:11:22:33:44:88\",\"alternateMacs\":\"AA-BB-CC-DD-EE-68, AA-BB-CC-DD-EE-69\",\"observedAt\":\"2026-11-09T03:00:00Z\",\"sourceFinalId\":\"legacy-mac-final\"}"),
                    ("legacy-numeric-mac", "{\"eventType\":\"modified\",\"macAddress\":112233445577.0,\"observedAt\":\"2026-11-09T04:00:00Z\",\"sourceFinalId\":\"legacy-mac-final\"}"),
                ]
                for internal_id, payload in events:
                    connection.execute(
                        "INSERT INTO resolved_device_history "
                        "(observation_key, internal_device_id, source, payload_json, recorded_at, source_final_id) "
                        "VALUES (?, ?, 'legacy', ?, '2026-11-09T00:00:00Z', 'legacy-mac-final')",
                        (internal_id, internal_id, payload),
                    )
                connection.execute(
                    "INSERT INTO resolved_device_history "
                    "(observation_key, internal_device_id, source, payload_json, recorded_at, source_final_id) "
                    "VALUES ('legacy-invalid-json', 'legacy-invalid-json', 'legacy', '{', '2026-11-09T00:00:00Z', 'legacy-mac-final')"
                )
            connection.close()

            primary = list_resolved_history_for_mac(database, "00:11:22:33:44:55")
            alternate = list_resolved_history_for_mac(database, "AA:BB:CC:DD:EE:66")
            packed_alternate = list_resolved_history_for_mac(database, "AA:BB:CC:DD:EE:69")
            numeric_mac = list_resolved_history_for_mac(database, "11:22:33:44:55:77")

            self.assertEqual((primary["total"], primary["events"][0]["internalDeviceId"]), (1, "legacy-primary"))
            self.assertEqual((alternate["total"], alternate["events"][0]["internalDeviceId"]), (1, "legacy-alternate"))
            self.assertEqual((packed_alternate["total"], packed_alternate["events"][0]["internalDeviceId"]), (1, "legacy-packed-alternate"))
            self.assertEqual((numeric_mac["total"], numeric_mac["events"][0]["internalDeviceId"]), (1, "legacy-numeric-mac"))

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

            self.assertEqual(result["schemaVersion"], 9)
            self.assertTrue(Path(result["backup"]["path"]).is_file())
            connection = sqlite3.connect(database)
            with connection:
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 9)
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

    def test_schema_v7_migration_indexes_snapshot_device_pages_and_preserves_legacy_json(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "schema-v7-snapshots.db"
            initialize_database(database)
            devices = [
                {"internalDeviceId": f"snapshot-device-{index}", "mac": f"02:00:00:00:00:{index:02X}"}
                for index in range(1, 4)
            ]
            legacy_json = json.dumps(devices, separators=(",", ":"))
            with sqlite3.connect(database) as connection:
                connection.execute(
                    "INSERT INTO snapshots (id, name, source, device_count, devices_json, created_at, signature) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("legacy-v7", "Legacy Final", "Main.csv", len(devices), legacy_json,
                     "2026-10-22T00:00:00Z", "legacy-signature"),
                )
                connection.execute("DROP TABLE snapshot_devices")
                connection.execute("DROP TABLE snapshot_device_index")
                connection.execute("PRAGMA user_version=7")
            connection.close()

            result = initialize_database(database)

            self.assertEqual(result["schemaVersion"], 9)
            self.assertTrue(Path(result["backup"]["path"]).is_file())
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 9)
                stored_json = connection.execute(
                    "SELECT devices_json FROM snapshots WHERE id='legacy-v7'"
                ).fetchone()[0]
                self.assertEqual(stored_json, legacy_json)
                self.assertEqual(connection.execute(
                    "SELECT COUNT(*) FROM snapshot_devices WHERE snapshot_id='legacy-v7'"
                ).fetchone()[0], 3)
                self.assertEqual(connection.execute(
                    "SELECT device_count FROM snapshot_device_index WHERE snapshot_id='legacy-v7'"
                ).fetchone()[0], 3)
                metadata_plan = " ".join(str(item) for row in connection.execute(
                    "EXPLAIN QUERY PLAN SELECT device_count FROM snapshot_device_index WHERE snapshot_id=?",
                    ("legacy-v7",),
                ) for item in row)
                self.assertIn("sqlite_autoindex_snapshot_device_index_1", metadata_plan)
                plan = " ".join(str(item) for row in connection.execute(
                    "EXPLAIN QUERY PLAN SELECT ordinal, payload_json FROM snapshot_devices "
                    "WHERE snapshot_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?",
                    ("legacy-v7", 1, 3),
                ) for item in row)
                self.assertIn("sqlite_autoindex_snapshot_devices_1", plan)
            connection.close()

            page1 = list_snapshot_devices(database, "legacy-v7", limit=2)
            page2 = list_snapshot_devices(database, "legacy-v7", after=page1["nextCursor"], limit=2)
            self.assertEqual([item["internalDeviceId"] for item in page1["devices"]], [
                "snapshot-device-1", "snapshot-device-2",
            ])
            self.assertEqual([item["internalDeviceId"] for item in page2["devices"]], ["snapshot-device-3"])
            self.assertIsNone(page2["nextCursor"])
            with patch("scripts.optional_sqlite_store._backfill_snapshot_devices") as backfill:
                second_start = initialize_database(database)
            backfill.assert_not_called()
            self.assertIsNone(second_start["backup"])

    def test_deleting_optional_snapshot_removes_only_its_history_and_preserves_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "snapshot-delete.db"
            initialize_database(database)
            with sqlite3.connect(database) as connection:
                connection.execute(
                    "INSERT INTO snapshots (id, name, source, device_count, devices_json, created_at, signature) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("keep-me", "keep-me", "Main.csv", 0, "[]", "2026-10-22T00:00:00Z", "keep-me"),
                )
            connection.close()
            metadata = {
                "type": "snapshot", "id": "delete-me", "name": "delete-me", "source": "Main.csv",
                "deviceCount": 1, "createdAt": "2026-10-22T00:00:00Z",
            }
            device = {"internalDeviceId": "delete-device", "mac": "00:11:22:33:44:56"}
            save_snapshot_stream(database, "delete-me", iter(
                json.dumps(row).encode("utf-8") for row in (metadata, device)
            ))
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
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute(
                    "SELECT COUNT(*) FROM snapshot_devices WHERE snapshot_id='delete-me'"
                ).fetchone()[0], 0)
                self.assertEqual(connection.execute(
                    "SELECT COUNT(*) FROM snapshot_device_index WHERE snapshot_id='delete-me'"
                ).fetchone()[0], 0)
            connection.close()
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
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 9)
            connection.close()
            self.assertEqual(result["schemaVersion"], 9)
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
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute(
                    "SELECT COUNT(*) FROM snapshot_devices WHERE snapshot_id='uploaded-final'"
                ).fetchone()[0], 2)
                self.assertEqual(connection.execute(
                    "SELECT device_count FROM snapshot_device_index WHERE snapshot_id='uploaded-final'"
                ).fetchone()[0], 2)
            connection.close()

            class TracedConnection(sqlite3.Connection):
                legacy_json_scans = 0
                indexed_digest_reads = 0
                full_index_counts = 0

                def execute(self, sql, parameters=(), /):
                    if "json_each(snapshot.devices_json)" in sql:
                        type(self).legacy_json_scans += 1
                    if "SELECT payload_json FROM snapshot_devices WHERE snapshot_id" in sql:
                        type(self).indexed_digest_reads += 1
                    if "SELECT COUNT(*) FROM snapshot_devices" in sql:
                        type(self).full_index_counts += 1
                    return super().execute(sql, parameters)

            TracedConnection.legacy_json_scans = 0
            TracedConnection.indexed_digest_reads = 0
            TracedConnection.full_index_counts = 0
            real_connect = sqlite3.connect

            def traced_connect(*args, **kwargs):
                return real_connect(*args, factory=TracedConnection, **kwargs)

            with patch("scripts.optional_sqlite_store.sqlite3.connect", side_effect=traced_connect):
                repeated = save_snapshot_stream(database, "uploaded-final", iter(lines))
                indexed_page = list_snapshot_devices(database, "uploaded-final", limit=1)
            self.assertEqual(TracedConnection.legacy_json_scans, 0)
            self.assertEqual(TracedConnection.indexed_digest_reads, 1)
            self.assertEqual(TracedConnection.full_index_counts, 0)
            self.assertEqual(indexed_page["devices"][0]["internalDeviceId"], "device-a")
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
                "UPDATE snapshot_devices SET payload_json = ? WHERE snapshot_id = ? AND ordinal = ?",
                (json.dumps({"internalDeviceId": "tampered-a"}), "uploaded-final", 0),
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
            with self.assertRaisesRegex(ValueError, "at most 100"):
                save_snapshot_stream(database, "too-many-alternate-macs", iter([
                    json.dumps({**metadata, "id": "too-many-alternate-macs", "deviceCount": 1}).encode("utf-8"),
                    json.dumps({"internalDeviceId": "device-a", "alternateMacs": [f"00:11:22:33:44:{index:02X}" for index in range(101)]}).encode("utf-8"),
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

    def test_snapshot_stream_batches_strong_identity_index_writes_without_per_token_selects(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "snapshot-token-batches.db"
            initialize_database(database)
            device_count = 1_201
            metadata = {
                "type": "snapshot", "id": "batched-final", "name": "Batched Final", "source": "Main.csv",
                "createdAt": "2026-10-21T10:00:00Z", "deviceCount": device_count,
            }

            class TracedConnection(sqlite3.Connection):
                token_insert_batches = []
                token_lookup_count = 0

                def execute(self, sql, parameters=(), /):
                    if sql.startswith("SELECT ordinal FROM upload_snapshot_identity_tokens"):
                        type(self).token_lookup_count += 1
                    return super().execute(sql, parameters)

                def executemany(self, sql, parameter_rows):
                    if sql.startswith("INSERT INTO upload_snapshot_identity_tokens"):
                        parameter_rows = list(parameter_rows)
                        type(self).token_insert_batches.append(len(parameter_rows))
                    return super().executemany(sql, parameter_rows)

            TracedConnection.token_insert_batches = []
            TracedConnection.token_lookup_count = 0
            real_connect = sqlite3.connect

            def traced_connect(*args, **kwargs):
                return real_connect(*args, factory=TracedConnection, **kwargs)

            def lines():
                yield json.dumps(metadata).encode("utf-8")
                for index in range(device_count):
                    mac = f"02:00:00:{(index >> 16) & 255:02X}:{(index >> 8) & 255:02X}:{index & 255:02X}"
                    yield json.dumps({"internalDeviceId": f"device-{index:05d}", "mac": mac}).encode("utf-8")

            with patch("scripts.optional_sqlite_store.sqlite3.connect", side_effect=traced_connect):
                saved = save_snapshot_stream(database, "batched-final", lines())

            self.assertEqual(saved["deviceCount"], device_count)
            self.assertEqual(TracedConnection.token_lookup_count, 0)
            self.assertEqual(TracedConnection.token_insert_batches, [999, 999, 999, 606])
            page = list_snapshot_devices(database, "batched-final", limit=2)
            self.assertEqual(page["deviceCount"], device_count)
            self.assertEqual(len(page["devices"]), 2)
            self.assertEqual(page["devices"][1]["internalDeviceId"], "device-00001")

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
            self.assertEqual(second["schemaVersion"], 9)
            self.assertIsNone(second["backup"])
            self.assertEqual(load_settings(database)["settings"], loaded["settings"])
            self.assertEqual(database_summary(database)["counts"]["device_inventory"], 0)

    def test_settings_reads_stop_at_the_bounded_json_response_size(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "settings.db"
            initialize_database(database)
            values = {f"bulk-{index}": "x" * 230_000 for index in range(5)}
            save_settings(database, values)
            with self.assertRaisesRegex(SettingsResponseTooLarge, "exceeds 1 MiB"):
                load_settings(database)
            selected = load_settings(database, ["bulk-4"])
            self.assertEqual(selected["settings"], {"bulk-4": values["bulk-4"]})

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
                self.assertIn('"internalDeviceId":"device-', resolved[1])
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
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 9)
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
            self.assertEqual(result["schemaVersion"], 9)

    def test_resolved_inventory_backfill_keeps_unicode_strong_id_conflicts_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "unicode-identity-conflicts.db"
            initialize_database(database)
            with sqlite3.connect(database) as connection:
                connection.executemany(
                    "INSERT INTO device_inventory (mac, mac_formatted, serial_number, first_seen, updated_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    [("001122334455", "AA:BB:CC:DD:EE:01", "Straße", "2024-01-01", "2024-01-02"),
                     ("001122334456", "AA:BB:CC:DD:EE:01", "STRASSE", "2024-01-01", "2024-01-02")],
                )
                connection.execute("PRAGMA user_version=3")
            connection.close()

            result = initialize_database(database)

            with sqlite3.connect(database) as connection:
                rows = connection.execute(
                    "SELECT internal_device_id, payload_json FROM resolved_device_inventory ORDER BY mac"
                ).fetchall()
            connection.close()
            self.assertEqual(len(rows), 2)
            flagged = [json.loads(payload) for _, payload in rows if json.loads(payload).get("identityConflicts")]
            self.assertEqual(len(flagged), 1)
            self.assertEqual(flagged[0]["identityConflicts"][0]["field"], "serialNumber")
            self.assertEqual(result["counts"]["resolved_device_inventory"], 2)

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
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 9)
                self.assertEqual(connection.execute(
                    "SELECT seen_count FROM resolved_device_inventory WHERE internal_device_id='stable-internal'"
                ).fetchone()[0], 7)
            connection.close()
            self.assertEqual(aliases, {
                ("internal", "stable-internal"), ("device", "stable-device"),
                ("id", "stable-internal"),
                ("mac", "001122334451"), ("mac", "AABBCCDDEE61"),
            })
            self.assertTrue(Path(result["backup"]["path"]).is_file())

    def test_alternate_mac_matches_resolved_inventory_and_derives_missing_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "alternate-mac.db"
            initialize_database(database)
            first = save_resolved_devices(database, [{
                "internalDeviceId": "stable-device", "deviceId": "edge-1",
                "alternateMacs": ["AA:BB:CC:DD:EE:61"],
            }])
            self.assertEqual(first["savedCount"], 1)
            matched = save_resolved_devices(database, [{
                "deviceId": "edge-1", "mac": "AA-BB-CC-DD-EE-61", "room": "101",
            }])
            self.assertEqual(matched["saved"], ["stable-device"])
            self.assertEqual(matched["conflictCount"], 0)
            expanded_aliases = save_resolved_devices(database, [{
                "deviceId": "edge-1", "mac": "AA:BB:CC:DD:EE:61",
                "alternateMacs": ["00:11:22:33:44:51", "00:11:22:33:44:72"],
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
            self.assertTrue(alternate_only["saved"][0].startswith("device-"))
            bounded = save_resolved_devices(database, [{
                "internalDeviceId": "too-many-aliases",
                "alternateMacs": [f"00:11:22:33:45:{index:02X}" for index in range(101)],
            }])
            self.assertEqual(bounded["savedCount"], 1)
            stored = next(device for device in list_resolved_devices(database)["devices"]
                if device["internalDeviceId"] == "too-many-aliases")
            self.assertEqual(len(stored["alternateMacs"]), 100)
            self.assertTrue(stored["alternateMacsTruncated"])

    def test_primary_mac_aliases_match_resolved_inventory(self):
        aliases = ("macAddress", "mac_address", "macFormatted", "mac_formatted", "CallingStationID")
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "primary-mac-aliases.db"
            initialize_database(database)
            for index, alias in enumerate(aliases):
                mac = f"AA:BB:CC:DD:EE:{index + 1:02X}"
                stable_id = f"stable-alias-{index}"
                first = save_resolved_devices(database, [{
                    "internalDeviceId": stable_id, alias: mac,
                }])
                self.assertEqual(first["saved"], [stable_id], alias)

                matched = save_resolved_devices(database, [{"mac": mac, "room": str(index + 1)}])

                self.assertEqual(matched["saved"], [stable_id], alias)
                self.assertEqual(matched["conflictCount"], 0, alias)

    def test_primary_mac_payload_uses_browser_canonical_form(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "primary-mac-canonical-payload.db"
            initialize_database(database)
            result = save_resolved_devices(database, [
                {
                    "internalDeviceId": "canonical-primary-direct",
                    "mac": "aa-bb-cc-dd-ee-01",
                },
                {
                    "internalDeviceId": "canonical-primary-alias",
                    "mac": "Unknown", "mac_address": "aabb.ccdd.ee02",
                },
            ])

            self.assertEqual(result["savedCount"], 2)
            devices = {device["internalDeviceId"]: device for device in list_resolved_devices(database)["devices"]}
            self.assertEqual(devices["canonical-primary-direct"]["mac"], "AA:BB:CC:DD:EE:01")
            self.assertEqual(devices["canonical-primary-alias"]["mac"], "AA:BB:CC:DD:EE:02")

    def test_primary_mac_display_field_matches_browser_without_treating_placeholders_as_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "primary-mac-display-normalization.db"
            initialize_database(database)
            result = save_resolved_devices(database, [
                {"internalDeviceId": "invalid-primary-display", "mac": "Unknown"},
                {"internalDeviceId": "zero-primary-display", "mac": "00-00-00-00-00-00"},
            ])

            self.assertEqual(result["savedCount"], 2)
            devices = {device["internalDeviceId"]: device for device in list_resolved_devices(database)["devices"]}
            self.assertEqual(devices["invalid-primary-display"]["mac"], "")
            self.assertEqual(devices["zero-primary-display"]["mac"], "00:00:00:00:00:00")
            self.assertEqual(devices["zero-primary-display"]["internalDeviceId"], "zero-primary-display")

    def test_device_ip_switch_ip_and_name_aliases_match_browser_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "device-alias-normalization.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "internalDeviceId": "device-alias-normalization",
                "ip": "Unknown", "deviceIp": "2001:0DB8:0:0::1", "device_ip": "192.0.2.9",
                "switchIp": "N/A", "ipSwitch": "192.0.2.1", "ip_switch": "192.0.2.2", "nasIp": "192.0.2.3",
                "switchPort": "unknown", "port": "", "nasPortId": " Gi1/0/10 ",
                "hostname": "—", "host": "", "host_name": "  codec   west ",
                "deviceName": "Unknown", "name": " Room Codec ", "smartroomId": "N/A", "smartroom_id": " sr-12 ",
                "deviceType": "unknown model", "type": " Codec ",
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["ip"], "2001:db8::1")
            self.assertEqual(device["switchIp"], "192.0.2.1")
            self.assertEqual(device["switchPort"], "Gi1/0/10")
            self.assertEqual(device["hostname"], "codec west")
            self.assertEqual(device["deviceName"], "Room Codec")
            self.assertEqual(device["smartroomId"], "sr-12")
            self.assertEqual(device["deviceType"], "Codec")

    def test_scalar_identity_text_fields_reject_booleans_like_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "boolean-scalar-normalization.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "internalDeviceId": "boolean-scalars",
                "manufacturer": True,
                "vendor": "Acme",
                "model": False,
                "room": True,
                "switchPort": False,
                "port": "Gi1/0/7",
                "smartroomId": True,
                "hostname": False,
                "host": "lobby-ap",
                "serial": True,
                "deviceName": False,
                "name": "Lobby AP",
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["manufacturer"], "Acme")
            self.assertEqual(device["model"], "")
            self.assertEqual(device["room"], "")
            self.assertEqual(device["switchPort"], "Gi1/0/7")
            self.assertEqual(device["smartroomId"], "")
            self.assertEqual(device["hostname"], "lobby-ap")
            self.assertEqual(device.get("serial", ""), "")
            self.assertEqual(device["deviceName"], "Lobby AP")

    def test_authentication_time_and_receipt_time_follow_browser_date_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "authentication-date-normalization.db"
            initialize_database(database)
            result = save_resolved_devices(database, [
                {"internalDeviceId": "date-excel", "authenticationTime": 46000.25},
                {"internalDeviceId": "date-fallback", "authenticationTime": "not found", "receiptTime": "15.10.2026 13:30"},
                {"internalDeviceId": "date-offset", "authenticationTime": "2026-10-15T13:30:00.123+03:00"},
                {"internalDeviceId": "date-invalid", "authenticationTime": "31.02.2026"},
                {"internalDeviceId": "date-month-name", "authenticationTime": "May 1, 2024"},
                {"internalDeviceId": "date-rfc", "authenticationTime": "Wed, 01 May 2024 12:00:00 GMT"},
                {"internalDeviceId": "date-year-slash", "authenticationTime": "2024/5/1"},
                {"internalDeviceId": "date-year-dot", "authenticationTime": "2024.5.1"},
                {"internalDeviceId": "date-overflow", "authenticationTime": "2024/2/30"},
                {"internalDeviceId": "date-year-invalid", "authenticationTime": "2024/13/1"},
            ])

            self.assertEqual(result["savedCount"], 10)
            devices = {device["internalDeviceId"]: device for device in list_resolved_devices(database)["devices"]}
            self.assertEqual(devices["date-excel"]["authenticationTime"], "2025-12-09T06:00:00.000Z")
            self.assertEqual(devices["date-fallback"]["authenticationTime"], "2026-10-15T13:30:00.000Z")
            self.assertEqual(devices["date-offset"]["authenticationTime"], "2026-10-15T10:30:00.123Z")
            self.assertEqual(devices["date-invalid"]["authenticationTime"], "")
            self.assertEqual(
                devices["date-month-name"]["authenticationTime"],
                datetime(2024, 5, 1).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            )
            self.assertEqual(devices["date-rfc"]["authenticationTime"], "2024-05-01T12:00:00.000Z")
            local_may = datetime(2024, 5, 1).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            local_march = datetime(2024, 3, 1).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            self.assertEqual(devices["date-year-slash"]["authenticationTime"], local_may)
            self.assertEqual(devices["date-year-dot"]["authenticationTime"], local_may)
            self.assertEqual(devices["date-overflow"]["authenticationTime"], local_march)
            self.assertEqual(devices["date-year-invalid"]["authenticationTime"], "")

    def test_location_path_aliases_infer_hierarchy_without_overwriting_explicit_room(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "location-path-normalization.db"
            initialize_database(database)
            result = save_resolved_devices(database, [
                {"internalDeviceId": "location-path", "locationPath": "Банк, Москва, Площадка, 4, Комната 5", "room": "Room explicit"},
                {"internalDeviceId": "room-path", "room": "Банк, , Площадка, , Комната 3, Москва, улица 1"},
                {"internalDeviceId": "address-path", "address": "Банк, Москва, Площадка, 4, Комната 5, Москва, ул. Ленина"},
            ])

            self.assertEqual(result["savedCount"], 3)
            devices = {device["internalDeviceId"]: device for device in list_resolved_devices(database)["devices"]}
            self.assertEqual((devices["location-path"]["businessUnit"], devices["location-path"]["room"]), ("Банк", "Room explicit"))
            self.assertEqual((devices["room-path"]["city"], devices["room-path"]["room"], devices["room-path"]["address"]), ("", "Комната 3", "Москва, улица 1"))
            self.assertEqual((devices["address-path"]["room"], devices["address-path"]["address"]), ("Комната 5", "Москва, ул. Ленина"))

    def test_legacy_location_path_remains_selected_during_inventory_merge(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy-location-merge.db"
            initialize_database(database)
            save_resolved_devices(database, [{
                "internalDeviceId": "legacy-location", "mac": "02:00:00:00:00:01",
                "locationPath": "Банк, Москва, Площадка, 4, Комната 5, Москва, улица 1",
            }])

            with sqlite3.connect(database) as connection:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("legacy-location",),
                ).fetchone()
                payload = json.loads(row[0])
                # Simulate a pre-normalization row where hierarchy only exists in the legacy path.
                for field in ("businessUnit", "city", "site", "floor", "room", "address"):
                    payload.pop(field, None)
                connection.execute(
                    "UPDATE resolved_device_inventory SET room = ?, payload_json = ? WHERE internal_device_id = ?",
                    ("", json.dumps(payload, ensure_ascii=False), "legacy-location"),
                )
            connection.close()

            save_resolved_devices(database, [{
                "internalDeviceId": "legacy-location", "mac": "02:00:00:00:00:01",
                "room": "Новая комната", "businessUnit": "Другой банк", "source": "Main",
            }])
            device = list_resolved_devices(database)["devices"][0]

            self.assertEqual(
                (device["businessUnit"], device["room"], device["address"]),
                ("Банк", "Комната 5", "Москва, улица 1"),
            )
            self.assertEqual(
                {(item["field"], item["selected"], item["value"]) for item in device["conflicts"]},
                {("room", "Комната 5", "Новая комната"), ("businessUnit", "Банк", "Другой банк")},
            )
            with sqlite3.connect(database) as connection:
                indexed_room = connection.execute(
                    "SELECT room FROM resolved_device_inventory WHERE internal_device_id = ?",
                    ("legacy-location",),
                ).fetchone()[0]
            connection.close()
            self.assertEqual(indexed_room, device["room"])

    def test_legacy_room_path_is_materialized_before_inventory_conflict_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy-room-path-merge.db"
            initialize_database(database)
            save_resolved_devices(database, [{
                "internalDeviceId": "legacy-room-path", "mac": "02:00:00:00:00:02",
            }])

            connection = sqlite3.connect(database)
            row = connection.execute(
                "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                ("legacy-room-path",),
            ).fetchone()
            payload = json.loads(row[0])
            for field in ("businessUnit", "city", "site", "floor", "room", "address"):
                payload.pop(field, None)
            payload["room"] = "Банк, Москва, Площадка, 4, Комната 6, Москва, улица 2"
            connection.execute(
                "UPDATE resolved_device_inventory SET room = ?, payload_json = ? WHERE internal_device_id = ?",
                (payload["room"], json.dumps(payload, ensure_ascii=False), "legacy-room-path"),
            )
            connection.commit()
            connection.close()

            save_resolved_devices(database, [{
                "internalDeviceId": "legacy-room-path", "mac": "02:00:00:00:00:02",
                "room": "Новая комната", "source": "Main",
            }])
            device = list_resolved_devices(database)["devices"][0]

            self.assertEqual(device.get("address"), "Москва, улица 2", device)
            self.assertEqual((device["businessUnit"], device["room"]), ("Банк", "Комната 6"))
            self.assertIn(
                ("room", "Комната 6", "Новая комната"),
                {(item["field"], item["selected"], item["value"]) for item in device["conflicts"]},
            )

    def test_device_list_projects_legacy_payload_without_mutating_stored_data(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy-device-read-projection.db"
            initialize_database(database)
            save_resolved_devices(database, [{
                "internalDeviceId": "legacy-read", "mac": "02:00:00:00:00:03",
            }])

            connection = sqlite3.connect(database)
            row = connection.execute(
                "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                ("legacy-read",),
            ).fetchone()
            payload = json.loads(row[0])
            payload.update({
                "room": "Банк, Москва, Площадка, 5, Комната 7, Москва, улица 3",
                "ip": "Unknown", "deviceIp": "192.0.2.30", "legacyNote": "keep this field",
            })
            raw_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            connection.execute(
                "UPDATE resolved_device_inventory SET room = ?, payload_json = ? WHERE internal_device_id = ?",
                (payload["room"], raw_payload, "legacy-read"),
            )
            connection.commit()
            connection.close()

            device = list_resolved_devices(database)["devices"][0]

            self.assertEqual(
                (device["businessUnit"], device["room"], device["address"], device["ip"]),
                ("Банк", "Комната 7", "Москва, улица 3", "192.0.2.30"),
            )
            self.assertEqual(device["legacyNote"], "keep this field")
            connection = sqlite3.connect(database)
            stored_payload = connection.execute(
                "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?",
                ("legacy-read",),
            ).fetchone()[0]
            connection.close()
            self.assertEqual(stored_payload, raw_payload)

    def test_possible_ip_list_is_normalized_and_truncated_like_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "possible-ip-intake-limit.db"
            initialize_database(database)
            possible_ips = [f"192.0.2.{index}" for index in range(1, 106)]
            result = save_resolved_devices(database, [{
                "internalDeviceId": "possible-ip-intake-limit", "possibleIps": possible_ips,
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(len(device["possibleIps"]), 100)
            self.assertEqual(device["possibleIps"][0], "192.0.2.1")
            self.assertEqual(device["possibleIps"][-1], "192.0.2.100")
            self.assertTrue(device["possibleIpsTruncated"])

    def test_evidence_truncation_flags_use_browser_boolean_coercion(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "evidence-truncation-flags.db"
            initialize_database(database)
            result = save_resolved_devices(database, [
                {"internalDeviceId": "truthy-flag", "alternateMacsTruncated": "false"},
                {"internalDeviceId": "empty-flag", "possibleIpsTruncated": ""},
            ])

            self.assertEqual(result["savedCount"], 2)
            devices = {device["internalDeviceId"]: device for device in list_resolved_devices(database)["devices"]}
            self.assertTrue(devices["truthy-flag"]["alternateMacsTruncated"])
            self.assertFalse(devices["truthy-flag"]["possibleIpsTruncated"])
            self.assertFalse(devices["empty-flag"]["alternateMacsTruncated"])
            self.assertFalse(devices["empty-flag"]["possibleIpsTruncated"])

    def test_alternate_mac_list_is_normalized_and_truncated_like_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "alternate-mac-intake-limit.db"
            initialize_database(database)
            alternates = [f"AA:BB:CC:DD:{index // 256:02X}:{index % 256:02X}" for index in range(105)]
            result = save_resolved_devices(database, [{
                "internalDeviceId": "alternate-mac-intake-limit", "mac": "00:11:22:33:44:55",
                "alternateMacs": ["00-11-22-33-44-55", *alternates[:100]], "mac2": alternates[100],
                "secondaryMac": alternates[101], "additional_mac": alternates[102],
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(len(device["alternateMacs"]), 100)
            self.assertEqual(device["alternateMacs"], alternates[:100])
            self.assertTrue(device["alternateMacsTruncated"])

    def test_legacy_alternate_mac_aliases_survive_api_projection_and_match_inventory(self):
        aliases = ("secondaryMac", "secondary_mac", "mac2", "additionalMac", "additional_mac")
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy-alternate-mac-aliases.db"
            initialize_database(database)
            for index, alias in enumerate(aliases):
                mac = f"AA:BB:CC:DD:EF:{index + 1:02X}"
                expected_id = _normalized_identity({alias: mac})
                self.assertEqual(expected_id, _normalized_identity({"alternateMacs": [mac]}), alias)
                self.assertIn(("mac", mac.replace(":", "")), _strong_identity_aliases({alias: mac}), alias)

                first = save_resolved_devices(database, [{alias: mac}])
                self.assertEqual(first["saved"], [expected_id], alias)
                projected = next(device for device in list_resolved_devices(database)["devices"]
                    if device["internalDeviceId"] == expected_id)
                self.assertEqual(projected["alternateMacs"], [mac], alias)
                self.assertFalse(projected["alternateMacsTruncated"], alias)
                matched = save_resolved_devices(database, [{"mac": mac}])
                self.assertEqual(matched["saved"], [expected_id], alias)
                self.assertEqual(matched["conflictCount"], 0, alias)

            self.assertEqual(list_resolved_devices(database)["total"], len(aliases))

    def test_internal_device_serial_aliases_survive_api_projection_and_match_inventory(self):
        cases = (
            ("id", "stable-internal-1", "internalDeviceId"),
            ("internal_device_id", "stable-internal-2", "internalDeviceId"),
            ("device_id", "asset-edge-1", "deviceId"),
            ("asset_id", "asset-edge-2", "deviceId"),
            ("serial", "SERIAL-1", "serialNumber"),
            ("serial_number", "SERIAL-2", "serialNumber"),
        )
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "strong-identity-aliases.db"
            initialize_database(database)
            for index, (alias, value, canonical) in enumerate(cases):
                first = save_resolved_devices(database, [{alias: value, "room": str(index)}])
                self.assertEqual(first["savedCount"], 1, alias)
                stable_id = first["saved"][0]

                matched = save_resolved_devices(database, [{canonical: value, "vendor": f"Vendor {index}"}])

                self.assertEqual(matched["saved"], [stable_id], alias)
                self.assertEqual(matched["conflictCount"], 0, alias)

    def test_inventory_serial_index_uses_browser_first_valid_serial_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "serial-alias-priority.db"
            initialize_database(database)
            save_resolved_devices(database, [{"internalDeviceId": "serial-priority-merge"}])
            saved = save_resolved_devices(database, [
                {"internalDeviceId": "serial-priority-new", "serial": "SERIAL-A", "serialNumber": "SERIAL-B"},
                {"internalDeviceId": "serial-priority-merge", "serial": "SERIAL-C", "serialNumber": "SERIAL-D"},
            ])

            self.assertEqual(saved["savedCount"], 2)
            connection = sqlite3.connect(database)
            try:
                values = dict(connection.execute(
                    "SELECT internal_device_id, serial_number FROM resolved_device_inventory"
                ).fetchall())
            finally:
                connection.close()
            self.assertEqual(values["serial-priority-new"], "SERIAL-A")
            self.assertEqual(values["serial-priority-merge"], "SERIAL-C")

    def test_conflicting_identity_aliases_are_visible_and_cannot_silently_merge(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "conflicting-identity-aliases.db"
            initialize_database(database)

            first = save_resolved_devices(database, [{
                "internalDeviceId": "stable-conflicting-aliases",
                "deviceId": "asset-selected",
                "device_id": "asset-alternative",
                "mac": "AA:BB:CC:DD:EE:81",
                "mac_address": "AA:BB:CC:DD:EE:82",
                "source": "Main",
            }])

            self.assertEqual(first["savedCount"], 1)
            projected = list_resolved_devices(database)["devices"][0]
            conflicts = projected["conflicts"]
            self.assertEqual(
                [(item["identifier"], item["selected"], item["alternative"]) for item in conflicts],
                [
                    ("deviceId", "asset-selected", "asset-alternative"),
                    ("mac", "AA:BB:CC:DD:EE:81", "AA:BB:CC:DD:EE:82"),
                ],
            )
            self.assertTrue(all(item["source"] == "Main" for item in conflicts))
            self.assertTrue(all("Конфликтующие алиасы" in item["reason"] for item in conflicts))

            alternative_match = save_resolved_devices(database, [{"deviceId": "asset-alternative", "room": "must-not-merge"}])

            self.assertEqual(alternative_match["savedCount"], 0)
            self.assertEqual(alternative_match["conflicts"][0]["reason"], "conflicting_strong_identity")
            self.assertEqual(list_resolved_devices(database)["total"], 1)

    def test_numeric_mac_alias_conflicts_match_browser_mac_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "numeric-mac-alias-conflict.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "internalDeviceId": "numeric-mac-aliases",
                "mac": 123456789012,
                "macAddress": 123456789013,
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["mac"], "12:34:56:78:90:12")
            self.assertEqual(device["conflicts"], [{
                "field": "identity", "identifier": "mac",
                "selected": "12:34:56:78:90:12", "alternative": "12:34:56:78:90:13",
                "source": "Импорт",
                "reason": "Конфликтующие алиасы сильного идентификатора (mac / macAddress)",
            }])

    def test_numeric_mac_field_uses_javascript_number_string_formatting(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "numeric-mac-field-format.db"
            initialize_database(database)
            saved = save_resolved_devices(database, [{
                "internalDeviceId": "numeric-mac-field", "mac": 1e11,
            }])

            self.assertEqual(saved["savedCount"], 1)
            self.assertEqual(list_resolved_devices(database)["devices"][0]["mac"], "10:00:00:00:00:00")

    def test_startup_backfill_repairs_legacy_alias_index_and_adds_conflict_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy-conflicting-aliases.db"
            initialize_database(database)
            saved_id = save_resolved_devices(database, [{
                "internalDeviceId": "stable-legacy-aliases", "deviceId": "asset-selected", "source": "Main",
            }])["saved"][0]
            with sqlite3.connect(database) as connection:
                row = connection.execute(
                    "SELECT payload_json FROM resolved_device_inventory WHERE internal_device_id = ?", (saved_id,),
                ).fetchone()
                payload = json.loads(row[0])
                payload["device_id"] = "asset-alternative"
                payload.pop("conflicts", None)
                payload.pop("conflictsTruncated", None)
                connection.execute(
                    "UPDATE resolved_device_inventory SET payload_json = ? WHERE internal_device_id = ?",
                    (json.dumps(payload, ensure_ascii=False), saved_id),
                )
                connection.execute("DELETE FROM resolved_device_identity_aliases")
                connection.commit()
            connection.close()

            initialize_database(database)

            repaired = list_resolved_devices(database)["devices"][0]
            self.assertEqual(len(repaired["conflicts"]), 1)
            self.assertEqual(repaired["conflicts"][0]["identifier"], "deviceId")
            with sqlite3.connect(database) as connection:
                self.assertIsNotNone(connection.execute(
                    "SELECT 1 FROM resolved_device_identity_aliases "
                    "WHERE internal_device_id = ? AND identity_type = 'device' AND identity_value = 'asset-alternative'",
                    (saved_id,),
                ).fetchone())
            connection.close()

            rejected = save_resolved_devices(database, [{"device_id": "asset-alternative", "room": "must-not-merge"}])

            self.assertEqual(rejected["savedCount"], 0)
            self.assertEqual(rejected["conflicts"][0]["reason"], "conflicting_strong_identity")
            self.assertEqual(list_resolved_devices(database)["total"], 1)

    def test_device_id_priority_selects_unique_row_and_quarantines_conflicting_mac(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "identity-priority.db"
            initialize_database(database)
            selected_id = save_resolved_devices(database, [{"deviceId": "edge-priority-1", "vendor": "Acme"}])["saved"][0]
            mac_owner = save_resolved_devices(database, [{"mac": "AA:BB:CC:DD:EE:71", "vendor": "Other"}])["saved"][0]

            result = save_resolved_devices(database, [{
                "deviceId": "edge-priority-1", "mac": "AA:BB:CC:DD:EE:71", "room": "101",
            }])

            self.assertEqual(result["saved"], [selected_id])
            self.assertEqual(result["savedCount"], 1)
            self.assertEqual(result["conflictCount"], 1)
            self.assertEqual(result["conflicts"][0]["candidateInternalDeviceIds"], [mac_owner])
            self.assertEqual(result["conflicts"][0]["selectedPriority"], 1)
            self.assertEqual(result["conflicts"][0]["contestedFields"], ["mac"])
            with sqlite3.connect(database) as connection:
                rows = connection.execute(
                    "SELECT internal_device_id, mac, room FROM resolved_device_inventory ORDER BY internal_device_id"
                ).fetchall()
            connection.close()
            self.assertEqual(len(rows), 2)
            self.assertEqual(next(row[1] for row in rows if row[0] == selected_id), "")
            self.assertEqual(next(row[1] for row in rows if row[0] == mac_owner), "AA:BB:CC:DD:EE:71")
            self.assertEqual(next(row[2] for row in rows if row[0] == selected_id), "101")

    def test_conflicting_supplied_internal_ids_do_not_fall_through_to_shared_device_id(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "internal-id-priority-conflict.db"
            initialize_database(database)
            first = save_resolved_devices(database, [{
                "internalDeviceId": "source-internal-a", "deviceId": "shared-device-id",
                "room": "original-room",
            }])
            self.assertEqual(first["savedCount"], 1)

            conflict = save_resolved_devices(database, [{
                "internalDeviceId": "source-internal-b", "deviceId": "shared-device-id",
                "room": "must-not-merge",
            }])

            self.assertEqual(conflict["savedCount"], 0)
            self.assertEqual(conflict["conflicts"][0]["reason"], "conflicting_strong_identity")
            stored = list_resolved_devices(database)
            self.assertEqual(stored["total"], 1)
            self.assertEqual(stored["devices"][0]["room"], "original-room")

    def test_conflicting_internal_id_aliases_keep_priority_and_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "internal-id-alias-priority-conflict.db"
            initialize_database(database)
            saved = save_resolved_devices(database, [{
                "internalDeviceId": "stable-internal-key", "room": "original-room",
            }])
            self.assertEqual(saved["savedCount"], 1)

            merged = save_resolved_devices(database, [{
                "id": "stable-internal-key", "internalDeviceId": "other-internal-key",
                "room": "must-not-merge",
            }])

            self.assertEqual(merged["saved"], ["stable-internal-key"])
            self.assertEqual(merged["conflictCount"], 1)
            self.assertEqual(merged["conflicts"][0]["field"], "room")
            stored = list_resolved_devices(database)
            self.assertEqual(stored["total"], 1)
            self.assertEqual(stored["devices"][0]["room"], "original-room")
            self.assertIn({
                "field": "identity", "identifier": "id", "selected": "stable-internal-key",
                "alternative": "other-internal-key", "source": "Импорт",
                "reason": "Конфликтующие алиасы сильного идентификатора (id / internalDeviceId)",
            }, stored["devices"][0]["conflicts"])

    def test_inventory_conflict_deduplication_matches_browser_merge_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "browser-conflict-dedup.db"
            initialize_database(database)
            first_conflict = {
                "field": "room", "selected": "101", "value": "202", "source": "DDIO",
            }
            saved = save_resolved_devices(database, [{
                "internalDeviceId": "conflict-dedup-device", "conflicts": [first_conflict],
            }])
            self.assertEqual(saved["savedCount"], 1)

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "conflict-dedup-device", "conflicts": [
                    {**first_conflict, "selected": "303"},
                    {**first_conflict, "value": "404"},
                ],
            }])

            self.assertEqual(merged["conflictCount"], 0)
            stored = list_resolved_devices(database)["devices"][0]["conflicts"]
            self.assertEqual(stored, [
                first_conflict, {**first_conflict, "value": "404"},
            ])

    def test_vendor_and_model_confidence_metadata_refresh_when_blank_values_are_filled(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "inventory-confidence-refresh.db"
            initialize_database(database)
            saved = save_resolved_devices(database, [{
                "internalDeviceId": "confidence-refresh-device",
                "vendorConfidence": 0.8, "vendorSource": "Legacy vendor source",
                "modelConfidence": 0.7, "modelSource": "Legacy model source",
            }])
            self.assertEqual(saved["savedCount"], 1)

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "confidence-refresh-device",
                "manufacturer": "Acme", "vendorConfidence": 0,
                "vendorSource": "Current vendor source",
                "model": "M1", "modelConfidence": 0,
                "modelSource": "Current model source",
            }])

            self.assertEqual(merged["saved"], ["confidence-refresh-device"])
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["manufacturer"], "Acme")
            self.assertEqual(device["vendorConfidence"], 0.0)
            self.assertEqual(device["vendorSource"], "Current vendor source")
            self.assertEqual(device["model"], "M1")
            self.assertEqual(device["modelConfidence"], 0.0)
            self.assertEqual(device["modelSource"], "Current model source")

    def test_confidence_and_provenance_snake_case_aliases_match_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "confidence-aliases.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "internalDeviceId": "confidence-aliases",
                "vendorConfidence": "1.4", "vendor_confidence": "0.4",
                "modelConfidence": "invalid", "model_confidence": "-0.2",
                "vendorSource": "Unknown", "vendor_source": " IEEE OUI ",
                "modelSource": "", "model_source": " MAC5 ",
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["vendorConfidence"], 1.0)
            self.assertEqual(device["modelConfidence"], 0.0)
            self.assertEqual(device["vendorSource"], "IEEE OUI")
            self.assertEqual(device["modelSource"], "MAC5")

    def test_vendor_model_source_aliases_reject_booleans_like_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "boolean-provenance-normalization.db"
            initialize_database(database)
            result = save_resolved_devices(database, [
                {"internalDeviceId": "source-fallback", "vendorSource": False, "vendor_source": "IEEE", "modelSource": True, "model_source": "History"},
                {"internalDeviceId": "source-empty", "vendorSource": True, "modelSource": False},
            ])

            self.assertEqual(result["savedCount"], 2)
            devices = {device["internalDeviceId"]: device for device in list_resolved_devices(database)["devices"]}
            self.assertEqual(devices["source-fallback"]["vendorSource"], "IEEE")
            self.assertEqual(devices["source-fallback"]["modelSource"], "History")
            self.assertEqual(devices["source-empty"]["vendorSource"], "")
            self.assertEqual(devices["source-empty"]["modelSource"], "")

    def test_confidence_aliases_use_javascript_number_coercion(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "confidence-number-coercion.db"
            initialize_database(database)
            result = save_resolved_devices(database, [
                {"internalDeviceId": "whitespace-confidence", "vendorConfidence": " ", "vendor_confidence": 0.6},
                {"internalDeviceId": "hex-confidence", "modelConfidence": "0x10", "model_confidence": 0.25},
            ])

            self.assertEqual(result["savedCount"], 2)
            devices = {device["internalDeviceId"]: device for device in list_resolved_devices(database)["devices"]}
            self.assertEqual(devices["whitespace-confidence"]["vendorConfidence"], 0.0)
            self.assertEqual(devices["hex-confidence"]["modelConfidence"], 1.0)

    def test_field_sources_values_match_browser_text_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "field-sources-values.db"
            initialize_database(database)
            custom_key = _custom_key("nested-source")
            result = save_resolved_devices(database, [{
                "internalDeviceId": "field-sources-values",
                "fieldSources": {
                    "boolean": False,
                    "number": 7,
                    "emptyMarker": "unknown",
                    "text": "  Main  ",
                    "nested": {"source": "ignored"},
                },
                "customFields": {custom_key: "rack-1"},
                "customFieldSources": {custom_key: {"source": "ignored"}},
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["fieldSources"], {
                "boolean": "false",
                "number": "7",
                "text": "Main",
            })
            self.assertEqual(device["customFieldSources"], {})

    def test_evidence_lists_accept_browser_scalar_values_before_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "scalar-evidence.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "internalDeviceId": "scalar-evidence",
                "alternateMacs": [112233445566, False, None],
                "possibleIps": [False, None],
                "sources": [7, False, None],
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["alternateMacs"], ["11:22:33:44:55:66"])
            self.assertEqual(device["possibleIps"], [])
            self.assertEqual(device["sources"], ["7", "false"])

    def test_packed_alternate_mac_text_matches_browser_legacy_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "packed-alternates.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "internalDeviceId": "packed-alternates",
                "mac": "00:11:22:33:44:55",
                "alternateMacs": "AA-BB-CC-DD-EE-02, 00:11:22:33:44:55,AA:BB:CC:DD:EE:02,AA:BB:CC:DD:EE:03",
            }])

            self.assertEqual(result["savedCount"], 1)
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["alternateMacs"], ["AA:BB:CC:DD:EE:02", "AA:BB:CC:DD:EE:03"])
            self.assertFalse(device["alternateMacsTruncated"])

    def test_numeric_identity_and_provenance_use_javascript_number_formatting(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "numeric-number-formatting.db"
            initialize_database(database)
            result = save_resolved_devices(database, [{
                "id": 1e-7,
                "fieldSources": {"small": 1e-7, "decimal": 1e-5, "large": 1e20, "negativeZero": -0.0},
            }])

            self.assertEqual(result["saved"], ["1e-7"])
            device = list_resolved_devices(database)["devices"][0]
            self.assertEqual(device["internalDeviceId"], "1e-7")
            self.assertEqual(device["fieldSources"], {
                "small": "1e-7", "decimal": "0.00001", "large": "100000000000000000000", "negativeZero": "0",
            })

    def test_internal_id_match_quarantines_different_primary_mac_even_when_alternate_overlaps(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "primary-vs-alternate-mac-conflict.db"
            initialize_database(database)
            first = save_resolved_devices(database, [{
                "internalDeviceId": "stable-primary-mac-conflict", "mac": "AA:BB:CC:DD:EE:91",
                "alternateMacs": ["AA:BB:CC:DD:EE:92"], "room": "original-room",
            }])
            self.assertEqual(first["savedCount"], 1)

            result = save_resolved_devices(database, [{
                "internalDeviceId": "stable-primary-mac-conflict", "mac": "AA:BB:CC:DD:EE:93",
                "alternateMacs": ["AA:BB:CC:DD:EE:92"], "room": "must-not-merge",
            }])

            self.assertEqual(result["saved"], ["stable-primary-mac-conflict"])
            self.assertEqual(result["conflicts"][0]["reason"], "conflicting_strong_identity")
            self.assertEqual(result["conflicts"][0]["fields"], [{
                "field": "mac", "existingValue": "AABBCCDDEE91", "incomingValue": "AABBCCDDEE93",
            }])
            self.assertEqual(result["conflicts"][0]["selectedPriority"], 0)
            self.assertTrue(result["conflicts"][0]["resolvedByPriority"])
            stored = list_resolved_devices(database)
            self.assertEqual(stored["total"], 1)
            self.assertEqual(stored["devices"][0]["mac"], "AA:BB:CC:DD:EE:91")
            self.assertEqual(stored["devices"][0]["room"], "original-room")
            self.assertIn("AA:BB:CC:DD:EE:93", stored["devices"][0]["alternateMacs"])

    def test_alternate_mac_match_cannot_override_conflicting_primary_mac(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "alternate-match-primary-conflict.db"
            initialize_database(database)
            saved = save_resolved_devices(database, [{
                "internalDeviceId": "stable-primary-owner", "mac": "AA:BB:CC:DD:EE:B1",
                "alternateMacs": ["AA:BB:CC:DD:EE:B2"], "room": "original-room",
            }])
            self.assertEqual(saved["savedCount"], 1)

            rejected = save_resolved_devices(database, [{"mac": "AA:BB:CC:DD:EE:B2", "room": "must-not-merge"}])

            self.assertEqual(rejected["savedCount"], 0)
            self.assertEqual(rejected["conflicts"][0]["reason"], "conflicting_strong_identity")
            self.assertEqual(list_resolved_devices(database)["total"], 1)

    def test_resolved_inventory_conflicts_remain_bounded_across_additive_merges(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "bounded-conflict-merge.db"
            initialize_database(database)
            first_conflicts = [
                {"field": "room", "selected": "original", "value": f"incoming-{index}", "source": "test"}
                for index in range(80)
            ]
            second_conflicts = [
                {"field": "room", "selected": "original", "value": f"incoming-{index}", "source": "test"}
                for index in range(80, 160)
            ]
            saved = save_resolved_devices(database, [{
                "internalDeviceId": "stable-bounded-conflicts", "deviceId": "bounded-conflicts",
                "conflicts": first_conflicts,
            }])
            self.assertEqual(saved["savedCount"], 1)

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "stable-bounded-conflicts", "deviceId": "bounded-conflicts",
                "conflicts": second_conflicts,
            }])

            self.assertEqual(merged["saved"], ["stable-bounded-conflicts"])
            stored = list_resolved_devices(database)["devices"][0]
            self.assertEqual(len(stored["conflicts"]), 100)
            self.assertTrue(stored["conflictsTruncated"])
            self.assertEqual(stored["conflicts"][0], first_conflicts[0])
            self.assertEqual(stored["conflicts"][-1], second_conflicts[19])

    def test_inventory_write_returns_exact_conflict_count_with_bounded_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "inventory-conflict-samples.db"
            initialize_database(database)
            devices = [
                {"id": f"duplicate-{index}", "observationCount": 1}
                for index in range(101)
                for _ in range(2)
            ]

            result = save_resolved_devices(database, devices)

            self.assertEqual(result["savedCount"], 0)
            self.assertEqual(result["rejectedCount"], 202)
            self.assertEqual(result["conflictCount"], 101)
            self.assertEqual(len(result["conflicts"]), 100)
            self.assertTrue(result["conflictsTruncated"])
            self.assertLessEqual(len(json.dumps(result["conflicts"], ensure_ascii=False).encode("utf-8")), 512 * 1024)

    def test_stronger_internal_id_merge_keeps_lower_priority_conflicts_visible_and_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "stronger-id-lower-conflict.db"
            initialize_database(database)
            first = save_resolved_devices(database, [{
                "internalDeviceId": "stable-strong-id", "deviceId": "edge-1",
                "mac": "AA:BB:CC:DD:EE:A1", "room": "original-room",
            }])
            self.assertEqual(first["savedCount"], 1)

            merged = save_resolved_devices(database, [{
                "internalDeviceId": "stable-strong-id", "deviceId": "edge-2",
                "mac": "AA:BB:CC:DD:EE:A2", "room": "101", "source": "Main",
            }])

            self.assertEqual(merged["saved"], ["stable-strong-id"])
            self.assertEqual(merged["conflictCount"], 2)
            self.assertTrue(merged["conflicts"][0]["resolvedByPriority"])
            self.assertEqual(merged["conflicts"][0]["selectedPriority"], 0)
            self.assertEqual(
                {item["field"] for item in merged["conflicts"][1:]},
                {"room"},
            )
            stored_page = list_resolved_devices(database)
            self.assertEqual(stored_page["total"], 1)
            stored = stored_page["devices"][0]
            self.assertEqual(stored["deviceId"], "edge-1")
            self.assertEqual(stored["mac"], "AA:BB:CC:DD:EE:A1")
            self.assertEqual(stored["room"], "original-room")
            self.assertIn("AA:BB:CC:DD:EE:A2", stored["alternateMacs"])
            self.assertIn({
                "field": "deviceId", "selected": "edge-1", "value": "edge-2", "source": "Main",
            }, stored["conflicts"])

    def test_device_id_priority_resolves_custom_host_ids_but_rejects_a_same_priority_tie(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "identity-priority-custom-ids.db"
            initialize_database(database)
            save_resolved_devices(database, [{
                "internalDeviceId": "host-device-a", "deviceId": "edge-priority-2", "vendor": "Acme",
            }])
            mac_owner = save_resolved_devices(database, [{
                "mac": "AA:BB:CC:DD:EE:72", "vendor": "Other",
            }])["saved"][0]

            result = save_resolved_devices(database, [{
                "deviceId": "edge-priority-2", "mac": "AA:BB:CC:DD:EE:72", "room": "202",
            }])

            self.assertEqual(result["saved"], ["host-device-a"])
            self.assertEqual(result["conflictCount"], 1)
            self.assertEqual(result["conflicts"][0]["selectedInternalDeviceId"], "host-device-a")
            with sqlite3.connect(database) as connection:
                connection.execute(
                    "INSERT INTO resolved_device_inventory "
                    "(internal_device_id, device_id, payload_json, first_seen, updated_at, seen_count) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("host-device-b", "edge-priority-2", json.dumps({"deviceId": "edge-priority-2"}),
                     "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z", 1),
                )
                connection.commit()
            connection.close()

            tied = save_resolved_devices(database, [{"deviceId": "edge-priority-2", "room": "303"}])

            self.assertEqual(tied["savedCount"], 0)
            self.assertEqual(tied["conflicts"][0]["reason"], "conflicting_strong_identity")
            self.assertEqual(set(tied["conflicts"][0]["candidateInternalDeviceIds"]), {"host-device-a", "host-device-b"})
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute(
                    "SELECT room FROM resolved_device_inventory WHERE internal_device_id='host-device-a'"
                ).fetchone()[0], "202")
            connection.close()

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
                connection.execute("PRAGMA user_version=10")
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

    def test_database_maintenance_checks_and_preserves_resolved_records(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "data.db"
            initialize_database(database)
            save_resolved_devices(database, [{"deviceId": "maintenance-device", "mac": "00:11:22:33:44:55", "vendor": "Acme"}])

            checked = database_maintenance(database)
            self.assertTrue(checked["ok"])
            self.assertEqual(checked["integrity"], "ok")
            self.assertEqual(checked["afterIntegrity"], "ok")
            self.assertTrue(checked["optimized"])
            self.assertFalse(checked["vacuumed"])
            self.assertEqual(checked["before"]["counts"]["resolved_device_inventory"], 1)
            self.assertEqual(checked["after"]["counts"]["resolved_device_inventory"], 1)

            vacuumed = database_maintenance(database, integrity=True, optimize=False, vacuum=True)
            self.assertTrue(vacuumed["ok"])
            self.assertFalse(vacuumed["optimized"])
            self.assertTrue(vacuumed["vacuumed"])
            self.assertEqual(vacuumed["after"]["counts"]["resolved_device_inventory"], 1)
            self.assertEqual(database_summary(database)["integrity"], "ok")

            with self.assertRaisesRegex(ValueError, "booleans"):
                database_maintenance(database, vacuum=1)

    def test_database_maintenance_does_not_mutate_an_invalid_sqlite_file(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "invalid.db"
            database.write_bytes(b"not a SQLite database")
            original = database.read_bytes()
            with self.assertRaises(sqlite3.DatabaseError):
                database_maintenance(database, integrity=True, optimize=True, vacuum=True)
            self.assertEqual(database.read_bytes(), original)

    def test_database_maintenance_checks_and_preserves_resolved_records(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "data.db"
            initialize_database(database)
            save_resolved_devices(database, [{"deviceId": "maintenance-device", "mac": "00:11:22:33:44:55", "vendor": "Acme"}])

            checked = database_maintenance(database)
            self.assertTrue(checked["ok"])
            self.assertEqual(checked["integrity"], "ok")
            self.assertEqual(checked["afterIntegrity"], "ok")
            self.assertTrue(checked["optimized"])
            self.assertFalse(checked["vacuumed"])
            self.assertEqual(checked["before"]["counts"]["resolved_device_inventory"], 1)
            self.assertEqual(checked["after"]["counts"]["resolved_device_inventory"], 1)

            vacuumed = database_maintenance(database, integrity=True, optimize=False, vacuum=True)
            self.assertTrue(vacuumed["ok"])
            self.assertFalse(vacuumed["optimized"])
            self.assertTrue(vacuumed["vacuumed"])
            self.assertEqual(vacuumed["after"]["counts"]["resolved_device_inventory"], 1)
            self.assertEqual(database_summary(database)["integrity"], "ok")

            with self.assertRaisesRegex(ValueError, "booleans"):
                database_maintenance(database, vacuum=1)


if __name__ == "__main__":
    unittest.main()
