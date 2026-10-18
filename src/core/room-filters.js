import { keyText, locationKey, text } from "./normalize.js";

export const ROOM_FILTER_FIELDS = Object.freeze(["businessUnit", "city", "site", "floor", "room"]);

export function roomFilterSignature(revision, filters = {}) {
  return JSON.stringify([Number(revision) || 0, ROOM_FILTER_FIELDS.map((field) => keyText(filters[field]))]);
}

export function matchesRoomFilters(device, filters = {}, fields = ROOM_FILTER_FIELDS) {
  return fields.every((field) => !text(filters[field]) || keyText(device?.[field]) === keyText(filters[field]));
}

export function roomFilterOptions(devices = [], field, filters = {}, ancestors = ROOM_FILTER_FIELDS) {
  const values = new Map();
  for (const device of devices) {
    if (!matchesRoomFilters(device, filters, ancestors)) continue;
    const value = text(device?.[field]);
    const key = keyText(value);
    if (key && !values.has(key)) values.set(key, value);
  }
  return [...values.values()].sort((left, right) => left.localeCompare(right, "ru", { numeric: true }));
}

export function addRoomCatalogDevices(catalog, devices = []) {
  for (const device of devices) {
    const key = locationKey(device);
    if (!key) continue;
    const room = Object.fromEntries([...ROOM_FILTER_FIELDS, "smartroomId", "address"].map((field) => [field, text(device?.[field])]));
    room.key = key;
    catalog.set(key, room);
  }
  return catalog;
}

export function uniqueRoomFilterSelection(options = [], selected = "") {
  return text(selected) || (options.length === 1 ? options[0] : "");
}
