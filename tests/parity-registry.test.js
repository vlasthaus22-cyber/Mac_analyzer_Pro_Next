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

test("enrichment expansion strategies have focused real-browser evidence", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows } = inspectParityRegistry(markdown);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  for (const id of [341, 342]) {
    const row = rows.find((entry) => entry.id === id);
    assert.ok(row);
    assert.match(row.status, /^Полностью подтверждено:/);
    assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  }
  assert.match(browserSmoke, /--expansion-no-only/);
  assert.match(browserSmoke, /--expansion-allow-only/);
  assert.match(browserSmoke, /hostname-only row was not added/);
});

test("DDIO mapping, history hint and export have focused real-browser evidence", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 420);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--ddio-only/);
  assert.match(browserSmoke, /ddio-ip-marker/);
  assert.match(browserSmoke, /possibleIpExcludedFromExport/);
});

test("DDIO possibilities remain separate through switch-IP history and Final export in Edge", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 270);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /--ddio-only[\s\S]*два Final[\s\S]*CSV Final[\s\S]*History/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--ddio-only/);
  assert.match(browserSmoke, /possibleIpExcludedFromExport/);
  assert.match(browserSmoke, /ddioHistoryHint/);
});

test("vendor API UI and host settings share tested numeric and provider normalization", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 541);
  const ui = readFileSync("src/core/external-vendor-settings.js", "utf8");
  const host = readFileSync("backend/services/integrations/external_vendor.py", "utf8");
  const uiTests = readFileSync("tests/external-vendor-settings.test.js", "utf8");
  const hostTests = readFileSync("tests/test_external_vendor.py", "utf8");
  const sharedCases = readFileSync("tests/fixtures/external-vendor-settings.json", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Частично:/);
  assert.match(row.status, /совпадение UI\/backend-нормализации provider, пустых\/null\/нулевых лимитов и TTL/);
  assert.match(ui, /settings\.provider \|\| ""\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(ui, /input === null \|\| typeof input === "number" \|\| typeof input === "string" \|\| typeof input === "boolean"/);
  assert.match(host, /def bounded_integer\(key: str, fallback: int, maximum: int\)/);
  assert.match(uiTests, /rateLimit: 0, cacheTtlDays: null/);
  assert.match(hostTests, /"rateLimit": 0, "cacheTtlDays": None/);
  assert.match(uiTests, /shared cross-runtime normalization cases/);
  assert.match(hostTests, /shared_cross_runtime_normalization_cases/);
  assert.match(sharedCases, /python-only numeric separators are rejected like JavaScript/);
});

test("Dashboard period mode and range survive an Edge reload with a current Final", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 292);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--period-mode-persistence-only/);
  assert.match(browserSmoke, /analyticsDashboardSettings/);
  assert.match(browserSmoke, /Reload replaced or lost the chosen period while a current Final remained/);
});

test("custom source fields round-trip through Main, SmartRoom, DDIO, and persisted provenance in Chrome", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 678);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /--custom-fields-only/);
  assert.match(row.status, /Main, SmartRoom и DDIO/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--custom-fields-only/);
  assert.match(browserSmoke, /customFieldSources/);
  assert.match(browserSmoke, /customColumnLabels/);
  assert.match(browserSmoke, /persisted\.device\?\.ip !== "192\.0\.2\.51"/);
  assert.match(browserSmoke, /possibleIps\?\.includes\("198\.51\.100\.51"\)/);
});

test("Dashboard XLSX browser export retains unique physical rooms and excludes unknown switch addresses", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 676);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /--dashboard-xlsx-parity-only/);
  assert.match(row.status, /Room Alpha[\s\S]*Room Beta[\s\S]*10\.0\.0\.1[\s\S]*10\.0\.0\.2/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--dashboard-xlsx-parity-only/);
  assert.match(browserSmoke, /XLSX stored-entry size or CRC does not match/);
  assert.match(browserSmoke, /roomCount !== 2/);
  assert.match(browserSmoke, /JSON\.stringify\(switchRows\) !== JSON\.stringify\(knownSwitches\)/);
});

test("batch queue failure policy is verified through browser UI and atomic IndexedDB state", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 668);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  const batchSource = readFileSync("src/core/batch.js", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /--batch-queue-failure-only[\s\S]*continue[\s\S]*stop/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--batch-queue-failure-only/);
  assert.match(browserSmoke, /Injected queue-cycle quota failure/);
  assert.match(browserSmoke, /Не запускался: очередь остановлена после ошибки пары №2/);
  assert.match(batchSource, /pair\.status = pair\.enabled === false \? "skipped" : "ready"/);
});

test("SQLite Smartroom room mappings round-trip through browser import and Main enrichment", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 670);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено(?:\s|\()/);
  assert.match(row.status, /--sqlite-smartroom-room-only[\s\S]*нормализованному ID[\s\S]*Imported SQLite Smartroom room mapping/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--sqlite-smartroom-room-only/);
  assert.match(browserSmoke, /tests\/fixtures\/smartroom-room-mappings\.sqlite/);
  assert.match(browserSmoke, /fieldSources\?\.room/);
  assert.match(browserSmoke, /roomConfidence !== 1/);
});

test("large-data requirement maps real-browser heap profiling for delimited and XLSX imports", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 550);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /Edge XLSX smoke 2026-11-05[\s\S]*20 000 MAC[\s\S]*96 MiB[\s\S]*Edge smoke 2026-11-05 \(--blob-stress-only[\s\S]*75 MiB[\s\S]*Chrome headless smoke 2026-11-05[\s\S]*fallback-export-stress-only[\s\S]*stress-rows=10000[\s\S]*fallback Blob без ошибки[\s\S]*40 001 CSV строк[\s\S]*59 MiB[\s\S]*85 MiB/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--stress-only/);
  assert.match(browserSmoke, /--xlsx-stress-only/);
  assert.match(browserSmoke, /--stress-rows=/);
  assert.match(browserSmoke, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(browserSmoke, /createZip\(entries\)/);
  assert.match(browserSmoke, /Runtime\.getHeapUsage/);
  assert.match(browserSmoke, /peakUsedMiB/);
  assert.match(browserSmoke, /stressRows \* 2/);
});

test("large-data fallback export disables File System Access before navigation and checks every directed row", () => {
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(browserSmoke, /--fallback-export-stress-only/);
  assert.match(browserSmoke, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(browserSmoke, /showSaveFilePicker', \{ configurable: true, value: undefined \}/);
  assert.match(browserSmoke, /fallbackExportEvidence\.lines !== stressRows \* 4 \+ 1/);
  assert.match(browserSmoke, /expectedLastMac/);
  assert.match(browserSmoke, /exportPeakUsedMiB/);
});

test("large original-file Blob attachments are persisted with each stress Final", () => {
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(browserSmoke, /--blob-stress-only/);
  assert.match(browserSmoke, /originalFiles/);
  assert.match(browserSmoke, /blobSize !== file\.size/);
  assert.match(browserSmoke, /DEV-STRESS-\$\{index === 0 \? stressRows \* 2 - 1 : stressRows - 1\}/);
});

test("Windows folder creation dates reach the batch pair through a real Edge UI smoke", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 666);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /Edge smoke 2026-11-05[\s\S]*filesystem\.created[\s\S]*не содержал содержимое CSV/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--batch-folder-metadata-only/);
  assert.match(browserSmoke, /filesystem\.created/);
  assert.match(browserSmoke, /применено дат файловой системы: 1/);
  assert.match(browserSmoke, /requestContainsFileContents/);
});

test("theme UI applies a choice and restores IndexedDB ahead of a conflicting local preference", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 596);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено для browser-only Next/);
  assert.match(row.status, /localStorage=light[\s\S]*восстановило dark из IndexedDB/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--theme-smoke-only/);
  assert.match(browserSmoke, /ThemeSelectionDialog/);
  assert.match(browserSmoke, /conflicting localStorage value/);
  assert.match(browserSmoke, /restoredTheme\.local !== "light"/);
  assert.match(browserSmoke, /databaseThemeAfterReload !== "dark"/);
});

test("browser-only autosave recovery rejects stale pointers and restores the newest complete Final", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 57);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено для browser-only Next/);
  assert.match(row.status, /stale pointer[\s\S]*неполный snapshot[\s\S]*восстановил последний целый Final/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /startup recovery ignored a stale active pointer and a newer incomplete Final/);
  assert.match(browserSmoke, /startupRecoveryState/);
});

test("saved Final and Inventory counters remain visible during a real IndexedDB startup failure", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 59);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено/);
  assert.match(row.status, /--database-unavailable-cache-only[\s\S]*точные оба счётчика[\s\S]*ошибку IndexedDB/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--database-unavailable-cache-only/);
  assert.match(browserSmoke, /cachedCounts\?\.snapshotCount !== 1/);
  assert.match(browserSmoke, /injected:\s*Boolean\(window\.__smokeIDBFailureInstalled\)/i);
  assert.match(browserSmoke, /unavailableState\.status\.includes\("1 устройств"\)/);
});

test("all-changed room KPI opens the exact positive room roster in real-browser smoke", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 207);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--all-changed-room-only/);
  assert.match(browserSmoke, /if \(kpi\.value === "1"\) break/);
  assert.match(browserSmoke, /allChangedRoomsKpi/);
  assert.match(browserSmoke, /rosterContainsBothDevices/);
});

test("reference Dashboard browser evidence checks exact pair counts, graph values, room timeline, and console", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 146);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--reference-dashboard-146-only/);
  assert.match(browserSmoke, /expectedKpis: \{ devices: 6, added: 3, absent: 1, modified: 2 \}/);
  assert.match(browserSmoke, /добавлено 3, отсутствовало 1/);
  assert.match(browserSmoke, /roomTimelineCount: timelineCount/);
  assert.match(browserSmoke, /runtimeDiagnostics\.length/);
});

test("Previous Final and unmatched DDIO do not create Final rows in real-browser smoke", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 343);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--no-new-final-rows-only/);
  assert.match(browserSmoke, /previousFinalAbsentDeviceNotRestored/);
  assert.match(browserSmoke, /unmatchedDdioDidNotCreateDevice/);
});

test("browser Final write failure keeps the prior snapshot active and dismisses its error", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 344);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--final-write-failure-only/);
  assert.match(browserSmoke, /previousFinalPreserved/);
  assert.match(browserSmoke, /errorDismissed/);
});

test("identity and expansion parity maps its strategy and Previous Final browser evidence", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 351);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--expansion-no-only/);
  assert.match(browserSmoke, /--expansion-allow-only/);
  assert.match(browserSmoke, /--no-new-final-rows-only/);
});

test("switch-IP history and DDIO warnings require a real historical change in browser smoke", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  for (const id of [352, 366]) {
    const row = rows.find((entry) => entry.id === id);
    assert.ok(row);
    assert.match(row.status, /^Полностью подтверждено:/);
    assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  }
  assert.match(browserSmoke, /initialSwitchIpReport/);
  assert.match(browserSmoke, /switchIpReport/);
  assert.match(browserSmoke, /noDedicatedIpChangesView/);
});

test("Main priority parity keeps every non-empty Main field over stale sources in Edge smoke", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find((entry) => entry.id === 363);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.ok(row.tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(browserSmoke, /--no-new-final-rows-only/);
  assert.match(browserSmoke, /currentMainFieldsPreserved/);
  assert.match(browserSmoke, /previousFinalAbsentDeviceNotRestored/);
  assert.match(browserSmoke, /unmatchedDdioDidNotCreateDevice/);
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
  assert.match(byId.get(652).status, /#370 и #673 перенесены в код и покрыты автотестами/);
  assert.match(byId.get(652).status, /реальная пользовательская отправка уведомлений и browser smoke остаются открытыми/);
  assert.match(byId.get(654).status, /^Полностью подтверждено/);
  assert.match(byId.get(654).status, /Edge 2026-11-05[\s\S]*--optional-host-workflows-only[\s\S]*--optional-host-transfer-only[\s\S]*--optional-diagnostics-only/);
  assert.ok(byId.get(654).tests.split("; ").includes("tools/browser-smoke.mjs"));
  assert.match(byId.get(278).status, /^Полностью подтверждено/);
  assert.match(byId.get(278).status, /--reference-dashboard-146-only[\s\S]*пяти уровней[\s\S]*без совпадений/);
  assert.match(byId.get(300).status, /^Полностью подтверждено/);
  assert.match(byId.get(300).status, /Было 4, стало 6 \(\+50\.0%\)/);
  assert.match(byId.get(282).status, /^Полностью подтверждено/);
  assert.match(byId.get(282).status, /Переговорных: 1 · MAC-адресов: 2/);
  assert.match(byId.get(287).status, /^Полностью подтверждено/);
  assert.match(byId.get(287).status, /Критические[\s\S]*severity critical[\s\S]*other/);
  assert.match(byId.get(298).status, /^Полностью подтверждено/);
  assert.match(byId.get(298).status, /10 событий, 7 добавлений, 1 отсутствие, 2 изменения и 1 критическое событие/);
  const browserSmoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(browserSmoke, /optional-host-workflows-only/);
  assert.match(browserSmoke, /optional-host-transfer-only/);
  assert.match(browserSmoke, /optional-diagnostics-only/);
  assert.match(browserSmoke, /Chart\?\.getChart\?\./);
  assert.match(browserSmoke, /weeklyTrend/);
  assert.match(browserSmoke, /MAC-адресов/);
  assert.match(browserSmoke, /changeCategories/);
  assert.match(browserSmoke, /severity-critical/);
  assert.match(browserSmoke, /No matching location/);
  assert.match(byId.get(128).status, /mac-analyzer-full-json` v2 после явного подтверждения потоково восстанавливается в отдельную IndexedDB базу/);
  assert.match(byId.get(128).status, /переключается на неё только после успешного импорта/);
  assert.match(byId.get(128).status, /предыдущая база остаётся нетронутой/);
  assert.match(byId.get(128).status, /^Полностью подтверждено:[\s\S]*browser import flows/);
  assert.match(byId.get(128).status, /MAC_ANALYZER_NEXT_ARCHIVE v1/);
  assert.match(byId.get(128).status, /`--archive-attachment-only`/);
  assert.match(byId.get(128).status, /portable `\.madb\.json` v1 сохранил совпадающие id\/taskId\/size и байты/);
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
  assert.deepEqual(wordingDifferences, [27, 140, 144, 309, 330, 398, 402, 405, 408]);
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
