import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { optionalHostDatabaseExportHref } from "../src/ui/optional-host-controls.js";

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

test("the optional-host backup link is wired into the portable bundle and stays hidden by default", async () => {
  const [html, app, build] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "src/app.js"), "utf8"),
    readFile(path.join(root, "scripts/build-config.js"), "utf8"),
  ]);
  assert.match(html, /id="optionalHostDatabaseExportLink"[^>]*hidden[^>]*download="mac-analyzer-database-backup\.db"/);
  assert.match(html, /optionalHostDatabaseExportNote" class="muted" hidden>Эта копия содержит только базу optional host, не данные IndexedDB этой вкладки/);
  assert.match(app, /optionalHostDatabaseExportHref\(globalThis\.location\)/);
  assert.match(app, /optionalHostDatabaseExport\.hidden = false/);
  assert.match(build, /"src\/ui\/optional-host-controls\.js"/);
});
