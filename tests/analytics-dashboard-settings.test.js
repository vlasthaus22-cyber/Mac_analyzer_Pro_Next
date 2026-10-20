import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ANALYTICS_DASHBOARD_SETTINGS,
  DASHBOARD_CHART_WIDGETS,
  DASHBOARD_KPI_WIDGETS,
  MAX_ANALYTICS_REFRESH_SECONDS,
  isDashboardWidgetVisible,
  legacyAnalyticsDashboardSettings,
  MIN_ANALYTICS_REFRESH_SECONDS,
  normalizeAnalyticsDashboardSettings,
} from "../src/core/analytics-dashboard-settings.js";

test("dashboard auto-refresh settings restore with bounded intervals", () => {
  assert.deepEqual(normalizeAnalyticsDashboardSettings(), DEFAULT_ANALYTICS_DASHBOARD_SETTINGS);
  const minimumInterval = normalizeAnalyticsDashboardSettings({ autoRefresh: true, refreshIntervalSeconds: 10 });
  assert.equal(minimumInterval.autoRefresh, true);
  assert.equal(minimumInterval.refreshIntervalSeconds, MIN_ANALYTICS_REFRESH_SECONDS);
  assert.equal(normalizeAnalyticsDashboardSettings({ autoRefresh: true, refreshIntervalSeconds: 4 }).refreshIntervalSeconds, 10);
  assert.equal(normalizeAnalyticsDashboardSettings({ autoRefresh: true, refreshIntervalSeconds: 999 }).refreshIntervalSeconds, MAX_ANALYTICS_REFRESH_SECONDS);
  assert.equal(normalizeAnalyticsDashboardSettings({ autoRefresh: "false", refreshIntervalSeconds: NaN }).refreshIntervalSeconds, 60);
  assert.equal(normalizeAnalyticsDashboardSettings({ autoRefresh: false }).autoRefresh, false);
  const customized = normalizeAnalyticsDashboardSettings({ widgets: { "kpi:devices": false, "chart:totals": false } });
  assert.equal(isDashboardWidgetVisible(customized, "kpi:devices"), false);
  assert.equal(isDashboardWidgetVisible(customized, "chart:totals"), false);
  assert.equal(isDashboardWidgetVisible(customized, "kpi:modified"), true);
  assert.equal(DASHBOARD_KPI_WIDGETS.length, 6);
  assert.equal(DASHBOARD_CHART_WIDGETS.length, 5);
});

test("legacy Dashboard settings map compatible widgets, filters, and period comparison", () => {
  const restored = legacyAnalyticsDashboardSettings(JSON.stringify({
    autoRefresh: true,
    refreshInterval: 45,
    query: "MAC-101",
    vendor: "Vendor A",
    room: "Conf A",
    status: "changed",
    changeMode: "period",
    changeDateFrom: "2026-01-03",
    changeDateTo: "2026-02-14",
    visibleCards: { total: false, changed: true, missing: false, unchanged: true, vendors: false, rooms: true, missingRoom: false },
    visibleCharts: { dynamics: false, vendors: false, fields: false, missing: false, presenceChurn: false },
  }));
  assert.equal(restored.autoRefresh, true);
  assert.equal(restored.refreshIntervalSeconds, 45);
  assert.deepEqual(restored.filters, { query: "MAC-101", manufacturer: "Vendor A", room: "Conf A", status: "changed" });
  assert.equal(restored.comparisonMode, "period");
  assert.equal(restored.comparisonDateFrom, "2026-01-03");
  assert.equal(restored.comparisonDateTo, "2026-02-14");
  assert.equal(restored.widgets["kpi:devices"], false);
  assert.equal(restored.widgets["kpi:modified"], true);
  assert.equal(restored.widgets["kpi:absent"], false);
  assert.equal(restored.widgets["kpi:manufacturers"], false);
  assert.equal(restored.widgets["chart:totals"], false);
  assert.equal(restored.widgets["chart:vendors"], false);
  assert.equal(restored.widgets["chart:fields"], false);
  assert.equal(restored.widgets["chart:absent-vendors"], false);
  assert.equal(restored.widgets["chart:presence-churn"], false);
  assert.equal(legacyAnalyticsDashboardSettings({ refreshInterval: 0 }).refreshIntervalSeconds, 60);
  assert.equal(legacyAnalyticsDashboardSettings("bad-json"), null);
  assert.equal(legacyAnalyticsDashboardSettings([]), null);
});

test("dashboard comparison selection settings normalize persisted mode and calendar dates", () => {
  const period = normalizeAnalyticsDashboardSettings({ comparisonMode: "period", comparisonDateFrom: "2026-01-03", comparisonDateTo: "2026-02-14" });
  assert.equal(period.comparisonMode, "period");
  assert.equal(period.comparisonDateFrom, "2026-01-03");
  assert.equal(period.comparisonDateTo, "2026-02-14");
  const invalid = normalizeAnalyticsDashboardSettings({ comparisonMode: "period", comparisonDateFrom: "2026-02-31", comparisonDateTo: "invalid" });
  assert.equal(invalid.comparisonMode, "period");
  assert.equal(invalid.comparisonDateFrom, "");
  assert.equal(invalid.comparisonDateTo, "");
});

test("dashboard query, manufacturer, room and status filters persist with bounded normalized values", () => {
  const settings = normalizeAnalyticsDashboardSettings({
    filters: { query: `  ${"x".repeat(600)}  `, manufacturer: "  Vendor A ", room: " Room 12 ", status: "missing" },
  });
  assert.equal(settings.filters.query.length, 500);
  assert.equal(settings.filters.manufacturer, "Vendor A");
  assert.equal(settings.filters.room, "Room 12");
  assert.equal(settings.filters.status, "missing");
  assert.equal(normalizeAnalyticsDashboardSettings({ filters: { status: "bogus" } }).filters.status, "all");
});
