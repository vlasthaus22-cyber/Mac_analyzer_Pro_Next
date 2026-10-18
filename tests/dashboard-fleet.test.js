import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardFleetSeries } from "../src/core/dashboard-fleet.js";

test("Dashboard fleet drilldown aligns filtered full-Final totals with snapshot dates and changes", () => {
  const analytics = {
    history: { uniqueMacs: 12 },
    kpis: { devices: 5 },
    totals: [
      { label: "Final A", value: 8 },
      { label: "Final B", value: 10 },
      { label: "Final C", value: 5 },
    ],
  };
  const fleet = buildDashboardFleetSeries(analytics, [
    { id: "c", name: "Final C", createdAt: "2026-10-03T00:00:00Z" },
    { id: "a", name: "Final A", createdAt: "2026-10-01T00:00:00Z" },
    { id: "b", name: "Final B", createdAt: "2026-10-02T00:00:00Z" },
  ]);
  assert.deepEqual(fleet, {
    uniqueMacs: 12,
    latestCount: 5,
    series: [
      { id: "a", name: "Final A", date: "2026-10-01T00:00:00Z", count: 8, delta: null },
      { id: "b", name: "Final B", date: "2026-10-02T00:00:00Z", count: 10, delta: 2 },
      { id: "c", name: "Final C", date: "2026-10-03T00:00:00Z", count: 5, delta: -5 },
    ],
  });
});

test("Dashboard fleet drilldown falls back to KPI total when no snapshot totals exist", () => {
  assert.deepEqual(buildDashboardFleetSeries({ kpis: { devices: 3 }, history: { uniqueMacs: 4 } }), {
    uniqueMacs: 4,
    latestCount: 3,
    series: [],
  });
});
