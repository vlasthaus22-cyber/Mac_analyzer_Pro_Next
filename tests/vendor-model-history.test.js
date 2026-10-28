import test from "node:test";
import assert from "node:assert/strict";
import { filterVendorModelHistory, selectVendorModelHistoryPage, vendorModelHistoryCsvChunks, VendorModelHistoryAccumulator } from "../src/core/vendor-model-history.js";

test("vendor-model history CSV streams filtered rows with the existing headers and array format", () => {
  const history = {
    vendors: [
      { oui: "001122", vendor: "Acme", occurrences: 3, snapshots: 2, importedObservations: 1, sources: ["Final", "SQLite"], firstSeen: "2026-01-01", lastSeen: "2026-02-01" },
      { oui: "AABBCC", vendor: "Other", occurrences: 1, snapshots: 1, importedObservations: 0, sources: ["Final"], firstSeen: "2026-03-01", lastSeen: "2026-03-01" },
    ],
  };
  const columns = [["oui", "OUI"], ["vendor", "Производитель"], ["sources", "Источники"]];
  const chunks = vendorModelHistoryCsvChunks(history, { kind: "vendors", query: "ACME", columns });

  assert.equal(chunks.next().value, "\uFEFF\"OUI\";\"Производитель\";\"Источники\"");
  assert.equal(chunks.next().value, "\r\n\"001122\";\"Acme\";\"Final; SQLite\"");
  assert.equal(chunks.next().done, true);
});

test("vendor and model history counts Final observations and distinct snapshots by OUI and MAC5", () => {
  const history = new VendorModelHistoryAccumulator();
  history.beginSnapshot({ id: "first", name: "first.csv", createdAt: "2026-01-01T00:00:00Z" });
  history.addDevice({ mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board X" });
  history.addDevice({ mac: "—", macFormatted: "00:11:22:33:44:66", manufacturer: "Acme", model: "Board X" });
  assert.equal(Object.hasOwn(history.activeSnapshot, "vendorKeys"), false);
  assert.equal(Object.hasOwn(history.activeSnapshot, "modelKeys"), false);
  history.endSnapshot();
  history.beginSnapshot({ id: "second", name: "second.csv", createdAt: "2026-02-01T00:00:00Z" });
  history.addDevice({ macFormatted: "00:11:22:33:44:55", vendor: "Acme", model: "Board X" });
  history.addDevice({ mac: "AA:BB:CC:11:22:33", manufacturer: "Other", model: "Board Y" });
  history.endSnapshot();
  const result = history.result();
  assert.deepEqual(result.vendors.map(({ oui, vendor, occurrences, snapshots, firstSeen, lastSeen }) => ({ oui, vendor, occurrences, snapshots, firstSeen, lastSeen })), [
    { oui: "001122", vendor: "Acme", occurrences: 3, snapshots: 2, firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-02-01T00:00:00Z" },
    { oui: "AABBCC", vendor: "Other", occurrences: 1, snapshots: 1, firstSeen: "2026-02-01T00:00:00Z", lastSeen: "2026-02-01T00:00:00Z" },
  ]);
  assert.equal(result.models[0].prefix, "0011223344");
  assert.equal(result.models[0].occurrences, 3);
  assert.equal(result.models[0].snapshots, 2);
  assert.equal(Object.hasOwn(result.vendors[0], "lastSnapshotOrdinal"), false, "the accumulator's internal snapshot marker must not leak into exports");
  assert.deepEqual(result.statistics, { totalSnapshots: 2, importedObservations: 0, importedLoads: 0, mappingRules: 0, loadRecords: 2, ouiVendorRecords: 2, uniqueOuis: 2, uniqueVendors: 2, mac5ModelRecords: 2, uniqueModels: 2 });
  assert.deepEqual(result.loads.map(({ source, records, vendors, models }) => ({ source, records, vendors, models })), [
    { source: "first.csv", records: 2, vendors: ["Acme"], models: ["Board X"] },
    { source: "second.csv", records: 2, vendors: ["Acme", "Other"], models: ["Board X", "Board Y"] },
  ]);
});

test("vendor-model history accumulator releases aggregate maps after the exported result is retained", () => {
  const history = new VendorModelHistoryAccumulator();
  history.beginSnapshot({ name: "snapshot.csv", createdAt: "2026-01-01T00:00:00Z" });
  history.addDevice({ mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board X" });
  history.endSnapshot();
  const expected = history.result();
  const result = history.result({ consume: true });

  assert.deepEqual(result, expected, "consuming materialization must preserve the exact export");
  assert.equal(history.vendors.size, 0);
  assert.equal(history.models.size, 0);
  assert.equal(history.loads.size, 0);
  history.clear();
  assert.equal(history.totalSnapshots, 0);
  assert.equal(history.activeSnapshot, null);
  assert.deepEqual(result.vendors[0].sources, ["snapshot.csv"], "the retained result must not reference mutable accumulator sets");
  assert.deepEqual(result.loads[0].vendors, ["Acme"]);
});

test("vendor and model history skips invalid MACs and empty marker values and enforces snapshot boundaries", () => {
  const history = new VendorModelHistoryAccumulator();
  assert.throws(() => history.addDevice({ mac: "00:11:22:33:44:55" }), /Начните Final/);
  history.beginSnapshot({ createdAt: "2026-01-01T00:00:00Z" });
  history.addDevice({ mac: "not a MAC", manufacturer: "Acme", model: "Board" });
  history.addDevice({ mac: "00:11:22:33:44:55", manufacturer: "Unknown", model: "Не указана" });
  assert.throws(() => history.beginSnapshot({}), /Сначала завершите/);
  history.endSnapshot();
  assert.deepEqual(history.result().vendors, []);
  assert.deepEqual(history.result().models, []);
});

test("vendor and model history excludes normalized and legacy placeholder values", () => {
  const history = new VendorModelHistoryAccumulator();
  history.beginSnapshot({ createdAt: "2026-03-01T00:00:00Z" });
  const placeholders = ["null", "undefined", "not found", "Не определено", "Неизвестный вендор", "Unknown model", "нет данных"];
  placeholders.forEach((value, index) => {
    const suffix = (index + 1).toString(16).padStart(2, "0");
    history.addDevice({
      mac: `00:11:22:33:44:${suffix}`,
      manufacturer: value,
      model: value,
    });
  });
  history.addDevice({ mac: "AA:BB:CC:11:22:33", manufacturer: "Unknown", vendor: "Recovered Vendor", model: "Unknown" });
  history.endSnapshot();
  const result = history.result();
  assert.deepEqual(result.vendors.map(({ vendor, occurrences }) => ({ vendor, occurrences })), [{ vendor: "Recovered Vendor", occurrences: 1 }]);
  assert.deepEqual(result.models, []);
});

test("vendor and model history includes imported observations with provenance without counting them as Finals", () => {
  const history = new VendorModelHistoryAccumulator();
  history.beginSnapshot({ id: "final-1", name: "Final January", createdAt: "2026-01-01T00:00:00Z" });
  history.addDevice({ mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board X" });
  history.endSnapshot();
  assert.equal(history.addObservation({
    id: "imported-1", kind: "vendor_model_history", source: "SQLite archive", observedAt: "2025-12-01T00:00:00Z",
    mac: "00-11-22-33-44-66", payload: { vendor: "Acme", model: "Board X" },
  }), true);
  assert.equal(history.addObservation({ id: "imported-empty-values", kind: "vendor_model_history", source: "Sparse.csv", observedAt: "2025-11-01T00:00:00Z", mac: "00:11:22:33:44:77", payload: {} }), true);
  assert.equal(history.addMappingRule({ kind: "vendor", prefix: "00112233", value: "Rule Vendor", source: "vendor-map.csv" }), true);
  assert.equal(history.addMappingRule({ kind: "model", prefix: "0011223344", value: "Rule Model", source: "model-map.csv", updatedAt: "2026-01-03T00:00:00Z" }), true);
  assert.equal(history.addMappingRule({ kind: "model", prefix: "INVALID", value: "Ignored Rule", source: "bad" }), false);
  assert.equal(history.addObservation({ id: "ignored", kind: "analysis_history", mac: "00:11:22:33:44:77", payload: { vendor: "Other" } }), false);
  assert.equal(history.addObservation({ id: "invalid", kind: "vendor_model_history", mac: "invalid", payload: { vendor: "Other" } }), false);
  const result = history.result();
  assert.equal(result.statistics.totalSnapshots, 1);
  assert.equal(result.statistics.importedObservations, 2);
  assert.equal(result.statistics.mappingRules, 2);
  assert.equal(result.statistics.loadRecords, 5);
  assert.deepEqual(result.vendors[0], {
    oui: "001122", vendor: "Acme", occurrences: 2, snapshots: 1, importedObservations: 1,
    sources: ["Final January", "SQLite archive"], firstSeen: "2025-12-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z",
  });
  assert.equal(result.models[0].occurrences, 2);
  assert.equal(result.models[0].snapshots, 1);
  assert.ok(result.vendors.some(({ oui, vendor, sources }) => oui === "001122" && vendor === "Rule Vendor" && sources.includes("vendor-map.csv")));
  assert.ok(result.models.some(({ prefix, model }) => prefix === "0011223344" && model === "Rule Model"));
  assert.equal(filterVendorModelHistory(result, { kind: "vendors", query: "sqlite archive" }).length, 1);
  assert.equal(filterVendorModelHistory(result, { kind: "models", query: "2025-12" }).length, 1);
  assert.deepEqual(selectVendorModelHistoryPage(result, { kind: "loads", query: "sparse.csv" }).rows.map(({ source, records, vendors, models }) => ({ source, records, vendors, models })), [
    { source: "Sparse.csv", records: 1, vendors: [], models: [] },
  ]);
});

test("imported OUI and MAC5 rules retain weighted occurrences and historical dates", () => {
  const history = new VendorModelHistoryAccumulator();
  history.addMappingRule({
    kind: "vendor", prefix: "001122", value: "Acme", source: "SQLite OUI history",
    occurrences: 17, firstSeen: "2025-02-03T00:00:00Z", lastSeen: "2026-02-03T00:00:00Z",
  });
  history.addMappingRule({
    kind: "model", prefix: "0011223344", value: "Board X", source: "SQLite MAC5 history",
    occurrences: 23, firstSeen: "2025-03-04T00:00:00Z", lastSeen: "2026-02-04T00:00:00Z",
  });
  const result = history.result();
  assert.deepEqual(result.vendors[0], {
    oui: "001122", vendor: "Acme", occurrences: 17, snapshots: 0, importedObservations: 0,
    sources: ["SQLite OUI history"], firstSeen: "2025-02-03T00:00:00Z", lastSeen: "2026-02-03T00:00:00Z",
  });
  assert.deepEqual(result.models[0], {
    prefix: "0011223344", model: "Board X", occurrences: 23, snapshots: 0, importedObservations: 0,
    sources: ["SQLite MAC5 history"], firstSeen: "2025-03-04T00:00:00Z", lastSeen: "2026-02-04T00:00:00Z",
  });
});

test("vendor and model history includes imported MAC and resolved-device observations with original sources", () => {
  const history = new VendorModelHistoryAccumulator();
  assert.equal(history.addObservation({
    id: "mac-history-1", kind: "mac_history", source: "Импорт SQLite", observedAt: "2026-02-01T00:00:00Z",
    mac: "—", payload: { macFormatted: "00:11:22:33:44:55", source_file: "room-scan.csv", vendor: "Room Vendor", model: "Room Model" },
  }), true);
  assert.equal(history.addObservation({
    id: "resolved-history-1", kind: "resolved_device_history", source: "Импорт SQLite", observedAt: "2026-02-02T00:00:00Z",
    payload: { decodedPayload: { mac_formatted: "00:11:22:33:44:66", source_file: "resolved.xlsx", manufacturer: "Resolved Vendor", device_model: "Resolved Model" } },
  }), true);
  assert.equal(history.addObservation({ id: "unrelated", kind: "analysis_history", payload: { mac: "00:11:22:33:44:77", vendor: "Ignored" } }), false);

  const result = history.result();
  assert.equal(result.statistics.totalSnapshots, 0);
  assert.equal(result.statistics.importedObservations, 2);
  assert.deepEqual(result.vendors.map(({ vendor, importedObservations, sources }) => ({ vendor, importedObservations, sources })), [
    { vendor: "Resolved Vendor", importedObservations: 1, sources: ["resolved.xlsx"] },
    { vendor: "Room Vendor", importedObservations: 1, sources: ["room-scan.csv"] },
  ]);
  assert.deepEqual(result.models.map(({ model, importedObservations, sources }) => ({ model, importedObservations, sources })), [
    { model: "Resolved Model", importedObservations: 1, sources: ["resolved.xlsx"] },
    { model: "Room Model", importedObservations: 1, sources: ["room-scan.csv"] },
  ]);
});

test("vendor and model load history includes imported legacy history_loads summaries", () => {
  const history = new VendorModelHistoryAccumulator();
  assert.equal(history.addObservation({
    id: "sqlite-history-loads-7", kind: "history_loads", source: "Импорт SQLite",
    observedAt: "2026-01-03T10:00:00.000Z",
    payload: {
      id: "7", filename: "C:\\Archive\\legacy-vendors.xlsx", devicesCount: 7,
      newVendorsAdded: 1, newModelsAdded: 2, enrichedFromHistory: 3,
    },
  }), true);
  assert.equal(history.addObservation({
    id: "sqlite-history-loads-7", kind: "history_loads", payload: { filename: "duplicate.csv", devicesCount: 99 },
  }), false);
  assert.equal(history.addObservation({ kind: "history_loads", payload: { filename: "missing-id.csv" } }), false);
  assert.equal(history.addObservation({
    id: "sqlite-history-loads-invalid", kind: "history_loads", payload: { filename: "invalid.csv", devicesCount: -4, newVendorsAdded: "bad" },
  }), true);
  const result = history.result();
  assert.equal(result.statistics.totalSnapshots, 0);
  assert.equal(result.statistics.importedObservations, 0);
  assert.equal(result.statistics.importedLoads, 2);
  assert.equal(result.statistics.loadRecords, 2);
  assert.deepEqual(result.loads.find(({ importedLoadId }) => importedLoadId === "sqlite-history-loads-7"), {
    source: "SQLite · legacy-vendors.xlsx", records: 7, vendors: [], models: [],
    lastSeen: "2026-01-03T10:00:00.000Z", devicesCount: 7, newVendorsAdded: 1,
    newModelsAdded: 2, enrichedFromHistory: 3, importedLoadId: "sqlite-history-loads-7",
  });
  assert.equal(result.loads.find(({ importedLoadId }) => importedLoadId === "sqlite-history-loads-invalid").devicesCount, 0);
  assert.deepEqual(selectVendorModelHistoryPage(result, { kind: "loads", query: "legacy-vendors.xlsx" }).rows.map(({ source, records, newVendorsAdded, newModelsAdded, enrichedFromHistory }) => ({ source, records, newVendorsAdded, newModelsAdded, enrichedFromHistory })), [
    { source: "SQLite · legacy-vendors.xlsx", records: 7, newVendorsAdded: 1, newModelsAdded: 2, enrichedFromHistory: 3 },
  ]);
});

test("vendor-model history keeps SQLite loads separate from source names that resemble internal IDs", () => {
  const build = (sqliteFirst) => {
    const history = new VendorModelHistoryAccumulator();
    const addSqliteLoad = () => history.addObservation({
      id: "load-7",
      kind: "history_loads",
      payload: { id: "7", filename: "legacy-load:7", devicesCount: 9 },
    });
    const addSnapshot = () => {
      history.beginSnapshot({ name: "legacy-load:7", createdAt: "2026-10-28T00:00:00Z" });
      history.addDevice({ mac: "00:11:22:33:44:55", manufacturer: "Acme", model: "Board X" });
      history.endSnapshot();
    };
    if (sqliteFirst) addSqliteLoad();
    addSnapshot();
    if (!sqliteFirst) addSqliteLoad();
    return history.result();
  };

  for (const sqliteFirst of [false, true]) {
    const result = build(sqliteFirst);
    assert.equal(result.statistics.loadRecords, 2);
    assert.deepEqual(result.loads.map(({ source, records, importedLoadId }) => ({ source, records, importedLoadId })).sort((left, right) => left.importedLoadId ? -1 : right.importedLoadId ? 1 : 0), [
      { source: "SQLite · legacy-load:7", records: 9, importedLoadId: "load-7" },
      { source: "legacy-load:7", records: 1, importedLoadId: undefined },
    ]);
  }
});

test("vendor and model history search and pagination cover the complete aggregates", () => {
  const history = new VendorModelHistoryAccumulator();
  history.beginSnapshot({ createdAt: "2026-01-01T00:00:00Z" });
  for (let index = 0; index < 120; index += 1) {
    const suffix = index.toString(16).padStart(4, "0").slice(-4);
    history.addDevice({ mac: `00:11:${suffix.slice(0, 2)}:${suffix.slice(2)}:00:01`, manufacturer: `Vendor ${index}`, model: `Model ${index}` });
  }
  history.endSnapshot();
  const aggregate = history.result();
  const lastPage = selectVendorModelHistoryPage(aggregate, { kind: "vendors", page: 3, limit: 50 });
  assert.equal(lastPage.total, 120);
  assert.equal(lastPage.rows.length, 20);
  assert.equal(lastPage.hasNext, false);
  assert.equal(lastPage.hasPrevious, true);
  const matches = filterVendorModelHistory(aggregate, { kind: "models", query: "Model 11" });
  assert.equal(matches.length, 11);
  assert.ok(matches.some((item) => item.model === "Model 11"));
  const vendorMatches = filterVendorModelHistory(aggregate, { kind: "vendors", query: "1" });
  assert.ok(vendorMatches.every((item) => item.oui.includes("1") || item.vendor.includes("1")));
  assert.equal(selectVendorModelHistoryPage(aggregate, { kind: "models", query: "missing" }).pageCount, 1);
});

test("vendor-model history pagination filters in place and caps retained rows at 1,000", () => {
  const vendors = Array.from({ length: 10_000 }, (_, index) => ({
    oui: `00:${String(index >>> 16).padStart(2, "0")}:${String(index >>> 8 & 0xff).padStart(2, "0")}`,
    vendor: index % 10 === 0 ? `Target ${index}` : `Vendor ${index}`,
  }));
  Object.defineProperty(vendors, "filter", { value() { throw new Error("pagination must not allocate a full filtered array"); } });
  let traversals = 0;
  const iterate = vendors[Symbol.iterator].bind(vendors);
  Object.defineProperty(vendors, Symbol.iterator, { value: function* () { traversals += 1; yield* iterate(); } });

  const page = selectVendorModelHistoryPage({ vendors }, { query: "target", page: 50, limit: 10 });
  assert.equal(page.total, 1_000);
  assert.equal(page.pageCount, 100);
  assert.equal(page.page, 50);
  assert.deepEqual(page.rows.map(({ vendor }) => vendor), Array.from({ length: 10 }, (_, index) => `Target ${4_900 + index * 10}`));
  assert.equal(traversals, 1, "a filtered page and exact total should share one source traversal");

  const oversizedPage = selectVendorModelHistoryPage({ vendors }, { query: "target", page: 50_000, limit: 50_000 });
  assert.equal(oversizedPage.rows.length, 1_000);
  assert.equal(oversizedPage.total, 1_000);
  assert.equal(oversizedPage.page, 1);
  assert.equal(oversizedPage.rows.at(-1).vendor, "Target 9990");
  assert.equal(traversals, 2);
});
