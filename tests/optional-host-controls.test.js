import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deleteOptionalHostSnapshot, deleteOptionalHostSnapshots, importOptionalHostOuiReferenceIntoDatabase, listOptionalHostHistoryForMac, listOptionalHostOuiReference, listOptionalHostSnapshots, loadOptionalHostDiagnostics, MAX_OPTIONAL_HOST_APP_BACKUP_BYTES, MAX_OPTIONAL_HOST_DATABASE_RESTORE_BYTES, optionalHostDatabaseExportHref, restoreWorkspaceBackupFromOptionalHost, runOptionalHostDatabaseMaintenance, saveWorkspaceBackupToOptionalHost, scanOptionalHostBatchFolders, searchOptionalHostDatabase, uploadFinalSnapshotToOptionalHost, uploadInventoryToOptionalHost, uploadSnapshotHistoryToOptionalHost, uploadSQLiteBackupToOptionalHost } from "../src/ui/optional-host-controls.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  const bytes = new globalThis.TextEncoder().encode(JSON.stringify(body));
  return {
    ok,
    status,
    body: new globalThis.ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
  };
}

test("optional host database export is available only on its loopback HTTP origin", () => {
  assert.equal(optionalHostDatabaseExportHref({ protocol: "http:", hostname: "127.0.0.1", port: "61234" }), "/api/database/export");
  assert.equal(optionalHostDatabaseExportHref({ protocol: "http:", hostname: "LOCALHOST", port: "61234" }), "/api/database/export");
  assert.equal(optionalHostDatabaseExportHref({ protocol: "http:", hostname: "127.0.0.1", port: "80" }), "");
  assert.equal(optionalHostDatabaseExportHref({ protocol: "http:", hostname: "127.0.0.1", port: "" }), "");
  assert.equal(optionalHostDatabaseExportHref({ protocol: "http:", hostname: "127.0.0.1", port: "70000" }), "");
  assert.equal(optionalHostDatabaseExportHref({ protocol: "http:", hostname: "192.168.1.5", port: "61234" }), "");
  assert.equal(optionalHostDatabaseExportHref({ protocol: "https:", hostname: "localhost", port: "61234" }), "");
  assert.equal(optionalHostDatabaseExportHref({ protocol: "file:", hostname: "", port: "" }), "");
  assert.equal(optionalHostDatabaseExportHref(null), "");
});

test("optional host OUI reference pages are loopback-only, bounded, sorted, and source-validated", async () => {
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  let request;
  const page = await listOptionalHostOuiReference({
    after: "001122", limit: 2, locationLike,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        total: 3,
        items: [{ prefix: "001123", vendor: "Reference B", source: "reference" }, { prefix: "001124", vendor: "Reference C", source: "builtin" }],
        nextAfter: "001124",
      });
    },
  });
  assert.equal(request.url, "/api/reference/oui?after=001122&limit=2");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(page.total, 3);
  await assert.rejects(() => listOptionalHostOuiReference({ locationLike: { protocol: "file:", hostname: "", port: "" }, fetchImpl: async () => { throw new Error("file origin must fail"); } }), /только через локальный optional host/);
  await assert.rejects(() => listOptionalHostOuiReference({ limit: 501, locationLike, fetchImpl: async () => { throw new Error("invalid limit must fail first"); } }), /от 1 до 500/);
  await assert.rejects(() => listOptionalHostOuiReference({ locationLike, fetchImpl: async () => jsonResponse({ total: 1, items: [{ prefix: "001122", vendor: "Custom", source: "custom" }], nextAfter: null }) }), /некорректную строку/);
  await assert.rejects(() => listOptionalHostOuiReference({ locationLike, fetchImpl: async () => jsonResponse({ total: 2, items: [{ prefix: "001123", vendor: "B", source: "reference" }], nextAfter: "001124" }) }), /несогласованный курсор/);
});

test("optional host OUI import pages the full list and lets IndexedDB preserve custom rules", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    prefix: (0x100000 + index).toString(16).toUpperCase().padStart(6, "0"),
    vendor: `Reference ${index}`,
    source: "reference",
  }));
  const requests = [];
  const imports = [];
  const progress = [];
  const result = await importOptionalHostOuiReferenceIntoDatabase({
    async importOui(batch, options) { imports.push({ batch, options }); return batch.length - (imports.length === 1 ? 1 : 0); },
  }, {
    locationLike: { protocol: "http:", hostname: "localhost", port: "61234" },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const query = new globalThis.URLSearchParams(url.split("?")[1]);
      const after = query.get("after") || "";
      const start = after ? rows.findIndex((item) => item.prefix === after) + 1 : 0;
      const pageRows = rows.slice(start, start + 500);
      return jsonResponse({ total: rows.length, items: pageRows, nextAfter: start + pageRows.length < rows.length ? pageRows.at(-1).prefix : null });
    },
    onProgress: (item) => progress.push(item),
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /limit=500/);
  assert.equal(requests[1].options.credentials, "same-origin");
  assert.equal(result.total, 501);
  assert.equal(result.received, 501);
  assert.equal(result.imported, 500, "the one preexisting custom rule is not counted as overwritten");
  assert.equal(imports.length, 2);
  assert.equal(imports[0].batch.length, 500);
  assert.equal(imports[1].batch.length, 1);
  assert(imports.flatMap(({ batch }) => batch).every((item) => item.source === "Справочник optional host"));
  assert(imports.every(({ options }) => options.overwriteExisting && options.overwriteSources.includes("Справочник optional host")));
  assert.deepEqual(progress.at(-1), { received: 501, total: 501, imported: 500 });
});

test("workspace JSON backup export is bounded, same-origin, and confirms the saved content", async () => {
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  const state = { version: 1, view: "search", search: "Комната А", page: 2, pageSize: 100, sort: { field: "mac", direction: 1 } };
  const content = JSON.stringify({ version: 1, createdAt: "2026-11-03T00:00:00+00:00", state });
  let request;
  const backup = await saveWorkspaceBackupToOptionalHost(state, {
    locationLike,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        ok: true, filename: "mac-analyzer-backup.json", mimeType: "application/json",
        content, bytes: new globalThis.TextEncoder().encode(content).byteLength, storedPath: "C:/app/data/backups/mac-analyzer-backup.json",
      });
    },
  });
  assert.equal(request.url, "/api/backup/export");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.redirect, "error");
  assert.deepEqual(JSON.parse(request.options.body), { state });
  assert.equal(backup.content, content);
  assert.equal(backup.bytes, new globalThis.TextEncoder().encode(content).byteLength);
  await assert.rejects(() => saveWorkspaceBackupToOptionalHost({ value: "x".repeat(MAX_OPTIONAL_HOST_APP_BACKUP_BYTES + 1) }, {
    locationLike,
    fetchImpl: async () => { throw new Error("oversized state must fail before sending"); },
  }), /512 КиБ/);
  await assert.rejects(() => saveWorkspaceBackupToOptionalHost(state, {
    locationLike: { protocol: "file:", hostname: "", port: "" },
    fetchImpl: async () => { throw new Error("file origin must fail before sending"); },
  }), /только через локальный optional host/);
});

test("workspace JSON backup restore sends bounded file bytes and validates the restored state", async () => {
  const locationLike = { protocol: "http:", hostname: "localhost", port: "61234" };
  const state = { version: 1, view: "analytics", search: "codec", page: 1, pageSize: 50, sort: { field: "mac", direction: -1 } };
  const content = JSON.stringify({ version: 1, createdAt: "2026-11-03T00:00:00+00:00", state });
  const bytes = new globalThis.TextEncoder().encode(content);
  let request;
  const restored = await restoreWorkspaceBackupFromOptionalHost({
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  }, {
    locationLike,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ ok: true, state, version: 1, bytes: bytes.byteLength, storedPath: "C:/app/data/backups/restored-backup.json" });
    },
  });
  assert.equal(request.url, "/api/backup/restore");
  assert.equal(request.options.credentials, "same-origin");
  assert.deepEqual([...globalThis.Buffer.from(JSON.parse(request.options.body).contentBase64, "base64")], [...bytes]);
  assert.deepEqual(restored.state, state);
  assert.equal(restored.version, 1);
  assert.equal(restored.bytes, bytes.byteLength);
  await assert.rejects(() => restoreWorkspaceBackupFromOptionalHost({ size: MAX_OPTIONAL_HOST_APP_BACKUP_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) }, {
    locationLike,
    fetchImpl: async () => { throw new Error("oversized file must fail before sending"); },
  }), /512 КиБ/);
});

test("Windows batch folder dates are requested only from same-origin loopback and bounded metadata is validated", async () => {
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  const result = { ok: true, folders: { main: { folderName: "Main", files: 1 }, smartroom: { folderName: "", files: 0 }, ddio: { folderName: "", files: 0 } }, files: [{ role: "main", name: "main.csv", relativePath: "main.csv", size: 12, date: "2026-10-27T00:00:00Z", dateSource: "filesystem.created" }], supportedExtensions: [".csv"] };
  let request;
  assert.deepEqual(await scanOptionalHostBatchFolders({ main: "C:/Exports/Main" }, {
    locationLike,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(result);
    },
  }), result);
  assert.equal(request.url, "/api/batch/folders/scan");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(request.options.body), { paths: { main: "C:/Exports/Main" } });
  await assert.rejects(scanOptionalHostBatchFolders({ main: "C:/Exports" }, {
    locationLike: { ...locationLike, hostname: "192.168.1.10" },
    fetchImpl: async () => { throw new Error("remote hosts must never receive folder paths"); },
  }), /локальный optional host/);
  await assert.rejects(scanOptionalHostBatchFolders({ main: "x".repeat(32_769) }, {
    locationLike,
    fetchImpl: async () => { throw new Error("oversized paths must not be sent"); },
  }), /слишком длинный/);
  await assert.rejects(scanOptionalHostBatchFolders({ main: "C:/Exports" }, {
    locationLike,
    fetchImpl: async () => jsonResponse({ ...result, files: [{ ...result.files[0], dateSource: "untrusted" }] }),
  }), /некорректные метаданные/);
  await assert.rejects(scanOptionalHostBatchFolders({ main: "C:/Exports" }, {
    locationLike,
    fetchImpl: async () => ({ ok: true, body: new globalThis.ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      controller.close();
    } }) }),
  }), /превышает предел 8 МиБ/);
});

test("optional-host UI exposes only explicit same-origin Inventory, Final, and backup actions", async () => {
  const [html, app, controls, build] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "src/app.js"), "utf8"),
    readFile(path.join(root, "src/ui/optional-host-controls.js"), "utf8"),
    readFile(path.join(root, "scripts/build-config.js"), "utf8"),
  ]);
  assert.match(html, /id="optionalHostDatabaseExportLink"[^>]*hidden[^>]*download="mac-analyzer-database-backup\.db"/);
  assert.match(html, /id="optionalHostWorkspaceBackupButton"[^>]*hidden>Скачать JSON-копию в optional host/);
  assert.match(html, /id="optionalHostWorkspaceRestoreInput" type="file" accept="application\/json,\.json"/);
  assert.match(html, /JSON-копия содержит только раздел, поиск и параметры таблицы/);
  assert.match(app, /saveWorkspaceBackupToOptionalHost\(workspace\)/);
  assert.match(app, /async function saveWorkspaceStateNow\(\) \{\s*globalThis\.clearTimeout\(state\.workspaceAutosaveTimer\);\s*state\.workspaceAutosaveTimer = 0;\s*return persistWorkspaceState\(\);\s*\}/);
  assert.match(app, /restoreWorkspaceBackupFromOptionalHost\(file\)/);
  assert.match(html, /optionalHostDatabaseExportNote" class="muted" hidden>Эта копия содержит только базу optional host, не данные IndexedDB этой вкладки/);
  assert.match(html, /id="importOptionalHostOuiButton"[^>]*hidden/);
  assert.match(html, /optionalHostOuiImportStatus" class="muted" role="status" aria-live="polite" hidden/);
  assert.match(app, /importOptionalHostOuiReferenceIntoDatabase\(database/);
  assert.match(controls, /overwriteSources: \["Справочник optional host"\]/);
  assert.match(app, /importOptionalHostOuiButton"\)\.addEventListener\("click"/);
  assert.match(controls, /export async function listOptionalHostOuiReference/);
  assert.match(app, /optionalHostDatabaseExportHref\(globalThis\.location\)/);
  assert.match(app, /optionalHostDatabaseExport\.hidden = false/);
  assert.match(app, /optionalHostDatabaseRestoreLabel"\)\.hidden = false/);
  assert.match(app, /uploadSQLiteBackupToOptionalHost\(file\)/);
  assert.match(app, /optionalHostDatabaseRestoreInput"\)\.addEventListener\("change"/);
  assert.match(html, /optionalHostDatabaseRestoreInput" type="file" accept="\.sqlite,\.sqlite3,\.db"/);
  assert.match(html, /активная база не заменяется/);
  assert.match(html, /id="optionalHostSnapshotUploadButton"[^>]*hidden[^>]*disabled/);
  assert.match(html, /id="optionalHostInventoryUploadButton"[^>]*hidden[^>]*disabled/);
  assert.match(html, /optionalHostInventoryUploadNote" class="muted" hidden>Накопленный Inventory передаётся локальному optional host курсорными страницами и пакетами/);
  assert.match(app, /uploadInventoryToOptionalHost\(database\.iterateInventoryPages\(\{ pageSize: 250 \}\)/);
  assert.match(app, /optionalHostInventoryUploadButton"\)\.addEventListener\("click"/);
  assert.match(html, /id="optionalHostSnapshotUploadNote" class="muted" hidden>Final и связанные события History отправляются одному локальному optional host как NDJSON-копия размером до 256 МиБ/);
  assert.match(app, /uploadFinalSnapshotToOptionalHost\(metadata, database\.iterateSnapshotDevices\(metadata\.id\)\)/);
  assert.match(app, /uploadSnapshotHistoryToOptionalHost\([\s\S]*?database\.iterateSnapshotHistoryEvents\(metadata\.id\)/);
  assert.match(app, /result\.alreadyExists[\s\S]*уже скопирован без изменений/);
  assert.match(app, /optionalHostSnapshotUploadButton"\)\.hidden = false/);
  assert.match(app, /optionalHostSnapshotUploadButton"\)\.addEventListener\("click"/);
  assert.match(html, /id="loadOptionalHostSnapshotsButton"[^>]*hidden/);
  assert.match(html, /id="loadOptionalHostMacHistoryButton"[^>]*hidden/);
  assert.match(app, /listOptionalHostHistoryForMac\(mac, \{ after: cursor, limit: 250 \}\)/);
  assert.match(app, /loadOptionalHostMacHistoryButton"\)\.addEventListener\("click", \(\) => openMacHistory\(\{ includeOptionalHostHistory: true \}\)/);
  assert.match(controls, /export async function listOptionalHostHistoryForMac/);
  assert.match(html, /атомарно удаляет каждый выбранный Final вместе с его History; Inventory и остальные снимки сохраняются/);
  assert.match(app, /deleteOptionalHostSnapshotFromUi\(remove\)/);
  assert.match(controls, /method: "DELETE"/);
  assert.match(controls, /export async function listOptionalHostSnapshots/);
  assert.match(controls, /\/api\/snapshots\/\$\{encodeURIComponent\(snapshotId\)\}/);
  assert.match(controls, /request\("\/api\/history"/);
  assert.match(controls, /request\("\/api\/devices"/);
  assert.match(build, /"src\/ui\/optional-host-controls\.js"/);
});

test("optional SQLite database search is bounded to same-origin loopback and validates projected rows", async () => {
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  const result = {
    results: [{ type: "device", mac: "00:11:22:33:44:55", title: "00:11:22:33:44:55", subtitle: "Acme · Codec", source: "Main", updatedAt: "2026-10-30" }],
    count: 1,
  };
  let request;
  assert.deepEqual(await searchOptionalHostDatabase(" Acme & Co ", {
    limit: 25,
    locationLike,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(result);
    },
  }), result);
  const params = new globalThis.URL(request.url, "http://127.0.0.1").searchParams;
  assert.equal(params.get("query"), "Acme & Co");
  assert.equal(params.get("limit"), "25");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.redirect, "error");

  let sent = false;
  await assert.rejects(searchOptionalHostDatabase("x", {
    locationLike: { ...locationLike, hostname: "192.168.1.10" },
    fetchImpl: async () => { sent = true; },
  }), /только в SQLite optional host/);
  await assert.rejects(searchOptionalHostDatabase("x".repeat(257), {
    locationLike,
    fetchImpl: async () => { sent = true; },
  }), /256 символов/);
  await assert.rejects(searchOptionalHostDatabase("x", {
    limit: 501, locationLike, fetchImpl: async () => { sent = true; },
  }), /от 1 до 500/);
  await assert.rejects(searchOptionalHostDatabase("x", {
    locationLike, fetchImpl: async () => jsonResponse({ ...result, count: 2 }),
  }), /некорректную страницу/);
  await assert.rejects(searchOptionalHostDatabase("x", {
    locationLike, fetchImpl: async () => jsonResponse({ ...result, results: [{ ...result.results[0], type: "html" }] }),
  }), /некорректную строку/);
  assert.equal(sent, false);
});

test("optional SQLite database search is discoverable only on the host UI and opens MAC history", async () => {
  const [html, app, controls] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "src/app.js"), "utf8"),
    readFile(path.join(root, "src/ui/optional-host-controls.js"), "utf8"),
  ]);
  assert.match(html, /id="optionalHostDatabaseSearchPanel" class="panel wide" hidden/);
  assert.match(html, /только в отдельной SQLite-копии локального optional host/);
  assert.match(app, /optionalHostDatabaseSearchPanel"\)\.hidden = false/);
  assert.match(app, /searchOptionalHostDatabase\(query, \{ limit: 100 \}\)/);
  assert.match(app, /escapeHtml\(item\.title \|\| mac\)/);
  assert.match(app, /openMacHistory\(\{ includeOptionalHostHistory: true \}\)/);
  assert.match(controls, /request\("\/api\/database\/search\?" \+ params/);
  assert.match(controls, /MAX_OPTIONAL_HOST_DATABASE_SEARCH_RESPONSE_BYTES/);
});

test("optional host snapshot management is bounded to loopback and validates delete scope", async () => {
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  let request;
  const page = { snapshots: [{ id: "final-a", name: "Main <today>", deviceCount: 12, createdAt: "2026-10-22T10:00:00Z", source: "Main.csv" }], total: 1, nextCursor: null };
  const listed = await listOptionalHostSnapshots({
    locationLike,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(page);
    },
  });
  assert.deepEqual(listed, page);
  assert.equal(request.url, "/api/snapshots?limit=50");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "same-origin");
  await assert.rejects(listOptionalHostSnapshots({ locationLike, after: "x".repeat(201), fetchImpl: async () => { throw new Error("invalid cursor must not fetch"); } }), /неверный формат/);
  await assert.rejects(listOptionalHostSnapshots({ locationLike: { ...locationLike, hostname: "192.168.1.5" }, fetchImpl: async () => { throw new Error("remote host must not fetch"); } }), /локальный optional host/);
  await assert.rejects(listOptionalHostSnapshots({
    locationLike,
    fetchImpl: async () => ({ ok: true, body: new globalThis.ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      controller.close();
    } }) }),
  }), /превышает предел 1 МиБ/);
  await assert.rejects(listOptionalHostSnapshots({
    locationLike,
    fetchImpl: async () => jsonResponse({ ...page, snapshots: [...page.snapshots, ...page.snapshots] }),
  }), /некорректную страницу Final/);
  await assert.rejects(listOptionalHostSnapshots({
    locationLike,
    fetchImpl: async () => jsonResponse({ ...page, nextCursor: "other-final" }),
  }), /несогласованный курсор Final/);

  const deleted = { ok: true, snapshotId: "final/a", deletedSnapshotCount: 1, deletedHistoryCount: 4, inventoryPreserved: true };
  const result = await deleteOptionalHostSnapshot("final/a", {
    locationLike,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => deleted };
    },
  });
  assert.deepEqual(result, deleted);
  assert.equal(request.url, "/api/snapshots/final%2Fa");
  assert.equal(request.options.method, "DELETE");
  assert.equal(request.options.credentials, "same-origin");
  await assert.rejects(deleteOptionalHostSnapshot("final/a", {
    locationLike,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ...deleted, deletedSnapshotCount: 0 }) }),
  }), /не подтвердил удаление только выбранного Final/);
  await assert.rejects(deleteOptionalHostSnapshot("final/a", {
    locationLike: { ...locationLike, protocol: "file:" },
    fetchImpl: async () => { throw new Error("file mode must not fetch"); },
  }), /только через локальный optional host/);
});

test("optional-host MAC History reads exact bounded pages only from the same loopback origin", async () => {
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  let request;
  const page = {
    events: [{
      id: 12, sourceFinalId: "final-a", observedAt: "2026-10-22T10:00:00Z",
      internalDeviceId: "device-a", eventType: "modified", mac: "00:11:22:33:44:55",
      field: "room", fromValue: "101", toValue: "202",
    }],
    total: 2,
    nextCursor: 12,
  };
  const result = await listOptionalHostHistoryForMac("001122334455", {
    locationLike,
    after: 4,
    limit: 25,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(page);
    },
  });
  assert.deepEqual(result, page);
  const query = new globalThis.URL(request.url, "http://localhost").searchParams;
  assert.equal(query.get("mac"), "00:11:22:33:44:55");
  assert.equal(query.get("after"), "4");
  assert.equal(query.get("limit"), "25");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.redirect, "error");

  let sent = false;
  await assert.rejects(listOptionalHostHistoryForMac("bad", {
    locationLike, fetchImpl: async () => { sent = true; },
  }), /корректный MAC/);
  await assert.rejects(listOptionalHostHistoryForMac("00:11:22:33:44:55", {
    locationLike: { ...locationLike, hostname: "192.168.1.5" },
    fetchImpl: async () => { sent = true; },
  }), /только через локальный optional host/);
  await assert.rejects(listOptionalHostHistoryForMac("00:11:22:33:44:55", {
    locationLike, after: 4, fetchImpl: async () => ({
      ok: true,
      body: jsonResponse({ ...page, nextCursor: 4 }).body,
    }),
  }), /некорректную страницу/);
  await assert.rejects(listOptionalHostHistoryForMac("00:11:22:33:44:55", {
    locationLike,
    fetchImpl: async () => ({ ok: true, body: new globalThis.ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      controller.close();
    } }) }),
  }), /превышает предел 1 МиБ/);
  await assert.rejects(listOptionalHostHistoryForMac("00:11:22:33:44:55", {
    locationLike,
    fetchImpl: async () => jsonResponse({ ...page, events: [...page.events, ...page.events] }),
  }), /некорректное событие History/);
  await assert.rejects(listOptionalHostHistoryForMac("00:11:22:33:44:55", {
    locationLike,
    fetchImpl: async () => jsonResponse({ ...page, nextCursor: 11 }),
  }), /несогласованный курсор History/);
  assert.equal(sent, false);
});

test("optional host snapshot list selects the current bounded page and deletes only checked copies", async () => {
  const [html, app] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "src/app.js"), "utf8"),
  ]);
  assert.match(html, /Выберите одну или несколько копий на странице/);
  assert.match(app, /const optionalHostSnapshotPage = \{ after: "", previous: \[\], items: \[\], selected: new Set\(\) \}/);
  assert.match(app, /listOptionalHostSnapshots\(\{ after, limit: 50 \}\)/);
  assert.match(app, /data-optional-host-snapshot-select-page/);
  assert.match(app, /data-optional-host-snapshot-select="\$\{escapeHtml\(snapshot\.id\)\}"/);
  assert.match(app, /selected = optionalHostSnapshotPage\.items\.filter\(\(\{ id \}\) => optionalHostSnapshotPage\.selected\.has\(id\)\)/);
  assert.match(app, /Each Final is deleted in a separate transaction|Каждый Final удаляется отдельной транзакцией/);
  assert.match(app, /deleteOptionalHostSnapshots\(selected\.map\(\(\{ id \}\) => id\)\)/);
  assert.match(app, /result\.failures\.map\(\(\{ snapshotId, message \}\)/);
  assert.match(app, /updateOptionalHostSnapshotSelectionUi\(\)/);
});

test("bulk optional-host deletion is serial, bounded, and reports per-Final failures", async () => {
  const calls = [];
  let activeRequests = 0;
  let maximumConcurrentRequests = 0;
  const locationLike = { protocol: "http:", hostname: "localhost", port: "61234" };
  const result = await deleteOptionalHostSnapshots(["final-a", "final-b", "final-c"], {
    locationLike,
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "DELETE");
      activeRequests += 1;
      maximumConcurrentRequests = Math.max(maximumConcurrentRequests, activeRequests);
      calls.push(url);
      await Promise.resolve();
      activeRequests -= 1;
      if (url.endsWith("final-b")) return { ok: false, status: 503, json: async () => ({}) };
      const snapshotId = decodeURIComponent(url.slice("/api/snapshots/".length));
      return {
        ok: true,
        json: async () => ({
          ok: true, snapshotId, deletedSnapshotCount: 1, deletedHistoryCount: 2, inventoryPreserved: true,
        }),
      };
    },
  });
  assert.deepEqual(calls, ["/api/snapshots/final-a", "/api/snapshots/final-b", "/api/snapshots/final-c"]);
  assert.equal(maximumConcurrentRequests, 1);
  assert.deepEqual(result, {
    deletedIds: ["final-a", "final-c"],
    failures: [{ snapshotId: "final-b", message: "Optional host не удалил Final (HTTP 503)" }],
  });
  let sent = false;
  await assert.rejects(deleteOptionalHostSnapshots(new Array(51).fill("final-a"), { locationLike, fetchImpl: async () => { sent = true; } }), /от 1 до 50/);
  await assert.rejects(deleteOptionalHostSnapshots(["final-a", "final-a"], { locationLike, fetchImpl: async () => { sent = true; } }), /повторяющийся ID/);
  assert.equal(sent, false);
});

test("Inventory copies every row in bounded batches and preserves observation counts on retries", async () => {
  const snapshot = "inventory-source";
  async function* pages() {
    yield Array.from({ length: 501 }, (_, index) => ({
      id: `inventory-${index}`,
      mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
      serial: `serial-${index}`,
      manufacturer: "Acme",
      vendorConfidence: 0.91,
      vendorSource: "OUI",
      model: "Codec X",
      modelConfidence: 0.87,
      modelSource: "MAC5",
      oui: "001122",
      physicalAddress: "Room 101",
      businessUnit: "Operations",
      city: "Moscow",
      site: "HQ",
      floor: "4",
      deviceType: "Codec",
      authenticationTime: "2026-10-21T10:00:00.000Z",
      firstSeen: "2026-10-20T10:00:00.000Z",
      lastSeen: "2026-10-21T10:00:00.000Z",
      lastMissing: "2026-10-19T10:00:00.000Z",
      present: true,
      snapshotId: "final-latest",
      possibleIps: ["192.0.2.1", "2001:db8::1"],
      possibleIpsTruncated: true,
      customFieldSources: { sourceFinalId: "Main" },
      fieldSources: { ip: "DDIO", possibleIps: "DDIO" },
      conflictsTruncated: true,
      ...(index === 0 ? { alternateMacs: "AA-BB-CC-DD-EE-FF,00:11:22:33:00:00" } : {}),
      observationCount: index + 1,
      customFields: { sourceFinalId: snapshot },
    }));
  }
  const sent = [];
  const result = await uploadInventoryToOptionalHost(pages(), {
    locationLike: { protocol: "http:", hostname: "localhost", port: "61234" },
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/devices");
      assert.equal(options.method, "PUT");
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["Content-Type"], "application/json");
      const payload = JSON.parse(options.body);
      assert.ok(payload.devices.length <= 500);
      assert.ok(new globalThis.TextEncoder().encode(options.body).byteLength <= 900 * 1024);
      sent.push(payload.devices);
      return jsonResponse({ savedCount: payload.devices.length, rejectedCount: 0, conflictCount: 0, conflicts: [] });
    },
  });
  assert.deepEqual(sent.map((batch) => batch.length), [500, 1]);
  assert.deepEqual(result, { deviceCount: 501, savedCount: 501, rejectedCount: 0, conflictCount: 0, conflicts: [], conflictsTruncated: false });
  assert.equal(sent[0][0].internalDeviceId, "inventory-0");
  assert.equal(sent[0][0].serialNumber, "serial-0");
  assert.equal(sent[0][0].vendor, "Acme");
  assert.equal(sent[0][0].manufacturer, "Acme");
  assert.equal(sent[0][0].vendorConfidence, 0.91);
  assert.equal(sent[0][0].vendorSource, "OUI");
  assert.equal(sent[0][0].modelConfidence, 0.87);
  assert.equal(sent[0][0].modelSource, "MAC5");
  assert.equal(sent[0][0].oui, "001122");
  assert.equal(sent[0][0].address, "Room 101");
  assert.equal(sent[0][0].businessUnit, "Operations");
  assert.equal(sent[0][0].city, "Moscow");
  assert.equal(sent[0][0].site, "HQ");
  assert.equal(sent[0][0].floor, "4");
  assert.equal(sent[0][0].deviceType, "Codec");
  assert.equal(sent[0][0].authenticationTime, "2026-10-21T10:00:00.000Z");
  assert.equal(sent[0][0].firstSeen, "2026-10-20T10:00:00.000Z");
  assert.equal(sent[0][0].lastSeen, "2026-10-21T10:00:00.000Z");
  assert.equal(sent[0][0].lastMissing, "2026-10-19T10:00:00.000Z");
  assert.equal(sent[0][0].present, true);
  assert.equal(sent[0][0].snapshotId, "final-latest");
  assert.deepEqual(sent[0][0].possibleIps, ["192.0.2.1", "2001:db8::1"]);
  assert.equal(sent[0][0].possibleIpsTruncated, true);
  assert.equal(sent[0][0].observationCount, 1);
  assert.deepEqual(sent[0][0].alternateMacs, ["AA:BB:CC:DD:EE:FF"]);
  assert.deepEqual(sent[0][0].customFields, { sourceFinalId: snapshot });
  assert.deepEqual(sent[0][0].customFieldSources, { sourceFinalId: "Main" });
  assert.deepEqual(sent[0][0].fieldSources, { ip: "DDIO", possibleIps: "DDIO" });
  assert.equal(sent[0][0].conflictsTruncated, true);
});

test("Inventory upload accepts exact conflict totals with a bounded diagnostic sample", async () => {
  async function* pages() { yield Array.from({ length: 101 }, (_, index) => ({ id: `device-${index}`, observationCount: 1 })); }
  const response = jsonResponse({
    savedCount: 0,
    rejectedCount: 101,
    conflictCount: 101,
    conflicts: Array.from({ length: 100 }, (_, index) => ({ internalDeviceId: `device-${index}`, reason: "conflict" })),
    conflictsTruncated: true,
  });
  const result = await uploadInventoryToOptionalHost(pages(), {
    locationLike: { protocol: "http:", hostname: "127.0.0.1", port: "61234" },
    fetchImpl: async () => response,
  });
  assert.deepEqual(result, {
    deviceCount: 101,
    savedCount: 0,
    rejectedCount: 101,
    conflictCount: 101,
    conflicts: Array.from({ length: 50 }, (_, index) => ({ internalDeviceId: `device-${index}`, reason: "conflict" })),
    conflictsTruncated: true,
  });
});

test("Inventory diagnostics do not count an accepted device as rejected", async () => {
  async function* pages() { yield [{ id: "device-a", observationCount: 1 }]; }
  const result = await uploadInventoryToOptionalHost(pages(), {
    locationLike: { protocol: "http:", hostname: "127.0.0.1", port: "61234" },
    fetchImpl: async () => jsonResponse({
      savedCount: 1,
      rejectedCount: 0,
      conflictCount: 1,
      conflicts: [{ internalDeviceId: "device-a", reason: "conflicting_strong_identity" }],
    }),
  });
  assert.deepEqual(result, {
    deviceCount: 1,
    savedCount: 1,
    rejectedCount: 0,
    conflictCount: 1,
    conflicts: [{ internalDeviceId: "device-a", reason: "conflicting_strong_identity" }],
    conflictsTruncated: false,
  });
});

test("Inventory upload rejects malformed counts and non-loopback destinations before sending", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return { ok: true, json: async () => ({ savedCount: 1, conflictCount: 0, conflicts: [] }) }; };
  const makePages = (row) => async function* pages() { yield [row]; };
  await assert.rejects(uploadInventoryToOptionalHost(makePages({ id: "device-a", observationCount: true })(), {
    locationLike: { protocol: "http:", hostname: "127.0.0.1", port: "61234" }, fetchImpl,
  }), /некорректное число наблюдений/);
  await assert.rejects(uploadInventoryToOptionalHost(makePages({ id: "device-a", observationCount: 1 })(), {
    locationLike: { protocol: "http:", hostname: "192.168.1.5", port: "61234" }, fetchImpl,
  }), /только локальному optional host/);
  assert.equal(requests, 0);
});

test("active Final History uploads as bounded idempotent batches only to the same-origin loopback host", async () => {
  const snapshotId = "history-final";
  async function* pages() {
    yield Array.from({ length: 501 }, (_, index) => ({
      id: index + 1,
      snapshotId,
      deviceId: `device-${index}`,
      mac: `00:11:22:33:${String(index >> 8).padStart(2, "0")}:${String(index & 255).padStart(2, "0")}`,
      type: "modified",
      timestamp: "2026-10-21T10:00:00Z",
      field: "room",
      oldValue: "101",
      newValue: "202",
      source: "Main",
    }));
  }
  const sent = [];
  const result = await uploadSnapshotHistoryToOptionalHost(snapshotId, pages(), {
    locationLike: { protocol: "http:", hostname: "localhost", port: "61234" },
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/history");
      assert.equal(options.method, "PUT");
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["Content-Type"], "application/json");
      const payload = JSON.parse(options.body);
      assert.ok(payload.events.length <= 500);
      assert.ok(new globalThis.TextEncoder().encode(options.body).byteLength <= 900 * 1024);
      sent.push(payload.events);
      return {
        ok: true,
        json: async () => ({ insertedCount: sent.length === 1 ? payload.events.length : 0, duplicateCount: sent.length === 1 ? 0 : payload.events.length }),
      };
    },
  });
  assert.deepEqual(sent.map((batch) => batch.length), [500, 1]);
  assert.deepEqual(result, { eventCount: 501, insertedCount: 500, duplicateCount: 1 });
  assert.deepEqual(sent[0][0], {
    sourceFinalId: snapshotId,
    observedAt: "2026-10-21T10:00:00Z",
    internalDeviceId: "device-0",
    eventType: "modified",
    mac: "00:11:22:33:00:00",
    source: "Main",
    field: "room",
    fromValue: "101",
    toValue: "202",
  });
});

test("snapshot History upload rejects another Final and non-loopback destinations before sending", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return { ok: true, json: async () => ({ insertedCount: 0, duplicateCount: 0 }) }; };
  const pages = async function* () {
    yield [{ snapshotId: "other-final", type: "added", timestamp: "2026-10-21T10:00:00Z", deviceId: "device-a" }];
  };
  await assert.rejects(uploadSnapshotHistoryToOptionalHost("target-final", pages(), {
    locationLike: { protocol: "http:", hostname: "127.0.0.1", port: "61234" }, fetchImpl,
  }), /не связано с копируемым Final/);
  await assert.rejects(uploadSnapshotHistoryToOptionalHost("target-final", pages(), {
    locationLike: { protocol: "http:", hostname: "192.168.1.5", port: "61234" }, fetchImpl,
  }), /только локальному optional host/);
  assert.equal(requests, 0);
});

test("SQLite restore uploads the selected file only to the same-origin loopback host", async () => {
  const bytes = new Uint8Array(100);
  bytes.set(new globalThis.TextEncoder().encode("SQLite format 3\0"));
  const file = new globalThis.Blob([bytes]);
  let request;
  const result = await uploadSQLiteBackupToOptionalHost(file, {
    locationLike: { protocol: "http:", hostname: "127.0.0.1", port: "61234" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ ok: true, bytes: 100, integrity: "ok" }) };
    },
  });

  assert.equal(result.integrity, "ok");
  assert.equal(request.url, "/api/database/restore");
  assert.equal(request.options.method, "PUT");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.headers["Content-Type"], "application/vnd.sqlite3");
  assert.equal(request.options.body, file);
});

test("active Final uploads as a size-bounded NDJSON Blob only to the same-origin loopback host", async () => {
  const metadata = { id: "final 1", name: "Final 1", createdAt: "2026-10-21T10:00:00.000Z", deviceCount: 2 };
  async function* devices() {
    yield { internalDeviceId: "device-a", mac: "00:11:22:33:44:01" };
    yield { internalDeviceId: "device-b", mac: "00:11:22:33:44:02" };
  }
  let request;
  let requestText = "";
  const result = await uploadFinalSnapshotToOptionalHost(metadata, devices(), {
    locationLike: { protocol: "http:", hostname: "127.0.0.1", port: "61234" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      assert.ok(options.body instanceof globalThis.Blob);
      requestText = await options.body.text();
      return { ok: true, status: 201, json: async () => ({ snapshotId: "final 1", deviceCount: 2, signature: "a".repeat(64) }) };
    },
  });

  assert.equal(result.deviceCount, 2);
  assert.equal(request.url, "/api/snapshots/final%201");
  assert.equal(request.options.method, "PUT");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers["Content-Type"], "application/x-ndjson");
  assert.equal(request.options.headers["Content-Length"], undefined);
  assert.deepEqual(requestText.trim().split("\n").map((line) => JSON.parse(line)), [
    { type: "snapshot", id: "final 1", name: "Final 1", source: "IndexedDB Final", createdAt: metadata.createdAt, deviceCount: 2 },
    { internalDeviceId: "device-a", mac: "00:11:22:33:44:01" },
    { internalDeviceId: "device-b", mac: "00:11:22:33:44:02" },
  ]);
});

test("active Final upload rejects non-loopback origins and mismatched device counts", async () => {
  let requestCount = 0;
  const fetchImpl = async (_url, options) => {
    requestCount += 1;
    const reader = options.body.getReader();
    while (!(await reader.read()).done) {}
    return { ok: true, status: 201, json: async () => ({ snapshotId: "final-a", deviceCount: 1, signature: "b".repeat(64) }) };
  };
  const metadata = { id: "final-a", name: "Final A", createdAt: "2026-10-21T10:00:00Z", deviceCount: 1 };
  const devices = async function* () { yield { internalDeviceId: "device-a" }; };
  await assert.rejects(uploadFinalSnapshotToOptionalHost(metadata, devices(), {
    locationLike: { protocol: "http:", hostname: "192.168.1.5", port: "61234" }, fetchImpl,
  }), /только локальному optional host/);
  await assert.rejects(uploadFinalSnapshotToOptionalHost({ ...metadata, deviceCount: 2 }, devices(), {
    locationLike: { protocol: "http:", hostname: "127.0.0.1", port: "61234" }, fetchImpl,
  }), /В потоке Final/);
  assert.equal(requestCount, 0);
});

test("large device rows remain intact in the bounded NDJSON upload payload", async () => {
  const metadata = { id: "large-final", name: "Large Final", createdAt: "2026-10-21T10:00:00Z", deviceCount: 1 };
  const largeValue = "x".repeat(100_000);
  const devices = async function* () { yield { internalDeviceId: "large-device", mac: "00:11:22:33:44:09", note: largeValue }; };
  let payload = "";
  await uploadFinalSnapshotToOptionalHost(metadata, devices(), {
    locationLike: { protocol: "http:", hostname: "localhost", port: "61234" },
    fetchImpl: async (_url, options) => {
      assert.ok(options.body.size < 256 * 1024 * 1024);
      payload = await options.body.text();
      return { ok: true, status: 201, json: async () => ({ snapshotId: "large-final", deviceCount: 1, signature: "c".repeat(64) }) };
    },
  });
  const records = payload.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records[0].deviceCount, 1);
  assert.equal(records[1].note, largeValue);
});

test("optional host diagnostics uses a bodyless same-origin GET only for loopback pages", async () => {
  let request;
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  const report = { checks: [{ id: "host-sqlite", title: "SQLite", status: "ok", detail: "quick_check: ok" }], passed: 1, warnings: 0, errors: 0 };
  const result = await loadOptionalHostDiagnostics({
    locationLike,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(report);
    },
  });

  assert.deepEqual(result, report);
  assert.equal(request.url, "/api/system/diagnostics");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.cache, "no-store");
  assert.equal("body" in request.options, false);
  assert.equal(await loadOptionalHostDiagnostics({
    locationLike: { protocol: "file:", hostname: "", port: "" },
    fetchImpl: async () => { throw new Error("file mode must not fetch"); },
  }), null);
});

test("optional host database maintenance stays loopback, validates bounded summaries, and sends explicit options", async () => {
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  const summary = { sizeBytes: 120, tableCount: 2, counts: { snapshots: 1, device_inventory: 4 } };
  const maintenance = {
    ok: true, integrity: "ok", afterIntegrity: "ok", optimized: true, vacuumed: true,
    before: summary, after: { ...summary, sizeBytes: 100 }, reclaimedBytes: 20,
  };
  let request;
  const result = await runOptionalHostDatabaseMaintenance({
    integrity: true, optimize: true, vacuum: true, locationLike,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(maintenance);
    },
  });
  assert.deepEqual(result, maintenance);
  assert.equal(request.url, "/api/database/maintenance");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(request.options.body), { integrity: true, optimize: true, vacuum: true });

  await assert.rejects(runOptionalHostDatabaseMaintenance({
    locationLike: { ...locationLike, hostname: "192.168.1.5" }, fetchImpl: async () => { throw new Error("must not fetch remote hosts"); },
  }), /только для SQLite optional host/);
  await assert.rejects(runOptionalHostDatabaseMaintenance({
    locationLike, vacuum: "yes", fetchImpl: async () => { throw new Error("invalid options must not fetch"); },
  }), /неверный формат/);
  await assert.rejects(runOptionalHostDatabaseMaintenance({
    locationLike, fetchImpl: async () => jsonResponse({ ...maintenance, after: { ...summary, counts: { snapshots: -1 } } }),
  }), /несогласованный результат/);
});

test("optional host diagnostics reads a bounded stream and validates every check and summary count", async () => {
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  const fetchReport = (payload) => loadOptionalHostDiagnostics({ locationLike, fetchImpl: async () => jsonResponse(payload) });
  const valid = { checks: [{ id: "host-health", title: "Health", status: "ok", detail: "ready" }], passed: 1, warnings: 0, errors: 0 };
  assert.deepEqual(await fetchReport(valid), valid);

  const invalidReports = [
    { ...valid, checks: [{ id: "host-health", status: "ok" }] },
    { ...valid, checks: [valid.checks[0], valid.checks[0]], passed: 2 },
    { ...valid, checks: [{ ...valid.checks[0], status: "unknown" }] },
    { ...valid, errors: 1 },
  ];
  for (const report of invalidReports) {
    await assert.rejects(fetchReport(report), /некорректн|несогласован/);
  }

  let cancelled = false;
  await assert.rejects(loadOptionalHostDiagnostics({
    locationLike,
    fetchImpl: async () => ({
      ok: true,
      body: new globalThis.ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
      }),
    }),
  }), /превышает предел 1 МиБ/);
  assert.equal(cancelled, true, "oversized response streams are canceled as soon as the limit is crossed");
});

test("SQLite restore rejects non-loopback origins, bad headers, and oversized files before upload", async () => {
  let requestCount = 0;
  const fetchImpl = async () => { requestCount += 1; return { ok: true, json: async () => ({ ok: true, integrity: "ok" }) }; };
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  const validFile = new globalThis.Blob([new Uint8Array(100)]);

  await assert.rejects(uploadSQLiteBackupToOptionalHost(validFile, {
    locationLike: { ...locationLike, hostname: "192.168.1.5" }, fetchImpl,
  }), /только через локальный optional host/);
  await assert.rejects(uploadSQLiteBackupToOptionalHost(validFile, { locationLike, fetchImpl }), /не является базой SQLite/);
  await assert.rejects(uploadSQLiteBackupToOptionalHost({
    size: MAX_OPTIONAL_HOST_DATABASE_RESTORE_BYTES + 1,
    slice: () => { throw new Error("oversize file must not be read"); },
  }, { locationLike, fetchImpl }), /превышает предел 512 МиБ/);
  assert.equal(requestCount, 0);
});
