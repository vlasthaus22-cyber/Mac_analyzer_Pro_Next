import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { inspectParityRegistry } from "../scripts/parity-registry.js";

test("parity registry has unique source rows and implementation/test references for every status", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const result = inspectParityRegistry(markdown);
  assert.deepEqual(result.issues, []);
  assert.equal(result.rows.length, 187);
  assert.match(readFileSync("README.md", "utf8"), /187 требований/);
  assert.ok(result.rows.some((row) => row.id === 670));
  assert.ok(result.rows.some((row) => row.id === 671));
  assert.ok(result.rows.some((row) => row.id === 677));
});

test("system-service requirement maps to the browser storage, import, diagnostics, access, and parity modules", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find(({ id }) => id === 408);
  assert.ok(row);
  for (const path of ["src/data/database.js", "src/data/sqlite-database-importer.js", "src/core/diagnostics.js", "src/core/engineering-session.js", "scripts/parity-registry.js", "docs/DATA_STORAGE.md"]) {
    assert.ok(row.implementation.split("; ").includes(path), `missing system implementation mapping: ${path}`);
  }
  for (const path of ["tests/database.test.js", "tests/sqlite-importer.test.js", "tests/diagnostics.test.js", "tests/engineering-session.test.js", "tests/parity-registry.test.js"]) {
    assert.ok(row.tests.split("; ").includes(path), `missing system regression mapping: ${path}`);
  }
  assert.match(row.status, /PBKDF2/);
  assert.match(row.status, /read-only/);
  assert.match(row.status, /browser-only/);
});

test("source summary assertions stay open while specific parity gaps remain", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows } = inspectParityRegistry(markdown);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.match(byId.get(652).status, /^Не закрыто:/);
  assert.match(byId.get(652).status, /#370.*#673/);
  assert.match(byId.get(654).status, /^Не закрыто:/);
  assert.match(byId.get(654).status, /real-browser UI smoke/);
  assert.match(byId.get(655).status, /^Не закрыто:/);
  assert.match(byId.get(655).status, /#370.*#673.*#666/);
});

test("Next parity registry covers every item in the pinned PyQt source index", () => {
  const sourceIds = JSON.parse(readFileSync("tests/fixtures/pyqt-parity-source-ids.json", "utf8"));
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const nextIds = new Set(rows.map(({ id }) => id));
  assert.equal(sourceIds.length, 178);
  assert.equal(new Set(sourceIds).size, sourceIds.length);
  assert.deepEqual(sourceIds.filter((id) => !nextIds.has(id)), []);
});

test("source wording differences in the Next registry stay on the reviewed schema and renderer exceptions", () => {
  const sourceItems = JSON.parse(readFileSync("tests/fixtures/pyqt-parity-source-text.json", "utf8"));
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const requirements = new Map(rows.map(({ id, requirement }) => [id, requirement]));
  const wordingDifferences = sourceItems
    .filter(({ line, text }) => !requirements.get(line)?.startsWith(text.trim()))
    .map(({ line }) => line)
    .sort((left, right) => left - right);
  assert.deepEqual(wordingDifferences, [27, 140, 144, 309, 330]);
});

test("parity registry rejects duplicate IDs and undocumented partial rows", () => {
  const result = inspectParityRegistry([
    "| ID | Requirement | Implementation | Tests | Status |",
    "|---|---|---|---|---|",
    "| 1 | Requirement A | src/a.js | tests/a.test.js | Частично: covered |",
    "| 1 | Requirement B | — | — | Частично: no evidence |",
  ].join("\n"));
  assert.ok(result.issues.some((issue) => issue.includes("повторный ID эталона 1")));
  assert.ok(result.issues.some((issue) => issue.includes("нет модуля Next")));
  assert.ok(result.issues.some((issue) => issue.includes("нет теста Next")));
});

test("parity registry rejects dangling implementation and test paths", () => {
  const result = inspectParityRegistry([
    "| ID | Requirement | Implementation | Tests | Status |",
    "|---|---|---|---|---|",
    "| 1 | Requirement A | src/missing.js | tests/missing.test.js | Частично: tracked |",
  ].join("\n"), { exists: () => false });
  assert.ok(result.issues.some((issue) => issue.includes("файл реализации не найден: src/missing.js")));
  assert.ok(result.issues.some((issue) => issue.includes("файл теста не найден: tests/missing.test.js")));
});

test("open parity requirements still need mapped Next evidence and a regression test", () => {
  const result = inspectParityRegistry([
    "| ID | Requirement | Implementation | Tests | Status |",
    "|---|---|---|---|---|",
    "| 1 | Requirement A | — | — | Не закрыто: unsupported |",
  ].join("\n"));
  assert.ok(result.issues.some((issue) => issue.includes("нет модуля Next")));
  assert.ok(result.issues.some((issue) => issue.includes("нет теста Next")));
});

test("parity registry rejects descriptive progress text without an explicit completion status", () => {
  const result = inspectParityRegistry([
    "| ID | Requirement | Implementation | Tests | Status |",
    "|---|---|---|---|---|",
    "| 1 | Requirement A | src/a.js | tests/a.test.js | Added feature and tests; browser smoke remains open |",
  ].join("\n"));
  assert.ok(result.issues.some((issue) => issue.includes("статус должен явно обозначать полноту переноса")));
});

test("parity registry resolves hidden project-context directories", () => {
  const result = inspectParityRegistry([
    "| ID | Requirement | Implementation | Tests | Status |",
    "|---|---|---|---|---|",
    "| 1 | Agent context | .agents/README.md | tests/project-layout.test.js | Частично: mapped |",
  ].join("\n"), { exists: existsSync });
  assert.deepEqual(result.issues, []);
  assert.equal(result.rows[0].implementation, ".agents/README.md");
});
