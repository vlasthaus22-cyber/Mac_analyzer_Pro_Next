import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRoomSwitchAnomalies, buildAnalytics, buildPresenceChurn } from "../src/core/analytics.js";

test("room switch anomaly contains full room equipment and bridges one missing ID", () => {
  const base = { smartroomId: "SR-1", businessUnit: "ЦА", city: "Москва", site: "Кутузовский", floor: "3", room: "Переговорная 1", address: "Кутузовский 1" };
  const devices = [
    { ...base, id: "a", mac: "00:11:22:33:44:51", switchIp: "10.0.0.1", model: "A" },
    { ...base, id: "b", mac: "00:11:22:33:44:52", switchIp: "10.0.0.1", model: "B" },
    { ...base, id: "c", mac: "00:11:22:33:44:53", switchIp: "10.0.0.1", model: "C" },
    { ...base, smartroomId: "", id: "d", mac: "00:11:22:33:44:54", switchIp: "10.0.0.2", model: "D" },
  ];
  const result = analyzeRoomSwitchAnomalies(devices);
  assert.equal(result.length, 1);
  assert.equal(result[0].deviceCount, 4);
  assert.equal(result[0].deviationCount, 1);
  assert.equal(result[0].devices.find((item) => item.id === "d").anomaly, true);
});

test("ambiguous missing Smartroom ID is not guessed", () => {
  const location = { city: "Москва", site: "Кутузовский", floor: "3", room: "Переговорная 1" };
  const result = analyzeRoomSwitchAnomalies([
    { ...location, smartroomId: "SR-1", id: "a", switchIp: "10.0.0.1" },
    { ...location, smartroomId: "SR-2", id: "b", switchIp: "10.0.0.2" },
    { ...location, smartroomId: "", id: "c", switchIp: "10.0.0.3" },
  ]);
  assert.equal(result.length, 0);
});

test("dashboard room count bridges a missing ID only for one unambiguous location", () => {
  const base = { businessUnit: "ЦА", city: "Москва", site: "Кутузовский", floor: "3", room: "Переговорная 1" };
  const snapshots = [{
    id: "one",
    createdAt: "2026-01-01T00:00:00Z",
    devices: [
      { ...base, id: "a", mac: "00:11:22:33:44:51", smartroomId: "SR-1" },
      { ...base, id: "b", mac: "00:11:22:33:44:52", smartroomId: "" },
    ],
  }];
  assert.equal(buildAnalytics(snapshots).kpis.rooms, 1);
});

test("dashboard uses full snapshots and reports absent devices", () => {
  const snapshots = [
    { id: "1", createdAt: "2026-01-01T00:00:00Z", devices: [{ id: "a", mac: "00:11:22:33:44:55" }, { id: "b", mac: "AA:BB:CC:DD:EE:FF" }] },
    { id: "2", createdAt: "2026-01-08T00:00:00Z", devices: [{ id: "a", mac: "00:11:22:33:44:55" }] },
  ];
  const result = buildAnalytics(snapshots);
  assert.equal(result.kpis.devices, 1);
  assert.equal(result.kpis.absent, 1);
  assert.equal(result.comparison.absent[0].id, "b");
});

test("presence churn detects repeated disappearance and return", () => {
  const snapshots = [true, false, true, false, true].map((present, index) => ({
    createdAt: `2026-01-0${index + 1}T00:00:00Z`,
    devices: present ? [{ mac: "00:11:22:33:44:55" }] : [],
  }));
  const result = buildPresenceChurn(snapshots);
  assert.equal(result[0].transitions, 4);
});

