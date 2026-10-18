import test from "node:test";
import assert from "node:assert/strict";
import { aggregatePerformanceMetrics, appendPerformanceMetric, normalizePerformanceMetric, PERFORMANCE_METRIC_LIMIT } from "../src/core/performance-statistics.js";

test("performance metrics accept only bounded operation labels and valid durations and timestamps", () => {
  assert.deepEqual(normalizePerformanceMetric({ operation: "export_csv", durationMs: 125.5, timestamp: "2026-10-15T10:00:00Z" }), {
    operation: "export_csv", durationMs: 125.5, timestamp: "2026-10-15T10:00:00Z",
  });
  assert.equal(normalizePerformanceMetric({ operation: "Main file customer.xlsx", durationMs: 2, timestamp: "2026-10-15T10:00:00Z" }), null);
  assert.equal(normalizePerformanceMetric({ operation: "enrichment", durationMs: -1, timestamp: "2026-10-15T10:00:00Z" }), null);
  assert.equal(normalizePerformanceMetric({ operation: "enrichment", durationMs: 1, timestamp: "invalid" }), null);
});

test("performance metric journal is capped and aggregates average, min, max and calls by operation", () => {
  const start = Date.parse("2026-10-15T00:00:00Z");
  let records = [];
  records = appendPerformanceMetric(records, { operation: "enrichment", durationMs: 1_000, timestamp: new Date(start - 2 * 86_400_000).toISOString() });
  records = appendPerformanceMetric(records, { operation: "enrichment", durationMs: 500, timestamp: new Date(start - 86_400_000).toISOString() });
  records = appendPerformanceMetric(records, { operation: "export_csv", durationMs: 200, timestamp: new Date(start - 60_000).toISOString() });
  records = appendPerformanceMetric(records, { operation: "export_csv", durationMs: 400, timestamp: new Date(start - 30_000).toISOString() });
  records = appendPerformanceMetric(records, { operation: "enrichment", durationMs: 99, timestamp: new Date(start - 9 * 86_400_000).toISOString() });

  const stats = aggregatePerformanceMetrics(records, { days: 7, now: start });
  assert.deepEqual(stats.map(({ operation, count, averageMs, minMs, maxMs }) => ({ operation, count, averageMs, minMs, maxMs })), [
    { operation: "enrichment", count: 2, averageMs: 750, minMs: 500, maxMs: 1_000 },
    { operation: "export_csv", count: 2, averageMs: 300, minMs: 200, maxMs: 400 },
  ]);
  assert.equal(aggregatePerformanceMetrics(records, { operation: "export_csv", days: 7, now: start }).length, 1);
  assert.equal(appendPerformanceMetric(Array.from({ length: PERFORMANCE_METRIC_LIMIT }, (_, index) => ({
    operation: "enrichment", durationMs: index, timestamp: "2026-10-15T00:00:00Z",
  })), { operation: "enrichment", durationMs: 999, timestamp: "2026-10-15T00:00:00Z" }).length, PERFORMANCE_METRIC_LIMIT);
});
