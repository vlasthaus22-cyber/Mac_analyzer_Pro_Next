export const DASHBOARD_KPI_WIDGETS = Object.freeze([
  Object.freeze({ key: "kpi:devices", label: "Устройства" }),
  Object.freeze({ key: "kpi:modified", label: "Изменённые" }),
  Object.freeze({ key: "kpi:absent", label: "Отсутствуют" }),
  Object.freeze({ key: "kpi:unchanged", label: "Без изменений" }),
  Object.freeze({ key: "kpi:manufacturers", label: "Производители" }),
  Object.freeze({ key: "kpi:rooms", label: "Помещения" }),
]);

export const DASHBOARD_CHART_WIDGETS = Object.freeze([
  Object.freeze({ key: "chart:totals", label: "Общее число устройств" }),
  Object.freeze({ key: "chart:vendors", label: "Топ производителей выбранного статуса" }),
  Object.freeze({ key: "chart:fields", label: "Изменения по полям" }),
  Object.freeze({ key: "chart:absent-vendors", label: "Отсутствующие устройства по производителям" }),
  Object.freeze({ key: "chart:presence-churn", label: "Исчезающие и возвращающиеся MAC" }),
]);

const DEFAULT_WIDGETS = Object.freeze(Object.fromEntries(
  [...DASHBOARD_KPI_WIDGETS, ...DASHBOARD_CHART_WIDGETS].map(({ key }) => [key, true]),
));

export const DEFAULT_ANALYTICS_DASHBOARD_SETTINGS = Object.freeze({
  autoRefresh: false,
  refreshIntervalSeconds: 60,
  comparisonMode: "snapshots",
  comparisonDateFrom: "",
  comparisonDateTo: "",
  filters: Object.freeze({ query: "", manufacturer: "", room: "", status: "all" }),
  widgets: DEFAULT_WIDGETS,
});

export const MIN_ANALYTICS_REFRESH_SECONDS = 10;
export const MAX_ANALYTICS_REFRESH_SECONDS = 300;

export function normalizeAnalyticsDashboardSettings(value = {}) {
  const rawInterval = Number(value?.refreshIntervalSeconds);
  const refreshIntervalSeconds = Number.isFinite(rawInterval)
    ? Math.min(MAX_ANALYTICS_REFRESH_SECONDS, Math.max(MIN_ANALYTICS_REFRESH_SECONDS, Math.round(rawInterval)))
    : DEFAULT_ANALYTICS_DASHBOARD_SETTINGS.refreshIntervalSeconds;
  return {
    autoRefresh: value?.autoRefresh === true,
    refreshIntervalSeconds,
    comparisonMode: value?.comparisonMode === "period" ? "period" : "snapshots",
    comparisonDateFrom: normalizeDashboardDate(value?.comparisonDateFrom),
    comparisonDateTo: normalizeDashboardDate(value?.comparisonDateTo),
    filters: normalizeDashboardFilters(value?.filters),
    widgets: Object.fromEntries(Object.keys(DEFAULT_WIDGETS).map((key) => [
      key,
      typeof value?.widgets?.[key] === "boolean" ? value.widgets[key] : true,
    ])),
  };
}

function normalizeDashboardDate(value) {
  const date = typeof value === "string" ? value.trim() : "";
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? date : "";
}

export function legacyAnalyticsDashboardSettings(value) {
  let settings = value;
  if (typeof settings === "string") {
    try { settings = JSON.parse(settings); } catch { return null; }
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const visibleCards = settings.visibleCards && typeof settings.visibleCards === "object" && !Array.isArray(settings.visibleCards)
    ? settings.visibleCards : {};
  const visibleCharts = settings.visibleCharts && typeof settings.visibleCharts === "object" && !Array.isArray(settings.visibleCharts)
    ? settings.visibleCharts : {};
  const widgets = {};
  const cardKeys = {
    total: "kpi:devices", changed: "kpi:modified", missing: "kpi:absent",
    unchanged: "kpi:unchanged", vendors: "kpi:manufacturers", rooms: "kpi:rooms",
  };
  for (const [legacyKey, widgetKey] of Object.entries(cardKeys)) {
    if (typeof visibleCards[legacyKey] === "boolean") widgets[widgetKey] = visibleCards[legacyKey];
  }
  const chartKeys = {
    dynamics: "chart:totals",
    vendors: "chart:vendors",
    fields: "chart:fields",
    missing: "chart:absent-vendors",
    presenceChurn: "chart:presence-churn",
  };
  for (const [legacyKey, widgetKey] of Object.entries(chartKeys)) {
    if (typeof visibleCharts[legacyKey] === "boolean") widgets[widgetKey] = visibleCharts[legacyKey];
  }
  return normalizeAnalyticsDashboardSettings({
    autoRefresh: settings.autoRefresh !== false,
    refreshIntervalSeconds: Number(settings.refreshInterval) || 60,
    widgets,
  });
}

export function isDashboardWidgetVisible(settings, key) {
  return settings?.widgets?.[key] !== false;
}
import { normalizeDashboardFilters } from "./dashboard-filter.js";

