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
  return snapshots.filter((snapshot) => {
    const createdAt = String(snapshot.createdAt || "");
    if (start && createdAt < start) return false;
    if (end && createdAt > end) return false;
    if (!search) return true;
    const searchable = [snapshot.name, snapshot.id, snapshot.sourceKey, ...snapshotSourceNames(snapshot)]
      .filter(Boolean).join(" ").toLocaleLowerCase("ru-RU");
    return searchable.includes(search);
  }).sort((left, right) => dateKey(right.createdAt).localeCompare(dateKey(left.createdAt)) || String(right.id).localeCompare(String(left.id)));
}

function uploadHistoryDateBounds(from, to) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from)) ? `${from}T00:00:00` : "";
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(to)) ? `${to}\uffff` : "";
  if (start && end && from > to) throw new Error("Начальная дата позже конечной");
  return { start, end };
}

function canonicalSnapshotRange(snapshots, { start, end }) {
  const firstAtOrAfter = (target) => {
    if (!target) return 0;
    let low = 0;
    let high = snapshots.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (String(snapshots[middle]?.createdAt || "") < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const firstAfter = (target) => {
    if (!target) return snapshots.length;
    let low = 0;
    let high = snapshots.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (String(snapshots[middle]?.createdAt || "") <= target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return { start: firstAtOrAfter(start), end: firstAfter(end) };
}

function hasCanonicalOrder(snapshots, snapshotsCanonical, snapshotsAscending) {
  return Array.isArray(snapshots) && (snapshotsCanonical || snapshotsAscending && isCanonicalUploadHistoryOrder(snapshots));
}

export function* uploadHistorySnapshotCandidates(snapshots = [], { from = "", to = "", snapshotsAscending = false, snapshotsCanonical = false } = {}) {
  const dateBounds = uploadHistoryDateBounds(from, to);
  if (hasCanonicalOrder(snapshots, snapshotsCanonical, snapshotsAscending)) {
    const range = canonicalSnapshotRange(snapshots, dateBounds);
    for (let index = range.end - 1; index >= range.start; index -= 1) {
      const snapshot = snapshots[index];
      yield snapshot;
    }
    return;
  }
  yield* filterUploadHistorySnapshots(snapshots, { from, to });
}

export function countUploadHistorySnapshotCandidates(snapshots = [], filters = {}) {
  const { from = "", to = "", snapshotsAscending = false, snapshotsCanonical = false } = filters;
  const dateBounds = uploadHistoryDateBounds(from, to);
  if (hasCanonicalOrder(snapshots, snapshotsCanonical, snapshotsAscending)) {
    const range = canonicalSnapshotRange(snapshots, dateBounds);
    return Math.max(0, range.end - range.start);
  }
  let count = 0;
  for (const _snapshot of uploadHistorySnapshotCandidates(snapshots, filters)) count += 1;
  return count;
}

export function selectUploadHistoryPage(snapshots = [], { query = "", from = "", to = "", page = 1, limit = 50, snapshotsAscending = false, snapshotsDescending = false, snapshotsCanonical = false } = {}) {
  const pageSize = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  const pageNumber = Math.max(1, Math.floor(Number(page) || 1));
  const search = String(query).trim().toLocaleLowerCase("ru-RU");
  const { start, end } = uploadHistoryDateBounds(from, to);
  if (Array.isArray(snapshots) && snapshotsDescending) {
    const offset = (pageNumber - 1) * pageSize;
    const requestedRows = [];
    let lastPageRows = [];
    let total = 0;
    for (const snapshot of snapshots) {
      const createdAt = String(snapshot.createdAt || "");
      if (start && createdAt < start || end && createdAt > end) continue;
      if (search && ![snapshot.name, snapshot.id, snapshot.sourceKey, ...snapshotSourceNames(snapshot)]
        .filter(Boolean).join(" ").toLocaleLowerCase("ru-RU").includes(search)) continue;
      const position = total;
      total += 1;
      if (position >= offset && position < offset + pageSize) requestedRows.push(snapshot);
      if (position % pageSize === 0) lastPageRows = [];
      lastPageRows.push(snapshot);
    }
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const selectedPage = Math.min(pageNumber, pageCount);
    const rows = selectedPage === pageNumber ? requestedRows : lastPageRows;
    return {
      rows,
      total,
      page: selectedPage,
      pageCount,
      hasPrevious: selectedPage > 1,
      hasNext: selectedPage < pageCount,
    };
  }
  if (hasCanonicalOrder(snapshots, snapshotsCanonical, snapshotsAscending)) {
    const range = canonicalSnapshotRange(snapshots, { start, end });
    if (!search) {
      const total = range.end - range.start;
      const pageCount = Math.max(1, Math.ceil(total / pageSize));
      const selectedPage = Math.min(pageNumber, pageCount);
      const rows = [];
      for (let index = range.end - 1 - ((selectedPage - 1) * pageSize); index >= range.start && rows.length < pageSize; index -= 1) {
        rows.push(snapshots[index]);
      }
      return { rows, total, page: selectedPage, pageCount, hasPrevious: selectedPage > 1, hasNext: selectedPage < pageCount };
    }
    const offset = (pageNumber - 1) * pageSize;
    const requestedRows = [];
    let lastPageRows = [];
    let total = 0;
    for (let index = range.end - 1; index >= range.start; index -= 1) {
      const snapshot = snapshots[index];
      const createdAt = String(snapshot.createdAt || "");
      if (start && createdAt < start || end && createdAt > end) continue;
      if (search && ![snapshot.name, snapshot.id, snapshot.sourceKey, ...snapshotSourceNames(snapshot)]
        .filter(Boolean).join(" ").toLocaleLowerCase("ru-RU").includes(search)) continue;
      const position = total;
      total += 1;
      if (position >= offset && position < offset + pageSize) requestedRows.push(snapshot);
      if (position % pageSize === 0) lastPageRows = [];
      lastPageRows.push(snapshot);
    }
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const selectedPage = Math.min(pageNumber, pageCount);
    const rows = selectedPage === pageNumber ? requestedRows : lastPageRows;
    return {
      rows,
      total,
      page: selectedPage,
      pageCount,
      hasPrevious: selectedPage > 1,
      hasNext: selectedPage < pageCount,
    };
  }
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

export function isCanonicalUploadHistoryOrder(snapshots) {
  let previous = null;
  for (const snapshot of snapshots) {
    const createdAt = String(snapshot?.createdAt ?? "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || dateKey(createdAt) !== createdAt) return false;
    if (previous && (previous.createdAt > createdAt || previous.createdAt === createdAt
      && (String(previous.id) > String(snapshot?.id) || String(previous.id).localeCompare(String(snapshot?.id)) > 0))) return false;
    previous = { id: snapshot?.id, createdAt };
  }
  return true;
}
