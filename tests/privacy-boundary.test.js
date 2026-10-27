import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function runtimeJavaScriptFiles(directory = path.join(root, "src")) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? runtimeJavaScriptFiles(fullPath) : entry.isFile() && entry.name.endsWith(".js") ? [fullPath] : [];
  }));
  return nested.flat();
}

test("runtime network access uses bundled assets or bounded loopback-only optional-host requests", async () => {
  const files = await runtimeJavaScriptFiles();
  const fetchCalls = [];
  let optionalHostRestoreSource = "";
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (path.relative(root, file).split(path.sep).join("/") === "src/ui/optional-host-controls.js") optionalHostRestoreSource = source;
    for (const match of source.matchAll(/\b(?:globalThis\.)?fetch\s*\(/g)) {
      const remainder = source.slice(match.index + match[0].length);
      const literal = remainder.match(/^\s*(["'`])([^"'`]+)\1/);
      assert.ok(literal, `${path.relative(root, file)} must use an auditable literal local asset URL`);
      fetchCalls.push({ file: path.relative(root, file).split(path.sep).join("/"), target: literal[2] });
    }
    assert.doesNotMatch(source, /\bXMLHttpRequest\b|\bWebSocket\b|\.sendBeacon\s*\(|\baxios\b/, `${path.relative(root, file).split(path.sep).join("/")} must not add an external upload transport`);
  }

  assert.deepEqual(fetchCalls.sort((left, right) => left.target.localeCompare(right.target)), [
    { file: "src/ui/optional-host-controls.js", target: "/api/database/restore" },
    { file: "src/app.js", target: "assets/ieee-vendor-registry.json" },
    { file: "src/core/pdf-export.js", target: "assets/NotoSans-Regular.ttf" },
  ]);
  for (const call of fetchCalls) {
    if (call.target.startsWith("/api/")) continue;
    assert.match(call.target, /^assets\/[a-z0-9._/-]+$/i);
  }
  assert.match(optionalHostRestoreSource, /if \(!optionalHostDatabaseExportHref\(locationLike\)\) throw/);
  assert.match(optionalHostRestoreSource, /credentials: "same-origin"/);
  assert.match(optionalHostRestoreSource, /request\("\/api\/batch\/folders\/scan", \{[\s\S]{0,220}method: "POST"/);
  assert.match(optionalHostRestoreSource, /credentials: "same-origin",[\s\S]{0,100}cache: "no-store"/);
  assert.match(optionalHostRestoreSource, /body: file/);
  assert.match(optionalHostRestoreSource, /file\.size > MAX_OPTIONAL_HOST_DATABASE_RESTORE_BYTES/);
  assert.match(optionalHostRestoreSource, /if \(!optionalHostDatabaseExportHref\(locationLike\)\) return null/);
  assert.match(optionalHostRestoreSource, /request\("\/api\/system\/diagnostics", \{\s*method: "GET"/);
  assert.match(optionalHostRestoreSource, /credentials: "same-origin",\s*cache: "no-store"/);
  assert.doesNotMatch(optionalHostRestoreSource, /\/api\/system\/diagnostics"[\s\S]{0,240}?body:/);
  assert.match(optionalHostRestoreSource, /export async function uploadFinalSnapshotToOptionalHost/);
  assert.match(optionalHostRestoreSource, /MAX_OPTIONAL_HOST_SNAPSHOT_UPLOAD_BYTES/);
  assert.match(optionalHostRestoreSource, /request\(`\/api\/snapshots\/\$\{encodeURIComponent\(snapshotId\)\}`/);
  assert.match(optionalHostRestoreSource, /credentials: "same-origin"[\s\S]{0,100}redirect: "error"/);
  assert.match(optionalHostRestoreSource, /duplex: "half"/);
  assert.match(optionalHostRestoreSource, /new ReadableStreamImpl/);
  assert.match(optionalHostRestoreSource, /export async function uploadSnapshotHistoryToOptionalHost/);
  assert.match(optionalHostRestoreSource, /request\("\/api\/history"/);
  assert.match(optionalHostRestoreSource, /request\("\/api\/devices"/);
  assert.match(optionalHostRestoreSource, /MAX_OPTIONAL_HOST_INVENTORY_REQUEST_BYTES/);
  assert.match(optionalHostRestoreSource, /MAX_OPTIONAL_HOST_HISTORY_REQUEST_BYTES/);
  assert.match(optionalHostRestoreSource, /credentials: "same-origin"[\s\S]{0,80}redirect: "error"/);
});
