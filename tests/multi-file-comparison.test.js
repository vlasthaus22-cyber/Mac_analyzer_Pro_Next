import test from "node:test";
import assert from "node:assert/strict";
import { allPairwiseCsv, comparisonRows, pairwiseComparisonPairs, selectMultiFileComparisonFields } from "../src/core/multi-file-comparison.js";
import { compareFinals } from "../src/core/comparison.js";

test("multi-file comparison creates every directed pair for two through ten files", () => {
  assert.deepEqual(pairwiseComparisonPairs(2).map(({ id }) => id), ["0:1", "1:0"]);
  assert.equal(pairwiseComparisonPairs(10).length, 90);
  assert.throws(() => pairwiseComparisonPairs(1), /не менее двух/);
  assert.throws(() => pairwiseComparisonPairs(11), /не более 10/);
});

test("all-pair export retains pair names and ambiguous identity diagnostics", () => {
  const pair = { file1: "before.csv", file2: "after.csv" };
  const result = { comparison: {
    added: [{ mac: "AA:BB:CC:00:00:03", ip: "10.0.0.3" }],
    absent: [{ mac: "AA:BB:CC:00:00:01", room: "101" }],
    modified: [{ before: { mac: "AA:BB:CC:00:00:02", ip: "10.0.0.1" }, after: { mac: "AA:BB:CC:00:00:02", ip: "10.0.0.2" }, changes: [{ label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.2" }] }],
    unchanged: [],
    ambiguous: [{ after: { mac: "AA:BB:CC:00:00:04" }, candidates: [{ mac: "AA:BB:CC:00:00:05" }] }],
  } };
  const rows = comparisonRows(pair, result);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.file1 === pair.file1 && row.file2 === pair.file2));
  const csv = allPairwiseCsv([{ pair, result }]);
  assert.match(csv, /before\.csv/);
  assert.match(csv, /Неоднозначно/);
  assert.match(csv, /Сильные идентификаторы конфликтуют/);
});

test("multi-file field selection applies defaults and can report OUI changes separately", () => {
  const before = [{ id: "stable", mac: "00:11:22:33:44:55", manufacturer: "Old", model: "A", ip: "10.0.0.1", room: "101" }];
  const after = [{ id: "stable", mac: "00:11:23:33:44:55", manufacturer: "New", model: "B", ip: "10.0.0.2", room: "102" }];
  const raw = compareFinals(before, after);
  const defaults = selectMultiFileComparisonFields(raw, { mac: true, oui: true });
  assert.deepEqual(defaults.modified[0].changes.map((change) => change.field).sort(), ["mac", "oui"]);
  const all = selectMultiFileComparisonFields(raw, { mac: true, oui: true, vendor: true, model: true, ip: true, room: true });
  assert.deepEqual(all.modified[0].changes.map((change) => change.field).sort(), ["ip", "mac", "manufacturer", "model", "oui", "room"]);
});
