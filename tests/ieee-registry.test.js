import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildIeeeRegistryIndex, createOuiIndexOverlay, detectOuiColumns, ieeeOuiRecordBatches, ieeeRegistryStatus, lookupOuiVendor, normalizeOuiPrefix, validateIeeeRegistry } from "../src/core/ieee-registry.js";

const registry = JSON.parse(readFileSync("assets/ieee-vendor-registry.json", "utf8"));

test("OUI column detection recognizes common headers and leaves custom fields selectable", () => {
  assert.deepEqual(detectOuiColumns(["Network", "Assignment", "Organization Name"]), { prefixIndex: 1, vendorIndex: 2 });
  assert.deepEqual(detectOuiColumns(["Column A", "Column B"]), { prefixIndex: -1, vendorIndex: -1 });
});

test("IEEE registry builds 24-, 28- and 36-bit assignments from the portable source", () => {
  const index = buildIeeeRegistryIndex(registry);
  const expectedPrefixes = Object.values(registry.rows).reduce((sum, row) => sum + row.length / 2, 0);
  const expectedSourceRecords = Object.values(registry.metadata.counts).reduce((sum, count) => sum + count, 0);
  assert.equal(index.size, expectedPrefixes);
  assert.equal(index.get("000000"), "XEROX CORPORATION");
  assert.equal(registry.metadata.schemaVersion, 2);
  assert.equal(registry.catalog.CID.length, registry.metadata.counts.CID);
  assert.ok(registry.catalog.CID.every(([prefix, organization]) => /^[0-9A-F]{6}$/.test(prefix) && organization));
  assert.equal(ieeeRegistryStatus(registry).counts.CID, 221);
  assert.equal(ieeeRegistryStatus(registry).total, expectedSourceRecords);
  assert.match(ieeeRegistryStatus(registry).generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(index.has("8C1F64860"), "the latest official MA-S assignment must be present in the bundled registry");
  assert.equal(lookupOuiVendor("8C:1F:64:86:0A:BC", index), index.get("8C1F64860"));
});

test("bundled OUI initialization streams every MA-L record in bounded batches", () => {
  let records = 0;
  let batches = 0;
  for (const batch of ieeeOuiRecordBatches(registry, { batchSize: 500 })) {
    batches += 1;
    records += batch.length;
    assert.ok(batch.length <= 500);
    assert.ok(batch.every((record) => /^[0-9A-F]{6}$/.test(record.prefix) && record.vendor && record.source === "Встроенный IEEE OUI"));
  }
  assert.equal(records, registry.rows["6"].length / 2);
  assert.equal(records, registry.metadata.counts["MA-L"]);
  assert.ok(batches > 1);
});

test("official IEEE payload validates every registry count and assignment before use", () => {
  assert.equal(validateIeeeRegistry(registry), true);
  const wrongCount = { ...registry, metadata: { ...registry.metadata, counts: { ...registry.metadata.counts, "MA-L": registry.metadata.counts["MA-L"] - 1 } } };
  assert.throws(() => validateIeeeRegistry(wrongCount), /неполон: префиксы длины 6/);
  const invalidVendorIndex = { ...registry, rows: { ...registry.rows, "7": [...registry.rows["7"]] } };
  invalidVendorIndex.rows["7"][1] = invalidVendorIndex.vendors.length;
  assert.throws(() => validateIeeeRegistry(invalidVendorIndex), /некорректную запись префикса 7/);
  const brokenCid = { ...registry, catalog: { ...registry.catalog, CID: [...registry.catalog.CID] } };
  brokenCid.catalog.CID.pop();
  assert.throws(() => validateIeeeRegistry(brokenCid), /неполный каталог CID/);
  const brokenSourceHash = { ...registry, metadata: { ...registry.metadata, sources: registry.metadata.sources.map((source) => ({ ...source })) } };
  brokenSourceHash.metadata.sources[0].sha256 = "invalid";
  assert.throws(() => validateIeeeRegistry(brokenSourceHash), /некорректные метаданные MA-L/);
});

test("IEEE lookup chooses the longest registered prefix and ignores invalid MACs", () => {
  const index = buildIeeeRegistryIndex({
    vendors: ["OUI", "MA-M", "4-byte local", "MA-S", "5-byte local"],
    rows: { "6": ["AABBCC", 0], "7": ["AABBCCD", 1], "8": ["AABBCCDD", 2], "9": ["AABBCCDDE", 3], "10": ["AABBCCDDEE", 4] },
  });
  assert.equal(lookupOuiVendor("AA:BB:CC:DD:EE:FF", index), "5-byte local");
  assert.equal(lookupOuiVendor("AA:BB:CC:DD:00:00", index), "4-byte local");
  assert.equal(lookupOuiVendor("AA:BB:CC:DD:EF:00", new Map([["AABBCCDDE", "MA-S"], ["AABBCCDD", "4-byte local"]])), "MA-S");
  assert.equal(lookupOuiVendor("AA:BB:CC:00:00:00", index), "OUI");
  assert.equal(lookupOuiVendor("not-a-mac", index), "");
});

test("user OUI prefixes normalize standard IEEE assignment lengths and local 3, 4, and 5-byte rules", () => {
  assert.equal(normalizeOuiPrefix("aa:bb:cc"), "AABBCC");
  assert.equal(normalizeOuiPrefix("  0xAA-BB-CC  "), "AABBCC");
  assert.equal(normalizeOuiPrefix("AA:BB:CC:D"), "AABBCCD");
  assert.equal(normalizeOuiPrefix("AA:BB:CC:DD"), "AABBCCDD");
  assert.equal(normalizeOuiPrefix("AA:BB:CC:DD:E"), "AABBCCDDE");
  assert.equal(normalizeOuiPrefix("AA:BB:CC:DD:EE"), "AABBCCDDEE");
  assert.equal(normalizeOuiPrefix("AA:BB"), "");
  assert.equal(normalizeOuiPrefix("AA:BB:CC:DD:EE:FF"), "");
});

test("user OUI entries override bundled IEEE assignments with the same prefix", () => {
  const bundled = new Map([["001122", "IEEE Vendor"], ["001122A", "IEEE Suballocation"]]);
  const custom = new Map([["001122", "Local Vendor"]]);
  const overlay = createOuiIndexOverlay(bundled, custom);
  assert.equal(lookupOuiVendor("00:11:22:AA:BB:CC", overlay), "IEEE Suballocation");
  assert.equal(lookupOuiVendor("00:11:22:00:00:00", overlay), "Local Vendor");
});

test("OUI overlay performs exact lookups without iterating or copying the bundled registry", () => {
  class LookupOnlyMap extends Map {
    [Symbol.iterator]() { throw new Error("Bundled registry must not be enumerated per MAC batch"); }
  }
  const bundled = new LookupOnlyMap([["001122", "IEEE Vendor"], ["001122A", "IEEE Suballocation"]]);
  const custom = new Map([["001122", "Local Vendor"]]);
  const overlay = createOuiIndexOverlay(bundled, custom);

  assert.equal(lookupOuiVendor("00:11:22:AA:BB:CC", overlay), "IEEE Suballocation");
  assert.equal(lookupOuiVendor("00:11:22:00:00:00", overlay), "Local Vendor");
});
