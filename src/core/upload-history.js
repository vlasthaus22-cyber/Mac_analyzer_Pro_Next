function dateKey(value) {
  const parsed = new Date(value || "");
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export function snapshotSourceNames(snapshot = {}) {
  const values = Array.isArray(snapshot.sourceFiles) ? snapshot.sourceFiles : [];
  const names = values.map((item) => typeof item === "string" ? item : item?.name || item?.fileName || item?.filename || "")
    .map((item) => String(item).trim()).filter(Boolean);
  return [...new Set(names)];
}

export function snapshotDeviceMatchesQuery(device = {}, query = "") {
  const search = String(query || "").trim().toLocaleLowerCase("ru-RU");
  if (!search) return true;
  const searchable = [
    device.mac, device.macFormatted, device.mac_formatted, device.manufacturer, device.vendor,
    device.model, device.ip, device.address, device.room, device.smartroomId, device.switchIp,
    device.switchPort, device.deviceId, device.serial, device.hostname,
  ].filter(Boolean).join(" ").toLocaleLowerCase("ru-RU");
  return searchable.includes(search);
}

export function snapshotDeviceMatchesFilters(device = {}, filters = {}) {
  const matches = (values, filter) => {
    const search = String(filter || "").trim().toLocaleLowerCase("ru-RU");
    if (!search) return true;
    return values.filter(Boolean).join(" ").toLocaleLowerCase("ru-RU").includes(search);
  };
  return matches([device.manufacturer, device.vendor], filters.vendor)
    && matches([device.model], filters.model)
    && matches([device.room, device.address, device.physicalAddress], filters.room);
}

export function filterUploadHistorySnapshots(snapshots = [], { query = "", from = "", to = "" } = {}) {
  const search = String(query).trim().toLocaleLowerCase("ru-RU");
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from)) ? `${from}T00:00:00` : "";
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(to)) ? `${to}\uffff` : "";
  if (start && end && from > to) throw new Error("Начальная дата позже конечной");
  return [...snapshots].filter((snapshot) => {
    const createdAt = String(snapshot.createdAt || "");
    if (start && createdAt < start) return false;
    if (end && createdAt > end) return false;
    if (!search) return true;
    const searchable = [snapshot.name, snapshot.id, snapshot.sourceKey, ...snapshotSourceNames(snapshot)]
      .filter(Boolean).join(" ").toLocaleLowerCase("ru-RU");
    return searchable.includes(search);
  }).sort((left, right) => dateKey(right.createdAt).localeCompare(dateKey(left.createdAt)) || String(right.id).localeCompare(String(left.id)));
}

export function selectUploadHistoryPage(snapshots = [], { query = "", from = "", to = "", page = 1, limit = 50 } = {}) {
  const pageSize = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  const pageNumber = Math.max(1, Math.floor(Number(page) || 1));
  const rows = filterUploadHistorySnapshots(snapshots, { query, from, to });
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const selectedPage = Math.min(pageNumber, pageCount);
  return {
    rows: rows.slice((selectedPage - 1) * pageSize, selectedPage * pageSize),
    total,
    page: selectedPage,
    pageCount,
    hasPrevious: selectedPage > 1,
    hasNext: selectedPage < pageCount,
  };
}
