import test from "node:test";
import assert from "node:assert/strict";
import { inspectReferenceImportAuditCounts } from "../scripts/reference-import-audit.js";

test("reference import audit matches restore-stage counts with stored collection totals", () => {
  const restoreCounts = new Map([
    ["snapshots", 2],
    ["inventory", 3],
    ["history", 4],
    ["legacyObservations", 5],
    ["settings", 6],
    ["oui", 7],
    ["mac5Models", 8],
    ["dataQualityReports", 9],
    ["legacySmartroomRoomMappings", 10],
  ]);
  const storeCounts = {
    snapshots: 2,
    inventory: 3,
    history: 4,
    legacyObservations: 5,
    settings: 6,
    oui: 7,
    mac5Models: 8,
    dataQualityReports: 9,
    legacySmartroomRoomMappings: 10,
  };
  const result = inspectReferenceImportAuditCounts({
    restoreCounts,
    storeCounts,
    imported: {
      snapshots: 2,
      inventory: 3,
      history: 4,
      legacyObservations: 5,
      settings: 6,
      oui: 7,
      mac5Models: 8,
      dataQualityReports: 9,
      legacySmartroomRoomMappings: 10,
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.exactRestoreChecks.length, 9);
  assert.equal(result.mappedRecordChecks.length, 9);
  assert.ok(result.exactRestoreChecks.every(({ passed }) => passed));
  assert.ok(result.mappedRecordChecks.every(({ passed }) => passed));
});

test("reference import audit catches a store mismatch and unreported stored rows", () => {
  const result = inspectReferenceImportAuditCounts({
    restoreCounts: new Map([["inventory", 2], ["legacyObservations", 3]]),
    storeCounts: { inventory: 1, legacyObservations: 3, oui: 1 },
    imported: { history: 0, legacyObservations: 3 },
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.exactRestoreChecks.filter(({ passed }) => !passed), [
    { collection: "inventory", expected: 2, actual: 1, passed: false },
    { collection: "oui", expected: 0, actual: 1, passed: false },
  ]);
});

test("reference import audit catches malformed counts and mapped totals that were not restored", () => {
  const result = inspectReferenceImportAuditCounts({
    restoreCounts: new Map([["legacyObservations", 1], ["snapshots", "NaN"]]),
    storeCounts: { snapshots: 0, legacyObservations: 1 },
    imported: { history: 0, legacyObservations: 2 },
  });

  assert.equal(result.passed, false);
  assert.equal(result.exactRestoreChecks.find(({ collection }) => collection === "snapshots").passed, false);
  assert.deepEqual(result.mappedRecordChecks.find(({ collection }) => collection === "legacyObservations"), {
    collection: "legacyObservations",
    expected: 2,
    restored: 1,
    passed: false,
  });
});

test("reference import audit compares every SQLite output collection, including settings and specialized records", () => {
  for (const collection of ["settings", "dataQualityReports", "legacySmartroomRoomMappings"]) {
    const result = inspectReferenceImportAuditCounts({
      restoreCounts: new Map([[collection, 2]]),
      storeCounts: { [collection]: 1 },
      imported: { [collection]: 2 },
    });
    assert.equal(result.passed, false, `${collection} store mismatch must fail the complete audit`);
    assert.deepEqual(result.exactRestoreChecks.find(({ collection: name }) => name === collection), {
      collection,
      expected: 2,
      actual: 1,
      passed: false,
    });
    assert.deepEqual(result.mappedRecordChecks.find(({ collection: name }) => name === collection), {
      collection,
      expected: 2,
      restored: 2,
      passed: true,
    });
  }
});
