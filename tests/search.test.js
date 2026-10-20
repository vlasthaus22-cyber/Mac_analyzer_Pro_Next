import test from "node:test";
import assert from "node:assert/strict";
import { matchesDeviceSearch, searchResultDoubleClickTarget } from "../src/core/search.js";

test("global device search matches normalized primary and alternate MAC forms", () => {
  const device = { mac: "00:11:22:33:44:55", alternateMacs: ["AA:BB:CC:DD:EE:FF"] };
  assert.equal(matchesDeviceSearch(device, "001122334455"), true);
  assert.equal(matchesDeviceSearch(device, "00-11-22"), true);
  assert.equal(matchesDeviceSearch(device, "aabb.ccdd.eeff"), true);
  assert.equal(matchesDeviceSearch(device, "001122334456"), false);
});

test("search result double-click resolves MAC first, then a meaningful model", () => {
  assert.deepEqual(searchResultDoubleClickTarget({ mac: "001122334455", model: "Switch X" }), {
    kind: "mac",
    mac: "00:11:22:33:44:55",
  });
  assert.deepEqual(searchResultDoubleClickTarget({ model: "  Switch X  " }), { kind: "model", model: "Switch X" });
  for (const model of ["", "—", "-", "Unknown"]) assert.equal(searchResultDoubleClickTarget({ model }), null);
  assert.equal(searchResultDoubleClickTarget({}), null);
});

test("global search accepts the PyQt legacy aliases for vendor, MAC, switch IP, and port", () => {
  const device = {
    mac_formatted: "AABB.CCDD.EEFF",
    vendor: "Legacy Vendor",
    switch_ip: "10.20.0.254",
    switch_port: "Gi1/0/24",
  };
  assert.equal(matchesDeviceSearch(device, "legacy vendor"), true);
  assert.equal(matchesDeviceSearch(device, "AA-BB-CC"), true);
  assert.equal(matchesDeviceSearch(device, "10.20.0.254"), true);
  assert.equal(matchesDeviceSearch(device, "Gi1/0/24"), true);
});

test("global search normalizes raw secondary-MAC aliases without needing a precomputed alternateMacs array", () => {
  assert.equal(matchesDeviceSearch({ mac2: "AABB.CCDD.EE01" }, "AA-BB-CC"), true);
  assert.equal(matchesDeviceSearch({ secondary_mac: "AA:BB:CC:DD:EE:02" }, "aabb.ccdd.ee02"), true);
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
