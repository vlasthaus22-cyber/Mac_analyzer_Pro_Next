import test from "node:test";
import assert from "node:assert/strict";
import { fillFromPreviewCatalog, filePreviewLookupDevice } from "../src/core/file-preview.js";
import { enrich } from "../src/core/enrichment.js";
import { normalizeDevice } from "../src/core/normalize.js";
import { createCollector } from "../src/core/analytics-detail.js";
import { fullRoomAddress } from "../src/ui/render.js";

test("Main MAC count is distinct before SmartRoom expansion or identity merging", async () => {
  const mainRows = [
    ["02:00:00:00:00:01", "D1"], ["020000000001", "D1"],
    ["02:00:00:00:00:02", "D1"], ["", "D2"],
  ];
  const result = await enrich({
    mainRows, smartroomRows: [["02:00:00:00:00:03", "D3"]],
    mappings: { main: { mac: 0, deviceId: 1 }, smartroom: { mac: 0, deviceId: 1 } },
    strategy: "ALLOW_EXPANSION",
  });
  assert.equal(result.diagnostics.counts.mainUniqueMacs, 2);
  assert.ok(result.devices.some((row) => row.deviceId === "D3"));
});

test("full location paths preserve street and actual room; a known room is not counted as missing", () => {
  const path = "ЦА, Москва, ул. Тверская, дом 8, 2 этаж, Переговорная 204";
  const device = normalizeDevice({ mac: "02:00:00:00:00:01", room: path });
  assert.equal(device.room, "Переговорная 204");
  assert.equal(device.floor, "2 этаж");
  assert.equal(device.address, "ул. Тверская, дом 8");
  assert.equal(device.locationPath, path);
  assert.equal(fullRoomAddress(device), path);
  assert.equal(normalizeDevice({ address: path }).room, "");
  const collector = createCollector({ countFinalRows: true });
  collector.accept([device, { id: "different-identity", mac: device.mac, smartroomId: "S1" }, { id: "no-room" }]);
  const dataset = collector.finish();
  assert.equal(dataset.summary.devices, 3);
  assert.equal(dataset.roomOccupancy.assignedDevices, 2);
  assert.equal(dataset.roomOccupancy.unassignedDevices, 1);
});

test("file preview fills blanks on a copy and refuses conflicting identifiers", () => {
  const input = normalizeDevice({ mac: "02:00:00:00:00:01", manufacturer: "File vendor", serial: "s1" });
  const stored = { id: "known", mac: input.mac, serial: "s1", manufacturer: "Catalog vendor", model: "Model", room: "101" };
  assert.ok(filePreviewLookupDevice(input).id);
  const found = fillFromPreviewCatalog(input, [stored]);
  assert.equal(found.match, "found");
  assert.equal(found.device.manufacturer, "File vendor");
  assert.equal(found.device.model, "Model");
  assert.equal(found.device.fieldSources.room, "Локальный Inventory");
  assert.equal(input.room, "");
  assert.equal(fillFromPreviewCatalog(input, [{ ...stored, serial: "s2" }]).match, "review");
  assert.equal(filePreviewLookupDevice({ ip: "10.0.0.1" }), null);
});
