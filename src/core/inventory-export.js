import { MAX_SHEET_DATA_ROWS } from "./xlsx-export.js";
import { inventoryCellText } from "./inventory-columns.js";

export const INVENTORY_EXPORT_COLUMNS = Object.freeze([
  ["id", "ID устройства"], ["mac", "MAC"], ["manufacturer", "Производитель"], ["model", "Модель"],
  ["deviceType", "Тип"], ["ip", "IP устройства"], ["switchIp", "IP коммутатора"], ["switchPort", "Порт"],
  ["address", "Физический адрес"], ["room", "Помещение"], ["smartroomId", "Smartroom ID"],
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
