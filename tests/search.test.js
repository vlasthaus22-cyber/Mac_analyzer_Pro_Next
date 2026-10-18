import test from "node:test";
import assert from "node:assert/strict";
import { matchesDeviceSearch } from "../src/core/search.js";

test("global device search matches normalized primary and alternate MAC forms", () => {
  const device = { mac: "00:11:22:33:44:55", alternateMacs: ["AA:BB:CC:DD:EE:FF"] };
  assert.equal(matchesDeviceSearch(device, "001122334455"), true);
  assert.equal(matchesDeviceSearch(device, "00-11-22"), true);
  assert.equal(matchesDeviceSearch(device, "aabb.ccdd.eeff"), true);
  assert.equal(matchesDeviceSearch(device, "001122334456"), false);
});

test("MAC search normalization does not reinterpret an IP address as a MAC fragment", () => {
  assert.equal(matchesDeviceSearch({ mac: "10:00:00:00:00:01" }, "10.0.0.1"), false);
  assert.equal(matchesDeviceSearch({ ip: "10.0.0.1" }, "10.0.0.1"), true);
});

test("global device search finds DDIO possible IP evidence without treating it as the assigned IP", () => {
  const device = { ip: "10.0.0.1", possibleIps: ["10.0.0.2", "10.0.0.3"] };
  assert.equal(matchesDeviceSearch(device, "10.0.0.2"), true);
  assert.equal(matchesDeviceSearch(device, "10.0.0.3"), true);
  assert.equal(device.ip, "10.0.0.1");
});
