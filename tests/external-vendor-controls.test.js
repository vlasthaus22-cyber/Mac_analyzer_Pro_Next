import test from "node:test";
import assert from "node:assert/strict";
import {
  externalVendorApiBase,
  loadExternalVendorSettings,
  lookupExternalVendorMacs,
  saveExternalVendorSettings,
  testExternalVendorApi,
} from "../src/ui/external-vendor-controls.js";

const localLocation = { protocol: "http:", hostname: "127.0.0.1", port: "8451", origin: "http://127.0.0.1:8451" };

test("external vendor controls are restricted to the optional loopback host", () => {
  assert.equal(externalVendorApiBase(localLocation), localLocation.origin);
  assert.equal(externalVendorApiBase({ ...localLocation, hostname: "192.168.1.2" }), null);
  assert.equal(externalVendorApiBase({ ...localLocation, protocol: "https:" }), null);
  assert.equal(externalVendorApiBase({ ...localLocation, port: "" }), null);
});

test("external vendor settings are normalized and saved only to same-computer host", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ settings: { enabled: false, provider: "macvendors", rateLimit: 25, cacheTtlDays: 30, onlyUnknown: true }, providers: [] }) };
  };
  const loaded = await loadExternalVendorSettings({ locationLike: localLocation, fetchImpl });
  assert.equal(loaded.settings.enabled, false);
  await saveExternalVendorSettings({ enabled: true, provider: "maclookup", rateLimit: 10 }, { locationLike: localLocation, fetchImpl });
  assert.equal(calls[0].url, localLocation.origin + "/api/external-vendor/settings");
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.redirect, "error");
  assert.deepEqual(JSON.parse(calls[1].options.body), { settings: { enabled: true, provider: "maclookup", rateLimit: 10, cacheTtlDays: 30, onlyUnknown: true } });
});

test("test and batch requests send only normalized MAC values to the loopback host", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await testExternalVendorApi("aa-bb-cc-00-00-01", { locationLike: localLocation, fetchImpl });
  await lookupExternalVendorMacs(["AA:BB:CC:00:00:02", "invalid"], { locationLike: localLocation, fetchImpl });
  assert.deepEqual(JSON.parse(calls[0].options.body), { mac: "AABBCC000001", forceLive: false });
  assert.deepEqual(JSON.parse(calls[1].options.body), { macs: ["AABBCC000002"] });
  assert.ok(calls.every(({ url }) => url.startsWith(localLocation.origin + "/api/external-vendor/")));
  await assert.rejects(testExternalVendorApi("invalid", { locationLike: localLocation, fetchImpl }), /12 шестнадцатеричных/);
  await assert.rejects(testExternalVendorApi("AABBCC000001", { locationLike: { ...localLocation, hostname: "example.com" }, fetchImpl }), /optional host/);
});
