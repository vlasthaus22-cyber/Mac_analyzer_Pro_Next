import test from "node:test";
import assert from "node:assert/strict";
import { sqliteImportStageProgress } from "../src/ui/progress.js";

test("SQLite restore progress reports a per-collection percentage from exact row counts", () => {
  assert.deepEqual(sqliteImportStageProgress({
    stage: "restoring",
    recordsProcessed: 250,
    totalRecords: 1_000,
  }), { value: 25, label: "25% этапа" });
});

test("SQLite byte stages report an exact stage percentage", () => {
  for (const stage of ["copying", "checkpointing", "hashing"]) {
    assert.deepEqual(sqliteImportStageProgress({ stage, bytesRead: 64, totalBytes: 256 }), {
      value: 25,
      label: "25% этапа",
    });
  }
});

test("SQLite stages without a known total remain indeterminate instead of showing false progress", () => {
  assert.deepEqual(sqliteImportStageProgress({ stage: "mapping", recordsRead: 500 }), {
    value: null,
    label: "Выполняется",
  });
  assert.deepEqual(sqliteImportStageProgress({ stage: "staging", recordsProcessed: 500, totalRecords: 0 }), {
    value: null,
    label: "Выполняется",
  });
  assert.deepEqual(sqliteImportStageProgress({ stage: "restoring", recordsProcessed: 0, totalRecords: 0 }), {
    value: null,
    label: "Выполняется",
  });
});

test("SQLite stage percentages stay within zero and one hundred", () => {
  assert.equal(sqliteImportStageProgress({ stage: "validating", recordsProcessed: -10, totalRecords: 10 }).value, 0);
  assert.equal(sqliteImportStageProgress({ stage: "restoring", recordsProcessed: 20, totalRecords: 10 }).value, 100);
});
