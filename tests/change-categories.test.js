import test from "node:test";
import assert from "node:assert/strict";
import { isCriticalHistoryChange, normalizeChangeField, normalizeChangeType, pageComparisonChanges, summarizeChangeCategories } from "../src/core/change-categories.js";

test("history aliases normalize Russian labels and legacy removed events consistently", () => {
  assert.equal(normalizeChangeType("removed"), "absent");
  assert.equal(normalizeChangeType("Появление"), "added");
  assert.equal(normalizeChangeType("Изменено"), "modified");
  assert.equal(normalizeChangeField("switch_ip"), "switchIp");
  assert.equal(normalizeChangeField("IP-адрес"), "ip");
  assert.equal(normalizeChangeField("Коммутатор"), "switchIp");
  assert.equal(isCriticalHistoryChange("removed", "device", "есть", ""), true);
  assert.equal(isCriticalHistoryChange("modified", "IP-адрес", "10.0.0.1", "10.0.0.2"), true);
  assert.equal(isCriticalHistoryChange("modified", "switch_ip", "10.0.0.1", "10.0.0.2"), true);
  assert.equal(isCriticalHistoryChange("modified", "Коммутатор", "", "10.0.0.2"), false);
  assert.equal(isCriticalHistoryChange("modified", "MAC", "00:11", "00:11"), false);
  assert.equal(isCriticalHistoryChange("modified", "address", "A", "B"), false);
});

test("change categories count nested field events and isolate critical changes from other types", () => {
  const comparison = {
    added: [{ id: "added", mac: "00:00:00:00:00:01" }],
    absent: [{ id: "absent", mac: "00:00:00:00:00:02" }],
    modified: [{
      before: { id: "device", room: "101", ip: "10.0.0.1" },
      after: { id: "device", room: "102", ip: "10.0.0.2" },
      changes: [
        { field: "ip", label: "IP", oldValue: "10.0.0.1", newValue: "10.0.0.2" },
        { field: "switchIp", label: "IP коммутатора", oldValue: "10.0.0.254", newValue: "10.0.0.253" },
        { field: "room", label: "Помещение", oldValue: "101", newValue: "102" },
        { field: "switchPort", label: "Порт", oldValue: "1", newValue: "2" },
      ],
    }],
  };
  assert.deepEqual(summarizeChangeCategories(comparison), { all: 6, critical: 3, added: 1, absent: 1, modified: 4 });
  assert.deepEqual(pageComparisonChanges(comparison, "critical").rows.map(({ type, change }) => [type, change?.field || ""]), [
    ["absent", ""], ["modified", "ip"], ["modified", "switchIp"],
  ]);
  assert.deepEqual(pageComparisonChanges(comparison, "modified").rows.map(({ change }) => change.field), ["ip", "switchIp", "room", "switchPort"]);
  assert.deepEqual(pageComparisonChanges(comparison, "added").rows.map(({ type }) => type), ["added"]);
  assert.deepEqual(pageComparisonChanges(comparison, "absent").rows.map(({ type }) => type), ["absent"]);
});

test("change category paging scans complete nested results and returns only the requested page", () => {
  const comparison = { modified: Array.from({ length: 150 }, (_, index) => ({
    after: { id: `device-${index}` },
    changes: [{ field: "model", oldValue: "A", newValue: "B" }, { field: "room", oldValue: "101", newValue: "102" }],
  })) };
  const page = pageComparisonChanges(comparison, "all", { offset: 100, limit: 100 });
  assert.equal(page.total, 300);
  assert.equal(page.rows.length, 100);
  assert.equal(page.rows[0].device.id, "device-50");
  assert.equal(page.hasMore, true);
});

test("change categories retain exact absence counts while detail rows are loaded by page", () => {
  const comparison = {
    added: [],
    addedCount: 3,
    absent: [],
    absentCount: 205,
    modified: [{ after: { id: "changed" }, changes: [{ field: "model", oldValue: "A", newValue: "B" }] }],
  };
  assert.deepEqual(summarizeChangeCategories(comparison), { all: 209, critical: 205, added: 3, absent: 205, modified: 1 });
  const first = pageComparisonChanges(comparison, "all", { offset: 100, limit: 100 });
  assert.equal(first.total, 209);
  assert.equal(first.rows.length, 100);
  assert.equal(first.rows[0].absenceOffset, 97);
  assert.equal(first.rows.at(-1).absenceOffset, 196);
  const last = pageComparisonChanges(comparison, "absent", { offset: 200, limit: 100 });
  assert.equal(last.total, 205);
  assert.equal(last.rows[0].absenceOffset, 200);
  assert.equal(last.rows.length, 5);
  assert.equal(last.hasMore, false);
  const additions = pageComparisonChanges(comparison, "added", { offset: 1, limit: 2 });
  assert.deepEqual(additions.rows.map((event) => event.additionOffset), [1, 2]);
  assert.equal(additions.total, 3);
});

test("stored change categories page missing modified details with exact all and critical offsets", () => {
  const comparison = {
    added: [], addedCount: 2,
    absent: [], absentCount: 3,
    modified: [], modifiedEventCount: 5, criticalModifiedEventCount: 2,
  };
  assert.deepEqual(summarizeChangeCategories(comparison), { all: 10, critical: 5, added: 2, absent: 3, modified: 5 });
  const all = pageComparisonChanges(comparison, "all", { offset: 5, limit: 3 });
  assert.deepEqual(all.rows.map((event) => event.modificationOffset), [0, 1, 2]);
  const critical = pageComparisonChanges(comparison, "critical", { offset: 2, limit: 5 });
  assert.equal(critical.total, 5);
  assert.deepEqual(critical.rows.slice(0, 1).map((event) => event.absenceOffset), [2]);
  assert.deepEqual(critical.rows.slice(1).map((event) => event.criticalModificationOffset), [0, 1]);
  const modified = pageComparisonChanges(comparison, "modified", { offset: 4, limit: 5 });
  assert.deepEqual(modified.rows.map((event) => event.modificationOffset), [4]);
});
