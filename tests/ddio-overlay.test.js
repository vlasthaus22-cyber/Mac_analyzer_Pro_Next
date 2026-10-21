import test from "node:test";
import assert from "node:assert/strict";
import { applyDdIoIp, buildDdIoIndex, buildDdIoIndexFromRows } from "../src/core/ddio-overlay.js";

test("an empty DDIO source returns before scanning target devices", async () => {
  let scannedTargets = false;
  const targetDevices = {
    [Symbol.iterator]() {
      scannedTargets = true;
      throw new Error("empty DDIO must not enumerate target devices");
    },
  };
  const { index, rowCount } = await buildDdIoIndexFromRows([], {}, targetDevices);
  assert.equal(rowCount, 0);
  assert.equal(scannedTargets, false);
  assert.equal(index.size, 0);
  assert.equal(index.byDeviceId.size, 0);
});

test("DDIO overlay keeps reservation and lease evidence independent and preserves known IP", async () => {
  const { index, rowCount } = await buildDdIoIndexFromRows([
    ["00:11:22:33:44:55", "10.0.0.10", "00:11:22:33:44:55", "10.0.0.11"],
  ], { reservationMac: 0, reservationIp: 1, leaseMac: 2, leaseIp: 3 });
  assert.equal(rowCount, 1);

  const blankDevice = { mac: "001122334455", ip: "", fieldSources: {}, sources: [] };
  assert.equal(applyDdIoIp(blankDevice, index), false);
  assert.deepEqual(blankDevice.possibleIps, ["10.0.0.10", "10.0.0.11"]);
  assert.equal(blankDevice.ip, "");
  assert.equal(blankDevice.conflicts[0].reason, "multiple-exact-mac-ips");

  const knownDevice = { mac: "00:11:22:33:44:55", ip: "10.0.0.99", fieldSources: {}, sources: [] };
  assert.equal(applyDdIoIp(knownDevice, index), false);
  assert.equal(knownDevice.ip, "10.0.0.99");
});

test("DDIO Device ID contributes possible-IP evidence without assigning device IP", () => {
  const index = buildDdIoIndex([["device-7", "10.0.0.7"]], { deviceId: 0, reservationIp: 1 });
  const device = { mac: "00:11:22:33:44:55", deviceId: "device-7", ip: "", fieldSources: {}, sources: [] };
  assert.equal(applyDdIoIp(device, index), false);
  assert.deepEqual(device.possibleIps, ["10.0.0.7"]);
  assert.equal(device.ip, "");
});

test("DDIO target membership indexes primary and alternate MACs without duplicate entries", async () => {
  const { index, rowCount } = await buildDdIoIndexFromRows([
    ["00:11:22:33:44:55", "10.0.0.5", "device-5"],
    ["00:11:22:33:44:56", "10.0.0.6", "device-6"],
    ["00:11:22:33:44:57", "10.0.0.7", "device-7"],
  ], { reservationMac: 0, reservationIp: 1, deviceId: 2 }, [
    {
      mac: "001122334455",
      alternateMacs: ["00:11:22:33:44:56", "001122334455", "invalid"],
      deviceId: "device-6",
    },
  ]);

  assert.equal(rowCount, 3);
  assert.deepEqual([...index.keys()], ["00:11:22:33:44:55", "00:11:22:33:44:56"]);
  assert.deepEqual([...index.byDeviceId.keys()], ["device-6"]);
  assert.deepEqual(index.get("00:11:22:33:44:56").ips, ["10.0.0.6"]);
});

test("DDIO exact target membership survives typed-index growth across thousands of MACs", async () => {
  const macFor = (value) => value.toString(16).padStart(12, "0").match(/.{2}/g).join(":");
  const targetDevices = Array.from({ length: 2_048 }, (_, index) => ({ mac: macFor(index * 2 + 1) }));
  const rows = Array.from({ length: 4_096 }, (_, index) => [macFor(index + 1), "10.0.0.5"]);
  const { index, rowCount } = await buildDdIoIndexFromRows(rows, { reservationMac: 0, reservationIp: 1 }, targetDevices);

  assert.equal(rowCount, rows.length);
  assert.equal(index.size, targetDevices.length);
  assert.deepEqual([...index.keys()], targetDevices.map(({ mac }) => mac.toUpperCase()));
  assert.equal(index.has("00:00:00:00:00:01"), true);
  assert.equal(index.has("00:00:00:00:00:02"), false);
});

test("DDIO overlay preserves evidence when device MAC aliases repeat", () => {
  const index = buildDdIoIndex([
    ["00:11:22:33:44:55", "10.0.0.5"],
    ["00:11:22:33:44:56", "10.0.0.6"],
  ], { reservationMac: 0, reservationIp: 1 });
  const device = {
    mac: "00:11:22:33:44:55",
    alternateMacs: ["001122334455", "00:11:22:33:44:56", "001122334456"],
    ip: "",
    fieldSources: {},
    sources: [],
  };

  assert.equal(applyDdIoIp(device, index), false);
  assert.deepEqual(device.possibleIps, ["10.0.0.5", "10.0.0.6"]);
  assert.equal(device.ip, "");
  assert.equal(device.conflicts.length, 1);
  assert.deepEqual(device.conflicts[0].values, ["10.0.0.5", "10.0.0.6"]);
});
