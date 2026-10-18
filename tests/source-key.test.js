import test from "node:test";
import assert from "node:assert/strict";
import { buildSourceKey } from "../src/core/source-key.js";

test("source-key identity includes content digest alongside file metadata, strategy, and mappings", () => {
  const file = { name: "main.csv", size: 100, lastModified: 1234 };
  const base = { strategy: "ALLOW_EXPANSION", files: { main: file }, mappings: { main: { mac: 1 } }, sourceDigests: { main: "a".repeat(64) } };
  const identical = { ...base, files: { main: { ...file } } };
  const changedBytes = { ...base, sourceDigests: { main: "b".repeat(64) } };
  assert.equal(buildSourceKey(base), buildSourceKey(identical));
  assert.notEqual(buildSourceKey(base), buildSourceKey(changedBytes));
  assert.notEqual(buildSourceKey(base), buildSourceKey({ ...base, strategy: "NO_EXPANSION" }));
  assert.notEqual(buildSourceKey(base), buildSourceKey({ ...base, mappings: { main: { mac: 2 } } }));
});
