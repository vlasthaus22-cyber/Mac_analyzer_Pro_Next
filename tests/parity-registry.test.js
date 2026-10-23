import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { inspectParityRegistry } from "../scripts/parity-registry.js";
import { inspectProgressCheckpoint, inspectReleaseReadiness } from "../scripts/release-readiness.js";

test("parity registry has unique source rows and implementation/test references for every status", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const result = inspectParityRegistry(markdown);
  assert.deepEqual(result.issues, []);
  assert.equal(result.rows.length, 188);
  assert.match(readFileSync("README.md", "utf8"), /188 требований/);
  assert.ok(result.rows.some((row) => row.id === 670));
  assert.ok(result.rows.some((row) => row.id === 671));
  assert.ok(result.rows.some((row) => row.id === 677));
  assert.ok(result.rows.some((row) => row.id === 679));
});

test("system-service requirement maps optional-host services and browser storage/import/diagnostics/access modules", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find(({ id }) => id === 408);
  assert.ok(row);
  for (const path of ["backend/services/system/storage_paths.py", "backend/services/system/sqlite_store.py", "backend/services/system/backup_store.py", "backend/services/system/diagnostics_service.py", "backend/services/system/engineering_service.py", "backend/services/system/legacy_migration_service.py", "server.py", "src/data/database.js", "src/data/sqlite-database-importer.js", "src/core/diagnostics.js", "src/core/engineering-session.js", "scripts/parity-registry.js", "docs/DATA_STORAGE.md"]) {
    assert.ok(row.implementation.split("; ").includes(path), `missing system implementation mapping: ${path}`);
  }
  for (const path of ["tests/test_system_services.py", "tests/test_optional_server.py", "tests/test_optional_sqlite_store.py", "tests/optional-server.test.js", "tests/database.test.js", "tests/sqlite-importer.test.js", "tests/diagnostics.test.js", "tests/engineering-session.test.js", "tests/parity-registry.test.js"]) {
    assert.ok(row.tests.split("; ").includes(path), `missing system regression mapping: ${path}`);
  }
  assert.match(row.status, /PBKDF2/);
  assert.match(row.status, /read-only/);
  assert.match(row.status, /browser-only/i);
});

test("file-enrichment parity row maps the supported legacy XLS pipeline and its regressions", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find(({ id }) => id === 462);
  assert.ok(row);
  for (const path of ["src/data/importer.js", "src/core/import-limits.js", "src/core/batch.js", "src/app.js"]) {
    assert.ok(row.implementation.split("; ").includes(path), `missing file import implementation mapping: ${path}`);
  }
  for (const path of ["tests/importer.test.js", "tests/batch.test.js", "tests/build-config.test.js", "tests/enrichment.test.js"]) {
    assert.ok(row.tests.split("; ").includes(path), `missing file import regression mapping: ${path}`);
  }
  assert.match(row.status, /XLSX и legacy XLS проходят локальный обычный и массовый pipeline/);
  assert.match(row.status, /лимитом 16 МиБ/);
  assert.match(row.status, /реальный browser smoke остаётся открытым/);
  assert.doesNotMatch(row.status, /показывает эталонную инструкцию конвертации/);
});

test("vendor parity status records the shared complete PyQt and Web text-confidence formula", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find(({ id }) => id === 371);
  assert.ok(row);
  assert.match(row.status, /полный путь текстового confidence в PyQt и Web равен min\(2 × совпадения \/ число ключевых слов, 1\.0\) × 0\.8/);
  assert.match(row.status, /Оба режима PyQt-переключателя выполняют локальные OUI\/MAC5\/детекторные стадии до исторического lookup/);
  assert.match(row.status, /с приоритетом она может заменить лишь более слабую текстовую\/похожую inference-оценку, если её confidence выше/);
  assert.match(row.status, /Известные поля Main, OUI и локальные MAC5\/модельные правила защищены/);
  assert.match(readFileSync("PARITY_REGISTRY.md", "utf8"), /общий `src\/core\/history-confidence\.js` вычисляет confidence Next из числа наблюдений по формуле PyQt/);
  assert.match(row.status, /сохранённым профилем `pyqt` или `web`/);
  assert.doesNotMatch(row.status, /иной множитель Web backend оставлен открытым/);
});

test("source summary assertions stay open while specific parity gaps remain", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows } = inspectParityRegistry(markdown);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.match(byId.get(652).status, /^Не закрыто:/);
  assert.match(byId.get(652).status, /#370.*#673/);
  assert.match(byId.get(654).status, /^Не закрыто:/);
  assert.match(byId.get(654).status, /реальный browser smoke не запускался/);
  assert.match(byId.get(655).status, /^Не закрыто:/);
  assert.match(byId.get(655).status, /#370.*#673.*#666/);
});

test("Next parity registry covers every item in the pinned Web source index", () => {
  const source = JSON.parse(readFileSync("tests/fixtures/web-parity-source-index.json", "utf8"));
  const sourceIds = source.items.map(({ line }) => line);
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const nextIds = new Set(rows.map(({ id }) => id));
  assert.equal(source.sourceProject, "MAC Analyzer Pro Web");
  assert.equal(source.sourceVersion, "1.0.82");
  assert.equal(source.status, "complete");
  assert.equal(sourceIds.length, 178);
  assert.equal(new Set(sourceIds).size, sourceIds.length);
  assert.equal(source.items.filter(({ checked }) => !checked).length, 0);
  assert.deepEqual(sourceIds.filter((id) => !nextIds.has(id)), []);
});

test("source wording differences in the Next registry stay on the reviewed schema and renderer exceptions", () => {
  const sourceItems = JSON.parse(readFileSync("tests/fixtures/web-parity-source-index.json", "utf8")).items;
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const requirements = new Map(rows.map(({ id, requirement }) => [id, requirement]));
  const wordingDifferences = sourceItems
    .filter(({ line, text }) => !requirements.get(line)?.startsWith(text.trim()))
    .map(({ line }) => line)
    .sort((left, right) => left - right);
  assert.deepEqual(wordingDifferences, [27, 140, 144, 309, 330, 398, 405, 408]);
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

test("the progress checkpoint counts a partial slice only when its status explicitly says it is code tested", () => {
  const rows = [
    { id: 1, status: "Полностью: implemented and verified" },
    { id: 2, status: "Частично: кодовая часть проверена Python integration tests; backend persistence remains open" },
    { id: 3, status: "Частично: backend implementation remains open" },
  ];
  const readiness = inspectReleaseReadiness(rows);
  const markdown = [
    "Текущий прогресс активной цели: **33.3% проверенного переноса (1/3 требований); 2 пункт остаётся открытым**.",
    "Отдельный показатель переноса на уровне кода и автотестов: **66.7% (2/3)** — verified plus one explicitly code-tested partial slice.",
  ].join("\n");
  const checkpoint = inspectProgressCheckpoint(markdown, readiness);
  assert.equal(checkpoint.valid, true, checkpoint.issue);
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
