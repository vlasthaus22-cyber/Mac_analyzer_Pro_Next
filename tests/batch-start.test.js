import test from "node:test";
import assert from "node:assert/strict";
import { batchStartPlan, batchQueueProblems } from "../src/core/batch.js";

const pair = (mapping = { mac: 0 }) => ({ main: { file: { name: "main.csv" }, mapping }, reviewed: false, enabled: true });

test("manual start separates valid unreviewed pairs from invalid mappings without approving them", () => {
  const pairs = [pair()];
  assert.deepEqual(batchStartPlan(pairs), { problems: [], enabledCount: 1, needsReview: true, missingSources: {} });
  assert.equal(pairs[0].reviewed, false);
  assert.match(batchQueueProblems(pairs)[0], /подтвердите/);
});

test("start preflight reports duplicate columns, missing identities and excludes disabled cycles", () => {
  const pairs = [pair({ mac: 0, serial: 0 }), pair({}), { ...pair({}), enabled: false }];
  const plan = batchStartPlan(pairs);
  assert.equal(plan.enabledCount, 2);
  assert.equal(plan.problems.length, 2);
  assert.match(plan.problems[0], /нескольких полей/);
  assert.match(plan.problems[1], /MAC/);
  assert.deepEqual(batchStartPlan([]).problems, ["Включите хотя бы один цикл массового объединения"]);
});

test("start warns when selected SmartRoom or DDIO files are not assigned to enabled cycles", () => {
  const pairs = [pair(), { ...pair(), smartroom: { file: { name: "smart.csv" }, mapping: { mac: 0 } }, reviewed: true }];
  assert.deepEqual(batchStartPlan(pairs, { smartroom: 2, ddio: 1 }).missingSources, { smartroom: 1, ddio: 2 });
  pairs[0].enabled = false;
  assert.deepEqual(batchStartPlan(pairs, { smartroom: 2 }).missingSources, { smartroom: 0 });
  assert.equal(batchStartPlan(pairs).needsReview, false);
});
