import { normalizeMac } from "./normalize.js";
import { ouiBytesForMac } from "./oui-formats.js";

const DEFAULT_FIELDS = Object.freeze([
  ["rowNumber", "№"],
  ["mac", "MAC"], ["ip", "IP-адрес"], ["switchIp", "IP коммутатора"], ["switchPort", "Порт подключения"],
  ["manufacturer", "Производитель"], ["model", "Модель"], ["deviceType", "Тип"], ["hostname", "Hostname"],
  ["serial", "Serial"], ["smartroomId", "Smartroom ID"], ["room", "Помещение"], ["address", "Физический адрес"],
  ["authenticationTime", "Время аутентификации"],
]);
const OPTIONAL_FIELDS = Object.freeze([
  ["macFormatted", "MAC (форматированный)"],
  ["oui3", "OUI (3 байта)"], ["oui4", "OUI (4 байта)"], ["oui5", "OUI (5 байт)"], ["oui6", "OUI (6 байт)"],
  ["deviceId", "Device ID"], ["deviceName", "Название устройства"], ["physicalAddress", "Физический адрес"],
  ["businessUnit", "ТБ"], ["city", "Город"], ["site", "Площадка"], ["floor", "Этаж"],
  ["matchDetails", "Примечание"], ["addedAt", "Дата добавления"],
]);
const DEFAULT_VISIBLE_ORDER = Object.freeze([
  "rowNumber", "mac", "manufacturer", "model", "ip", "address", "room", "switchIp", "switchPort", "matchDetails",
]);
const DEFAULT_VISIBLE_KEYS = new Set(DEFAULT_VISIBLE_ORDER);
const LEGACY_COLUMN_KEYS = Object.freeze({
  "№": "rowNumber", mac_formatted: "macFormatted", "MAC (форматированный)": "macFormatted", vendor: "manufacturer", serialNumber: "serial",
});
export const INVENTORY_DEFAULT_COLUMNS = Object.freeze(DEFAULT_FIELDS.filter(([key]) => key !== "rowNumber").map(([key, label]) => Object.freeze([key, label])));
export const INVENTORY_COLUMN_CATALOG = Object.freeze([
  ...DEFAULT_FIELDS.map(([key, label]) => Object.freeze({ key, label, visibleByDefault: DEFAULT_VISIBLE_KEYS.has(key) })),
  ...OPTIONAL_FIELDS.map(([key, label]) => Object.freeze({ key, label, visibleByDefault: DEFAULT_VISIBLE_KEYS.has(key) })),
]);

const CATALOG_BY_KEY = new Map(INVENTORY_COLUMN_CATALOG.map((column) => [column.key, column]));
const MIN_WIDTH = 70;
const MAX_WIDTH = 600;
const clampWidth = (value) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(Number(value) || 0)));
const CUSTOM_COLUMN_KEY = /^custom_[0-9a-f-]{36}$/i;

export function customInventoryColumnKey(label) {
  const normalized = String(label || "").trim().slice(0, 60).toLowerCase();
  if (!normalized) throw new Error("Введите название пользовательского столбца");
  let first = 0xcbf29ce484222325n;
  let second = 0x84222325cbf29ce4n;
  let index = 0n;
  for (const character of normalized) {
    const codePoint = BigInt(character.codePointAt(0));
    first = BigInt.asUintN(64, (first ^ codePoint) * 0x100000001b3n);
    second = BigInt.asUintN(64, (second ^ (codePoint + index)) * 0x100000001b3n);
    index += 1n;
  }
  let hex = `${first.toString(16).padStart(16, "0")}${second.toString(16).padStart(16, "0")}`;
  hex = `${hex.slice(0, 12)}5${hex.slice(13, 16)}${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17)}`;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return `custom_${id}`;
}

export function defaultInventoryColumnConfig() {
  const defaults = new Map(INVENTORY_COLUMN_CATALOG.map(({ key, label, visibleByDefault }) => [key, { key, label, visible: visibleByDefault, width: 150 }]));
  const orderedKeys = [...DEFAULT_VISIBLE_ORDER, ...INVENTORY_COLUMN_CATALOG.map(({ key }) => key).filter((key) => !DEFAULT_VISIBLE_KEYS.has(key))];
  return { columns: orderedKeys.map((key) => defaults.get(key)) };
}

export function inventoryColumnConfigFromLegacyPreferences(value) {
  let preferences = value;
  if (typeof preferences === "string") {
    try { preferences = JSON.parse(preferences); } catch { return null; }
  }
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return null;
  const sourceOrder = Array.isArray(preferences.order) ? preferences.order : Array.isArray(preferences.columns) ? preferences.columns : [];
  const sourceVisible = new Set(Array.isArray(preferences.visible) ? preferences.visible : sourceOrder);
  const sourceWidths = preferences.widths && typeof preferences.widths === "object" ? preferences.widths : {};
  const sourceToInventory = (key) => LEGACY_COLUMN_KEYS[key] || key;
  const mappedOrder = [];
  for (const key of sourceOrder) {
    const mapped = sourceToInventory(String(key));
    if (CATALOG_BY_KEY.has(mapped) && !mappedOrder.includes(mapped)) mappedOrder.push(mapped);
  }
  if (!mappedOrder.length) return null;
  const defaults = defaultInventoryColumnConfig().columns;
  const byKey = new Map(defaults.map((column) => [column.key, column]));
  const allKeys = [
    ...mappedOrder,
    ...defaults.map(({ key }) => key).filter((key) => key !== "rowNumber" && !mappedOrder.includes(key)),
  ];
  if (!mappedOrder.includes("rowNumber")) allKeys.unshift("rowNumber");
  return normalizeInventoryColumnConfig({
    columns: allKeys.map((key) => {
      const legacyKey = sourceOrder.find((item) => sourceToInventory(String(item)) === key);
      const legacyVisible = key === "rowNumber" && !sourceOrder.some((item) => sourceToInventory(String(item)) === key)
        ? true
        : [...sourceVisible].some((item) => sourceToInventory(String(item)) === key);
      const legacyWidth = sourceWidths[legacyKey] ?? sourceWidths[key];
      return { ...byKey.get(key), visible: legacyVisible, width: legacyWidth ?? byKey.get(key).width };
    }),
  });
}

export function normalizeInventoryColumnConfig(value = {}) {
  const defaults = defaultInventoryColumnConfig();
  const incoming = Array.isArray(value?.columns) ? value.columns : [];
  const seen = new Set();
  const columns = [];
  for (const item of incoming) {
    const key = String(item?.key || "");
    const descriptor = CATALOG_BY_KEY.get(key);
    const custom = Boolean(item?.custom) && CUSTOM_COLUMN_KEY.test(key);
    if ((!descriptor && !custom) || seen.has(key)) continue;
    const defaultLabel = descriptor?.label || "Пользовательское поле";
    const label = String(item.label ?? defaultLabel).trim().slice(0, 60) || defaultLabel;
    columns.push({ key, label, visible: Boolean(item.visible), width: item.width === undefined ? 150 : clampWidth(item.width), ...(custom ? { custom: true } : {}) });
    seen.add(key);
  }
  for (const column of defaults.columns) {
    if (seen.has(column.key)) continue;
    if (column.key === "rowNumber") columns.unshift(column);
    else columns.push(column);
  }
  return { columns };
}

export function moveInventoryColumn(config, key, direction) {
  const normalized = normalizeInventoryColumnConfig(config);
  const index = normalized.columns.findIndex((column) => column.key === key);
  const nextIndex = index + Math.sign(Number(direction) || 0);
  if (index < 0 || nextIndex < 0 || nextIndex >= normalized.columns.length) return normalized;
  [normalized.columns[index], normalized.columns[nextIndex]] = [normalized.columns[nextIndex], normalized.columns[index]];
  return normalized;
}

export function updateInventoryColumn(config, key, patch = {}) {
  const normalized = normalizeInventoryColumnConfig(config);
  normalized.columns = normalized.columns.map((column) => column.key !== key ? column : {
    ...column,
    ...(Object.hasOwn(patch, "visible") ? { visible: Boolean(patch.visible) } : {}),
    ...(Object.hasOwn(patch, "label") ? { label: String(patch.label || "").trim().slice(0, 60) || CATALOG_BY_KEY.get(key)?.label || column.label } : {}),
    ...(Object.hasOwn(patch, "width") ? { width: clampWidth(patch.width) || 150 } : {}),
  });
  return normalized;
}

export function addCustomInventoryColumn(config, label, id = customInventoryColumnKey(label).slice("custom_".length)) {
  const cleanLabel = String(label || "").trim().slice(0, 60);
  const key = `custom_${String(id || "").toLowerCase()}`;
  if (!cleanLabel) throw new Error("Введите название пользовательского столбца");
  if (!CUSTOM_COLUMN_KEY.test(key)) throw new Error("Не удалось создать идентификатор пользовательского столбца");
  const normalized = normalizeInventoryColumnConfig(config);
  if (normalized.columns.some((column) => column.key === key)) throw new Error("Такой пользовательский столбец уже существует");
  normalized.columns.push({ key, label: cleanLabel, visible: true, width: 150, custom: true });
  return normalized;
}

export function removeCustomInventoryColumn(config, key) {
  const normalized = normalizeInventoryColumnConfig(config);
  normalized.columns = normalized.columns.filter((column) => !(column.custom && column.key === key));
  return normalized;
}

export function visibleInventoryColumns(config) {
  return normalizeInventoryColumnConfig(config).columns.filter((column) => column.visible);
}

export function inventoryCellText(device, key, rowNumber = null) {
  if (key === "rowNumber") return Number.isFinite(Number(rowNumber)) && rowNumber !== null ? String(Number(rowNumber)) : "";
  if (key === "macFormatted") return String(device?.macFormatted || device?.mac_formatted || normalizeMac(device?.mac));
  const ouiMatch = /^oui([3-6])$/.exec(key);
  if (ouiMatch) return ouiBytesForMac(device?.mac || device?.macFormatted || device?.mac_formatted, Number(ouiMatch[1]));
  if (key === "addedAt") return String(device?.firstSeenAt || device?.addedAt || "");
  const value = key.startsWith("custom_") ? device?.customFields?.[key] : device?.[key];
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

export async function optimizeInventoryColumnWidths(config, visitInventory) {
  if (typeof visitInventory !== "function") throw new TypeError("Требуется последовательный обход Inventory");
  const normalized = normalizeInventoryColumnConfig(config);
  const widths = new Map(normalized.columns.map((column) => [column.key, column.label.length]));
  await visitInventory((device) => {
    for (const column of normalized.columns) {
      const length = Math.min(72, inventoryCellText(device, column.key).length);
      widths.set(column.key, Math.max(widths.get(column.key), length));
    }
  });
  return {
    columns: normalized.columns.map((column) => ({
      ...column,
      width: clampWidth((widths.get(column.key) || column.label.length) * 8 + 30),
    })),
  };
}
