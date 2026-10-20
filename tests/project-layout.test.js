import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("project map documents primary browser storage, optional loopback hosting, and portability", async () => {
  const [guide, agentContext, agents, tests, tools, scripts] = await Promise.all([
    read("docs/PROJECT_STRUCTURE.md"), read(".agents/README.md"), read("AGENTS.md"),
    read("tests/render.test.js"), read("tools/browser-smoke.mjs"), read("scripts/check.mjs"),
  ]);
  assert.match(guide, /browser IndexedDB as its primary storage/i);
  assert.match(guide, /optional Python loopback host/i);
  assert.match(guide, /STOP_MAC_ANALYZER_SERVER\.cmd/);
  assert.match(guide, /IndexedDB/);
  assert.match(guide, /does not yet provide a SQLite service or shared\s+database/i);
  assert.match(agentContext, /AGENTS\.md/);
  assert.match(agents, /Browser-only IndexedDB is the primary runtime/);
  assert.match(tests, /test\(/);
  assert.match(tools, /browser/);
  assert.match(scripts, /parity registry/);
});

test("Windows full-check wrapper runs pnpm check and preserves its exit code", async () => {
  const wrapper = await read("CHECK_MAC_ANALYZER.ps1");
  assert.match(wrapper, /Push-Location \$PSScriptRoot/);
  assert.match(wrapper, /pnpm check/);
  assert.match(wrapper, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
  assert.match(wrapper, /finally\s*\{\s*Pop-Location\s*\}/);
});
