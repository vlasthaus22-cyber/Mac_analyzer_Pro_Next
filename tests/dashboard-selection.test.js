import test from "node:test";
import assert from "node:assert/strict";
import { resolveDashboardSnapshotPair } from "../src/core/dashboard-selection.js";

const snapshots = [
  { id: "a", fileCreatedAt: "2026-01-01T10:00:00Z" },
  { id: "b", fileCreatedAt: "2026-01-10T10:00:00Z" },
  { id: "c", fileCreatedAt: "2026-01-20T10:00:00Z" },
  { id: "d", fileCreatedAt: "2026-02-02T10:00:00Z" },
];

test("Dashboard snapshot mode keeps explicit selections and falls back to the latest adjacent pair", () => {
  assert.deepEqual(resolveDashboardSnapshotPair(snapshots, { comparisonMode: "snapshots", baseSnapshotId: "a", currentSnapshotId: "c" }), { baselineId: "a", comparisonId: "c" });
  assert.deepEqual(resolveDashboardSnapshotPair(snapshots, { comparisonMode: "snapshots", baseSnapshotId: "missing", currentSnapshotId: "missing" }), { baselineId: "c", comparisonId: "d" });
});

test("Dashboard period mode picks the latest snapshot through the end date and first in-period baseline", () => {
  assert.deepEqual(resolveDashboardSnapshotPair(snapshots, { comparisonMode: "period", comparisonDateFrom: "2026-01-05", comparisonDateTo: "2026-01-31" }), { baselineId: "b", comparisonId: "c" });
  assert.deepEqual(resolveDashboardSnapshotPair(snapshots, { comparisonMode: "period", comparisonDateFrom: "2026-01-11", comparisonDateTo: "2026-01-19" }), { baselineId: "a", comparisonId: "b" });
});

test("Dashboard period mode handles open bounds, invalid dates, and empty histories", () => {
  assert.deepEqual(resolveDashboardSnapshotPair(snapshots, { comparisonMode: "period", comparisonDateFrom: "2026-01-11" }), { baselineId: "c", comparisonId: "d" });
  assert.deepEqual(resolveDashboardSnapshotPair(snapshots, { comparisonMode: "period", comparisonDateTo: "2026-01-15" }), { baselineId: "a", comparisonId: "b" });
  assert.deepEqual(resolveDashboardSnapshotPair([], { comparisonMode: "period" }), { baselineId: "", comparisonId: "" });
});
