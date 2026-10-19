import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyDailyStatisticsAccumulator, normalizeLegacyDailyStatistics } from "../src/core/legacy-daily-statistics.js";

test("legacy daily statistics normalize counts and sort without mixing other observation kinds", () => {
  const rows = normalizeLegacyDailyStatistics([
    { id: "later", kind: "daily_stats", observedAt: "2026-10-16T00:00:00.000Z", payload: { date: "2026-10-16", totalDevices: "30", newDevices: -2, vendorsCount: 4.9 } },
    { id: "ignored", kind: "history_loads", observedAt: "2026-10-15T00:00:00.000Z", payload: { date: "2026-10-15" } },
    { id: "earlier", kind: "daily_stats", observedAt: "2026-10-15T00:00:00.000Z", payload: { date: "2026-10-15", totalDevices: 20, newDevices: 3, roomsCount: 5, devicesWithAddress: 19, devicesWithRoom: 18 } },
  ]);
  assert.deepEqual(rows, [
    { id: "earlier", date: "2026-10-15", observedAt: "2026-10-15T00:00:00.000Z", totalDevices: 20, newDevices: 3, vendorsCount: 0, roomsCount: 5, devicesWithAddress: 19, devicesWithRoom: 18 },
    { id: "later", date: "2026-10-16", observedAt: "2026-10-16T00:00:00.000Z", totalDevices: 30, newDevices: 0, vendorsCount: 4, roomsCount: 0, devicesWithAddress: 0, devicesWithRoom: 0 },
  ]);
});

test("legacy daily statistics reject invalid dates and non-finite counters", () => {
  const rows = normalizeLegacyDailyStatistics([
    { id: "bad-date", kind: "daily_stats", observedAt: "not-a-date", payload: { date: "2026-02-30", totalDevices: 5 } },
    { id: "fallback", kind: "daily_stats", observedAt: "2026-02-28T00:00:00.000Z", payload: { date: "invalid", totalDevices: Number.POSITIVE_INFINITY, newDevices: "NaN" } },
  ]);
  assert.deepEqual(rows, [{
    id: "fallback", date: "2026-02-28", observedAt: "2026-02-28T00:00:00.000Z",
    totalDevices: 0, newDevices: 0, vendorsCount: 0, roomsCount: 0, devicesWithAddress: 0, devicesWithRoom: 0,
  }]);
});

test("daily-statistics accumulator keeps the latest row per day with bounded date-range state", () => {
  const accumulator = createLegacyDailyStatisticsAccumulator({ fromDate: "2026-10-01", throughDate: "2026-10-30" });
  for (let index = 0; index < 12_000; index += 1) {
    const day = String((index % 30) + 1).padStart(2, "0");
    const date = `2026-10-${day}`;
    accumulator.add({
      id: `row-${String(index).padStart(5, "0")}`,
      kind: "daily_stats",
      observedAt: new Date(Date.UTC(2026, 9, Number(day), 0, Math.floor(index / 30))).toISOString(),
      payload: { date, totalDevices: index },
    });
  }
  accumulator.add({ id: "outside", kind: "daily_stats", observedAt: "2026-10-30T23:59:00.000Z", payload: { date: "2026-09-30", totalDevices: 99_999 } });
  const rows = accumulator.finish();
  assert.equal(rows.length, 30);
  assert.deepEqual(rows.map((row) => row.date), Array.from({ length: 30 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`));
  assert.equal(rows[0].totalDevices, 11_970);
  assert.equal(rows.at(-1).totalDevices, 11_999);
});
