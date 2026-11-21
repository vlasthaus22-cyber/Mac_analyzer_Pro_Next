import test from "node:test";
import assert from "node:assert/strict";
import { assignSourceMapping, effectiveMergeMapping } from "../src/data/importer.js";
import { batchMappingProblems } from "../src/core/batch.js";

test("disabled extras never contribute duplicate columns or imported identities", () => {
  const mapping = { mac: 0, room: 1, deviceId: 2, hostname: 0, id: 0 };
  assert.deepEqual(effectiveMergeMapping("smartroom", mapping), { mac: 0, room: 1, deviceId: 2 });
  assert.deepEqual(batchMappingProblems("smartroom", mapping, { includeExtras: false }), []);
  assert.equal(batchMappingProblems("smartroom", mapping, { includeExtras: true }).length, 1);
  const message = batchMappingProblems("smartroom", { mac: 0, deviceId: 0 }, { headers: ["MAC source"], includeExtras: false })[0];
  assert.match(message, /MAC source: MAC, Device ID/);
});
test("explicit column selection reassigns the column and reports the displaced fields", () => {
  const original = { mac: 0, room: 1, hostname: 2 };
  const result = assignSourceMapping(original, "deviceId", "2");
  assert.deepEqual(result.mapping, { mac: 0, room: 1, deviceId: 2 });
  assert.deepEqual(result.replaced, ["hostname"]);
  assert.equal(original.hostname, 2);
  assert.deepEqual(assignSourceMapping(result.mapping, "deviceId", "").mapping, { mac: 0, room: 1 });
});
test("enabling extras does not invent assignments; disabling discards optional source columns", () => {
  const primary = effectiveMergeMapping("main", { mac: 0, hostname: 1, id: 2 });
  assert.deepEqual(effectiveMergeMapping("main", primary, true), { mac: 0 });
  const manual = assignSourceMapping(primary, "hostname", "1").mapping;
  assert.deepEqual(effectiveMergeMapping("main", manual, true), { mac: 0, hostname: 1 });
  assert.deepEqual(effectiveMergeMapping("main", manual, false), { mac: 0 });
});
