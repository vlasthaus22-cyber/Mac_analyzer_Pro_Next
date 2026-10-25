import test from "node:test";
import assert from "node:assert/strict";
import { compareFinals } from "../src/core/comparison.js";
import { carryForwardRoomDeviceFields, compactRoomHistoryDevice, compactRoomHistoryDevices } from "../src/core/room-history.js";

test("room history carries known fields through empty observations without mutating Final rows", () => {
  const original = { id: "device", mac: "00:11:22:33:44:55", model: "Model A", ip: "192.0.2.4", fieldSources: { ip: "DDIO" } };
  const first = carryForwardRoomDeviceFields([], [original]);
  const absent = carryForwardRoomDeviceFields(first.knownDevices, []);
  const returned = carryForwardRoomDeviceFields(absent.knownDevices, [{ id: "device", mac: "00:11:22:33:44:55", model: "Model B", ip: "" }]);

  assert.deepEqual(returned.devices[0], {
    id: "device", mac: "00:11:22:33:44:55", model: "Model B", ip: "192.0.2.4", fieldSources: { ip: "DDIO" },
  });
  assert.equal(returned.knownDevices[0].model, "Model B");
  assert.equal(original.ip, "192.0.2.4");
  assert.deepEqual(returned.diagnostics, []);
});

test("room history treats shared placeholders as empty and carries vendor/model confidence provenance", () => {
  const previous = [{
    id: "device-provenance",
    mac: "00:11:22:33:44:57",
    manufacturer: "Acme",
    model: "Room Kit",
    address: "HQ",
    vendorConfidence: 0.95,
    vendorSource: "IEEE OUI",
    modelConfidence: 0.84,
    modelSource: "MAC5 rule",
    fieldSources: { manufacturer: "OUI", model: "MAC5 rule", address: "IP history" },
  }];
  const current = [{
    id: "device-provenance",
    mac: "00:11:22:33:44:57",
    manufacturer: "не заполнено",
    model: "Неизвестная модель",
    address: "нет данных",
    vendorConfidence: "",
    vendorSource: "",
    modelConfidence: "",
    modelSource: "",
  }];
  const result = carryForwardRoomDeviceFields(previous, current);
  assert.equal(result.devices[0].manufacturer, "Acme");
  assert.equal(result.devices[0].model, "Room Kit");
  assert.equal(result.devices[0].address, "HQ");
  assert.equal(result.devices[0].vendorConfidence, 0.95);
  assert.equal(result.devices[0].vendorSource, "IEEE OUI");
  assert.equal(result.devices[0].modelConfidence, 0.84);
  assert.equal(result.devices[0].modelSource, "MAC5 rule");
  assert.deepEqual(result.devices[0].fieldSources, { manufacturer: "OUI", model: "MAC5 rule", address: "IP history" });
  assert.equal(result.knownDevices[0].vendorSource, "IEEE OUI");
});

test("room history reuses an explicitly compact known-device array instead of cloning its full index", () => {
  const first = carryForwardRoomDeviceFields([], [{ id: "device-a", mac: "00:11:22:33:44:55", model: "Model A" }]);
  const retained = first.knownDevices;
  const next = carryForwardRoomDeviceFields(retained, [
    { id: "device-a", mac: "00:11:22:33:44:55", model: "", ip: "192.0.2.10" },
  ], { previousIsCompact: true });

  assert.equal(next.knownDevices, retained);
  assert.equal(next.knownDevices.length, 1);
  assert.equal(next.knownDevices[0].model, "Model A");
  assert.equal(next.knownDevices[0].ip, "192.0.2.10");
});

test("room timeline can reuse projected device objects in the carried forward identity index", () => {
  const previous = compactRoomHistoryDevices([{
    id: "device-a", mac: "00:11:22:33:44:55", model: "Model A", opaque: { unused: true },
  }]);
  const current = compactRoomHistoryDevice({
    id: "device-a", mac: "00:11:22:33:44:55", model: "", ip: "192.0.2.10", opaque: { unused: true },
  });
  const carried = carryForwardRoomDeviceFields(previous, [current], { previousIsCompact: true, currentIsCompact: true });

  assert.equal(carried.devices[0].model, "Model A");
  assert.equal(carried.knownDevices[0], carried.devices[0]);
  assert.equal(carried.knownDevices[0].opaque, undefined);
});

test("room history preserves current non-empty values and does not guess ambiguous identity", () => {
  const previous = [
    { mac: "00:11:22:33:44:55", ip: "192.0.2.1", model: "A" },
    { mac: "00-11-22-33-44-55", ip: "192.0.2.2", model: "B" },
  ];
  const current = { mac: "0011.2233.4455", ip: "192.0.2.9", model: "" };
  const result = carryForwardRoomDeviceFields(previous, [current]);
  assert.deepEqual(result.devices, [current]);
  assert.equal(result.diagnostics.length, 1);
});

test("room history refuses a MAC match when another strong identifier conflicts", () => {
  const previous = [{ id: "persistent-a", deviceId: "DEV-A", mac: "00:11:22:33:44:55", ip: "192.0.2.1" }];
  const current = { id: "persistent-b", deviceId: "DEV-B", mac: "00:11:22:33:44:55", ip: "" };
  const result = carryForwardRoomDeviceFields(previous, [current]);
  assert.deepEqual(result.devices, [current]);
  assert.deepEqual(result.diagnostics[0].conflictingFields.sort(), ["deviceId", "id"]);
});

test("room history carries a compact identity and display projection instead of retaining heavy source diagnostics", () => {
  const source = {
    id: "device-compact",
    mac: "00:11:22:33:44:55",
    alternateMacs: ["00:11:22:33:44:56"],
    model: "Model A",
    room: "301",
    fieldSources: { model: "Main", room: "SmartRoom", nestedUnused: "discarded" },
    sources: [{ role: "main", file: "large.xlsx", rows: Array.from({ length: 100 }, (_, index) => index) }],
    conflicts: [{ value: "legacy", raw: "large conflict payload" }],
    opaquePayload: { bytes: "unneeded" },
  };
  const carried = carryForwardRoomDeviceFields([], [source]);
  const current = {
    id: "device-compact", mac: "00:11:22:33:44:55", alternateMacs: [], model: "", room: "",
  };
  const returned = carryForwardRoomDeviceFields(carried.knownDevices, [current]);

  assert.equal(carried.knownDevices[0].model, "Model A");
  assert.equal(carried.knownDevices[0].opaquePayload, undefined);
  assert.equal(carried.knownDevices[0].sources, undefined);
  assert.equal(carried.knownDevices[0].conflicts, undefined);
  assert.deepEqual(carried.knownDevices[0].fieldSources, { model: "Main", room: "SmartRoom" });
  assert.equal(returned.devices[0].model, "Model A");
  assert.equal(returned.devices[0].room, "301");
  assert.deepEqual(returned.devices[0].fieldSources, { model: "Main", room: "SmartRoom" });
  assert.equal(source.model, "Model A");
  assert.equal(source.room, "301");
  assert.equal(current.model, "");
  assert.equal(current.room, "");
});

test("room timeline projection drops unrelated payloads while preserving display and exact comparison fields", () => {
  const source = {
    id: "room-device", mac: "00:11:22:33:44:55", ip: "192.0.2.10", switchIp: "192.0.2.1",
    switchPort: "Gi1/0/1", manufacturer: "Acme", model: "AP-1", room: "301", source: "Main",
    fieldSources: { ip: "DDIO", opaquePayload: "drop" }, opaquePayload: { cells: new Array(10_000).fill("unused") },
  };
  const current = { ...source, ip: "192.0.2.11" };
  const projected = compactRoomHistoryDevice(source);
  const projectedCurrent = compactRoomHistoryDevice(current);
  const expected = compareFinals([source], [current], "2026-01-02T00:00:00Z");
  const actual = compareFinals([projected], [projectedCurrent], "2026-01-02T00:00:00Z");

  assert.equal(projected.opaquePayload, undefined);
  assert.equal(projected.source, "Main");
  assert.deepEqual(projected.fieldSources, { ip: "DDIO" });
  assert.deepEqual(actual.modified[0].changes, expected.modified[0].changes);
});

test("compacted room comparison baseline preserves exact classifications and displayed fields", () => {
  const previous = [
    { id: "changed", mac: "00:11:22:33:44:71", ip: "192.0.2.1", room: "301", model: "A", sources: [{ rows: [1, 2, 3] }] },
    { id: "absent", mac: "00:11:22:33:44:72", ip: "192.0.2.2", room: "301", model: "B", opaquePayload: { large: true } },
  ];
  const current = [
    { id: "changed", mac: "00:11:22:33:44:71", ip: "192.0.2.9", room: "301", model: "A" },
    { id: "added", mac: "00:11:22:33:44:73", ip: "192.0.2.3", room: "301", model: "C" },
  ];
  const expected = compareFinals(previous, current, "2026-10-17T00:00:00Z");
  const compacted = compactRoomHistoryDevices(previous);
  const actual = compareFinals(compacted, current, "2026-10-17T00:00:00Z");

  assert.deepEqual(compacted.map(({ id, mac, ip, room, model }) => ({ id, mac, ip, room, model })), previous.map(({ id, mac, ip, room, model }) => ({ id, mac, ip, room, model })));
  assert.equal(compacted[0].sources, undefined);
  assert.equal(compacted[1].opaquePayload, undefined);
  assert.deepEqual(actual.added.map((device) => device.id), expected.added.map((device) => device.id));
  assert.deepEqual(actual.absent.map((device) => device.id), expected.absent.map((device) => device.id));
  assert.deepEqual(actual.modified.map(({ after, changes }) => ({ id: after.id, changes })), expected.modified.map(({ after, changes }) => ({ id: after.id, changes })));
  assert.equal(actual.unchangedCount, expected.unchangedCount);
  assert.equal(actual.modified[0].before.room, "301");
});
