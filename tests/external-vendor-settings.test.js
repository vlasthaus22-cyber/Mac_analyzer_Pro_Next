import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("external vendor numeric settings match backend normalization for empty and fractional values", () => {
  assert.deepEqual(normalizeExternalVendorSettings({ provider: " MACLOOKUP ", rateLimit: 0, cacheTtlDays: null }), {
    enabled: false, provider: "maclookup", rateLimit: 1, cacheTtlDays: 1, onlyUnknown: true,
  });
  assert.deepEqual(normalizeExternalVendorSettings({ rateLimit: "2.8", cacheTtlDays: "0x10" }), {
    ...DEFAULT_EXTERNAL_VENDOR_SETTINGS, rateLimit: 2, cacheTtlDays: 16,
  });
  assert.deepEqual(normalizeExternalVendorSettings({ rateLimit: [], cacheTtlDays: {} }), DEFAULT_EXTERNAL_VENDOR_SETTINGS);
  assert.equal(normalizeExternalVendorSettings({ rateLimit: "1_0" }).rateLimit, 25);
});

test("browser vendor settings match the shared cross-runtime normalization cases", () => {
  const cases = JSON.parse(readFileSync("tests/fixtures/external-vendor-settings.json", "utf8"));
  for (const { name, input, expected } of cases) {
    assert.deepEqual(normalizeExternalVendorSettings(input), expected, name);
  }
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

test("vendor candidate planning uses canonical MAC parsing and shared empty-vendor markers", () => {
  const devices = [
    { mac: "AA:BB:CC:00:00:01", vendor: "N/A" },
    { mac: "AA:BB:CC:00:00:02", vendor: "Неизвестный вендор" },
    { mac: "AA:BB:CC:00:00:03", vendor: "Known Vendor" },
    { mac: "serial 001122334455 from source", vendor: "" },
    { macAddress: "001122334466", vendor: "Unknown Model" },
    { mac: "000000000000", vendor: "" },
  ];
  assert.deepEqual(externalVendorCandidateMacs(devices, { enabled: true, onlyUnknown: true }), [
    "AABBCC000001", "AABBCC000002", "001122334466",
  ]);
  assert.equal(normalizeExternalVendorMac("label AA:BB:CC:00:00:01 imported"), "");
  assert.deepEqual(externalVendorCandidateMacs(devices, { enabled: true, onlyUnknown: false }), [
    "AABBCC000001", "AABBCC000002", "AABBCC000003", "001122334466",
  ]);
  assert.equal(normalizeExternalVendorMac("serial 001122334455 from source"), "");
  assert.equal(normalizeExternalVendorMac("000000000000"), "");
});

test("the replacement keyless provider is available without changing the default or opt-in", () => {
  assert.deepEqual(normalizeExternalVendorSettings({ provider: "MACADRESS", enabled: true }), {
    enabled: true, provider: "macadress", rateLimit: 25, cacheTtlDays: 30, onlyUnknown: true,
  });
  assert.equal(normalizeExternalVendorSettings().enabled, false);
});
