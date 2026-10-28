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

function referencePair(snapshots, settings = {}) {
  const time = (snapshot) => {
    const value = Date.parse(snapshot?.fileCreatedAt || snapshot?.createdAt || snapshot?.created_at || snapshot?.savedAt || "");
    return Number.isFinite(value) ? value : 0;
  };
  const ordered = snapshots.map((snapshot, index) => ({ snapshot, index, time: time(snapshot) }))
    .sort((left, right) => left.time - right.time || left.index - right.index);
  if (!ordered.length) return { baselineId: "", comparisonId: "" };
  if (ordered.length === 1) return { baselineId: ordered[0].snapshot.id, comparisonId: ordered[0].snapshot.id };
  if (settings.comparisonMode !== "period") {
    const requestedIndex = ordered.findIndex(({ snapshot }) => snapshot.id === settings.currentSnapshotId);
    const comparisonIndex = requestedIndex >= 0 ? requestedIndex : ordered.length - 1;
    const comparison = ordered[comparisonIndex];
    const requestedBaseline = ordered.find(({ snapshot }) => snapshot.id === settings.baseSnapshotId && snapshot.id !== comparison.snapshot.id);
    return { baselineId: requestedBaseline?.snapshot.id || ordered[Math.max(0, comparisonIndex - 1)].snapshot.id, comparisonId: comparison.snapshot.id };
  }
  const dayStart = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return date.toISOString().slice(0, 10) === value ? date.getTime() : null;
  };
  const fromTime = dayStart(settings.comparisonDateFrom) ?? -Infinity;
  const toStart = dayStart(settings.comparisonDateTo);
  const toTime = toStart === null ? Infinity : toStart + 86_400_000 - 1;
  const comparison = ordered.filter(({ time }) => time <= toTime).at(-1) || ordered.at(-1);
  const before = ordered.filter(({ snapshot }) => snapshot.id !== comparison.snapshot.id && time(snapshot) <= comparison.time);
  const baseline = before.filter(({ time }) => time >= fromTime && time <= toTime)[0]
    || before.filter(({ time }) => time < fromTime).at(-1) || before.at(-1) || comparison;
  return { baselineId: baseline.snapshot.id, comparisonId: comparison.snapshot.id };
}

test("linear Dashboard snapshot selection matches the canonical sorter for ties, legacy dates, and bounds", () => {
  let seed = 0x4d4143;
  const random = (max) => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed % max;
  };
  const dates = ["2025-12-31T23:59:59Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-10T10:00:00Z", "invalid", "2026-02-01"];
  const modes = ["snapshots", "period"];
  const bounds = [undefined, "2026-01-01", "2026-01-09", "2026-01-10", "invalid"];
  for (let run = 0; run < 200; run += 1) {
    const rows = Array.from({ length: random(60) }, (_, index) => ({
      id: `run-${index}`,
      [random(2) ? "createdAt" : "fileCreatedAt"]: dates[random(dates.length)],
    }));
    const settings = {
      comparisonMode: modes[random(modes.length)],
      currentSnapshotId: random(5) ? `run-${random(60)}` : undefined,
      baseSnapshotId: random(5) ? `run-${random(60)}` : undefined,
      comparisonDateFrom: bounds[random(bounds.length)],
      comparisonDateTo: bounds[random(bounds.length)],
    };
    assert.deepEqual(resolveDashboardSnapshotPair(rows, settings), referencePair(rows, settings));
  }
});

test("Dashboard snapshot selection scans large histories without sort/filter/map copies", () => {
  const rows = Array.from({ length: 100_000 }, (_, index) => ({
    id: `snapshot-${String(index).padStart(6, "0")}`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
  }));
  const source = new Proxy(rows, {
    get(target, property, receiver) {
      if (["map", "sort", "filter"].includes(property)) throw new Error(`unexpected full-array ${String(property)} copy`);
      return Reflect.get(target, property, receiver);
    },
  });
  const result = resolveDashboardSnapshotPair(source, {
    comparisonMode: "period", comparisonDateFrom: "2026-01-02", comparisonDateTo: "2026-01-03",
  });
  assert.deepEqual(result, { baselineId: "snapshot-001440", comparisonId: "snapshot-004319" });
  assert.equal(rows.length, 100_000);
  assert.equal(rows[0].id, "snapshot-000000");
  assert.equal(rows.at(-1).id, "snapshot-099999");
});
