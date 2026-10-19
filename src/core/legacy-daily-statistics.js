function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function validDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : "";
}

function normalizedDailyStatistic(item) {
  if (item?.kind !== "daily_stats" || !item.payload || typeof item.payload !== "object") return null;
  const observedAt = String(item.observedAt || "");
  const date = validDate(item.payload.date) || validDate(observedAt.slice(0, 10));
  if (!date) return null;
  return {
    id: String(item.id || ""),
    date,
    observedAt,
    totalDevices: count(item.payload.totalDevices),
    newDevices: count(item.payload.newDevices),
    vendorsCount: count(item.payload.vendorsCount),
    roomsCount: count(item.payload.roomsCount),
    devicesWithAddress: count(item.payload.devicesWithAddress),
    devicesWithRoom: count(item.payload.devicesWithRoom),
  };
}

/** Keep only the newest imported row for each day, matching PyQt's daily_stats table. */
export function createLegacyDailyStatisticsAccumulator({ fromDate = "", throughDate = "" } = {}) {
  const latestByDate = new Map();
  return {
    add(item) {
      const row = normalizedDailyStatistic(item);
      if (!row || (fromDate && row.date < fromDate) || (throughDate && row.date > throughDate)) return false;
      const current = latestByDate.get(row.date);
      if (!current || row.observedAt > current.observedAt || (row.observedAt === current.observedAt && row.id > current.id)) {
        latestByDate.set(row.date, row);
      }
      return true;
    },
    finish() {
      return [...latestByDate.values()].sort((left, right) => left.date.localeCompare(right.date)
        || left.observedAt.localeCompare(right.observedAt)
        || left.id.localeCompare(right.id));
    },
  };
}

export function normalizeLegacyDailyStatistics(observations = []) {
  if (!Array.isArray(observations)) return [];
  return observations.map(normalizedDailyStatistic).filter(Boolean).sort((left, right) => left.date.localeCompare(right.date)
    || left.observedAt.localeCompare(right.observedAt)
    || left.id.localeCompare(right.id));
}
