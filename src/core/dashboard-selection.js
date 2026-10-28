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
  const count = Array.isArray(snapshots) ? snapshots.length : 0;
  if (!count) return { baselineId: "", comparisonId: "" };
  const orderedBefore = (left, right) => left.time < right.time || (left.time === right.time && left.index < right.index);
  let latest = null;
  let requestedComparison = null;
  const periodMode = settings.comparisonMode === "period";
  const fromTime = utcDayStart(settings.comparisonDateFrom) ?? -Infinity;
  const toTime = utcDayEnd(settings.comparisonDateTo) ?? Infinity;
  let latestThroughEnd = null;
  for (let index = 0; index < count; index += 1) {
    const snapshot = snapshots[index];
    const row = { snapshot, index, time: timestamp(snapshot) };
    if (!latest || orderedBefore(latest, row)) latest = row;
    if (!periodMode && snapshot?.id === settings.currentSnapshotId
      && (!requestedComparison || orderedBefore(row, requestedComparison))) requestedComparison = row;
    if (periodMode && row.time <= toTime && (!latestThroughEnd || orderedBefore(latestThroughEnd, row))) latestThroughEnd = row;
  }
  const comparison = periodMode ? (latestThroughEnd || latest) : (requestedComparison || latest);
  if (count === 1) return { baselineId: comparison.snapshot?.id || "", comparisonId: comparison.snapshot?.id || "" };

  if (!periodMode) {
    let requestedBaseline = null;
    let adjacentBaseline = null;
    for (let index = 0; index < count; index += 1) {
      const snapshot = snapshots[index];
      const row = { snapshot, index, time: timestamp(snapshot) };
      if (snapshot?.id === settings.baseSnapshotId && snapshot.id !== comparison.snapshot?.id
        && (!requestedBaseline || orderedBefore(row, requestedBaseline))) requestedBaseline = row;
      if (orderedBefore(row, comparison) && (!adjacentBaseline || orderedBefore(adjacentBaseline, row))) adjacentBaseline = row;
    }
    return {
      baselineId: (requestedBaseline || adjacentBaseline || comparison).snapshot?.id || "",
      comparisonId: comparison.snapshot?.id || "",
    };
  }

  let firstInRange = null;
  let lastBeforeRange = null;
  let lastEligible = null;
  for (let index = 0; index < count; index += 1) {
    const snapshot = snapshots[index];
    const row = { snapshot, index, time: timestamp(snapshot) };
    if (snapshot?.id === comparison.snapshot?.id || row.time > comparison.time) continue;
    if (!lastEligible || orderedBefore(lastEligible, row)) lastEligible = row;
    if (row.time >= fromTime && row.time <= toTime) {
      if (!firstInRange || orderedBefore(row, firstInRange)) firstInRange = row;
    } else if (row.time < fromTime && (!lastBeforeRange || orderedBefore(lastBeforeRange, row))) {
      lastBeforeRange = row;
    }
  }
  const baseline = firstInRange || lastBeforeRange || lastEligible || comparison;
  return { baselineId: baseline.snapshot?.id || "", comparisonId: comparison.snapshot?.id || "" };
}
