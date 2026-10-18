function timestamp(snapshot) {
  const raw = snapshot?.fileCreatedAt || snapshot?.createdAt || snapshot?.created_at || snapshot?.savedAt || "";
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : 0;
}

function utcDayStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value ? date.getTime() : null;
}

function utcDayEnd(value) {
  const start = utcDayStart(value);
  return start === null ? null : start + 86_400_000 - 1;
}

export function resolveDashboardSnapshotPair(snapshots = [], settings = {}) {
  const ordered = snapshots.map((snapshot, index) => ({ snapshot, index, time: timestamp(snapshot) }))
    .sort((left, right) => left.time - right.time || left.index - right.index);
  if (!ordered.length) return { baselineId: "", comparisonId: "" };
  if (ordered.length === 1) return { baselineId: ordered[0].snapshot.id, comparisonId: ordered[0].snapshot.id };

  if (settings.comparisonMode !== "period") {
    const requestedIndex = ordered.findIndex(({ snapshot }) => snapshot.id === settings.currentSnapshotId);
    const comparisonIndex = requestedIndex >= 0 ? requestedIndex : ordered.length - 1;
    const comparison = ordered[comparisonIndex];
    const requestedBaseline = ordered.find(({ snapshot }) => snapshot.id === settings.baseSnapshotId && snapshot.id !== comparison.snapshot.id);
    const adjacentBaseline = ordered[Math.max(0, comparisonIndex - 1)];
    return { baselineId: requestedBaseline?.snapshot.id || adjacentBaseline.snapshot.id, comparisonId: comparison.snapshot.id };
  }
  const fromTime = utcDayStart(settings.comparisonDateFrom) ?? -Infinity;
  const toTime = utcDayEnd(settings.comparisonDateTo) ?? Infinity;
  const comparison = ordered.filter(({ time }) => time <= toTime).at(-1) || ordered.at(-1);
  const beforeComparison = ordered.filter(({ snapshot }) => snapshot.id !== comparison.snapshot.id && timestamp(snapshot) <= comparison.time);
  const baseline = beforeComparison.filter(({ time }) => time >= fromTime && time <= toTime)[0]
    || beforeComparison.filter(({ time }) => time < fromTime).at(-1)
    || beforeComparison.at(-1)
    || comparison;
  return { baselineId: baseline.snapshot.id, comparisonId: comparison.snapshot.id };
}
