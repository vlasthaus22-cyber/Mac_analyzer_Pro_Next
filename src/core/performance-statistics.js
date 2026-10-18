export const PERFORMANCE_METRIC_LIMIT = 500;

export function normalizePerformanceMetric(record = {}) {
  const operation = String(record.operation || "").trim();
  const durationMs = Number(record.durationMs);
  const timestamp = String(record.timestamp || "");
  if (!/^[a-z][a-z0-9_]{0,63}$/i.test(operation)
    || !Number.isFinite(durationMs) || durationMs < 0
    || !Number.isFinite(Date.parse(timestamp))) return null;
  return { operation, durationMs, timestamp };
}

export function appendPerformanceMetric(records = [], metric, limit = PERFORMANCE_METRIC_LIMIT) {
  const normalized = normalizePerformanceMetric(metric);
  if (!normalized) throw new TypeError("Метрика производительности имеет неверный формат");
  const safeLimit = Math.max(1, Math.floor(Number(limit) || PERFORMANCE_METRIC_LIMIT));
  const rows = Array.isArray(records) ? records : [];
  return [...rows.filter((row) => normalizePerformanceMetric(row)), normalized].slice(-safeLimit);
}

export class PerformanceStatisticsAccumulator {
  constructor({ operation = "", days = 7, now = Date.now() } = {}) {
    const windowDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 7)));
    this.cutoff = Number(now) - windowDays * 24 * 60 * 60 * 1000;
    this.requestedOperation = String(operation || "").trim().toLocaleLowerCase("en-US");
    this.groups = new Map();
  }

  add(candidate) {
    const metric = normalizePerformanceMetric(candidate);
    if (!metric || Date.parse(metric.timestamp) < this.cutoff
      || (this.requestedOperation && metric.operation.toLocaleLowerCase("en-US") !== this.requestedOperation)) return false;
    let summary = this.groups.get(metric.operation);
    if (!summary) {
      summary = { operation: metric.operation, count: 0, totalMs: 0, averageMs: 0, minMs: Infinity, maxMs: 0, latestAt: "" };
      this.groups.set(metric.operation, summary);
    }
    summary.count += 1;
    summary.totalMs += metric.durationMs;
    summary.minMs = Math.min(summary.minMs, metric.durationMs);
    summary.maxMs = Math.max(summary.maxMs, metric.durationMs);
    if (metric.timestamp > summary.latestAt) summary.latestAt = metric.timestamp;
    return true;
  }

  finish() {
    return [...this.groups.values()].map((summary) => ({
      ...summary,
      averageMs: summary.totalMs / summary.count,
      minMs: Number.isFinite(summary.minMs) ? summary.minMs : 0,
    })).sort((left, right) => left.operation.localeCompare(right.operation, "en-US"));
  }
}

export function aggregatePerformanceMetrics(records = [], options = {}) {
  const accumulator = new PerformanceStatisticsAccumulator(options);
  for (const candidate of Array.isArray(records) ? records : []) accumulator.add(candidate);
  return accumulator.finish();
}
