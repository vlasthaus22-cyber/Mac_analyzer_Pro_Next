import test from "node:test";
import assert from "node:assert/strict";
import { FINAL_SNAPSHOT_TYPE, isFinalSnapshot, resolveSnapshotType, SINGLE_ANALYSIS_SNAPSHOT_TYPE } from "../src/core/snapshot-kind.js";

test("snapshot type keeps single-file analyses out of Final selectors and recognizes legacy names", () => {
  assert.equal(resolveSnapshotType("", "Single file: inventory.csv"), SINGLE_ANALYSIS_SNAPSHOT_TYPE);
  assert.equal(isFinalSnapshot({ name: "Single file: old.csv" }), false);
  for (const name of ["Final main.csv", "Анализ: main.csv", "Analysis: main.csv"]) {
    assert.equal(isFinalSnapshot({ name }), true, name);
  }
  assert.equal(isFinalSnapshot({ name: "Scheduled task: queue.csv" }), false);
  assert.equal(isFinalSnapshot({ name: "Scheduled task: queue.csv", snapshotType: FINAL_SNAPSHOT_TYPE }), true);
  assert.equal(isFinalSnapshot({ snapshotType: FINAL_SNAPSHOT_TYPE, name: "Single file: retained as Final" }), true);
  assert.equal(isFinalSnapshot({ snapshotType: SINGLE_ANALYSIS_SNAPSHOT_TYPE, name: "Final: not a Final" }), false);
  assert.throws(() => resolveSnapshotType("preview", "file.csv"), /Неизвестный тип снимка/);
});
