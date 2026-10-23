import test from "node:test";
import assert from "node:assert/strict";
import { buildDeviceAnalytics, collectDeviceAppearances, compactDeviceAppearance, createStrongIdentityMatcher, deviceAnalyticsContent, deviceAnalyticsHistoryStats, deviceAnalyticsHtml, deviceAnalyticsHtmlAfterAppearances, deviceAnalyticsHtmlAppearanceRows, deviceAnalyticsHtmlChunks, deviceAnalyticsHtmlFooter, deviceAnalyticsHtmlHeader, deviceAnalyticsHtmlOpening, deviceAnalyticsHtmlHistoryRows, deviceAnalyticsTxt, deviceAnalyticsXlsxSheets, resolveDeviceAppearance, sharesStrongDeviceIdentity } from "../src/core/device-analytics.js";
import { buildIdentityIndex, findIdentityMatch } from "../src/core/identity.js";

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

test("device appearance collection preserves strong-identity matches and reports duplicate candidates", async () => {
  const snapshots = [
    { id: "final-1", createdAt: "2026-01-01", name: "One" },
    { id: "final-2", createdAt: "2026-02-01", name: "Two" },
    { id: "final-3", createdAt: "2026-03-01", name: "Three" },
  ];
  const records = new Map([
    ["final-1", [{ id: "device-1", mac: "00:11:22:33:44:55", model: "A" }]],
    ["final-2", [
      { id: "device-1", mac: "00:11:22:33:44:55", model: "B" },
      { id: "duplicate", mac: "00:11:22:33:44:55", model: "Conflict" },
    ]],
    ["final-3", [{ id: "other-device", mac: "00:11:22:33:44:66" }]],
  ]);
  const appearances = await collectDeviceAppearances(
    { id: "device-1", mac: "00:11:22:33:44:55" },
    snapshots,
    async (snapshotId, visit) => { visit(records.get(snapshotId)); },
  );
  assert.deepEqual(appearances.map(({ id, status, candidateCount, device }) => ({ id, status, candidateCount, device })), [
    { id: "final-1", status: "matched", candidateCount: 1, device: { id: "device-1", mac: "00:11:22:33:44:55", model: "A" } },
    { id: "final-2", status: "ambiguous", candidateCount: 2, device: null },
  ]);
});

test("device appearance collection uses indexed candidates and ignores weak-token overflow", async () => {
  const snapshots = [{ id: "indexed-final" }];
  const appearances = await collectDeviceAppearances(
    { id: "device-1", hostname: "shared-host" },
    snapshots,
    async () => { throw new Error("An available identity index must avoid scanning snapshot chunks"); },
    {
      findSnapshotCandidates: async () => ({
        candidates: [
          { id: "device-1", hostname: "shared-host", model: "Matched" },
          { id: "other-device", hostname: "shared-host", model: "Weak-only candidate" },
        ],
        overflowTokenKeys: new Set(["hostname:shared-host"]),
      }),
    },
  );
  assert.equal(appearances.length, 1);
  assert.equal(appearances[0].status, "matched");
  assert.equal(appearances[0].device.model, "Matched");
  assert.equal(appearances[0].candidateCount, 1);
});

test("device appearance collection treats overflow in a strong indexed token as ambiguous", async () => {
  const appearances = await collectDeviceAppearances(
    { id: "device-1" },
    [{ id: "overflow-final" }],
    async () => { throw new Error("An available identity index must avoid scanning snapshot chunks"); },
    {
      findSnapshotCandidates: async () => ({
        candidates: [
          { id: "device-1", model: "First" },
          { id: "device-1", model: "Second" },
        ],
        overflowTokenKeys: new Set(["id:device-1"]),
      }),
    },
  );
  assert.equal(appearances[0].status, "ambiguous");
  assert.equal(appearances[0].candidateCount, 3);
  assert.equal(appearances[0].device, null);
});

test("device appearance scan stops at the current chunk when its dialog request becomes stale", async () => {
  let checks = 0;
  const visited = [];
  const result = await collectDeviceAppearances(
    { id: "device-1" },
    [{ id: "final-1" }, { id: "final-2" }],
    async (snapshotId, visit) => {
      visited.push(snapshotId);
      const completed = visit([
        { id: "device-1", mac: "00:11:22:33:44:55" },
        { id: "device-1", mac: "00:11:22:33:44:55" },
        { id: "device-1", mac: "00:11:22:33:44:55" },
      ]);
      assert.equal(completed, false);
    },
    { isCurrent: () => ++checks < 4 },
  );
  assert.equal(result, null);
  assert.deepEqual(visited, ["final-1"]);
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

test("device analytics reuses chronological database pages and sorts fallback input without mutating it", () => {
  const appearances = [
    { id: "f1", createdAt: "2026-01-01T00:00:00Z", device: { model: "A" } },
    { id: "f2", createdAt: "2026-02-01T00:00:00Z", device: { model: "B" } },
  ];
  const history = [
    { id: 1, timestamp: "2026-01-01T00:00:00Z", type: "added" },
    { id: 2, timestamp: "2026-02-01T00:00:00Z", type: "modified" },
  ];
  const ordered = buildDeviceAnalytics({}, appearances, history);
  assert.equal(ordered.appearances, appearances);
  assert.equal(ordered.history, history);

  const reverseAppearances = [...appearances].reverse();
  const reverseHistory = [...history].reverse();
  const sorted = buildDeviceAnalytics({}, reverseAppearances, reverseHistory);
  assert.deepEqual(sorted.appearances.map((row) => row.id), ["f1", "f2"]);
  assert.deepEqual(sorted.history.map((row) => row.id), [1, 2]);
  assert.deepEqual(reverseAppearances.map((row) => row.id), ["f2", "f1"]);
  assert.deepEqual(reverseHistory.map((row) => row.id), [2, 1]);
  assert.equal(sorted.modifiedTotal, 1);
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
  assert.match(content, /id="deviceHistoryRows"/);
  assert.match(content, /id="deviceHistoryHeading"/);
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

test("device history can show cumulative row count while retaining only the latest page", () => {
  const report = buildDeviceAnalytics({ id: "device-a" }, [], [{ id: 1, type: "modified" }], {
    total: 1_001, modifiedTotal: 900, hasMore: true,
  });
  report.history = [{ id: 901, type: "modified" }];
  report.historyShown = 901;
  const content = deviceAnalyticsContent(report);
  assert.match(content, /Изменения параметров \(1[\s\u00a0]001\) · показано 901/);
  const retainedRows = content.match(/<tbody id="deviceHistoryRows">([\s\S]*?)<\/tbody>/)?.[1] || "";
  assert.ok(retainedRows.startsWith("<tr>"));
  assert.equal((retainedRows.match(/<tr>/g) || []).length, 1);
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

test("cached device identity matcher agrees with the shared resolver across strong aliases", () => {
  const targets = [
    { id: "internal-1", deviceId: "asset-1", serial: "serial-1", mac: "00:11:22:33:44:55", alternateMacs: ["00:11:22:33:44:66"] },
    { mac: "00:11:22:33:44:55", alternateMacs: ["00:11:22:33:44:66"] },
    { hostname: "weak-only", ip: "192.0.2.10" },
  ];
  const candidates = [
    { id: "internal-1", mac: "00:11:22:33:44:77" },
    { device_id: "asset-1" },
    { serial_number: "SERIAL-1" },
    { mac: "00:11:22:33:44:66" },
    { mac2: "00:11:22:33:44:66" },
    { alternateMacs: ["00:11:22:33:44:55"] },
    { hostname: "weak-only", ip: "192.0.2.10" },
    { mac: "00:11:22:33:44:88" },
    {},
  ];
  for (const target of targets) {
    const match = createStrongIdentityMatcher(target);
    for (const candidate of candidates) {
      const expected = findIdentityMatch(target, buildIdentityIndex([candidate])).status === "matched";
      assert.equal(match(candidate), expected, `${JSON.stringify(target)} ↔ ${JSON.stringify(candidate)}`);
      assert.equal(sharesStrongDeviceIdentity(target, candidate), expected);
    }
  }
});

test("device analytics HTML appearance rows can be generated in bounded pages with exact document framing", () => {
  const appearances = Array.from({ length: 1_001 }, (_, index) => ({
    id: `final-${index}`,
    createdAt: `2026-${String(Math.floor(index / 31) % 12 + 1).padStart(2, "0")}-01T00:00:00Z`,
    source: `file-${index}.csv`,
    device: { model: index === 500 ? "<script>alert(1)</script>" : `Model ${index}` },
  }));
  const payload = buildDeviceAnalytics({ id: "device-a" }, appearances, [], { total: 0 });
  const batches = [];
  for (let offset = 0; offset < appearances.length; offset += 100) {
    batches.push(deviceAnalyticsHtmlAppearanceRows(payload.appearances.slice(offset, offset + 100)));
  }
  assert.equal(batches.length, 11);
  assert.equal(batches.reduce((count, batch) => count + (batch.match(/<tr>/g) || []).length, 0), 1_001);
  const escapedBatch = batches.find((batch) => batch.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(escapedBatch);
  assert.doesNotMatch(escapedBatch, /<script>alert/);
  const framed = deviceAnalyticsHtmlOpening(payload) + batches.join("") + deviceAnalyticsHtmlAfterAppearances(payload);
  assert.ok(framed.includes("<h2>История появлений</h2>"));
  assert.ok(framed.includes("Изменения параметров (0)"));
  assert.equal(deviceAnalyticsHtmlHeader(payload), framed);
  assert.equal(deviceAnalyticsHtmlFooter(), "</tbody></table></body></html>");
});

test("device analytics HTML stream preserves the full report while paging History and appearances", async () => {
  const appearances = Array.from({ length: 1_001 }, (_, index) => ({
    id: `final-${index}`,
    createdAt: `2026-${String(Math.floor(index / 31) % 12 + 1).padStart(2, "0")}-01T00:00:00Z`,
    source: `file-${index}.csv`,
    device: { model: `Model ${index}` },
  }));
  const history = Array.from({ length: 1_001 }, (_, index) => ({
    id: `event-${index}`,
    timestamp: `2026-10-${String(index % 28 + 1).padStart(2, "0")}T00:00:00Z`,
    field: `field-${index}`,
    oldValue: `old-${index}`,
    newValue: `new-${index}`,
    source: `source-${index}`,
    device: { model: `History Model ${index}` },
  }));
  const payload = buildDeviceAnalytics({ id: "device-stream" }, appearances, [], { total: history.length, modifiedTotal: history.length });
  const chunks = [];
  const calls = [];
  for await (const chunk of deviceAnalyticsHtmlChunks(payload, async (id, { cursor, limit }) => {
    calls.push({ id, cursor, limit });
    const offset = Number(cursor || 0);
    const end = Math.min(history.length, offset + limit);
    return { rows: history.slice(offset, end), hasMore: end < history.length, nextCursor: end < history.length ? String(end) : null };
  })) chunks.push(chunk);

  const appearancePages = [];
  for (let offset = 0; offset < payload.appearances.length; offset += 100) {
    appearancePages.push(deviceAnalyticsHtmlAppearanceRows(payload.appearances.slice(offset, offset + 100)));
  }
  const historyPages = [];
  for (let offset = 0; offset < history.length; offset += 500) {
    historyPages.push(deviceAnalyticsHtmlHistoryRows(history.slice(offset, offset + 500)));
  }
  const expected = deviceAnalyticsHtmlOpening(payload)
    + appearancePages.join("")
    + deviceAnalyticsHtmlAfterAppearances(payload)
    + historyPages.join("")
    + deviceAnalyticsHtmlFooter();
  assert.equal(chunks.join(""), expected);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ id, limit }) => id === "device-stream" && limit === 500));
  assert.ok(Math.max(...chunks.map((chunk) => (chunk.match(/<tr>/g) || []).length)) <= 500);
  assert.equal((chunks.join("").match(/<tr>/g) || []).length, appearances.length + history.length + 2);
});

test("device analytics HTML stream preserves empty-state rows without reading History", async () => {
  const payload = buildDeviceAnalytics({ id: "device-empty" }, [], [], { total: 0 });
  let readCount = 0;
  const chunks = [];
  for await (const chunk of deviceAnalyticsHtmlChunks(payload, async () => { readCount += 1; return { rows: [], hasMore: false }; })) chunks.push(chunk);
  const html = chunks.join("");
  assert.equal(readCount, 1);
  assert.match(html, /История появлений MAC пока пуста/);
  assert.match(html, /Исторических изменений нет/);
  assert.equal(html, deviceAnalyticsHtmlOpening(payload)
    + '<tr><td colspan="8">История появлений MAC пока пуста.</td></tr>'
    + deviceAnalyticsHtmlAfterAppearances(payload)
    + '<tr><td colspan="6">Исторических изменений нет</td></tr>'
    + deviceAnalyticsHtmlFooter());
});
