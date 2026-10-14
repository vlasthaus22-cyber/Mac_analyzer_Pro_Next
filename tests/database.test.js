import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/data/database.js";

test("Final, Inventory and History are committed and restored", async () => {
  const database = new Database(`test-${crypto.randomUUID()}`);
  const first = [
    { id: "device-a", mac: "00:11:22:33:44:55", ip: "10.0.0.1", model: "A" },
    { id: "device-b", mac: "AA:BB:CC:DD:EE:FF", ip: "10.0.0.2", model: "B" },
  ];
  await database.saveFinal({ id: "final-1", name: "First", createdAt: "2026-01-01T00:00:00Z", devices: first });
  await database.saveFinal({
    id: "final-2",
    name: "Second",
    createdAt: "2026-01-02T00:00:00Z",
    devices: [{ ...first[0], ip: "10.0.0.10" }],
    comparison: {
      modified: [{ after: { ...first[0], ip: "10.0.0.10" }, changes: [{ field: "ip", label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.10", timestamp: "2026-01-02T00:00:00Z" }] }],
      added: [],
      absent: [first[1]],
    },
  });
  const active = await database.activeSnapshot();
  assert.equal(active.id, "final-2");
  assert.equal(active.devices.length, 1);
  const inventory = await database.inventory();
  assert.equal(inventory.length, 2);
  assert.equal(inventory.find((item) => item.id === "device-b").present, false);
  const history = await database.history("device-a");
  assert.equal(history.length, 1);
  assert.equal(history[0].newValue, "10.0.0.10");
});

test("portable archive roundtrip keeps snapshots", async () => {
  const source = new Database(`source-${crypto.randomUUID()}`);
  await source.saveFinal({ id: "one", name: "One", devices: [{ id: "a", mac: "00:11:22:33:44:55" }] });
  const archive = await source.exportArchive();
  const target = new Database(`target-${crypto.randomUUID()}`);
  await target.importArchive(archive);
  assert.equal((await target.listSnapshots()).length, 1);
  assert.equal((await target.activeSnapshot()).devices[0].mac, "00:11:22:33:44:55");
});

