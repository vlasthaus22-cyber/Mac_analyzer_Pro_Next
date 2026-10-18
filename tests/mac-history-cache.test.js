import test from "node:test";
import assert from "node:assert/strict";
import { readMacHistoryCache, writeMacHistoryCache } from "../src/core/mac-history-cache.js";

test("MAC history cache keeps recent entries and evicts the oldest entry at its cap", () => {
  const cache = new Map();
  const first = [{ id: "first" }];
  const second = [{ id: "second" }];
  const third = [{ id: "third" }];
  assert.equal(writeMacHistoryCache(cache, "a", first, 1, { maxEntries: 2 }), true);
  assert.equal(writeMacHistoryCache(cache, "b", second, 1, { maxEntries: 2 }), true);
  assert.equal(readMacHistoryCache(cache, "a"), first);
  assert.equal(writeMacHistoryCache(cache, "c", third, 1, { maxEntries: 2 }), true);
  assert.equal(readMacHistoryCache(cache, "a"), first);
  assert.equal(readMacHistoryCache(cache, "b"), null);
  assert.equal(readMacHistoryCache(cache, "c"), third);
});

test("MAC history cache refuses oversized source histories and oversized event results", () => {
  const cache = new Map();
  assert.equal(writeMacHistoryCache(cache, "many-source-events", [], 11, { maxEvents: 10 }), false);
  assert.equal(writeMacHistoryCache(cache, "many-output-events", Array.from({ length: 11 }, () => ({})), 1, { maxEvents: 10 }), false);
  assert.equal(cache.size, 0);
});
