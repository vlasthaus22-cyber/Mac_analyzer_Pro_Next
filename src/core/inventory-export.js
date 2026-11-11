import { MAX_SHEET_DATA_ROWS } from "./xlsx-export.js";
import { inventoryCellText } from "./inventory-columns.js";

export const INVENTORY_EXPORT_COLUMNS = Object.freeze([
  ["id", "ID устройства"], ["mac", "MAC"], ["manufacturer", "Производитель"], ["model", "Модель"],
  ["deviceType", "Тип"], ["ip", "IP устройства"], ["switchIp", "IP коммутатора"], ["switchPort", "Порт"],
  ["authenticationTime", "Время аутентификации"],
  ["address", "Адрес"], ["room", "Помещение"], ["smartroomId", "Smartroom ID"],
  ["serial", "Серийный номер"], ["deviceId", "Device ID"], ["hostname", "Hostname"],
  ["firstSeen", "Первое наблюдение"], ["lastSeen", "Последнее наблюдение"],
  ["observationCount", "Наблюдений в Final"], ["present", "Присутствует в последнем Final"],
]);

export async function createInventoryXlsxSheets(database, {
  pageSize = 500,
  maxDataRowsPerSheet = MAX_SHEET_DATA_ROWS,
  columns = null,
  additionalColumns = [],
  onProgress = () => {},
} = {}) {
  const customColumns = additionalColumns
    .filter((column) => /^custom_[0-9a-f-]{36}$/i.test(String(column?.key || "")))
    .map((column) => [String(column.key), String(column.label || "Пользовательское поле").slice(0, 60)]);
  const configuredColumns = Array.isArray(columns) ? columns
    .filter((column) => column && (/^[A-Za-z][A-Za-z0-9]*$/.test(String(column.key || "")) || /^custom_[0-9a-f-]{36}$/i.test(String(column.key || ""))))
    .map((column) => [String(column.key), String(column.label || column.key).slice(0, 60)]) : [];
  const exportColumns = configuredColumns.length
    ? [...new Map(configuredColumns.map((column) => [column[0], column])).values()]
    : [...INVENTORY_EXPORT_COLUMNS, ...customColumns];
  const total = await database.inventoryCount();
  const maximum = Math.max(1, Math.min(MAX_SHEET_DATA_ROWS, Math.floor(Number(maxDataRowsPerSheet) || MAX_SHEET_DATA_ROWS)));
  const boundedPageSize = Math.max(1, Math.min(2_000, Math.floor(Number(pageSize) || 500)));
  const sheetCount = Math.max(1, Math.ceil(total / maximum));
  let afterId = null;
  let exported = 0;
  const sheets = Array.from({ length: sheetCount }, (_, index) => ({
    name: index === 0 ? "Inventory" : `Inventory ${index + 1}`,
    headings: exportColumns.map(([, label]) => label),
    rows: (async function* rows() {
      let remaining = Math.min(maximum, Math.max(0, total - index * maximum));
      while (remaining > 0) {
        const page = await database.inventoryPage({ afterId, limit: Math.min(boundedPageSize, remaining) });
        if (!page.rows.length) break;
        for (const device of page.rows) {
          yield exportColumns.map(([field]) => field === "present"
            ? (device.present ? "Да" : "Нет")
            : configuredColumns.length ? inventoryCellText(device, field, exported + 1)
              : field.startsWith("custom_") ? device.customFields?.[field] ?? "" : device[field] ?? "");
          afterId = device.id;
          exported += 1;
          remaining -= 1;
        }
        onProgress(exported, total);
      }
    })(),
  }));
  return { total, sheets, get exported() { return exported; } };
}

export async function createInventorySearchXlsxSheets(database, {
  query = "",
  matches = () => true,
  cellText = inventoryCellText,
  pageSize = 500,
  maxDataRowsPerSheet = MAX_SHEET_DATA_ROWS,
  columns = [],
  onProgress = () => {},
} = {}) {
  if (typeof database?.inventoryPage !== "function") throw new TypeError("Для экспорта поиска нужен постраничный Inventory");
  if (typeof matches !== "function" || typeof cellText !== "function") throw new TypeError("Для экспорта поиска нужны правила фильтрации и ячеек");
  const exportColumns = [...new Map((Array.isArray(columns) ? columns : [])
    .filter((column) => column && /^[A-Za-z][A-Za-z0-9]*$/.test(String(column.key || "")))
    .map((column) => [String(column.key), { key: String(column.key), label: String(column.label || column.key).slice(0, 60) }])).values()];
  if (!exportColumns.length) throw new TypeError("Выберите хотя бы один столбец для экспорта поиска");
  const boundedPageSize = Math.max(1, Math.min(2_000, Math.floor(Number(pageSize) || 500)));
  const maximum = Math.max(1, Math.min(MAX_SHEET_DATA_ROWS, Math.floor(Number(maxDataRowsPerSheet) || MAX_SHEET_DATA_ROWS)));
  let matchedTotal = 0;
  let afterId = null;
  let scanned = 0;
  while (true) {
    const page = await database.inventoryPage({ afterId, limit: boundedPageSize });
    if (!page.rows.length) break;
    for (const device of page.rows) if (matches(device, query)) matchedTotal += 1;
    scanned += page.rows.length;
    afterId = page.rows.at(-1)?.id;
    if (!afterId || !page.hasMore) break;
  }
  const sheetCount = Math.max(1, Math.ceil(matchedTotal / maximum));
  let exported = 0;
  afterId = null;
  let pageRows = [];
  let pageOffset = 0;
  let exhausted = false;
  const sheets = Array.from({ length: sheetCount }, (_, index) => {
    const expected = Math.min(maximum, Math.max(0, matchedTotal - index * maximum));
    return {
      name: index === 0 ? "Результаты поиска" : `Результаты ${index + 1}`,
      headings: exportColumns.map(({ label }) => label),
      rows: (async function* rows() {
        let remaining = expected;
        while (remaining > 0 && !exhausted) {
          if (pageOffset >= pageRows.length) {
            const page = await database.inventoryPage({ afterId, limit: boundedPageSize });
            pageRows = page.rows;
            pageOffset = 0;
            if (!pageRows.length) { exhausted = true; break; }
          }
          const device = pageRows[pageOffset++];
          afterId = device.id;
          if (!matches(device, query)) continue;
          yield exportColumns.map(({ key }) => cellText(device, key, exported + 1));
          exported += 1;
          remaining -= 1;
          onProgress(exported, matchedTotal);
        }
        if (remaining > 0) throw new Error(`Поиск в Inventory изменился во время экспорта: выгружено ${exported} из ${matchedTotal}. Повторите экспорт.`);
      })(),
    };
  });
  return { total: matchedTotal, sheets, get exported() { return exported; }, scanned };
}
