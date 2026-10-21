import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOptionalHostDiagnostics, MAX_OPTIONAL_HOST_DATABASE_RESTORE_BYTES, optionalHostDatabaseExportHref, uploadFinalSnapshotToOptionalHost, uploadSnapshotHistoryToOptionalHost, uploadSQLiteBackupToOptionalHost } from "../src/ui/optional-host-controls.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("optional-host UI exposes only explicit same-origin Final copy and backup actions", async () => {
  const [html, app, controls, build] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "src/app.js"), "utf8"),
    readFile(path.join(root, "src/ui/optional-host-controls.js"), "utf8"),
    readFile(path.join(root, "scripts/build-config.js"), "utf8"),
  ]);
  assert.match(html, /id="optionalHostDatabaseExportLink"[^>]*hidden[^>]*download="mac-analyzer-database-backup\.db"/);
  assert.match(html, /optionalHostDatabaseExportNote" class="muted" hidden>Эта копия содержит только базу optional host, не данные IndexedDB этой вкладки/);
  assert.match(app, /optionalHostDatabaseExportHref\(globalThis\.location\)/);
  assert.match(app, /optionalHostDatabaseExport\.hidden = false/);
  assert.match(app, /optionalHostDatabaseRestoreLabel"\)\.hidden = false/);
  assert.match(app, /uploadSQLiteBackupToOptionalHost\(file\)/);
  assert.match(app, /optionalHostDatabaseRestoreInput"\)\.addEventListener\("change"/);
  assert.match(html, /optionalHostDatabaseRestoreInput" type="file" accept="\.sqlite,\.sqlite3,\.db"/);
  assert.match(html, /активная база не заменяется/);
  assert.match(html, /id="optionalHostSnapshotUploadButton"[^>]*hidden[^>]*disabled/);
  assert.match(html, /id="optionalHostSnapshotUploadNote" class="muted" hidden>Потоковая копия Final и связанные с ним события History передаются только локальному optional host/);
  assert.match(app, /uploadFinalSnapshotToOptionalHost\(metadata, database\.iterateSnapshotDevices\(metadata\.id\)\)/);
  assert.match(app, /uploadSnapshotHistoryToOptionalHost\([\s\S]*?database\.iterateSnapshotHistoryEvents\(metadata\.id\)/);
  assert.match(app, /result\.alreadyExists[\s\S]*уже скопирован без изменений/);
  assert.match(app, /optionalHostSnapshotUploadButton"\)\.hidden = false/);
  assert.match(app, /optionalHostSnapshotUploadButton"\)\.addEventListener\("click"/);
  assert.match(controls, /\/api\/snapshots\/\$\{encodeURIComponent\(snapshotId\)\}/);
  assert.match(controls, /request\("\/api\/history"/);
  assert.match(build, /"src\/ui\/optional-host-controls\.js"/);
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

test("active Final uploads as bounded NDJSON frames only to the same-origin loopback host", async () => {
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
      const reader = options.body.getReader();
      const decoder = new globalThis.TextDecoder();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        assert.ok(next.value.byteLength <= 64 * 1024);
        requestText += decoder.decode(next.value, { stream: true });
      }
      requestText += decoder.decode();
      return { ok: true, status: 201, json: async () => ({ snapshotId: "final 1", deviceCount: 2, signature: "a".repeat(64) }) };
    },
  });

  assert.equal(result.deviceCount, 2);
  assert.equal(request.url, "/api/snapshots/final%201");
  assert.equal(request.options.method, "PUT");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.duplex, "half");
  assert.equal(request.options.headers["Content-Type"], "application/x-ndjson");
  assert.equal("Content-Length" in request.options.headers, false);
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
  }), /потоково передать Final/);
  assert.equal(requestCount, 1);
});

test("large device rows split across 64 KiB network frames without changing NDJSON records", async () => {
  const metadata = { id: "large-final", name: "Large Final", createdAt: "2026-10-21T10:00:00Z", deviceCount: 1 };
  const largeValue = "x".repeat(100_000);
  const devices = async function* () { yield { internalDeviceId: "large-device", mac: "00:11:22:33:44:09", note: largeValue }; };
  const frames = [];
  await uploadFinalSnapshotToOptionalHost(metadata, devices(), {
    locationLike: { protocol: "http:", hostname: "localhost", port: "61234" },
    fetchImpl: async (_url, options) => {
      const reader = options.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        assert.ok(next.value.byteLength <= 64 * 1024);
        frames.push(next.value);
      }
      return { ok: true, status: 201, json: async () => ({ snapshotId: "large-final", deviceCount: 1, signature: "c".repeat(64) }) };
    },
  });
  const bytes = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0));
  let offset = 0;
  for (const frame of frames) { bytes.set(frame, offset); offset += frame.byteLength; }
  const records = new globalThis.TextDecoder().decode(bytes).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records[0].deviceCount, 1);
  assert.equal(records[1].note, largeValue);
});

test("optional host diagnostics uses a bodyless same-origin GET only for loopback pages", async () => {
  let request;
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  const report = { checks: [{ id: "host-sqlite", status: "ok" }], errors: 0 };
  const result = await loadOptionalHostDiagnostics({
    locationLike,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => report };
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
