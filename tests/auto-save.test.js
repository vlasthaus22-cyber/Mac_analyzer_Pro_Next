import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_SAVE_INTERVAL_MS, autoSaveXlsxFilename } from "../src/core/auto-save.js";

test("Final autosave interval matches the reference five-minute schedule", () => {
  assert.equal(AUTO_SAVE_INTERVAL_MS, 5 * 60 * 1000);
});

test("Final autosave names are safe, dated and distinct by caller-provided token", () => {
  const date = new Date(2026, 9, 17, 12, 34, 56, 7);
  const first = autoSaveXlsxFilename(date, "a1b2c3d4e5f6");
  const second = autoSaveXlsxFilename(date, "102030405060");
  assert.equal(first, "autosave_20261017_123456_007_a1b2c3d4e5f6.xlsx");
  assert.notEqual(first, second);
  assert.match(first, /^[a-z0-9_-]+\.xlsx$/);
  assert.throws(() => autoSaveXlsxFilename(date, "../unsafe"), /уникальный безопасный суффикс/);
});
