import { isDashboardWidgetVisible } from "./analytics-dashboard-settings.js";
import { text as normalizeText } from "./normalize.js";

const KPI_LABELS = Object.freeze([
  ["devices", "Устройства"],
  ["modified", "Изменённые"],
  ["absent", "Отсутствуют"],
  ["unchanged", "Без изменений"],
  ["manufacturers", "Производители"],
  ["rooms", "Помещения"],
]);

function series(items = [], valueKey = "value") {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    label: String(item?.label ?? item?.period ?? index + 1),
    value: Number(item?.[valueKey]) || 0,
  }));
}

export function buildAnalyticsDashboardExportModel(analytics, settings) {
  if (!analytics?.detailsReady || !analytics.kpis) throw new Error("Дождитесь завершения расчёта Dashboard перед экспортом PNG");
  const status = analytics.dashboardFilters?.status || "all";
  const scopedDeviceCount = Number(analytics.dashboardFilteredDeviceCount ?? analytics.kpis.devices) || 0;
  const fleetLabel = analytics.history
    ? `${Number(analytics.history.uniqueMacs || 0).toLocaleString("ru-RU")} / ${scopedDeviceCount.toLocaleString("ru-RU")}`
    : null;
  const scopedKpis = {
    devices: fleetLabel ?? scopedDeviceCount,
    manufacturers: Number(analytics.dataset?.summary?.uniqueVendors ?? analytics.kpis.manufacturers) || 0,
    rooms: Number(analytics.dataset?.roomOccupancy?.uniqueRooms ?? analytics.dataset?.summary?.uniqueRooms ?? analytics.kpis.rooms) || 0,
  };
  const exportSummary = analytics.dashboardExportSummary || {};
  const totals = series(analytics.totals);
  const previousTotal = totals.at(-2)?.value || 0;
  const currentTotal = totals.at(-1)?.value || 0;
  const changePercent = previousTotal ? ((currentTotal - previousTotal) / previousTotal) * 100 : currentTotal ? 100 : 0;
  const vendors = series(analytics.dataset?.charts?.vendors);
  const presenceChurnItems = Array.isArray(analytics.churn) ? analytics.churn : [];
  const fieldChanges = status === "all" || status === "changed" ? series(exportSummary.fieldChanges) : [];
  const absentVendors = status === "all" || status === "missing" ? series(exportSummary.absentVendors) : [];
  const charts = [
    {
      key: "chart:totals",
      type: "line",
      title: "Динамика общего числа устройств",
      labels: totals.map((item) => item.label),
      datasets: [{ label: "Устройств", tone: "primary", values: totals.map((item) => item.value) }],
      summary: `Было ${previousTotal.toLocaleString("ru-RU")}, стало ${currentTotal.toLocaleString("ru-RU")} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(1)}%)`,
    },
    { key: "chart:vendors", type: "bar", title: "Топ производителей выбранного статуса", categoryHeading: "Производитель", items: vendors },
    {
      key: "chart:fields",
      type: "bar",
      title: "Изменения по полям",
      categoryHeading: "Поле",
      items: fieldChanges,
    },
    {
      key: "chart:absent-vendors",
      type: "bar",
      title: "Отсутствующие устройства по производителям",
      categoryHeading: "Производитель",
      items: absentVendors,
    },
    {
      key: "chart:presence-churn",
      type: "bar",
      title: "Исчезающие и возвращающиеся MAC",
      categoryHeading: "MAC",
      items: presenceChurnItems,
      itemLabel: (item) => String(item?.mac || item?.macFormatted || ""),
      itemValue: (item) => Number(item?.transitions ?? item?.transitionCount) || 0,
    },
  ].filter(({ key }) => isDashboardWidgetVisible(settings, key));
  return {
    width: 2_000,
    height: charts.length > 4 ? 1_520 : 1_200,
    kpis: KPI_LABELS.map(([key, label]) => ({
      key,
      label,
      value: Object.hasOwn(scopedKpis, key) ? scopedKpis[key] : Number(analytics.kpis[key]) || 0,
    }))
      .filter(({ key }) => isDashboardWidgetVisible(settings, `kpi:${key}`)),
    charts,
  };
}

function* rows(items, select) {
  for (let index = 0; index < items.length; index += 1) yield select(items[index], index);
}

function streamSheet(name, headings, sourceRows) {
  return { name, headings, rows: (async function* () { yield* sourceRows; })() };
}

export function analyticsDashboardXlsxSheets(analytics, settings) {
  const model = buildAnalyticsDashboardExportModel(analytics, settings);
  const sheets = [streamSheet("Показатели", ["Показатель", "Значение"], rows(model.kpis, ({ label, value }) => [label, value]))];
  for (const chart of model.charts) {
    if (chart.key === "chart:totals") {
      sheets.push(streamSheet("Итого устройств", ["Final", "Устройств"], rows(chart.labels, (label, index) => [label, chart.datasets[0].values[index] || 0])));
    } else if (chart.key === "chart:vendors") {
      sheets.push(streamSheet("Производители статуса", ["Производитель", "Устройств"], rows(chart.items, ({ label, value }) => [label, value])));
    } else if (chart.key === "chart:fields") {
      sheets.push(streamSheet("Изменения по полям", ["Поле", "Изменений"], rows(chart.items, ({ label, value }) => [label, value])));
    } else if (chart.key === "chart:absent-vendors") {
      sheets.push(streamSheet("Отсутствуют", ["Производитель", "Устройств"], rows(chart.items, ({ label, value }) => [label, value])));
    } else if (chart.key === "chart:presence-churn") {
      sheets.push(streamSheet("MAC churn", ["MAC", "Производитель", "Модель", "IP", "Помещение", "Появлений", "Исчезновений", "Возвращений", "Переходов"], rows(analytics.churn || [], (item) => [
        item.mac || item.macFormatted || "",
        item.vendor || item.manufacturer || "",
        item.model || "",
        item.ip || "",
        item.room || "",
        Number(item.present) || 0,
        Number(item.disappearances) || 0,
        Number(item.reappearances) || 0,
        Number(item.transitions ?? item.transitionCount) || 0,
      ])));
    }
  }
  return sheets;
}

async function* rankedAnalyticsRows(readRankedPage, queryId, metric, denominator, { pageSize = 200, limit = Infinity, exclude = () => false, expectedTotal: requiredTotal = null, requireRows = false } = {}) {
  let after = null;
  let observed = 0;
  let expectedTotal = null;
  let exported = 0;
  do {
    const page = await readRankedPage(queryId, metric, { after, limit: pageSize });
    if (!Number.isSafeInteger(Number(page?.total)) || Number(page.total) < 0 || !Array.isArray(page.rows)) {
      throw new Error(`Повреждена страница аналитического рейтинга «${metric}»`);
    }
    if (expectedTotal !== null && Number(page.total) !== expectedTotal) {
      throw new Error(`Состав рейтинга «${metric}» изменился во время экспорта`);
    }
    expectedTotal = Number(page.total);
    if (requiredTotal !== null && expectedTotal !== Number(requiredTotal)) {
      throw new Error(`Рейтинг «${metric}» устарел: ожидалось ${Number(requiredTotal).toLocaleString("ru-RU")}, найдено ${expectedTotal.toLocaleString("ru-RU")}`);
    }
    if (requireRows && expectedTotal === 0) throw new Error(`Рейтинг «${metric}» отсутствует в активном агрегате`);
    observed += page.rows.length;
    for (const row of page.rows) {
      if (exported >= limit) break;
      const label = String(row?.data?.label ?? row?.value ?? "");
      if (exclude(label)) continue;
      const count = Number(row?.count || 0);
      const percent = denominator ? Math.round(count / denominator * 1000) / 10 : 0;
      yield [label, count, `${percent.toFixed(1)}%`];
      exported += 1;
    }
    if (!page.hasMore) break;
    if (!page.nextCursor || (page.rows.length === 0 && expectedTotal > observed)) {
      throw new Error(`Не удалось продолжить чтение рейтинга «${metric}»`);
    }
    after = page.nextCursor;
  } while (true);
  if (observed !== expectedTotal) {
    throw new Error(`Рейтинг «${metric}» неполон: ожидалось ${expectedTotal.toLocaleString("ru-RU")}, прочитано ${observed.toLocaleString("ru-RU")}`);
  }
}

export function analyticsSummaryXlsxSheets(analytics, readRankedPage, { pageSize = 200 } = {}) {
  if (!analytics?.detailsReady || !analytics.dataset?.summary) throw new Error("Дождитесь завершения аналитики перед экспортом сводки");
  if (typeof readRankedPage !== "function") throw new TypeError("Для полного экспорта рейтингов требуется постраничное чтение IndexedDB");
  const queryId = String(analytics.dataset.clusters?.queryId || "");
  if (!queryId) throw new Error("Для полного экспорта рейтингов обновите аналитику выбранного Final");
  const summary = analytics.dataset.summary;
  const coverage = analytics.dataset.coverage || {};
  const total = Number(summary.devices) || 0;
  const percentage = (count) => `${total ? (Math.round(Number(count || 0) / total * 1000) / 10).toFixed(1) : "0.0"}%`;
  const countWithPercent = (count) => `${Number(count || 0)} (${percentage(count)})`;
  const statistics = [
    ["Всего устройств", total],
    ["С определенным производителем", countWithPercent(summary.knownVendors)],
    ["С определенной моделью", countWithPercent(summary.withModel)],
    ["С физическим адресом", countWithPercent(summary.withAddress)],
    ["С помещением", countWithPercent(summary.withRoom)],
    ["С IP-адресом", countWithPercent(summary.withIp)],
    ["С IP коммутатора", countWithPercent(summary.withSwitch)],
    ["С портом подключения", countWithPercent(coverage.port?.count)],
    ["Уникальных производителей", Number(summary.uniqueVendors) || 0],
    ["Уникальных моделей", Number(summary.uniqueModels) || 0],
    ["Уникальных помещений", Number(analytics.dataset?.roomOccupancy?.uniqueRooms ?? summary.uniqueRooms) || 0],
    ["Уникальных коммутаторов", Number(summary.uniqueSwitches) || 0],
  ];
  const sheet = (name, headings, rows) => ({ name, headings, rows: (async function* () { yield* rows; })() });
  const list = (metric, options = {}) => rankedAnalyticsRows(readRankedPage, queryId, metric, total, { pageSize, ...options });
  return [
    sheet("Общая статистика", ["Показатель", "Значение"], statistics),
    sheet("Производители", ["Производитель", "Количество", "Процент"], list("vendor", { requireRows: total > 0 })),
    sheet("Модели", ["Модель", "Количество", "Процент"], list("model", { limit: 50, expectedTotal: Number(summary.uniqueModels) || 0, exclude: (label) => !normalizeText(label) })),
    sheet("Помещения", ["Помещение", "Количество", "Процент"], list("room", { exclude: (label) => !normalizeText(label) })),
    sheet("Коммутаторы", ["IP коммутатора", "Количество устройств", "Процент"], list("switch", { expectedTotal: Number(summary.uniqueSwitches) || 0 })),
    sheet("Заполненность полей", ["Поле", "Заполнено", "Процент"], [
      ["Производитель", countWithPercent(summary.knownVendors), percentage(summary.knownVendors)],
      ["Модель", countWithPercent(summary.withModel), percentage(summary.withModel)],
      ["IP-адрес", countWithPercent(summary.withIp), percentage(summary.withIp)],
      ["Физический адрес", countWithPercent(summary.withAddress), percentage(summary.withAddress)],
      ["Помещение", countWithPercent(summary.withRoom), percentage(summary.withRoom)],
      ["IP коммутатора", countWithPercent(summary.withSwitch), percentage(summary.withSwitch)],
      ["Порт подключения", countWithPercent(coverage.port?.count), percentage(coverage.port?.count)],
    ]),
  ];
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function* analyticsDashboardHtmlChunks(analytics, createdAt = new Date(), settings) {
  const model = buildAnalyticsDashboardExportModel(analytics, settings);
  const created = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  yield `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAC Analyzer Pro · Dashboard</title><style>:root{color-scheme:light}body{font:15px/1.5 Segoe UI,Arial,sans-serif;margin:32px auto;padding:0 20px;max-width:1200px;color:#172326;background:#f4f7f8}header,section{background:#fff;border:1px solid #d6e0e2;border-radius:10px;padding:20px;margin:18px 0}h1,h2{margin-top:0}ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 24px;padding-left:20px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%}th,td{padding:8px 10px;border:1px solid #d6e0e2;text-align:left}th{background:#edf3f4}footer{color:#66777b;font-size:13px}@media print{body{background:#fff;margin:0;max-width:none}header,section{break-inside:avoid;box-shadow:none}}</style></head><body><header><h1>MAC Analyzer Pro · Dashboard</h1><p>Создано: <time>${htmlEscape(created)}</time></p><h2>Показатели</h2><ul>`;
  for (const { label, value } of model.kpis) {
    yield `<li><strong>${htmlEscape(label)}:</strong> ${htmlEscape(typeof value === "number" ? value.toLocaleString("ru-RU") : value)}</li>`;
  }
  yield "</ul></header>";
  for (const chart of model.charts) {
    const headings = chart.type === "line"
      ? chart.datasets.map(({ label }) => `<th scope="col">${htmlEscape(label)}</th>`).join("")
      : "<th scope=\"col\">Значение</th>";
    const categoryHeading = chart.type === "line" ? "Период" : chart.categoryHeading || "Категория";
    yield `<section><h2>${htmlEscape(chart.title)}</h2>${chart.summary ? `<p>${htmlEscape(chart.summary)}</p>` : ""}<div class="table-wrap"><table><thead><tr><th scope="col">${htmlEscape(categoryHeading)}</th>${headings}</tr></thead><tbody>`;
    let rowCount = 0;
    if (chart.type === "line") {
      for (let index = 0; index < chart.labels.length; index += 1) {
        const values = chart.datasets.map((dataset) => `<td>${htmlEscape(dataset.values[index] ?? 0)}</td>`).join("");
        yield `<tr><td>${htmlEscape(chart.labels[index])}</td>${values}</tr>`;
        rowCount += 1;
      }
    } else {
      for (const item of chart.items) {
        const label = chart.itemLabel ? chart.itemLabel(item) : item.label;
        const value = chart.itemValue ? chart.itemValue(item) : item.value;
        yield `<tr><td>${htmlEscape(label)}</td><td>${htmlEscape(value)}</td></tr>`;
        rowCount += 1;
      }
    }
    if (!rowCount) yield `<tr><td colspan="${chart.type === "line" ? chart.datasets.length + 1 : 2}">Нет данных</td></tr>`;
    yield "</tbody></table></div></section>";
  }
  yield "<footer>Отчёт сформирован локально в MAC Analyzer Pro Next.</footer></body></html>";
}

export function analyticsDashboardHtml(analytics, createdAt = new Date(), settings) {
  return Array.from(analyticsDashboardHtmlChunks(analytics, createdAt, settings)).join("");
}
