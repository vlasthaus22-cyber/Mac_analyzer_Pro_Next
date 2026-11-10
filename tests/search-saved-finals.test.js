import test from "node:test";
import assert from "node:assert/strict";
import { searchSavedFinalSnapshots } from "../src/core/search.js";

const snapshotDevices = {
  older: [
    { mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Codec X", room: "North" },
    { mac: "00:11:22:33:44:66", manufacturer: "Acme", model: "Codec Y", room: "South" },
  ],
  newer: [
    { mac: "00-11-22-33-44-55", manufacturer: "Acme", model: "Codec X2", room: "West" },
    { mac: "00:11:22:33:44:77", manufacturer: "Other", model: "Codec Z", room: "East" },
  ],
};

test("saved Final search scans newest first and keeps the latest row for each MAC", async () => {
  const visited = [];
  const result = await searchSavedFinalSnapshots("Codec", {
    snapshots: [
      { id: "older", name: "Final 1", createdAt: "2026-01-01" },
      { id: "newer", name: "Final 2", createdAt: "2026-02-01" },
    ],
    iterateSnapshotDevices: async function* (id) {
      visited.push(id);
      yield* snapshotDevices[id];
    },
  });

  assert.deepEqual(visited, ["newer", "older"]);
  assert.equal(result.scanned, 4);
  assert.equal(result.snapshotsScanned, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rows.map((row) => [row.mac, row.model, row.snapshotId, row.deviceIndex]), [
    ["00:11:22:33:44:55", "Codec X2", "newer", 0],
    ["00:11:22:33:44:77", "Codec Z", "newer", 1],
    ["00:11:22:33:44:66", "Codec Y", "older", 1],
  ]);
});

test("saved Final search matches the same supported fields and bounds results", async () => {
  const result = await searchSavedFinalSnapshots("west", {
    snapshots: [{ id: "newer", name: "Final" }],
    limit: 1,
    iterateSnapshotDevices: async function* (id) {
      yield* snapshotDevices[id];
    },
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].room, "West");
  assert.equal(result.truncated, false);

  const truncated = await searchSavedFinalSnapshots("Codec", {
    snapshots: [{ id: "newer" }],
    limit: 1,
    iterateSnapshotDevices: async function* (id) { yield* snapshotDevices[id]; },
  });
  assert.equal(truncated.rows.length, 1);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.scanned, 2);
});

test("saved Final search keeps room, postal address, and physical address as separate values", async () => {
  const result = await searchSavedFinalSnapshots("10.20.30.40", {
    snapshots: [{ id: "mapped", name: "Mapped Final" }],
    iterateSnapshotDevices: async function* () {
      yield {
        mac: "00:11:22:33:44:88",
        room: "Office 14",
        address: "Building B, Example Street 10",
        physicalAddress: "Rack 2, Unit 4",
        ip: "10.20.30.40",
      };
    },
  });
  assert.deepEqual(
    [result.rows[0].room, result.rows[0].address, result.rows[0].physicalAddress],
    ["Office 14", "Building B, Example Street 10", "Rack 2, Unit 4"],
  );
});

test("saved Final search finds a device by its user-defined custom field", async () => {
  const result = await searchSavedFinalSnapshots("North closet", {
    snapshots: [{ id: "custom", name: "Custom fields" }],
    iterateSnapshotDevices: async function* () {
      yield { ...snapshotDevices.older[0], customFields: { "Rack label": "North closet" } };
    },
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].mac, "00:11:22:33:44:55");
});

test("saved Final search returns and deduplicates serial-identified devices without a MAC", async () => {
  const result = await searchSavedFinalSnapshots("SER-998", {
    snapshots: [
      { id: "older", name: "Previous Final" },
      { id: "newer", name: "Current Final" },
    ],
    iterateSnapshotDevices: async function* (id) {
      yield { serial: "SER-998", model: id === "newer" ? "Updated model" : "Old model" };
    },
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].mac, "");
  assert.equal(result.rows[0].macFormatted, "SER-998");
  assert.equal(result.rows[0].snapshotId, "newer");
  assert.equal(result.rows[0].model, "Updated model");
});

test("saved Final search validates the reader and responds to cancellation", async () => {
  await assert.rejects(searchSavedFinalSnapshots("x", { snapshots: [{ id: "x" }] }), /iterateSnapshotDevices/);

  const controller = new globalThis.AbortController();
  const result = searchSavedFinalSnapshots("Acme", {
    snapshots: [{ id: "newer" }],
    signal: controller.signal,
    iterateSnapshotDevices: async function* (id) {
      yield snapshotDevices[id][0];
      controller.abort();
      yield snapshotDevices[id][1];
    },
  });
  await assert.rejects(result, { name: "AbortError" });
  await assert.rejects(searchSavedFinalSnapshots("x", { limit: 501, iterateSnapshotDevices: async function* () {} }), /limit/);
});
