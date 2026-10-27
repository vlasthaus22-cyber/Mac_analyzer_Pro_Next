import test from "node:test";
import assert from "node:assert/strict";
import { clusterPyqtFeatureRows, compactPyqtClusterLabels, pyqtDeviceFeatures, writePyqtDeviceFeatures } from "../src/core/pyqt-clustering.js";

test("PyQt clustering features retain the eight source dimensions and empty markers", () => {
  assert.deepEqual(pyqtDeviceFeatures({
    mac: "AA:BB:CC:00:00:01", vendor: "Acme", model: "Router", address: "Room 1",
    ip: "Unknown", room: "Не указано", switchIp: "10.0.0.1", switchPort: "2/3",
  }), [17, 4, 6, 6, 0, 0, 1, 1]);
  assert.deepEqual(pyqtDeviceFeatures({ mac: "", manufacturer: "Vendor", physicalAddress: "A" }), [0, 6, 0, 1, 0, 0, 0, 0]);
  const target = new Float32Array(10);
  writePyqtDeviceFeatures({ mac: "M", room: "Office" }, target, 2);
  assert.deepEqual([...target], [0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
  assert.throws(() => writePyqtDeviceFeatures({}, target, 4), RangeError);
});

test("PyQt clustering reports insufficient rows and validates finite feature values", async () => {
  assert.deepEqual(await clusterPyqtFeatureRows([[1, 2, 3, 4, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]]), {
    status: "insufficient-data", labels: new Uint8Array(), clusterCount: 0, inertia: 0,
  });
  await assert.rejects(clusterPyqtFeatureRows([[1, 2, 3, 4, 0, 0, 0, 0], [1, 2, 3, 4, 0, 0, 0, 0], [NaN, 2, 3, 4, 0, 0, 0, 0]]), /конечным числом/);
});

test("standardized KMeans is deterministic, multi-start and returns one label per device", async () => {
  const groups = [
    [17, 8, 8, 6, 1, 1, 1, 1], [17, 8, 8, 6, 1, 1, 1, 1], [17, 8, 8, 6, 1, 1, 1, 1],
    [12, 0, 0, 0, 0, 0, 0, 0], [12, 0, 0, 0, 0, 0, 0, 0], [12, 0, 0, 0, 0, 0, 0, 0],
    [17, 6, 6, 4, 1, 1, 0, 0], [17, 6, 6, 4, 1, 1, 0, 0], [17, 6, 6, 4, 1, 1, 0, 0],
  ];
  const first = await clusterPyqtFeatureRows(groups, { restarts: 4 });
  const second = await clusterPyqtFeatureRows(groups, { restarts: 4 });
  assert.equal(first.status, "ok");
  assert.equal(first.clusterCount, 3);
  assert.equal(first.labels.length, groups.length);
  assert.deepEqual(first.labels, second.labels);
  assert.ok(Number.isFinite(first.inertia));
  assert.equal(new Set(first.labels).size, 3);
});

test("observed KMeans labels omit empty groups and match the groups PyQt actually displays", async () => {
  const identical = Float32Array.from({ length: 3 * 8 }, () => 0);
  const result = await clusterPyqtFeatureRows(identical, { restarts: 2 });
  const compacted = compactPyqtClusterLabels(result.labels);
  assert.equal(result.clusterCount, 3, "the estimator still uses the requested maximum");
  assert.equal(compacted.clusterCount, 1, "identical feature rows produce one observed group");
  assert.deepEqual([...compacted.labels], [0, 0, 0]);

  const sparse = compactPyqtClusterLabels(Uint8Array.from([2, 2, 0, 2, 0]));
  assert.equal(sparse.clusterCount, 2);
  assert.deepEqual([...sparse.labels], [0, 0, 1, 0, 1]);
  assert.throws(() => compactPyqtClusterLabels([0, 1]), /типизированным массивом/);
});

test("clustering can cancel between iterations", async () => {
  const controller = new globalThis.AbortController();
  await assert.rejects(clusterPyqtFeatureRows(Array.from({ length: 30 }, (_, index) => [index, index % 4, index % 5, index % 3, index % 2, 1, 0, 1]), {
    maxIterations: 300,
    signal: controller.signal,
    onProgress: ({ stage }) => { if (stage === "iteration") controller.abort(); },
  }), { name: "AbortError" });
});
