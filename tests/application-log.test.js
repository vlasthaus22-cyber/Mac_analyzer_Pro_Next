import test from "node:test";
import assert from "node:assert/strict";
import { appendApplicationLog, normalizeApplicationLogEntry, APPLICATION_LOG_LIMIT } from "../src/core/application-log.js";

test("application log accepts only safe event codes, error names, and timestamps", () => {
  assert.deepEqual(normalizeApplicationLogEntry({ event: "ui_error", errorName: "QuotaExceededError", timestamp: "2026-10-15T10:00:00Z" }), {
    event: "ui_error", errorName: "QuotaExceededError", timestamp: "2026-10-15T10:00:00Z",
  });
  assert.equal(normalizeApplicationLogEntry({ event: "ui_error: workbook has device values", timestamp: "2026-10-15T10:00:00Z" }), null);
  assert.equal(normalizeApplicationLogEntry({ event: "ui_error", errorName: "Workbook data: ...", timestamp: "2026-10-15T10:00:00Z" }), null);
  assert.equal(normalizeApplicationLogEntry({ event: "ui_error", timestamp: "invalid" }), null);
});

test("application log retains only the latest fixed-size set of structured events", () => {
  const records = Array.from({ length: APPLICATION_LOG_LIMIT }, (_, index) => ({
    event: "ui_error", errorName: "Error", timestamp: new Date(1_800_000_000_000 + index).toISOString(),
  }));
  const result = appendApplicationLog(records, { event: "ui_error", errorName: "AbortError", timestamp: "2026-10-15T12:00:00Z" });
  assert.equal(result.length, APPLICATION_LOG_LIMIT);
  assert.equal(result.at(-1).errorName, "AbortError");
  assert.equal(Object.hasOwn(result.at(-1), "message"), false);
  assert.equal(Object.hasOwn(result.at(-1), "details"), false);
});
