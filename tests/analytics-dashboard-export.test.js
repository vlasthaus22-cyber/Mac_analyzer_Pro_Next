import test from "node:test";
import assert from "node:assert/strict";
import { analyticsDashboardHtml, analyticsDashboardHtmlChunks, analyticsDashboardXlsxSheets, analyticsSummaryXlsxSheets, buildAnalyticsDashboardExportModel } from "../src/core/analytics-dashboard-export.js";

test("Dashboard PNG model includes six KPIs and status-scoped charts from the filtered comparison", async () => {
  const analytics = {
    detailsReady: true,
    dashboardFilters: { status: "changed", query: "switch", manufacturer: "Vendor A", room: "Room 7" },
    kpis: { devices: 500, modified: 12, absent: 3, unchanged: 485, manufacturers: 8, rooms: 22 },
    dashboardFilteredDeviceCount: 12,
    history: { uniqueMacs: 600 },
    churn: [{ mac: "00:11:22:33:44:55", vendor: "Vendor Churn", model: "Router", ip: "10.0.0.9", room: "Room 9", present: 3, disappearances: 2, reappearances: 1, transitions: 3 }],
    dataset: { summary: { uniqueVendors: 5, uniqueRooms: 7 }, roomOccupancy: { uniqueRooms: 6 }, charts: { vendors: [{ label: "Vendor A", value: 9 }, { label: "Vendor B", value: 3 }] } },
    totals: [{ label: "08.10", value: 496 }, { label: "15.10", value: 500 }],
    dashboardExportSummary: {
      fieldChanges: [{ label: "IP", value: 8 }, { label: "Модель", value: 4 }],
      absentVendors: [{ label: "Vendor C", value: 2 }],
    },
  };
  const model = buildAnalyticsDashboardExportModel(analytics);
  assert.equal(model.width, 2000);
  assert.equal(model.height, 1520);
  assert.deepEqual(model.kpis.map(({ key }) => key), ["devices", "modified", "absent", "unchanged", "manufacturers", "rooms"]);
  assert.equal(model.kpis[0].value, "600 / 12", "device KPI displays fleet history alongside the selected-status count");
  assert.equal(model.kpis.find(({ key }) => key === "manufacturers").value, 5);
  assert.equal(model.kpis.find(({ key }) => key === "rooms").value, 6);
  const exportedRows = [];
  for await (const row of analyticsDashboardXlsxSheets(analytics)[0].rows) exportedRows.push(row);
  assert.deepEqual(exportedRows, [["Устройства", "600 / 12"], ["Изменённые", 12], ["Отсутствуют", 3], ["Без изменений", 485], ["Производители", 5], ["Помещения", 6]]);
  assert.match(analyticsDashboardHtml(analytics), /Устройства:<\/strong> 600 \/ 12/);
  assert.equal(model.charts.length, 5);
  assert.equal(model.charts[0].title, "Динамика общего числа устройств");
  assert.deepEqual(model.charts[0].datasets[0].values, [496, 500]);
  assert.equal(model.charts[0].summary, "Было 496, стало 500 (+0.8%)");
  assert.deepEqual(model.charts[1].items, [{ label: "Vendor A", value: 9 }, { label: "Vendor B", value: 3 }]);
  assert.deepEqual(model.charts[2].items, [{ label: "IP", value: 8 }, { label: "Модель", value: 4 }]);
  assert.deepEqual(model.charts[3].items, []);
  assert.equal(model.charts[4].items, analytics.churn, "the export model keeps the compact churn rows instead of cloning the full roster");
  assert.deepEqual([model.charts[4].itemLabel(analytics.churn[0]), model.charts[4].itemValue(analytics.churn[0])], ["00:11:22:33:44:55", 3]);
  const churnRows = [];
  for await (const row of analyticsDashboardXlsxSheets(analytics).at(-1).rows) churnRows.push(row);
  assert.deepEqual(churnRows, [["00:11:22:33:44:55", "Vendor Churn", "Router", "10.0.0.9", "Room 9", 3, 2, 1, 3]]);
  assert.match(analyticsDashboardHtml(analytics), /00:11:22:33:44:55/);
});

test("Dashboard PNG model refuses a partial dashboard before extended calculations finish", () => {
  assert.throws(() => buildAnalyticsDashboardExportModel({ detailsReady: false, kpis: {} }, null), /Дождитесь завершения/);
});

test("Dashboard XLSX streams status-scoped vendor, field and absence sheets", async () => {
  const analytics = {
    detailsReady: true,
    dashboardFilters: { status: "missing" },
    kpis: { devices: 2, modified: 1, absent: 0, unchanged: 1, manufacturers: 2, rooms: 1 },
    dashboardFilteredDeviceCount: 0,
    totals: [{ label: "Final A", value: 5 }, { label: "Final B", value: 2 }],
    dataset: { charts: { vendors: [{ label: "Old Vendor", value: 2 }] } },
    dashboardExportSummary: {
      fieldChanges: [{ label: "IP", value: 3 }],
      absentVendors: [{ label: "Old Vendor", value: 2 }],
    },
  };
  const sheets = analyticsDashboardXlsxSheets(analytics);
  assert.deepEqual(sheets.map(({ name }) => name), ["Показатели", "Итого устройств", "Производители статуса", "Изменения по полям", "Отсутствуют", "MAC churn"]);
  const sheetRows = [];
  for (const sheet of sheets) {
    const rows = [];
    for await (const row of sheet.rows) rows.push(row);
    sheetRows.push(rows);
  }
  assert.deepEqual(sheetRows[0][0], ["Устройства", 0]);
  assert.deepEqual(sheetRows[1], [["Final A", 5], ["Final B", 2]]);
  assert.deepEqual(sheetRows[2], [["Old Vendor", 2]]);
  assert.deepEqual(sheetRows[3], []);
  assert.deepEqual(sheetRows[4], [["Old Vendor", 2]]);
  assert.deepEqual(sheetRows[5], []);
});

test("Dashboard exports keep the fleet timeline global and scope detail charts to each status", () => {
  const totals = [{ label: "Final A", value: 100 }, { label: "Final B", value: 120 }];
  const fieldChanges = [{ label: "IP", value: 2 }];
  const absentVendors = [{ label: "Old Vendor", value: 3 }];
  const churn = [{ mac: "AA:BB:CC:DD:EE:FF", transitions: 4 }];
  const expected = {
    all: { fields: fieldChanges, absent: absentVendors },
    changed: { fields: fieldChanges, absent: [] },
    missing: { fields: [], absent: absentVendors },
    unchanged: { fields: [], absent: [] },
  };
  for (const [status, details] of Object.entries(expected)) {
    const model = buildAnalyticsDashboardExportModel({
      detailsReady: true,
      dashboardFilters: { status },
      dashboardFilteredDeviceCount: 10,
      kpis: { devices: 120, modified: 2, absent: 3, unchanged: 115, manufacturers: 5, rooms: 6 },
      totals,
      churn,
      dataset: { charts: { vendors: [{ label: `${status} vendor`, value: 1 }] } },
      dashboardExportSummary: { fieldChanges, absentVendors },
    });
    assert.deepEqual(model.charts.find((chart) => chart.key === "chart:totals").datasets[0].values, [100, 120], `${status} keeps the full fleet trend`);
    assert.deepEqual(model.charts.find((chart) => chart.key === "chart:vendors").items, [{ label: `${status} vendor`, value: 1 }], `${status} receives its status-specific vendor ranking`);
    assert.deepEqual(model.charts.find((chart) => chart.key === "chart:fields").items, details.fields, `${status} gets only applicable field changes`);
    assert.deepEqual(model.charts.find((chart) => chart.key === "chart:absent-vendors").items, details.absent, `${status} gets only applicable missing vendors`);
    assert.equal(model.charts.find((chart) => chart.key === "chart:presence-churn").items, churn, `${status} retains the complete presence-churn series without cloning it`);
  }
});

test("analytics workbook streams complete counts and source-compatible top 50 models across pages", async () => {
  const ranked = {
    vendor: Array.from({ length: 205 }, (_, index) => ({ value: `Vendor ${String(index).padStart(3, "0")}`, count: 205 - index })),
    model: Array.from({ length: 52 }, (_, index) => ({ value: `Model ${String(index).padStart(2, "0")}`, count: 100 - index })),
    room: [...Array.from({ length: 57 }, (_, index) => ({ value: `Room ${String(index).padStart(2, "0")}`, count: 57 - index })), { value: "Без помещения", count: 900 }],
    switch: Array.from({ length: 53 }, (_, index) => ({ value: `10.0.0.${index + 1}`, count: 53 - index })),
  };
  const calls = new Map();
  const analytics = {
    detailsReady: true,
    dataset: {
      clusters: { queryId: "analytics:current" },
      summary: {
        devices: 1000, knownVendors: 900, withModel: 850, withAddress: 800, withRoom: 700,
        withIp: 750, withSwitch: 600, withSwitchPort: 550,
        uniqueVendors: 205, uniqueModels: 52, uniqueRooms: 59, uniqueSwitches: 53,
      },
      coverage: { port: { count: 550 } },
      roomOccupancy: { uniqueRooms: 57 },
    },
  };
  async function readRankedPage(queryId, metric, { after = null, limit }) {
    assert.equal(queryId, "analytics:current");
    const rows = ranked[metric] || [];
    const start = after?.offset || 0;
    const pageRows = rows.slice(start, start + limit);
    const nextOffset = start + pageRows.length;
    calls.set(metric, (calls.get(metric) || 0) + 1);
    return { rows: pageRows, total: rows.length, hasMore: nextOffset < rows.length, nextCursor: nextOffset < rows.length ? { offset: nextOffset } : null };
  }
  const sheets = analyticsSummaryXlsxSheets(analytics, readRankedPage, { pageSize: 20 });
  assert.deepEqual(sheets.map(({ name }) => name), ["Общая статистика", "Производители", "Модели", "Помещения", "Коммутаторы", "Заполненность полей"]);
  const rows = {};
  for (const sheet of sheets) {
    rows[sheet.name] = [];
    for await (const row of sheet.rows) rows[sheet.name].push(row);
  }
  assert.deepEqual(rows["Общая статистика"].slice(0, 4), [
    ["Всего устройств", 1000],
    ["С определенным производителем", "900 (90.0%)"],
    ["С определенной моделью", "850 (85.0%)"],
    ["С физическим адресом", "800 (80.0%)"],
  ]);
  assert.deepEqual(rows["Общая статистика"][10], ["Уникальных помещений", 57]);
  assert.deepEqual(rows["Общая статистика"][9], ["Уникальных моделей", 52]);
  assert.equal(rows["Производители"].length, 205);
  assert.deepEqual(rows["Производители"][0], ["Vendor 000", 205, "20.5%"]);
  assert.equal(rows["Модели"].length, 50);
  assert.deepEqual(rows["Модели"][0], ["Model 00", 100, "10.0%"]);
  assert.deepEqual(rows["Модели"].at(-1), ["Model 49", 51, "5.1%"]);
  assert.equal(rows["Помещения"].length, 57);
  assert.equal(rows["Коммутаторы"].length, 53);
  assert.equal(rows["Заполненность полей"].length, 7);
  assert.ok(calls.get("vendor") > 1, "the complete vendor sheet must cross aggregate pages");
  assert.ok(calls.get("model") > 1, "the complete model sheet must cross aggregate pages");
  assert.ok(calls.get("room") > 1, "the complete room sheet must cross aggregate pages");
});

test("analytics XLSX rejects incomplete aggregate paging rather than exporting a partial workbook", async () => {
  const analytics = { detailsReady: true, dataset: { clusters: { queryId: "analytics:stale" }, summary: { devices: 1 } } };
  const sheets = analyticsSummaryXlsxSheets(analytics, async () => ({ rows: [{ value: "Acme", count: 1 }], total: 2, hasMore: false, nextCursor: null }));
  await assert.rejects(async () => {
    const output = [];
    for await (const row of sheets[1].rows) output.push(row);
    return output;
  }, /Рейтинг «vendor» неполон/);
});

test("Dashboard HTML contains all KPI and chart rows and escapes imported labels", () => {
  const analytics = {
    detailsReady: true,
    dashboardFilters: { status: "all" },
    kpis: { devices: 2, modified: 1, absent: 0, unchanged: 1, manufacturers: 2, rooms: 1 },
    totals: [{ label: "Final & A", value: 5 }],
    dataset: { charts: { vendors: [{ label: "Vendor & A", value: 2 }] } },
    dashboardExportSummary: {
      fieldChanges: [{ label: "<script>alert(1)</script>", value: 3 }],
      absentVendors: [{ label: "Vendor & A", value: 1 }],
    },
  };
  const html = analyticsDashboardHtml(analytics, "2026-10-16T12:00:00Z");
  assert.match(html, /Создано: <time>2026-10-16T12:00:00Z<\/time>/);
  assert.match(html, /Устройства:<\/strong> 2/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Final &amp; A/);
  assert.match(html, /Изменения по полям/);
  assert.match(html, /Отсутствующие устройства по производителям/);
  assert.match(html, /Исчезающие и возвращающиеся MAC/);
  assert.match(html, /Vendor &amp; A/);
});

test("Dashboard HTML chunks preserve the complete document without accumulating high-cardinality rows", () => {
  const churn = Array.from({ length: 100_000 }, (_, index) => ({ mac: `02:00:00:${String(index >> 16).padStart(2, "0")}:${String(index >> 8 & 255).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`, transitions: index % 7 }));
  const analytics = {
    detailsReady: true,
    dashboardFilters: { status: "all" },
    kpis: { devices: churn.length, modified: 0, absent: 0, unchanged: churn.length, manufacturers: 1, rooms: 1 },
    churn,
  };
  const chunks = analyticsDashboardHtmlChunks(analytics, "2026-10-16T12:00:00Z");
  let count = 0;
  let maxChunkLength = 0;
  for (const chunk of chunks) {
    count += 1;
    maxChunkLength = Math.max(maxChunkLength, chunk.length);
  }
  assert.equal(count, churn.length + 23);
  assert.ok(maxChunkLength < 2_000, `expected row-level output chunks, got ${maxChunkLength} characters`);

  const small = { ...analytics, churn: churn.slice(0, 2) };
  assert.equal(Array.from(analyticsDashboardHtmlChunks(small, "2026-10-16T12:00:00Z")).join(""), analyticsDashboardHtml(small, "2026-10-16T12:00:00Z"));
});

test("PNG, HTML and XLSX apply the saved KPI and chart visibility choices", async () => {
  const analytics = {
    detailsReady: true,
    dashboardFilters: { status: "all" },
    kpis: { devices: 10, modified: 2, absent: 1, unchanged: 7, manufacturers: 3, rooms: 4 },
    totals: [{ label: "Final A", value: 10 }],
    dataset: { charts: { vendors: [{ label: "Vendor A", value: 5 }] } },
    dashboardExportSummary: { fieldChanges: [{ label: "IP", value: 2 }], absentVendors: [{ label: "Vendor B", value: 1 }] },
  };
  const settings = { widgets: { "kpi:devices": false, "chart:totals": false, "chart:fields": false, "chart:presence-churn": false } };
  const model = buildAnalyticsDashboardExportModel(analytics, settings);
  assert.deepEqual(model.kpis.map(({ key }) => key), ["modified", "absent", "unchanged", "manufacturers", "rooms"]);
  assert.deepEqual(model.charts.map(({ key }) => key), ["chart:vendors", "chart:absent-vendors"]);

  const html = analyticsDashboardHtml(analytics, "2026-10-16T12:00:00Z", settings);
  assert.doesNotMatch(html, /Устройства:<\/strong>/);
  assert.doesNotMatch(html, /Динамика общего числа устройств/);
  assert.match(html, /Топ производителей выбранного статуса/);
  assert.doesNotMatch(html, /Изменения по полям/);

  const sheets = analyticsDashboardXlsxSheets(analytics, settings);
  assert.deepEqual(sheets.map(({ name }) => name), ["Показатели", "Производители статуса", "Отсутствуют"]);
});
