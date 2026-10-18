import test from "node:test";
import assert from "node:assert/strict";
import { applyIpMapping, createIpMappingAccumulator, createIpMappingDetector, detectIpMappingColumns, detectIpMappingsFromDevices, ipMappingsCsv, normalizeIpMappings } from "../src/core/ip-mapping.js";

test("IP mapping import suggests switch-IP and address columns but accepts custom headers", () => {
  assert.deepEqual(detectIpMappingColumns(["Device", "NAS-IP", "Location address"]), { switchIndex: 1, addressIndex: 2 });
  assert.deepEqual(detectIpMappingColumns(["Column A", "Column B"]), { switchIndex: -1, addressIndex: -1 });
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
