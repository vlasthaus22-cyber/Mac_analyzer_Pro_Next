import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectReferenceImportAuditCounts, isImportedSQLiteSettingKey } from "../scripts/reference-import-audit.js";
import { writeReferenceImportCheckpoint } from "../scripts/reference-import-progress.js";

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
    migratedSettingCount: 6,
  });

  assert.equal(result.passed, true);
  assert.equal(result.exactRestoreChecks.length, 9);
  assert.equal(result.mappedRecordChecks.length, 9);
  assert.ok(result.exactRestoreChecks.every(({ passed }) => passed));
  assert.ok(result.mappedRecordChecks.every(({ passed }) => passed));
});

test("checked-in production SQLite audit evidence reproduces every count-only restore check", async () => {
  const evidencePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "reference-sqlite-import-audit-2026-10-27.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.auditVersion, 1);
  assert.equal(evidence.source.filename, "mac_analyzer_web.db");
  assert.equal(evidence.source.bytes, 373_112_832);
  assert.equal(evidence.source.integrity, "ok");
  assert.equal(Date.parse(evidence.source.lastWriteUtc) < Date.parse(evidence.startedAt), true, "source file was not modified after the audited import began");
  assert.equal(evidence.destination, "unique disposable in-memory IndexedDB");
  assert.deepEqual(evidence.skippedRows, {});
  assert.deepEqual(evidence.excludedTables, ["engineering_sessions", "notification_settings"]);

  const result = inspectReferenceImportAuditCounts(evidence.auditInputs);
  assert.equal(result.passed, true);
  assert.deepEqual(result.exactRestoreChecks, evidence.expectedExactRestoreChecks);
  assert.deepEqual(result.mappedRecordChecks, evidence.expectedMappedRecordChecks);
  assert.equal(result.mappedRecordChecks.find(({ collection }) => collection === "inventory").merged, 8);
});

test("v1.0.27 portable archive SQLite import evidence reproduces every full restore check", async () => {
  const evidencePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "reference-sqlite-archive-import-2026-10-29.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.auditVersion, 1);
  assert.equal(evidence.archive.filename, "MAC-Analyzer-Pro-v1.0.27-Complete.zip");
  assert.equal(evidence.source.filename, "mac_analyzer_web.db");
  assert.equal(evidence.source.bytes, 373_112_832);
  assert.equal(evidence.source.integrity, "ok");
  assert.equal(evidence.source.walBytes, 0);
  assert.equal(evidence.destination, "unique disposable in-memory IndexedDB");
  assert.deepEqual(evidence.skippedRows, {});

  const result = inspectReferenceImportAuditCounts({
    restoreCounts: new Map(Object.entries(evidence.auditInputs.restoreCounts)),
    storeCounts: evidence.auditInputs.storeCounts,
    imported: evidence.auditInputs.imported,
    migratedSettingCount: evidence.auditInputs.migratedSettingCount,
  });
  assert.equal(result.passed, true);
  assert.equal(result.exactRestoreChecks.length, 9);
  assert.equal(result.mappedRecordChecks.length, 9);
  assert.ok(result.exactRestoreChecks.every(({ passed }) => passed));
  assert.ok(result.mappedRecordChecks.every(({ passed }) => passed));
});

test("reference import progress checkpoint is atomically replaced with a compact JSON snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mac-analyzer-import-checkpoint-"));
  try {
    const target = writeReferenceImportCheckpoint({ status: "running", lastProgress: { stage: "restoring", processed: 500 } }, directory);
    const first = JSON.parse(await readFile(target, "utf8"));
    assert.deepEqual(first, { status: "running", lastProgress: { stage: "restoring", processed: 500 } });

    writeReferenceImportCheckpoint({ status: "completed", counts: { inventory: 2 } }, directory);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { status: "completed", counts: { inventory: 2 } });
    assert.deepEqual(await readdir(directory), ["reference-sqlite-import-progress.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      ...(collection === "settings" ? { migratedSettingCount: 1 } : {}),
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

test("reference import audit accounts for merged duplicate Inventory IDs and separately counted IP mappings", () => {
  const result = inspectReferenceImportAuditCounts({
    restoreCounts: new Map([[
      "inventory", 100_013,
    ], ["settings", 388]]),
    storeCounts: { inventory: 100_013, settings: 389 },
    imported: { inventory: 100_021, settings: 387, ipAddressMappings: 1 },
    migratedSettingCount: 388,
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.mappedRecordChecks.find(({ collection }) => collection === "inventory"), {
    collection: "inventory",
    expected: 100_021,
    restored: 100_013,
    transformation: "duplicate stable IDs merged",
    merged: 8,
    passed: true,
  });
  assert.deepEqual(result.mappedRecordChecks.find(({ collection }) => collection === "settings"), {
    collection: "settings",
    expected: 388,
    restored: 388,
    passed: true,
  });
});

test("reference import audit rejects Inventory counts that cannot result from duplicate-ID merging", () => {
  const result = inspectReferenceImportAuditCounts({
    restoreCounts: new Map([["inventory", 2]]),
    storeCounts: { inventory: 2 },
    imported: { inventory: 1 },
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.mappedRecordChecks.find(({ collection }) => collection === "inventory"), {
    collection: "inventory",
    expected: 1,
    restored: 2,
    transformation: "duplicate stable IDs merged",
    merged: -1,
    passed: false,
  });
});

test("reference import audit counts only migrated SQLite settings, not native Next settings", () => {
  for (const key of [
    "ipAddressMappings",
    "legacyAppSetting:theme",
    "legacyAutosave:slot1",
    "legacyColumnPreferences:inventory",
    "legacyPerformanceMetric:legacy-metric-1",
  ]) assert.equal(isImportedSQLiteSettingKey(key), true, `${key} is an imported settings key`);
  for (const key of ["activeSnapshotId", "theme", "userPreference:theme", ""]) {
    assert.equal(isImportedSQLiteSettingKey(key), false, `${key} is a native settings key`);
  }
});
