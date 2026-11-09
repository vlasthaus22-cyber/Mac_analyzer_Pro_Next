import { keyText, locationKey, text } from "./normalize.js";

export const ROOM_FILTER_FIELDS = Object.freeze(["businessUnit", "city", "site", "floor", "room"]);
const ROOM_CATALOG_FIELDS = Object.freeze([...ROOM_FILTER_FIELDS, "smartroomId", "address"]);

export function roomFilterSignature(revision, filters = {}) {
  return JSON.stringify([Number(revision) || 0, ROOM_FILTER_FIELDS.map((field) => keyText(filters[field]))]);
}

export function publishRoomCatalogForRevision(state, revision, catalog) {
  if (!state || Number(revision) !== Number(state.roomCatalogRevision) || !Array.isArray(catalog)) return false;
  state.roomCatalog = catalog;
  return true;
}

export async function cachedRoomCatalogLoad(state, load) {
  if (!state || typeof load !== "function") throw new TypeError("Для загрузки каталога нужны состояние и функция чтения");
  if (!state.roomCatalogPromise) state.roomCatalogPromise = Promise.resolve().then(load);
  const pending = state.roomCatalogPromise;
  try {
    return await pending;
  } catch (error) {
    if (state.roomCatalogPromise === pending) state.roomCatalogPromise = null;
    throw error;
  }
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

export function roomFilterCascadeOptions(devices = [], filters = {}, fields = ROOM_FILTER_FIELDS) {
  const selected = Object.fromEntries(fields.map((field) => [field, keyText(filters[field])]));
  const values = new Map(fields.map((field) => [field, new Map()]));
  for (const device of devices) {
    let matches = true;
    for (const field of fields) {
      if (!matches) break;
      const value = text(device?.[field]);
      const key = keyText(value);
      if (key && !values.get(field).has(key)) values.get(field).set(key, value);
      const expected = selected[field];
      if (expected && key !== expected) matches = false;
    }
  }
  return Object.fromEntries(fields.map((field) => [
    field,
    [...values.get(field).values()].sort((left, right) => left.localeCompare(right, "ru", { numeric: true })),
  ]));
}

export function addRoomCatalogDevices(catalog, devices = []) {
  for (const device of devices) {
    const key = locationKey(device);
    if (!key) continue;
    const existing = catalog.get(key);
    let unchanged = existing !== undefined;
    if (unchanged) {
      for (const field of ROOM_CATALOG_FIELDS) {
        if (existing[field] !== text(device?.[field])) {
          unchanged = false;
          break;
        }
      }
    }
    if (unchanged) continue;
    const room = {};
    for (const field of ROOM_CATALOG_FIELDS) room[field] = text(device?.[field]);
    room.key = key;
    catalog.set(key, room);
  }
  return catalog;
}

export function uniqueRoomFilterSelection(options = [], selected = "") {
  return text(selected) || (options.length === 1 ? options[0] : "");
}
