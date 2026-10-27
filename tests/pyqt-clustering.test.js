import test from "node:test";
import assert from "node:assert/strict";
import { clusterPyqtFeatureRows, pyqtDeviceFeatures, writePyqtDeviceFeatures } from "../src/core/pyqt-clustering.js";

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

test("clustering can cancel between iterations", async () => {
  const controller = new globalThis.AbortController();
  await assert.rejects(clusterPyqtFeatureRows(Array.from({ length: 30 }, (_, index) => [index, index % 4, index % 5, index % 3, index % 2, 1, 0, 1]), {
    maxIterations: 300,
    signal: controller.signal,
    onProgress: ({ stage }) => { if (stage === "iteration") controller.abort(); },
  }), { name: "AbortError" });
});
