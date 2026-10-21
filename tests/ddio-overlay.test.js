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
