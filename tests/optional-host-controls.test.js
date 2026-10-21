import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOptionalHostDiagnostics, loadOptionalHostSnapshotDevicePage, loadOptionalHostSnapshotPage, MAX_OPTIONAL_HOST_DATABASE_RESTORE_BYTES, optionalHostDatabaseExportHref, uploadFinalSnapshotToOptionalHost, uploadSQLiteBackupToOptionalHost } from "../src/ui/optional-host-controls.js";

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

test("optional-host backup and Final transfer controls are loopback-only in the portable bundle", async () => {
  const [html, app, build] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "src/app.js"), "utf8"),
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
  assert.match(html, /id="optionalHostSnapshotUploadNote" class="muted" hidden>Передача идёт потоково только через loopback optional host/);
  assert.match(app, /uploadFinalSnapshotToOptionalHost\(metadata, database\.iterateSnapshotDevices\(metadata\.id\)\)/);
  assert.match(app, /optionalHostSnapshotUploadButton"\)\.hidden = false/);
  assert.match(app, /optionalHostSnapshotUploadButton"\)\.addEventListener\("click"/);
  assert.match(html, /id="optionalHostSnapshotsPanel" class="panel wide" hidden/);
  assert.match(app, /loadOptionalHostSnapshotPage\(\{ after, limit: OPTIONAL_HOST_SNAPSHOT_PAGE_SIZE \}\)/);
  assert.match(app, /loadOptionalHostSnapshotDevicePage\(snapshot\.id, \{ after, limit: OPTIONAL_HOST_SNAPSHOT_PAGE_SIZE \}\)/);
  assert.match(app, /optionalHostSnapshotsRefreshButton"\)\.addEventListener\("click"/);
  assert.match(build, /"src\/ui\/optional-host-controls\.js"/);
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

test("optional-host SQLite snapshots and devices load by bounded cursor pages", async () => {
  const locationLike = { protocol: "http:", hostname: "127.0.0.1", port: "61234" };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith("/api/snapshots?")) {
      return { ok: true, json: async () => ({ snapshots: [{ id: "snapshot / 1", name: "Final A", deviceCount: 120, createdAt: "2026-10-21T10:00:00Z" }], total: 121, nextCursor: "snapshot / 1" }) };
    }
    return { ok: true, json: async () => ({ snapshotId: "snapshot / 1", deviceCount: 120, devices: [{ internalDeviceId: "device-a", mac: "00:11:22:33:44:01" }], nextCursor: 100 }) };
  };
  const snapshots = await loadOptionalHostSnapshotPage({ after: "older / final", locationLike, fetchImpl });
  const devices = await loadOptionalHostSnapshotDevicePage("snapshot / 1", { after: 100, locationLike, fetchImpl });

  assert.equal(snapshots.total, 121);
  assert.equal(snapshots.snapshots[0].deviceCount, 120);
  assert.equal(requests[0].url, "/api/snapshots?limit=100&after=older+%2F+final");
  assert.equal(requests[0].options.credentials, "same-origin");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[1].url, "/api/snapshots/snapshot%20%2F%201/devices?limit=100&after=100");
  assert.equal(devices.devices[0].internalDeviceId, "device-a");
  assert.equal(devices.nextCursor, 100);
});

test("optional-host SQLite reads reject external origins and malformed responses", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ snapshots: [], total: -1, nextCursor: null }) }; };
  await assert.rejects(loadOptionalHostSnapshotPage({
    locationLike: { protocol: "http:", hostname: "192.168.1.20", port: "61234" }, fetchImpl,
  }), /только через локальный optional host/);
  await assert.rejects(loadOptionalHostSnapshotPage({
    locationLike: { protocol: "http:", hostname: "localhost", port: "61234" }, fetchImpl,
  }), /некорректный список снимков/);
  assert.equal(calls, 1);
  await assert.rejects(loadOptionalHostSnapshotDevicePage("../database", {
    locationLike: { protocol: "http:", hostname: "localhost", port: "61234" }, fetchImpl,
  }), /некорректную страницу устройств/);
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
