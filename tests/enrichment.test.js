import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { applyDdIoIp, buildDdIoIndex, buildDdIoIndexFromRows, collectCurrentSmartroomRoomTargets, enrich, mapRow, mergeDevice, STRATEGIES } from "../src/core/enrichment.js";
import { buildHistoricalAddressIndex, buildImportedSmartroomRoomIndex, buildSmartroomRoomIndex } from "../src/core/historical-mapping.js";
import { Database } from "../src/data/database.js";
import { readTableRowBatches } from "../src/data/importer.js";
import { customInventoryColumnKey } from "../src/core/inventory-columns.js";
import { buildIdentityIndex } from "../src/core/identity.js";
import { compactPreviousFinalDevice, loadCompactSnapshot, trimComparisonBaseline } from "../src/core/compact-final-analytics.js";

const mappings = {
  main: { mac: 0, switchIp: 1 },
  smartroom: { mac: 0, ip: 1, room: 2, model: 3 },
  ddio: { reservationIp: 0, reservationMac: 1, leaseIp: 2, leaseMac: 3 },
};

async function* rowBatches(rows, size = 1) {
  for (let index = 0; index < rows.length; index += size) yield rows.slice(index, index + size);
}

test("Main without strong identities is rejected before SmartRoom expansion can create or retain rows", async () => {
  const invalidInputs = [
    { mainRows: [["—"]], mappings: { main: { mac: 0 } } },
    { mainDevices: [{ id: "valid", mac: "00:11:22:33:44:55" }, { manufacturer: "Acme" }] },
  ];
  for (const main of invalidInputs) {
    let smartroomRead = false;
    async function* smartroomRows() {
      smartroomRead = true;
      yield ["AA:BB:CC:DD:EE:FF", "10.0.0.5", "Room 5"];
    }
    await assert.rejects(enrich({
      ...main,
      smartroomRows: smartroomRows(),
      mappings: { ...main.mappings, smartroom: { mac: 0, ip: 1, room: 2 } },
      strategy: STRATEGIES.ALLOW_EXPANSION,
    }), /сильн.*идентификатор/);
    assert.equal(smartroomRead, false, "invalid Main must fail before SmartRoom can create rows");
  }
});

test("blank Main and SmartRoom rows do not count as invalid devices or shift source row numbers", async () => {
  const result = await enrich({
    mainRows: [[""], ["00:11:22:33:44:55"]],
    smartroomRows: [[""], ["00:11:22:33:44:55", "10.0.0.5", "Room 5"]],
    mappings: {
      main: { mac: 0 },
      smartroom: { mac: 0, ip: 1, room: 2 },
      ddio: {},
    },
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].room, "Room 5");
  assert.equal(result.diagnostics.counts.mainRaw, 2);
  assert.equal(result.diagnostics.counts.smartroomRaw, 2);
  assert.equal(result.diagnostics.counts.invalidTotal || 0, 0);
  assert.deepEqual(result.diagnostics.invalid, []);
});

test("paged Final storage preserves enrichment output while releasing the full device array", async () => {
  const input = {
    mainRows: [["00:11:22:33:44:55", "10.0.0.10"]],
    smartroomRows: [["00:11:22:33:44:55", "", "Room 20", "Model 20"]],
    ddioRows: [["10.0.0.30", "00:11:22:33:44:55", "", ""]],
    mappings: {
      main: { mac: 0, switchIp: 1 },
      smartroom: { mac: 0, ip: 1, room: 2, model: 3 },
      ddio: { reservationIp: 0, reservationMac: 1, leaseIp: 2, leaseMac: 3 },
    },
  };
  const expected = await enrich(input);
  const pages = [];
  const identities = new Map();
  const deviceStore = {
    count: 0,
    async appendPage(rows, { offset, identityEntries = new Map() }) {
      assert.equal(offset, this.count);
      pages.push(...globalThis.structuredClone(rows));
      for (const [key, value] of identityEntries) identities.set(key, globalThis.structuredClone(value));
      this.count += rows.length;
      return rows.length;
    },
    async readPage(offset, limit) { return globalThis.structuredClone(pages.slice(offset, offset + limit)); },
    async readPositions(positions) { return new Map(positions.map((position) => [position, globalThis.structuredClone(pages[position])])); },
    async readIdentityEntries(keys) { return new Map(keys.filter((key) => identities.has(key)).map((key) => [key, globalThis.structuredClone(identities.get(key))])); },
    async writeIdentityEntries(entries) { for (const [key, value] of entries) identities.set(key, globalThis.structuredClone(value)); return entries.size; },
    async writePage(offset, rows) { pages.splice(offset, rows.length, ...globalThis.structuredClone(rows)); return rows.length; },
  };
  const actual = await enrich({ ...input, deviceStore });
  const comparableDevices = (devices) => devices.map((device) => {
    const copy = globalThis.structuredClone(device);
    delete copy.observedAt;
    return copy;
  });
  assert.deepEqual(comparableDevices(pages), comparableDevices(expected.devices));
  assert.deepEqual(actual.diagnostics, expected.diagnostics);
  assert.equal(actual.deviceCount, expected.devices.length);
  assert.deepEqual(actual.devices, []);
  assert.equal(actual.deviceStore, deviceStore);
  assert.equal(deviceStore.count, expected.devices.length);
  assert.equal(pages[0].ip, "10.0.0.30");
  assert.equal(pages[0].room, "Room 20");
  assert.equal(pages[0].model, "Model 20");
});

test("paged Final storage append failures abort enrichment instead of returning an incomplete Final", async () => {
  const deviceStore = {
    count: 0,
    async appendPage() { throw new Error("disk full"); },
    async readPage() { return []; },
    async readPositions() { return new Map(); },
    async readIdentityEntries() { return new Map(); },
    async writeIdentityEntries() { return 0; },
    async writePage() { return 0; },
  };
  await assert.rejects(enrich({
    mainRows: [["00:11:22:33:44:55"]],
    mappings: { main: { mac: 0 }, smartroom: {}, ddio: {} },
    deviceStore,
  }), /disk full/);
});

test("paged Final validation still rejects duplicate internal IDs", async () => {
  const records = [];
  const deviceStore = {
    count: 0,
    async appendPage(rows) { records.push(...globalThis.structuredClone(rows)); this.count += rows.length; return rows.length; },
    async readPage(offset, limit) { return globalThis.structuredClone(records.slice(offset, offset + limit)); },
    async writePage(offset, rows) { records.splice(offset, rows.length, ...globalThis.structuredClone(rows)); return rows.length; },
  };
  const mainDevices = Array.from({ length: 501 }, (_, index) => ({
    id: index === 0 || index === 500 ? "duplicated-id" : `device-${index}`,
    mac: `00:11:22:33:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    fieldSources: {},
    sources: [],
  }));
  await assert.rejects(enrich({
    mainDevices,
    smartroomRows: [],
    deviceStore,
  }), /дубли внутренних ID/);
});

test("enrichment persists every page update through the IndexedDB Final staging API", async () => {
  const database = new Database(`enrichment-final-stage-${crypto.randomUUID()}`);
  const queryId = `final-device-stage:${crypto.randomUUID()}`;
  const deviceStore = {
    count: 0,
    async appendPage(devices, { offset, total, identityEntries = new Map() }) {
      const appended = await database.appendFinalDeviceStageChunk(queryId, devices, { offset, total, identityEntries });
      this.count = offset + appended;
      return appended;
    },
    readPage: (offset, limit) => database.finalDeviceStagePage(queryId, { offset, limit }),
    readPositions: (positions) => database.finalDeviceStageDevicesAtPositions(queryId, positions),
    readIdentityEntries: (keys) => database.finalDeviceStageIdentityEntries(queryId, keys),
    appendDdIoEvidencePage: (index) => database.appendFinalDdIoEvidencePage(queryId, index),
    ddIoEvidenceForKeys: (macs, deviceIds) => database.finalDdIoEvidenceForKeys(queryId, macs, deviceIds),
    writeIdentityEntries: (entries, maxPositionExclusive) => database.writeFinalDeviceStageIdentityEntries(queryId, entries, { maxPositionExclusive }),
    writePositions: (updates) => database.replaceFinalDeviceStageDevicesAtPositions(queryId, updates),
    writePage: (offset, devices) => database.replaceFinalDeviceStagePage(queryId, { offset, devices }),
    finalize: (total) => database.finalizeFinalDeviceStage(queryId, total),
  };
  try {
    const mainRows = Array.from({ length: 501 }, (_, index) => [
      index === 0 || index === 500 ? "00:11:22:33:44:55" : `00:11:22:33:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
      index === 1 ? "10.0.0.101" : "",
      index === 0 ? "" : index === 500 ? "10.0.0.99" : "10.0.0.1",
      index === 1 ? "Device-1" : "",
    ]);
    const input = {
      mainRows,
      smartroomRows: [
        ["00:11:22:33:44:55", "", "Room 5", "Model 5"],
        ["00:11:22:33:EE:02", "", "Expansion room", "Expansion model"],
      ],
      ddioRows: Array.from({ length: 502 }, (_, index) => index === 0
        ? ["10.0.0.5", "00:11:22:33:44:55", "", ""]
        : index === 1
          ? ["10.0.0.77", "00:11:22:33:00:01", "", "", "Device-1"]
          : index === 2
            ? ["10.0.0.79", "", "", "", "Device-1"]
            : index === 501
          ? ["10.0.0.78", "00:11:22:33:00:01", "", "", "Device-1"]
          : ["10.0.0.88", "AA:BB:CC:DD:EE:FF", "", ""]),
      mappings: {
        main: { mac: 0, ip: 1, switchIp: 2, deviceId: 3 },
        smartroom: { mac: 0, ip: 1, room: 2, model: 3 },
        ddio: { reservationIp: 0, reservationMac: 1, leaseIp: 2, leaseMac: 3, deviceId: 4 },
      },
      strategy: STRATEGIES.ALLOW_EXPANSION,
    };
    const expected = await enrich(input);
    const result = await enrich({
      ...input,
      mainRows: rowBatches(mainRows, 137),
      deviceStore,
    });
    const firstPage = await database.finalDeviceStagePage(queryId, { offset: 0, limit: 500 });
    const lastPage = await database.finalDeviceStagePage(queryId, { offset: 500, limit: 1 });
    assert.equal(result.deviceCount, 501);
    assert.equal(result.diagnostics.counts.mainRaw, 501);
    assert.equal(result.diagnostics.counts.mainUnique, 500);
    assert.equal(result.diagnostics.counts.afterSmartroom, 501);
    assert.deepEqual(result.devices, []);
    assert.equal(deviceStore.count, 501);
    assert.equal(firstPage.length, 500);
    assert.equal(lastPage.length, 1);
    assert.equal(firstPage[0].switchIp, "10.0.0.99", "a duplicate Main row after the persisted page boundary merges into the first device");
    assert.equal(firstPage[0].ip, "10.0.0.5");
    assert.equal(firstPage[0].room, "Room 5");
    assert.equal(firstPage[0].model, "Model 5");
    assert.equal(firstPage[1].ip, "10.0.0.101", "DDIO keeps the known Main IP");
    assert.deepEqual(firstPage[1].possibleIps, ["10.0.0.77", "10.0.0.78", "10.0.0.79"], "MAC and Device ID evidence merges across scratch pages and is persisted without replacing a known IP");
    assert.equal(lastPage[0].mac, "00:11:22:33:EE:02");
    assert.equal(lastPage[0].room, "Expansion room");
    const identityEntries = await database.finalDeviceStageIdentityEntries(queryId, ["mac:00:11:22:33:44:55", "mac:00:11:22:33:EE:02"]);
    assert.equal(identityEntries.get("mac:00:11:22:33:44:55"), 0, "the exact matching key is persisted by position, not retained across the full Main set in RAM");
    assert.equal(identityEntries.get("mac:00:11:22:33:EE:02"), 500, "SmartRoom expansion identities are persisted as well");
    const withoutRuntimeTimestamp = (rows) => rows.map((row) => {
      const copy = globalThis.structuredClone(row);
      delete copy.observedAt;
      return copy;
    });
    assert.deepEqual(withoutRuntimeTimestamp([...firstPage, ...lastPage]), withoutRuntimeTimestamp(expected.devices));
    assert.deepEqual(result.diagnostics, expected.diagnostics);
    const saved = await database.saveFinal({
      id: "streamed-main-final",
      name: "Streamed Main",
      devices: [],
      stagedDeviceQueryId: queryId,
      stagedDeviceCount: result.deviceCount,
      updateInventory: false,
    });
    assert.equal(saved.deviceCount, 501, "finalized dynamic staging can commit atomically into Final");
    await database.clearAnalyticsAggregateQuery(queryId);
    const clearedDdIo = await database.finalDdIoEvidenceForKeys(queryId, ["00:11:22:33:00:01"], ["device-1"]);
    assert.equal(clearedDdIo.size, 0);
    assert.equal(clearedDdIo.byDeviceId.size, 0, "successful Final commit cleanup removes spilled DDIO evidence");
    assert.equal((await database.finalDeviceStageIdentityEntries(queryId, ["mac:00:11:22:33:44:55", "mac:00:11:22:33:EE:02"])).size, 0,
      "the coordinator cleanup removes temporary disk-backed identity entries after commit");
    assert.ok(firstPage[0].observedAt);
  } finally {
    await database.clearAnalyticsAggregateQuery(queryId);
    (await database.open()).close();
  }
});

test("Main-only imports clear the duplicate identity index immediately after Main normalization", async () => {
  const originalClear = globalThis.Map.prototype.clear;
  let mainIdentityIndexCleared = false;
  globalThis.Map.prototype.clear = function observeMainIdentityIndexClear() {
    if ([...this.keys()].some((key) => key === "mac:00:11:22:33:44:55")) mainIdentityIndexCleared = true;
    return originalClear.call(this);
  };
  let result;
  try {
    result = await enrich({
      mainRows: [
        ["00:11:22:33:44:55", "10.0.0.1"],
        ["00:11:22:33:44:55", "10.0.0.1"],
      ],
      smartroomRows: [],
      mappings: { main: { mac: 0, ip: 1 }, smartroom: {}, ddio: {} },
    });
  } finally {
    globalThis.Map.prototype.clear = originalClear;
  }
  assert.equal(mainIdentityIndexCleared, true);
  assert.equal(result.devices.length, 1, "Main duplicate collapse still uses its index before clearing it");
  assert.equal(result.diagnostics.counts.smartroomRaw, 0);
});

test("pre-normalized Main rejects conflicting identity aliases before reading SmartRoom", async () => {
  let smartroomRead = false;
  const mainDevices = [{
    id: "device-a",
    mac: "00:11:22:33:44:55",
    conflicts: [{
      field: "identity",
      identifier: "id",
      selected: "device-a",
      alternative: "device-b",
      reason: "Конфликтующие алиасы сильного идентификатора (id / internalDeviceId)",
    }],
  }];
  const smartroomRows = {
    async *[Symbol.asyncIterator]() {
      smartroomRead = true;
      yield ["AA:BB:CC:DD:EE:FF"];
    },
  };

  await assert.rejects(enrich({ mainDevices, smartroomRows }), /строка 2.*конфликт алиасов сильного идентификатора/i);
  assert.equal(smartroomRead, false);
  assert.equal(mainDevices[0].id, "device-a", "validation must not mutate the caller's normalized records");
});

test("enrichment reuses the exact Previous Final identity index for field carry-forward", async () => {
  const previous = [{ id: "previous-device", mac: "00:11:22:33:44:01", model: "Known model" }];
  const baseIndex = buildIdentityIndex(previous);
  let tokenReads = 0;
  const previousIdentityIndex = {
    devices: previous,
    tokens: { get(key) { tokenReads += 1; return baseIndex.tokens.get(key); } },
  };

  const result = await enrich({
    mainRows: [["00:11:22:33:44:01"]],
    mappings: { main: { mac: 0 } },
    previousFinal: previous,
    previousIdentityIndex,
  });

  assert.ok(tokenReads > 0, "the supplied index must serve Previous Final identity matching");
  assert.equal(result.devices[0].id, "previous-device");
  assert.equal(result.devices[0].model, "Known model");
});

test("enrichment resolves Previous Final identity in bounded current-device batches", async () => {
  const previous = Array.from({ length: 1_002 }, (_, index) => ({
    id: `previous-${index}`,
    mac: `00:11:22:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
    model: `Model ${index}`,
    modelSource: "Previous Final",
    fieldSources: {},
  }));
  const mainDevices = previous.map(({ id, mac }) => ({ id, mac, fieldSources: {} }));
  const requestedBatchSizes = [];
  const result = await enrich({
    mainDevices,
    loadPreviousIdentityIndex: async (currentBatch) => {
      requestedBatchSizes.push(currentBatch.length);
      const ids = new Set(currentBatch.map(({ id }) => id));
      return buildIdentityIndex(previous.filter(({ id }) => ids.has(id)));
    },
  });

  assert.deepEqual(requestedBatchSizes, [500, 500, 2]);
  assert.equal(result.devices.length, 1_002);
  assert.equal(result.devices[0].model, "Model 0");
  assert.equal(result.devices[1_001].model, "Model 1001");
  assert.equal(result.devices[1_001].modelSource, "Previous Final");
});

test("trimming a consumed Previous Final preserves identity matching and exact History comparison", async () => {
  const previous = [{
    id: "previous-trimmed", mac: "00:11:22:33:44:01", ip: "10.0.0.1", model: "Known model",
    customFields: { owner: "Facilities" }, customFieldSources: { owner: "Previous Final" },
    fieldSources: { model: "Imported model" }, conflicts: [{ field: "model", value: "Old" }],
    possibleIps: ["10.0.0.2"],
  }];
  const previousIdentityIndex = buildIdentityIndex(previous);
  const result = await enrich({
    mainRows: [["00:11:22:33:44:01", "10.0.0.9"]],
    mappings: { main: { mac: 0, ip: 1 } },
    previousFinal: previous,
    previousIdentityIndex,
  });
  const { compareFinals } = await import("../src/core/comparison.js");
  const timestamp = "2026-10-19T00:00:00.000Z";
  const expected = compareFinals(previous, result.devices, timestamp, { previousIdentityIndex });

  trimComparisonBaseline(previous);

  const actual = compareFinals(previous, result.devices, timestamp, { previousIdentityIndex });
  assert.deepEqual(actual, expected);
  assert.equal(result.devices[0].model, "Known model");
  assert.equal(previous[0].customFields, undefined);
  assert.equal(previous[0].fieldSources, undefined);
  assert.equal(previous[0].conflicts, undefined);
  assert.deepEqual(previous[0].alternateMacs, undefined);
});

test("production enrichment trims consumed Previous Final merge-only fields after preserving them", async () => {
  const previousFinal = [{
    id: "trim-consumed-previous",
    mac: "00:11:22:33:44:81",
    model: "Previous model",
    customFields: { owner: "Facilities" },
    customFieldSources: { owner: "Legacy SQLite" },
    fieldSources: { model: "PyQt history" },
    possibleIps: ["10.0.0.81"],
    sources: ["Previous Final"],
    conflicts: [{ field: "model", selected: "Previous model" }],
  }, { id: "trim-unmatched-previous", mac: "00:11:22:33:44:82", model: "Absent model", customFields: { owner: "Old" }, possibleIps: ["10.0.0.82"] }];
  const mainRows = [["00:11:22:33:44:81"]];
  const referencePrevious = previousFinal.map((device) => ({ ...device, ...(device.customFields ? { customFields: { ...device.customFields } } : {}), ...(device.customFieldSources ? { customFieldSources: { ...device.customFieldSources } } : {}), ...(device.fieldSources ? { fieldSources: { ...device.fieldSources } } : {}), ...(device.possibleIps ? { possibleIps: [...device.possibleIps] } : {}), ...(device.sources ? { sources: [...device.sources] } : {}), ...(device.conflicts ? { conflicts: device.conflicts.map((item) => ({ ...item })) } : {}) }));
  const reference = await enrich({
    mainRows,
    mappings: { main: { mac: 0 } },
    previousFinal: referencePrevious,
    previousIdentityIndex: buildIdentityIndex(referencePrevious),
  });
  const result = await enrich({
    mainRows,
    mappings: { main: { mac: 0 } },
    previousFinal,
    previousIdentityIndex: buildIdentityIndex(previousFinal),
    trimConsumedPreviousFinal: true,
  });
  const withoutObservedAt = (devices) => devices.map((device) => { const copy = { ...device }; delete copy.observedAt; return copy; });
  assert.deepEqual(withoutObservedAt(result.devices), withoutObservedAt(reference.devices), "early field release preserves the ordinary merge result");
  assert.ok(referencePrevious[0].customFields, "the default core API does not mutate caller-owned Previous Final data");
  trimComparisonBaseline(referencePrevious);
  const { compareFinals } = await import("../src/core/comparison.js");
  const historyAt = "2026-10-19T00:00:00.000Z";
  assert.deepEqual(
    compareFinals(previousFinal, withoutObservedAt(result.devices), historyAt, { previousIdentityIndex: buildIdentityIndex(previousFinal) }),
    compareFinals(referencePrevious, withoutObservedAt(reference.devices), historyAt, { previousIdentityIndex: buildIdentityIndex(referencePrevious) }),
    "trimmed matched and unmatched baselines keep identical History comparison",
  );
  assert.equal(result.devices[0].id, "trim-consumed-previous");
  assert.equal(result.devices[0].model, "Previous model");
  assert.equal(result.devices[0].fieldSources.model, "Previous Final");
  assert.equal(result.devices[0].customFields.owner, "Facilities");
  assert.equal(result.devices[0].customFieldSources.owner, "Legacy SQLite");
  assert.equal(result.devices[0].possibleIps[0], "10.0.0.81");
  assert.equal(previousFinal[0].model, "Previous model", "comparison fields remain in the detached baseline");
  assert.equal(previousFinal[0].customFields, undefined, "merge-only custom fields are released after their final match");
  assert.equal(previousFinal[0].fieldSources, undefined);
  assert.equal(previousFinal[0].possibleIps, undefined);
  assert.equal(previousFinal[0].conflicts, undefined);
  assert.equal(previousFinal[1].model, "Absent model", "unmatched rows retain comparison values");
  assert.equal(previousFinal[1].customFields, undefined, "unmatched rows release merge-only fields after the Main pass");
});

test("12,249-row CSV streams through importer batches into the full enrichment pipeline", async () => {
  const rowCount = 12_249;
  const macAt = (index) => {
    const high = Math.floor(index / 256).toString(16).padStart(2, "0");
    const low = (index % 256).toString(16).padStart(2, "0");
    return `02:00:00:00:${high}:${low}`;
  };
  const ipAt = (index) => `10.20.${Math.floor((index - 1) / 254)}.${((index - 1) % 254) + 1}`;
  const csvFile = (name, header, records) => Object.assign(
    new globalThis.Blob([`${header}\n${records}`], { type: "text/csv" }),
    { name },
  );
  const mainRecords = [];
  const smartroomRecords = [];
  const ddioRecords = [];
  for (let index = 1; index <= rowCount; index += 1) {
    const mac = macAt(index);
    mainRecords.push(`${mac};asset-${index}`);
    smartroomRecords.push(`${mac};${index % 2 === 0 ? ipAt(index) : ""};Room-${index % 100};Model-${index % 15}`);
    ddioRecords.push(`${mac};${ipAt(index)}`);
  }
  const files = {
    main: csvFile("large-main.csv", "MAC;Device ID", mainRecords.join("\n")),
    smartroom: csvFile("large-smartroom.csv", "MAC;IP;Room;Model", smartroomRecords.join("\n")),
    ddio: csvFile("large-ddio.csv", "Reservation MAC;Reservation IP", ddioRecords.join("\n")),
  };
  mainRecords.length = 0;
  smartroomRecords.length = 0;
  ddioRecords.length = 0;
  const batchMetrics = Object.fromEntries(Object.keys(files).map((role) => [role, { headers: [], count: 0, maximum: 0 }]));
  let maximumBatch = 0;
  async function* rowsFor(role) {
    const metrics = batchMetrics[role];
    for await (const batch of readTableRowBatches(files[role], {
      batchSize: 500,
      onHeaders: (metadata) => { metrics.headers = metadata.headers; },
    })) {
      metrics.count += 1;
      metrics.maximum = Math.max(metrics.maximum, batch.length);
      maximumBatch = Math.max(maximumBatch, batch.length);
      assert.ok(batch.length <= 500);
      yield batch;
    }
  }

  const result = await enrich({
    mainRows: rowsFor("main"),
    smartroomRows: rowsFor("smartroom"),
    ddioRows: rowsFor("ddio"),
    mappings: {
      main: { mac: 0, deviceId: 1 },
      smartroom: { mac: 0, ip: 1, room: 2, model: 3 },
      ddio: { reservationMac: 0, reservationIp: 1 },
    },
  });
  assert.deepEqual(batchMetrics.main.headers, ["MAC", "Device ID"]);
  assert.deepEqual(batchMetrics.smartroom.headers, ["MAC", "IP", "Room", "Model"]);
  assert.deepEqual(batchMetrics.ddio.headers, ["Reservation MAC", "Reservation IP"]);
  for (const metrics of Object.values(batchMetrics)) {
    assert.equal(metrics.count, Math.ceil(rowCount / 500));
    assert.equal(metrics.maximum, 500);
  }
  assert.equal(maximumBatch, 500);
  assert.equal(result.diagnostics.counts.mainRaw, rowCount);
  assert.equal(result.diagnostics.counts.mainUnique, rowCount);
  assert.equal(result.diagnostics.counts.smartroomRaw, rowCount);
  assert.equal(result.devices.length, rowCount);
  assert.equal(result.devices[0].deviceId, "asset-1");
  assert.equal(result.devices[0].ip, ipAt(1));
  assert.equal(result.devices[0].fieldSources.ip, "DDIO");
  assert.equal(result.devices[0].room, "Room-1");
  assert.equal(result.devices[0].model, "Model-1");
  assert.equal(result.devices[1].ip, ipAt(2));
  assert.equal(result.devices[1].fieldSources.ip, "SmartRoom");
  assert.equal(result.devices.at(-1).deviceId, `asset-${rowCount}`);

  const database = new Database(`import-enrichment-${globalThis.crypto.randomUUID()}`);
  await database.saveFinal({ id: "import-enrichment-final", name: "CSV enrichment stress", devices: result.devices });
  const metadata = await database.activeSnapshotMetadata();
  assert.equal(metadata.id, "import-enrichment-final");
  assert.equal(metadata.deviceCount, rowCount);
  assert.equal(metadata.chunkCount, Math.ceil(rowCount / 500));
  assert.equal(await database.inventoryCount(), rowCount);
  const firstPage = await database.loadSnapshotPage(metadata.id, { page: 1, limit: 500 });
  const lastPage = await database.loadSnapshotPage(metadata.id, { page: metadata.chunkCount, limit: 500 });
  assert.equal(firstPage.total, rowCount);
  assert.equal(firstPage.devices.length, 500);
  assert.equal(firstPage.devices[0].fieldSources.ip, "DDIO");
  assert.equal(lastPage.devices.length, rowCount % 500);
  assert.equal(lastPage.devices.at(-1).deviceId, `asset-${rowCount}`);
  (await database.open()).close();
});

test("authentication time accepts text dates and XLSX serial cells parsed as strings", () => {
  assert.equal(mapRow(["46000.5"], { authenticationTime: 0 }, "Main").authenticationTime, "2025-12-09T12:00:00.000Z");
  assert.equal(mapRow(["01.02.2026 03:04:05"], { authenticationTime: 0 }, "Main").authenticationTime, "2026-02-01T03:04:05.000Z");
  assert.equal(mapRow(["2026-09-13 10:15:00"], { authenticationTime: 0 }, "Main").authenticationTime, "2026-09-13T10:15:00.000Z");
});

test("enrichment fills manufacturer from the longest IEEE allocation prefix", async () => {
  const result = await enrich({
    mainRows: [["AA:BB:CC:DD:EE:FF"]],
    mappings: { main: { mac: 0 }, smartroom: {}, ddio: {} },
    ouiIndex: new Map([["AABBCC", "Short allocation"], ["AABBCCD", "Extended allocation"]]),
  });
  assert.equal(result.devices[0].manufacturer, "Extended allocation");
  assert.equal(result.devices[0].vendorConfidence, 0.95);
  assert.equal(result.devices[0].vendorSource, "OUI");
  assert.equal(result.devices[0].fieldSources.manufacturer, "OUI");
});

test("legacy enrichment field switches suppress only optional source merges and keep identity plus DDIO rules", async () => {
  const enrichmentFieldSettings = Object.fromEntries(Object.keys({
    model: true, address: true, ip: true, vendor: true, room: true, switch_ip: true, switch_port: true,
  }).map((field) => [field, false]));
  const result = await enrich({
    mainRows: [["AA:BB:CC:DD:EE:01"]],
    smartroomRows: [["AA:BB:CC:DD:EE:01", "10.0.0.2", "101", "Switch X", "Acme", "10.0.0.1", "Gi1/0/1", "SR-1"]],
    ddioRows: [["10.0.0.99", "AA:BB:CC:DD:EE:01"]],
    mappings: {
      main: { mac: 0 },
      smartroom: { mac: 0, ip: 1, room: 2, model: 3, manufacturer: 4, switchIp: 5, switchPort: 6, smartroomId: 7 },
      ddio: { reservationIp: 0, reservationMac: 1 },
    },
    enrichmentFieldSettings,
  });
  const [device] = result.devices;
  assert.equal(device.mac, "AA:BB:CC:DD:EE:01");
  assert.equal(device.smartroomId, "SR-1");
  assert.equal(device.ip, "10.0.0.99", "the independent exact-MAC DDIO overlay remains active");
  assert.equal(device.room, "");
  assert.equal(device.model, "");
  assert.equal(device.manufacturer, "");
  assert.equal(device.switchIp, "");
  assert.equal(device.switchPort, "");
});

test("legacy enrichment field switches apply to Previous Final without restoring devices", async () => {
  const result = await enrich({
    mainRows: [["AA:BB:CC:DD:EE:02"]],
    mappings: { main: { mac: 0 }, smartroom: {}, ddio: {} },
    previousFinal: [{ mac: "AA:BB:CC:DD:EE:02", model: "Old model", address: "Room 2" }],
    enrichmentFieldSettings: { model: false, address: false },
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].model, "");
  assert.equal(result.devices[0].address, "");
});

test("enrichment uses user OUI overrides from 3, 4, and 5-byte prefixes by longest match", async () => {
  const result = await enrich({
    mainRows: [["AA:BB:CC:DD:EE:FF"]],
    mappings: { main: { mac: 0 }, smartroom: {}, ddio: {} },
    ouiIndex: new Map([
      ["AABBCC", "3-byte vendor"],
      ["AABBCCDD", "4-byte vendor"],
      ["AABBCCDDEE", "5-byte vendor"],
    ]),
  });
  assert.equal(result.devices[0].manufacturer, "5-byte vendor");
  assert.equal(result.devices[0].fieldSources.manufacturer, "OUI");
});

test("normalized single-file devices use the shared local enrichment pipeline in place", async () => {
  const devices = [{
    id: "single-analysis-device",
    mac: "AA:BB:CC:DD:EE:FF",
    manufacturer: "",
    model: "",
    fieldSources: {},
  }];
  const result = await enrich({
    mainDevices: devices,
    ouiIndex: new Map([["AABBCC", "Local OUI Vendor"]]),
    knownModels: new Map([["AA:BB:CC:DD:EE:FF", "Known Model"]]),
  });
  assert.equal(result.devices, devices);
  assert.equal(result.devices[0].manufacturer, "Local OUI Vendor");
  assert.equal(result.devices[0].model, "Known Model");
  assert.equal(result.devices[0].fieldSources.manufacturer, "OUI");
  assert.equal(result.devices[0].fieldSources.model, "Known Models");
});

test("enrichment locally infers only blank vendor and model fields from similar MACs", async () => {
  const result = await enrich({
    mainRows: [
      ["AA:BB:CC:DD:00:01", "Acme", "Switch X"],
      ["AA-BB-CC-DD-00-02", "", ""],
    ],
    mappings: { main: { mac: 0, manufacturer: 1, model: 2 }, smartroom: {}, ddio: {} },
    vendorDetectorSettings: { useInference: true, confidenceThreshold: 0.6 },
  });
  assert.equal(result.devices[1].manufacturer, "Acme");
  assert.equal(result.devices[1].model, "Switch X");
  assert.equal(result.devices[1].fieldSources.manufacturer, "Similar device inference");
  assert.equal(result.devices[1].vendorSource, "Similar device inference");
  assert.equal(result.devices[1].modelSource, "Similar device inference");
  assert.equal(result.diagnostics.counts.vendorFromSimilarDevices, 1);
  assert.equal(result.diagnostics.counts.modelFromSimilarDevices, 1);
});

test("Previous Final carries vendor/model confidence and original provenance into blank fields", async () => {
  const result = await enrich({
    mainRows: [["AA:BB:CC:DD:EE:37"]],
    mappings: { main: { mac: 0 }, smartroom: {}, ddio: {} },
    previousFinal: [{
      mac: "AA:BB:CC:DD:EE:37",
      manufacturer: "Acme",
      model: "Switch 37",
      vendor_confidence: 0.95,
      vendor_source: "IEEE OUI",
      model_confidence: 0.82,
      model_source: "MAC5 rule",
    }],
  });
  assert.equal(result.devices[0].manufacturer, "Acme");
  assert.equal(result.devices[0].model, "Switch 37");
  assert.equal(result.devices[0].vendorConfidence, 0.95);
  assert.equal(result.devices[0].vendorSource, "IEEE OUI");
  assert.equal(result.devices[0].modelConfidence, 0.82);
  assert.equal(result.devices[0].modelSource, "MAC5 rule");
  assert.equal(result.devices[0].fieldSources.manufacturer, "Previous Final");
  assert.equal(result.devices[0].fieldSources.model, "Previous Final");
});

test("vendor detector settings can disable OUI and MAC5 without disabling import", async () => {
  const result = await enrich({
    mainRows: [["AA:BB:CC:DD:EE:01"]],
    mappings: { main: { mac: 0 }, smartroom: {}, ddio: {} },
    ouiIndex: new Map([["AABBCC", "Acme"]]),
    mac5Models: new Map([["AABBCCDD", "Switch X"]]),
    vendorDetectorSettings: { useOui3: false, useMac5: false, useText: false, useInference: false },
  });
  assert.equal(result.devices[0].manufacturer, "");
  assert.equal(result.devices[0].model, "");
});

test("Main can establish strong identity from a mapped alternate MAC column", async () => {
  const result = await enrich({
    mainRows: [["AA:BB:CC:DD:EE:FF"]],
    mappings: { main: { mac2: 0 }, smartroom: {}, ddio: {} },
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].mac, "");
  assert.deepEqual(result.devices[0].alternateMacs, ["AA:BB:CC:DD:EE:FF"]);
});

test("Main mapping carries vendor, model, room, address, and switch port into Final", async () => {
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", "Acme", "Board X", "Meeting Room 1", "Example Street 1", "Gi1/0/8"]],
    mappings: {
      main: { mac: 0, manufacturer: 1, model: 2, room: 3, address: 4, switchPort: 5 },
      smartroom: {},
      ddio: {},
    },
  });
  assert.equal(result.devices.length, 1);
  assert.deepEqual({
    mac: result.devices[0].mac,
    manufacturer: result.devices[0].manufacturer,
    model: result.devices[0].model,
    room: result.devices[0].room,
    address: result.devices[0].address,
    switchPort: result.devices[0].switchPort,
  }, {
    mac: "00:11:22:33:44:55",
    manufacturer: "Acme",
    model: "Board X",
    room: "Meeting Room 1",
    address: "Example Street 1",
    switchPort: "Gi1/0/8",
  });
});

test("custom source mappings enrich user fields without overwriting Main values", () => {
  const customKey = customInventoryColumnKey("Кабинет ответственного");
  const main = mapRow(["00:11:22:33:44:55", "Главный отдел"], { mac: 0, [customKey]: 1 }, "Main");
  const smartroom = mapRow(["00:11:22:33:44:55", "Другое значение", "Кабинет 305"], {
    mac: 0,
    [customKey]: 1,
    [customInventoryColumnKey("Помещение ответственного")]: 2,
  }, "SmartRoom");
  mergeDevice(main, smartroom, "SmartRoom");
  assert.equal(main.customFields[customKey], "Главный отдел");
  assert.equal(main.customFieldSources[customKey], "Main");
  const roomKey = customInventoryColumnKey("Помещение ответственного");
  assert.equal(main.customFields[roomKey], "Кабинет 305");
  assert.equal(main.customFieldSources[roomKey], "SmartRoom");
});

test("enrichment reports conflicting strong-identity aliases from an imported row", async () => {
  const result = await enrich({
    mainRows: [
      ["persistent-a", "persistent-b", "00:11:22:33:44:55", "AA:BB:CC:DD:EE:FF"],
      ["clean-device", "", "00:11:22:33:44:66", ""],
    ],
    mappings: {
      main: { id: 0, internalDeviceId: 1, mac: 2, macFormatted: 3 },
      smartroom: {}, ddio: {},
    },
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].id, "clean-device", "a row with contradictory identity aliases is not admitted to Main");
  assert.equal(result.devices[0].mac, "00:11:22:33:44:66");
  assert.deepEqual(result.diagnostics.conflicts.map(({ source, row, field, identifier, selected, alternative }) => ({
    source, row, field, identifier, selected, alternative,
  })), [
    { source: "Main", row: 2, field: "identity", identifier: "id", selected: "persistent-a", alternative: "persistent-b" },
    { source: "Main", row: 2, field: "identity", identifier: "mac", selected: "00:11:22:33:44:55", alternative: "AA:BB:CC:DD:EE:FF" },
  ]);
  assert.ok(result.diagnostics.invalid.some(({ source, row, reason }) => source === "Main" && row === 2 && reason.includes("Конфликтующие алиасы")));
});

test("SmartRoom rows with conflicting strong-identity aliases cannot merge or expand", async () => {
  const result = await enrich({
    mainRows: [["main-device", "00:11:22:33:44:55", "Main model"]],
    smartroomRows: [["smart-a", "smart-b", "AA:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:01", "Injected model"]],
    mappings: {
      main: { id: 0, mac: 1, model: 2 },
      smartroom: { id: 0, internalDeviceId: 1, mac: 2, macFormatted: 3, model: 4 },
      ddio: {},
    },
    strategy: STRATEGIES.ALLOW_EXPANSION,
  });

  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].model, "Main model");
  assert.equal(result.devices.some((device) => device.id === "smart-a" || device.model === "Injected model"), false);
  assert.ok(result.diagnostics.conflicts.some(({ source, row, field }) => source === "SmartRoom" && row === 2 && field === "identity"));
  assert.ok(result.diagnostics.invalid.some(({ source, row }) => source === "SmartRoom" && row === 2));
});

test("device merge retains each distinct strong-identity alias conflict", () => {
  const target = mapRow([], {}, "Main");
  const incoming = mapRow([], {}, "SmartRoom");
  incoming.conflicts = [
    { field: "identity", identifier: "id", selected: "id-a", alternative: "id-b", source: "SmartRoom" },
    { field: "identity", identifier: "mac", selected: "00:11:22:33:44:55", alternative: "AA:BB:CC:DD:EE:FF", source: "SmartRoom" },
  ];
  mergeDevice(target, incoming, "SmartRoom");
  assert.deepEqual(target.conflicts.filter((item) => item.field === "identity"), incoming.conflicts);
});

test("device merge carries packed alternate MACs forward as normalized aliases", () => {
  const target = mapRow(["00:11:22:33:44:55"], { mac: 0 }, "Main");
  const incoming = mapRow(["AA:BB:CC:DD:EE:FF"], { mac: 0 }, "SmartRoom");
  target.alternateMacs = "00:11:22:33:44:66";
  incoming.alternateMacs = "AA:BB:CC:DD:EE:01,00:11:22:33:44:55";
  mergeDevice(target, incoming, "SmartRoom");
  assert.deepEqual(target.alternateMacs, ["00:11:22:33:44:66", "AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:FF"]);
  assert.equal(target.alternateMacsTruncated, false);
});

test("NO_EXPANSION keeps Main count and DDIO fills blank IP by MAC", async () => {
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.1"]],
    smartroomRows: [
      ["00:11:22:33:44:55", "", "Room A", "Model A"],
      ["AA:BB:CC:DD:EE:FF", "10.9.9.9", "Room B", "Model B"],
    ],
    ddioRows: [["192.168.10.20", "00-11-22-33-44-55", "", ""]],
    mappings,
    strategy: STRATEGIES.NO_EXPANSION,
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].ip, "192.168.10.20");
  assert.equal(result.devices[0].fieldSources.ip, "DDIO");
  assert.equal(result.devices[0].switchIp, "10.0.0.1");
  assert.equal(result.diagnostics.unmatched.length, 1);
  assert.equal(result.diagnostics.unmatched[0].reason, "NO_EXPANSION");
  assert.equal(result.diagnostics.counts.finalUnique, 1);
  assert.equal(result.diagnostics.decisions.some((item) => item.action === "NOT_CREATED_FROM_SMARTROOM"), true);
});

test("large enrichment keeps bounded diagnostic samples and exact dropped counts", async () => {
  const smartroomRows = Array.from({ length: 1_005 }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(6, "0").match(/.{2}/g).join(":");
    return [`AA:BB:CC:${suffix}`];
  });
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55"]],
    smartroomRows,
    mappings: { main: { mac: 0 }, smartroom: { mac: 0 } },
    strategy: STRATEGIES.NO_EXPANSION,
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.diagnostics.unmatched.length, 1_000);
  assert.equal(result.diagnostics.counts.unmatchedTotal, 1_005);
  assert.equal(result.diagnostics.counts.unmatchedTruncated, 5);
  assert.equal(result.diagnostics.decisions.length, 1_000);
  assert.equal(result.diagnostics.counts.decisionsTotal, 1_006);
  assert.equal(result.diagnostics.counts.decisionsTruncated, 6);
});

test("enrichment consumes asynchronous row batches with the same identities and diagnostics as arrays", async () => {
  const input = {
    mainRows: [["", ""], ["00:11:22:33:44:61", ""], ["00:11:22:33:44:61", ""], ["00:11:22:33:44:62", ""]],
    smartroomRows: [["00:11:22:33:44:61", "Room A"], ["not-an-id", "Room B"]],
    ddioRows: [["192.168.1.61", "00-11-22-33-44-61", "", ""]],
    mappings: {
      main: { mac: 0 },
      smartroom: { mac: 0, room: 1 },
      ddio: { reservationIp: 0, reservationMac: 1, leaseIp: 2, leaseMac: 3 },
    },
  };
  const arrayResult = await enrich(input);
  const streamedResult = await enrich({
    ...input,
    mainRows: rowBatches(input.mainRows),
    smartroomRows: rowBatches(input.smartroomRows),
    ddioRows: rowBatches(input.ddioRows),
  });

  const withoutObservedAt = (devices) => devices.map((device) => {
    const copy = { ...device };
    delete copy.observedAt;
    return copy;
  });
  assert.deepEqual(withoutObservedAt(streamedResult.devices), withoutObservedAt(arrayResult.devices));
  assert.deepEqual(streamedResult.diagnostics, arrayResult.diagnostics);
  assert.equal(streamedResult.diagnostics.counts.mainRaw, 4);
  assert.equal(streamedResult.diagnostics.counts.smartroomRaw, 2);
  assert.equal(streamedResult.diagnostics.counts.ddioRaw, 1);
  assert.deepEqual(streamedResult.devices.map((device) => device.ip), ["192.168.1.61", ""]);
});

test("Main and SmartRoom reuse parsed row arrays without iterating or copying them", async () => {
  const withoutIterator = (values) => new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) throw new Error("parsed row array should not be copied");
      return Reflect.get(target, property, receiver);
    },
  });
  const result = await enrich({
    mainRows: [withoutIterator(["00:11:22:33:44:55"])],
    smartroomRows: [withoutIterator(["00:11:22:33:44:55", "101"])],
    mappings: { main: { mac: 0 }, smartroom: { mac: 0, room: 1 }, ddio: {} },
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].room, "101");
});

test("final duplicate-ID validation rejects colliding internal IDs", async () => {
  await assert.rejects(enrich({
    mainDevices: [
      { id: "duplicate-final-id", mac: "00:11:22:33:44:71", fieldSources: {} },
      { id: "duplicate-final-id", mac: "00:11:22:33:44:72", fieldSources: {} },
    ],
  }), /дубли внутренних ID/);
});

test("final ID validation tolerates compact-hash collisions between distinct IDs", async () => {
  const result = await enrich({
    mainDevices: [
      { id: "r0md0qcxul-12165", mac: "00:11:22:33:44:73", fieldSources: {} },
      { id: "s0hqgtfbl3r-37612", mac: "00:11:22:33:44:74", fieldSources: {} },
    ],
  });
  assert.equal(result.devices.length, 2);
  assert.equal(result.diagnostics.counts.finalUnique, 2);
});

test("Final accepts distinct MAC identities that collided in the former 32-bit generated IDs", async () => {
  const result = await enrich({
    mainRows: [["00:00:00:00:4F:D9"], ["00:00:00:06:61:22"]],
    mappings: { main: { mac: 0 }, smartroom: {}, ddio: {} },
  });
  assert.equal(result.devices.length, 2);
  assert.equal(new Set(result.devices.map(({ id }) => id)).size, 2);
  assert.equal(result.diagnostics.counts.finalUnique, 2);
});

test("streamed DDIO indexes retain only current strong MAC and Device ID evidence", async () => {
  const result = await buildDdIoIndexFromRows(rowBatches([
    ["00:11:22:33:44:81", "10.0.0.81", "", "", ""],
    ["", "", "AA:BB:CC:DD:EE:82", "10.0.0.82", ""],
    ["10:20:30:40:50:60", "10.0.0.60", "", "", "unrelated-device"],
    ["", "10.0.0.81", "", "", "device-81"],
    ["", "", "", "10.0.0.90", "unrelated-device"],
  ], 2), {
    reservationMac: 0, reservationIp: 1, leaseMac: 2, leaseIp: 3, deviceId: 4,
  }, [{ mac: "00:11:22:33:44:81", alternateMacs: ["AA:BB:CC:DD:EE:82"], deviceId: "Device-81" }]);

  assert.deepEqual([...result.index.keys()].sort(), ["00:11:22:33:44:81", "AA:BB:CC:DD:EE:82"]);
  assert.deepEqual([...result.index.byDeviceId.keys()], ["device-81"]);
  assert.deepEqual(result.index.get("00:11:22:33:44:81").ips, ["10.0.0.81"]);
  assert.deepEqual(result.index.get("AA:BB:CC:DD:EE:82").ips, ["10.0.0.82"]);
  assert.deepEqual(result.index.byDeviceId.get("device-81").ips, ["10.0.0.81"]);
  assert.equal(result.rowCount, 5, "raw DDIO count includes ignored rows");
});

test("DDIO matches normalized MAC formats from reservation and lease fields, never switch IP", async () => {
  const mainRows = [
    ["00:11:22:33:44:51", "172.16.0.51"],
    ["00:11:22:33:44:52", "172.16.0.52"],
    ["00:11:22:33:44:53", "172.16.0.53"],
    ["00:11:22:33:44:54", "172.16.0.54"],
  ];
  const ddioRows = [
    ["192.168.1.51", "00-11-22-33-44-51", "", "", "172.16.0.1"],
    ["", "", "192.168.1.52", "0011.2233.4452", "172.16.0.2"],
    ["", "", "192.168.1.53", "NAS-1/00:11:22:33:44:53", "172.16.0.3"],
    ["192.168.1.54", "001122334454", "", "", "172.16.0.4"],
  ];
  const result = await enrich({
    mainRows,
    ddioRows,
    mappings: {
      main: { mac: 0, switchIp: 1 },
      smartroom: {},
      ddio: { reservationIp: 0, reservationMac: 1, leaseIp: 2, leaseMac: 3, switchIp: 4 },
    },
  });

  assert.deepEqual(result.devices.map((device) => device.ip), [
    "192.168.1.51", "192.168.1.52", "192.168.1.53", "192.168.1.54",
  ]);
  assert.ok(result.devices.every((device) => device.fieldSources.ip === "DDIO"));
});

test("current and persisted Smartroom ID mappings fill blank room names without overwriting current rooms", async () => {
  const current = await enrich({
    mainRows: [
      ["00:11:22:33:44:51", "SR-1"],
      ["00:11:22:33:44:52", "SR-1"],
    ],
    smartroomRows: [["00:11:22:33:44:51", "Current Room", "SR-1"]],
    mappings: {
      main: { mac: 0, smartroomId: 1 },
      smartroom: { mac: 0, room: 1, smartroomId: 2 },
      ddio: {},
    },
  });
  assert.equal(current.devices[1].room, "Current Room");
  assert.equal(current.devices[1].fieldSources.room, "Current Smartroom ID mapping");
  assert.equal(current.diagnostics.counts.currentSmartroomRoomFilled, 1);

  const historical = await enrich({
    mainRows: [["00:11:22:33:44:53", "SR-2", ""]],
    mappings: { main: { mac: 0, smartroomId: 1, room: 2 }, smartroom: {}, ddio: {} },
    historicalRoomIndex: buildSmartroomRoomIndex([{
      smartroomId: "SR-2", room: "Historical Room", status: "confirmed", sourceFinalId: "final-1",
      snapshotName: "Final 1", createdAt: "2026-10-13T00:00:00Z", deviceCount: 2,
    }]),
  });
  assert.equal(historical.devices[0].room, "Historical Room");
  assert.equal(historical.devices[0].fieldSources.room, "Historical Smartroom ID mapping");
  assert.equal(historical.diagnostics.counts.historicalSmartroomRoomFilled, 1);
});

test("Smartroom room target collection is bounded and falls back without dropping IDs", async () => {
  const devices = [
    { smartroomId: " SR-A ", room: "" },
    { smartroomId: "sr-a", room: "" },
    { smartroomId: "SR-IGNORED", room: "Already assigned" },
    { smartroomId: "SR-B", room: "" },
  ];
  const selective = await collectCurrentSmartroomRoomTargets(devices, { maxTargets: 2 });
  assert.deepEqual(selective, new Set(["sr-a", "sr-b"]));
  assert.equal(await collectCurrentSmartroomRoomTargets(devices, { maxTargets: 1 }), null,
    "overflow signals an exact full-index fallback instead of truncating the target IDs");
});

test("historical Smartroom lookup loads only unique IDs for devices still missing a room", async () => {
  const requested = [];
  const result = await enrich({
    mainRows: [
      ["00:11:22:33:44:61", " SR-HIST ", ""],
      ["00:11:22:33:44:62", "SR-HIST", ""],
      ["00:11:22:33:44:63", "SR-CURRENT", "Already assigned"],
    ],
    mappings: { main: { mac: 0, smartroomId: 1, room: 2 }, smartroom: {}, ddio: {} },
    loadHistoricalRoomIndex: async (ids) => {
      requested.push(ids);
      return buildSmartroomRoomIndex([{
        smartroomId: "SR-HIST", room: "Historical Room", status: "confirmed", sourceFinalId: "final-1",
        snapshotName: "Final 1", createdAt: "2026-10-13T00:00:00Z", deviceCount: 2,
      }]);
    },
  });
  assert.deepEqual(requested, [["SR-HIST"]]);
  assert.equal(result.devices[0].room, "Historical Room");
  assert.equal(result.devices[1].room, "Historical Room");
  assert.equal(result.devices[2].room, "Already assigned");
  assert.equal(result.historicalRoomIndex.size, 1);
});

test("batch enrichment releases applied historical room evidence before later stages", async () => {
  const historical = buildSmartroomRoomIndex([{
    smartroomId: "SR-HIST-RELEASE", room: "Historical Room", status: "confirmed", sourceFinalId: "final-1",
    snapshotName: "Final 1", createdAt: "2026-10-13T00:00:00Z", deviceCount: 1,
  }]);
  const imported = buildImportedSmartroomRoomIndex([
    { smartroomId: "SR-IMPORT-RELEASE", room: "Imported Room", source: "manual", updatedAt: "2026-10-15T12:00:00Z" },
  ]);
  const result = await enrich({
    mainRows: [
      ["00:11:22:33:44:81", "SR-HIST-RELEASE", ""],
      ["00:11:22:33:44:82", "SR-IMPORT-RELEASE", ""],
    ],
    mappings: { main: { mac: 0, smartroomId: 1, room: 2 }, smartroom: {}, ddio: {} },
    loadHistoricalRoomIndex: async () => historical,
    loadImportedSmartroomRoomIndex: async () => imported,
    retainSmartroomRoomEvidence: false,
  });
  assert.deepEqual(result.devices.map((device) => device.room), ["Historical Room", "Imported Room"]);
  assert.equal(result.diagnostics.counts.historicalSmartroomRoomFilled, 1);
  assert.equal(result.diagnostics.counts.importedSmartroomRoomFilled, 1);
  assert.equal(historical.size, 1, "the lookup page remains owned by its loader, not mutated by batch enrichment");
  assert.equal(imported.size, 1, "the lookup page remains owned by its loader, not mutated by batch enrichment");
  assert.equal(result.historicalRoomIndex, null);
  assert.equal(result.importedSmartroomRoomIndex, null);
});

test("explicit imported Smartroom mappings fill only exact missing rooms without becoming identity evidence", async () => {
  const requested = [];
  const result = await enrich({
    mainRows: [
      ["00:11:22:33:44:71", "SR-EXACT", ""],
      ["00:11:22:33:44:72", "SR-CURRENT", "Current Room"],
      ["00:11:22:33:44:73", "SR-NONE", ""],
      ["00:11:22:33:44:74", "SR-CONFLICT", ""],
    ],
    mappings: { main: { mac: 0, smartroomId: 1, room: 2 }, smartroom: {}, ddio: {} },
    loadImportedSmartroomRoomIndex: async (ids) => {
      requested.push(ids);
      return buildImportedSmartroomRoomIndex([
        { smartroomId: "SR-EXACT", room: "Mapped Room", source: "manual", updatedAt: "2026-10-15T12:00:00Z" },
        { smartroomId: "SR-CONFLICT", room: "Room A" },
        { smartroomId: "SR-CONFLICT", room: "Room B" },
      ]);
    },
  });
  assert.deepEqual(requested, [["SR-EXACT", "SR-NONE", "SR-CONFLICT"]]);
  assert.equal(result.devices[0].room, "Mapped Room");
  assert.equal(result.devices[0].fieldSources.room, "Imported SQLite Smartroom room mapping");
  assert.equal(result.devices[0].roomEvidence.mappingType, "explicit-imported-mapping");
  assert.equal(result.devices[1].room, "Current Room");
  assert.equal(result.devices[2].room, "");
  assert.equal(result.devices[3].room, "", "conflicting imported rooms remain unresolved");
  assert.deepEqual(result.importedSmartroomRoomIndex.get("sr-conflict"), {
    smartroomId: "SR-CONFLICT",
    room: "",
    status: "review",
    alternatives: [{ room: "Room A" }, { room: "Room B" }],
    source: "",
    updatedAt: "",
  });
  assert.equal(result.diagnostics.counts.importedSmartroomRoomFilled, 1);
  assert.equal(result.devices[0].smartroomId, "SR-EXACT", "Smartroom ID only selects a room mapping and does not define device identity");
});

test("MAC5 rule lookup loads only prefixes for devices still missing a model", async () => {
  const requested = [];
  const result = await enrich({
    mainRows: [["00:11:22:33:44:71", "Known Model"], ["AA:BB:CC:DD:EE:72", ""]],
    mappings: { main: { mac: 0, model: 1 }, smartroom: {}, ddio: {} },
    loadMac5Models: async (macs) => {
      requested.push(macs);
      return new Map([["AABBCCDD", "Matched custom model"]]);
    },
  });
  assert.deepEqual(requested, [["AA:BB:CC:DD:EE:72"]]);
  assert.equal(result.devices[0].model, "Known Model");
  assert.equal(result.devices[1].model, "Matched custom model");
});

test("12,249-device enrichment uses bounded lookup batches and fixed-stage progress", async () => {
  const requests = { oui: [], known: [], mac5: [], history: [] };
  const progress = [];
  const macs = Array.from({ length: 12_249 }, (_, index) => {
    const hex = (BigInt(index) + 1n).toString(16).padStart(12, "0").toUpperCase();
    return hex.match(/.{2}/g).join(":");
  });
  const emptyLookup = (requestsForSource) => async (requestedMacs) => {
    requestsForSource.push(requestedMacs.length);
    return new Map();
  };
  const result = await enrich({
    mainRows: macs.map((mac) => [mac]),
    mappings: { main: { mac: 0 }, smartroom: {}, ddio: {} },
    loadOuiIndex: emptyLookup(requests.oui),
    loadKnownModels: emptyLookup(requests.known),
    loadMac5Models: emptyLookup(requests.mac5),
    loadLegacyVendorModelSuggestions: emptyLookup(requests.history),
    onProgress: (value, stage) => progress.push([value, stage]),
  });

  const expectedBatches = [...Array(24).fill(500), 249];
  for (const batches of Object.values(requests)) {
    assert.deepEqual(batches, expectedBatches);
    assert.ok(Math.max(...batches) <= 500);
  }
  assert.equal(result.devices.length, 12_249);
  assert.equal(result.diagnostics.counts.finalUnique, 12_249);
  assert.deepEqual(progress.map(([value]) => value), [5, 20, 40, 58, 70, 82, 92, 100]);
});

test("enrichment skips local knowledge lookups for batches with no missing fields", async () => {
  const macs = Array.from({ length: 1001 }, (_, index) => {
    const hex = (BigInt(index) + 1n).toString(16).padStart(12, "0").toUpperCase();
    return hex.match(/.{2}/g).join(":");
  });
  const shouldNotLoad = (source) => async () => { throw new Error(`${source} should not load for a complete batch`); };
  const result = await enrich({
    mainRows: macs.map((mac, index) => [mac, `Vendor ${index % 5}`, `Model ${index % 7}`]),
    mappings: { main: { mac: 0, manufacturer: 1, model: 2 }, smartroom: {}, ddio: {} },
    loadOuiIndex: shouldNotLoad("OUI"),
    loadKnownModels: shouldNotLoad("known models"),
    loadMac5Models: shouldNotLoad("MAC5"),
    loadLegacyVendorModelSuggestions: shouldNotLoad("vendor/model history"),
  });

  assert.equal(result.devices.length, 1001);
  assert.equal(result.devices[1000].manufacturer, "Vendor 0");
  assert.equal(result.devices[1000].model, "Model 6");
});

test("ALLOW_EXPANSION lets SmartRoom create, but DDIO never creates", async () => {
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.1"]],
    smartroomRows: [["AA:BB:CC:DD:EE:FF", "10.9.9.9", "Room B", "Model B"]],
    ddioRows: [
      ["192.168.10.20", "00:11:22:33:44:55", "", ""],
      ["192.168.10.99", "12:34:56:78:90:AB", "", ""],
    ],
    mappings,
    strategy: STRATEGIES.ALLOW_EXPANSION,
  });
  assert.equal(result.devices.length, 2);
  assert.equal(result.devices.some((item) => item.mac === "12:34:56:78:90:AB"), false);
});

test("SmartRoom expansion uses a new strong MAC when its Smartroom ID is shared weak evidence", async () => {
  const input = {
    mainRows: [["00:11:22:33:44:55", "SR-1", "Room 1"]],
    smartroomRows: [["AA:BB:CC:DD:EE:FF", "SR-1", "Room 1", "Model B"]],
    mappings: {
      main: { mac: 0, smartroomId: 1, room: 2 },
      smartroom: { mac: 0, smartroomId: 1, room: 2, model: 3 },
    },
  };
  const result = await enrich({ ...input, strategy: STRATEGIES.ALLOW_EXPANSION });
  assert.equal(result.devices.length, 2);
  assert.equal(result.devices.some((device) => device.mac === "AA:BB:CC:DD:EE:FF" && device.model === "Model B"), true);
  assert.equal(result.diagnostics.conflicts.some((conflict) => conflict.reason === "Неоднозначная идентификация"), false);
});

test("SmartRoom secondary MAC matches the Main device while the Main MAC stays canonical", async () => {
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55"]],
    smartroomRows: [["AA:BB:CC:DD:EE:FF", "00-11-22-33-44-55", "Room A", "Kit A"]],
    mappings: {
      main: { mac: 0 },
      smartroom: { mac: 0, mac2: 1, room: 2, model: 3 },
    },
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].mac, "00:11:22:33:44:55");
  assert.deepEqual(result.devices[0].alternateMacs, ["AA:BB:CC:DD:EE:FF"]);
  assert.equal(result.devices[0].room, "Room A");
  assert.equal(result.devices[0].conflicts.some((item) => item.field === "mac"), false);
});

test("a SmartRoom row identified only by its secondary MAC expands only when allowed", async () => {
  const input = {
    mainRows: [["00:11:22:33:44:55"]],
    smartroomRows: [["", "AA:BB:CC:DD:EE:FF", "Room B", "Kit B"]],
    mappings: {
      main: { mac: 0 },
      smartroom: { mac: 0, mac2: 1, room: 2, model: 3 },
    },
  };
  const blocked = await enrich({ ...input, strategy: STRATEGIES.NO_EXPANSION });
  assert.equal(blocked.devices.length, 1);
  assert.equal(blocked.diagnostics.unmatched.length, 1);

  const expanded = await enrich({ ...input, strategy: STRATEGIES.ALLOW_EXPANSION });
  assert.equal(expanded.devices.length, 2);
  const added = expanded.devices.find((device) => device.alternateMacs.includes("AA:BB:CC:DD:EE:FF"));
  assert.ok(added);
  assert.equal(added.mac, "");
  assert.equal(added.room, "Room B");
});

test("multiple DDIO IP values stay alternatives and are not chosen randomly", async () => {
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.1"]],
    ddioRows: [
      ["192.168.10.20", "00:11:22:33:44:55", "", ""],
      ["192.168.10.21", "00:11:22:33:44:55", "", ""],
    ],
    mappings,
  });
  assert.equal(result.devices[0].ip, "");
  assert.deepEqual(result.devices[0].possibleIps, ["192.168.10.20", "192.168.10.21"]);
  assert.equal(result.devices[0].conflicts.some((item) => item.reason === "multiple-exact-mac-ips"), true);
});

test("DDIO fills placeholder IP through SmartRoom or Previous Final alternate MAC and preserves known IP", async () => {
  const result = await enrich({
    mainRows: [
      ["00:11:22:33:44:51", "N/A"],
      ["00:11:22:33:44:52", "10.0.0.52"],
      ["00:11:22:33:44:53", "—"],
    ],
    smartroomRows: [["AA:BB:CC:DD:EE:51", "00:11:22:33:44:51"]],
    ddioRows: [
      ["192.168.1.51", "AA-BB-CC-DD-EE-51", "", ""],
      ["192.168.1.52", "00:11:22:33:44:52", "", ""],
      ["", "", "192.168.1.53", "AA:BB:CC:DD:EE:53"],
      ["192.168.1.99", "12:34:56:78:90:AB", "", ""],
    ],
    mappings: {
      main: { mac: 0, ip: 1 },
      smartroom: { mac: 0, mac2: 1 },
      ddio: { reservationIp: 0, reservationMac: 1, leaseIp: 2, leaseMac: 3, switchIp: 4 },
    },
    previousFinal: [{ id: "device-c", mac: "00:11:22:33:44:53", alternateMacs: ["AA:BB:CC:DD:EE:53"] }],
  });
  assert.equal(result.devices.length, 3);
  assert.deepEqual(result.devices.map((device) => device.ip), ["192.168.1.51", "10.0.0.52", "192.168.1.53"]);
  assert.equal(result.devices[0].fieldSources.ip, "DDIO");
  assert.equal(result.devices[2].fieldSources.ip, "DDIO");
  assert.ok(result.devices[1].possibleIps.includes("192.168.1.52"));
  assert.equal(result.devices.some((device) => device.mac === "12:34:56:78:90:AB"), false);
  assert.equal(result.devices[2].id, "device-c");
});

test("DDIO custom field mapping overlays known devices by exact MAC without replacing their IP", async () => {
  const customKey = customInventoryColumnKey("Метка DDIO");
  const device = mapRow(["00:11:22:33:44:55", "10.0.0.9"], { mac: 0, ip: 1 }, "Main");
  const mapping = { reservationMac: 0, reservationIp: 1, [customKey]: 2 };
  const result = await buildDdIoIndexFromRows([
    ["00-11-22-33-44-55", "10.0.0.10", "резерв"],
    ["00:11:22:33:44:99", "10.0.0.11", "чужое устройство"],
  ], mapping, [device]);
  assert.equal(result.index.has("00:11:22:33:44:55"), true);
  assert.equal(result.index.has("00:11:22:33:44:99"), false);
  applyDdIoIp(device, result.index);
  assert.equal(device.ip, "10.0.0.9");
  assert.equal(device.customFields[customKey], "резерв");
  assert.equal(device.customFieldSources[customKey], "DDIO");

  const conflicted = mapRow(["00:11:22:33:44:55", "10.0.0.9"], { mac: 0, ip: 1 }, "Main");
  const conflictIndex = await buildDdIoIndexFromRows([
    ["00:11:22:33:44:55", "", "первое"],
    ["00:11:22:33:44:55", "", "второе"],
  ], mapping, [conflicted]);
  applyDdIoIp(conflicted, conflictIndex.index);
  assert.equal(conflicted.customFields[customKey], undefined);
  assert.deepEqual(conflicted.conflicts.find(({ field }) => field === "customField")?.values, ["первое", "второе"]);
});

test("DDIO target and overlay matching accept packed alternate MAC values", async () => {
  const device = mapRow(["00:11:22:33:44:55"], { mac: 0 }, "Main");
  device.id = "packed-device";
  device.alternateMacs = "AA:BB:CC:DD:EE:01,AA:BB:CC:DD:EE:02";
  const result = await buildDdIoIndexFromRows([
    ["AA:BB:CC:DD:EE:01", "10.0.0.1"],
    ["AA:BB:CC:DD:EE:02", "10.0.0.2"],
    ["AA:BB:CC:DD:EE:03", "10.0.0.3"],
  ], { reservationMac: 0, reservationIp: 1 }, [device]);
  assert.deepEqual([...result.index.keys()], ["AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02"]);
  assert.equal(applyDdIoIp(device, result.index), false, "multiple exact alternate-MAC addresses remain advisory");
  assert.deepEqual(device.possibleIps, ["10.0.0.1", "10.0.0.2"]);
  assert.equal(device.ip, "", "multiple candidate IPs must not become the assigned device IP");
});

test("DDIO and device conflicts retain bounded alternatives with an overflow marker", () => {
  const mac = "00:11:22:33:44:55";
  const rows = Array.from({ length: 150 }, (_, index) => [`10.0.${Math.floor(index / 250)}.${index + 1}`, mac, "", ""]);
  const index = buildDdIoIndex(rows, mappings.ddio);
  assert.equal(index.get(mac).ips.length, 100);
  assert.equal(index.get(mac).ipOverflow, true);
  const device = mapRow([mac, "N/A"], { mac: 0, ip: 1 }, "Main");
  assert.equal(applyDdIoIp(device, index), false);
  assert.equal(device.ip, "");
  assert.equal(device.possibleIps.length, 100);
  assert.equal(device.possibleIpsTruncated, true);
  assert.equal(device.conflicts[0].values.length, 100);
  assert.equal(device.conflicts[0].valuesTruncated, true);

  const target = mapRow([mac], { mac: 0 }, "Main");
  mergeDevice(target, { conflicts: Array.from({ length: 150 }, (_, n) => ({ field: "model", value: `Model ${n}`, source: "SmartRoom" })) }, "SmartRoom");
  assert.equal(target.conflicts.length, 100);
  assert.equal(target.conflictsTruncated, true);
});

test("DDIO Device ID adds searchable possible IP evidence but never assigns device IP", async () => {
  const mainRows = [
    ["device-a", "00:11:22:33:44:61", ""],
    ["device-b", "00:11:22:33:44:62", ""],
  ];
  const ddioRows = [
    ["device-a", "10.0.0.61", "00:11:22:33:44:61"],
    ["device-b", "10.0.0.99", "00:11:22:33:44:99"],
  ];
  const input = {
    mappings: {
      main: { deviceId: 0, mac: 1, ip: 2 },
      smartroom: {},
      ddio: { deviceId: 0, reservationIp: 1, reservationMac: 2 },
    },
  };
  const result = await enrich({ ...input, mainRows, ddioRows });
  const streamed = await enrich({ ...input, mainRows: rowBatches(mainRows), ddioRows: rowBatches(ddioRows) });

  const byId = new Map(result.devices.map((device) => [device.deviceId, device]));
  assert.equal(byId.get("device-a").ip, "10.0.0.61");
  assert.equal(byId.get("device-a").fieldSources.ip, "DDIO");
  assert.equal(byId.get("device-b").ip, "");
  assert.equal(byId.get("device-b").fieldSources.ip, undefined);
  assert.deepEqual(byId.get("device-b").possibleIps, ["10.0.0.99"]);
  assert.equal(byId.get("device-b").fieldSources.possibleIps, "DDIO");
  assert.ok(byId.get("device-b").sources.includes("DDIO"));
  assert.deepEqual(byId.get("device-b").conflicts, []);
  const withoutObservationTime = (device) => Object.fromEntries(Object.entries(device).filter(([key]) => key !== "observedAt"));
  assert.deepEqual(streamed.devices.map(withoutObservationTime), result.devices.map(withoutObservationTime));
});

test("structured DDIO Device IDs cannot create possible-IP evidence for a literal object string ID", async () => {
  const result = await enrich({
    mainRows: [["[object Object]", "00:11:22:33:44:71", ""]],
    ddioRows: [[{ value: "anything" }, "10.0.0.71", ""]],
    mappings: {
      main: { deviceId: 0, mac: 1, ip: 2 },
      smartroom: {},
      ddio: { deviceId: 0, reservationIp: 1, reservationMac: 2 },
    },
  });
  assert.equal(result.devices[0].deviceId, "[object Object]");
  assert.deepEqual(result.devices[0].possibleIps, []);
  assert.equal(result.devices[0].fieldSources.possibleIps, undefined);
});

test("previous Final restores blanks but does not add absent devices", async () => {
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.1"]],
    mappings,
    previousFinal: [
      { id: "old-a", mac: "00:11:22:33:44:55", manufacturer: "Vendor", model: "Model" },
      { id: "old-b", mac: "AA:BB:CC:DD:EE:FF", manufacturer: "Other" },
    ],
  });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].manufacturer, "Vendor");
  assert.equal(result.devices[0].model, "Model");
});

test("Previous Final compact projection carries custom fields and their original source into blank Main fields", async () => {
  const field = "custom_12345678-1234-4234-8234-123456789abc";
  const previous = compactPreviousFinalDevice({
    id: "device-a",
    mac: "00:11:22:33:44:55",
    customFields: { [field]: "Критичная переговорная" },
    customFieldSources: { [field]: "legacy.sqlite:Main" },
    rawSpreadsheetRow: Array(1_000).fill("unused"),
  });
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", ""]],
    mappings: { main: { mac: 0, [field]: 1 } },
    previousFinal: [previous],
  });

  assert.equal(result.devices[0].customFields[field], "Критичная переговорная");
  assert.equal(result.devices[0].customFieldSources[field], "legacy.sqlite:Main");
  assert.equal(Object.hasOwn(previous, "rawSpreadsheetRow"), false);
});

test("chunked Previous Final restore carries custom values and provenance through enrichment", async () => {
  const field = "custom_22345678-1234-4234-8234-123456789abc";
  const database = new Database(`previous-custom-fields-${globalThis.crypto.randomUUID()}`);
  try {
    const previousSnapshot = await database.saveFinal({
      name: "Previous with custom field",
      devices: [{
        id: "device-b",
        mac: "00:11:22:33:44:66",
        customFields: { [field]: "Серверная переговорная" },
        customFieldSources: { [field]: "legacy.sqlite:Inventory" },
        rawSpreadsheetRow: ["discard after persistence"],
      }],
    });
    const previous = await loadCompactSnapshot(
      previousSnapshot.id,
      (id, visit) => database.forEachSnapshotChunk(id, visit),
      { mutateDetachedChunks: true },
    );
    const result = await enrich({
      mainRows: [["00:11:22:33:44:66", ""]],
      mappings: { main: { mac: 0, [field]: 1 } },
      previousFinal: previous.devices,
    });

    assert.equal(result.devices[0].customFields[field], "Серверная переговорная");
    assert.equal(result.devices[0].customFieldSources[field], "legacy.sqlite:Inventory");
    assert.equal(Object.hasOwn(previous.devices[0], "rawSpreadsheetRow"), false);
  } finally {
    (await database.open()).close();
  }
});

test("chunked Previous Final restore carries vendor/model confidence and provenance through enrichment", async () => {
  const database = new Database(`previous-knowledge-provenance-${globalThis.crypto.randomUUID()}`);
  try {
    const previousSnapshot = await database.saveFinal({
      name: "Previous vendor/model provenance",
      devices: [{
        id: "device-knowledge-provenance",
        mac: "00:11:22:33:44:67",
        manufacturer: "Legacy Vendor",
        vendorConfidence: 0.91,
        vendorSource: "legacy.sqlite:oui_vendor_history",
        model: "Legacy Model",
        modelConfidence: 0.84,
        modelSource: "legacy.sqlite:mac5_model_history",
        fieldSources: {
          manufacturer: "legacy.sqlite:oui_vendor_history",
          model: "legacy.sqlite:mac5_model_history",
        },
      }],
    });
    const previous = await loadCompactSnapshot(
      previousSnapshot.id,
      (id, visit) => database.forEachSnapshotChunk(id, visit),
      { mutateDetachedChunks: true },
    );
    const result = await enrich({
      mainRows: [["00:11:22:33:44:67", "", ""]],
      mappings: { main: { mac: 0, manufacturer: 1, model: 2 } },
      previousFinal: previous.devices,
    });

    assert.equal(result.devices[0].manufacturer, "Legacy Vendor");
    assert.equal(result.devices[0].vendorConfidence, 0.91);
    assert.equal(result.devices[0].vendorSource, "legacy.sqlite:oui_vendor_history");
    assert.equal(result.devices[0].fieldSources.manufacturer, "Previous Final");
    assert.equal(result.devices[0].model, "Legacy Model");
    assert.equal(result.devices[0].modelConfidence, 0.84);
    assert.equal(result.devices[0].modelSource, "legacy.sqlite:mac5_model_history");
    assert.equal(result.devices[0].fieldSources.model, "Previous Final");
  } finally {
    (await database.open()).close();
  }
});

test("model placeholders are treated as empty so Previous Final and MAC-prefix rules can restore a model", async () => {
  const previous = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.1"]],
    smartroomRows: [["00:11:22:33:44:55", "", "", "Не указано"]],
    mappings,
    previousFinal: [{ id: "old-a", mac: "00:11:22:33:44:55", model: "Conference Kit" }],
  });
  assert.equal(previous.devices[0].model, "Conference Kit");
  assert.equal(previous.devices[0].fieldSources.model, "Previous Final");

  const learned = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.1"]],
    mappings,
    mac5Models: new Map([["00112233", "Learned Conference"]]),
  });
  assert.equal(learned.devices[0].model, "Learned Conference");
  assert.equal(learned.devices[0].fieldSources.model, "MAC5 rule 00112233");
});

test("legacy placeholder vendor and model values do not block OUI or exact-MAC knowledge", async () => {
  const mac = "AA:BB:CC:DD:EE:FF";
  const result = await enrich({
    mainRows: [[mac, "not found", "Не определено"]],
    mappings: { main: { mac: 0, manufacturer: 1, model: 2 } },
    loadOuiIndex: async () => new Map([["AABBCC", "Known Vendor"]]),
    loadKnownModels: async () => new Map([[mac, "Known Model"]]),
  });
  assert.equal(result.devices[0].manufacturer, "Known Vendor");
  assert.equal(result.devices[0].model, "Known Model");
  assert.equal(result.devices[0].fieldSources.manufacturer, "OUI");
  assert.equal(result.devices[0].fieldSources.model, "Known Models");
});

test("learned model lookup is requested only for devices still missing a model", async () => {
  const requested = [];
  const result = await enrich({
    mainRows: [
      ["00:11:22:33:44:55", "Current model"],
      ["AA:BB:CC:DD:EE:FF", ""],
    ],
    mappings: { main: { mac: 0, model: 1 } },
    loadKnownModels: async (macs) => {
      requested.push(...macs);
      return new Map([["AA:BB:CC:DD:EE:FF", "Learned model"]]);
    },
  });
  assert.deepEqual(requested, ["AA:BB:CC:DD:EE:FF"]);
  assert.equal(result.devices[0].model, "Current model");
  assert.equal(result.devices[1].model, "Learned model");
  assert.equal(result.devices[1].fieldSources.model, "Known Models");
});

test("legacy exact vendor/model history fills only blank fields with explicit provenance", async () => {
  const mac = "AA:BB:CC:DD:EE:FF";
  const result = await enrich({
    mainRows: [[mac]],
    mappings: { main: { mac: 0 } },
    loadLegacyVendorModelSuggestions: async (macs) => {
      assert.deepEqual(macs, [mac]);
      return new Map([[mac, { vendor: "History Vendor", model: "History Model", source: "vendor_model_history_exact", confidence: 0.93 }]]);
    },
  });
  assert.equal(result.devices[0].manufacturer, "History Vendor");
  assert.equal(result.devices[0].model, "History Model");
  assert.equal(result.devices[0].fieldSources.manufacturer, "vendor_model_history_exact");
  assert.equal(result.devices[0].fieldSources.model, "vendor_model_history_exact");
  assert.equal(result.devices[0].vendorConfidence, 0.93);
  assert.equal(result.devices[0].modelConfidence, 0.93);
});

test("legacy prefix suggestions preserve per-field historical confidence independent of detector threshold", async () => {
  const mac = "AA:BB:CC:DD:EE:FF";
  const result = await enrich({
    mainRows: [[mac]],
    mappings: { main: { mac: 0 } },
    vendorDetectorSettings: { enabled: true, confidenceThreshold: 0.8 },
    loadLegacyVendorModelSuggestions: async () => new Map([[mac, {
      vendor: "Prefix Vendor", model: "OUI Model", confidence: 0.68,
      vendorConfidence: 0.82, modelConfidence: 0.68,
      vendorSource: "vendor_model_history_prefix", modelSource: "vendor_model_history_prefix",
    }]]),
  });
  assert.equal(result.devices[0].manufacturer, "Prefix Vendor");
  assert.equal(result.devices[0].fieldSources.manufacturer, "vendor_model_history_prefix");
  assert.equal(result.devices[0].vendorConfidence, 0.82);
  assert.equal(result.devices[0].model, "OUI Model");
  assert.equal(result.devices[0].modelConfidence, 0.68);
});

test("local MAC5 model rules keep priority over imported legacy model history", async () => {
  const mac = "AA:BB:CC:DD:EE:FF";
  const result = await enrich({
    mainRows: [[mac]],
    mappings: { main: { mac: 0 } },
    historyEnrichmentSettings: { enabled: true, priorityHistory: false, useOuiMatch: true, useMac5Match: true },
    loadMac5Models: async () => new Map([["AABBCCDDEE", "Local MAC5 Model"]]),
    loadLegacyVendorModelSuggestions: async () => new Map([[mac, {
      vendor: "History Vendor", model: "Older History Model", source: "vendor_model_history_exact", confidence: 0.93,
    }]]),
  });
  assert.equal(result.devices[0].manufacturer, "History Vendor");
  assert.equal(result.devices[0].fieldSources.manufacturer, "vendor_model_history_exact");
  assert.equal(result.devices[0].model, "Local MAC5 Model");
  assert.equal(result.devices[0].fieldSources.model, "MAC5 rule AABBCCDDEE");
});

test("non-priority history fills only fields left unresolved by local detection", async () => {
  const mac = "AA:BB:CC:DD:EE:FF";
  const result = await enrich({
    mainRows: [[mac, "Juniper SRX"]],
    mappings: { main: { mac: 0, model: 1 } },
    vendorDetectorSettings: { enabled: true, useText: true, useInference: false, confidenceThreshold: 0.5 },
    historyEnrichmentSettings: { enabled: true, priorityHistory: false, useOuiMatch: true, useMac5Match: true },
    loadLegacyVendorModelSuggestions: async () => new Map([[mac, {
      vendor: "History Vendor", model: "History Model", confidence: 0.96,
      vendorSource: "vendor_model_history_exact", modelSource: "vendor_model_history_exact",
    }]]),
  });
  assert.equal(result.devices[0].manufacturer, "Juniper");
  assert.equal(result.devices[0].fieldSources.manufacturer, "Text: Juniper SRX");
  assert.equal(result.devices[0].model, "Juniper SRX");
});

test("priority history keeps stronger OUI and local MAC5 knowledge without replacing source values", async () => {
  const mac = "AA:BB:CC:DD:EE:FF";
  const requests = [];
  const result = await enrich({
    mainRows: [[mac, "Source Vendor", ""], ["00:11:22:33:44:55", "", ""]],
    mappings: { main: { mac: 0, manufacturer: 1, model: 2 } },
    vendorDetectorSettings: { enabled: true, useOui3: true, useText: false, useInference: false },
    loadOuiIndex: async () => new Map([["001122", "IEEE Vendor"]]),
    loadMac5Models: async () => new Map([ ["AABBCCDDEE", "Local MAC5 Model"], ["0011223344", "Local MAC5 Model"] ]),
    loadLegacyVendorModelSuggestions: async (macs, settings) => {
      requests.push({ macs, settings });
      const suggestion = {
        vendor: "History Vendor", model: "History Model", confidence: 0.93,
        vendorSource: "vendor_model_history_exact", modelSource: "vendor_model_history_exact",
      };
      return new Map([[mac, suggestion], ["00:11:22:33:44:55", suggestion]]);
    },
  });
  assert.deepEqual(requests, [{
    macs: [mac, "00:11:22:33:44:55"],
    settings: { useMac5Match: true, useOuiMatch: true },
  }]);
  assert.deepEqual(result.devices.map(({ manufacturer, model }) => [manufacturer, model]), [
    ["Source Vendor", "Local MAC5 Model"],
    ["IEEE Vendor", "Local MAC5 Model"],
  ]);
});

test("priority history replaces weaker text inference by confidence", async () => {
  const mac = "AA:BB:CC:DD:EE:FF";
  const result = await enrich({
    mainRows: [[mac, "Juniper SRX"]],
    mappings: { main: { mac: 0, model: 1 } },
    vendorDetectorSettings: { enabled: true, useText: true, useInference: false, confidenceThreshold: 0.5 },
    historyEnrichmentSettings: { enabled: true, priorityHistory: true, useOuiMatch: true, useMac5Match: true },
    loadLegacyVendorModelSuggestions: async () => new Map([[mac, {
      vendor: "Historical Juniper", model: "", vendorConfidence: 0.9,
      vendorSource: "vendor_model_history_exact",
    }]]),
  });
  assert.equal(result.devices[0].manufacturer, "Historical Juniper");
  assert.equal(result.devices[0].vendorConfidence, 0.9);
  assert.equal(result.devices[0].fieldSources.manufacturer, "vendor_model_history_exact");
  assert.equal(result.devices[0].model, "Juniper SRX");
});

test("Web history precedence runs before OUI and MAC5 rules while preserving explicit Main values", async () => {
  const historyMac = "AA:BB:CC:DD:EE:FF";
  const explicitMac = "00:11:22:33:44:55";
  const result = await enrich({
    mainRows: [[historyMac, "", ""], [explicitMac, "Main Vendor", "Main Model"]],
    mappings: { main: { mac: 0, manufacturer: 1, model: 2 } },
    historyEnrichmentSettings: {
      enabled: true, priorityHistory: true, precedenceProfile: "web", useOuiMatch: true, useMac5Match: true,
    },
    loadOuiIndex: async () => new Map([["AABBCC", "IEEE Vendor"]]),
    loadMac5Models: async () => new Map([["AABBCCDDEE", "Local MAC5 Model"]]),
    loadLegacyVendorModelSuggestions: async () => new Map([[historyMac, {
      vendor: "Historical Vendor", model: "Historical Model", vendorConfidence: 0.7, modelConfidence: 0.7,
      vendorSource: "vendor_model_history_exact", modelSource: "vendor_model_history_exact",
    }]]),
  });
  assert.deepEqual(result.devices.map(({ manufacturer, model }) => [manufacturer, model]), [
    ["Historical Vendor", "Historical Model"],
    ["Main Vendor", "Main Model"],
  ]);
  assert.deepEqual(result.devices[0].fieldSources, {
    manufacturer: "vendor_model_history_exact", model: "vendor_model_history_exact",
  });
});

test("disabled historical enrichment does not read history suggestions", async () => {
  let requested = false;
  const result = await enrich({
    mainRows: [["AA:BB:CC:DD:EE:FF"]],
    mappings: { main: { mac: 0 } },
    historyEnrichmentSettings: { enabled: false, priorityHistory: true, useOuiMatch: true, useMac5Match: true },
    loadLegacyVendorModelSuggestions: async () => {
      requested = true;
      return new Map();
    },
  });
  assert.equal(requested, false);
  assert.equal(result.devices[0].manufacturer, "");
});

test("historical confidence follows its own evidence and does not use the detector threshold", async () => {
  let requested = false;
  const result = await enrich({
    mainRows: [["AA:BB:CC:DD:EE:FF"]],
    mappings: { main: { mac: 0 } },
    vendorDetectorSettings: { enabled: true, confidenceThreshold: 0.98 },
    loadLegacyVendorModelSuggestions: async () => {
      requested = true;
      return new Map([["AA:BB:CC:DD:EE:FF", { vendor: "History Vendor", model: "History Model", confidence: 0.93 }]]);
    },
  });
  assert.equal(requested, true);
  assert.equal(result.devices[0].manufacturer, "History Vendor");
  assert.equal(result.devices[0].model, "History Model");
});

test("custom OUI lookup is requested only for missing manufacturers", async () => {
  const requested = [];
  const result = await enrich({
    mainRows: [
      ["00:11:22:33:44:55", "Main vendor"],
      ["AA:BB:CC:DD:EE:FF", ""],
    ],
    mappings: { main: { mac: 0, manufacturer: 1 } },
    loadOuiIndex: async (macs) => {
      requested.push(...macs);
      return new Map([["AABBCCDDE", "Custom OUI vendor"]]);
    },
  });
  assert.deepEqual(requested, ["AA:BB:CC:DD:EE:FF"]);
  assert.equal(result.devices[0].manufacturer, "Main vendor");
  assert.equal(result.devices[1].manufacturer, "Custom OUI vendor");
  assert.equal(result.devices[1].fieldSources.manufacturer, "OUI");
});

test("built-in MAC-prefix model lookup enriches a missing model with field provenance", async () => {
  const result = await enrich({ mainRows: [["00:11:22:33:44:55", "10.0.0.1"]], mappings });
  assert.equal(result.devices[0].model, "Cisco Catalyst 2960");
  assert.equal(result.devices[0].fieldSources.model, "MAC5 rule 00112233");
});

test("repeated enrichment is stable", async () => {
  const input = { mainRows: [["00:11:22:33:44:55", "10.0.0.1"]], mappings };
  const first = await enrich(input);
  const second = await enrich({ ...input, previousFinal: first.devices });
  assert.equal(second.devices.length, first.devices.length);
  assert.equal(second.devices[0].id, first.devices[0].id);
});

test("persistent internal ID wins across a MAC change without synthetic add or absence", async () => {
  const previous = [{ id: "persistent-device-17", mac: "00:11:22:33:44:55", model: "Conference Kit" }];
  const enriched = await enrich({
    mainRows: [["AA:BB:CC:DD:EE:FF", "10.0.0.7", "persistent-device-17"]],
    mappings: { main: { mac: 0, ip: 1, id: 2 } },
    previousFinal: previous,
  });
  assert.equal(enriched.devices[0].id, "persistent-device-17");
  const { compareFinals } = await import("../src/core/comparison.js");
  const comparison = compareFinals(previous, enriched.devices, "2026-01-02T00:00:00Z");
  assert.equal(comparison.added.length, 0);
  assert.equal(comparison.absent.length, 0);
  assert.equal(comparison.modified.length, 1);
  assert.ok(comparison.modified[0].changes.some((change) => change.field === "mac"));
});

test("a conflicting weaker Main alias is diagnosed after deterministic internal-ID matching", async () => {
  const enriched = await enrich({
    mainRows: [
      ["00:11:22:33:44:55", "device-a"],
      ["AA:BB:CC:DD:EE:FF", "device-b"],
      ["AA:BB:CC:DD:EE:FF", "device-a"],
    ],
    mappings: { main: { mac: 0, id: 1 } },
  });
  assert.equal(enriched.devices.length, 2);
  assert.equal(enriched.devices[0].id, "device-a");
  assert.ok(enriched.devices[0].alternateMacs.includes("AA:BB:CC:DD:EE:FF"));
  assert.ok(enriched.diagnostics.conflicts.some((item) => item.field === "identity" && item.source === "Main" && item.row === 4));
});

test("successful historical switch-IP consensus fills a blank room address with confidence evidence", async () => {
  const historicalAddressIndex = buildHistoricalAddressIndex(["previous-1", "previous-2"].map((snapshotId) => ({
    snapshotId,
    snapshotName: `Final ${snapshotId}`,
    switchIp: "10.0.0.254",
    address: "Москва, офис 1",
    deviceCount: 3,
    sampleMacs: ["00:11:22:33:44:55"],
  })));
  const result = await enrich({
    mainRows: [["00:11:22:33:44:55", "10.0.0.254"]],
    mappings: { main: { mac: 0, switchIp: 1 } },
    strategy: STRATEGIES.NO_EXPANSION,
    historicalAddressIndex,
  });
  assert.equal(result.devices[0].address, "Москва, офис 1");
  assert.equal(result.devices[0].fieldSources.address, "Historical switch IP mapping");
  assert.equal(result.devices[0].addressEvidence.length, 2);
  assert.equal(result.diagnostics.counts.historicalAddressFilled, 1);
});

test("manual IP mappings enrich Main with exact or unambiguous /24 matches before historical evidence", async () => {
  const requestedHistoryIps = [];
  const result = await enrich({
    mainRows: [
      ["00:11:22:33:44:51", "10.0.0.1", ""],
      ["00:11:22:33:44:52", "10.0.0.99", ""],
      ["00:11:22:33:44:53", "10.0.1.99", ""],
      ["00:11:22:33:44:54", "10.0.0.2", "Source Room"],
    ],
    mappings: { main: { mac: 0, switchIp: 1, address: 2 } },
    ipAddressMappings: [
      { switchIp: "10.0.0.1", address: "Room A", source: "Manual" },
      { switchIp: "10.0.0.2", address: "Room A", source: "Imported" },
      { switchIp: "10.0.1.1", address: "Room C", source: "Manual" },
      { switchIp: "10.0.1.2", address: "Room D", source: "Manual" },
    ],
    ipEnrichmentSettings: { enabled: true, partialMatch: true, overwrite: false },
    loadHistoricalAddressIndex: async (ips) => {
      requestedHistoryIps.push(ips);
      return new Map();
    },
  });
  assert.deepEqual(result.devices.map(({ address }) => address), ["Room A", "Room A", "", "Source Room"]);
  assert.equal(result.devices[0].fieldSources.address, "Manual");
  assert.match(result.devices[1].fieldSources.address, /частичное совпадение/);
  assert.deepEqual(requestedHistoryIps, [["10.0.1.99"]], "manual mappings run before historical lookup and known addresses remain untouched");
  assert.equal(result.diagnostics.counts.ipMappingFilled, 2);
});

test("historical address loader receives only unique switch IPs with a still-blank address", async () => {
  const requested = [];
  const result = await enrich({
    mainRows: [
      ["00:11:22:33:44:81", "10.0.0.81", ""],
      ["00:11:22:33:44:82", "10.0.0.81", ""],
      ["00:11:22:33:44:83", "10.0.0.83", "Known address"],
    ],
    mappings: { main: { mac: 0, switchIp: 1, address: 2 }, smartroom: {}, ddio: {} },
    loadHistoricalAddressIndex: async (ips) => {
      requested.push(ips);
      return buildHistoricalAddressIndex([
        { switchIp: "10.0.0.81", address: "Historical address", snapshotId: "final-1", snapshotName: "Final 1", deviceCount: 3 },
        { switchIp: "10.0.0.81", address: "Historical address", snapshotId: "final-2", snapshotName: "Final 2", deviceCount: 3 },
      ]);
    },
  });
  assert.deepEqual(requested, [["10.0.0.81"]]);
  assert.equal(result.devices[0].address, "Historical address");
  assert.equal(result.devices[1].address, "Historical address");
  assert.equal(result.devices[2].address, "Known address");
});

test("historical address inference can be disabled without loading evidence or changing addresses", async () => {
  let loadCount = 0;
  const result = await enrich({
    mainRows: [["00:11:22:33:44:91", "10.0.0.91", ""]],
    mappings: { main: { mac: 0, switchIp: 1, address: 2 }, smartroom: {}, ddio: {} },
    ipEnrichmentSettings: { historicalAddress: false },
    loadHistoricalAddressIndex: async () => {
      loadCount += 1;
      return buildHistoricalAddressIndex([
        { switchIp: "10.0.0.91", address: "Historical address", snapshotId: "final-1", deviceCount: 3 },
        { switchIp: "10.0.0.91", address: "Historical address", snapshotId: "final-2", deviceCount: 3 },
      ]);
    },
  });
  assert.equal(loadCount, 0);
  assert.equal(result.devices[0].address, "");
  assert.equal(result.diagnostics.counts.historicalAddressFilled, 0);
});

test("historical address lookup bounds requested switch-IP keys to 500-device batches", async () => {
  const requests = [];
  const mainRows = Array.from({ length: 1_205 }, (_, index) => {
    const octet3 = Math.floor(index / 256) + 1;
    const octet4 = index % 256;
    const macSuffix = index.toString(16).padStart(8, "0").match(/../g).join(":");
    return [`02:00:${macSuffix}`, `10.0.${octet3}.${octet4}`];
  });
  const result = await enrich({
    mainRows,
    mappings: { main: { mac: 0, switchIp: 1 } },
    retainHistoricalAddressIndex: false,
    loadHistoricalAddressIndex: async (ips) => {
      requests.push(ips);
      return new Map(ips.map((switchIp) => [switchIp, { switchIp, status: "confirmed", address: "Known historical address", confidence: 0.9, evidence: [] }]));
    },
  });
  assert.equal(result.devices.length, 1_205);
  assert.equal(result.historicalAddressIndex, null);
  assert.equal(result.diagnostics.counts.historicalAddressFilled, 1_205);
  assert.ok(result.devices.every((device) => device.address === "Known historical address"));
  assert.deepEqual(requests.map((ips) => ips.length), [500, 500, 205]);
  assert.ok(requests.every((ips) => new Set(ips).size === ips.length));
});

test("historical Smartroom ID lookup batches imported room keys and preserves every mapping", async () => {
  const requests = [];
  const mainRows = Array.from({ length: 1_205 }, (_, index) => {
    const macSuffix = index.toString(16).padStart(8, "0").match(/../g).join(":");
    return [`02:01:${macSuffix}`, `SR-${index}`, ""];
  });
  const result = await enrich({
    mainRows,
    mappings: { main: { mac: 0, smartroomId: 1, room: 2 } },
    loadHistoricalRoomIndex: async () => new Map(),
    loadImportedSmartroomRoomIndex: async (ids) => {
      requests.push(ids);
      return new Map(ids.map((smartroomId) => [smartroomId.toLowerCase(), {
        smartroomId,
        room: `Room ${smartroomId.slice(3)}`,
        status: "confirmed",
        alternatives: [],
      }]));
    },
  });
  assert.deepEqual(requests.map((ids) => ids.length), [500, 500, 205]);
  assert.ok(requests.every((ids) => new Set(ids).size === ids.length));
  assert.equal(result.devices.length, 1_205);
  assert.equal(result.devices[0].room, "Room 0");
  assert.equal(result.devices.at(-1).room, "Room 1204");
  assert.equal(result.diagnostics.counts.importedSmartroomRoomFilled, 1_205);
});

test("historical Smartroom evidence lookup bounds IDs to 500-device batches", async () => {
  const requests = [];
  const mainRows = Array.from({ length: 1_205 }, (_, index) => {
    const macSuffix = index.toString(16).padStart(8, "0").match(/../g).join(":");
    return [`02:02:${macSuffix}`, `HIST-${index}`, ""];
  });
  const result = await enrich({
    mainRows,
    mappings: { main: { mac: 0, smartroomId: 1, room: 2 } },
    loadHistoricalRoomIndex: async (ids) => {
      requests.push(ids);
      return new Map(ids.map((smartroomId) => [smartroomId.toLowerCase(), {
        smartroomId,
        room: `Historical ${smartroomId.slice(5)}`,
        status: "confirmed",
        sourceFinalId: "prior-final",
        alternatives: [],
      }]));
    },
  });
  assert.deepEqual(requests.map((ids) => ids.length), [500, 500, 205]);
  assert.ok(requests.every((ids) => new Set(ids).size === ids.length));
  assert.equal(result.devices.length, 1_205);
  assert.equal(result.devices[0].room, "Historical 0");
  assert.equal(result.devices.at(-1).room, "Historical 1204");
  assert.equal(result.diagnostics.counts.historicalSmartroomRoomFilled, 1_205);
});

test("10,000 Main rows remain linear and keep exact count", async () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => {
    const suffix = index.toString(16).padStart(8, "0").match(/../g).join(":");
    return [`02:00:${suffix}`, `10.${Math.floor(index / 65_536)}.${Math.floor(index / 256) % 256}.${index % 256}`];
  });
  const started = performance.now();
  const result = await enrich({ mainRows: rows, mappings });
  const elapsed = performance.now() - started;
  assert.equal(result.devices.length, 10_000);
  assert.ok(elapsed < 2_500, `10,000 rows took ${elapsed.toFixed(1)} ms`);
});

function rowsWithReadCount(controller, totalRows = 1_000) {
  let reads = 0;
  const visitedRows = new Set();
  const rows = Array.from({ length: totalRows }, (_, index) => {
    const mac = `00:44:55:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`;
    const row = [mac, `Room ${index}`, "", ""];
    Object.defineProperty(row, "0", {
      get() {
        if (!visitedRows.has(index)) {
          visitedRows.add(index);
          reads += 1;
          if (reads === 1) globalThis.setImmediate(() => controller.abort());
        }
        return mac;
      },
    });
    return row;
  });
  return { rows, get reads() { return reads; } };
}

test("cancelling during Main row processing stops before the next 500-row boundary", async () => {
  const controller = new globalThis.AbortController();
  const input = rowsWithReadCount(controller);
  await assert.rejects(enrich({
    mainRows: input.rows,
    mappings: { main: { mac: 0 } },
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(input.reads, 499);
});

test("cancelling during SmartRoom row processing stops after one bounded input batch", async () => {
  const controller = new globalThis.AbortController();
  const input = rowsWithReadCount(controller);
  await assert.rejects(enrich({
    mainRows: [["00:11:22:33:44:01"]],
    smartroomRows: input.rows,
    mappings: { main: { mac: 0 }, smartroom: { mac: 0, room: 1 } },
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(input.reads, 500);
});

test("cancelling during DDIO candidate scanning stops at the current 500-row batch", async () => {
  const controller = new globalThis.AbortController();
  const input = rowsWithReadCount(controller);
  await assert.rejects(enrich({
    mainRows: [["00:11:22:33:44:01"]],
    ddioRows: input.rows,
    mappings: { main: { mac: 0 }, ddio: { reservationMac: 0, reservationIp: 1, leaseMac: 2, leaseIp: 3 } },
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(input.reads, 500);
});

test("cancelling during a pre-normalized Main identity index stops at the current 500-device batch", async () => {
  const controller = new globalThis.AbortController();
  let reads = 0;
  const mainDevices = Array.from({ length: 1_000 }, (_, index) => {
    const device = { mac: `00:55:66:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}` };
    Object.defineProperty(device, "id", {
      get() {
        reads += 1;
        if (reads === 1) globalThis.setImmediate(() => controller.abort());
        return `device-${index}`;
      },
    });
    return device;
  });

  await assert.rejects(enrich({ mainDevices, signal: controller.signal }), { name: "AbortError" });
  assert.equal(reads, 500);
});

test("cancelling during a Previous Final identity index stops at the current 500-device batch", async () => {
  const controller = new globalThis.AbortController();
  let reads = 0;
  const previousFinal = Array.from({ length: 1_000 }, (_, index) => {
    const device = { mac: `00:66:77:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}` };
    Object.defineProperty(device, "id", {
      get() {
        reads += 1;
        if (reads === 1) globalThis.setImmediate(() => controller.abort());
        return `previous-${index}`;
      },
    });
    return device;
  });

  await assert.rejects(enrich({
    mainDevices: [{ id: "current", mac: "00:11:22:33:44:55" }],
    previousFinal,
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(reads, 500);
});

test("cancelling while applying Previous Final stops before loading the next device batch", async () => {
  const controller = new globalThis.AbortController();
  let lookupBatches = 0;
  const mainDevices = Array.from({ length: 1_000 }, (_, index) => ({
    id: `main-${index}`,
    mac: `00:77:88:${Math.floor(index / 65_536).toString(16).padStart(2, "0")}:${Math.floor(index / 256).toString(16).padStart(2, "0")}:${(index % 256).toString(16).padStart(2, "0")}`,
  }));

  await assert.rejects(enrich({
    mainDevices,
    loadPreviousIdentityIndex: async () => {
      lookupBatches += 1;
      globalThis.setImmediate(() => controller.abort());
      return buildIdentityIndex([]);
    },
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(lookupBatches, 1);
});

