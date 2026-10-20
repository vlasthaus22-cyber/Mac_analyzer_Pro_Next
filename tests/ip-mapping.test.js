import test from "node:test";
import assert from "node:assert/strict";
import { applyIpMapping, createIpMappingAccumulator, createIpMappingDetector, createIpMappingIndex, DEFAULT_IP_ENRICHMENT_SETTINGS, detectIpMappingColumns, detectIpMappingsFromDevices, ipMappingsCsv, normalizeIpEnrichmentSettings, normalizeIpMappings } from "../src/core/ip-mapping.js";

test("IP mapping import suggests switch-IP and address columns but accepts custom headers", () => {
  assert.deepEqual(detectIpMappingColumns(["Device", "NAS-IP", "Location address"]), { switchIndex: 1, addressIndex: 2 });
  assert.deepEqual(detectIpMappingColumns(["Column A", "Column B"]), { switchIndex: -1, addressIndex: -1 });
});

test("IP mapping import infers an unlabeled IP column from the first 20 preview rows", () => {
  const rows = [
    ["Codec A", "10.0.0.1", "Building 1"],
    ["Codec B", "10.0.0.2", "Building 2"],
    ["Codec C", "not an IP", "Building 3"],
  ];
  assert.deepEqual(detectIpMappingColumns(["Device", "Column B", "Building"], rows), { switchIndex: 1, addressIndex: 2 });
  assert.deepEqual(detectIpMappingColumns(["NAS-IP", "Device IP"], rows), { switchIndex: 0, addressIndex: -1 });
  assert.deepEqual(detectIpMappingColumns(["Column A", "Column B"], [
    ["10.0.0.1", "192.0.2.1"],
    ["10.0.0.2", "192.0.2.2"],
  ]), { switchIndex: -1, addressIndex: -1 });
});

test("IP mapping validates exact IPs, normalizes duplicates and only fills blank addresses", () => {
  const rules = normalizeIpMappings([
    { switchIp: "010.0.0.1", address: "bad" },
    { switchIp: "10.0.0.1", address: "Первый" },
    { switchIp: "10.0.0.1", address: "Точный адрес", source: "Файл" },
    { switchIp: "10.0.0.2", address: "Unknown" },
  ]);
  assert.deepEqual(rules, [{ switchIp: "10.0.0.1", address: "Точный адрес", source: "Файл" }]);
  const mapping = new Map(rules.map((item) => [item.switchIp, item]));
  const blank = { switchIp: "10.0.0.1", address: "" };
  assert.equal(applyIpMapping(blank, mapping), true);
  assert.equal(blank.address, "Точный адрес");
  assert.equal(blank.fieldSources.address, "Файл");
  const known = { switchIp: "10.0.0.1", address: "Текущий адрес" };
  assert.equal(applyIpMapping(known, mapping), false);
  assert.equal(known.address, "Текущий адрес");
  assert.match(ipMappingsCsv(rules), /switchIp.*address.*source/);
});

test("IP mapping accumulator deduplicates streamed records and releases its map on finish", () => {
  const accumulator = createIpMappingAccumulator();
  assert.equal(accumulator.accept({ switchIp: "10.0.0.1", address: "Первый", source: "SQLite" }), true);
  assert.equal(accumulator.accept({ switchIp: "10.0.0.2", address: "Unknown" }), false);
  accumulator.acceptMany([
    { switchIp: "010.0.0.1", address: "Невалидный адрес" },
    { switchIp: "10.0.0.1", address: "Последний", source: "SQLite" },
    { switchIp: "10.0.0.3", address: "Комната 3" },
  ]);
  assert.deepEqual(accumulator.finish(), [
    { switchIp: "10.0.0.1", address: "Последний", source: "SQLite" },
    { switchIp: "10.0.0.3", address: "Комната 3", source: "Ручное правило" },
  ]);
  assert.deepEqual(accumulator.finish(), []);
});

test("IP auto-detection adds only unambiguous switch IPs and does not replace rules", () => {
  const detected = detectIpMappingsFromDevices([
    { switchIp: "10.0.0.1", address: "Адрес A" },
    { switchIp: "10.0.0.1", address: "Адрес A" },
    { switchIp: "10.0.0.2", address: "Адрес B" },
    { switchIp: "10.0.0.2", address: "Адрес C" },
    { switchIp: "10.0.0.3", address: "Адрес D" },
  ], [{ switchIp: "10.0.0.3", address: "Ручной адрес" }]);
  assert.deepEqual(detected, [{ switchIp: "10.0.0.1", address: "Адрес A", source: "Автоопределение из активного Final" }]);
});

test("IP mapping detector produces identical results across streamed chunks", () => {
  const devices = [
    { switchIp: "10.0.0.1", address: "Адрес A" },
    { switchIp: "10.0.0.1", address: "Адрес A" },
    { switchIp: "10.0.0.2", address: "Адрес B" },
    { switchIp: "10.0.0.2", address: "Адрес C" },
    { switchIp: "10.0.0.3", address: "Адрес D" },
  ];
  const detector = createIpMappingDetector([{ switchIp: "10.0.0.3", address: "Ручной адрес" }]);
  detector.accept(devices.slice(0, 2));
  detector.accept(devices.slice(2));
  assert.deepEqual(detector.finish(), detectIpMappingsFromDevices(devices, [{ switchIp: "10.0.0.3", address: "Ручной адрес" }]));
});

test("IP enrichment settings normalize PyQt aliases and preserve safe defaults", () => {
  assert.deepEqual(normalizeIpEnrichmentSettings({ enabled: false, partial_match: false, overwrite_existing: true }), {
    enabled: false, partialMatch: false, overwrite: true, historicalAddress: true,
  });
  assert.equal(normalizeIpEnrichmentSettings({ auto_detect_address_by_ip: false }).historicalAddress, false);
  assert.deepEqual(normalizeIpEnrichmentSettings({ partialMatch: "yes", overwrite: 1 }), DEFAULT_IP_ENRICHMENT_SETTINGS);
});

test("automatic IP enrichment uses exact rules first and only unambiguous IPv4 /24 mappings", () => {
  const unambiguous = createIpMappingIndex([
    { switchIp: "10.0.0.1", address: "Room A", source: "Manual" },
    { switchIp: "10.0.0.2", address: "Room A", source: "Imported" },
    { switchIp: "10.0.1.1", address: "Room B", source: "Manual" },
  ], { partialMatch: true });
  const partial = { switchIp: "10.0.0.99", address: "" };
  assert.equal(applyIpMapping(partial, unambiguous, DEFAULT_IP_ENRICHMENT_SETTINGS), true);
  assert.equal(partial.address, "Room A");
  assert.match(partial.fieldSources.address, /частичное совпадение/);
  const exact = { switchIp: "10.0.0.1", address: "" };
  assert.equal(applyIpMapping(exact, unambiguous, DEFAULT_IP_ENRICHMENT_SETTINGS), true);
  assert.equal(exact.fieldSources.address, "Manual");

  const ambiguous = createIpMappingIndex([
    { switchIp: "10.0.0.1", address: "Room A" },
    { switchIp: "10.0.0.2", address: "Room C" },
  ], { partialMatch: true });
  const uncertain = { switchIp: "10.0.0.99", address: "" };
  assert.equal(applyIpMapping(uncertain, ambiguous, DEFAULT_IP_ENRICHMENT_SETTINGS), false);
  assert.equal(uncertain.address, "");
});

test("IP enrichment respects disabled and explicit overwrite settings", () => {
  const mapping = createIpMappingIndex([{ switchIp: "10.0.0.1", address: "Imported Room" }]);
  const known = { switchIp: "10.0.0.1", address: "Source Room" };
  assert.equal(applyIpMapping(known, mapping, { enabled: false, overwrite: true }), false);
  assert.equal(applyIpMapping(known, mapping, { enabled: true, overwrite: false }), false);
  assert.equal(known.address, "Source Room");
  assert.equal(applyIpMapping(known, mapping, { enabled: true, overwrite: true }), true);
  assert.equal(known.address, "Imported Room");
});
