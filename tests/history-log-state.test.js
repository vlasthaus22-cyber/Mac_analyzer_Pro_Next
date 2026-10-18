import test from "node:test";
import assert from "node:assert/strict";
import { historyLogNeedsRefresh } from "../src/core/history-log-state.js";

test("history log refreshes before its first load and after IndexedDB revision changes", () => {
  assert.equal(historyLogNeedsRefresh({}, 0), true);
  assert.equal(historyLogNeedsRefresh({ initialized: true, loaded: false, loadedRevision: 0 }, 0), true);
  assert.equal(historyLogNeedsRefresh({ initialized: true, loaded: true, loadedRevision: 4 }, 5), true);
});

test("history log keeps its rendered page while the backing revision is unchanged", () => {
  assert.equal(historyLogNeedsRefresh({ initialized: true, loaded: true, loadedRevision: 5 }, 5), false);
});
