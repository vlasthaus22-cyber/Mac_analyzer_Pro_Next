import test from "node:test";
import assert from "node:assert/strict";
import { defaultHistoryLogFilters, historyLogNeedsRefresh } from "../src/core/history-log-state.js";

test("history log refreshes before its first load and after IndexedDB revision changes", () => {
  assert.equal(historyLogNeedsRefresh({}, 0), true);
  assert.equal(historyLogNeedsRefresh({ initialized: true, loaded: false, loadedRevision: 0 }, 0), true);
  assert.equal(historyLogNeedsRefresh({ initialized: true, loaded: true, loadedRevision: 4 }, 5), true);
});

test("history log keeps its rendered page while the backing revision is unchanged", () => {
  assert.equal(historyLogNeedsRefresh({ initialized: true, loaded: true, loadedRevision: 5 }, 5), false);
});

test("global history defaults to the same inclusive 30-day window as the PyQt dialog", () => {
  const filters = defaultHistoryLogFilters(new Date(2026, 2, 31, 14, 15, 16));
  assert.deepEqual(filters, { from: "2026-03-01", fromTime: "00:00:00", to: "2026-03-31", toTime: "23:59:59" });
});
