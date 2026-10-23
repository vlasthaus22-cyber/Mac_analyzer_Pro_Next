import test from "node:test";
import assert from "node:assert/strict";
import { selectTemporalSnapshotWindow, TemporalStatisticsAccumulator, temporalPeriodKey, temporalStatisticsCsv, temporalStatisticsCsvChunks } from "../src/core/temporal-statistics.js";

test("temporal CSV generator preserves output bytes and yields periods incrementally", () => {
  const result = { periods: [
    { period: "2026-01-01", periodType: "day", snapshotCount: 1, sources: ["main.csv"], snapshots: [{ name: "Final 1", id: "s1", deviceCount: 10, processingTimeMs: 12 }] },
    { period: "2026-01-02", periodType: "day", snapshotCount: 1, sources: ["room.xlsx"], snapshots: [{ name: "Final 2", id: "s2", deviceCount: 12, processingTimeMs: 18 }] },
  ] };
  const chunks = temporalStatisticsCsvChunks(result);
  const header = chunks.next();
  const firstPeriod = chunks.next();
  const secondPeriod = chunks.next();

  assert.match(header.value, /^"Период"/);
  assert.match(firstPeriod.value, /^\r\n"2026-01-01"/);
  assert.match(firstPeriod.value, /"Final 1 \(10, 12 ms\)"/);
  assert.match(secondPeriod.value, /^\r\n"2026-01-02"/);
  assert.equal(chunks.next().done, true);
  assert.equal([...temporalStatisticsCsvChunks(result)].join(""), temporalStatisticsCsv(result));
});

test("temporal snapshot windows include the exact preset cutoff and sort chronologically", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  const make = (daysAgo, id) => ({ id, createdAt: new Date(now - daysAgo * 86_400_000).toISOString() });
  const snapshots = [make(0, "today"), make(31, "outside-30"), make(30, "cutoff-30"), make(91, "outside-90"), make(90, "cutoff-90"), make(366, "outside-365"), make(365, "cutoff-365"), { id: "invalid", createdAt: "bad-date" }];
  const originalOrder = snapshots.map(({ id }) => id);
  assert.deepEqual(selectTemporalSnapshotWindow(snapshots, { rangeDays: 30, now }).map(({ id }) => id), ["cutoff-30", "today"]);
  assert.deepEqual(selectTemporalSnapshotWindow(snapshots, { rangeDays: 90, now }).map(({ id }) => id), ["cutoff-90", "outside-30", "cutoff-30", "today"]);
  assert.deepEqual(selectTemporalSnapshotWindow(snapshots, { rangeDays: 365, now }).map(({ id }) => id), ["cutoff-365", "outside-90", "cutoff-90", "outside-30", "cutoff-30", "today"]);
  const ascending = [...snapshots].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  assert.deepEqual(
    selectTemporalSnapshotWindow(ascending, { rangeDays: 365, now, snapshotsAscending: true }),
    selectTemporalSnapshotWindow(snapshots, { rangeDays: 365, now }),
  );
  assert.deepEqual(selectTemporalSnapshotWindow(snapshots, { rangeDays: 45, now }).map(({ id }) => id), ["cutoff-30", "today"], "unsupported ranges normalize to the reference 30-day default");
  assert.deepEqual(snapshots.map(({ id }) => id), originalOrder, "window selection must not reorder stored metadata");
  assert.throws(() => selectTemporalSnapshotWindow([], { rangeDays: 30, now: NaN }), /корректная дата/);
});

test("temporal period keys use UTC calendar days, ISO weeks, and months", () => {
  assert.equal(temporalPeriodKey("2026-01-01T23:30:00-02:00", "day"), "2026-01-02");
  assert.equal(temporalPeriodKey("2025-12-31T12:00:00Z", "week"), "2026-W01");
  assert.equal(temporalPeriodKey("2026-01-31T23:59:00Z", "month"), "2026-01");
  assert.throws(() => temporalPeriodKey("2026-01-01", "year"), /Период/);
});

test("temporal accumulator groups snapshots, deduplicates MACs, and compares adjacent periods", async () => {
  const stats = new TemporalStatisticsAccumulator("day");
  await stats.startSnapshot({ id: "s1", name: "Final 1", createdAt: "2026-04-01T08:00:00Z", deviceCount: 2, processingTimeMs: 1250, sourceFiles: [{ name: "main.csv" }] });
  await stats.observeChunk([{ mac: "—", macFormatted: "AA:BB:CC:00:00:01", manufacturer: "Acme", room: "101" }]);
  await stats.observeChunk([{ mac: "AA:BB:CC:00:00:02", manufacturer: "Other", room: "102" }]);
  await stats.startSnapshot({ id: "s2", name: "Final 2", createdAt: "2026-04-01T18:00:00Z", deviceCount: 3, sourceFiles: [{ name: "smartroom.xlsx" }] });
  await stats.observeChunk([{ mac: "aa-bb-cc-00-00-01", manufacturer: "ACME", room: "101" }, { mac: "AA:BB:CC:00:00:03", manufacturer: "Acme", room: "103" }]);
  await stats.startSnapshot({ id: "s3", name: "Final 3", createdAt: "2026-04-02T08:00:00Z", deviceCount: 1 });
  await stats.observeChunk([{ mac: "AABB.CC00.0003", manufacturer: "Acme", room: "103" }]);

  const result = await stats.finish();
  assert.equal(result.summary.periods, 2);
  assert.equal(result.summary.snapshots, 3);
  assert.equal(result.summary.uniqueMacs, 3);
  assert.equal(result.summary.deviceTotal, 6);
  assert.equal(result.summary.latestDeviceCount, 1);
  assert.equal(result.summary.maxDevices, 3);
  assert.deepEqual(result.periods.map((row) => [row.uniqueMacs, row.added, row.removed]), [[3, 3, 0], [1, 0, 2]]);
  assert.equal(result.periods[0].snapshotCount, 2);
  assert.equal(result.periods[0].snapshots[0].processingTimeMs, 1250);
  assert.equal(result.periods[0].vendors, 2);
  assert.equal(result.periods[0].rooms, 3);
  assert.deepEqual(result.periods[0].sources, ["main.csv", "smartroom.xlsx"]);
  assert.match(temporalStatisticsCsv(result), /Период/);
  assert.match(temporalStatisticsCsv(result), /Final 2/);
});

test("temporal accumulator groups day, ISO-week and month boundaries", async () => {
  for (const [period, expected] of [["day", ["2025-12-31", "2026-01-01"]], ["week", ["2026-W01"]], ["month", ["2025-12", "2026-01"]]]) {
    const stats = new TemporalStatisticsAccumulator(period);
    for (const [index, createdAt] of ["2025-12-31T12:00:00Z", "2026-01-01T12:00:00Z"].entries()) {
      await stats.startSnapshot({ id: `boundary-${index}`, createdAt, deviceCount: 1 });
      await stats.observeChunk([{ mac: index ? "AA:BB:CC:00:00:02" : "AA:BB:CC:00:00:01" }]);
    }
    const result = await stats.finish();
    assert.deepEqual(result.periods.map(({ period: key }) => key), expected, `${period} groups must match UTC calendar boundaries`);
    assert.equal(result.summary.snapshots, 2);
  }
});

test("temporal accumulator rejects chunks without an active snapshot", async () => {
  const stats = new TemporalStatisticsAccumulator();
  await assert.rejects(stats.observeChunk([{ mac: "AA:BB:CC:00:00:01" }]), /Сначала начните/);
});

test("temporal statistics filter every snapshot before totals, vendors, rooms and MAC transitions", async () => {
  const stats = new TemporalStatisticsAccumulator("day", { deviceMatches: (device) => device.manufacturer === "Acme" });
  await stats.startSnapshot({ id: "s1", name: "Final 1", createdAt: "2026-04-01T08:00:00Z", deviceCount: 2 });
  await stats.observeChunk([
    { mac: "AA:BB:CC:00:00:01", manufacturer: "Acme", room: "101" },
    { mac: "AA:BB:CC:00:00:02", manufacturer: "Other", room: "102" },
  ]);
  stats.endSnapshot();
  await stats.startSnapshot({ id: "s2", name: "Final 2", createdAt: "2026-04-02T08:00:00Z", deviceCount: 3 });
  await stats.observeChunk([
    { mac: "AA:BB:CC:00:00:01", manufacturer: "Acme", room: "101" },
    { mac: "AA:BB:CC:00:00:03", manufacturer: "Acme", room: "103" },
    { mac: "AA:BB:CC:00:00:04", manufacturer: "Other", room: "104" },
  ]);
  stats.endSnapshot();
  const result = await stats.finish();
  assert.equal(result.summary.deviceTotal, 3);
  assert.equal(result.summary.latestDeviceCount, 2);
  assert.equal(result.summary.maxDevices, 2);
  assert.equal(result.summary.uniqueMacs, 2);
  assert.deepEqual(result.periods.map((row) => [row.deviceTotal, row.maxDevices, row.latestDeviceCount, row.uniqueMacs, row.added]), [[1, 1, 1, 1, 1], [2, 2, 2, 2, 1]]);
  assert.deepEqual(result.periods.map((row) => row.snapshots[0].deviceCount), [1, 2]);
});
