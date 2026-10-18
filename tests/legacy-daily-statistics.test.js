import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLegacyDailyStatistics } from "../src/core/legacy-daily-statistics.js";

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
