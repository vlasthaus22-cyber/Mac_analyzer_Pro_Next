import test from "node:test";
import assert from "node:assert/strict";
import { buildModelPrefixAnalytics, compileMacModelRules, countMac5Occurrences, createMac5OccurrenceCollector, createModelPrefixAnalyticsCollector, lookupMacModel, modelPrefixAnalyticsXlsxSheets, normalizeMacPrefix } from "../src/core/model-knowledge.js";

test("MAC model rules normalize separators and prefer the most specific prefix", () => {
  assert.equal(normalizeMacPrefix("00:11:22:33"), "00112233");
  assert.deepEqual(lookupMacModel("00:11:22:33:44:55", new Map([
    ["00112233", "Generic model"],
    ["00:11:22:33:44", "Specific model"],
  ])), { model: "Specific model", prefix: "0011223344" });
});

test("invalid or placeholder model rules are not considered evidence", () => {
  assert.equal(normalizeMacPrefix("001122"), "001122");
  assert.equal(lookupMacModel("00:11:22:33:44:55", new Map([["00112233", "—"]])), null);
  assert.equal(lookupMacModel("invalid", new Map([["00112233", "Model"]])), null);
});

test("compiled MAC model rules use exact prefix maps and learned rules override built-ins", () => {
  const index = compileMacModelRules(new Map([
    ["00:11:22:33", "Learned generic"],
    ["0011223344", "Learned specific"],
    ["00112233", "Custom Catalyst"],
    ["001122", "Local Catalyst"],
  ]), { includeBuiltins: true });

  assert.deepEqual(lookupMacModel("00:11:22:33:44:55", index), { model: "Learned specific", prefix: "0011223344" });
  assert.deepEqual(lookupMacModel("00:11:22:AA:BB:CC", index), { model: "Local Catalyst", prefix: "001122" });
  assert.deepEqual(lookupMacModel("00:11:22:33:AA:BB", index), { model: "Custom Catalyst", prefix: "00112233" });
  assert.deepEqual(lookupMacModel("AA:BB:CC:DD:EE:FF", index), null);
});

test("model prefix analytics searches exact or partial model names and reports rule sources", () => {
  const result = buildModelPrefixAnalytics("catalyst 2960", [], [
    { mac: "00:11:22:33:44:55", model: "Other", manufacturer: "Cisco" },
    { mac: "00:11:22:AA:BB:CC", model: "catalyst 2960", manufacturer: "Acme" },
    { mac: "00:11:22:44:44:66", model: "Unknown", manufacturer: "Other" },
  ]);
  assert.equal(result.prefixes.length, 1);
  assert.deepEqual(result.prefixes[0], {
    prefix: "00112233", model: "Cisco Catalyst 2960", source: "Встроенная база", formattedPrefix: "00:11:22:33",
  });
  assert.deepEqual(result.metrics, { prefixes: 1, matchedDevices: 2, vendors: 2 });
});

test("custom model prefix overrides the built-in rule for the same prefix", () => {
  const result = buildModelPrefixAnalytics("Conference", [{ prefix: "00:11:22:33", model: "Conference Kit", source: "Пользовательское правило" }], [
    { mac: "00:11:22:33:44:55", model: "Cisco Catalyst 2960", manufacturer: "Cisco" },
  ]);
  assert.deepEqual(result.prefixes.map(({ prefix, model, source }) => ({ prefix, model, source })), [
    { prefix: "00112233", model: "Conference Kit", source: "Пользовательское правило" },
  ]);
  assert.equal(result.metrics.matchedDevices, 1);
});

test("model prefix analytics accepts chunks without retaining the matched device roster", () => {
  const devices = [
    { mac: "00:11:22:33:44:55", model: "Other", manufacturer: "Cisco" },
    { mac: "00:11:22:AA:BB:CC", model: "catalyst 2960", manufacturer: "Acme" },
    { mac: "00:11:22:44:44:66", model: "Unknown", manufacturer: "Other" },
  ];
  const collector = createModelPrefixAnalyticsCollector("catalyst 2960");
  collector.accept(devices.slice(0, 1));
  collector.accept(devices.slice(1));
  assert.deepEqual(collector.finish(), buildModelPrefixAnalytics("catalyst 2960", [], devices));
});

test("MAC5 occurrence collector counts every matching Final appearance across chunks", () => {
  const collector = createMac5OccurrenceCollector([
    { prefix: "00:11:22:33:44" }, { prefix: "AABBCCDDEE" }, { prefix: "00112233" },
  ]);
  collector.accept([
    { mac: "00:11:22:33:44:55" }, { macFormatted: "00:11:22:33:44:66" }, { mac: "invalid" },
  ]);
  collector.accept([
    { mac_formatted: "AA:BB:CC:DD:EE:FF" }, { mac: "00:11:22:AA:BB:CC" },
  ]);
  assert.deepEqual([...collector.finish()], [["0011223344", 2], ["AABBCCDDEE", 1], ["00112233", 2]]);
});

test("MAC5 occurrence count reads every Final sequentially and combines its chunks", async () => {
  const reads = [];
  const counts = await countMac5Occurrences([
    { prefix: "00:11:22:33:44" }, { prefix: "AA:BB:CC:DD:EE" },
  ], [{ id: "final-1" }, { id: "final-2" }], async (id, visit) => {
    reads.push(id);
    for (const chunk of id === "final-1"
      ? [[{ mac: "00:11:22:33:44:55" }], [{ mac: "AA:BB:CC:DD:EE:FF" }]]
      : [[{ macFormatted: "00:11:22:33:44:66" }, { mac: "invalid" }]]) visit(chunk);
  });
  assert.deepEqual(reads, ["final-1", "final-2"]);
  assert.deepEqual([...counts], [["0011223344", 2], ["AABBCCDDEE", 1]]);
});

test("model-prefix XLSX sheet exports the exact visible rows and occurrence counts", async () => {
  const [sheet] = modelPrefixAnalyticsXlsxSheets({ prefixes: [
    { prefix: "0011223344", formattedPrefix: "00:11:22:33:44", model: "Board A", source: "History", occurrences: 27 },
  ] });
  assert.equal(sheet.name, "Префиксы модели");
  assert.deepEqual(sheet.headings, ["Префикс (5 байт)", "Форматированный", "Модель", "Источник", "Количество вхождений"]);
  const rows = [];
  for await (const row of sheet.rows) rows.push(row);
  assert.deepEqual(rows, [["0011223344", "00:11:22:33:44", "Board A", "History", 27]]);
});
