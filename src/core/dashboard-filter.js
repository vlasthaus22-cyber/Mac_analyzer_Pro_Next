import { firstMac, keyText, normalizeMac, text } from "./normalize.js";

export const DASHBOARD_STATUS_FILTERS = Object.freeze(["all", "changed", "missing", "unchanged"]);
const KPI_STATUS_FILTERS = Object.freeze({
  devices: "all",
  modified: "changed",
  absent: "missing",
  unchanged: "unchanged",
  manufacturers: "all",
  rooms: "all",
});

export function dashboardStatusForKpi(key) {
  return Object.hasOwn(KPI_STATUS_FILTERS, key) ? KPI_STATUS_FILTERS[key] : null;
}

function deviceManufacturer(device = {}) {
  return text(device.manufacturer) || text(device.vendor);
}

export function normalizeDashboardFilters(value = {}) {
  const status = DASHBOARD_STATUS_FILTERS.includes(value?.status) ? value.status : "all";
  return {
    query: text(value?.query).slice(0, 500),
    manufacturer: text(value?.manufacturer).slice(0, 500),
    room: text(value?.room).slice(0, 500),
    status,
  };
}

export function dashboardDeviceMatchesFilters(device = {}, value = {}) {
  const filters = normalizeDashboardFilters(value);
  if (!filters.query && !filters.manufacturer && !filters.room) return true;
  const manufacturer = deviceManufacturer(device);
  const room = text(device.room);
  if (filters.manufacturer && keyText(manufacturer) !== keyText(filters.manufacturer)) return false;
  if (filters.room && keyText(room) !== keyText(filters.room)) return false;
  if (!filters.query) return true;
  const needle = keyText(filters.query);
  const compactMac = normalizeMac(filters.query);
  let searchable = "";
  let hasScalar = false;
  for (const field in device) {
    if (!Object.hasOwn(device, field)) continue;
    const item = device[field];
    if (item === null || item === undefined || (typeof item === "object" && !Array.isArray(item))) continue;
    if (hasScalar) searchable += " ";
    searchable += String(item);
    hasScalar = true;
  }
  searchable = searchable.toLocaleLowerCase();
  return searchable.includes(filters.query.toLocaleLowerCase())
    || Boolean(compactMac && firstMac(device.mac, device.macFormatted).includes(compactMac))
    || Boolean(needle && keyText(searchable).includes(needle));
}

export function filterDashboardDevicesInPlace(devices = [], filters = {}) {
  let kept = 0;
  for (let index = 0; index < devices.length; index += 1) {
    const device = devices[index];
    if (dashboardDeviceMatchesFilters(device, filters)) devices[kept++] = device;
  }
  devices.length = kept;
  return devices;
}

export function dashboardFilterOptions(devices = []) {
  const manufacturers = new Set();
  const rooms = new Set();
  for (const device of devices) {
    const manufacturer = deviceManufacturer(device);
    const room = text(device?.room);
    if (manufacturer) manufacturers.add(manufacturer);
    if (room) rooms.add(room);
  }
  const order = (left, right) => left.localeCompare(right, "ru", { sensitivity: "base" }) || left.localeCompare(right);
  return { manufacturers: [...manufacturers].sort(order), rooms: [...rooms].sort(order) };
}
