export function buildDashboardFleetSeries(analytics, snapshots = [], { snapshotsAscending = false } = {}) {
  const totals = Array.isArray(analytics?.totals) ? analytics.totals : [];
  const snapshotRows = Array.isArray(snapshots) ? snapshots : [];
  const orderedSnapshots = snapshotsAscending
    ? snapshotRows
    : [...snapshotRows].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  let previousCount = null;
  const series = totals.map((row, index) => {
    const snapshot = orderedSnapshots[index] || {};
    const count = Math.max(0, Number(row?.value) || 0);
    const item = {
      id: String(snapshot.id || index),
      name: String(snapshot.name || row?.label || snapshot.id || `Final ${index + 1}`),
      date: String(snapshot.createdAt || ""),
      count,
      delta: previousCount === null ? null : count - previousCount,
    };
    previousCount = count;
    return item;
  });
  return {
    uniqueMacs: Math.max(0, Number(analytics?.history?.uniqueMacs) || 0),
    latestCount: series.at(-1)?.count ?? Math.max(0, Number(analytics?.kpis?.devices) || 0),
    series,
  };
}
