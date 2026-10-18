import { normalizeChangeType } from "./change-categories.js";

const FIELD_LABELS = Object.freeze({
  address: "Адрес",
  deviceIp: "IP-адрес",
  ip: "IP-адрес",
  manufacturer: "Производитель",
  model: "Модель",
  room: "Помещение",
  switchIp: "IP коммутатора",
  switchPort: "Порт",
  vendor: "Производитель",
});

export function historyExportRow(event = {}) {
  const oldValue = event.oldValue ?? event.before ?? "";
  const newValue = event.newValue ?? event.after ?? "";
  const placeholder = (value) => ["—", "–", "-"].includes(String(value).trim());
  const type = normalizeChangeType(event.type);
  const added = type === "added" || (placeholder(oldValue) && Boolean(newValue) && !placeholder(newValue));
  const removed = type === "absent" || (placeholder(newValue) && Boolean(oldValue) && !placeholder(oldValue));
  const source = String(event.source || "").split(/[\\/]/).at(-1) || "-";
  return [
    String(event.timestamp || event.createdAt || ""),
    String(event.mac || ""),
    FIELD_LABELS[event.field] || String(event.label || event.field || ""),
    oldValue === "" ? "—" : oldValue,
    newValue === "" ? "—" : newValue,
    source,
    added ? "Добавление" : removed ? "Удаление" : "Изменение",
  ];
}

export function historyExportSheets(database, filters = {}) {
  const rows = (async function* historyRows() {
    let cursor = null;
    do {
      const page = await database.historyDateRangePage(filters, { cursor, limit: 500 });
      for (const event of page.rows) yield historyExportRow(event);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (cursor);
  }());
  return [{
    name: "История изменений",
    headings: ["Дата", "MAC-адрес", "Поле", "Было", "Стало", "Файл", "Тип"],
    rows,
  }];
}
