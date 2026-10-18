import test from "node:test";
import assert from "node:assert/strict";
import { runCoalescedTask } from "../src/core/coalesced-task.js";

test("concurrent task requests serialize and schedule one latest-state rerun", async () => {
  const state = { running: false, pending: false };
  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const firstRun = runCoalescedTask(state, async () => {
    calls += 1;
    if (calls === 1) {
      markStarted();
      await firstGate;
    }
  });

  await firstStarted;
  assert.equal(await runCoalescedTask(state, async () => { calls += 1; }), false);
  assert.equal(await runCoalescedTask(state, async () => { calls += 1; }), false);
  assert.equal(calls, 1);
  assert.equal(state.running, true);
  assert.equal(state.pending, true);
  releaseFirst();

  assert.equal(await firstRun, true);
  assert.equal(calls, 2);
  assert.deepEqual(state, { running: false, pending: false });
});

test("a task failure resets the lock and leaves a later request runnable", async () => {
  const state = { running: false, pending: false };
  await assert.rejects(runCoalescedTask(state, async () => { throw new Error("write failed"); }), /write failed/);
  assert.deepEqual(state, { running: false, pending: false });

  let calls = 0;
  assert.equal(await runCoalescedTask(state, async () => { calls += 1; }), true);
  assert.equal(calls, 1);
});
