export async function runAnalyticsInStages({
  calculatePair,
  calculateDetails,
  isCurrent,
  paintSummary,
  paintDetails,
  schedule,
  onError = () => {},
}) {
  const pair = await calculatePair();
  if (!isCurrent()) return null;
  paintSummary(pair);
  schedule(async () => {
    if (!isCurrent()) return;
    try {
      const details = await calculateDetails(pair);
      if (details && isCurrent()) paintDetails(pair, details);
    } catch (error) {
      if (isCurrent()) onError(error);
    }
  });
  return pair;
}

export function usableAnalyticsFallback(analytics) {
  return analytics?.detailsReady === true
    && Boolean(analytics.current?.id)
    && Boolean(analytics.comparison)
    ? analytics
    : null;
}

export function reuseInFlightRequest(requests, key, operation) {
  const existing = requests.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(operation);
  requests.set(key, promise);
  const clear = () => {
    if (requests.get(key) === promise) requests.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

export function createBoundedComparisonPageCache({ maxEntries = 12, maxRows = 1_200 } = {}) {
  const entryLimit = Math.max(1, Math.floor(Number(maxEntries) || 12));
  const rowLimit = Math.max(1, Math.floor(Number(maxRows) || 1_200));
  const entries = new Map();
  let rowCount = 0;
  const removeOldest = () => {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    rowCount -= entries.get(oldest).rowCount;
    entries.delete(oldest);
  };
  const copyPage = (page) => ({
    ...page,
    ...(Array.isArray(page.rows) ? { rows: [...page.rows] } : {}),
    ...(Array.isArray(page.events) ? { events: [...page.events] } : {}),
    ...(Array.isArray(page.devices) ? { devices: [...page.devices] } : {}),
  });
  return {
    get(key) {
      const entry = entries.get(String(key));
      if (!entry) return null;
      entries.delete(String(key));
      entries.set(String(key), entry);
      return copyPage(entry.page);
    },
    set(key, page) {
      if (!key || !page || typeof page !== "object") return false;
      const rows = page.rows || page.events || page.devices || [];
      const count = Array.isArray(rows) ? rows.length : 0;
      if (count > rowLimit) return false;
      const normalizedKey = String(key);
      if (entries.has(normalizedKey)) {
        rowCount -= entries.get(normalizedKey).rowCount;
        entries.delete(normalizedKey);
      }
      entries.set(normalizedKey, { page: copyPage(page), rowCount: count });
      rowCount += count;
      while (entries.size > entryLimit || rowCount > rowLimit) removeOldest();
      return entries.has(normalizedKey);
    },
    clear() {
      entries.clear();
      rowCount = 0;
    },
    get size() { return entries.size; },
    get rowCount() { return rowCount; },
  };
}

export async function feedAnalyticsDatasetRows({ snapshotId = "", devices, visitChunks, accept, isCurrent = () => true }) {
  if (typeof accept !== "function") throw new TypeError("Analytics dataset consumer must be a function");
  if (Array.isArray(devices)) {
    for (let offset = 0; offset < devices.length; offset += 500) {
      if (!isCurrent()) return "stale";
      await accept(devices.slice(offset, offset + 500), offset);
    }
    return "payload";
  }
  if (!snapshotId || typeof visitChunks !== "function") return "empty";
  await visitChunks(snapshotId, async (chunk, chunkIndex = 0, ...metadata) => {
    if (!isCurrent()) return false;
    const startOffset = Number.isInteger(chunkIndex) ? chunkIndex * 500 : 0;
    await accept(chunk, startOffset, ...metadata);
    return isCurrent();
  });
  return isCurrent() ? "chunks" : "stale";
}
