import test from "node:test";
import assert from "node:assert/strict";
import { TextEncoder } from "node:util";
import { createIeeeRegistryPayload, IEEE_REGISTRY_SOURCES, parseIeeeRegistryCsv } from "../scripts/update-ieee-registry.mjs";

test("IEEE CSV parser reads quoted organizations and keeps the latest duplicate assignment", () => {
  const rows = parseIeeeRegistryCsv([
    'Assignment,Organization Name',
    '00-11-22,"Vendor, Inc."',
    '00-11-22,Updated Vendor',
    'invalid,',
  ].join("\n"));
  assert.deepEqual(rows, [["001122", "Updated Vendor"]]);
  assert.throws(() => parseIeeeRegistryCsv("wrong,headers\nx,y"), /missing Assignment/);
  assert.throws(() => parseIeeeRegistryCsv("Assignment,Organization Name\nx,"), /no valid assignments/);
});

test("IEEE updater payload counts all registries and excludes CID assignments from vendor matching", async () => {
  const entries = new Map([
    ["MA-L", "001122,Vendor A"],
    ["MA-M", "AABBCCD,Vendor B"],
    ["MA-S", "112233445,Vendor C"],
    ["IAB", "223344556,Vendor D"],
    ["CID", "334455,Protocol Org"],
  ]);
  const payload = await createIeeeRegistryPayload(async (url, options) => {
    const registry = Object.entries(IEEE_REGISTRY_SOURCES).find(([, source]) => source === url)?.[0];
    assert.ok(registry);
    assert.match(options.headers["user-agent"], /IEEE registry updater/);
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode(`Assignment,Organization Name\n${entries.get(registry)}\n`).buffer };
  });
  assert.deepEqual(payload.metadata.counts, { "MA-L": 1, "MA-M": 1, "MA-S": 1, IAB: 1, CID: 1 });
  assert.equal(payload.metadata.total, 5);
  assert.deepEqual(payload.catalog.CID, [["334455", "Protocol Org"]]);
  assert.deepEqual(payload.rows["6"], ["001122", payload.vendors.indexOf("Vendor A")]);
  assert.deepEqual(payload.rows["7"], ["AABBCCD", payload.vendors.indexOf("Vendor B")]);
  assert.deepEqual(payload.rows["9"], ["112233445", payload.vendors.indexOf("Vendor C"), "223344556", payload.vendors.indexOf("Vendor D")]);
  assert.ok(!payload.vendors.includes("Protocol Org"));
  assert.ok(!Object.values(payload.rows).some((row) => row.includes("334455")));
  assert.equal(payload.metadata.sources.length, 5);
  assert.match(payload.metadata.sources[0].sha256, /^[0-9a-f]{64}$/);
});

test("CID catalog rows are retained for reference without entering the device vendor index", async () => {
  const entries = new Map(Object.keys(IEEE_REGISTRY_SOURCES).map((registry) => [registry, registry === "CID" ? "334455,Protocol Org" : `${registry === "MA-L" ? "001122" : registry === "MA-M" ? "AABBCCD" : registry === "MA-S" ? "112233445" : "223344556"},${registry} Vendor`]));
  const payload = await createIeeeRegistryPayload(async (url) => {
    const registry = Object.entries(IEEE_REGISTRY_SOURCES).find(([, source]) => source === url)?.[0];
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode(`Assignment,Organization Name\n${entries.get(registry)}\n`).buffer };
  });
  const { buildIeeeRegistryIndex, lookupOuiVendor } = await import("../src/core/ieee-registry.js");
  assert.deepEqual(payload.catalog.CID, [["334455", "Protocol Org"]]);
  assert.equal(lookupOuiVendor("33:44:55:00:00:01", buildIeeeRegistryIndex(payload)), "");
});

test("IEEE updater refuses failed HTTP responses instead of producing a partial registry", async () => {
  let requestCount = 0;
  await assert.rejects(createIeeeRegistryPayload(async () => {
    requestCount += 1;
    return { ok: false, status: 503 };
  }), /MA-L download failed: HTTP 503/);
  assert.equal(requestCount, 1);
});
