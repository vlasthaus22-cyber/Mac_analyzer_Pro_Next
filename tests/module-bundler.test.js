import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { bundleModules } from "../scripts/module-bundler.js";

test("portable bundler isolates modules and resolves aliased named imports at runtime", () => {
  const bundle = bundleModules([
    ["src/one.js", "export const FIELDS = [1, 2];\nexport function first() { return FIELDS.length; }"],
    ["src/nested/two.js", "export const FIELDS = [\"a\", \"b\", \"c\"]"],
    ["src/entry.js", "import { FIELDS as firstFields, first } from \"./one.js\";\nimport { FIELDS as secondFields } from \"./nested/two.js\";\nexport const result = [first(), firstFields[0], secondFields[2]];"],
  ], { entryPath: "src/entry.js", exposeResult: true });
  const context = {};
  new Script(bundle).runInNewContext(context);
  assert.deepEqual(Array.from(context.__MAC_ANALYZER_BUNDLE_RESULT__.result), [2, 1, "c"]);
});

test("portable bundler rejects an omitted static import before building", () => {
  assert.throws(
    () => bundleModules([["src/entry.js", "import { missing } from \"./missing.js\"; export const result = missing;"]], { entryPath: "src/entry.js" }),
    /Imported module is missing from portable build/,
  );
});

test("portable bundler supports exported asynchronous generators", async () => {
  const bundle = bundleModules([
    ["src/stream.js", "export async function* rows() { yield [1]; yield [2]; }"],
    ["src/entry.js", "import { rows } from \"./stream.js\"; export const stream = rows();"],
  ], { entryPath: "src/entry.js", exposeResult: true });
  const context = {};
  new Script(bundle).runInNewContext(context);
  const rows = await Array.fromAsync(context.__MAC_ANALYZER_BUNDLE_RESULT__.stream);
  assert.deepEqual(rows.map((row) => Array.from(row)), [[1], [2]]);
});
