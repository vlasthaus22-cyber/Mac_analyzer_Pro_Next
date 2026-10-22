import test from "node:test";
import assert from "node:assert/strict";
import { applyDdIoIp, applyDdIoIpWithChanges, buildDdIoIndex, buildDdIoIndexFromRows } from "../src/core/ddio-overlay.js";

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

test("DDIO application reports persisted evidence changes separately from assigned IP changes", () => {
  const mac = "00:11:22:33:44:55";
  const device = {
    mac, ip: "", possibleIps: [], possibleIpsTruncated: false,
    customFields: {}, customFieldSources: {}, fieldSources: {}, sources: [],
    conflicts: [], conflictsTruncated: false,
  };
  const index = buildDdIoIndex([
    [mac, "10.0.0.5"],
    [mac, "10.0.0.6"],
  ], { reservationMac: 0, reservationIp: 1 });

  assert.deepEqual(applyDdIoIpWithChanges(device, index), { assignedIp: false, changed: true });
  assert.deepEqual(device.possibleIps, ["10.0.0.5", "10.0.0.6"]);
  assert.equal(device.conflicts.some(({ reason }) => reason === "multiple-exact-mac-ips"), true);
  assert.deepEqual(applyDdIoIpWithChanges(device, index), { assignedIp: false, changed: false },
    "reapplying the same advisory evidence must not trigger another page write");

  const empty = { ...device, mac: "00:11:22:33:44:66", possibleIps: [], sources: [], fieldSources: {}, conflicts: [] };
  assert.deepEqual(applyDdIoIpWithChanges(empty, buildDdIoIndex()), { assignedIp: false, changed: false });
  const assigned = { ...empty, ip: "", possibleIps: [], sources: [], fieldSources: {}, conflicts: [] };
  assert.deepEqual(applyDdIoIpWithChanges(assigned, buildDdIoIndex([[assigned.mac, "10.0.0.7"]], { reservationMac: 0, reservationIp: 1 })), {
    assignedIp: true, changed: true,
  });
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

test("DDIO target membership resolves bounded candidate keys through the staged identity index", async () => {
  const requestedPages = [];
  const savedPages = [];
  const targetKeys = new Set([
    "alternateMac:02:00:00:00:00:01",
    "deviceId:device-6",
  ]);
  const macFor = (value) => [2, 0, 0, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    .map((byte) => byte.toString(16).padStart(2, "0")).join(":");
  const rows = Array.from({ length: 501 }, (_, index) => [
    macFor(index + 1), "10.0.0.5", `device-${index + 1}`, macFor(index + 10_001), "10.0.0.6",
  ]);
  const result = await buildDdIoIndexFromRows(rows, {
    reservationMac: 0,
    reservationIp: 1,
    deviceId: 2,
    leaseMac: 3,
    leaseIp: 4,
  }, {
    count: 1_000_000,
    readPage() { throw new Error("staged target lookup must not scan every Final page"); },
  }, {
    targetIdentityKeys: async (keys) => {
      requestedPages.push(keys);
      return new Set(keys.filter((key) => targetKeys.has(key)));
    },
    onIndexPage: async (index) => {
      savedPages.push({ mac: [...index], device: [...index.byDeviceId] });
      return index.size + index.byDeviceId.size;
    },
  });

  assert.equal(result.rowCount, 501);
  assert.equal(result.offloaded, true);
  assert.equal(requestedPages.length, 2);
  assert.deepEqual(requestedPages.map((keys) => keys.length), [2_500, 5]);
  assert.deepEqual(savedPages.flatMap((page) => page.mac.map(([mac]) => mac)), ["02:00:00:00:00:01"]);
  assert.deepEqual(savedPages.flatMap((page) => page.device.map(([key]) => key)), ["device-6"]);
  assert.equal(result.index.size, 0);
  assert.equal(result.index.byDeviceId.size, 0);
});

test("DDIO target lookup aborts before processing a batch when IndexedDB lookup is cancelled", async () => {
  const controller = new globalThis.AbortController();
  const macFor = (value) => [2, 0, 0, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    .map((byte) => byte.toString(16).padStart(2, "0")).join(":");
  const rows = Array.from({ length: 500 }, (_, index) => [macFor(index + 1), "10.0.0.5"]);
  let saved = false;
  await assert.rejects(buildDdIoIndexFromRows(rows, { reservationMac: 0, reservationIp: 1 }, { count: rows.length }, {
    signal: controller.signal,
    targetIdentityKeys: async () => {
      controller.abort();
      return new Set();
    },
    onIndexPage: async () => { saved = true; return 1; },
  }), { name: "AbortError" });
  assert.equal(saved, false, "cancelled target batches do not spill partial evidence");
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
