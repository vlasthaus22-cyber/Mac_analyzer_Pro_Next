import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXTERNAL_VENDOR_SETTINGS,
  externalVendorCandidateMacs,
  importedExternalVendorSettingsFallback,
  normalizeExternalVendorMac,
  normalizeExternalVendorSettings,
} from "../src/core/external-vendor-settings.js";

test("external vendor lookups are disabled by default and settings are bounded", () => {
  assert.deepEqual(normalizeExternalVendorSettings(), DEFAULT_EXTERNAL_VENDOR_SETTINGS);
  assert.deepEqual(normalizeExternalVendorSettings({ enabled: true, provider: "custom", rateLimit: 9999, cacheTtlDays: -2 }), {
    enabled: true, provider: "macvendors", rateLimit: 500, cacheTtlDays: 1, onlyUnknown: true,
  });
});

test("PyQt vendor preference survives host unavailability without restoring API opt-in", () => {
  assert.equal(importedExternalVendorSettingsFallback(null), null);
  assert.deepEqual(importedExternalVendorSettingsFallback({ provider: "maclookup", enabled: true, rateLimit: 60 }), {
    enabled: false, provider: "maclookup", rateLimit: 60, cacheTtlDays: 30, onlyUnknown: true,
  });
  assert.deepEqual(importedExternalVendorSettingsFallback({ provider: "untrusted", enabled: true }), {
    ...DEFAULT_EXTERNAL_VENDOR_SETTINGS,
    enabled: false,
  });
});

test("candidate planning sends normalized unique MACs and respects selection, unknown-only and request limit", () => {
  const devices = [
    { mac: "aa:bb:cc:00:00:01", vendor: "Unknown" },
    { macFormatted: "AA-BB-CC-00-00-01", vendor: "Unknown" },
    { mac: "AA:BB:CC:00:00:02", vendor: "Known Vendor" },
    { mac: "AA:BB:CC:00:00:03", vendor: "" },
    { mac: "invalid", vendor: "" },
  ];
  assert.deepEqual(externalVendorCandidateMacs(devices, { enabled: true, rateLimit: 1 }), ["AABBCC000001"]);
  assert.deepEqual(externalVendorCandidateMacs(devices, { enabled: true, onlyUnknown: false, rateLimit: 10 }, ["AA:BB:CC:00:00:02"]), ["AABBCC000002"]);
  assert.equal(normalizeExternalVendorMac("AA-BB-CC-00-00-01"), "AABBCC000001");
});
