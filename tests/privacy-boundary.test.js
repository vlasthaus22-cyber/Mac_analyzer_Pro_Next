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

test("runtime network access is limited to bundled local assets and has no upload transports", async () => {
  const files = await runtimeJavaScriptFiles();
  const fetchCalls = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\b(?:globalThis\.)?fetch\s*\(/g)) {
      const remainder = source.slice(match.index + match[0].length);
      const literal = remainder.match(/^\s*(["'`])([^"'`]+)\1/);
      assert.ok(literal, `${path.relative(root, file)} must use an auditable literal local asset URL`);
      fetchCalls.push({ file: path.relative(root, file).split(path.sep).join("/"), target: literal[2] });
    }
    assert.doesNotMatch(source, /\bXMLHttpRequest\b|\bWebSocket\b|\.sendBeacon\s*\(|\baxios\b/, `${path.relative(root, file).split(path.sep).join("/")} must not add an external upload transport`);
  }

  assert.deepEqual(fetchCalls.sort((left, right) => left.target.localeCompare(right.target)), [
    { file: "src/app.js", target: "assets/ieee-vendor-registry.json" },
    { file: "src/core/pdf-export.js", target: "assets/NotoSans-Regular.ttf" },
  ]);
  for (const call of fetchCalls) assert.match(call.target, /^assets\/[a-z0-9._/-]+$/i);
});
