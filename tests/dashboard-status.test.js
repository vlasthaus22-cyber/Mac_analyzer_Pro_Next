import test from "node:test";
import assert from "node:assert/strict";
import { compareFinalAbsencePage, compareFinalAdditionPage, compareFinalDevicePage, compareFinalModifiedDevicePage, compareFinalUnchangedPage } from "../src/core/comparison.js";

const previous = [
  { deviceId: "one", mac: "00:11:22:33:44:51", manufacturer: "Vendor", room: "Room 1" },
  { deviceId: "two", mac: "00:11:22:33:44:52", manufacturer: "Vendor", room: "Room 1" },
  { deviceId: "three", mac: "00:11:22:33:44:53", manufacturer: "Vendor", room: "Room 1" },
];
const current = [
  { ...previous[0], room: "Room 1" },
  { ...previous[1], room: "Room 2" },
  { deviceId: "four", mac: "00:11:22:33:44:54", manufacturer: "Vendor" },
];

test("all-status roster streams bounded pages and applies dashboard filters before counting", async () => {
  const rows = Array.from({ length: 275 }, (_, index) => ({ deviceId: `device-${index}`, manufacturer: index % 2 ? "Vendor A" : "Vendor B" }));
  const visitor = async (visit) => {
    await visit(rows.slice(0, 120));
    await visit(rows.slice(120));
  };
  const page = await compareFinalDevicePage(visitor, { offset: 100, limit: 50, deviceMatches: (device) => device.manufacturer === "Vendor A" });
  assert.equal(page.total, 137);
  assert.equal(page.devices.length, 37);
  assert.equal(page.devices[0].deviceId, "device-201");
  assert.equal(page.hasNext, false);
  const first = await compareFinalDevicePage(visitor, { limit: 100 });
  assert.equal(first.total, rows.length);
  assert.equal(first.devices.length, 100);
  assert.equal(first.hasNext, true);
});

test("streamed unchanged status roster returns exact bounded pages using the shared strong identity and change rules", async () => {
  const visitor = async (visit) => { visit(current.slice(0, 1)); visit(current.slice(1)); };
  const first = await compareFinalUnchangedPage(previous, visitor, { offset: 0, limit: 1 });
  assert.equal(first.total, 1);
  assert.equal(first.devices[0].deviceId, "one");
  assert.equal(first.hasNext, false);
});

test("unchanged roster excludes matched records with known field changes and absent/added devices", async () => {
  const result = await compareFinalUnchangedPage(previous, async (visit) => visit(current), { limit: 10 });
  assert.deepEqual(result.devices.map((device) => device.deviceId), ["one"]);
  assert.equal(result.total, 1);
});

test("modified status roster pages unique devices despite multiple changed fields", async () => {
  const before = [
    { deviceId: "modified-a", mac: "00:11:22:33:44:71", model: "A", room: "North" },
    { deviceId: "modified-b", mac: "00:11:22:33:44:72", model: "B", room: "South" },
    { deviceId: "same", mac: "00:11:22:33:44:73", model: "C", room: "North" },
  ];
  const after = [
    { ...before[0], model: "A2", room: "North 2" },
    { ...before[1], model: "B2" },
    { ...before[2] },
  ];
  const visitChunks = async (visit) => { visit(after.slice(0, 1)); visit(after.slice(1)); };
  const first = await compareFinalModifiedDevicePage(before, visitChunks, { offset: 0, limit: 1 });
  const second = await compareFinalModifiedDevicePage(before, visitChunks, { offset: 1, limit: 1 });
  assert.equal(first.total, 2);
  assert.deepEqual(first.devices.map(({ deviceId }) => deviceId), ["modified-a"]);
  assert.equal(first.hasNext, true);
  assert.deepEqual(second.devices.map(({ deviceId }) => deviceId), ["modified-b"]);
  assert.equal(second.hasNext, false);
  const filtered = await compareFinalModifiedDevicePage(before, visitChunks, { deviceMatches: (device) => device.room === "North 2" });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.devices.map(({ deviceId }) => deviceId), ["modified-a"]);
});

test("status detail pages match identities across the full pair before filtering each status row", async () => {
  const before = [
    { deviceId: "keep-a", mac: "00:11:22:33:44:61", manufacturer: "Vendor A" },
    { deviceId: "keep-b", mac: "00:11:22:33:44:62", manufacturer: "Vendor B" },
    { deviceId: "missing-a", mac: "00:11:22:33:44:63", manufacturer: "Vendor A" },
  ];
  const after = [
    { ...before[0] },
    { ...before[1] },
    { deviceId: "added-b", mac: "00:11:22:33:44:64", manufacturer: "Vendor B" },
  ];
  const visitAll = async (visit) => visit(after);
  const matches = (device) => device.manufacturer === "Vendor A";
  const absent = await compareFinalAbsencePage(before, visitAll, { deviceMatches: matches });
  const added = await compareFinalAdditionPage(before, visitAll, { deviceMatches: matches });
  const unchanged = await compareFinalUnchangedPage(before, visitAll, { deviceMatches: matches });
  assert.deepEqual(absent.devices.map(({ deviceId }) => deviceId), ["missing-a"]);
  assert.equal(absent.total, 1);
  assert.deepEqual(added.devices, []);
  assert.equal(added.total, 0);
  assert.deepEqual(unchanged.devices.map(({ deviceId }) => deviceId), ["keep-a"]);
  assert.equal(unchanged.total, 1);
});
