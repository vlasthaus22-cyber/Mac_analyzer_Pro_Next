import test from "node:test";
import assert from "node:assert/strict";
import { packAlternateMacsInPlace } from "../src/core/identity.js";
import { dashboardDeviceMatchesFilters, dashboardFilterOptions, dashboardStatusForKpi, filterDashboardDevicesInPlace, normalizeDashboardFilters } from "../src/core/dashboard-filter.js";

const devices = [
  { mac: "00:11:22:33:44:51", manufacturer: "Vendor A", model: "Codec Alpha", room: "Boardroom 1", ip: "192.168.1.51" },
  { mac: "00-11-22-33-44-52", vendor: "Vendor B", model: "Display Beta", room: "Boardroom 2", ip: "192.168.1.52" },
  { mac: "00:11:22:33:44:53", manufacturer: "Vendor A", model: "Display Gamma", room: "Boardroom 2", ip: "192.168.1.53" },
];

test("Dashboard filters match full scalar search, normalized MAC, manufacturer aliases and exact room", () => {
  assert.equal(dashboardDeviceMatchesFilters(devices[0]), true);
  assert.equal(dashboardDeviceMatchesFilters(devices[0], { query: "codec alpha" }), true);
  assert.equal(dashboardDeviceMatchesFilters(devices[0], { query: "001122334451" }), true);
  assert.equal(dashboardDeviceMatchesFilters(devices[1], { manufacturer: "Vendor B", room: "Boardroom 2" }), true);
  assert.equal(dashboardDeviceMatchesFilters({ manufacturer: "Не указано", vendor: "Vendor C" }, { manufacturer: "Vendor C" }), true);
  assert.equal(dashboardDeviceMatchesFilters(devices[1], { manufacturer: "Vendor A" }), false);
  assert.equal(dashboardDeviceMatchesFilters(devices[2], { room: "Boardroom 1" }), false);
  assert.equal(dashboardDeviceMatchesFilters(devices[0], { query: "not present" }), false);
  assert.equal(dashboardDeviceMatchesFilters({ first: "North", second: "Wing", nested: { value: "hidden" } }, { query: "north wing" }), true);
  assert.equal(dashboardDeviceMatchesFilters({ first: "North", second: "Wing", nested: { value: "hidden" } }, { query: "hidden" }), false);
  assert.equal(dashboardDeviceMatchesFilters({ mac: "00:11:22:33:44:51", alternateMacs: ["AA:BB:CC:DD:EE:51"] }, { query: "AA:BB:CC:DD:EE:51" }), true);
  assert.equal(dashboardDeviceMatchesFilters({ mac: "—", macFormatted: "AA:BB:CC:DD:EE:51" }, { query: "AA:BB:CC:DD:EE:51" }), true);
});

test("packed Dashboard alternate MAC values preserve the existing scalar query format", () => {
  const device = { id: "device-1", alternateMacs: ["AA:BB:CC:DD:EE:51", "11:22:33:44:55:66"] };
  const query = "AA:BB:CC:DD:EE:51,11:22:33:44:55:66";
  const before = dashboardDeviceMatchesFilters(device, { query });
  packAlternateMacsInPlace([device]);
  assert.equal(device.alternateMacs, query);
  assert.equal(dashboardDeviceMatchesFilters(device, { query }), before);
});

test("Dashboard filter normalization bounds text and accepts only supported status choices", () => {
  assert.deepEqual(normalizeDashboardFilters({ query: "  Codec  ", manufacturer: " A ", room: " R ", status: "unchanged" }), {
    query: "Codec", manufacturer: "A", room: "R", status: "unchanged",
  });
  assert.equal(normalizeDashboardFilters({ status: "other" }).status, "all");
  assert.equal(normalizeDashboardFilters({ query: "x".repeat(600) }).query.length, 500);
});

test("Dashboard KPI cards select their matching status filter and general cards restore all statuses", () => {
  assert.deepEqual(
    ["devices", "modified", "absent", "unchanged", "manufacturers", "rooms", "withoutRoom"].map(dashboardStatusForKpi),
    ["all", "changed", "missing", "unchanged", "all", "all", null],
  );
});

test("Dashboard filter options preserve every distinct non-empty value and in-place filtering keeps bounded arrays", () => {
  assert.deepEqual(dashboardFilterOptions([...devices, { manufacturer: "Не указано", vendor: "Vendor C" }]), {
    manufacturers: ["Vendor A", "Vendor B", "Vendor C"],
    rooms: ["Boardroom 1", "Boardroom 2"],
  });
  const rows = [...devices];
  assert.equal(filterDashboardDevicesInPlace(rows, { manufacturer: "Vendor A" }), rows);
  assert.deepEqual(rows, [devices[0], devices[2]]);
});
