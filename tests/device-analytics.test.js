import test from "node:test";
import assert from "node:assert/strict";
import { buildDeviceAnalytics, compactDeviceAppearance, deviceAnalyticsContent, deviceAnalyticsHistoryStats, deviceAnalyticsHtml, deviceAnalyticsHtmlFooter, deviceAnalyticsHtmlHeader, deviceAnalyticsHtmlHistoryRows, deviceAnalyticsTxt, deviceAnalyticsXlsxSheets, resolveDeviceAppearance, sharesStrongDeviceIdentity } from "../src/core/device-analytics.js";

test("single device report includes field provenance, full Final appearances and history", () => {
  const report = buildDeviceAnalytics({
    id: "device-1", mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Room Kit", observationCount: 3, vendorConfidence: 0.95, modelConfidence: 0.63,
    room: "101", ip: "10.0.0.1", fieldSources: { manufacturer: "OUI", model: "SmartRoom" },
    possibleIps: ["10.0.0.2", "10.0.0.3"], possibleIpsTruncated: true,
    sources: ["Main.csv", "SmartRoom.xlsx"], conflicts: [{ field: "room", value: "102", source: "Previous Final" }],
  }, [
    { id: "final-1", name: "Final 1", createdAt: "2026-01-01T00:00:00Z", device: { mac: "00:11:22:33:44:55", room: "100", manufacturer: "Acme", model: "Board A" } },
    { id: "final-2", name: "Final 2", createdAt: "2026-02-01T00:00:00Z", device: { mac: "00:11:22:33:44:55", room: "101", manufacturer: "Unknown", model: "Board A" } },
  ], [
    { type: "modified", field: "room", oldValue: "100", newValue: "101", source: "SmartRoom", timestamp: "2026-02-01T00:00:00Z" },
  ]);

  assert.match(report.reportText, /Производитель: Acme/);
  assert.match(report.reportText, /Производитель: OUI \(95%\)/);
  assert.match(report.reportText, /Модель: SmartRoom \(63%\)/);
  assert.match(report.reportText, /Все источники: Main\.csv, SmartRoom\.xlsx/);
  assert.match(report.reportText, /Появлений в Final: 2/);
  assert.match(report.reportText, /Файлов появлений: 2/);
  assert.match(report.reportText, /Изменений параметров: 1/);
  assert.match(report.reportText, /Производителей в истории: 1/);
  assert.match(report.reportText, /Моделей в истории: 1/);
  assert.match(report.reportText, /Наблюдений в Final: 3/);
  assert.match(report.reportText, /Возможные IP \(DDIO\): 10\.0\.0\.2, 10\.0\.0\.3/);
  assert.match(report.reportText, /Возможные IP \(DDIO\): список сокращён/);
  assert.match(report.reportText, /Исторических событий: 1/);
  assert.match(report.reportText, /Примечания: room: 102 \(Previous Final\)/);
  assert.match(deviceAnalyticsContent(report), /Открыть хронологию MAC/);
  assert.match(deviceAnalyticsContent(report), /SmartRoom/);
  assert.match(deviceAnalyticsContent(report), /Smartroom ID/);
  assert.match(deviceAnalyticsContent(report), /Первое появление/);
  assert.match(deviceAnalyticsContent(report), /История появлений/);
  assert.match(deviceAnalyticsContent(report), /Изменения параметров/);
  assert.match(deviceAnalyticsContent(report), /<span>Изменений<\/span><strong>1<\/strong>/);
  assert.match(deviceAnalyticsHtml(report), /изменений: 1 · производителей: 1 · моделей: 1/);
  assert.match(deviceAnalyticsHtml(report), /Final 2/);
  assert.match(deviceAnalyticsHtml(report), /100/);
});

test("historical appearance projection keeps every displayed field without retaining enrichment payloads", () => {
  const projected = compactDeviceAppearance({
    id: "device-1", mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Room Kit",
    ip: "192.0.2.3", address: "Office", physicalAddress: "HQ", room: "301", smartroomId: "room-1",
    switchIp: "192.0.2.1", possibleIps: ["192.0.2.4"], fieldSources: { manufacturer: "OUI" },
    conflicts: [{ field: "room" }], sources: ["main.csv"], customFields: { note: "retained elsewhere" },
  });
  assert.deepEqual(projected, {
    id: "device-1", mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Room Kit",
    ip: "192.0.2.3", address: "Office", physicalAddress: "HQ", room: "301", smartroomId: "room-1",
  });
});

test("device appearance statistics count unique values in one pass without mapping every history row", () => {
  const appearances = Array.from({ length: 10_000 }, (_, index) => ({
    source: `source-${index % 3}`,
    device: {
      manufacturer: index % 7 === 0 ? "Unknown" : `Vendor ${index % 4}`,
      model: `Model ${index % 5}`,
    },
  }));
  const stats = deviceAnalyticsHistoryStats({
    appearances,
    history: Array.from({ length: 2_000 }, (_, index) => ({ type: index % 4 === 0 ? "modified" : "added" })),
  });
  assert.equal(stats.appearances, 10_000);
  assert.equal(stats.files, 3);
  assert.equal(stats.vendors, 4);
  assert.equal(stats.models, 5);
  assert.equal(stats.movements, 500);
});

test("single device HTML report escapes imported values and tolerates malformed optional fields", () => {
  const report = buildDeviceAnalytics({
    id: "x", manufacturer: "<img src=x onerror=alert(1)>",
    sources: "untrusted", conflicts: { field: "not-an-array" }, alternateMacs: {},
  }, [{ id: "bad", name: "<script>bad()</script>", createdAt: "not-a-date", status: "matched", device: { room: "<b>Room</b>" } }], []);
  const html = deviceAnalyticsHtml(report);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b&gt;Room&lt;\/b&gt;/);
});

test("single-device text export matches the reference report shape and preserves Cyrillic with a UTF-8 BOM", () => {
  const payload = buildDeviceAnalytics({
    mac: "00:11:22:33:44:55", manufacturer: "Акме", model: "Панель 101", ip: "10.0.0.5",
    vendorConfidence: 0.95, vendorSource: "IEEE OUI", modelConfidence: 0.8, modelSource: "Main.csv",
    matchDetails: "Совпадение по серийному номеру",
  }, [], []);
  const output = deviceAnalyticsTxt(payload, "2026-10-17T12:30:00Z");
  assert.ok(output.startsWith("\uFEFF"));
  assert.match(output, /АНАЛИТИКА УСТРОЙСТВА\nДата: 2026-10-17T12:30:00Z/);
  assert.match(output, /Производитель: Акме/);
  assert.match(output, /Модель: Панель 101/);
  assert.match(output, /Производитель: IEEE OUI \(95%\)/);
  assert.match(output, /Совпадение по серийному номеру/);
  assert.ok(output.endsWith("\n"));
});

test("device history report paginates UI rows but preserves exact event totals and export row streaming helpers", () => {
  const report = buildDeviceAnalytics({ id: "device-a", mac: "00:11:22:33:44:55" }, [], [
    { timestamp: "2026-01-01T00:00:00Z", type: "modified", label: "Модель", oldValue: "A", newValue: "B" },
    { timestamp: "2026-01-02T00:00:00Z", type: "modified", label: "IP", oldValue: "1", newValue: "2" },
  ], { total: 205, hasMore: true, nextCursor: { timestamp: "2026-01-02T00:00:00Z", id: 2 } });
  const content = deviceAnalyticsContent(report);
  assert.match(report.reportText, /Исторических событий: 205/);
  assert.match(content, /Изменения параметров \(205\) · показано 2/);
  assert.match(content, /data-load-device-history/);
  assert.match(content, /data-delete-device-history/);
  assert.match(content, /записи Inventory и появления по снимкам сохраняются/);
  assert.equal((deviceAnalyticsHtmlHistoryRows(report.history).match(/<tr>/g) || []).length, 2);
  const contextualRow = deviceAnalyticsHtmlHistoryRows([{
    timestamp: "2026-01-01T00:00:00Z", label: "Модель", oldValue: "A", newValue: "B", source: "Main.xlsx",
    device: { manufacturer: "Acme", model: "Board", address: "Site A", room: "101" },
  }]);
  assert.equal((contextualRow.match(/<td>/g) || []).length, 5);
  assert.match(contextualRow, /Производитель: Acme/);
  assert.match(contextualRow, /Помещение: 101/);
  assert.match(deviceAnalyticsHtmlHeader(report), /Изменения параметров \(205\)/);
  assert.equal(deviceAnalyticsHtmlFooter(), "</tbody></table></body></html>");
  assert.doesNotMatch(deviceAnalyticsContent(buildDeviceAnalytics({ id: "device-a" }, [], [], { total: 0 })), /data-delete-device-history/);
});

test("device analytics XLSX streams appearance and complete history sheets with device context", async () => {
  const payload = buildDeviceAnalytics({
    id: "device-a", mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board 10", address: "Site A", room: "101",
  }, [{
    id: "final-1", name: "Final 1", createdAt: "2026-01-01T00:00:00Z", status: "matched",
    device: { mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board 10", address: "Site A", room: "101", ip: "10.0.0.2" },
  }], []);
  async function* events() {
    yield { timestamp: "2026-01-02T00:00:00Z", type: "modified", field: "room", oldValue: "100", newValue: "101", source: "SmartRoom" };
    yield { timestamp: "2026-01-03T00:00:00Z", type: "modified", field: "ip", oldValue: "10.0.0.1", newValue: "10.0.0.2" };
  }
  const sheets = deviceAnalyticsXlsxSheets(payload, events());
  assert.deepEqual(sheets.map(({ name }) => name), ["Появления", "Изменения"]);
  const appearances = [];
  for await (const row of sheets[0].rows) appearances.push(row);
  assert.deepEqual(appearances[0], ["2026-01-01T00:00:00Z", "Final 1", "Acme", "Board 10", "10.0.0.2", "Site A", "101", ""]);
  const changes = [];
  for await (const row of sheets[1].rows) changes.push(row);
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[0], ["2026-01-02T00:00:00Z", "room", "100", "101", "SmartRoom", "00:11:22:33:44:55", "Acme", "Board 10", "Site A", "101"]);
  assert.match(deviceAnalyticsContent(payload), /data-export-device-analytics-xlsx/);
  assert.match(deviceAnalyticsContent(payload), /data-export-device-analytics-txt/);
  const stats = deviceAnalyticsHistoryStats(payload);
  assert.equal(stats.appearances, 1);
  assert.equal(stats.files, 1);
  assert.equal(stats.firstSeen, stats.lastSeen);
});

test("device history uses strong identity, survives MAC changes and leaves duplicate matches ambiguous", () => {
  const target = { id: "persistent-1", deviceId: "hardware-1", mac: "00:11:22:33:44:55", ip: "10.0.0.1" };
  const changedMac = { id: "persistent-1", deviceId: "hardware-1", mac: "00:11:22:33:44:66", ip: "10.0.0.1" };
  assert.equal(sharesStrongDeviceIdentity(target, changedMac), true);
  assert.deepEqual(resolveDeviceAppearance(target, [changedMac]), { status: "matched", device: changedMac, candidates: [] });
  assert.equal(sharesStrongDeviceIdentity(target, { id: "other", ip: "10.0.0.1" }), false);
  assert.equal(resolveDeviceAppearance(target, [changedMac, { ...changedMac, id: "duplicate" }], 2).status, "ambiguous");
});
