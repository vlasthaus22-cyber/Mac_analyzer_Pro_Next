import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_SAVE_INTERVAL_MS, autoSaveXlsxFilename, isAutoSaveDue } from "../src/core/auto-save.js";

test("Final autosave interval matches the reference five-minute schedule", () => {
  assert.equal(AUTO_SAVE_INTERVAL_MS, 5 * 60 * 1000);
});

test("Final autosave catches up after a suspended tab without running early", () => {
  const start = 1_000_000;
  assert.equal(isAutoSaveDue(start, start + AUTO_SAVE_INTERVAL_MS - 1), false);
  assert.equal(isAutoSaveDue(start, start + AUTO_SAVE_INTERVAL_MS), true);
  assert.equal(isAutoSaveDue(start, start + AUTO_SAVE_INTERVAL_MS * 3), true);
  assert.equal(isAutoSaveDue(start, start - 1), false);
  assert.equal(isAutoSaveDue(null, start + AUTO_SAVE_INTERVAL_MS), false);
  assert.equal(isAutoSaveDue("", start + AUTO_SAVE_INTERVAL_MS), false);
  assert.equal(isAutoSaveDue(Number.NaN, start + AUTO_SAVE_INTERVAL_MS), false);
  assert.equal(isAutoSaveDue(start, start + AUTO_SAVE_INTERVAL_MS, 0), false);
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
