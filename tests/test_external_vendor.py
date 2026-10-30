import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.services.integrations import external_vendor
from scripts.optional_sqlite_store import initialize_database


class ExternalVendorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "host.db"
        initialize_database(self.database)

    def tearDown(self):
        self.temp.cleanup()

    def test_settings_are_opt_in_fixed_provider_and_bounded(self):
        self.assertFalse(external_vendor.load_settings(self.database)["enabled"])
        saved = external_vendor.save_settings(self.database, {
            "enabled": True, "provider": "custom", "endpoint": "http://127.0.0.1", "rateLimit": 9999,
        })
        self.assertEqual(saved["provider"], "macvendors")
        self.assertEqual(saved["rateLimit"], 500)
        self.assertNotIn("endpoint", saved)
        self.assertEqual([row["key"] for row in external_vendor.provider_options()], ["macvendors", "maclookup", "mac2vendor"])

    def test_fixed_provider_redirects_are_rejected(self):
        request = external_vendor.Request("https://api.macvendors.com/AABBCC000001")
        handler = external_vendor._DenyVendorRedirects()
        self.assertIsNone(handler.redirect_request(
            request, None, 302, "Found", {"Location": "https://attacker.example/mac"}, "https://attacker.example/mac"
        ))
        self.assertIsNone(handler.redirect_request(
            request, None, 302, "Found", {"Location": "https://api.macvendors.com/other"}, "https://api.macvendors.com/other"
        ))

    def test_vendor_transport_wires_the_redirect_rejecting_handler(self):
        request = external_vendor.Request("https://api.macvendors.com/AABBCC000001")
        with patch.object(external_vendor, "build_opener") as build_opener:
            external_vendor.urlopen(request, timeout=3)
        build_opener.assert_called_once_with(external_vendor._DenyVendorRedirects)
        build_opener.return_value.open.assert_called_once_with(request, timeout=3)

    def test_invalid_mac_and_disabled_api_never_open_network(self):
        with patch.object(external_vendor, "urlopen", side_effect=AssertionError("no network")):
            invalid = external_vendor.test_vendor_api(self.database, "not-a-mac")
            disabled = external_vendor.test_vendor_api(self.database, "AA:BB:CC:00:00:01")
        self.assertFalse(invalid["ok"])
        self.assertEqual(invalid["lookups"], 0)
        self.assertFalse(disabled["ok"])
        self.assertEqual(disabled["lookups"], 0)

    def test_lookup_uses_only_fixed_https_provider_and_parses_responses(self):
        class Response:
            status = 200

            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return self.body

        settings = external_vendor.normalize_settings({"enabled": True, "provider": "macvendors"})
        with patch.object(external_vendor, "_rate_limit"), patch.object(
            external_vendor, "urlopen", return_value=Response(b"Example Vendor")
        ) as request:
            self.assertEqual(external_vendor.lookup_vendor("AA:BB:CC:00:00:01", settings), "Example Vendor")
        sent_request = request.call_args.args[0]
        self.assertEqual(sent_request.full_url, "https://api.macvendors.com/AABBCC000001")
        self.assertEqual(request.call_args.kwargs["timeout"], external_vendor.REQUEST_TIMEOUT_SECONDS)

        settings["provider"] = "maclookup"
        with patch.object(external_vendor, "_rate_limit"), patch.object(
            external_vendor, "urlopen", return_value=Response(json.dumps({"found": True, "company": "Lookup Vendor"}).encode())
        ):
            self.assertEqual(external_vendor.lookup_vendor("AABBCC000001", settings), "Lookup Vendor")

    def test_lookup_handles_provider_errors_without_leaking_request_details(self):
        settings = external_vendor.normalize_settings({"enabled": True})
        with patch.object(external_vendor, "_rate_limit"), patch.object(external_vendor, "urlopen", side_effect=OSError("private detail")):
            self.assertIsNone(external_vendor.lookup_vendor("AABBCC000001", settings))

    def test_test_call_caches_result_and_forced_live_refreshes(self):
        external_vendor.save_settings(self.database, {"enabled": True, "provider": "macvendors"})
        with patch.object(external_vendor, "_rate_limit"), patch.object(external_vendor, "urlopen") as request:
            class Response:
                status = 200
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def read(self, _limit): return b"Example Vendor"
            request.return_value = Response()
            live = external_vendor.test_vendor_api(self.database, "AA:BB:CC:00:00:01")
            cached = external_vendor.test_vendor_api(self.database, "AA:BB:CC:00:00:01")
            external_vendor.test_vendor_api(self.database, "AA:BB:CC:00:00:01", force_live=True)
        self.assertEqual(live["source"], "api")
        self.assertEqual(cached["source"], "cache")
        self.assertEqual(request.call_count, 2)

    def test_batch_deduplicates_macs_limits_payload_and_keeps_cache_provider_scoped(self):
        external_vendor.save_settings(self.database, {"enabled": True, "provider": "maclookup", "rateLimit": 1})
        with patch.object(external_vendor, "lookup_vendor", return_value="Lookup Vendor") as lookup:
            result = external_vendor.enrich_macs(self.database, ["AA:BB:CC:00:00:01", "AABBCC000001", "bad"])
        self.assertEqual(result["candidates"], 1)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(lookup.call_count, 1)
        self.assertEqual(external_vendor.enrich_macs(self.database, ["AA:BB:CC:00:00:01"])["cached"], 1)
        external_vendor.cache_set(self.database, external_vendor.cache_key("macvendors", "AABBCC000002"), "Other Vendor")
        self.assertEqual(external_vendor.clear_cache(self.database, "maclookup"), 1)
        self.assertIsNotNone(external_vendor.cache_get(self.database, external_vendor.cache_key("macvendors", "AABBCC000002")))
        with self.assertRaisesRegex(ValueError, "выключен"):
            external_vendor.save_settings(self.database, {"enabled": False})
            external_vendor.enrich_macs(self.database, ["AABBCC000001"])

    def test_batch_rejects_oversized_input_before_lookups(self):
        external_vendor.save_settings(self.database, {"enabled": True})
        with patch.object(external_vendor, "lookup_vendor", side_effect=AssertionError("lookup must not start")):
            with self.assertRaisesRegex(ValueError, "не более"):
                external_vendor.enrich_macs(self.database, ["AABBCC000001"] * (external_vendor.MAX_VENDOR_BATCH + 1))


if __name__ == "__main__":
    unittest.main()
