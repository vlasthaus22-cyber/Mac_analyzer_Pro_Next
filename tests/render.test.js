import test from "node:test";
import assert from "node:assert/strict";
import { compareFinals } from "../src/core/comparison.js";
import { absentDevicesPageContent, churnContent, comparisonContent, dashboardAggregateDialogContent, dashboardChangeDeviceGroups, dashboardChangeDeviceGroupsContent, dashboardFleetDialogContent, deviceTable, drawBars, drawFinalChangeTrend, drawFinalTotalsTrend, drawLegacyDailyStatistics, drawWeekly, excelColumnLabel, finalHistoryComparisonDetails, HISTORY_LOG_COLUMNS, historyLogColumnControls, historyLogContent, identityConflictDetails, legacyObservationLogContent, macTimelineAppearancesContent, macTimelineContent, macTimelineSummaryContent, modelPrefixAnalyticsContent, normalizedHistoryLogColumns, paginationSummary, renderKpis, roomAnomalyContent, roomCoverageContent, roomPairComparisonContent, roomTimelineObservationContent, unassignedDevicesContent } from "../src/ui/render.js";

test("Dashboard change details group field events by device and escape context, values and sources", () => {
  const events = [
    { type: "modified", severity: "critical", device: { mac: "00:11:22:33:44:55", model: "<Router>", address: "Floor & 1", room: "R<2>" }, change: { field: "ip", label: "IP", oldValue: "10.0.0.1", newValue: "<script>", source: "Main & CSV" } },
    { type: "modified", severity: "other", device: { mac: "00:11:22:33:44:55", model: "<Router>", address: "Floor & 1", room: "R<2>" }, change: { field: "vendor", label: "Производитель", oldValue: "Old", newValue: "New" } },
    { type: "absent", severity: "critical", device: { mac: "00:11:22:33:44:66", model: "Switch", room: "R3" } },
  ];
  const groups = dashboardChangeDeviceGroups(events);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].changes.length, 2);
  assert.equal(groups[0].severity, "critical");
  const html = dashboardChangeDeviceGroupsContent(events);
  assert.equal((html.match(/<details class="change-device-group">/g) || []).length, 2);
  assert.match(html, /&lt;Router&gt;/);
  assert.match(html, /Floor &amp; 1 · R&lt;2&gt;/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Main &amp; CSV/);
  assert.match(html, /2 пол\./);
  assert.match(html, /severity-critical">Критическое<\/span> IP:/);
  assert.match(html, /severity-other">Другое<\/span> Производитель:/);
  assert.deepEqual(groups[0].changes.map((change) => change.severity), ["critical", "other"]);
  const fieldSource = dashboardChangeDeviceGroupsContent([{
    type: "modified",
    device: { mac: "EE:FF", fieldSources: { model: "Learned model rule" } },
    changes: [{ field: "model", oldValue: "A", newValue: "B" }],
  }]);
  assert.match(fieldSource, /Источник: Learned model rule/);
});

test("Dashboard change groups follow the shared strong identity priority across MAC changes", () => {
  const groups = dashboardChangeDeviceGroups([
    { type: "modified", device: { id: "persistent-1", deviceId: "asset-1", mac: "00:11:22:33:44:55" }, change: { field: "ip", oldValue: "10.0.0.1", newValue: "10.0.0.2" } },
    { type: "modified", device: { id: "persistent-1", deviceId: "asset-1", mac: "AA:BB:CC:DD:EE:FF" }, change: { field: "model", oldValue: "Old", newValue: "New" } },
    { type: "modified", device: { deviceId: "asset-2", serial: "serial-2", mac: "00:11:22:33:44:66" }, change: { field: "ip", oldValue: "10.0.1.1", newValue: "10.0.1.2" } },
    { type: "modified", device: { deviceId: "asset-2", serial: "serial-2", mac: "AA:BB:CC:DD:EE:01" }, change: { field: "model", oldValue: "Old", newValue: "New" } },
    { type: "modified", device: { serial: "serial-3", mac: "00:11:22:33:44:77" }, change: { field: "ip", oldValue: "10.0.2.1", newValue: "10.0.2.2" } },
    { type: "modified", device: { serial: "serial-3", mac: "AA:BB:CC:DD:EE:02" }, change: { field: "model", oldValue: "Old", newValue: "New" } },
    { type: "modified", device: { deviceId: "asset-4", mac: "00:11:22:33:44:55" }, change: { field: "room", oldValue: "A", newValue: "B" } },
  ]);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map((group) => group.changes.length), [2, 2, 2, 1]);
});

test("Dashboard change groups never merge devices using hostname-only evidence", () => {
  const groups = dashboardChangeDeviceGroups([
    { type: "modified", device: { hostname: "switch-a" }, change: { field: "room", oldValue: "101", newValue: "102" } },
    { type: "modified", device: { hostname: "switch-a" }, change: { field: "model", oldValue: "Old", newValue: "New" } },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.changes.length), [1, 1]);
});

test("Excel column labels advance through Z and multiple letters", () => {
  assert.deepEqual([0, 25, 26, 27, 701].map(excelColumnLabel), ["A", "Z", "AA", "AB", "ZZ"]);
  assert.equal(excelColumnLabel(-1), "");
});

test("dashboard fleet dialog pages its history and escapes imported snapshot names", () => {
  const fleet = {
    uniqueMacs: 101,
    latestCount: 50,
    series: Array.from({ length: 101 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
      name: index === 0 ? "<script>alert(1)</script>" : `Final ${index + 1}`,
      count: index + 1,
      delta: index ? 1 : null,
    })),
  };
  const first = dashboardFleetDialogContent(fleet);
  assert.match(first, /Уникальных MAC во всех Final/);
  assert.match(first, /data-dashboard-fleet-page="100"/);
  assert.match(first, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(first, /<script>alert/);
  assert.match(first, /Показано 1–100 из 101/);
  assert.match(first, /<table class="data-table" data-virtual-scroll="true">/);
  const last = dashboardFleetDialogContent(fleet, { offset: 100 });
  assert.match(last, /Показано 101–101 из 101/);
  assert.match(last, /data-dashboard-fleet-page="0"/);
  assert.match(last, /data-dashboard-fleet-page="200" disabled/);
});

test("Dashboard manufacturer and room KPI details page every aggregate and escape labels", () => {
  const items = Array.from({ length: 101 }, (_, index) => ({
    label: index === 0 ? '<img src=x onerror="alert(1)">' : `Room ${index + 1}`,
    value: index + 1,
  }));
  const first = dashboardAggregateDialogContent(items, { field: "room" });
  assert.match(first, /Помещение/);
  assert.match(first, /data-dashboard-aggregate-page="100"/);
  assert.ok(first.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.doesNotMatch(first, /<img src=x/);
  assert.match(first, /1–100 из 101/);
  const last = dashboardAggregateDialogContent(items, { field: "manufacturer", offset: 100 });
  assert.match(last, /Производитель/);
  assert.match(last, /101–101 из 101/);
  assert.match(last, /data-dashboard-aggregate-page="200" disabled/);
});

test("renderKpis accepts a safe display value for the uploads and latest-Final total", () => {
  const container = { innerHTML: "", onclick: null };
  renderKpis(container, { devices: 9 }, {}, null, { devices: "12 / 9" });
  assert.match(container.innerHTML, /<strong>12 \/ 9<\/strong>/);
});

test("pagination summary separates current-page rows from the full result count", () => {
  assert.equal(paginationSummary({ page: 2, pages: 20, items: Array.from({ length: 50 }), total: 973 }), "Страница 2 из 20 · на странице 50 · всего найдено 973");
});

test("legacy observation log renders imported values as escaped selectable rows", () => {
  const html = legacyObservationLogContent([{
    id: "row-<script>", kind: "vendor_model_history", observedAt: "2026-10-15T10:00:00Z", mac: "00:11:22:33:44:55",
    payload: { vendor: "<img src=x onerror=alert(1)>", model: "Model A", source_file: "source.xlsx" },
  }], new Set(["row-<script>"]));
  assert.match(html, /data-legacy-observation-select="row-&lt;script&gt;"/);
  assert.match(html, /checked/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /<table class="data-table" data-virtual-scroll="true">/);
});

test("legacy daily statistics render all imported aggregate counts", () => {
  const html = legacyObservationLogContent([{
    id: "daily-1", kind: "daily_stats", observedAt: "2026-01-06T00:00:00.000Z",
    payload: { date: "2026-01-06", totalDevices: 20, newDevices: 3, vendorsCount: 5, roomsCount: 4, devicesWithAddress: 17, devicesWithRoom: 18 },
  }]);
  assert.match(html, /Daily statistics/);
  assert.match(html, /Устройства: 20 · новые: 3 · производителей: 5 · помещений: 4 · с адресом: 17 · с помещением: 18/);
});

test("legacy task log shows schedule and queue metadata without rendering source file contents", () => {
  const html = legacyObservationLogContent([
    { id: "task-1", kind: "scheduled_tasks", observedAt: "2026-10-15", payload: { name: "Nightly", enabled: true, intervalMinutes: 60, nextRunAt: "2026-10-16T09:00:00Z" } },
    { id: "task-disabled", kind: "scheduled_tasks", observedAt: "2026-10-14", payload: { name: "Manual only", enabled: false, intervalMinutes: 60 } },
    { id: "queue-1", kind: "task_file_queue", observedAt: "2026-10-15", payload: { filename: "main.xlsx", status: "error", taskId: "task-1", contentAvailable: true, error: "invalid workbook", result: { valid: 2, invalid: 1 }, contentBase64: "SECRET FILE BYTES" } },
    { id: "queue-large", kind: "task_file_queue", observedAt: "2026-10-15", payload: { filename: "large.xlsx", status: "pending", taskId: "task-1", contentAvailable: false, contentRetainedInSourceDatabase: true } },
  ]);
  assert.match(html, /Nightly/);
  assert.match(html, /Каждые 60 мин\./);
  assert.match(html, /data-run-legacy-task="task-1"/);
  assert.match(html, /data-run-legacy-task="task-disabled"[^>]*>Запустить очередь/);
  assert.match(html, /data-toggle-legacy-task="task-1"[^>]*>Выключить/);
  assert.match(html, /data-toggle-legacy-task="task-disabled"[^>]*>Включить/);
  assert.match(html, /data-add-legacy-task-files="task-1"[^>]*>Добавить файлы/);
  assert.match(html, /Запустить очередь/);
  assert.match(html, /data-run-legacy-task="task-1"/);
  assert.match(html, /Запустить очередь/);
  assert.match(html, /main\.xlsx/);
  assert.match(html, /файл можно скачать/);
  assert.match(html, /data-download-legacy-task-file="queue-1"/);
  assert.match(html, /data-download-legacy-task-file="queue-large"/);
  assert.match(html, /файл читается из сохранённой SQLite базы/);
  assert.match(legacyObservationLogContent([{ id: "local", kind: "task_file_queue", payload: { filename: "local.xlsx", contentRetainedLocally: true } }]), /файл хранится локально в этом браузере/);
  assert.match(html, /ошибка: invalid workbook/);
  assert.match(html, /устройств: 2; строк с ошибками: 1/);
  assert.doesNotMatch(html, /SECRET FILE BYTES/);
});

test("legacy schedule rows display the exact queue status summary", () => {
  const html = legacyObservationLogContent([
    { id: "task-row", kind: "scheduled_tasks", payload: { id: "task-id", name: "Nightly", intervalMinutes: 60 } },
  ], new Set(), new Map([["task-id", { pending: 3, running: 1, done: 7, error: 2, total: 13 }]]));
  assert.match(html, /очередь: 3 ждёт \/ 7 готово \/ 2 ошибок/);
});

test("ambiguous comparison details compare the incoming row with each candidate safely", () => {
  const result = comparisonContent({
    modified: [], identityConflicts: [], absent: [],
    ambiguous: [{
      after: { id: "incoming-1", deviceId: "D-1", mac: "00:11:22:33:44:55", manufacturer: "<script>alert(1)</script>", room: "Комната A" },
      candidates: [
        { id: "candidate-" + "q".repeat(350), deviceId: "D-1", mac: "00:11:22:33:44:66", manufacturer: "Vendor A", room: "Комната A", address: "x".repeat(350) },
        { id: "candidate-2", deviceId: "D-2", mac: "00:11:22:33:44:77", manufacturer: "Vendor B", model: "Model B" },
      ],
    }],
  });

  assert.match(result, /Соответствие не выбрано/);
  assert.match(result, /Новая запись/);
  assert.match(result, /Кандидат/);
  assert.match(result, /Vendor A/);
  assert.match(result, /Vendor B/);
  assert.match(result, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(result, /показана часть/);
  assert.doesNotMatch(result, /x{301}/);
  assert.doesNotMatch(result, /q{301}/);
  assert.doesNotMatch(result, /<script>alert\(1\)<\/script>/);
});

test("Chart.js renderer validates rows, renders every row and releases prior instances", () => {
  const previousChart = globalThis.Chart;
  const rendered = [];
  class ChartMock {
    constructor(context, config) {
      this.context = context;
      this.config = config;
      this.destroyed = false;
      rendered.push(this);
    }
    destroy() { this.destroyed = true; }
  }
  globalThis.Chart = ChartMock;
  const state = { hidden: true, textContent: "", errors: [], classList: { toggle: (...args) => state.errors.push(args) } };
  const context = {};
  const canvas = { id: "test-chart", hidden: false, getContext: () => context, parentElement: { querySelector: () => state } };
  try {
    assert.equal(drawBars(canvas, [{ label: "Добавлено", value: 3 }, { label: "Отсутствует", value: -2 }]), true);
    assert.deepEqual(rendered[0].config.data.labels, ["Добавлено", "Отсутствует"]);
    assert.deepEqual(rendered[0].config.data.datasets[0].data, [3, -2]);
    assert.equal(canvas.hidden, false);
    assert.equal(state.hidden, true);
    assert.equal(drawWeekly(canvas, [{ label: "Неделя 1", modified: 2, rooms: 1, macs: 3 }]), true);
    assert.equal(rendered[0].destroyed, true);
    assert.equal(rendered[1].config.data.datasets[0].label, "Изменений");
    assert.equal(canvas.title, "Неделя 1: 2 изменений, 1 помещений, 3 MAC");
    assert.equal(drawBars(canvas, []), false);
    assert.equal(rendered[1].destroyed, true);
    assert.equal(state.textContent, "Нет данных для построения графика.");
    assert.equal(state.hidden, false);
    assert.equal(drawBars(canvas, [{ label: "bad", value: Number.NaN }]), false);
    assert.match(state.textContent, /нечисловые значения/);
  } finally {
    if (previousChart === undefined) delete globalThis.Chart;
    else globalThis.Chart = previousChart;
  }
});

test("Chart.js renderer reports an unavailable runtime instead of leaving a blank canvas", () => {
  const previousChart = globalThis.Chart;
  delete globalThis.Chart;
  const state = { hidden: true, textContent: "", classList: { toggle() {} } };
  const canvas = { id: "missing-chart", hidden: false, parentElement: { querySelector: () => state } };
  try {
    assert.equal(drawBars(canvas, [{ label: "One", value: 1 }]), false);
    assert.equal(canvas.hidden, true);
    assert.match(state.textContent, /Chart\.js не загружена/);
  } finally {
    if (previousChart !== undefined) globalThis.Chart = previousChart;
  }
});

test("weekly chart uses reference date ranges, including weeks that cross a year boundary", () => {
  const previousChart = globalThis.Chart;
  let config;
  class ChartMock {
    constructor(_context, value) { config = value; }
    destroy() {}
  }
  globalThis.Chart = ChartMock;
  const state = { hidden: true, textContent: "", classList: { toggle() {} } };
  const canvas = { id: "weekly-range-chart", hidden: false, getContext: () => ({}), parentElement: { querySelector: () => state } };
  try {
    assert.equal(drawWeekly(canvas, [
      { label: "2026-01-05", modified: 2, rooms: 1, macs: 2 },
      { label: "2026-12-28", modified: 3, rooms: 2, macs: 4 },
    ]), true);
    assert.deepEqual(config.data.labels, ["05.01–11.01.2026", "28.12–03.01.2026/2027"]);
    assert.match(canvas.title, /05\.01–11\.01\.2026: 2 изменений/);
    assert.match(canvas.title, /28\.12–03\.01\.2026\/2027: 3 изменений/);
    assert.equal(config.options.plugins.tooltip.callbacks.afterLabel({ dataIndex: 0 }), "Переговорных: 1 · MAC-адресов: 2");
    assert.equal(config.options.plugins.tooltip.callbacks.afterLabel({ dataIndex: 1 }), "Переговорных: 2 · MAC-адресов: 4");
  } finally {
    if (previousChart === undefined) delete globalThis.Chart;
    else globalThis.Chart = previousChart;
  }
});

test("Final presence and device-count charts use the reference line series and total summary", () => {
  const previousChart = globalThis.Chart;
  const previousDocument = globalThis.document;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  const rendered = [];
  class ChartMock {
    constructor(_context, config) { this.config = config; rendered.push(this); }
    destroy() {}
  }
  globalThis.Chart = ChartMock;
  globalThis.document = { body: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => ({
      "--text": "#edf6f7",
      "--muted": "#a9b9bd",
      "--border": "#34464b",
      "--primary": "#43b7c3",
      "--danger": "#ff8b92",
    })[name] || "",
  });
  const makeCanvas = (id) => {
    const state = { hidden: true, textContent: "", classList: { toggle() {} } };
    return { id, hidden: false, getContext: () => ({}), parentElement: { querySelector: () => state } };
  };
  try {
    assert.equal(drawFinalChangeTrend(makeCanvas("presence-line"), [
      { label: "Final 1", added: 0, absent: 0 },
      { label: "Final 2", added: 3, absent: 2 },
    ]), true);
    assert.equal(rendered[0].config.type, "line");
    assert.deepEqual(rendered[0].config.data.labels, ["Final 1", "Final 2"]);
    assert.deepEqual(rendered[0].config.data.datasets.map((dataset) => dataset.label), ["Добавлено", "Отсутствовало"]);
    assert.deepEqual(rendered[0].config.data.datasets.map((dataset) => dataset.data), [[0, 3], [0, -2]]);
    assert.deepEqual(rendered[0].config.data.datasets.map((dataset) => dataset.borderColor), ["#43b7c3", "#ff8b92"]);
    assert.equal(rendered[0].config.options.scales.x.ticks.color, "#a9b9bd");
    assert.equal(rendered[0].config.options.scales.y.grid.color, "#34464b");

    assert.equal(drawFinalTotalsTrend(makeCanvas("totals-line"), [
      { label: "Final 1", value: 10 },
      { label: "Final 2", value: 12 },
    ]), true);
    assert.equal(rendered[1].config.type, "line");
    assert.deepEqual(rendered[1].config.data.datasets[0].data, [10, 12]);
    assert.equal(rendered[1].config.options.plugins.title.text, "Было 10, стало 12 (+20.0%)");

    assert.equal(drawLegacyDailyStatistics(makeCanvas("legacy-daily-statistics"), [
      { date: "2026-10-15", totalDevices: 20, newDevices: 3 },
      { date: "2026-10-16", totalDevices: 24, newDevices: 4 },
    ]), true);
    assert.equal(rendered[2].config.type, "bar");
    assert.deepEqual(rendered[2].config.data.labels, ["2026-10-15", "2026-10-16"]);
    assert.deepEqual(rendered[2].config.data.datasets.map(({ type }) => type), ["line", "bar"]);
    assert.deepEqual(rendered[2].config.data.datasets.map(({ label, data }) => ({ label, data })), [
      { label: "Всего устройств", data: [20, 24] },
      { label: "Новых устройств", data: [3, 4] },
    ]);
  } finally {
    if (previousChart === undefined) delete globalThis.Chart;
    else globalThis.Chart = previousChart;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

test("Dashboard KPI rendering honors the six configurable visibility settings", () => {
  const container = {};
  renderKpis(container, { devices: 4, modified: 1, withoutRoom: 2 }, {}, new Map([["kpi:devices", true], ["kpi:modified", false]]));
  assert.match(container.innerHTML, /data-dashboard-widget-kpi="kpi:devices"/);
  assert.doesNotMatch(container.innerHTML, /data-dashboard-widget-kpi="kpi:modified"/);
  assert.match(container.innerHTML, /data-kpi="withoutRoom"/);
});

test("global history groups the current page by MAC and escapes imported values with device context", () => {
  const html = historyLogContent([
    { mac: "—", timestamp: "2026-01-01T10:00:00Z", type: "modified", label: "Помещение", oldValue: "100", newValue: "101", source: "<file>", device: { macFormatted: "00:11:22:33:44:55", manufacturer: "<vendor>", model: "Board", address: "Site", room: "101" } },
    { mac: "00:11:22:33:44:55", timestamp: "2026-01-02T10:00:00Z", type: "modified", label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.2" },
    { mac: "AA:BB:CC:DD:EE:FF", timestamp: "2026-01-03T10:00:00Z", type: "added", label: "Устройство" },
  ]);
  assert.equal((html.match(/<details class="panel history-log-group"/g) || []).length, 2);
  assert.match(html, /<table class="data-table" data-virtual-scroll="true">/);
  assert.match(html, /Помещение/);
  assert.match(html, /&lt;file&gt;/);
  assert.match(html, /&lt;vendor&gt;/);
  assert.doesNotMatch(html, /<file>/);
  assert.match(historyLogContent([]), /событий нет/);
});

test("global history marks switch-IP changes with escaped DDIO possible-IP guidance", () => {
  const html = historyLogContent([
    { id: 1, mac: "00:11:22:33:44:55", field: "switchIp", label: "IP коммутатора", oldValue: "10.0.0.1", newValue: "10.0.0.2", possibleIps: ["192.0.2.10", "<img src=x>"], possibleIpsTruncated: true },
    { id: 2, mac: "00:11:22:33:44:55", field: "ip", label: "IP устройства", oldValue: "192.0.2.1", newValue: "192.0.2.2", possibleIps: ["192.0.2.10"] },
  ], ["mac", "field"]);
  assert.equal((html.match(/class="ddio-ip-marker"/g) || []).length, 1);
  assert.match(html, /В DDIO указаны возможные IP: 192\.0\.2\.10, &lt;img src=x&gt;, список не полный/);
  assert.match(html, /не изменяет подтверждённый IP устройства/);
  assert.doesNotMatch(html, /<img src=x>/);
});

test("global history column settings retain supported choices and default safely", () => {
  assert.deepEqual(normalizedHistoryLogColumns(["mac", "room", "mac", "unknown"]), ["room", "mac"]);
  assert.deepEqual(normalizedHistoryLogColumns([]), HISTORY_LOG_COLUMNS.map(({ key }) => key));
  const controls = historyLogColumnControls(["mac"]);
  assert.match(controls, /value="mac"[^>]*checked/);
  assert.doesNotMatch(controls, /value="room"[^>]*checked/);
  const table = historyLogContent([{ id: 7, mac: "00:11:22:33:44:55", type: "modified", room: "x" }], ["mac"], new Set(["7"]));
  assert.match(table, /data-history-event-select="7"[^>]*checked/);
  assert.match(table, /data-history-event-row data-history-event-mac="00:11:22:33:44:55"/);
  assert.match(table, /<th>MAC<\/th>/);
  assert.doesNotMatch(table, /<th>Помещение<\/th>/);
});

test("model prefix detail renders counts and escapes imported model and source values", () => {
  const html = modelPrefixAnalyticsContent({
    metrics: { prefixes: 1, matchedDevices: 3, vendors: 2 },
    prefixes: [{ formattedPrefix: "00:11:22:33", model: "<unsafe>", source: "<file>" }],
  });
  assert.match(html, /Устройств в выбранном Final/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /&lt;file&gt;/);
  assert.doesNotMatch(html, /<unsafe>/);
});

test("identity conflict details escape aliases, preserve exact counts and bound preview rows", () => {
  assert.equal(identityConflictDetails([{ field: "room", source: "Main" }]), "");
  const conflicts = Array.from({ length: 25 }, (_, index) => ({
    field: "identity", source: index === 0 ? "<Main>" : "SmartRoom", row: index + 2,
    selected: index === 0 ? "<selected>" : `id-${index}`, alternative: index === 0 ? "<alternative>" : `other-${index}`,
  }));
  const html = identityConflictDetails(conflicts);
  assert.match(html, /Конфликты идентификаторов: 25/);
  assert.match(html, /Показаны первые 20 из 25/);
  assert.equal((html.match(/<tr>/g) || []).length, 21);
  assert.match(html, /&lt;Main&gt;/);
  assert.match(html, /&lt;selected&gt;/);
  assert.match(html, /&lt;alternative&gt;/);
  assert.doesNotMatch(html, /<selected>|<alternative>|<Main>/);
  assert.match(identityConflictDetails(conflicts.slice(0, 1), 500), /Показаны первые 1 из 500/);
});

test("Final history comparison diagnostics show exact unresolved counts and escape bounded identity samples", () => {
  assert.equal(finalHistoryComparisonDetails({ ambiguousCount: 0, identityConflictCount: 0 }), "");
  const html = finalHistoryComparisonDetails({
    ambiguousCount: 2,
    identityConflictCount: 1,
    diagnosticSamplesTruncated: 7,
    diagnosticSamples: [
      { type: "ambiguous", identity: "<current>", candidates: ["<before-a>", "before-b"] },
      { type: "identity-conflict", identity: "current-c", alternatives: ["before-c"] },
    ],
  });
  assert.match(html, /неоднозначных идентичностей 2/);
  assert.match(html, /конфликтов сильных идентификаторов 1/);
  assert.match(html, /&lt;current&gt;/);
  assert.match(html, /&lt;before-a&gt;/);
  assert.match(html, /ещё 7 не показано/);
  assert.doesNotMatch(html, /<current>|<before-a>/);
});

test("comparison details expose ambiguous strong identity candidates safely", () => {
  const html = comparisonContent({ modified: [], ambiguous: [{
    after: { mac: "AA:BB:CC:00:00:01" },
    candidates: [{ mac: "AA:BB:CC:00:00:02" }, { mac: "<unsafe>" }],
  }] });
  assert.match(html, /Неоднозначные соответствия \(1\)/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<unsafe>/);
});

test("comparison details report priority-selected identities and conflicting weaker aliases", () => {
  const html = comparisonContent({
    modified: [],
    ambiguous: [],
    identityConflicts: [{
      after: { id: "stable-1", mac: "00:11:22:33:44:55" },
      selected: { id: "stable-1", mac: "00:11:22:33:44:55" },
      alternative: { id: "stale-2", mac: "00:11:22:33:44:55" },
    }],
  });
  assert.match(html, /Конфликты вторичных идентификаторов \(1\)/);
  assert.match(html, /выбран: stable-1/);
  assert.match(html, /stale-2/);
});

test("comparison detail renders 100 device entries at a time with exact totals and working offsets", () => {
  const modified = Array.from({ length: 205 }, (_, index) => ({
    after: { mac: `00:11:22:33:${String(Math.floor(index / 256)).padStart(2, "0")}:${String(index % 256).padStart(2, "0")}`, room: "Room" },
    changes: [{ label: "Модель", oldValue: "Old", newValue: `Model ${index}` }],
  }));
  const comparison = { modified, ambiguous: [{ after: { mac: "AA:BB:CC:00:00:01" }, candidates: [] }] };
  const first = comparisonContent(comparison, { viewId: "test-view" });
  assert.match(first, /показано 100 из 206/);
  assert.match(first, /Показать следующие 100 из 106 устройств/);
  assert.match(first, /Model 99/);
  assert.doesNotMatch(first, /Model 100/);
  const second = comparisonContent(comparison, { viewId: "test-view", offset: 100 });
  assert.match(second, /показано 200 из 206/);
  assert.match(second, /Model 199/);
  assert.doesNotMatch(second, /Model 99/);
  assert.match(second, /Показать следующие 6 из 6 устройств/);
  const finalPage = comparisonContent(comparison, { viewId: "test-view", offset: 200 });
  assert.match(finalPage, /AA:BB:CC:00:00:01/);
  assert.doesNotMatch(finalPage, /data-comparison-more/);
});

test("absent Final details render bounded device pages with exact totals", () => {
  const absent = Array.from({ length: 205 }, (_, index) => ({
    mac: `00:11:22:33:${String(Math.floor(index / 256)).padStart(2, "0")}:${String(index % 256).padStart(2, "0")}`,
    room: `Room ${index}`,
  }));
  const first = comparisonContent({ absent }, { viewId: "absent-view" });
  assert.match(first, /Отсутствующие устройства · показано 1–100 из 205/);
  assert.match(first, /Room 99/);
  assert.doesNotMatch(first, /Room 100/);
  assert.match(first, /Показать следующие 100 из 105 устройств/);
  const second = comparisonContent({ absent }, { viewId: "absent-view", offset: 100 });
  assert.match(second, /Отсутствующие устройства · показано 101–200 из 205/);
  assert.match(second, /Room 199/);
  assert.doesNotMatch(second, /Room 99/);
  assert.match(second, /Показать следующие 5 из 5 устройств/);
  const last = comparisonContent({ absent }, { viewId: "absent-view", offset: 200 });
  assert.match(last, /Room 204/);
  assert.doesNotMatch(last, /data-comparison-more/);
});

test("streamed absent detail page shows exact range and navigates by offset", () => {
  const html = absentDevicesPageContent({
    devices: [{ mac: "00:11:22:33:44:66", room: "Room A" }],
    total: 205,
    offset: 100,
    limit: 100,
  });
  assert.match(html, /Отсутствующие устройства: <strong>205<\/strong>/);
  assert.match(html, /Показано 101–101 из 205/);
  assert.match(html, /data-analytics-absence-page="0"/);
  assert.match(html, /data-analytics-absence-page="200"/);
  assert.match(html, /Room A/);
});

test("unassigned detail shows exact total, complete summaries, and escaped device rows", () => {
  const html = unassignedDevicesContent({
    count: 2,
    vendors: [{ label: "Vendor <A>", value: 2 }],
    models: [{ label: "Model & One", value: 1 }, { label: "Model Two", value: 1 }],
    devices: [{ mac: "00:11:22:33:44:55", manufacturer: "Vendor <A>", model: "Model & One" }, { mac: "00:11:22:33:44:56", manufacturer: "Vendor <A>", model: "Model Two" }],
  });
  assert.match(html, /Устройств без помещения: <strong>2<\/strong>/);
  assert.match(html, /Vendor &lt;A&gt;<\/span><strong>2<\/strong>/);
  assert.match(html, /Model &amp; One/);
  assert.match(html, /Model Two/);
  assert.match(html, /Список устройств/);
  const paged = unassignedDevicesContent({ count: 103, page: 2, pageCount: 3, devices: [{ mac: "00:11:22:33:44:66" }] });
  assert.match(paged, /Страница 2 из 3/);
  assert.match(paged, /data-unassigned-device-page="1"/);
  assert.match(paged, /data-unassigned-device-page="3"/);
});

test("room coverage shows address and an action to open the room's full snapshot chronology", () => {
  const details = roomCoverageContent([{
    key: "sr:sr-1",
    smartroomId: "SR-1",
    businessUnit: "BU",
    city: "City",
    site: "Site",
    floor: "3",
    room: "Room A",
    address: "Address <1>",
    changedCount: 2,
    deviceCount: 2,
    rosterCount: 2,
    allChanged: true,
  }], true);
  assert.match(details, /Address &lt;1&gt;/);
  assert.match(details, /Открыть хронологию помещения/);
  assert.match(details, /data-open-room-history=/);
  assert.match(details, /2\/2 изменено/);
  assert.match(details, /Загрузить состав Final · 2 устройств/);
  assert.doesNotMatch(details, /data-device-context-row/);
  const page = roomCoverageContent([{
    key: "sr:sr-1", smartroomId: "SR-1", room: "Room A", changedCount: 2, deviceCount: 2, rosterCount: 2, allChanged: true,
  }], true, { "sr:sr-1": { devices: [{ mac: "00:11:22:33:44:55" }], total: 2, page: 1, pageCount: 1 } });
  assert.match(page, /Состав Final · страница 1 из 1 · 2 устройств/);
  assert.match(page, /data-device-field="mac">00:11:22:33:44:55/);
});

test("room chronology explains field changes, additions, removals and keeps the full current roster", () => {
  const room = { smartroomId: "SR-1", room: "Room <A>", address: "Address" };
  const previous = [
    { ...room, id: "a", mac: "00:11:22:33:44:51", ip: "10.0.0.1" },
    { ...room, id: "b", mac: "00:11:22:33:44:52", ip: "10.0.0.2" },
    { ...room, id: "c", mac: "00:11:22:33:44:53", ip: "10.0.0.3" },
  ];
  const current = [
    { ...room, id: "a", mac: "00:11:22:33:44:51", ip: "10.0.1.1" },
    previous[1],
    { ...room, id: "d", mac: "00:11:22:33:44:54", ip: "10.0.0.4" },
  ];
  const comparison = { ...compareFinals(previous, current, "2026-01-02T00:00:00Z"), previousName: "Final 1" };
  const html = roomTimelineObservationContent({ name: "Final 2", createdAt: "2026-01-02T00:00:00Z" }, current, comparison, room);
  assert.match(html, /SR-1 · Room &lt;A&gt; · Address/);
  assert.match(html, /Сравнение с Final 1: изменено 1, добавлено 1, отсутствует 1, без изменений 1/);
  assert.match(html, /IP устройства/);
  assert.match(html, /Добавлены \(1\)/);
  assert.match(html, /Отсутствуют \(1\)/);
  assert.match(html, /Состав комнаты в этом Final/);
  assert.match(html, /10\.0\.1\.1/);
});

test("room chronology renders stable 20-row pages for full rosters and additions", () => {
  const devices = Array.from({ length: 47 }, (_, index) => ({ id: `device-${index}`, mac: `00:11:22:33:44:${String(index).padStart(2, "0")}` }));
  const snapshot = { id: "final-a", name: "Final", createdAt: "2026-01-02T00:00:00Z" };
  const first = roomTimelineObservationContent(snapshot, devices, null, {}, {});
  const second = roomTimelineObservationContent(snapshot, devices, null, {}, { roster: 2 });
  assert.equal((first.match(/data-device-context-row/g) || []).length, 20);
  assert.match(first, /Строки 1–20 из 47/);
  assert.match(first, /data-room-timeline-snapshot="final-a" data-room-timeline-section="roster" data-page="2"/);
  assert.equal((second.match(/data-device-context-row/g) || []).length, 20);
  assert.doesNotMatch(second, /data-device-id="device-19"/);
  assert.match(second, /data-device-id="device-20"/);
  assert.match(second, /data-room-timeline-section="roster" data-page="1"/);

  const comparison = { added: devices, absent: [], modified: [], ambiguous: [], unchanged: [] };
  const firstChanges = roomTimelineObservationContent({ ...snapshot, id: "final-b" }, [], comparison, {}, {});
  const secondChanges = roomTimelineObservationContent({ ...snapshot, id: "final-b" }, [], comparison, {}, { added: 2 });
  assert.equal((firstChanges.match(/data-device-context-row/g) || []).length, 20);
  assert.equal((secondChanges.match(/data-device-context-row/g) || []).length, 20);
  assert.doesNotMatch(secondChanges, /data-device-id="device-19"/);
  assert.match(secondChanges, /data-device-id="device-20"/);
});

test("room chronology bounds modified and identity-diagnostic details to 20 rows", () => {
  const modified = Array.from({ length: 47 }, (_, index) => ({
    before: { id: `device-${index}`, mac: `00:11:22:33:44:${String(index).padStart(2, "0")}`, ip: "10.0.0.1" },
    after: { id: `device-${index}`, mac: `00:11:22:33:44:${String(index).padStart(2, "0")}`, ip: "10.0.0.2" },
    changes: [{ field: "ip", label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.2" }],
  }));
  const comparison = { modified, added: [], absent: [], unchanged: [], ambiguous: [], identityConflicts: [] };
  const snapshot = { id: "final-large-room", name: "Final", createdAt: "2026-01-02T00:00:00Z" };
  const first = roomTimelineObservationContent(snapshot, [], comparison);
  const last = roomTimelineObservationContent(snapshot, [], comparison, {}, { changes: 3 });

  assert.equal((first.match(/<tr><td>00:11:22/g) || []).length, 20);
  assert.match(first, /показано 20 из 47/);
  assert.match(first, /data-room-timeline-section="changes" data-page="2"/);
  assert.equal((last.match(/<tr><td>00:11:22/g) || []).length, 7);
  assert.match(last, /показано 47 из 47/);
  assert.doesNotMatch(last, /data-comparison-more=/);
  assert.match(last, /data-room-timeline-section="changes" data-page="2"/);
});

test("device rows outside Inventory expose accessible context actions and field labels", () => {
  const html = deviceTable([{ id: "d1", mac: "00:11:22:33:44:55", model: "Model A" }]);
  assert.match(html, /data-device-context-row[^>]*data-device-id="d1"[^>]*tabindex="0"/);
  assert.match(html, /data-device-field="mac"/);
  assert.match(html, /data-device-field="model"/);
  assert.match(html, /data-device-column="mac"/);
});

test("Final result tables use the saved visible column order and values", () => {
  const config = { columns: [
    { key: "model", label: "Модель первой", visible: true },
    { key: "rowNumber", label: "№", visible: true },
    { key: "mac", label: "MAC", visible: false },
    { key: "oui3", label: "OUI", visible: true },
    { key: "custom_550e8400-e29b-41d4-a716-446655440000", label: "Инвентарный код", visible: true, custom: true },
  ] };
  const html = deviceTable([{
    id: "d1", mac: "00:11:22:33:44:55", model: "Switch A",
    customFields: { "custom_550e8400-e29b-41d4-a716-446655440000": "Rack 7" },
  }], { columnConfig: config, rowNumberOffset: 200 });
  assert.ok(html.indexOf("Модель первой") < html.indexOf(">№</th>"));
  assert.ok(html.indexOf(">№</th>") < html.indexOf(">OUI</th>"));
  assert.ok(html.indexOf(">OUI</th>") < html.indexOf("Инвентарный код"));
  assert.match(html, /data-device-field="model">Switch A/);
  assert.match(html, /data-device-field="rowNumber">201/);
  assert.match(html, /data-device-field="oui3">00:11:22/);
  assert.match(html, /data-device-field="custom_550e8400-e29b-41d4-a716-446655440000">Rack 7/);
  assert.doesNotMatch(html, /data-device-column="mac"/);
});

test("first room chronology observation is explicitly identified", () => {
  const html = roomTimelineObservationContent({ name: "Final 1", createdAt: "2026-01-01T00:00:00Z" }, [], null, { room: "Room A" });
  assert.match(html, /Первый сохранённый Final для выбранной комнаты/);
  assert.match(html, /Помещение отсутствует в этом Final/);
});

test("room Final comparison shows the two snapshot labels and every change category safely", () => {
  const html = roomPairComparisonContent({
    added: [{ mac: "00:11:22:33:44:51", smartroomId: "SR-1", room: "Room A" }],
    absent: [{ mac: "00:11:22:33:44:52", room: "Room B" }],
    modified: [{ before: { mac: "00:11:22:33:44:53", room: "Room <C>" }, after: { mac: "00:11:22:33:44:53", room: "Room <C>" }, changes: [{ field: "ip", label: "IP устройства", oldValue: "10.0.0.1", newValue: "10.0.0.2" }] }],
    unchanged: [{ mac: "00:11:22:33:44:54" }],
    ambiguous: [{ after: { mac: "00:11:22:33:44:55" }, candidates: [{ mac: "00:11:22:33:44:56" }] }],
  }, { name: "Final 1", createdAt: "2026-01-01T00:00:00Z" }, { name: "Final 2", createdAt: "2026-01-02T00:00:00Z" });
  assert.match(html, /Final 1/);
  assert.match(html, /Final 2/);
  assert.match(html, /Изменено/);
  assert.match(html, /Добавлено/);
  assert.match(html, /Отсутствует/);
  assert.match(html, /Неоднозначно/);
  assert.match(html, /Изменилось всё оборудование<\/span><strong>Не подтверждено · неоднозначных: 1/);
  assert.match(html, /Room &lt;C&gt;/);
  assert.doesNotMatch(html, /Room <C>/);
});

test("room Final comparison explicitly reports full-change coverage and leaves ambiguous matches unconfirmed", () => {
  const snapshots = [{ name: "Before" }, { name: "After" }];
  const allChanged = roomPairComparisonContent({
    added: [{ mac: "00:11:22:33:44:51" }], absent: [], modified: [], unchanged: [], ambiguous: [],
  }, ...snapshots);
  assert.match(allChanged, /Изменилось всё оборудование<\/span><strong>Да<\/strong>/);

  const partial = roomPairComparisonContent({
    added: [], absent: [], modified: [{ before: {}, after: {}, changes: [] }], unchanged: [{}], ambiguous: [],
  }, ...snapshots);
  assert.match(partial, /Изменилось всё оборудование<\/span><strong>Нет<\/strong>/);

  const uncertain = roomPairComparisonContent({
    added: [], absent: [], modified: [], unchanged: [], ambiguous: [{}],
  }, ...snapshots);
  assert.match(uncertain, /Изменилось всё оборудование<\/span><strong>Не подтверждено · неоднозначных: 1/);
});

test("room Final comparison keeps exact totals and pages detail rows by 20", () => {
  const added = Array.from({ length: 45 }, (_, index) => ({ id: `added-${index}`, mac: `00:11:22:33:44:${String(index).padStart(2, "0")}` }));
  const comparison = { added, absent: [], modified: [], unchanged: [], ambiguous: [] };
  const first = roomPairComparisonContent(comparison, { name: "Previous" }, { name: "Current" });
  const second = roomPairComparisonContent(comparison, { name: "Previous" }, { name: "Current" }, 2);
  assert.equal((first.match(/<tr><td>Добавлено<\/td>/g) || []).length, 20);
  assert.match(first, /<span>Добавлено<\/span><strong>45<\/strong>/);
  assert.match(first, /data-room-pair-page data-page="2"/);
  assert.equal((second.match(/<tr><td>Добавлено<\/td>/g) || []).length, 20);
  assert.doesNotMatch(second, /00:11:22:33:44:19/);
  assert.match(second, /00:11:22:33:44:20/);
  assert.match(second, /data-room-pair-page data-page="1"/);
});

test("room chronology compares switch IP and port by serial when a device has no MAC", () => {
  const before = [{ id: "d1", serial: "SN-001", switchIp: "10.0.0.1", switchPort: "Gi1/0/1" }];
  const after = [{ id: "d1", serial: "SN-001", switchIp: "10.0.0.2", switchPort: "Gi1/0/2" }];
  const comparison = compareFinals(before, after, "2026-01-02T00:00:00Z");
  const html = roomPairComparisonContent(comparison, { name: "Final 1" }, { name: "Final 2" });
  assert.equal(comparison.modified.length, 1);
  assert.deepEqual(comparison.modified[0].changes.map(({ field }) => field), ["switchIp", "switchPort"]);
  assert.match(html, /SN-001/);
  assert.match(html, /IP коммутатора: 10\.0\.0\.1 → 10\.0\.0\.2/);
  assert.match(html, /Порт: Gi1\/0\/1 → Gi1\/0\/2/);
});

test("room switch detail shows full IP distribution and safe clickable deviation MACs", () => {
  const html = roomAnomalyContent([{
    room: "Room <A>",
    key: "sr:sr-1",
    smartroomId: "SR-1",
    deviceCount: 3,
    switchCount: 2,
    deviationCount: 1,
    missingSwitchDevices: 1,
    dominantIp: "10.0.0.1",
    switches: { "10.0.0.1": 2, "10.0.0.2": 1 },
    businessUnit: "BU",
    city: "City",
    site: "Site",
    floor: "3",
    address: "Address",
  }], {
    "sr:sr-1": { page: 1, pageCount: 1, total: 3, hasNext: false, devices: [
      { id: "deviation", mac: "00:11:22:33:44:55", switchIp: "10.0.0.2" },
      { id: "missing-switch", mac: "00:11:22:33:44:66", switchIp: "" },
    ] },
  });
  assert.match(html, /Основной IP коммутатора: <strong>10\.0\.0\.1<\/strong>/);
  assert.match(html, /10\.0\.0\.1 — 2<\/span> · <span>10\.0\.0\.2 — 1/);
  assert.match(html, /3 устройств · 2 IP · 1 отклонений · 1 без IP коммутатора/);
  assert.match(html, /href="#search" data-search-mac="00:11:22:33:44:55"/);
  assert.match(html, /<td>Отклонение<\/td>/);
  assert.match(html, /<td>IP не указан<\/td>/);
  assert.equal((html.match(/class="danger-row"/g) || []).length, 1);
  assert.match(html, /Room &lt;A&gt;/);
  assert.match(html, /Устройства 1–3 из 3/);
  assert.match(roomAnomalyContent([{ key: "room", deviceCount: 103, room: "Room", switches: {} }]), /Загрузить полный состав · 103 устройств/);
  assert.match(roomAnomalyContent([{ key: "room", deviceCount: 103, room: "Room", switches: {} }], { room: { loading: true } }), /Загрузка состава/);
  assert.doesNotMatch(roomAnomalyContent([{ key: "room", deviceCount: 103, room: "Room", switches: {} }]), /data-device-context-row/);
});

test("MAC timeline renders every device field and highlights only confirmed changes", () => {
  const html = macTimelineContent([{
    date: "2026-01-02T00:00:00Z",
    status: "changed",
    before: { id: "device-1" },
    after: { id: "device-1", deviceId: "ID-1", authenticationTime: "2026-01-02T00:00:00Z", address: "<Office>" },
    changes: [{ field: "address", label: "Адрес", oldValue: "Old", newValue: "<Office>" }],
  }]);
  assert.match(html, /Внутренний ID/);
  assert.match(html, /Device ID/);
  assert.match(html, /Время аутентификации/);
  assert.match(html, /class="changed-value">&lt;Office&gt;/);
  assert.match(html, /02\.01\.2026, 00:00:00 UTC/);
  assert.doesNotMatch(html, /class="changed-value">ID-1/);
  assert.match(html, /Было в предыдущем Final «Final»/);
  assert.match(html, /Стало в новом Final «Final»/);
  assert.match(html, /<details class="timeline-card mac-timeline-item mac-timeline-changed">/);
  assert.match(html, /<summary title="Открыть полную информацию о событии">/);
});

test("MAC timeline labels and escapes imported SQLite observations separately from changes", () => {
  const html = macTimelineContent([{
    date: "2026-10-15T12:00:00Z", status: "observation", snapshotName: "SQLite · mac_history",
    source: "Импорт <legacy>", after: { mac: "00:11:22:33:44:55", room: "<Room>" }, changes: [],
  }]);
  assert.match(html, /Наблюдение SQLite/);
  assert.match(html, /SQLite · mac_history/);
  assert.match(html, /Импорт &lt;legacy&gt;/);
  assert.match(html, /&lt;Room&gt;/);
  assert.match(html, /mac-timeline-observed/);
  assert.doesNotMatch(html, /class="mac-timeline-item mac-timeline-changed/);
});

test("MAC timeline summary counts appearances, distinct sources, and saved movements without absences or ambiguity", () => {
  const html = macTimelineSummaryContent([
    { date: "2026-01-01T00:00:00Z", snapshotId: "one", status: "first", snapshotName: "Main A", changes: [] },
    { date: "2026-01-02T00:00:00Z", snapshotId: "two", status: "changed", snapshotName: "Main B", changes: [{ field: "model", oldValue: "A", newValue: "B", historyEventIds: ["10", "11"] }] },
    { date: "2026-01-03T00:00:00Z", status: "observation", source: "DDIO import", changes: [] },
    { date: "2026-01-04T00:00:00Z", status: "absent", snapshotName: "Absent final", changes: [] },
    { date: "2026-01-05T00:00:00Z", status: "ambiguous", candidates: [{ mac: "AA:BB:CC:DD:EE:FF" }], changes: [] },
  ]);
  assert.match(html, /Событий<\/span><strong>5<\/strong>/);
  assert.match(html, /Выгрузок<\/span><strong>3<\/strong>/);
  assert.match(html, /Первое появление<\/span><strong>01\.01\.2026, 00:00:00 UTC<\/strong>/);
  assert.match(html, /Последнее появление<\/span><strong>03\.01\.2026, 00:00:00 UTC<\/strong>/);
  assert.match(html, /Источников<\/span><strong>3<\/strong>/);
  assert.match(html, /Изменений<\/span><strong>1<\/strong>/);
});

test("MAC appearance table renders only appearance rows with all reference columns and escapes imported data", () => {
  const html = macTimelineAppearancesContent([
    { date: "2026-01-01T00:00:00Z", status: "first", snapshotName: "Main <A>", after: { manufacturer: "<Acme>", model: "Switch", ip: "10.0.0.1", address: "HQ", room: "101", smartroomId: "room-1" } },
    { date: "2026-01-02T00:00:00Z", status: "absent", snapshotName: "Absent", before: { model: "Switch" } },
    { date: "2026-01-03T00:00:00Z", status: "changed", snapshotName: "Main B", after: { model: "New" } },
    { date: "2026-01-04T00:00:00Z", status: "changed", historyOnly: true, snapshotName: "History only", after: { model: "History" } },
  ]);
  assert.match(html, /<th>Дата<\/th><th>Выгрузка<\/th><th>Производитель<\/th><th>Модель<\/th><th>IP<\/th><th>Адрес<\/th><th>Помещение<\/th><th>Smartroom ID<\/th>/);
  assert.match(html, /Main &lt;A&gt;/);
  assert.match(html, /&lt;Acme&gt;/);
  assert.doesNotMatch(html, /Absent|History only/);
  assert.match(html, /Появления 1–2 из 2/);
  assert.equal((html.match(/<tr>/g) || []).length, 3);
  const secondPage = macTimelineAppearancesContent([
    { date: "2026-01-01T00:00:00Z", status: "first", snapshotName: "Main A", after: { model: "Older" } },
    { date: "2026-01-02T00:00:00Z", status: "present", snapshotName: "Main B", after: { model: "Newer" } },
  ], { page: 2, pageSize: 1 });
  assert.match(secondPage, /Появления 2–2 из 2/);
  assert.match(secondPage, /Older/);
  assert.doesNotMatch(secondPage, /Newer/);
});

test("MAC timeline shows explicit Final names and count of merged saved events", () => {
  const html = macTimelineContent([{
    date: "2026-01-02T00:00:00Z", status: "changed", snapshotName: "Current <Final>", previousSnapshotName: "Previous Final",
    before: { model: "A" }, after: { model: "B" },
    changes: [{ field: "model", label: "Модель", oldValue: "A", newValue: "B", historyEventIds: ["1", "2"] }],
  }]);
  assert.match(html, /Previous Final/);
  assert.match(html, /Current &lt;Final&gt;/);
  assert.match(html, /сохранённых событий: 2/);
  assert.match(html, /Полная информация/);
});

test("MAC timeline orders events chronologically and shows elapsed time between snapshots", () => {
  const html = macTimelineContent([
    { date: "2026-01-02T00:00:00Z", status: "present", after: { mac: "AA:BB:CC:DD:EE:FF" }, changes: [] },
    { date: "2026-01-01T00:00:00Z", status: "first", after: { mac: "AA:BB:CC:DD:EE:FF" }, changes: [] },
  ]);
  assert.ok(html.indexOf("01.01.2026") < html.indexOf("02.01.2026"));
  assert.match(html, /Интервал: 1 дн\. 0 ч/);
  assert.match(html, /class="mac-timeline-marker"/);
});

test("MAC timeline displays duplicate-identity diagnostics", () => {
  const html = macTimelineContent([{ date: "2026-01-02T00:00:00Z", status: "ambiguous", candidates: [{ mac: "AA:BB:CC:DD:EE:FF", deviceId: "one" }, { mac: "AA:BB:CC:DD:EE:FF", serial: "two" }], changes: [] }]);
  assert.match(html, /Неоднозначно: MAC найден у нескольких устройств/);
  assert.match(html, /AA:BB:CC:DD:EE:FF · one/);
  assert.match(html, /AA:BB:CC:DD:EE:FF · two/);
});

test("MAC timeline renders a bounded chronological page with exact totals and cross-page interval", () => {
  const events = Array.from({ length: 205 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    status: "first",
    after: { mac: `DEVICE-${index}` },
    changes: [],
  }));
  const html = macTimelineContent(events, { page: 2, pageSize: 500 });
  assert.match(html, /DEVICE-100/);
  assert.match(html, /DEVICE-199/);
  assert.doesNotMatch(html, /DEVICE-0<\/strong>|DEVICE-200<\/strong>/);
  assert.match(html, /События 101–200 из 205/);
  assert.match(html, /data-mac-timeline-page="1"/);
  assert.match(html, /Страница 2 из 3/);
  assert.match(html, /Интервал: 1 сек\./);
  assert.equal((html.match(/class="timeline-card mac-timeline-item/g) || []).length, 100);
});

test("MAC churn details page the full search result and escape device fields", () => {
  const items = Array.from({ length: 205 }, (_, index) => ({
    mac: `DEVICE-${index}`,
    macFormatted: `DEVICE-${index}`,
    vendor: index === 23 ? "<Vendor>" : "Acme",
    model: `MODEL-${index}`,
    transitions: index,
    transitionCount: index + 2,
    present: 3,
    disappearances: 1,
    reappearances: 1,
  }));
  const page = churnContent(items, { page: 2, pageSize: 500 });
  assert.match(page, />DEVICE-100<\/button>/);
  assert.match(page, />DEVICE-199<\/button>/);
  assert.doesNotMatch(page, />DEVICE-99<\/button>|>DEVICE-200<\/button>/);
  assert.match(page, /Устройства 101–200 из 205/);
  assert.match(page, /data-churn-page="1"/);
  assert.equal((page.match(/data-churn-transitions=/g) || []).length, 100);
  const searched = churnContent(items, { query: "model-20", page: 2, pageSize: 3 });
  assert.match(searched, /Устройства 4–6 из 6/);
  assert.doesNotMatch(searched, />DEVICE-199<\/button>/);
  assert.match(churnContent(items, { query: "<vendor>" }), /&lt;Vendor&gt;/);
  assert.match(churnContent([{ mac: "—", macFormatted: "00-11-22-33-44-55", transitionCount: 2 }]), /data-search-mac="00:11:22:33:44:55"/);
});

