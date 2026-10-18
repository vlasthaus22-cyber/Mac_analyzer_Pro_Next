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

export function normalizeLegacyDailyStatistics(observations = []) {
  if (!Array.isArray(observations)) return [];
  return observations.flatMap((item) => {
    if (item?.kind !== "daily_stats" || !item.payload || typeof item.payload !== "object") return [];
    const observedAt = String(item.observedAt || "");
    const date = validDate(item.payload.date) || validDate(observedAt.slice(0, 10));
    if (!date) return [];
    return [{
      id: String(item.id || ""),
      date,
      observedAt,
      totalDevices: count(item.payload.totalDevices),
      newDevices: count(item.payload.newDevices),
      vendorsCount: count(item.payload.vendorsCount),
      roomsCount: count(item.payload.roomsCount),
      devicesWithAddress: count(item.payload.devicesWithAddress),
      devicesWithRoom: count(item.payload.devicesWithRoom),
    }];
  }).sort((left, right) => left.date.localeCompare(right.date)
    || left.observedAt.localeCompare(right.observedAt)
    || left.id.localeCompare(right.id));
}
