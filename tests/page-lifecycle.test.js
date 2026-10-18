import test from "node:test";
import assert from "node:assert/strict";
import { cleanupPageHide } from "../src/core/page-lifecycle.js";

test("pagehide cancels current work, invalidates requests, clears timers and stops schedulers", () => {
  const calls = [];
  const cleaned = cleanupPageHide({ persisted: false }, {
    abortActive: () => calls.push("abort"),
    invalidatePending: () => calls.push("invalidate"),
    intervalTimers: [11, 0, 22],
    clearInterval: (timer) => calls.push(`clear:${timer}`),
    stopSchedulers: [() => calls.push("stop-batch"), () => calls.push("stop-legacy")],
  });

  assert.equal(cleaned, true);
  assert.deepEqual(calls, ["abort", "invalidate", "clear:11", "clear:22", "stop-batch", "stop-legacy"]);
});

test("pagehide keeps work intact when the browser stores the page in its back-forward cache", () => {
  const calls = [];
  const cleaned = cleanupPageHide({ persisted: true }, {
    abortActive: () => calls.push("abort"),
    invalidatePending: () => calls.push("invalidate"),
    intervalTimers: [11],
    clearInterval: (timer) => calls.push(`clear:${timer}`),
    stopSchedulers: [() => calls.push("stop")],
  });

  assert.equal(cleaned, false);
  assert.deepEqual(calls, []);
});
