import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PORTABLE_MODULES, PORTABLE_WORKER_MODULES } from "../scripts/build-config.js";

const builder = readFileSync("scripts/build-portable.mjs", "utf8");
const artifactCheck = readFileSync("scripts/check-portable-artifact.mjs", "utf8");
const archiveBuilder = readFileSync("scripts/build-release-archive.mjs", "utf8");
const archiveChecker = readFileSync("scripts/check-release-archive.mjs", "utf8");
const outputDirectory = readFileSync("scripts/output-directory.js", "utf8");

test("portable and release artifact paths can be isolated from an open default dist file", () => {
  assert.match(outputDirectory, /MAC_ANALYZER_DIST_DIR/);
  for (const source of [builder, artifactCheck, archiveBuilder, archiveChecker]) {
    assert.match(source, /getOutputDirectory/);
  }
});

test("model-prefix detail counts all Final appearances and wires its XLSX export", () => {
  const app = readFileSync("src/app.js", "utf8");
  const render = readFileSync("src/ui/render.js", "utf8");
  assert.match(app, /countMac5Occurrences/);
  assert.match(app, /const savedFinals = \(await database\.listSnapshots\(\)\)\.filter\(\(item\) => isFinalSnapshot\(item\) && !String\(item\.id\)\.startsWith\("legacy-sqlite-"\)\)/);
  assert.match(app, /database\.legacyObservationPage\(\{ kind: "mac_history", cursor, limit: 500 \}\)/);
  assert.match(app, /data-export-model-prefix-analytics-xlsx/);
  assert.match(app, /exportModelPrefixAnalyticsXlsx/);
  assert.match(render, /Количество вхождений/);
  assert.match(app, /occurrences: rule\.occurrences, firstSeen: rule\.firstSeen, lastSeen: rule\.lastSeen/);
});

test("static UI control IDs have direct or explicitly delegated runtime wiring", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(allIds).size, allIds.length, "static HTML IDs must be unique");
  const knownIds = new Set(allIds);
  for (const attribute of ["for", "aria-controls", "aria-labelledby"]) {
    const unresolved = [...html.matchAll(new RegExp(`\\b${attribute}="([^"]+)"`, "g"))]
      .flatMap((match) => match[1].split(/\s+/))
      .filter((id) => id && !knownIds.has(id));
    assert.deepEqual(unresolved, [], `${attribute} references must resolve to static elements`);
  }
  const buttonIds = [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map((match) => match[1]);
  const unlabelledButtons = [...html.matchAll(/<button\b([^>]*)>/g)].map((match) => match[1]).filter((attributes) => !/\bid=/.test(attributes));
  const inputIds = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((match) => match[1]);
  const formIds = [...html.matchAll(/<form[^>]*id="([^"]+)"/g)].map((match) => match[1]);
  const selectIds = [...html.matchAll(/<select[^>]*id="([^"]+)"/g)].map((match) => match[1]);
  const errorBanner = readFileSync("src/ui/error-banner.js", "utf8");
  const indirectlyWired = buttonIds.filter((id) => !app.includes(id));
  const indirectlyWiredInputs = inputIds.filter((id) => !app.includes(id));
  assert.deepEqual(indirectlyWired.sort(), [
    "dashboardSettingsCardsTab",
    "dashboardSettingsChartsTab",
    "dashboardSettingsGeneralTab",
    "exportFinalHtmlButton",
    "exportFinalJsonButton",
    "exportFinalTxtButton",
    "exportFinalYamlButton",
  ]);
  assert.ok(app.includes('$$("#analyticsDashboardSettingsDialog [role=\'tab\']")'));
  assert.ok(app.includes('dashboardSettingsTabs.forEach((tab, index) => tab.addEventListener("click"'));
  assert.ok(app.includes('for (const format of ["csv", "xlsx", "txt", "json", "yaml", "html"])'));
  assert.ok(app.includes('$(`#exportFinal${format[0].toUpperCase()}${format.slice(1)}Button`).addEventListener("click"'));
  assert.deepEqual(indirectlyWiredInputs.sort(), [
    "batchDdIoInput",
    "batchMainInput",
    "batchSmartroomInput",
    "compareFile0Input",
    "compareFile1Input",
    "ddioFileInput",
    "smartroomFileInput",
  ]);
  assert.ok(app.includes('for (const role of ["main", "smartroom", "ddio"]) $(`#${role}FileInput`).addEventListener("change"'));
  assert.ok(app.includes('for (const role of ["Main", "Smartroom", "DdIo"])'));
  assert.ok(app.includes('for (const position of [0, 1]) $(`#compareFile${position}Input`).addEventListener("change"'));
  for (const id of formIds) {
    assert.ok(app.includes(`$("#${id}").addEventListener("submit"`) || app.includes(`$("#${id}").onsubmit =`), `${id} must own a submit handler`);
  }
  assert.deepEqual(selectIds.filter((id) => !app.includes(id)), []);
  const indirectlyWiredSelects = selectIds.filter((id) => !app.includes(`$("#${id}").addEventListener("change"`));
  assert.deepEqual(indirectlyWiredSelects.sort(), [
    "analyticsDashboardManufacturer",
    "analyticsDashboardRoom",
    "analyticsDashboardStatus",
    "baseSnapshotSelect",
    "businessUnitFilter",
    "changeReportBaseSnapshotSelect",
    "changeReportCurrentSnapshotSelect",
    "cityFilter",
    "currentSnapshotSelect",
    "floorFilter",
    "roomFilter",
    "siteFilter",
  ]);
  assert.ok(app.includes('$("#applyAnalyticsDashboardFiltersButton").addEventListener("click"'));
  assert.ok(app.includes('$("#applyComparisonButton").addEventListener("click"'));
  assert.ok(app.includes('$("#applyChangeSnapshotButton").addEventListener("click"'));
  assert.ok(app.includes('["businessUnit", "city", "site", "floor", "room"].forEach((field) => $(`#${field === "businessUnit" ? "businessUnit" : field}Filter`).addEventListener("change"'));
  const delegatedButtonAttributes = [...new Set(unlabelledButtons.flatMap((attributes) => [...attributes.matchAll(/\b(data-[\w-]+)/g)].map((match) => match[1])))].sort();
  assert.deepEqual(unlabelledButtons.filter((attributes) => !/\btype="submit"/.test(attributes) && !/\bdata-[\w-]+/.test(attributes)), []);
  assert.deepEqual(delegatedButtonAttributes, [
    "data-dashboard-settings-close",
    "data-device-action",
    "data-dialog-close",
    "data-engineering-close",
    "data-error-dismiss",
    "data-mapping-review-close",
    "data-oui-formats-all",
    "data-oui-formats-none",
    "data-theme-choice",
    "data-theme-close",
    "data-view",
  ]);
  for (const attribute of delegatedButtonAttributes.filter((name) => name !== "data-view" && name !== "data-error-dismiss")) {
    assert.ok(app.includes(`[${attribute}]`), `${attribute} must have a delegated action`);
  }
  assert.ok(errorBanner.includes("[data-error-dismiss]"));
  assert.ok(app.includes('$$(".nav-button").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)))'));
  const unlabelledFields = [...html.matchAll(/<(input|select)\b([^>]*)>/g)].filter((match) => !/\bid=/.test(match[2]));
  const delegatedFieldAttributes = [...new Set(unlabelledFields.flatMap((match) => [...match[2].matchAll(/\b(data-[\w-]+)/g)].map((attribute) => attribute[1])))].sort();
  assert.deepEqual(delegatedFieldAttributes, ["data-dashboard-widget-setting", "data-enrichment-field", "data-oui-format"]);
  for (const attribute of delegatedFieldAttributes) assert.ok(app.includes(`[${attribute}]`), `${attribute} must have a field handler`);
  for (const field of unlabelledFields.filter((match) => !/\bdata-[\w-]+/.test(match[2]))) {
    if (/\bname="strategy"/.test(field[2])) {
      assert.ok(app.includes('document.addEventListener("change"') && app.includes('input[name="strategy"]'), "enrichment strategy radios must have a delegated change handler");
      continue;
    }
    const form = [...html.slice(0, field.index).matchAll(/<form\b[^>]*id="([^"]+)"[^>]*>/g)].at(-1);
    assert.ok(form && html.indexOf("</form>", form.index) > field.index, `${field[0]} must belong to a form`);
    const formId = form[1];
    assert.ok(app.includes(`$("#${formId}").addEventListener("submit"`) || app.includes(`$("#${formId}").onsubmit =`), `${formId} must handle its unlabelled fields`);
  }
});

test("portable HTML configuration includes every current runtime module", () => {
  assert.ok(PORTABLE_MODULES.includes("src/core/ieee-registry.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/ip-mapping.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/request-gate.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/analytics-lifecycle.js"));
  assert.ok(PORTABLE_MODULES.includes("src/ui/dashboard-export.js"));
  assert.ok(PORTABLE_MODULES.includes("src/ui/error-banner.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/analytics-history-worker-client.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/batch.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/daily-scheduler.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/snapshot-kind.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/data-quality.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/historical-mapping.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/room-history.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/history-enrichment.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/analytics-detail.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/pdf-export.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/dashboard-fleet.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/import-limits.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/single-file-analysis.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/file-comparison-export.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/stream-writer.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/multi-file-comparison.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/temporal-statistics.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/shortcuts.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/device-analytics.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/history-export.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/table-actions.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/diagnostics.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/theme.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/workspace-state.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/compact-final-analytics.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/inventory-columns.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/upload-history.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/legacy-pyqt-settings.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/enrichment-settings.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/oui-formats.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/source-mapping-preferences.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/auto-save.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/vendor-model-history.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/xlsx-export.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/inventory-export.js"));
  assert.ok(PORTABLE_MODULES.indexOf("src/data/importer.js") < PORTABLE_MODULES.indexOf("src/core/batch.js"));
  assert.equal(new Set(PORTABLE_MODULES).size, PORTABLE_MODULES.length);
  assert.ok(PORTABLE_WORKER_MODULES.includes("src/core/analytics-history-worker.js"));
  assert.ok(PORTABLE_WORKER_MODULES.includes("src/core/compact-final-analytics.js"));
  assert.ok(PORTABLE_WORKER_MODULES.includes("src/core/dashboard-filter.js"));
});

test("portable artifact verification checks static UI references and error overlay order", () => {
  assert.match(artifactCheck, /duplicate static element IDs/);
  assert.ok(artifactCheck.includes("unresolved ${attribute} references"));
  assert.match(artifactCheck, /zIndex\("error-banner"\) > zIndex\("progress-panel"\)/);
});

test("workspace resume autosaves bounded UI state to IndexedDB and restores it before navigation", () => {
  const app = readFileSync("src/app.js", "utf8");
  const workspaceState = readFileSync("src/core/workspace-state.js", "utf8");
  const bootstrap = app.slice(app.indexOf("async function bootstrap()"));
  assert.match(app, /database\.setSetting\("workspaceState", value\)/);
  assert.match(app, /captureWorkspaceState\(\{[\s\S]*?view: state\.workspaceView,[\s\S]*?sort: state\.sort,[\s\S]*?\}, options\.views/);
  assert.match(app, /await readWorkspaceState\(workspaceStateQueue, database\)/);
  assert.match(workspaceState, /readWorkspaceState\(queue, database\)[\s\S]*?queue\.enqueue\(\(\) => database\.getSetting\("workspaceState", null\)\)/);
  assert.match(app, /workspaceAutosaveTimer/);
  assert.match(bootstrap, /await initializeEngineeringMode\(\);\s*await restoreWorkspaceState\(\);/);
  assert.match(bootstrap, /allowedViews\.includes\(requestedView\) \? requestedView : state\.workspaceView/);
});

test("workspace checkpoint controls save, restore and delete only the checkpoint setting", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const workspaceState = readFileSync("src/core/workspace-state.js", "utf8");
  for (const id of ["saveWorkspaceStateButton", "restoreWorkspaceStateButton", "deleteWorkspaceStateButton", "workspaceStateStatus"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is available in the UI`);
  }
  assert.match(app, /#saveWorkspaceStateButton"\)\.addEventListener\("click"/);
  assert.match(app, /#restoreWorkspaceStateButton"\)\.addEventListener\("click"/);
  assert.match(app, /#deleteWorkspaceStateButton"\)\.addEventListener\("click"/);
  assert.match(app, /deleteWorkspaceStateSetting\(workspaceStateQueue, database\)/);
  assert.match(workspaceState, /deleteWorkspaceState\(queue, database\)[\s\S]*?queue\.enqueue\(\(\) => database\.deleteSetting\("workspaceState"\)\)/);
  assert.match(database, /async deleteSetting\(key\)[\s\S]*?objectStore\("settings"\)\.delete\(normalizedKey\)/);
});

test("temporal analytics uses disposable IndexedDB sets and cleans them after every request", () => {
  const app = readFileSync("src/app.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  const statistics = readFileSync("src/core/temporal-statistics.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(app, /clearExpiredAnalyticsAggregateQueries\("temporal:"\)/);
  assert.match(app, /macStore: database/);
  assert.match(app, /await accumulator\.observeChunk\(devices\)/);
  assert.match(app, /selectTemporalSnapshotWindow\(state\.snapshotMetadata, \{ rangeDays \}\)/);
  assert.match(html, /id="temporalRangeSelect"[\s\S]*?value="30"[\s\S]*?value="90"[\s\S]*?value="365"/);
  assert.match(statistics, /export function selectTemporalSnapshotWindow\(/);
  assert.match(app, /finally\s*\{\s*await accumulator\.cleanup\(\);\s*\}/);
  assert.match(statistics, /await this\.macStore\.addAnalyticsDistinctBatch\(this\.queryId, this\.current\.metric, macs, "ever"\)/);
  assert.match(statistics, /compareAnalyticsDistinctMetrics/);
  assert.match(statistics, /export function\* temporalStatisticsCsvChunks/);
  assert.match(app, /yield\* temporalStatisticsCsvChunks\(state\.temporalStatistics\)/);
  assert.match(app, /writeReadableStreamToWritable\(stream, await handle\.createWritable\(\)\)/);
  assert.doesNotMatch(app, /temporalStatisticsCsv\(state\.temporalStatistics\)/);
  assert.match(database, /async addAnalyticsDistinctBatch/);
  assert.match(database, /async clearExpiredAnalyticsAggregateQueries/);
  assert.match(database, /async compareAnalyticsDistinctMetrics/);
});

test("PyQt settings import stays local, bounded, atomic, and restores supported preferences", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(html, /id="importPyQtSettingsInput"[^>]*type="file"[^>]*accept="\.json,application\/json"/);
  assert.match(app, /file\.size > LEGACY_PYQT_SETTINGS_MAX_BYTES/);
  assert.match(app, /normalizeLegacyPyQtSettings\(raw\)/);
  assert.match(app, /await database\.setSettings\(records\)/);
  assert.match(database, /async setSettings\(records = \[\]\)[\s\S]*?transaction\("settings", "readwrite", \{ durability: "strict" \}\)/);
  assert.match(app, /getSetting\("enrichmentStrategy", "NO_EXPANSION"\)/);
  assert.match(app, /getSetting\("enrichmentFieldSettings", DEFAULT_ENRICHMENT_FIELD_SETTINGS\)/);
  assert.match(app, /database\.setSetting\("enrichmentFieldSettings", settings\)/);
  assert.match(html, /data-enrichment-field="switch_port"/);
  assert.match(html, /data-oui-format="6"/);
  assert.match(app, /database\.setSetting\("ouiFormats", settings\)/);
  assert.match(app, /resolveThemeChoice\(databaseTheme, localTheme/);
});

test("data-directory archive restores before Final recovery without deleting browser state", () => {
  const app = readFileSync("src/app.js", "utf8");
  const bootstrap = app.slice(app.indexOf("async function bootstrap()"));
  const restore = app.slice(app.indexOf("async function restoreDataDirectoryArchive()"), app.indexOf("\nasync function synchronizeDataDirectoryArchiveOnce()"));
  const databaseOpen = bootstrap.indexOf("await database.open()");
  const restoreCall = bootstrap.indexOf("await restoreDataDirectoryArchive()");
  const finalRecovery = bootstrap.indexOf("const finalRecovery = await database.recoverActiveSnapshot()");
  assert.ok(databaseOpen >= 0 && databaseOpen < restoreCall, "open IndexedDB before checking the retained directory handle");
  assert.ok(restoreCall < finalRecovery, "restore additive archive records before active Final recovery");
  assert.match(restore, /state\.dataDirectoryHandle = await database\.dataDirectoryHandle\(\)/);
  assert.match(restore, /state\.dataDirectoryPermission = await queryDirectoryPermission\(state\.dataDirectoryHandle\)/);
  assert.ok(restore.indexOf("if (state.dataDirectoryPermission !== \"granted\") return false") < restore.indexOf("getDirectoryArchiveFile(state.dataDirectoryHandle)"));
  assert.match(restore, /await importPortableArchiveFile\(file\)/);
  assert.match(restore, /Автовосстановление не выполнено; файл не перезаписан/);
  assert.doesNotMatch(restore, /clearFinalHistory|deleteSnapshot|deleteDatabase/);
});

test("directory archive sync serializes writes and retries when IndexedDB changes mid-write", () => {
  const app = readFileSync("src/app.js", "utf8");
  const once = app.slice(app.indexOf("async function synchronizeDataDirectoryArchiveOnce()"), app.indexOf("\nfunction synchronizeDataDirectoryArchive()"));
  assert.match(app, /runCoalescedTask\(state, synchronizeDataDirectoryArchiveOnce,\s*\{\s*runningKey: "dataDirectorySyncing",\s*pendingKey: "dataDirectorySyncRequested"/);
  assert.match(once, /await writeDirectoryArchive\(handle, database\.exportArchiveStream\(\)\)/);
  assert.match(once, /if \(handle !== state\.dataDirectoryHandle\)\s*\{\s*state\.dataDirectorySyncRequested = true;/);
  assert.match(once, /state\.dataDirectoryWriteFailed = true/);
  assert.match(once, /Final сохранён в IndexedDB/);
});

test("portable app schedules streaming Final XLSX autosaves only through the granted local folder", () => {
  const app = readFileSync("src/app.js", "utf8");
  const lifecycle = readFileSync("src/core/page-lifecycle.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /id="autoSaveStatus"/);
  assert.match(app, /setInterval\(\(\) => \{ void autoSaveActiveFinal\(\); \}, AUTO_SAVE_INTERVAL_MS\)/);
  assert.match(app, /state\.dataDirectoryPermission = await queryDirectoryPermission\(handle\)/);
  assert.match(app, /writeDirectoryFile\(handle, fileName, createXlsxWorkbookStream\(sheets\)\)/);
  assert.match(app, /const columns = inventoryOutputColumns\(\)/);
  assert.match(app, /createSnapshotXlsxSheets\(database, state\.activeSnapshot, columns\)/);
  assert.match(app, /Final остаётся в IndexedDB/);
  const autoSave = app.slice(app.indexOf("async function autoSaveActiveFinal()"), app.indexOf("\nfunction startFinalAutoSave()"));
  assert.match(autoSave, /if \(state\.dataDirectoryWriteFailed\)[\s\S]*?Автосохранение приостановлено/);
  assert.match(autoSave, /state\.dataDirectoryWriteFailed = true;[\s\S]*?await refreshDataDirectoryControls\(\);/);
  assert.match(lifecycle, /for \(const timer of intervalTimers\) if \(timer\) clearInterval\(timer\)/);
});

test("manual Final XLSX exports use the same configured columns as autosave", () => {
  const app = readFileSync("src/app.js", "utf8");
  const exportFinal = app.slice(app.indexOf("function exportActiveFinal(format)"), app.indexOf("\nasync function exportTopologyHtml()"));
  assert.match(exportFinal, /const columns = format === "xlsx"\s*\? inventoryOutputColumns\(\)/);
  assert.match(exportFinal, /createSnapshotXlsxSheets\(database, snapshot, columns\)/);
});

test("closing the app cancels active work and stops browser-owned background schedules", () => {
  const app = readFileSync("src/app.js", "utf8");
  const cleanup = app.slice(app.indexOf("function handleAppPageHide("), app.indexOf("\nfunction progress("));
  assert.match(app, /globalThis\.addEventListener\("pagehide", handleAppPageHide\)/);
  assert.match(app, /import \{ cleanupPageHide \} from "\.\/core\/page-lifecycle\.js"/);
  assert.match(cleanup, /cleanupPageHide\(event,\s*\{/);
  assert.match(cleanup, /abortActive: cancelActiveProcess/);
  assert.match(cleanup, /invalidatePending: \(\) => state\.analyticsRequests\.invalidate\(\)/);
  assert.match(cleanup, /intervalTimers: \[state\.autoSaveTimer, state\.analyticsAutoRefreshTimer, state\.engineeringSessionTimer, state\.workspaceAutosaveTimer\]/);
  assert.match(cleanup, /stopScheduledBatch\(/);
  assert.match(cleanup, /legacyTaskSchedulers\.values\(\)/);
  assert.match(cleanup, /legacyTaskSchedulers\.clear\(\)/);
});

test("imported PyQt autosaves expose only a validated Final recovery action", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const sqlite = readFileSync("src/data/sqlite-database-importer.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(html, /id="legacyAutosaveRestoreList"/);
  assert.match(sqlite, /SELECT "slot", "state_json" FROM "app_autosaves"/);
  assert.match(sqlite, /legacySnapshotReferences\.has\(String\(row\.id\)\.slice\(0, 200\)\)\) legacySnapshotIds\.set/);
  assert.match(sqlite, /legacyAutosaveSnapshotId\(row\.state_json, legacySnapshotIds\)/);
  assert.match(app, /data-activate-legacy-autosave/);
  assert.match(app, /data-restore-legacy-autosave-settings/);
  assert.match(app, /database\.activateSnapshot\(snapshot\.id\)/);
  assert.match(app, /normalizeLegacyAutosaveSettings\(JSON\.parse\(rawState\)\)/);
  assert.match(app, /database\.legacyAutosaveState\(key, \{ maxBytes: LEGACY_PYQT_SETTINGS_MAX_BYTES \}\)/);
  assert.match(app, /settings\.ipAddressMappings, \.\.\.existingMappings/);
  assert.match(app, /applyAnalyticsDashboardSettings\(settings\.analyticsDashboardSettings\)/);
  assert.match(app, /Текущие снимки и история сохранятся/);
  assert.match(app, /Исходные файлы и незавершённые строки старого рабочего пространства не восстанавливаются/);
  assert.match(database, /async legacyAutosavePage\(/);
  assert.match(database, /async legacyAutosaveState\(key/);
  assert.match(database, /async activateSnapshot\(snapshotId\)/);
});

test("global shortcut dispatch allows public help outside engineer mode", () => {
  const app = readFileSync("src/app.js", "utf8");
  const shortcuts = readFileSync("src/core/shortcuts.js", "utf8");
  assert.match(app, /isShortcutAllowedWithoutEngineer\(shortcut\)/);
  assert.match(shortcuts, /USER_MODE_SHORTCUTS\s*=\s*new Set\(\[[^\]]*"f1"/);
});

test("Ctrl+S selects Final XLSX or portable backup and Ctrl+E opens export choices", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /state\.snapshotMetadata\.length\s*\?\s*"#exportFinalXlsxButton"\s*:\s*"#exportDatabaseButton"/);
  assert.match(app, /const menu = \$\("#exportFinalCsvButton"\)\.closest\("details\.export-menu"\)/);
  assert.match(app, /menu\.open = true;\s*menu\.querySelector\("summary"\)\.focus\(\)/);
});

test("Ctrl+F selects the existing global search query for immediate replacement", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /"ctrl\+f":\s*\(\)\s*=>\s*\{\s*activateView\("search"\);\s*\$\("#globalSearch"\)\.focus\(\);\s*\$\("#globalSearch"\)\.select\(\);\s*\}/);
});

test("Ctrl+Shift+C opens the engineer-only Inventory column manager", () => {
  const app = readFileSync("src/app.js", "utf8");
  const shortcuts = readFileSync("src/core/shortcuts.js", "utf8");
  assert.match(shortcuts, /event\.shiftKey\) return key === "c" \? "ctrl\+shift\+c"/);
  assert.match(app, /"ctrl\+shift\+c":\s*\(\)\s*=>\s*\{\s*activateView\("search"\);\s*const panel = \$\("#inventoryColumnManagerPanel"\);\s*panel\.open = true;/);
  assert.match(app, /if \(!isEngineerActive\(\) && !isShortcutAllowedWithoutEngineer\(shortcut\)\) return/);
});

test("legacy XLS is selectable across data screens and uses the local bounded parser", () => {
  const html = readFileSync("index.html", "utf8");
  const importer = readFileSync("src/data/importer.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const batch = readFileSync("src/core/batch.js", "utf8");
  const build = readFileSync("scripts/build-portable.mjs", "utf8");
  const limits = readFileSync("src/core/import-limits.js", "utf8");
  for (const id of ["singleFileInput", "compareFile0Input", "compareFile1Input", "multiCompareFilesInput", "mainFileInput", "smartroomFileInput", "ddioFileInput", "batchMainInput", "batchSmartroomInput", "batchDdIoInput", "ouiFileInput", "importIpMappingsInput"]) {
    const field = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(field?.includes(".xls"), `${id} must expose legacy XLS files`);
  }
  assert.match(batch, /xlsx\|xlsm\|xls/);
  assert.match(app, /json\|xlsx\|xlsm\|xls/);
  assert.match(app, /if \(!isStreamableTableFile\(file\)\) throw new Error/);
  assert.match(app, /state\.batch\[key\] = \[\.\.\.event\.target\.files\]\.filter\(isStreamableTableFile\)/);
  assert.match(importer, /legacyXlsRowBatches\(file/);
  assert.match(importer, /library\.read\(bytes/);
  assert.match(importer, /IMPORT_LIMITS\.legacyXlsFileBytes/);
  assert.match(limits, /legacyXlsFileBytes: 16 \* 1024 \* 1024/);
  assert.match(html, /vendor\/xlsx\.full\.min\.js/);
  assert.match(build, /vendor\/xlsx\.full\.min\.js/);
  assert.match(build, /SheetJS\.LICENSE\.md/);
  assert.doesNotMatch(importer, /Старый XLS не поддерживается/);
});

test("merge view can queue its currently selected Main, SmartRoom and DDIO files", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const batchStart = html.indexOf('<section class="view" id="batchView"');
  const dataStart = html.indexOf('<section class="view" id="dataView"');
  assert.ok(batchStart >= 0 && dataStart > batchStart);
  assert.ok(html.slice(batchStart, dataStart).includes('id="legacyTaskCreateForm"'), "file schedule creation belongs to the automation view");
  assert.ok(!html.slice(dataStart).includes('id="legacyTaskCreateForm"'), "the schedule form must not be buried in imported history");
  assert.match(html, /id="queueCurrentSourceFilesButton"[^>]*>Поставить текущие файлы в очередь/);
  assert.match(app, /\$\("#queueCurrentSourceFilesButton"\)\.addEventListener\("click", \(\) => queueCurrentSourceFiles\(\)\.catch\(showError\)\)/);
  assert.match(app, /\["main", "smartroom", "ddio"\]\.map\(\(role\) => state\.sourceFiles\[role\]\)\.filter\(Boolean\)/);
  assert.match(app, /legacyObservationSearchPage\(\{ kind: "scheduled_tasks" \}, \{ limit: 1 \}\)/);
  assert.match(app, /database\.appendLegacyTaskQueueFiles\(task\.id, files\)/);
  assert.match(database, /async appendLegacyTaskQueueFiles\(taskRecordId, files = \[\]\)/);
});

test("browser smoke waits for DevTools and enters the disposable engineer UI before lazy imports", () => {
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /getJsonEventually\(`http:\/\/127\.0\.0\.1:\$\{port\}\/json\/list`\)/);
  assert.match(smoke, /for \(let attempt = 0; attempt < 50; attempt \+= 1\)[\s\S]*?target = targets\.find/);
  assert.match(smoke, /new URL\(item\.url\)\.searchParams\.get\("db"\) === requestedSmokeUrl\.searchParams\.get\("db"\)/);
  assert.match(smoke, /json\/new\?\$\{encodeURIComponent\(smokeUrl\.href\)\}/);
  assert.match(smoke, /mac-analyzer-pro-next-test-\$\{crypto\.randomUUID\(\)\}/);
  assert.match(smoke, /document\.querySelector\('#engineeringModeButton'\)\.click\(\)/);
  assert.match(smoke, /document\.querySelector\('#engineeringModeForm'\)\.requestSubmit\(\)/);
  assert.match(smoke, /document\.querySelector\('\[data-view="enrichment"\]'\)\?\.click\(\)/);
  assert.match(smoke, /process\.argv\.includes\("--roster-only"\)/);
  assert.match(smoke, /--roster-size=/);
  assert.match(smoke, /Math\.min\(5_000, Math\.max\(101, requestedRosterSize\)\)/);
  assert.match(smoke, /secondPageEnd/);
  assert.match(smoke, /#exportAnalyticsHtmlButton/);
  assert.match(smoke, /#exportAnalyticsPngButton/);
  assert.match(smoke, /#exportAnalyticsXlsxButton/);
  assert.match(smoke, /async function openDashboardAggregateKpi\(key, title\)[\s\S]*?data-dashboard-aggregate-filter/);
  assert.match(smoke, /openDashboardAggregateKpi\("manufacturers", "Производители выбранного Final"\)/);
  assert.match(smoke, /openDashboardAggregateKpi\("rooms", "Помещения выбранного Final"\)/);
  assert.match(smoke, /137,80,78,71,13,10,26,10/);
  assert.match(smoke, /80,75,3,4/);
  assert.match(smoke, /window\.confirm=\(message\)=>/);
  assert.match(smoke, /data-mapping-field="room"/);
  assert.match(smoke, /command\("Page\.reload", \{ ignoreCache: true \}\)/);
  assert.match(smoke, /#legacyTaskCreateForm/);
  assert.match(smoke, /#queueCurrentSourceFilesButton/);
  assert.match(smoke, /missingSmartroomIdRow\?\.\[10\] !== "—"/);
  assert.match(smoke, /#singleFileInput/);
  assert.match(smoke, /#runSingleAnalysisButton/);
  assert.match(smoke, /singleAnalysisHistoryRows/);
  assert.match(smoke, /singleFileNotice\.includes\("активный Final не переключается"\)/);
  assert.match(smoke, /compare_before\.csv/);
  assert.match(smoke, /file-comparison\.xlsx/);
  assert.match(smoke, /multiComparePairSelect/);
  assert.match(smoke, /six directed comparisons|шесть направленных пар/);
  assert.match(smoke, /data-multi-position=\\?"2\\?"/);
  assert.match(smoke, /data-run-legacy-task/);
  assert.match(smoke, /очередь: 0 ждёт \/ 3 готово \/ 0 ошибок/);
  assert.match(smoke, /задача выполнена: 3 файлов, успешно 3, ошибок 0/);
  assert.match(smoke, /record\.payload\.intervalMinutes=1;record\.payload\.nextRunAt=new Date\(Date\.now\(\)\+2000\)/);
  assert.match(smoke, /timedQueueCompleted/);
  assert.match(smoke, /mode\.value='same-date'/);
  assert.match(smoke, /tolerance\.value='0'/);
  assert.match(smoke, /reassignResult\.moved/);
  assert.match(smoke, /reassignDdIoResult\.moved/);
  assert.match(smoke, /data-kpi="switchAnomalyRooms"/);
  assert.match(smoke, /data-room-anomaly-page/);
  assert.match(smoke, /data-batch-pair-enabled="1"/);
  assert.match(smoke, /DevTools command timed out/);
});

test("autonomous enrichment rechecks heap reserve during streamed stages and lookup batches", () => {
  const enrichment = readFileSync("src/core/enrichment.js", "utf8");
  const ddio = readFileSync("src/core/ddio-overlay.js", "utf8");
  const limits = readFileSync("src/core/import-limits.js", "utf8");
  assert.match(limits, /export function assertBrowserHeapReserve/);
  assert.ok(enrichment.includes("rowIndex % 500 === 0) assertBrowserHeapReserve();"));
  assert.ok(/const lookup = await loadLookup\(macs\);\s*assertBrowserHeapReserve\(\)/.test(enrichment));
  assert.ok(ddio.includes("rowCount % 500 === 0) assertBrowserHeapReserve();"));
});

test("Main and SmartRoom release transient identity tokens after their last merge lookup", () => {
  const enrichment = readFileSync("src/core/enrichment.js", "utf8");
  const main = enrichment.slice(enrichment.indexOf("async function createMainDevices("), enrichment.indexOf("async function enrichSmartroom("));
  const smartroom = enrichment.slice(enrichment.indexOf("async function enrichSmartroom("), enrichment.indexOf("function applyOuiKnowledge("));
  assert.ok(main.replaceAll("\r\n", "\n").includes("index.tokens.clear();\n  return { devices, rowCount: rowIndex };"));
  assert.ok(smartroom.replaceAll("\r\n", "\n").includes("index.tokens.clear();\n  return rowIndex;"));
});

test("autonomous enrichment checks available heap before hashing sources and XLSX inflation", () => {
  const app = readFileSync("src/app.js", "utf8");
  const limits = readFileSync("src/core/import-limits.js", "utf8");
  assert.match(app, /const totalSourceBytes = entries\.reduce\([\s\S]*?assertBrowserHeapCapacity\(totalSourceBytes \* 2\)/);
  assert.ok(app.indexOf("assertBrowserHeapCapacity(totalSourceBytes * 2)") < app.indexOf("const results = await Promise.allSettled(entries.map"));
  assert.match(limits, /assertBrowserHeapCapacity\(expandedBytes \* 2, memoryInfo\)/);
  assert.match(limits, /const safeAvailableBytes = Math\.max\(0, availableBytes - reserveBytes\)/);
});

test("source mapping review uses a local draft dialog and validates before applying", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const batch = readFileSync("src/core/batch.js", "utf8");
  const enrichment = readFileSync("src/core/enrichment.js", "utf8");
  const css = readFileSync("styles.css", "utf8");
  assert.match(html, /id="mappingReviewDialog"[^>]*aria-labelledby="mappingReviewTitle"/);
  for (const id of ["mappingReviewSummary", "mappingReviewContent", "mappingReviewValidation", "mappingReviewRecommendations", "mappingReviewClear", "mappingReviewApply"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /data-open-mapping-review="\$\{role\}"/);
  assert.match(html, /Выбрать рекомендации/);
  assert.match(app, /report\.details\[field\].*conflict/s);
  assert.match(app, /const recommendedIndex = detail\?\.recommendedIndex/);
  assert.match(app, /detail\?\.alternatives\?\.find\(\(item\) => item\.index === recommendedIndex\)/);
  assert.match(app, /Number\(draft\[field\]\) === index/);
  assert.match(app, /const supportsCustomFields = !isSingle && \["main", "smartroom", "ddio"\]\.includes\(role\)/);
  assert.match(app, /data-mapping-add-custom/);
  assert.match(app, /data-add-source-custom-field/);
  assert.match(app, /createCustomSourceFieldMapping\(/);
  assert.match(app, /customColumns\.map\(\(\{ key \}\) => key\)/);
  assert.match(enrichment, /customFields\[field\] = normalized/);
  assert.match(enrichment, /target\.customFields\[key\] = value/);
  assert.match(app, /кандидат, не назначен/);
  assert.match(app, /const updateValidation = \(\) => \{\s*const problems = isSingle\s*\?/);
  assert.match(app, /batchMappingProblems\(role, draft/);
  assert.match(app, /<small class="mapping-reason">Причина:/);
  assert.match(app, /\$\("#mappingReviewForm"\)\.onsubmit = \(event\) =>/);
  assert.match(app, /state\.mappings\[role\] = \{ \.\.\.draft \};/);
  assert.match(app, /renderMapping\(role\);/);
  assert.match(app, /Ручной выбор запоминается для этой схемы заголовков/);
  assert.match(app, /dialog\.close\(\);/);
  assert.match(batch, /STRONG_FIELDS\.main\.some/);
  assert.match(batch, /reservationMac\).*reservationIp/);
  assert.match(batch, /new Set\(selected\)\.size !== selected\.length/);
  assert.match(css, /\.mapping-review-table/);
  assert.match(css, /\.mapping-validation\.error/);
});

test("manual source column mappings persist locally and restore only for matching headers", () => {
  const app = readFileSync("src/app.js", "utf8");
  const preferences = readFileSync("src/core/source-mapping-preferences.js", "utf8");
  assert.match(app, /database\.getSetting\("sourceMappingPreferences", \{\}\)/);
  assert.match(app, /restoreSourceMapping\(table\.headers, state\.sourceMappingPreferences\[role\], detected\)/);
  assert.match(app, /database\.setSetting\("sourceMappingPreferences", state\.sourceMappingPreferences\)/);
  assert.match(app, /persistSourceMappingPreference\(role\)\.catch\(showError\)/);
  assert.match(preferences, /preference\.headers\.length === normalized\.length/);
  assert.match(preferences, /MAX_SOURCE_MAPPING_PREFERENCES_PER_ROLE = 8/);
});

test("single-file analysis exposes the same review and apply flow as source imports", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const detector = readFileSync("src/data/importer.js", "utf8");
  const single = readFileSync("src/core/single-file-analysis.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(app, /data-open-single-mapping-review/);
  assert.match(app, /openMappingReview\("single"\)/);
  assert.match(app, /const isSingle = role === "single"/);
  assert.match(app, /state\.singleFile\.mapping = \{ \.\.\.draft \}/);
  assert.match(app, /state\.singleFile\.mappingReviewed = true/);
  assert.match(app, /hasSingleFileMappingConflicts\(report\) && !state\.singleFile\.mappingReviewed/);
  assert.match(app, /Перед анализом откройте проверку вариантов и примените сопоставление/);
  assert.match(app, /async function enrichStandaloneDevices\(devices, signal\)/);
  assert.match(app, /const enriched = await enrichStandaloneDevices\(result\.devices, controller\.signal\)/);
  assert.match(app, /Object\.assign\(result\.summary, countSingleFileDeviceFields\(result\.devices\)\)/);
  assert.doesNotMatch(app, /result\.summary\.with(?:Manufacturer|Model|Address|Room|SwitchIp) = result\.devices\.filter/);
  const legacyAnalysis = app.match(/async function analyzeLegacyTaskFile\(file\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(legacyAnalysis, /Object\.assign\(result\.summary, countSingleFileDeviceFields\(result\.devices\)\)/);
  assert.doesNotMatch(legacyAnalysis, /result\.devices\.filter\(\(device\) => text\(device\[field\]\)\)/);
  assert.match(app, /readableTextStreamFromIterable\(singleFileDevicesCsvChunks\(result\.devices\)\)/);
  assert.match(app, /writeReadableStreamToWritable\([\s\S]*?singleFileDevicesCsvChunks\(result\.devices\)/);
  assert.doesNotMatch(app, /singleFileDevicesCsv\(state\.singleFile\.result\.devices\)/);
  assert.match(app, /async function compareInventoryObservationFromDatabase\(devices, timestamp\)[\s\S]*?database\.inventoryCandidatesForDevices\(devices,\s*\{\s*batchSize: 250,[\s\S]*?onPage: \(candidates\) => comparator\.acceptCandidates\(candidates\)/);
  assert.match(app, /const comparison = await compareInventoryObservationFromDatabase\(result\.devices, createdAt\)/);
  assert.match(app, /const finalSnapshot = await database\.saveFinal\(/);
  assert.match(app, /activate: false,\s*updateInventory: true/);
  assert.match(app, /finalSnapshotId: finalSnapshot\.id/);
  assert.match(html, /Анализ сохраняется в отдельной истории и снимке; активный Final не переключается, а найденные устройства обновляют Inventory/);
  assert.doesNotMatch(html, /Этот анализ не создаёт Final и не меняет базу/);
  assert.match(app, /Выберите внутренний ID, Device ID, серийный номер или MAC/);
  assert.match(detector, /role === "single"/);
  assert.match(single, /detectMapping\(headers, rows, "single"\)/);
  assert.match(single, /MAX_DIAGNOSTIC_SAMPLES = 1_000/);
  assert.match(single, /invalid: diagnostics\.invalidTotal/);
  assert.match(database, /invalid: Number\(diagnostics\.invalidTotal \?\? diagnostics\.invalid\?\.length/);
  assert.match(database, /invalidTruncated: Math\.max\(0, Number\(metadata\.diagnosticCounts\.invalid/);
});

test("Main and SmartRoom mapping controls include every non-DDIO device attribute", () => {
  const app = readFileSync("src/app.js", "utf8");
  const importer = readFileSync("src/data/importer.js", "utf8");
  assert.match(app, /main: \["id", "deviceId", "serial", "mac", "mac2"[\s\S]*"manufacturer", "model", "deviceType", "deviceName", "smartroomId", "businessUnit", "city", "site", "floor", "room", "address", "physicalAddress", "locationPath"\]/);
  assert.match(app, /smartroom: \["id", "deviceId", "serial", "mac", "mac2"[\s\S]*"switchPort"[\s\S]*"locationPath"\]/);
  assert.match(importer, /const allowed = role === "ddio"[\s\S]*Object\.keys\(FIELD_LABELS\)\.filter\(\(field\) => !field\.startsWith\("reservation"\) && !field\.startsWith\("lease"\)\)/);
});

test("analytics refresh retains a complete in-memory dashboard until its replacement succeeds", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /const fallbackAnalytics = usableAnalyticsFallback\(state\.analytics\)/);
  assert.match(app, /analytics\.fallbackAnalytics = fallbackAnalytics/);
  assert.match(app, /showAnalyticsFallback\(error, analytics\.fallbackAnalytics\)/);
  assert.match(app, /Обновление не удалось\. Показан последний успешно рассчитанный полный Dashboard/);
  assert.match(app, /refreshAnalyticsButton.*renderAnalytics\(true\)\.catch\(\(error\) => showAnalyticsFallback\(error, state\.analytics\)\)/);
  assert.ok(app.includes('$("#applyComparisonButton").addEventListener("click"'));
  assert.ok(app.includes('comparisonMode: "snapshots"'));
  assert.ok(app.includes('$("#applyDashboardPeriodButton").addEventListener("click"'));
  assert.ok(app.includes('comparisonMode: "period"'));
  assert.ok(app.includes('resolveDashboardSnapshotPair(metadata,'));
});

test("full check dynamically runs every Node test file in the tests directory", () => {
  const runner = readFileSync("scripts/check.mjs", "utf8");
  assert.match(runner, /readdirSync\("tests"\)\.filter\(\(name\) => name\.endsWith\("\.test\.js"\)\)/);
  assert.match(runner, /\["--test", \.\.\.readdirSync\("tests"\)/);
});

test("removed alert feature stays absent from the browser UI, coordinator, and IndexedDB surface", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  for (const source of [html, app, database]) assert.doesNotMatch(source, /notification|оповещени[яйе]|уведомлени[яйе]/i);
});

test("the application opens one shared current IndexedDB version without a legacy v4 fallback", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const diagnostics = readFileSync("src/core/diagnostics.js", "utf8");
  assert.match(database, /const DB_VERSION = 28;/);
  assert.match(database, /createIndex\("by_identity_lookup", "identityLookupKeys", \{ unique: false, multiEntry: true \}\)/);
  assert.match(database, /indexedDB\.open\(this\.name, DB_VERSION\)/);
  assert.equal((database.match(/indexedDB\.open\(/g) || []).length, 1);
  assert.match(app, /import \{ database \} from "\.\/data\/database\.js"/);
  assert.match(diagnostics, /runBrowserDiagnostics\(\{ database,/);
  assert.doesNotMatch(app, /indexedDB\.open\([^,]+,\s*4\)/);
});

test("MAC chronology uses the migrated compound history index and preserves alternate-MAC events", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(database, /createIndex\("by_mac_timestamp", \["macKey", "timestamp"\]/);
  assert.match(database, /async forEachMacHistoryPage\(mac/);
  assert.match(database, /forEachMacHistoryPage\(mac/);
  assert.match(database, /index\("by_alternate_mac"\)/);
  assert.match(database, /macKey: normalizeMac\(item\.mac\)/);
  assert.match(app, /database\.forEachMacHistoryPage\(mac/);
});

test("imported legacy history has a searchable UI bound to the indexed database APIs", () => {
  const html = readFileSync("index.html", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(html, /id="legacyObservationFilters"/);
  assert.match(html, /id="legacyObservationResults"/);
  assert.match(html, /id="deleteLegacyObservationsButton"/);
  assert.match(html, /id="deleteFilteredLegacyObservationsButton"/);
  assert.match(html, /id="showImportedApiCacheButton"/);
  assert.match(html, /Включённые расписания с доступными файлами очереди автоматически восстанавливаются/);
  assert.match(html, /<option value="scheduled_tasks">Scheduled tasks<\/option>/);
  assert.match(html, /<option value="task_file_queue">Task file queue<\/option>/);
  assert.match(html, /<option value="daily_stats">Daily statistics<\/option>/);
  assert.match(html, /id="refreshLegacyDailyStatisticsButton"/);
  assert.match(html, /id="legacyDailyStatisticsChart"/);
  assert.match(app, /database\.legacyObservationPage\(\{ kind: "daily_stats", cursor, limit: 100 \}\)/);
  assert.match(app, /createLegacyDailyStatisticsAccumulator\(\{ fromDate: from, throughDate: through \}\)/);
  assert.match(app, /accumulator\.add\(row\)/);
  assert.match(app, /const rows = accumulator\.finish\(\)/);
  assert.doesNotMatch(app.match(/async function renderImportedDailyStatistics\(\) \{([\s\S]*?)\n\}/)?.[1] || "", /observations\.push/);
  assert.match(app, /drawLegacyDailyStatistics\(canvas, rows\)/);
  assert.match(database, /"daily_stats"/);
  const renderer = readFileSync("src/ui/render.js", "utf8");
  const queue = readFileSync("src/core/legacy-task-queue.js", "utf8");
  assert.match(database, /legacyObservationSearchPage\(filters = \{\}/);
  assert.match(database, /deleteLegacyObservations\(ids = \[\]\)/);
  assert.match(database, /deleteLegacyObservationsByFilters\(filters = \{\}\)/);
  assert.match(database, /uniqueMacs: 0, vendors: 0, models: 0, rooms: 0, sources: 0/);
  assert.match(database, /createIndex\("by_observed_id", \["observedAt", "id"\]/);
  assert.match(app, /database\.legacyObservationSearchPage\(filters, \{ cursor, limit: 100 \}\)/);
  assert.match(app, /form\.elements\.namedItem\("source"\)\.value = "SQLite API cache"/);
  assert.match(app, /showImportedApiCacheButton.*showImportedApiCache\(\)\.catch\(showError\)/);
  assert.match(app, /loadPage: \(taskId, options\) => database\.legacyTaskQueuePage\(taskId, options\)/);
  assert.match(app, /analyzeLegacyTaskFile\(file\)/);
  assert.match(app, /createFinalHistoryComparisonStream\(previousDevices, createdAt, \{ previousIdentityIndex \}\)/);
  assert.match(app, /const comparisonStream = \{\s*process: \(currentBatch, visit\) => historyComparator\.process\(currentBatch, visit\),\s*finish: \(visit\) => \{[\s\S]*?historyComparator\.finish\(visit\)[\s\S]*?releaseComparisonBaseline\(\)/);
  assert.match(app, /runLegacyTaskQueue\(String\(task\.payload\.id \|\| id\)/);
  assert.match(app, /updateLegacyScheduledTaskRun\(id, lastRunAt, nextRunAt\)/);
  assert.match(app, /readLegacyTaskQueueFileFromSQLite\(source, queued/);
  assert.match(app, /legacySqliteSourceForTask\(taskId\)/);
  assert.match(database, /legacySqliteSourceForTask\(taskId\)/);
  assert.match(app, /sqliteSource && item\.payload\?\.contentRetainedInSourceDatabase/);
  assert.match(app, /await restoreLegacyTaskSchedulers\(\)/);
  assert.match(app, /const firstRunAt = Number\.isFinite\(parsedNext\) \? new Date\(parsedNext\) : new Date\(\)/);
  assert.match(app, /активных legacy-расписаний: \$\{restored\} \(работают, пока страница открыта\)/);
  assert.match(app, /updateItem: \(itemId, patch\) => database\.updateLegacyTaskQueueFile\(itemId, patch\)/);
  assert.match(queue, /status: "done"/);
  assert.match(renderer, /data-run-legacy-task=/);
});

test("saving a new Final counts unchanged devices without retaining pairwise row copies", () => {
  const app = readFileSync("src/app.js", "utf8");
  const comparison = readFileSync("src/core/comparison.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(app, /const previousDevices = previous\?\.devices \|\| \[\];\s*const previousIdentityIndex = buildIdentityIndex\(previousDevices\)/);
  assert.match(app, /previousFinal: previousDevices,\s*previousIdentityIndex,/);
  assert.match(app, /previousIdentityIndex,\s*trimConsumedPreviousFinal: true,/);
  assert.match(app, /finalHistoryComparisonDetails\(result\.diagnostics\.historyComparison\)/);
  const executeEnrichment = app.slice(app.indexOf("async function executeEnrichment("), app.indexOf("\nfunction recordOperationDuration", app.indexOf("async function executeEnrichment(")));
  const resultReady = executeEnrichment.indexOf("const result = await enrich(");
  const comparisonBuild = executeEnrichment.indexOf("const comparisonStream =");
  assert.ok(resultReady >= 0 && resultReady < comparisonBuild, "compact the detached Previous Final during enrichment before comparison/save");
  assert.ok(readFileSync("src/core/enrichment.js", "utf8").includes("if (previousUseCounts) for (const device of previousFinal) trimComparisonDeviceInPlace(device);"));
  assert.ok(readFileSync("src/core/enrichment.js", "utf8").includes("if (ownsPreviousIndex) previousIndex.tokens.clear();"), "release only internally built Previous Final tokens");
  assert.match(executeEnrichment, /createFinalHistoryComparisonStream\(previousDevices, createdAt, \{ previousIdentityIndex \}\)/);
  const finalSave = executeEnrichment.indexOf("await database.saveFinal({");
  const releaseResultDevices = executeEnrichment.indexOf("result.devices.length = 0");
  assert.ok(comparisonBuild < finalSave && finalSave < releaseResultDevices, "release enriched device records only after the atomic Final save has succeeded");
  assert.match(executeEnrichment, /comparisonStream,\s*consumeDevices: true,/);
  assert.match(executeEnrichment, /const releaseComparisonBaseline = \(\) => \{\s*previousDevices\.length = 0;\s*previousIdentityIndex\.tokens\.clear\(\);\s*\}/);
  assert.match(executeEnrichment, /if \(!metadata\.reused\) recordOperationDuration\("enrichment", metadata\.processingTimeMs\);\s*result\.diagnostics\.historyComparison = metadata\.diagnostics\?\.historyComparison \|\| null;\s*releaseComparisonBaseline\(\)/);
  assert.match(executeEnrichment, /const presentation = includeSwitchIpReport \? \{[\s\S]*?summarizeHistoricalAddressDevices\(result\.devices\)[\s\S]*?summarizeAppliedSmartroomMappings\(result\.devices\)/);
  assert.match(executeEnrichment, /if \(!includeSwitchIpReport\) \{\s*result\.historicalAddressIndex = null;\s*result\.historicalRoomIndex = null;\s*result\.importedSmartroomRoomIndex = null;/);
  assert.match(app, /const \{ historicalAddressSummary, appliedSmartroomSummary \} = result\.presentation/);
  assert.match(app, /comparisonStream,\s*consumeDevices: true,\s*sourceFiles:/);
  assert.match(executeEnrichment, /return \{ \.\.\.result, presentation, metadata, historicalSwitchChangeQueryId, historicalSwitchChangeTotal \};/);
  assert.match(comparison, /const matchedPrevious = new Uint8Array\(previous\.length\)/);
  assert.match(comparison, /export function createFinalHistoryComparisonStream\(previous = \[\]/);
  assert.match(comparison, /const item = \{ after, candidates, reason: "conflicting-strong-identifiers" \};\s*if \(includeDiagnosticRows\) ambiguous\.push\(item\);\s*onAmbiguous\?\.\(item\)/);
  assert.match(comparison, /const absentPositionMask = includeAbsentPositionMask \? matchedPrevious : null/);
  assert.match(comparison, /const absentPositionMask = includeAbsentPositionMask \? matched : null/);
  assert.doesNotMatch(comparison, /includeAbsentPositionMask \? new Uint8Array\((?:previous|baselineDevices)\.length\)/);
  assert.match(comparison, /absentPositionMask\[position\] = absentPositionMask\[position\] === 2 \? 1 : 0/);
  assert.match(database, /comparisonEvents\(addEvent\)/);
  assert.match(database, /metadata\.diagnostics\.historyComparison = serializable\(result\);\s*tx\.objectStore\("snapshots"\)\.put\(metadata\)/);
  assert.match(database, /history\.add\(\{ \.\.\.event, snapshotId: id \}\)/);
  const saveFinalDatabase = database.slice(database.indexOf("async saveFinal("), database.indexOf("async saveOriginalFiles(", database.indexOf("async saveFinal(")));
  assert.ok(saveFinalDatabase.indexOf("comparisonStream.process(sourceChunk, addStreamHistoryEvent)") < saveFinalDatabase.indexOf("chunkStore.put({ snapshotId: id, index: chunkIndex, devices: cleanChunk })"), "compare current chunks before releasing them in the same transaction");
  assert.ok(saveFinalDatabase.indexOf("comparisonStream.finish(addStreamHistoryEvent)") > saveFinalDatabase.indexOf("for (let position = 0; position < initialChunkCount; position += 1)"), "compare absences after every current chunk has been visited");
});

test("Previous Final loading trims the detached IndexedDB chunks in place", () => {
  const app = readFileSync("src/app.js", "utf8");
  const compact = readFileSync("src/core/compact-final-analytics.js", "utf8");
  assert.equal((app.match(/mutateDetachedChunks: true/g) || []).length, 2);
  assert.match(compact, /if \(mutateDetachedChunks\) \{\s*for \(const device of chunk\) devices\.push\(trimPreviousFinalDeviceInPlace\(device\)\)/);
  assert.match(compact, /if \(!COMPACT_PREVIOUS_FINAL_FIELD_SET\.has\(field\)\) delete device\[field\]/);
});

test("unchanged room filter views reuse their cascade by catalogue and selection signature", () => {
  const app = readFileSync("src/app.js", "utf8");
  const filters = readFileSync("src/core/room-filters.js", "utf8");
  assert.match(filters, /export function roomFilterSignature\(revision, filters = \{\}\)/);
  assert.match(app, /if \(!changed && state\.roomFilterCascadeSignature === initialSignature\) return/);
  assert.match(app, /state\.roomFilterCascadeSignature = roomFilterSignature\(state\.roomCatalogRevision, values\)/);
  assert.match(app, /state\.roomFilterCascadeSignature = ""/);
});

test("complete performance statistics are bundled and exposed with a bounded preview in the Data view", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  const build = readFileSync("scripts/build-config.js", "utf8");
  assert.match(build, /src\/core\/performance-statistics\.js/);
  assert.match(database, /visitSettingPrefix\(db, PERFORMANCE_METRIC_PREFIX/);
  assert.match(database, /visitSettingPrefix\(db, LEGACY_PERFORMANCE_METRIC_PREFIX/);
  assert.match(database, /new PerformanceStatisticsAccumulator\(options\)/);
  assert.match(database, /performanceStatistics\(options = \{\}\)/);
  assert.match(app, /recordOperationDuration\("enrichment", metadata\.processingTimeMs\)/);
  assert.match(app, /csv: \{ filename: "final\.csv"[\s\S]*operation: "export_csv"/);
  assert.match(app, /recordOperationDuration\(definition\.operation/);
  assert.match(app, /renderPerformanceMetrics\(\)/);
  assert.match(html, /id="performanceMetricsTable"/);
  assert.doesNotMatch(html, /Журнал ограничен последними 500 операциями/);
});

test("application errors persist only safe event categories in a capped local journal", () => {
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  const build = readFileSync("scripts/build-config.js", "utf8");
  assert.match(build, /src\/core\/application-log\.js/);
  assert.match(app, /recordApplicationLog\("ui_error", errorName\)/);
  assert.doesNotMatch(app, /console\.error\(error\)/);
  assert.match(app, /renderApplicationLog\(\)/);
  assert.match(database, /appendApplicationLog\(current, entry\)/);
  assert.match(database, /applicationLog\(\)/);
  assert.match(html, /id="applicationLogEntries"/);
  assert.match(html, /последние 100 записей/);
});

test("Inventory column manager persists local preferences and optimizes from a full cursor scan", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(html, /id="inventoryColumnManagerPanel"/);
  assert.match(html, /id="optimizeInventoryColumnsButton"/);
  assert.match(app, /database\.getSetting\("inventoryColumnConfig", null\)/);
  assert.match(app, /inventoryColumnConfigFromLegacyPreferences\(legacy\)/);
  assert.match(app, /legacyColumnPreferences:\$\{viewName\}/);
  assert.match(app, /database\.setSetting\("inventoryColumnConfig", state\.inventoryColumnConfig\)/);
  assert.match(app, /optimizeInventoryColumnWidths\(state\.inventoryColumnConfig, \(visit\) => database\.forEachInventory\(visit\)\)/);
  assert.match(app, /visibleInventoryColumns\(state\.inventoryColumnConfig\)/);
  assert.match(html, /id="inventoryCustomColumnForm"/);
  assert.match(app, /removeCustomInventoryColumn\(state\.inventoryColumnConfig, removeButton\.dataset\.columnRemove\)/);
  assert.match(app, /data-column-remove=.*Удалить пользовательский столбец/);
  assert.match(app, /Пользовательский столбец удалён\. Сохранённые значения в данных устройства остаются без изменений\./);
  assert.match(app, /database\.updateInventoryCustomField\(deviceId, fieldKey, value\)/);
  assert.match(app, /columns: visibleInventoryColumns\(state\.inventoryColumnConfig\)/);
  assert.match(html, /XLSX-экспорт всех устройств каталога с выбранными столбцами из менеджера таблицы/);
  assert.match(app, /const rowNumber = \(result\.page - 1\) \* state\.pageSize \+ rowIndex \+ 1/);
  assert.match(app, /inventoryCellText\(device, key, rowNumber\)/);
});

test("Inventory result pages expose the full reference page-size choices up to 1000 rows", () => {
  const html = readFileSync("index.html", "utf8");
  const options = html.match(/<select id="pageSizeSelect"[^>]*>([\s\S]*?)<\/select>/)?.[1] || "";
  const sizes = [...options.matchAll(/<option(?:\s+value="(\d+)")?[^>]*>(\d+)<\/option>/g)]
    .map(([, value, label]) => Number(value || label));
  assert.deepEqual(sizes, [50, 100, 250, 500, 1000]);
});

test("Final comparison selectors update before expensive Inventory and MAC refreshes", () => {
  const app = readFileSync("src/app.js", "utf8");
  const refresh = app.slice(app.indexOf("async function refreshDatabaseState()"), app.indexOf("\nasync function renderLocalArchiveList()"));
  assert.match(refresh, /state\.snapshotMetadata = \(await database\.listSnapshots\(\{ includeDiagnostics: false \}\)\)\.filter\(isFinalSnapshot\)[\s\S]*?renderSnapshotSelectors\(\);\s*await renderDeviceTable\(\);\s*await renderMacOptions\(\)/);
});

test("engineering mode uses a stored Web Crypto credential, TTL, and user view gate", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const auth = readFileSync("src/core/engineering-session.js", "utf8");
  assert.match(html, /id="engineeringModeButton"/);
  assert.match(html, /id="engineeringModeDialog"/);
  assert.match(app, /database\.setSetting\("engineeringCredential"/);
  assert.match(app, /verifyEngineerCredential\(password, state\.engineeringCredential\)/);
  assert.match(app, /canAccessView\(name, isEngineerActive\(\)\)/);
  assert.match(app, /data-delete-device-history[\s\S]*#deleteHistoryEventsButton/);
  assert.match(auth, /PBKDF2-SHA-256/);
  assert.match(auth, /MAX_ENGINEERING_SESSION_MINUTES = 1_440/);
});

test("analytics dashboard persists engineer-only auto-refresh and skips hidden tabs", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const settings = readFileSync("src/core/analytics-dashboard-settings.js", "utf8");
  assert.match(html, /id="analyticsDashboardSettingsDialog"/);
  assert.match(html, /id="analyticsAutoRefreshEnabled"/);
  assert.match(html, /id="analyticsRefreshIntervalSeconds" type="number" min="10" max="300"/);
  assert.match(app, /database\.getSetting\("analyticsDashboardSettings"/);
  assert.match(app, /database\.setSetting\("analyticsDashboardSettings"/);
  assert.match(app, /legacyAnalyticsDashboardSettings\(await database\.getSetting\("legacyAppSetting:dashboard"/);
  assert.match(app, /document\.visibilityState === "hidden" \|\| \$\("#analyticsView"\)\.hidden/);
  assert.match(app, /analyticsSettingsButton\.hidden = !engineer/);
  assert.match(settings, /MAX_ANALYTICS_REFRESH_SECONDS = 300/);
  assert.equal((html.match(/<details class="analytics-group" open>/g) || []).length, 3);
  assert.match(html, /<span>Ключевые графики<\/span>/);
  assert.match(html, /<span>Состав и качество данных<\/span>/);
  assert.match(html, /<span>Расширенная аналитика<\/span>/);
  for (const panel of ["dashboardStatusTotalsChart", "datasetOverview", "clusterSummary", "topologySummary", "weeklyChart", "presenceChart", "totalChart", "vendorRanking", "modelRanking", "churnRanking", "changeTable"]) {
    assert.match(html, new RegExp(`id="${panel}"`));
  }
  assert.match(readFileSync("styles.css", "utf8"), /\.analytics-group\[open\] > summary::after/);
});

test("Dashboard settings expose three tabs, six KPI and five screen chart controls with PNG export", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const settings = readFileSync("src/core/analytics-dashboard-settings.js", "utf8");
  const exporter = readFileSync("src/core/analytics-dashboard-export.js", "utf8");
  const renderer = readFileSync("src/ui/dashboard-export.js", "utf8");
  assert.equal((html.match(/role="tab" aria-selected=/g) || []).length, 3);
  assert.equal((html.match(/data-dashboard-widget-setting="kpi:/g) || []).length, 6);
  assert.equal((html.match(/data-dashboard-widget-setting="chart:/g) || []).length, 5);
  assert.match(html, /id="exportAnalyticsPngButton"/);
  assert.match(html, /id="exportAnalyticsXlsxButton"/);
  assert.match(html, /id="exportAnalyticsHtmlButton"/);
  assert.match(app, /analyticsDashboardHtml\(state\.analytics, new Date\(\), state\.analyticsDashboardSettings\)/);
  assert.match(app, /exportAnalyticsHtmlButton"\)\.addEventListener\("click".*exportAnalyticsDashboardHtml/);
  assert.match(exporter, /export function analyticsDashboardHtml/);
  assert.match(app, /analyticsDashboardXlsxSheets\(state\.analytics, state\.analyticsDashboardSettings\)/);
  assert.match(app, /analyticsSummaryXlsxSheets\(state\.analytics, \(queryId, metric, options\) => database\.analyticsAggregateRankedPage\(queryId, metric, options\)\)/);
  assert.match(app, /const sheets = \[\.\.\.summarySheets, \.\.\.analyticsDashboardXlsxSheets/);
  assert.match(app, /drawDashboardStatusCharts\(state\.analytics\)/);
  assert.match(app, /exportAnalyticsXlsxButton"\)\.addEventListener\("click".*exportAnalyticsDashboardXlsx/);
  assert.match(app, /selectDashboardSettingsTab\(nextIndex, true\)/);
  assert.match(app, /canvas\.width = model\.width;[\s\S]*?canvas\.height = model\.height/);
  assert.match(app, /download\(`analytics-dashboard-.*?\.png`, blob, "image\/png"\)/);
  assert.match(settings, /DASHBOARD_KPI_WIDGETS/);
  assert.match(exporter, /width: 2_000,[\s\S]*?height: 1_200/);
  assert.match(exporter, /type: "line"[\s\S]*?datasets:/);
  assert.match(app, /import \{ drawDashboardExportChart \} from "\.\/ui\/dashboard-export\.js"/);
  assert.match(renderer, /context\.arc\(pointX\(index\), pointY, 4/);
});

test("weekly history chart stays independent from the configurable status chart widgets", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const analytics = readFileSync("src/core/analytics.js", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  const weeklyChart = html.match(/<article class="panel wide"><h3>Динамика изменения MAC-адресов по неделям<\/h3>[\s\S]*?<\/article>/)?.[0] || "";
  assert.match(weeklyChart, /<h3>Динамика изменения MAC-адресов по неделям<\/h3>/);
  assert.match(weeklyChart, /id="weeklyChart"[^>]*aria-label="Динамика изменения MAC-адресов по неделям"/);
  assert.match(html, /data-dashboard-widget="chart:fields"/);
  assert.match(html, /data-dashboard-widget="chart:vendors"/);
  assert.match(html, /data-dashboard-widget="chart:absent-vendors"/);
  assert.match(html, /data-dashboard-widget="chart:presence-churn"/);
  assert.match(app, /data-churn-search/);
  assert.match(app, /data-churn-rows/);
  assert.match(app, /churnContent\(analytics\.churn, \{ page, pageSize: 100 \}\)/);
  assert.match(renderer, /export function churnContent\(/);
  assert.match(renderer, /data-churn-page=/);
  assert.match(app, /data-churn-transitions/);
  assert.match(app, /collectPresenceTransitions\(mac, state\.snapshotMetadata,[\s\S]*?forEachSnapshotChunk\(snapshotId, visit\)/);
  assert.match(app, /filters: analytics\.dashboardFilters \|\| \{\}/);
  assert.match(analytics, /export async function collectPresenceTransitions\(/);
  assert.match(app, /drawFinalChangeTrend\(\$\("#presenceChart"\), analytics\.snapshotChanges\)/);
  assert.match(app, /drawFinalTotalsTrend\(\$\("#totalChart"\), analytics\.totals\)/);
});

test("dark chart palette keeps text, grid, and danger series readable", () => {
  const styles = readFileSync("styles.css", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  const darkTheme = styles.match(/body\.dark\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(darkTheme, /--text:\s*#edf6f7/);
  assert.match(darkTheme, /--border:\s*#34464b/);
  assert.match(darkTheme, /--primary:\s*#43b7c3/);
  assert.match(darkTheme, /--danger:\s*#ff8b92/);
  assert.match(renderer, /globalThis\.getComputedStyle\?\.\(globalThis\.document\?\.body\)/);
});

test("light and dark status foregrounds maintain WCAG AA contrast on their surfaces", () => {
  const styles = readFileSync("styles.css", "utf8");
  const root = styles.match(/:root\s*\{([^}]+)\}/)?.[1] || "";
  const dark = styles.match(/body\.dark\s*\{([^}]+)\}/)?.[1] || "";
  const value = (block, name) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const luminance = (hex) => {
    const [r, g, b] = hex.slice(1).match(/.{2}/g).map((channel) => parseInt(channel, 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (foreground, background) => {
    const first = luminance(foreground);
    const second = luminance(background);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };
  for (const [theme, tokens] of [["light", root], ["dark", dark]]) {
    for (const [foreground, background] of [
      ["text", "surface"], ["muted", "surface"], ["primary", "surface"],
      ["primary-dark", "surface-soft"], ["on-primary", "primary"], ["on-primary", "primary-dark"],
      ["on-danger", "danger"], ["danger", "danger-soft"],
    ]) {
      const textColor = value(tokens, foreground);
      const backgroundColor = value(tokens, background);
      assert.ok(textColor && backgroundColor, `${theme} theme must define ${foreground}/${background}`);
      assert.ok(contrast(textColor, backgroundColor) >= 4.5, `${theme} ${foreground} on ${background} must meet WCAG AA`);
    }
  }
  assert.match(styles, /\.button\.primary\s*\{[^}]*color:\s*var\(--on-primary\)/);
  assert.match(styles, /\.button\.danger\s*\{[^}]*color:\s*var\(--on-danger\)/);
  assert.match(styles, /\.error-banner\s*\{[^}]*color:\s*var\(--on-danger\)/);
});

test("upload history screen searches, pages and opens successful Final snapshots", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(html, /id="snapshotHistoryFilters"/);
  assert.match(html, /id="snapshotHistoryPreviousButton"/);
  assert.match(html, /id="snapshotHistoryNextButton"/);
  assert.match(html, /id="deleteSelectedFinalsButton"/);
  assert.match(html, /id="clearFinalHistoryButton"/);
  assert.match(html, /name="vendor"/);
  assert.match(html, /name="model"/);
  assert.match(html, /name="room"/);
  assert.match(html, /поиском по устройствам/i);
  assert.match(app, /snapshotDeviceMatchesQuery\(device, query\)/);
  assert.match(app, /database\.loadSnapshotPage\(snapshotId/);
  assert.match(app, /snapshotSourceNames\(snapshot\)/);
  assert.match(app, /database\.deleteSnapshots\(ids\)/);
  assert.match(app, /state\.snapshotMetadata\s*=\s*\(await database\.listSnapshots\(\{ includeDiagnostics: false \}\)\)\.filter\(isFinalSnapshot\)/);
  assert.match(app, /database\.deleteSnapshots\(state\.snapshotMetadata\.map\(\(\{ id \}\) => id\)\)/);
  assert.match(app, /state\.uploadHistory\.selectedIds\.add/);
  assert.match(app, /snapshotDeviceMatchesFilters\(device, deviceFilters\)/);
  assert.match(app, /synchronizeDataDirectoryArchive\(\)/);
});

test("selected snapshot deletion scans metadata by cursor instead of materializing every snapshot", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const start = database.indexOf("async deleteSnapshots(ids = []) {");
  const end = database.indexOf("async clearSnapshots() {", start);
  assert.ok(start >= 0 && end > start);
  const deletion = database.slice(start, end);
  assert.match(deletion, /snapshots\.openCursor\(\)/);
  assert.doesNotMatch(deletion, /snapshots\.getAll\(/);
});

test("startup active-Final recovery scans newest metadata and chunks by cursors without collecting history", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const start = database.indexOf("async recoverActiveSnapshot() {");
  const end = database.indexOf("async saveFinal(", start);
  assert.ok(start >= 0 && end > start);
  const recovery = database.slice(start, end);
  assert.match(recovery, /snapshots\.index\("by_created"\)/);
  assert.match(recovery, /source\.openCursor\(null, direction\)/);
  assert.match(recovery, /snapshotChunks\.openCursor\(range, "next"\)/);
  assert.doesNotMatch(recovery, /listSnapshots\(|\.getAll\(/);
});

test("switch-IP change details persist bounded batches and read exact cursor pages", () => {
  const app = readFileSync("src/app.js", "utf8");
  const core = readFileSync("src/core/historical-mapping.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(app, /onChangesBatch: \(changes, \{ total \}\) => database\.appendSwitchIpReportChanges\(/);
  assert.match(app, /signal: state\.controller\?\.signal,\s*onChangesBatch:/);
  assert.match(app, /database\.switchIpReportChangesPage\(queryId, \{ offset, limit: 100 \}\)/);
  assert.match(app, /function historicalSwitchChangeDetails\(page\)/);
  assert.match(app, /data-switch-ip-change-offset=/);
  assert.match(app, /data-switch-ip-change-container/);
  assert.match(app, /switchIpChangePage\.closest\("\[data-switch-ip-change-container\]"\)/);
  assert.match(app, /loadSwitchIpChangeReportPage\(host, Number\(switchIpChangePage\.dataset\.switchIpChangeOffset\) \|\| 0\)\.catch\(showError\)/);
  assert.match(core, /onChangesBatch = null/);
  assert.match(core, /signal = null/);
  assert.match(core, /throwIfAborted\(\)/);
  assert.match(core, /return onChangesBatch \? \{ total \} : changes/);
  assert.match(database, /async appendSwitchIpReportChanges\(/);
  assert.match(database, /async switchIpReportChangesPage\(/);
  assert.match(app, /await database\.clearExpiredAnalyticsAggregateQueries\("switch-ip-report:"\)/);
  assert.match(app, /\.catch\(async \(error\) => \{\s*error\.batchStage = "атомарное сохранение Final";\s*if \(historicalSwitchChangeQueryId\) await database\.clearAnalyticsAggregateQuery\(historicalSwitchChangeQueryId\)\.catch\(\(\) => \{\}\);/);
});

test("vendor inference settings persist locally and are included in the portable runtime", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(html, /id="vendorInferenceEnabled"/);
  assert.match(html, /id="vendorDetectorEnabled"/);
  assert.match(html, /id="vendorOuiEnabled"/);
  assert.match(html, /id="vendorMac5Enabled"/);
  assert.match(html, /id="vendorTextEnabled"/);
  assert.match(html, /id="vendorInferenceThreshold"/);
  assert.match(app, /database\.setSetting\("vendorDetectorSettings", settings\)/);
  assert.match(app, /enabled: \$\("#vendorDetectorEnabled"\)\.checked/);
  assert.match(app, /vendorDetectorSettings,/);
  assert.ok(PORTABLE_MODULES.includes("src/core/vendor-detector.js"));
  assert.ok(PORTABLE_MODULES.includes("src/core/coalesced-task.js"));
});

test("vendor and model rule learning reads Final chunks and persists without replacing existing rules", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(html, /id="learnVendorModelButton"/);
  assert.match(html, /id="vendorModelLearnMinCount"/);
  assert.match(html, /id="vendorModelLearnSource"/);
  assert.match(app, /createVendorModelRuleLearner\(/);
  assert.match(app, /database\.forEachSnapshotChunk\(snapshot\.id/);
  assert.match(app, /database\.saveLearnedVendorModelRules\(suggestions\)/);
  assert.match(app, /database\.applyVendorModelRulesToActiveSnapshot\(\)/);
  assert.match(database, /async saveLearnedVendorModelRules/);
  assert.match(database, /async applyVendorModelRulesToActiveSnapshot/);
  assert.match(database, /store\.add\(\{ prefix, vendor/);
  assert.match(app, /rule\.observations/);
  assert.match(app, /rule\.source/);
});

test("leaving analytics invalidates pending work and returning recalculates from IndexedDB", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /previousView === "analytics" && name !== "analytics"[\s\S]{0,240}state\.analyticsRequests\.invalidate\(\)[\s\S]{0,180}state\.analytics = null[\s\S]{0,180}state\.analyticsNeedsRefresh = true/);
  assert.match(app, /if \(name === "analytics"\) \{\s*const force = state\.analyticsNeedsRefresh;\s*state\.analyticsNeedsRefresh = false;\s*renderAnalytics\(force\)/);
  assert.match(app, /async function renderAnalytics\(force = false\)/);
});

test("extended selected-Final analytics reuses its loaded payload and falls back to IndexedDB chunks", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /if \(state\.analyticsDashboardSettings\.filters\.status !== "all"\) return renderAnalytics\(true\);/);
  assert.match(app, /createDatasetAnalyticsCollector\(\{ includeTopologyDevices: false, includeTopologySummary: !clusterQueryId, includeClusters: !clusterQueryId, includeRankings: !clusterQueryId, clusterFields \}\)/);
  assert.match(app, /if \(dashboardStatus === "missing"\) return chunk\.filter\(\(_device, index\) => missingPositionMask\?\.\[startOffset \+ index\] === 1\)/);
  assert.match(app, /devices: datasetSnapshotId \? undefined : analytics\.devices/);
  assert.match(app, /const expectedStatus = CURRENT_STATUS_MASK\[dashboardStatus\];[\s\S]*?chunk\.filter\(\(_device, index\) => currentStatusMask\?\.\[startOffset \+ index\] === expectedStatus\)/);
  assert.match(app, /database\.mergeAnalyticsAggregateBatches\(clusterQueryId, \{[\s\S]*?\.\.\.collectAnalyticsBuckets\(selectedChunk\)/);
  assert.match(app, /const builtAnalytics = await buildAnalyticsPairFromChunks\(previous, current,[\s\S]*?database\.forEachSnapshotChunk\(currentMetadata\.id, visit\)[\s\S]*?includeAbsentPositionMask: dashboardFilters\.status === "missing",[\s\S]*?includeCurrentStatusMask: dashboardFilters\.status === "changed" \|\| dashboardFilters\.status === "unchanged"/);
  assert.match(app, /buildAnalyticsPairFromChunks\(previous, current,[\s\S]*?releasePreviousDevices: true/);
  assert.doesNotMatch(app, /loadCompactFinalForComparison\(currentMetadata/);
  assert.match(app, /renderDashboardFilterOptions\(\[\], builtAnalytics\.dashboardFilterOptions\)/);
  assert.match(app, /scheduleAnalyticsDetails\(analytics, revision, metadata, historySignature, force, missingPositionMask, currentStatusMask\)/);
  assert.match(app, /function calculateAnalyticsDetails\(analytics, revision, metadata, historySignature, force, missingPositionMask = null, currentStatusMask = null\)/);
  assert.match(app, /await feedAnalyticsDatasetRows\(\{[\s\S]*?devices: datasetSnapshotId \? undefined : analytics\.devices[\s\S]*?visitChunks: \(snapshotId, visit\) => database\.forEachSnapshotChunk\(snapshotId, visit, \{/);
  assert.match(app, /selected-final-dataset-v6:/);
  assert.match(app, /database\.loadAnalyticsCache\(datasetCacheKey, historySignature, 6\)/);
  assert.match(app, /database\.saveAnalyticsCache\(datasetCacheKey, historySignature, \{ snapshotId: datasetCacheSnapshotId, dataset \}, 6, \{[\s\S]*?onProgress/);
  assert.match(app, /\.\.\.collectTopologyBuckets\(selectedChunk\)/);
  assert.match(app, /analyticsAggregateRankedPage\(clusterQueryId, "topology-switch", \{ limit: 20 \}\)/);
  assert.match(app, /dataset\.summary\.devices !== expectedDevices/);
  assert.doesNotMatch(app, /buildDatasetAnalytics\(analytics\.devices/);
});

test("selected-Final clusters page and export the complete IndexedDB aggregate", () => {
  const app = readFileSync("src/app.js", "utf8");
  const detail = readFileSync("src/core/analytics-detail.js", "utf8");
  assert.match(app, /analyticsAggregatePage\(clusters\.queryId, "cluster", \{ after, limit: 50 \}\)/);
  assert.match(app, /async function exportAnalyticsClustersCsv\(\)/);
  assert.match(app, /analyticsAggregatePage\(clusters\.queryId, "cluster", \{ after, limit: 500 \}\)/);
  assert.match(app, /writeClustersCsv\(fields,[\s\S]*?writable\)/);
  assert.match(app, /new globalThis\.TransformStream\(\{[\s\S]*?encoder\.encode\(String\(chunk\)\)/);
  assert.match(app, /new globalThis\.Response\(transform\.readable[\s\S]*?\.blob\(\)/);
  assert.match(app, /writable = transform\.writable\.getWriter\(\)/);
  assert.match(detail, /function collectClusterBuckets\(/);
  assert.match(detail, /async function writeClustersCsv\(/);
  assert.doesNotMatch(app, /clustersCsv\(state\.analytics\.dataset\)/);
});

test("topology pages read exact switch, port and room aggregates from IndexedDB", () => {
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const detail = readFileSync("src/core/analytics-detail.js", "utf8");
  assert.match(app, /async function loadTopologyAggregateNodes\(/);
  assert.match(app, /fetchTopologySwitchPage = async \(/);
  assert.match(app, /fetchTopologyChildPage = async \(/);
  assert.match(database, /async analyticsAggregateRankedPage\(/);
  assert.match(database, /async analyticsAggregateValuePage\(/);
  assert.match(detail, /function collectTopologyBuckets\(/);
  assert.match(detail, /topology\.pageTotal/);
  assert.match(detail, /data-topology-room-page/);
});

test("database refresh stores only active-Final metadata and exports or scans its chunks on demand", () => {
  const app = readFileSync("src/app.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  const modules = readFileSync("scripts/build-config.js", "utf8");
  assert.match(app, /state\.activeSnapshot = await database\.activeSnapshotMetadata\(\)/);
  assert.match(app, /function exportActiveFinal\(format\)/);
  for (const writer of ["writeSnapshotCsv", "writeSnapshotJson", "writeSnapshotYaml", "writeSnapshotHtml"]) assert.match(app, new RegExp(`${writer}`));
  assert.match(app, /typeof globalThis\.showSaveFilePicker === "function"/);
  assert.match(app, /definition\.stream\(snapshot, visitChunks, columns, writable\)/);
  assert.match(app, /definition\.blob\(snapshot, visitChunks, columns\)/);
  assert.match(app, /function exportActiveFinal\(format\)[\s\S]*?new globalThis\.TransformStream\(\{[\s\S]*?encoder\.encode\(String\(chunk\)\)/);
  assert.match(app, /function exportActiveFinal\(format\)[\s\S]*?new globalThis\.Response\(transform\.readable, \{ headers: \{ "Content-Type": definition\.mime \} \}\)\.blob\(\)/);
  assert.match(app, /new globalThis\.Response\(createXlsxWorkbookStream\(createSnapshotXlsxSheets\(database, snapshot, columns\)\), \{ headers: \{ "Content-Type": definition\.mime \} \}\)/);
  assert.match(app, /async function exportTopologyHtml\(\)[\s\S]*?writeTopologyHtml\(analytics\.current,[\s\S]*?database\.forEachSnapshotChunk\(id, visit\)/);
  assert.match(app, /async function exportTopologyHtml\(\)[\s\S]*?new globalThis\.TransformStream\(\{[\s\S]*?encoder\.encode\(String\(chunk\)\)/);
  assert.match(app, /async function exportTopologyHtml\(\)[\s\S]*?new globalThis\.Response\(transform\.readable[\s\S]*?\.blob\(\)/);
  assert.match(app, /async function exportTopologyHtml\(\)[\s\S]*?if \(typeof writable\.close === "function"\) await writable\.close\(\)/);
  assert.doesNotMatch(app, /createDatasetAnalyticsCollector\(\{ includeTopologyDevices: true \}\)/);
  assert.match(app, /for \(const format of \["csv", "xlsx", "txt", "json", "yaml", "html"\]\)/);
  assert.match(app, /createSnapshotPdfBlob\(state\.activeSnapshot, \(id, visit\) => database\.forEachSnapshotChunk\(id, visit\), inventoryOutputColumns\(\)/);
  assert.match(app, /download\(`mac-analyzer-final-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.pdf`, blob, "application\/pdf"\)/);
  assert.match(html, /id="exportFinalYamlButton"/);
  assert.match(html, /id="exportFinalCsvButton"/);
  assert.match(html, /id="exportFinalXlsxButton"/);
  assert.match(html, /id="exportFinalTxtButton"/);
  assert.match(html, /id="exportFinalJsonButton"/);
  assert.match(html, /id="exportFinalHtmlButton"/);
  assert.match(html, /id="exportFinalPdfButton"/);
  assert.match(app, /database\.forEachSnapshotChunk\(state\.activeSnapshot\.id, \(chunk\) => detector\.accept\(chunk\)\)/);
  assert.match(app, /database\.forEachSnapshotChunk\(snapshot\.id, \(chunk\) => collector\.accept\(chunk\)\)/);
  assert.match(modules, /"src\/core\/snapshot-export\.js"/);
  assert.match(modules, /"src\/core\/pdf-export\.js"/);
  assert.match(builder, /node_modules\/jspdf\/dist\/jspdf\.umd\.min\.js/);
  assert.match(builder, /assets\/NotoSans-Regular\.ttf/);
  assert.match(builder, /__MAC_ANALYZER_PDF_FONT_BASE64__/);
  assert.match(artifactCheck, /embedded Cyrillic font/);
  assert.match(artifactCheck, /Version 4\.2\.1/);
});

test("large Dashboard updates show detail progress and clear the previous dataset summary", () => {
  const app = readFileSync("src/app.js", "utf8");
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(app, /function paintAnalyticsSummary\(analytics\) \{[\s\S]*Подробная сводка выбранного статуса рассчитывается/);
  assert.match(app, /function calculateAnalyticsDetails\([\s\S]*Расчёт статистики по времени/);
  assert.match(app, /Сводки выбранного статуса: \$\{rowsProcessed\.toLocaleString/);
  assert.match(app, /Сохранение агрегатов выбранного статуса: \$\{pendingRowsProcessed\.toLocaleString/);
  assert.match(app, /Чтение чанка \$\{index \+ 1\}\/\$\{chunkCount\} Final/);
  assert.match(app, /Ответ IndexedDB для чанка \$\{index \+ 1\}\/\$\{chunkCount\} получен; обрабатываю/);
  assert.match(app, /Чтение истории Final \$\{index \+ 1\}\/\$\{metadata\.length\}, чанка/);
  assert.match(app, /Ответ IndexedDB для истории Final \$\{index \+ 1\}\/\$\{metadata\.length\}, чанка/);
  assert.match(app, /Обработка истории Final \$\{index \+ 1\}\/\$\{metadata\.length\}, чанка/);
  assert.match(app, /Worker истории Final \$\{snapshotIndex \+ 1\}\/\$\{snapshotCount\}, чанк \$\{chunkIndex \+ 1\}\/\$\{chunkCount\}/);
  assert.match(app, /const stage = \(message\) => \{ if \(loading && state\.analyticsRequests\.isCurrent\(revision\)\) loading\.textContent = message; \};/);
  assert.match(app, /await renderTemporalStatistics\(false\)/);
  assert.match(app, /feedAnalyticsDatasetRows\(\{[\s\S]*?isCurrent: \(\) => state\.analyticsRequests\.isCurrent\(revision\)/);
  assert.match(app, /Завершение рейтингов, комнат и топологии/);
  assert.match(app, /if \(!state\.analyticsRequests\.isCurrent\(revision\)\) \{\s*return null;\s*\}/);
  assert.match(app, /deviceMatches: historyFilters\.query \|\| historyFilters\.manufacturer \|\| historyFilters\.room[\s\S]*?Final \$\{index \+ 1\} из \$\{snapshots\.length\}, блок \$\{chunkNumber\} из \$\{chunkCount\}/);
  assert.match(smoke, /const needsApply=current\.value!==.*expectedBase.*if\(needsApply\)document\.querySelector\('#applyComparisonButton'\)\.click\(\)/);
  assert.match(smoke, /analyticsProgressChangedAt = Date\.now\(\)/);
  assert.match(smoke, /перестал сообщать о продвижении более 75 секунд/);
});

test("vendor and model history screen exposes rebuild, search, paging and full filtered export", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(html, /id="rebuildVendorModelHistoryButton"/);
  assert.match(html, /id="vendorModelHistoryFilters"/);
  assert.match(html, /id="vendorModelHistoryPreviousButton"/);
  assert.match(html, /id="vendorModelHistoryNextButton"/);
  assert.match(html, /id="exportVendorModelHistoryButton"/);
  assert.match(html, /id="deleteImportedHistoryLoadsButton"/);
  assert.match(html, /<option value="loads">Источники \/ загрузки<\/option>/);
  assert.match(app, /database\.forEachSnapshotChunk\(snapshot\.id/);
  assert.match(app, /for \(const kind of \["vendor_model_history", "mac_history", "resolved_device_history"\]\)/);
  assert.match(app, /database\.legacyObservationPage\(\{ kind, cursor: importedCursor, limit: 250 \}\)/);
  assert.match(app, /accumulator\.addObservation\(observation\)/);
  assert.match(app, /database\.legacyObservationPage\(\{ kind: "history_loads", cursor: loadCursor, limit: 250 \}\)/);
  assert.match(app, /database\.ouiPage\(\{ afterPrefix: ouiCursor, limit: 250 \}\)/);
  assert.match(app, /database\.mac5ModelPage\(\{ afterPrefix: modelCursor, limit: 250 \}\)/);
  assert.match(app, /accumulator\.addMappingRule\(\{ kind: "vendor"/);
  assert.match(app, /accumulator\.addMappingRule\(\{ kind: "model"/);
  assert.match(app, /importedObservations/);
  assert.match(app, /mappingRules/);
  assert.match(app, /row\.sources\.join\("; "\)/);
  assert.match(app, /stats\.loadRecords\.toLocaleString/);
  assert.match(app, /\["source", "Источник \/ файл"\], \["records", "Устройств \/ записей"\]/);
  assert.match(app, /\["newVendorsAdded", "Новых производителей"\]/);
  assert.match(app, /\["enrichedFromHistory", "Обогащено из истории"\]/);
  assert.match(app, /function exportVendorModelHistory\(\)[\s\S]*?\["newModelsAdded", "Новых моделей"\][\s\S]*?\["lastSeen", "Последняя запись"\]/);
  assert.match(app, /vendorModelHistoryCsvChunks\(current\.data, \{ kind: current\.kind, query: current\.query, columns \}\)/);
  assert.match(app, /writeReadableStreamToWritable\(stream, await handle\.createWritable\(\)\)/);
  assert.doesNotMatch(app.match(/function exportVendorModelHistory\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "", /filterVendorModelHistory|exportRows|csv\(/);
  assert.match(app, /data-delete-imported-history-load/);
  assert.match(app, /deleteImportedHistoryLoads\(\)/);
  assert.match(app, /deleteLegacyObservationsByFilters\(\{ kind: "history_loads" \}\)/);
  assert.match(app, /deleteLegacyObservations\(\[id\]\)/);
  assert.match(app, /deleteImportedHistoryLoadsButton/);
  assert.match(app, /deleteImportedHistoryLoadsButton"\)\.hidden = current\.kind !== "loads"/);
  assert.match(app, /\["models", "loads"\]\.includes\(values\.kind\)/);
});

test("enrichment displays escaped details for strongest-identifier conflict diagnostics", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /identityConflictDetails,/);
  assert.match(app, /identityConflictDetails\(result\.diagnostics\.conflicts, result\.diagnostics\.counts\.identityConflictsTotal\)/);
  const render = readFileSync("src/ui/render.js", "utf8");
  assert.match(render, /export function identityConflictDetails\(conflicts = \[\], totalCount = null\)/);
  assert.match(render, /escapeHtml\(item\.alternative \|\| "—"\)/);
});

test("selected-pair analytics keeps the baseline in IndexedDB and streams both Final sides", () => {
  const app = readFileSync("src/app.js", "utf8");
  const analytics = readFileSync("src/core/analytics.js", "utf8");
  const compactAnalytics = readFileSync("src/core/compact-final-analytics.js", "utf8");
  assert.match(app, /async function ensureDashboardComparisonIndex\(metadata, baselineMetadata/);
  assert.match(app, /database\.saveFinalAnalyticsIndexFromSnapshot\(/);
  assert.match(app, /const previousIndex = await ensureDashboardComparisonIndex\(metadata, previousMetadata/);
  assert.match(app, /resolveIdentityChunk: previousIndex\.snapshotId[\s\S]*?database\.buildFinalAnalyticsIdentityIndex/);
  assert.match(app, /visitPreviousChunks: previousIndex\.snapshotId[\s\S]*?database\.forEachFinalAnalyticsIndexChunk/);
  assert.match(app, /import \{ compactComparisonDevice,[^}]*trimComparisonDeviceInPlace/);
  assert.match(compactAnalytics, /export function trimComparisonDeviceInPlace\(device = \{\}\)[\s\S]*?delete device\[field\]/);
  assert.match(app, /buildAnalyticsPairFromChunks\(previous, current/);
  assert.match(app, /database\.forEachSnapshotChunk\(currentMetadata\.id, visit\)/);
  assert.doesNotMatch(app, /loadCompactFinalForComparison/);
  assert.match(analytics, /visitPreviousChunks && baseline\.length/);
  assert.match(analytics, /summary\.observePreviousChunk\(chunk, previousOffset\)/);
  assert.doesNotMatch(app, /database\.loadFinalAnalyticsIndex\(metadata\.id/);
  assert.match(app, /releaseDashboardCurrentDevices\(builtAnalytics\)/);
  assert.match(app, /devices: datasetSnapshotId \? undefined : analytics\.devices/);
  assert.doesNotMatch(app, /database\.loadSnapshot\((?:current|previous)Metadata\.id\)/);
});

test("first and history-backfilled Dashboard comparisons stream both Final sides through the sparse identity index", () => {
  const app = readFileSync("src/app.js", "utf8");
  const comparison = readFileSync("src/core/comparison.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const compact = readFileSync("src/core/compact-final-analytics.js", "utf8");
  assert.match(app, /async function ensureDashboardComparisonIndex\([\s\S]*?if \(baselineIndex <= 0\)/);
  assert.match(app, /__mac_analyzer_comparison_backfill__:\$\{baselineMetadata\.id\}/);
  assert.match(app, /resolveSnapshotIdentityIndex: \(snapshot, devices\) => database\.buildFinalAnalyticsIdentityIndex/);
  assert.match(app, /saveFinalAnalyticsIndexFromSnapshot\(/);
  assert.match(app, /buildFinalAnalyticsIdentityIndex\(/);
  assert.match(app, /visitPreviousChunks: \(visit\) => database\.forEachFinalAnalyticsIndexChunk\(/);
  assert.match(comparison, /export async function compareFinalAbsencePage\([\s\S]*?visitPreviousChunks = null,[\s\S]*?resolveIdentityChunk = null/);
  assert.match(comparison, /export async function compareFinalAdditionPage\([\s\S]*?resolveIdentityChunk = null/);
  assert.match(database, /forEachFinalAnalyticsIndexChunk\(snapshotId, signature, schemaVersion = 1, visit\)/);
  assert.match(database, /createIndex\("by_identity_lookup", "identityLookupKeys", \{ unique: false, multiEntry: true \}\)/);
  assert.match(compact, /FINAL_ANALYTICS_INDEX_SCHEMA_VERSION = 5/);
});

test("room analytics computes reconciled descriptors per row without a full descriptor roster", () => {
  const analytics = readFileSync("src/core/analytics.js", "utf8");
  assert.match(analytics, /function roomLocationIndex\(devices\)[\s\S]*?for \(const device of devices\) addRoomSmartroomEvidence/);
  assert.match(analytics, /export function analyzeRoomSwitchAnomalies\(devices = \[\], locationToIds = roomLocationIndex\(devices\)\)[\s\S]*?for \(const device of devices\)[\s\S]*?reconciledRoomDescriptor\(device, locationToIds\)/);
  assert.match(analytics, /const currentRoomLocations = roomLocationIndex\(devices\)[\s\S]*?for \(const device of devices\)[\s\S]*?reconciledRoomDescriptor\(device, currentRoomLocations\)/);
  assert.doesNotMatch(analytics, /function reconcileRoomKeys|const currentRoomDescriptors\s*=|devices\.map\(\(device\) => roomDescriptor\(device\)\)/);
});

test("selected comparison filters reuse pages only under an exact bounded pair cache key", () => {
  const app = readFileSync("src/app.js", "utf8");
  const lifecycle = readFileSync("src/core/analytics-lifecycle.js", "utf8");
  assert.match(app, /createBoundedComparisonPageCache\(\)/);
  assert.match(app, /analytics\.comparisonPairSignature = JSON\.stringify\(\[historySignature, previousMetadata\?\.id \|\| "", currentMetadata\?\.id \|\| "", dashboardFilters\]\)/);
  assert.match(app, /"comparison-page-v1",\s*analytics\.comparisonPairSignature/);
  assert.match(app, /state\.analyticsComparisonPageCache\.clear\(\)/);
  assert.match(lifecycle, /export function createBoundedComparisonPageCache\(/);
  assert.match(lifecycle, /while \(entries\.size > entryLimit \|\| rowCount > rowLimit\)/);
});

test("selected-pair analytics paints the complete metadata fleet trend before loading filtered history details", () => {
  const app = readFileSync("src/app.js", "utf8");
  const analytics = readFileSync("src/core/analytics.js", "utf8");
  const summaryStart = app.indexOf("function paintAnalyticsSummary(analytics)");
  const summaryEnd = app.indexOf("function paintAnalyticsDetails(analytics)", summaryStart);
  const summary = app.slice(summaryStart, summaryEnd);
  const metadataTrendIndex = app.indexOf("analytics.totals = buildSnapshotTotalSeries(metadata)");
  const stateCommitIndex = app.indexOf("state.analytics = analytics", metadataTrendIndex);
  const detailsScheduleIndex = app.indexOf("scheduleAnalyticsDetails(analytics, revision", stateCommitIndex);
  assert.ok(metadataTrendIndex >= 0 && metadataTrendIndex < stateCommitIndex && stateCommitIndex < detailsScheduleIndex);
  assert.match(app, /analytics\.totals = buildSnapshotTotalSeries\(metadata\)/);
  assert.doesNotMatch(app, /analytics\.totals = historyFiltersActive \? \[\] : buildSnapshotTotalSeries\(metadata\)/);
  assert.match(summary, /drawFinalTotalsTrend\(\$\("#totalChart"\), analytics\.totals \|\| \[\]\)/);
  assert.match(analytics, /export function buildSnapshotTotalSeries\(/);
});

test("Final result detail pages use the persisted user-configured results columns", () => {
  const app = readFileSync("src/app.js", "utf8");
  const openFinalSnapshotPage = app.match(/async function openFinalSnapshotPage\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(openFinalSnapshotPage, /^async function openFinalSnapshotPage\([^\n]*\) \{\s*await loadInventoryColumnConfig\(\);\s*const pageSize = 100;\s*const result = await database\.loadSnapshotPage/);
  assert.match(openFinalSnapshotPage, /deviceTable\(result\.devices,\s*\{ columnConfig: state\.inventoryColumnConfig, rowNumberOffset: \(result\.page - 1\) \* pageSize \}\)/);
});

test("temporal history gives each request its revision before async cache reads and rejects stale results", () => {
  const app = readFileSync("src/app.js", "utf8");
  const temporal = app.match(/async function renderTemporalStatistics\(force = false\) \{[\s\S]*?\n\}\n\nfunction paintTemporalStatistics/)?.[0] || "";
  const revisionIndex = temporal.indexOf("const revision = ++state.temporalRevision");
  const cacheReadIndex = temporal.indexOf("await database.loadAnalyticsCache");
  assert.ok(revisionIndex >= 0 && revisionIndex < cacheReadIndex, "request order must be recorded before the first asynchronous cache read");
  assert.match(temporal, /await database\.loadAnalyticsCache\([\s\S]*?if \(revision !== state\.temporalRevision\) return;[\s\S]*?cached\?\.windowSignature/);
  assert.match(temporal, /await database\.clearExpiredAnalyticsAggregateQueries\("temporal:"\);\s*if \(revision !== state\.temporalRevision\) return;/);
  assert.match(temporal, /await accumulator\.startSnapshot\(snapshot\);\s*if \(revision !== state\.temporalRevision\) return;/);
  assert.match(temporal, /await accumulator\.finish\(\);\s*if \(revision !== state\.temporalRevision\) return;\s*await database\.saveAnalyticsCache/);
  assert.match(temporal, /await database\.saveAnalyticsCache\([\s\S]*?if \(revision !== state\.temporalRevision\) return;\s*state\.temporalStatistics = result/);
});

test("paged comparison details retain only the currently displayed report", () => {
  const app = readFileSync("src/app.js", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  assert.match(app, /function pagedComparisonContent\(comparison\)\s*\{\s*state\.comparisonViews\.clear\(\);\s*const viewId/);
  for (const key of ["modified", "absent", "unchanged"]) {
    assert.equal((app.match(new RegExp(`${key}: \\(\\) => selectDashboardKpiStatus\\("${key}", analytics\\)`, "g")) || []).length, 2);
  }
  for (const key of ["manufacturers", "rooms"]) {
    assert.equal((app.match(new RegExp(`${key}: \\(\\) => showDashboardAggregateDialog\\("${key}", analytics\\)\\.catch\\(showError\\)`, "g")) || []).length, 2);
  }
  assert.match(app, /function showDashboardAggregateDialog\(key, analytics\)[\s\S]*?dashboardAggregateDialogContent\(items, \{ field, offset: 0 \}\)/);
  assert.match(app, /data-dashboard-aggregate-page[\s\S]*?dashboardAggregateDialogContent\(detail\.items, detail\)/);
  assert.match(app, /data-dashboard-aggregate-filter[\s\S]*?saveAnalyticsDashboardSettings\(\{ \.\.\.state\.analyticsDashboardSettings, filters \}\)/);
  assert.equal((app.match(/devices: \(\) => \{\s*selectDashboardKpiStatus\("devices", analytics\);\s*showDashboardFleetDialog\(analytics\)\.catch\(showError\);/g) || []).length, 2);
  assert.match(app, /function showDashboardFleetDialog\(analytics\)[\s\S]*?buildDashboardFleetSeries\(analytics, state\.snapshotMetadata\)/);
  assert.match(app, /function selectDashboardKpiStatus\(key, analytics = state\.analytics\)\s*\{\s*const status = dashboardStatusForKpi\(key\)/);
  const kpiStatusHandler = app.match(/function selectDashboardKpiStatus\(key, analytics = state\.analytics\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(kpiStatusHandler, /saveAnalyticsDashboardSettings\([\s\S]*?\.then\(async \(\) => \{\s*if \(state\.analytics !== analytics\) return;\s*if \(key === "modified"\) await showAnalyticsModificationPage\(analytics, 0, false, true\);\s*if \(key === "absent"\) await showAnalyticsAbsencePage\(analytics, 0, true\);\s*if \(key === "unchanged"\) await renderAnalyticsUnchangedPage\(analytics, 0, true\);\s*return renderAnalytics\(true\);/);
  assert.doesNotMatch(kpiStatusHandler, /changeReportSettings\.mode/);
  assert.match(app, /async function loadDashboardAbsencePage\(analytics, offset = 0, limit = 100, sharedRequestId = null\)/);
  assert.match(app, /async function loadDashboardChangeGroupPage\(analytics, category, offset = 0, limit = 100\)/);
  assert.match(app, /const comparePage = kind === "added"[\s\S]*?compareFinalModificationEventPage : kind === "unchanged" \? compareFinalUnchangedPage : compareFinalAbsencePage/);
  assert.match(app, /const result = await comparePage\(\s*previousDevices/);
  assert.match(app, /if \(kind === "allDevices"\) \{\s*const result = await compareFinalDevicePage\(\s*\(visit\) => database\.forEachSnapshotChunk\(currentId, visit\),\s*\{ offset, limit, deviceMatches:/);
  assert.match(app, /async function loadDashboardAdditionPage\(analytics, offset = 0, limit = 100, sharedRequestId = null\)/);
  assert.match(app, /async function loadDashboardModificationPage\(analytics, offset = 0, limit = 100, options = \{\}\)/);
  assert.match(app, /async function renderAnalyticsUnchangedPage\(analytics = state\.analytics, offset = 0, dialog = false\)[\s\S]*?const pageAttribute = dialog \? "data-analytics-unchanged-page"/);
  assert.match(app, /const unchangedPage = event\.target\.closest\("\[data-analytics-unchanged-page\]"\)[\s\S]*?renderAnalyticsUnchangedPage\(state\.analytics, Number\(unchangedPage\.dataset\.analyticsUnchangedPage\) \|\| 0, true\)/);
  assert.match(app, /async function loadDashboardComparisonPage\(analytics, kind, offset = 0, limit = 100, options = \{\}, sharedRequestId = null\)/);
  assert.match(app, /compareFinalAdditionPage[\s\S]*compareFinals/);
  assert.match(app, /compareFinalModificationEventPage[\s\S]*compareFinals/);
  assert.match(app, /if \(baselineIndex > 0 && baselineId !== currentId\)/);
  assert.equal((app.match(/codecChanges: \(\) => showAnalyticsModificationPage\(analytics, 0, true\)\.catch\(showError\)/g) || []).length, 2);
  assert.match(app, /data-analytics-modified-page=/);
  assert.match(app, /const missingModificationOffsets = page\.rows/);
  assert.match(renderer, /const absentPage = absent\.slice\(absentStart/);
  assert.match(renderer, /data-analytics-absence-page=/);
  assert.doesNotMatch(app, /comparisonViews\.size > 32/);
});

test("enrichment reads the previous Final as a compact chunked projection", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /previous = await loadCompactSnapshot\(activeSnapshotId, \(id, visit\) => database\.forEachSnapshotChunk\(id, visit\), \{ mutateDetachedChunks: true \}\)/);
  assert.doesNotMatch(app, /previous = await database\.activeSnapshot\(\)/);
});

test("enrichment releases Smartroom and DDIO lookup indexes immediately after their last application", () => {
  const enrichment = readFileSync("src/core/enrichment.js", "utf8");
  const roomLookup = enrichment.slice(enrichment.indexOf("const currentRoomIndex ="), enrichment.indexOf("await progress(58, \"Использование предыдущего Final\")"));
  assert.match(roomLookup, /for \(const device of devices\) if \(applySmartroomRoom\(device, currentRoomIndex,[\s\S]*?currentRoomIndex\.clear\(\)/);
  const ddioLookup = enrichment.slice(enrichment.indexOf("const ddioIndex = ddio.index"), enrichment.indexOf("await progress(82, \"Производители и модели\")"));
  assert.match(ddioLookup, /for \(const device of devices\) if \(applyDdIoIp\(device, ddioIndex\)\)[\s\S]*?ddioIndex\.clear\(\)[\s\S]*?ddioIndex\.byDeviceId\.clear\(\)/);
});

test("MAC chronology pages saved history events and merges them into calculated Final transitions without collecting history", () => {
  const app = readFileSync("src/app.js", "utf8");
  const comparison = readFileSync("src/core/comparison.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  assert.match(app, /async function openMacHistory\(\)/);
  assert.match(app, /createMacTimelineAccumulator\(mac\)/);
  assert.match(app, /timeline\.addSnapshot\(metadata, matches\)/);
  assert.match(app, /timeline\.addHistory\(item, orderedSnapshots\)/);
  assert.doesNotMatch(app.match(/async function openMacHistory\(\) \{([\s\S]*?)\n\}/)?.[1] || "", /snapshots\.push\(/);
  assert.match(comparison, /export function createMacTimelineAccumulator\(mac\)/);
  assert.match(app, /database\.forEachMacHistoryPage\(mac, \(page\) =>/);
  assert.match(app, /renderMacHistory\(events\)/);
  assert.match(html, /id="macTimelineSummary"/);
  assert.match(html, /id="macAppearancesPanel"/);
  assert.match(renderer, /export function macTimelineSummaryContent\(/);
  assert.match(renderer, /export function macTimelineAppearancesContent\(/);
  assert.match(renderer, /data-mac-appearance-page=/);
  assert.match(renderer, /export function macTimelineContent\(events = \[\], \{ page = 1, pageSize = 100 \}/);
  assert.match(renderer, /data-mac-timeline-page=/);
  assert.match(app, /renderMacHistory\(events\)/);
  assert.match(app, /macTimelineContent\(events, \{ page: timelinePage, pageSize: 100 \}\)/);
  assert.match(app, /pageSize: 100/);
  assert.doesNotMatch(app, /const storedHistory = \[\]/);
});

test("device appearance history retains only fields consumed by its tables and exports", () => {
  const app = readFileSync("src/app.js", "utf8");
  const moduleSource = readFileSync("src/core/device-analytics.js", "utf8");
  assert.match(app, /device: match\.device \? compactDeviceAppearance\(match\.device\) : null/);
  assert.match(moduleSource, /export function compactDeviceAppearance\(device = \{\}\)/);
  assert.match(moduleSource, /const APPEARANCE_DEVICE_FIELDS = Object\.freeze\(\[/);
  const stats = moduleSource.slice(moduleSource.indexOf("export function deviceAnalyticsHistoryStats"), moduleSource.indexOf("export function deviceAnalyticsTxt"));
  assert.doesNotMatch(stats, /\.map\(|\.filter\(/);
  assert.match(stats, /for \(const row of appearances\)/);
});

test("Final analytics change table exposes accessible category tabs with per-event paging", () => {
  const app = readFileSync("src/app.js", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  assert.match(app, /function renderAnalyticsChangeCategories\(/);
  assert.match(app, /dashboardChangeDeviceGroupsContent\(page\.rows\)/);
  assert.match(app, /loadDashboardChangeGroupPage\(analytics, selected, offset, 100\)/);
  assert.match(app, /kind === "modifiedGroups" \? compareFinalModificationDeviceGroupPage/);
  assert.match(app, /\["all", "critical", "modified"\]\.includes\(selected\)/);
  assert.match(app, /criticalModifiedDeviceCount/);
  assert.match(app, /Группы изменений не совпали с точным количеством событий/);
  assert.match(renderer, /export function dashboardChangeDeviceGroupsContent\(/);
  assert.match(renderer, /<details class="change-device-group">/);
  assert.match(renderer, /device\.address/);
  assert.match(app, /data-change-category=/);
  assert.match(app, /pageComparisonChanges\(comparison, selected, \{ offset, limit: 100 \}\)/);
  assert.match(app, /addEventListener\("keydown", \(event\) => \{/);
  assert.match(app, /data-change-page=/);
  assert.match(app, /const reportUsesPeriod = state\.changeReportSettings\.mode === "period"/);
  assert.match(app, /if \(category === undefined && !reportUsesPeriod\) return renderAnalyticsStatusRoster\(analytics, defaultStatus, 0\)/);
  assert.match(app, /async function renderAnalyticsStatusRoster\(/);
  assert.match(app, /data-status-roster-page=/);
});

test("change report mode is loaded from and saved to IndexedDB instead of reverting to Final comparison", () => {
  const app = readFileSync("src/app.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /id="changeReportModeSelect"[\s\S]*?value="period"/);
  assert.match(app, /getSetting\("changeReportSettings", \{\}\)/);
  assert.match(app, /setSetting\("changeReportSettings", state\.changeReportSettings\)/);
  assert.match(app, /if \(reportUsesPeriod\) return renderPeriodChangeCategory\(selected\)/);
  assert.match(app, /periodHistoryFilters\(category, settings, dashboardFilters\)/);
  assert.match(app, /JSON\.stringify\(\[settings\.from, settings\.to, dashboardFilters\.query, dashboardFilters\.manufacturer, dashboardFilters\.room, state\.temporalDataRevision\]\)/);
  assert.match(app, /database\.historySearchPage\(periodHistoryFilters\(category, settings, dashboardFilters\), \{ cursor: current\.cursor, limit: 100 \}\)/);
});

test("historical address evidence is read in bounded lookup and UI pages", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(database, /async forEachSwitchAddressEvidenceForIps\(ips = \[\], visit = \(\) => \{\}\)[\s\S]*?index\.openCursor\(IDBKeyRange\.only\(ip\)\)/);
  assert.doesNotMatch(database, /switchAddressEvidence\(\)[\s\S]*?getAll\(\)/);
  assert.match(app, /createHistoricalAddressAccumulator\(\)/);
  assert.match(app, /summarizeHistoricalAddressDevices\(result\.devices\)/);
  assert.match(app, /summarizeAppliedSmartroomMappings\(result\.devices\)/);
  assert.match(app, /database\.forEachSwitchAddressEvidenceForIps\(ips, \(record\) => accumulator\.add\(record\)\)/);
  assert.match(database, /async switchAddressEvidenceIpsPage\(offset = 0, limit = 100, candidateIps = null\)[\s\S]*?openKeyCursor\(null, "nextunique"\)/);
  assert.match(database, /candidateIps = null\)[\s\S]*?candidates\.has\(cursor\.key\)/);
  assert.match(app, /loadHistoricalAddressIndex: async \(ips\)/);
  assert.doesNotMatch(app, /database\.forEachSwitchAddressEvidence\(\(record\)/);
  assert.match(app, /retainHistoricalAddressIndex: false/);
  assert.match(app, /async function loadHistoricalAddressDetailsPage\(candidateIps, offset = 0, limit = 100\)[\s\S]*?switchAddressEvidenceIpsPage\(offset, limit, candidateIps\)/);
  const historicalAddress = app.match(/function historicalAddressDetails\([\s\S]*?(?=function historicalSmartroomDetails)/)?.[0] || "";
  assert.match(historicalAddress, /function historicalAddressDetails\(appliedCount, page\)/);
  assert.doesNotMatch(historicalAddress, /\.values\(\)/);
  assert.match(historicalAddress, /loadHistoricalAddressDetailsPage\(candidateIps, nextOffset\)/);
  assert.match(app, /bindHistoricalAddressPager\(\$\("#enrichmentSummary \[data-historical-address-details\]"\)/);
});

test("learned models are fetched by exact MAC for missing model fields instead of loading the full store", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const enrichment = readFileSync("src/core/enrichment.js", "utf8");
  assert.match(database, /async knownModelsForMacs\(macs = \[\]\)[\s\S]*?store\.get\(mac\)/);
  assert.doesNotMatch(database, /async knownModels\(\)[\s\S]*?getAll\(\)/);
  assert.match(app, /loadKnownModels: \(macs\) => database\.knownModelsForMacs\(macs\)/);
  assert.match(enrichment, /KNOWLEDGE_LOOKUP_BATCH_SIZE = 500/);
  assert.match(enrichment, /applyKnowledgeLookupBatches\([\s\S]*?\(device\) => !text\(device\.model\)/);
});

test("historical Smartroom room mappings are fetched only for devices needing a room", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const enrichment = readFileSync("src/core/enrichment.js", "utf8");
  assert.match(database, /async smartroomRoomMappingsForIds\(ids = \[\]\)[\s\S]*?store\.get\(key\)/);
  assert.match(database, /INDEXED_DB_KEY_READ_BATCH_SIZE = 250/);
  assert.match(database, /getByKeysInBatches\(db, "smartroomRoomMappings", keys\)/);
  assert.match(app, /loadHistoricalRoomIndex: async \(ids\) => buildSmartroomRoomIndex\(await database\.smartroomRoomMappingsForIds\(ids\)\)/);
  assert.match(enrichment, /async function loadDeviceIndexInBatches\(devices, needsLookup, keyFor, loadIndex, \{ retain = true, apply = null, pageKeyFor = null \} = \{\}\)[\s\S]*?offset \+= KNOWLEDGE_LOOKUP_BATCH_SIZE[\s\S]*?keys\.add\(key\)[\s\S]*?loadIndex\(\[\.\.\.keys\]\)[\s\S]*?pageKeyFor\(key\)/);
  assert.match(enrichment, /loadDeviceIndexInBatches\([\s\S]*?\(device\) => !text\(device\.room\) && text\(device\.smartroomId\)/);
  assert.match(enrichment, /loadDeviceIndexInBatches\([\s\S]*?\(device\) => !text\(device\.address\) && text\(device\.switchIp\)/);
  assert.doesNotMatch(app, /buildSmartroomRoomIndex\(await database\.smartroomRoomMappings\(\)\)/);
});

test("conflicting imported Smartroom room mappings remain visible in the enrichment summary", () => {
  const app = readFileSync("src/app.js", "utf8");
  const mapping = readFileSync("src/core/historical-mapping.js", "utf8");
  const enrichment = readFileSync("src/core/enrichment.js", "utf8");
  assert.match(mapping, /status: value\.rooms\.size === 1 \? "confirmed" : "review"/);
  assert.match(mapping, /mapping\.status !== "confirmed"/);
  assert.match(enrichment, /importedSmartroomRoomIndex: retainSmartroomRoomEvidence \? effectiveImportedRoomIndex : null/);
  assert.match(enrichment, /retain: retainRoomEvidence,[\s\S]*?apply: retainRoomEvidence \? null : \(device, suggestion\)/);
  assert.match(enrichment, /retain: retainRoomEvidence,[\s\S]*?apply: retainRoomEvidence \? null : \(device, mapping\)/);
  assert.match(app, /retainSmartroomRoomEvidence: includeSwitchIpReport/);
  assert.match(app, /function importedSmartroomDetails\(index, appliedCount, offset = 0, expanded = false\)/);
  assert.match(app, /function bindMappingIndexPager\(container, selector, dataKey, renderPage\)/);
  assert.match(app, /mappingIndexPage\(index, \{ offset, limit: 100 \}\)/);
  assert.match(app, /page\.reviewCount\.toLocaleString\("ru-RU"\)/);
  assert.match(app, /Конфликт · нужна проверка/);
  assert.match(app, /importedSmartroomDetails\(result\.importedSmartroomRoomIndex, appliedSmartroomSummary\.importedCount\)/);
});

test("custom MAC5 rules are fetched by current MAC prefixes instead of loading the full rule store", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const enrichment = readFileSync("src/core/enrichment.js", "utf8");
  assert.match(database, /async mac5ModelsForMacs\(macs = \[\]\)[\s\S]*?store\.get\(prefix\)/);
  assert.match(app, /loadMac5Models: \(macs\) => database\.mac5ModelsForMacs\(macs\)/);
  assert.match(enrichment, /await loadMac5Models\(macs\)/);
  assert.doesNotMatch(app, /new Map\(\(await database\.mac5Models\(\)\)/);
});

test("custom OUI prefixes are fetched only for current devices missing a vendor", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const enrichment = readFileSync("src/core/enrichment.js", "utf8");
  assert.match(database, /async ouiIndexForMacs\(macs = \[\]\)[\s\S]*?store\.get\(prefix\)/);
  assert.doesNotMatch(database, /async ouiIndex\(\)[\s\S]*?getAll\(\)/);
  assert.match(app, /loadOuiIndex: async \(macs\) => vendorDetectorSettings\.enabled && vendorDetectorSettings\.useOui3[\s\S]{0,180}createOuiIndexOverlay\(bundledOuiIndex, await database\.ouiIndexForMacs\(macs\)\)/);
  assert.match(enrichment, /applyKnowledgeLookupBatches\([\s\S]*?\(device\) => !text\(device\.manufacturer\)/);
});

test("every delimited import screen allows TXT files", () => {
  const html = readFileSync("index.html", "utf8");
  for (const id of [
    "singleFileInput", "compareFile0Input", "compareFile1Input", "multiCompareFilesInput",
    "mainFileInput", "smartroomFileInput", "ddioFileInput", "batchMainInput", "batchSmartroomInput", "batchDdIoInput",
  ]) {
    const input = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] || "";
    assert.match(input, /accept="[^"]*\.txt/ , `${id} must allow TXT files`);
  }
});

test("single-file XLSX analysis exposes a selectable worksheet", () => {
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /id="singleSheetPicker"[\s\S]*?id="singleSheetSelect"/);
});

test("single-file ambiguity UI uses the escaped bounded candidate comparison", () => {
  const app = readFileSync("src/app.js", "utf8");
  const render = readFileSync("src/ui/render.js", "utf8");
  assert.match(app, /identityCandidateComparisonMarkup\(item\.device, item\.candidates, \{ incomingLabel: "Строка файла" \}\)/);
  assert.match(render, /normalized\.length > 300/);
  assert.match(render, /escapeHtml\(incomingValue \|\| "—"\)/);
});

test("single-file analysis history persists, searches, restores, exports, and deletes saved reports", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  for (const id of ["toggleSingleAnalysisHistoryButton", "singleAnalysisHistoryForm", "singleAnalysisHistoryRows", "previousSingleAnalysisHistoryPage", "nextSingleAnalysisHistoryPage"]) assert.match(html, new RegExp(`id="${id}"`));
  const historyToggle = /\$\("#toggleSingleAnalysisHistoryButton"\)\.addEventListener\("click", \(\) => \{([\s\S]*?)\n  \}\)/.exec(app)?.[1] || "";
  assert.match(historyToggle, /renderSingleAnalysisHistory\(\)\.catch\(showError\)/);
  assert.match(app, /database\.saveSingleAnalysis\(\{ filename: file\.name, sheetName: state\.singleFile\.sheetName, result, processedAt, finalSnapshotId: finalSnapshot\.id \}\)/);
  assert.match(app, /database\.listSingleAnalyses\(\{ query: history\.query, page: history\.page, limit: 25 \}\)/);
  assert.match(app, /database\.loadSingleAnalysis\(id\)/);
  assert.match(app, /database\.deleteSingleAnalysis\(id\)/);
  assert.match(database, /async saveSingleAnalysis\(/);
  assert.match(database, /async loadSingleAnalysis\(/);
});

test("two-file comparison exposes CSV, JSON, Excel, and TXT exports", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  for (const [id, label] of [
    ["exportFileCompareCsvButton", "Экспорт CSV"],
    ["exportFileCompareJsonButton", "Экспорт JSON"],
    ["exportFileCompareXlsxButton", "Экспорт Excel"],
    ["exportFileCompareTxtButton", "Экспорт TXT"],
  ]) assert.match(html, new RegExp(`id="${id}"[^>]*>${label}`));
  const csvHandler = /exportFileCompareCsvButton"\)\.addEventListener\("click", async \(\) => \{([\s\S]*?)\n  \}\);/.exec(app)?.[1] || "";
  assert.match(csvHandler, /streamFromAsyncIterable\(fileComparisonCsvChunksFromDevices\(analysis\.before\.devices, analysis\.after\.devices, analysis\.comparison\.timestamp, state\.ouiFormats\)\)/);
  assert.match(app, /comparison: compareFinals\(before\.devices, after\.devices, new Date\(\)\.toISOString\(\), \{[\s\S]*?collectRows: false,[\s\S]*?includeDiagnosticRows: false,[\s\S]*?\}\)/);
  const runFileCompare = /async function runFileCompare\(\) \{([\s\S]*?)\n\}/.exec(app)?.[1] || "";
  assert.match(runFileCompare, /assertFilePairCapacity\(state\.fileCompare\.files\)/);
  assert.ok(runFileCompare.indexOf("assertFilePairCapacity(state.fileCompare.files)") < runFileCompare.indexOf("analyzeFileCompareInput(0"), "preflight both complete source files before building the first device roster");
  const fileCompareAnalyzer = /async function analyzeFileCompareInput\([\s\S]*?\n\}/.exec(app)?.[0] || "";
  for (const [option, value] of [["retainSourceRows", "false"], ["retainDiagnosticSamples", "false"], ["compactDevices", "true"]]) {
    assert.match(fileCompareAnalyzer, new RegExp(`${option} = ${value}`), `file comparison defaults ${option} to ${value}`);
  }
  assert.match(app, /async function runFileCompare\(\)[\s\S]*?analyzeFileCompareInput\(0, \{ controller, stageStart: 2 \}\)[\s\S]*?analyzeFileCompareInput\(1, \{ controller, stageStart: 50 \}\)/);
  assert.match(app, /function streamFromAsyncIterable\(iterable\)\s*\{\s*return readableTextStreamFromIterable\(iterable\);/);
  assert.match(app, /result\.unchangedCount \?\? result\.unchanged\.length/);
  for (const format of ["Json", "Xlsx", "Txt"]) {
    const handler = new RegExp(`exportFileCompare${format}Button"\\)\\.addEventListener\\("click"[\\s\\S]*?\\n  \\}\\);`).exec(app)?.[0] || "";
    assert.match(handler, format === "Json" ? /fileComparisonJsonFromDevices\(before\.devices, after\.devices, summaryComparison\)/
      : format === "Xlsx" ? /fileComparisonXlsxRows\(analysis\)/ : /fileComparisonTxtChunks\(analysis\)/, `${format} export streams comparison rows from source devices`);
    if (format === "Json") {
      assert.match(handler, /analyzeFileCompareInput\(0,[\s\S]*?retainSourceRows: false,[\s\S]*?retainDiagnosticSamples: true,[\s\S]*?compactDevices: false/);
      assert.match(handler, /analyzeFileCompareInput\(1,[\s\S]*?retainSourceRows: false,[\s\S]*?retainDiagnosticSamples: true,[\s\S]*?compactDevices: false/);
      assert.match(handler, /fullExportAnalysis = \{ \.\.\.analysis, before, after, comparison, ouiFormats: state\.ouiFormats \};[\s\S]*?return fullExportAnalysis/);
    }
  }
  assert.match(csvHandler, /showSaveFilePicker/);
  assert.match(csvHandler, /writeReadableStreamToWritable\(stream, await handle\.createWritable\(\)\)/);
  assert.doesNotMatch(csvHandler, /const records\s*=\s*\[/);
  const resultRenderer = /function renderFileCompareResult\(analysis\) \{([\s\S]*?)\n\}/.exec(app)?.[1] || "";
  assert.match(resultRenderer, /fileComparisonRowsPagesFromDevices\(before\.devices, after\.devices, result/);
  assert.match(resultRenderer, /ambiguousPage\.rows\.map/);
  assert.doesNotMatch(resultRenderer, /\[\.\.\.fileComparisonExportRows/);
  assert.match(app, /FILE_COMPARE_PAGE_SIZES = \[25, 50, 100, 250, 500, 1_000\]/);
  assert.match(app, /data-file-comparison-page/);
  assert.match(app, /data-file-comparison-page-size/);
});

test("IP mapping import exposes manual switch-IP and address column selection", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(html, /id="ipMappingImportPanel"/);
  assert.match(app, /id="ipMappingImportSwitchColumn"/);
  assert.match(app, /id="ipMappingImportAddressColumn"/);
  assert.match(app, /importIpMappings\(file,\s*\{/);
});

test("IP mapping deletion reads and writes the current settings value atomically", () => {
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const renderer = /async function renderIpMappings\(\) \{([\s\S]*?)\n\}\n\nasync function prepareIpMappingImport/.exec(app)?.[1] || "";
  assert.match(renderer, /database\.deleteIpAddressMapping\(button\.dataset\.deleteIpMapping\);\s*await renderIpMappings\(\);\s*await synchronizeDataDirectoryArchive\(\)[\s\S]*?catch\(showError\)/);
  assert.match(database, /async deleteIpAddressMapping\(switchIp\)[\s\S]*?settings\.get\("ipAddressMappings"\)[\s\S]*?settings\.put\(\{ key: "ipAddressMappings", value: serializable\(mappings\) \}\)/);
});

test("IP mapping imports and auto-detection merge atomically without losing concurrent or manual rules", () => {
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(app, /database\.mergeIpAddressMappings\(\[\.\.\.imported\.values\(\)\]\)/);
  assert.match(app, /database\.mergeIpAddressMappings\(detected, \{ overwriteExisting: false \}\)/);
  assert.match(database, /async mergeIpAddressMappings\(records, \{ overwriteExisting = true \} = \{\}\)[\s\S]*?settings\.get\("ipAddressMappings"\)[\s\S]*?if \(overwriteExisting \|\| !byIp\.has\(item\.switchIp\)\)[\s\S]*?settings\.put\(\{ key: "ipAddressMappings", value: serializable\(merged\) \}\)/);
});

test("source mapping review shows confidence, sample evidence and strong identity guidance", () => {
  const app = readFileSync("src/app.js", "utf8");
  const importer = readFileSync("src/data/importer.js", "utf8");
  assert.match(app, /detectMappingReport\(table\.headers, table\.rows, role\)/);
  assert.match(app, /batchMappingProblems\("main", state\.mappings\.main,/);
  assert.match(app, /Проверьте сопоставление перед обогащением/);
  assert.match(app, /совпадение \$\{detail\?\.recommendedConfidence/);
  assert.match(app, /примеры:/);
  assert.match(app, /Сильный идентификатор не выбран/);
  assert.match(importer, /export function detectMappingReport/);
  assert.match(importer, /validDdIoPair/);
});

test("OUI import exposes manual prefix and vendor column selection", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const registry = readFileSync("src/core/ieee-registry.js", "utf8");
  assert.match(html, /id="ouiImportPanel"/);
  assert.match(app, /id="ouiPrefixColumn"/);
  assert.match(app, /id="ouiVendorColumn"/);
  assert.match(app, /importOui\(file,\s*\{/);
  assert.match(app, /prefix: normalizeOuiPrefix\(row\[prefixIndex/);
  assert.match(registry, /\[10, 9, 8, 7, 6\]/);
});

test("streamed OUI imports commit each normalized row batch without retaining the full file", () => {
  const app = readFileSync("src/app.js", "utf8");
  const importBody = app.match(/async function importOui\(file, columns\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(importBody, /for await \(const rows of readTableRowBatches\(file, \{ batchSize: 500 \}\)\)/);
  assert.match(importBody, /const records = ouiRecords\(\{ headers: table\.headers, rows \}, columns\);[\s\S]*?await database\.importOui\(records\);[\s\S]*?imported \+= records\.length/);
  assert.doesNotMatch(importBody, /records\.push\(\.\.\.ouiRecords/);
});

test("bundled IEEE seeding migrates by registry version in bounded batches without replacing local rules", () => {
  const app = readFileSync("src/app.js", "utf8");
  const initializeBody = app.match(/async function ensureBundledOui\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  const registryLoader = app.match(/async function loadBundledIeeeRegistry\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  const database = readFileSync("src/data/database.js", "utf8");
  const builder = readFileSync("scripts/build-portable.mjs", "utf8");
  assert.match(initializeBody, /const version = String\(registry\.metadata\.generatedAt\)/);
  assert.match(initializeBody, /previousVersion === "2026\.10" && currentOuiSource === "Встроенный IEEE OUI"[\s\S]*?overwriteSources\.push\("Пользовательский справочник"\)/);
  assert.match(initializeBody, /for \(const records of ieeeOuiRecordBatches\(registry, \{ batchSize: 500 \}\)\)/);
  assert.match(initializeBody, /database\.importOui\(records, \{ overwriteSources \}\)/);
  assert.match(initializeBody, /if \(!currentOuiSource\) await database\.setSetting\("ouiSource", "Встроенный IEEE OUI"\)/);
  assert.match(initializeBody, /setSetting\("bundledOuiVersion", version\)/);
  assert.match(registryLoader, /validateIeeeRegistry\(registry\)/);
  assert.ok(registryLoader.indexOf("validateIeeeRegistry(registry)") < registryLoader.indexOf("bundledIeeeRegistry = registry"));
  const ieeeCore = readFileSync("src/core/ieee-registry.js", "utf8");
  assert.match(ieeeCore, /export function validateIeeeRegistry\(registry = \{\}\)/);
  assert.match(ieeeCore, /expectedRows = \{ "6": counts\["MA-L"\], "7": counts\["MA-M"\], "9": counts\["MA-S"\] \+ counts\.IAB \}/);
  assert.match(ieeeCore, /source\.sha256/);
  assert.match(database, /async importOui\(records, \{ overwriteExisting = true, overwriteSources = null \} = \{\}\)[\s\S]*?const existing = await requestResult\(store\.get\(prefix\)\)[\s\S]*?overwriteSources\.includes\(text\(existing\.source\)\)/);
  assert.doesNotMatch(builder, /assets\/oui\.csv|__MAC_ANALYZER_OUI_CSV__/);
  assert.match(builder, /assets\/ieee-vendor-registry\.json/);
  assert.match(builder, /__MAC_ANALYZER_IEEE_REGISTRY__/);
});

test("Inventory view exposes full XLSX export with a progress status", () => {
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /id="exportInventoryXlsxButton"/);
  assert.match(html, /id="inventoryExportStatus"[^>]*aria-live="polite"/);
});

test("filtered Inventory CSV export streams keyset pages with the visible column set", () => {
  const app = readFileSync("src/app.js", "utf8");
  const actions = readFileSync("src/core/table-actions.js", "utf8");
  const exportBody = app.match(/async function exportSearchCsv\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(exportBody, /visibleInventoryColumns\(state\.inventoryColumnConfig\)/);
  assert.match(exportBody, /database\.inventoryPage\(\{ afterId, limit \}\)/);
  assert.match(exportBody, /matchesDeviceSearch\(device, search\)/);
  assert.match(exportBody, /readableTextStreamFromIterable\(iterable\)/);
  assert.match(exportBody, /writeReadableStreamToWritable\(stream/);
  assert.doesNotMatch(exportBody, /forEachInventory|const parts =|new Blob\(parts/);
  assert.match(actions, /page\.rows\[index\] = null/);
  assert.match(actions, /const chunk = `\$\{lines\.join\("\\r\\n"\)\}\\r\\n`/);
});

test("room chronology exposes comparison of the two latest Finals", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(html, /id="compareRoomFinalsButton"[^>]*>Сравнить два последних Final/);
  assert.match(html, /id="roomFinalComparison"/);
  assert.match(app, /async function loadRoomPairComparison\(pair\)[\s\S]*?compareFinals\(baseDevices, currentDevices, currentSnapshot\.createdAt\)/);
  assert.match(app, /state\.roomPair = \{ key, room, baseSnapshot: snapshots\.at\(-2\), currentSnapshot: snapshots\.at\(-1\) \}/);
  assert.match(app, /roomPairComparisonContent\(comparison, baseSnapshot, currentSnapshot, state\.roomPairPage\)/);
  assert.match(app, /data-room-timeline-snapshot/);
  assert.match(app, /\["roster", "changes", "added", "absent"\]/);
  assert.match(app, /state\.roomTimelinePages\[snapshotId\]\[section\] = page/);
  assert.equal((app.match(/carryForwardRoomDeviceFields\(knownRoomDevices, devices, \{ previousIsCompact: true \}\)/g) || []).length, 3);
  assert.match(app, /for \(const device of chunk\) if \(roomTimelineMatch\(device, key, room\)\) devices\.push\(device\)/);
  assert.match(app, /data-room-pair-page/);
  assert.match(readFileSync("src/ui/render.js", "utf8"), /comparisonContent\(\{ \.\.\.comparison, absent: \[\] \}, \{ offset: changesStart, limit: 20, viewId: `room-\$\{snapshotId\}`, showMore: false \}\)/);
  assert.match(readFileSync("src/ui/render.js", "utf8"), /const pageSize = 20;/);
});

test("portable build embeds licensed Chart.js and chart error states are present in the UI", () => {
  const build = readFileSync("scripts/build-portable.mjs", "utf8");
  const checker = readFileSync("scripts/check-portable-artifact.mjs", "utf8");
  const html = readFileSync("index.html", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  assert.match(build, /vendor\/chart\.umd\.min\.js/);
  assert.match(build, /licenses\/Chart\.js\.LICENSE\.md/);
  assert.match(build, /\$\{chartSource\}/);
  assert.match(build, /PORTABLE_WORKER_MODULES/);
  assert.match(build, /__MAC_ANALYZER_HISTORY_WORKER_SOURCE__/);
  assert.match(checker, /Chart\.js v4\.5\.1/);
  assert.match(html, /data-chart-state="weeklyChart" role="status"/);
  assert.match(renderer, /Ошибка: библиотека Chart\.js не загружена/);
  assert.match(renderer, /Нет данных для построения графика/);
});

test("history aggregation streams into its embedded worker and honors request cancellation", () => {
  const app = readFileSync("src/app.js", "utf8");
  const client = readFileSync("src/core/analytics-history-worker-client.js", "utf8");
  const worker = readFileSync("src/core/analytics-history-worker.js", "utf8");
  assert.match(app, /aggregateSnapshotHistoryInWorker\(metadata, visitHistoryChunks,\s*\{\s*isCurrent: \(\) => state\.analyticsRequests\.isCurrent\(revision\)/);
  assert.match(app, /if \(!history\) history = await aggregateSnapshotHistory\(metadata, visitHistoryChunks,\s*\{\s*filters: historyFilters\s*\}\)/);
  assert.match(client, /await visitSnapshotChunks\(snapshot\.id, async \(devices, chunkIndex\) =>/);
  assert.match(client, /worker\.terminate\?\.\(\)/);
  assert.match(client, /error\.name = "AbortError"/);
  assert.match(worker, /createFinalComparisonSummary\(current\.previousDevices, snapshot\.createdAt,\s*\{\s*deviceMatches: \(device\) => device\.__dashboardFilterMatch === true\s*\}\)/);
  assert.match(client, /devices\.map\(compactComparisonDevice\)/);
  assert.match(client, /matchedFilters = devices\.map\(\(device\) => dashboardDeviceMatchesFilters\(device, filters\)\)/);
});

test("opening analytics from a startup hash loads restored snapshots before painting the dashboard", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /if \(name === "analytics"\) \{\s*const force = state\.analyticsNeedsRefresh;[\s\S]*?renderAnalytics\(force\)\.catch\(/);
  assert.match(app, /await refreshDatabaseState\(\);[\s\S]*?const requestedView = location\.hash\.slice\(1\);[\s\S]*?const initial = allowedViews\.includes\(requestedView\) \? requestedView : state\.workspaceView;[\s\S]*?activateView\(initialView\);[\s\S]*?initializeLazyTabs\(\$\$\("\.view"\), initialView\)/);
  assert.match(app, /async function renderAnalytics\(force = false\)/);
  assert.match(readFileSync("src/ui/render.js", "utf8"), /export function drawBars\(canvas, items/);
});

test("Final analytics has a live status for restored historical comparison fields", () => {
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /id="analyticsHistoryFallback"[^>]*aria-live="polite"/);
});

test("context actions are delegated to non-Inventory device tables", () => {
  const app = readFileSync("src/app.js", "utf8");
  const css = readFileSync("styles.css", "utf8");
  assert.match(app, /document\.addEventListener\("click",[\s\S]*?selectContextTableRow\(row\)/);
  assert.match(app, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(app, /document\.addEventListener\("contextmenu",[\s\S]*?\[data-device-context-row\]/);
  assert.match(app, /selectContextTableRow\(row\);\s*const device = contextDeviceFromRow\(row\)/);
  assert.match(app, /document\.addEventListener\("keydown",[\s\S]*?event\.key !== "F10"/);
  assert.match(css, /\.data-table tr\.context-row-selected[^\n]*background: var\(--surface-soft\)/);
});

test("topology switch, port and device pages are connected to analytics controls", () => {
  const app = readFileSync("src/app.js", "utf8");
  const renderer = readFileSync("src/core/analytics-detail.js", "utf8");
  assert.match(renderer, /data-topology-switch-page=/);
  assert.match(renderer, /data-topology-port-page=/);
  assert.match(renderer, /data-topology-device-page=/);
  assert.match(renderer, /data-topology-load-device-page=/);
  assert.match(renderer, /data-topology-unassigned-page=/);
  assert.match(renderer, /data-topology-load-unassigned-page=/);
  assert.match(app, /\[data-topology-switch-page\]/);
  assert.match(app, /\[data-topology-port-page\]/);
  assert.match(app, /\[data-topology-device-page\]/);
  assert.match(app, /\[data-topology-unassigned-page\]/);
  assert.match(app, /database\.loadSnapshotDevicePage\(snapshotId, \{ switchIp, switchPort, page: page \+ 1, limit: 50 \}\)/);
  assert.match(app, /database\.loadSnapshotDevicePage\(snapshotId, \{ unassigned: true, page: page \+ 1, limit: 50 \}\)/);
  assert.match(app, /includeTopologyDevices: false/);
  assert.match(app, /details\.local-topology-node\[open\]/);
  assert.match(app, /details\.local-topology-port\[open\]/);
});

test("unassigned analytics details load bounded pages instead of retaining a full roster", () => {
  const app = readFileSync("src/app.js", "utf8");
  const analytics = readFileSync("src/core/analytics.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  assert.doesNotMatch(analytics, /unassignedDevices\s*=\s*devices\.filter/);
  assert.doesNotMatch(app, /analytics\.unassignedDevices/);
  assert.match(app, /database\.loadSnapshotUnassignedRoomPage\(snapshotId, \{ page, limit: 50, filters: analytics\.dashboardFilters \}\)/);
  assert.match(app, /\[data-unassigned-device-page\]/);
  assert.match(database, /async loadSnapshotUnassignedRoomPage/);
  assert.match(database, /if \(locationKey\(device\) \|\| !dashboardDeviceMatchesFilters\(device, filters\)\) continue/);
  assert.match(renderer, /data-unassigned-device-page=/);
});

test("room change coverage keeps counts and loads the complete roster from Final pages on demand", () => {
  const analytics = readFileSync("src/core/analytics.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  assert.match(analytics, /rosterCount: room\.rosterCount/);
  assert.doesNotMatch(analytics, /devices: room\.devices/);
  assert.match(app, /async function loadRoomCoveragePage\(analytics, roomKey, page\)/);
  assert.match(app, /database\.loadSnapshotRoomAnomalyPage\(snapshotId, \{ roomKey, page, limit: 100, filters: analytics\.dashboardFilters \}\)/);
  assert.match(app, /state\.analyticsRoomCoveragePages = \{ \[roomKey\]: \{ \.\.\.current, loading: true \} \}/);
  assert.match(app, /loadRoomCoveragePage\([\s\S]*?roomCoveragePageButton\.dataset\.roomCoveragePage/);
  assert.match(renderer, /data-room-coverage-page=/);
  assert.match(renderer, /deviceTable\(roster\)/);
});

test("normal XLSX enrichment selects a bounded preview and re-reads rows in batches", () => {
  const app = readFileSync("src/app.js", "utf8");
  const importer = readFileSync("src/data/importer.js", "utf8");
  assert.match(app, /readTablePreview\(file, \{ maxRows: 80 \}\)/);
  assert.match(app, /return readTableRowBatches\(file, \{/);
  assert.match(importer, /async function\* readTableRowBatches/);
  assert.match(importer, /yield batch/);
});

test("JSON source screens use bounded previews and the async row-batch reader", () => {
  const app = readFileSync("src/app.js", "utf8");
  const importer = readFileSync("src/data/importer.js", "utf8");
  assert.match(app, /isStreamableTableFile = .*json/);
  assert.match(app, /table\.preview && isStreamableTableFile\(file\)/);
  assert.match(importer, /if \(\/\\\.json\$\/i\.test\(file\.name\) && typeof file\.slice === "function"\)/);
  assert.match(importer, /yield\* jsonRowBatches\(file, \{ \.\.\.options, batchSize \}\)/);
});

test("multi-file comparison accepts JSON and streams it through the shared row-batch reader", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(html, /id="multiCompareFilesInput"[^>]*accept="[^"]*\.json/);
  assert.match(html, /id="exportAllMultiCompareButton"[^>]*>Экспорт всех пар XLSX/);
  assert.match(html, /id="exportAllMultiCompareCsvButton"[^>]*>Экспорт всех пар CSV/);
  assert.match(app, /if \(!isStreamableTableFile\(file\)\)/);
  assert.match(app, /entry\.preview\.preview && isStreamableTableFile\(entry\.file\)/);
  assert.match(app, /readTableRowBatches\(entry\.file, \{/);
  assert.match(app, /multiFileComparisonWorkbookSheets\(pairs, files, \(pair\) => loadMultiComparePair\(pair, \{ signal \}\), \{ signal \}\)/);
  assert.match(app, /showSaveFilePicker\(\{\s*suggestedName: filename,[\s\S]*?\.xlsx/);
  assert.match(app, /await writable\.write\(value\)/);
  assert.match(app, /exportAllMultiCompareCsvButton.*exportAllMultiComparePairsCsv/);
  assert.match(app, /multiFileComparisonRowsPage\(pair, result, \{ offset: \(state\.multiCompare\.page - 1\) \* state\.multiCompare\.pageSize, limit: state\.multiCompare\.pageSize \}\)/);
  const pairSelector = app.match(/function renderMultiCompareState\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(pairSelector, /value="\$\{escapeHtml\(pair\.id\)\}"/);
  assert.match(pairSelector, /escapeHtml\(files\[pair\.first\]\.file\.name\)/);
  assert.match(pairSelector, /escapeHtml\(files\[pair\.second\]\.file\.name\)/);
  assert.match(app, /MULTI_COMPARE_PAGE_SIZES = \[25, 50, 100, 250, 500, 1_000\]/);
  assert.match(app, /data-multi-compare-page-size/);
  assert.match(app, /data-multi-compare-page/);
  assert.doesNotMatch(app.match(/function renderMultiCompareResult\(result\) \{([\s\S]*?)\n\}/)?.[1] || "", /comparisonRows\(/);
  assert.match(app, /async function exportAllMultiComparePairsCsv\(\)[\s\S]*?pairwiseComparisonCsvChunks\(result\.pair, result\)/);
  assert.match(app, /readableTextStreamFromIterable\(chunks, \{ signal \}\)/);
  assert.match(app, /writeReadableStreamToWritable\(stream, writable, \{ signal \}\)/);
  assert.match(app, /new globalThis\.Response\(stream\)\.blob\(\)/);
  assert.match(app, /async function runMultiCompareCancellable\(title, action\)[\s\S]*?state\.controller = controller;[\s\S]*?controller\.signal\.aborted/);
  assert.match(app, /readTableRowBatches\(entry\.file, \{\s*batchSize: 500,\s*signal,/);
  assert.match(app, /function cancelActiveProcess\(\)\s*\{\s*return abortActiveControllers\(\[state\.controller, state\.singleFileController, state\.fileCompare\.controller\]\)/);
  assert.match(app, /escape: \(\) => \{[\s\S]*?escapeActionTarget\([\s\S]*?errorVisible: !\$\("#errorBanner"\)\.hidden[\s\S]*?target === "error"\) dismissErrorBanner/);
  assert.match(app, /if \(shortcut === "escape"\) \{\s*if \(action\(\)\) event\.preventDefault\(\);\s*return;/);
  assert.match(app, /return abortActiveControllers\(\[state\.controller, state\.singleFileController, state\.fileCompare\.controller\]\)/);
  assert.match(app, /cancelProcessButton"\)\.addEventListener\("click", cancelActiveProcess\)/);
  assert.match(app, /async function runSingleFileAnalysis\(\)[\s\S]*?runSingleFileAnalysisTask\([\s\S]*?finally\s*\{[\s\S]*?runSingleAnalysisButton/);
  assert.match(app, /async function runFileCompare\(\)[\s\S]*?finally\s*\{[\s\S]*?runFileCompareButton/);
});

test("device history exposes a streaming XLSX export backed by paged IndexedDB events", () => {
  const app = readFileSync("src/app.js", "utf8");
  const analytics = readFileSync("src/core/device-analytics.js", "utf8");
  assert.match(analytics, /data-export-device-analytics-xlsx/);
  assert.match(analytics, /data-export-device-analytics-txt/);
  assert.match(analytics, /deviceAnalyticsXlsxSheets/);
  assert.match(app, /data-export-device-analytics-xlsx/);
  assert.match(app, /data-export-device-analytics-txt/);
  assert.match(app, /deviceAnalyticsTxt\(payload\)/);
  assert.match(app, /database\.historyPage\(device\.id, \{ cursor, limit: 500 \}\)/);
  assert.match(app, /createXlsxWorkbookStream\(deviceAnalyticsXlsxSheets\(payload, historyRows\)\)/);
});

test("device analytics can delete that device's event history without changing its Final or Inventory", () => {
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const analytics = readFileSync("src/core/device-analytics.js", "utf8");
  assert.match(analytics, /data-delete-device-history/);
  assert.match(app, /database\.deleteDeviceHistoryEvents\(current\.device\.id\)/);
  assert.match(app, /Появления в Final, снимки Final и Inventory сохранятся/);
  assert.match(database, /async deleteDeviceHistoryEvents\(deviceId\)/);
  assert.match(database, /index\.openCursor\(IDBKeyRange\.only\(String\(deviceId\)\)\)/);
});

test("device analytics HTML export emits appearance rows in bounded batches", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /deviceAnalyticsHtmlOpening\(payload\)/);
  assert.match(app, /const appearancePageSize = 100/);
  assert.match(app, /payload\.appearances\.slice\(offset, offset \+ appearancePageSize\)/);
  assert.match(app, /deviceAnalyticsHtmlAppearanceRows\(/);
  assert.match(app, /deviceAnalyticsHtmlAfterAppearances\(payload\)/);
});

test("device analytics constructs its strong identity matcher once per selected device", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /const matchesDevice = createStrongIdentityMatcher\(device\);\s*for \(const metadata of state\.snapshotMetadata\)[\s\S]*?forEachSnapshotChunk\(metadata\.id, \(rows\) => \{[\s\S]*?if \(!matchesDevice\(item\)\) continue;/);
  assert.doesNotMatch(app, /if \(!sharesStrongDeviceIdentity\(device, item\)\) continue/);
});

test("device history appends each cursor page and retains only that page in the analytics payload", () => {
  const app = readFileSync("src/app.js", "utf8");
  const loader = app.match(/async function loadMoreDeviceHistory\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(loader, /current\.history = added/);
  assert.match(loader, /current\.historyLoading\) return/);
  assert.match(loader, /current\.historyLoading = true/);
  assert.match(loader, /button\.disabled = true/);
  assert.match(loader, /finally \{[\s\S]*?current\.historyLoading = false/);
  assert.match(loader, /current\.historyShown = Number\(current\.historyShown \?\? current\.history\.length\) \+ added\.length/);
  assert.match(loader, /historyRows\.insertAdjacentHTML\("beforeend", deviceAnalyticsHtmlHistoryRows\(added\)\)/);
  assert.doesNotMatch(loader, /\[\.\.\.current\.history/);
  assert.doesNotMatch(loader, /innerHTML = deviceAnalyticsContent/);
});

test("history screen exposes global MAC, event, field, source and date filters with paging", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  assert.match(html, /id="historyLogFilters"/);
  for (const filter of ["query", "mac", "type", "field", "source", "manufacturer", "model", "room", "from", "fromTime", "to", "toTime"]) assert.match(html, new RegExp(`name="${filter}"`));
  assert.match(html, /id="historyLogPreviousButton"/);
  assert.match(html, /id="historyLogNextButton"/);
  assert.match(html, /id="exportHistoryDateRangeButton"/);
  assert.match(app, /database\.historySearchPage\(filters, \{ cursor, limit: 100 \}\)/);
  assert.match(app, /historyExportSheets\(database, filters\)/);
  assert.match(app, /exportHistoryDateRangeButton.*exportHistoryDateRange\(\)/);
  assert.match(app, /historyLogResults.*addEventListener\("dblclick"/);
  assert.match(app, /row\.dataset\.historyEventMac[\s\S]*?openMacHistory\(\)/);
  assert.match(app, /const pickerPromise = typeof globalThis\.showSaveFilePicker/);
  assert.match(app, /await workbook\.pipeTo\(writable\)/);
  assert.match(renderer, /export function historyLogContent/);
});

test("DDIO alternatives are kept on switch-IP history events and exposed as guidance", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const render = readFileSync("src/ui/render.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(database, /change\.field === "switchIp"[\s\S]*?possibleIps: Array\.isArray\(row\.after\.possibleIps\)/);
  assert.match(render, /class="ddio-ip-marker"/);
  assert.match(render, /не изменяет подтверждённый IP устройства/);
  assert.match(app, /excelColumnLabel\(index\)/);
  assert.match(render, /export function excelColumnLabel/);
});

test("global history supports selected event deletion and persisted visible columns", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(html, /id="deleteHistoryEventsButton"/);
  assert.match(html, /id="historyLogColumns"/);
  assert.match(app, /database\.deleteHistoryEvents\(ids\)/);
  assert.match(app, /globalThis\.confirm\(`Удалить/);
  assert.match(app, /setSetting\("historyLogColumns"/);
  assert.match(database, /async deleteHistoryEvents\(ids = \[\]\)/);
});

test("DDIO enrichment builds its evidence index only for current Main and SmartRoom devices", () => {
  const enrichment = readFileSync("src/core/enrichment.js", "utf8");
  const ddio = readFileSync("src/core/ddio-overlay.js", "utf8");
  assert.match(enrichment, /buildDdIoIndexFromRows\(ddioRows, mappings\.ddio \|\| \{\}, devices\)/);
  assert.match(enrichment, /from "\.\/ddio-overlay\.js"/);
  assert.match(ddio, /targetDevices\) \{[\s\S]*?targetMacs = new Set\(\);[\s\S]*?targetDeviceIds = new Set\(\)/);
  assert.match(ddio, /if \(targetMacs && !targetMacs\.has\(mac\)\) return/);
  assert.match(ddio, /if \(targetDeviceIds && !targetDeviceIds\.has\(key\)\) return/);
});

test("portable archive import validates its header and streams events into removable staging", () => {
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const importer = readFileSync("src/data/importer.js", "utf8");
  assert.match(app, /inspectPortableArchiveHeader\(file\)/);
  assert.match(app, /database\.importArchiveEvents\(header,\s*readPortableArchiveEvents\(file/);
  assert.match(app, /getDirectoryArchiveFile\(state\.dataDirectoryHandle\)/);
  assert.match(app, /await importPortableArchiveFile\(file\)/);
  const archiveImport = app.slice(app.indexOf("async function importPortableArchiveFile("), app.indexOf("\nasync function ", app.indexOf("async function importPortableArchiveFile(")));
  assert.doesNotMatch(archiveImport, /JSON\.parse\(await file\.text\(\)\)/);
  assert.match(importer, /export async function\* readPortableArchiveEvents/);
  assert.match(importer, /yield \{ type: "snapshotChunk"/);
  assert.match(database, /async importArchiveEvents\(header, events, \{ preserveActiveSnapshot = false \} = \{\}\)/);
  assert.match(database, /finally \{\s*await this\.deleteLocalArchive\(archiveId\)/);
});

test("SQLite import status shows why tables or views were skipped", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /result\.skippedTables\.map\(\(\{ table, reason \}\) => reason \? `\$\{table\} \(\$\{reason\}\)` : table\)/);
  assert.match(app, /sqliteImportStatus/);
});

test("guide exposes read-only browser diagnostics for the IndexedDB store", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const diagnostics = readFileSync("src/core/diagnostics.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(html, /id="runDiagnosticsButton"/);
  assert.match(html, /id="diagnosticsResults"[^>]*aria-live="polite"/);
  assert.match(app, /runBrowserDiagnostics\(\{[\s\S]*?database,[\s\S]*?directoryPermission: state\.dataDirectoryPermission/);
  assert.match(app, /#runDiagnosticsButton.*runSystemDiagnostics/s);
  assert.match(diagnostics, /forEachSnapshotChunk\(snapshot\.id/);
  assert.match(diagnostics, /singleAnalysisMetadataPage/);
  assert.match(diagnostics, /forEachSingleAnalysisChunk/);
  assert.match(database, /async singleAnalysisMetadataPage/);
  assert.match(database, /async forEachSingleAnalysisChunk/);
  assert.match(diagnostics, /Backend \/ SQLite \/ REST API/);
  assert.doesNotMatch(diagnostics, /transaction\([^\n]*,\s*["']readwrite/);
});

test("user guide explains the complete strong identity priority without promoting hostname", () => {
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /сохранённый внутренний ID → Device ID → серийный номер → основной MAC → дополнительный MAC/);
  assert.match(html, /Hostname помогает сопоставлению, но сам не разрешает неоднозначность/);
  assert.match(html, /Smartroom ID и IP — слабые признаки/);
  assert.doesNotMatch(html, /Приоритет: Device ID → serial → MAC/);
});

test("theme button opens an accessible selector and persists its active choice", () => {
  const html = readFileSync("index.html", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(html, /id="themeDialog"[^>]*aria-labelledby="themeDialogTitle"/);
  assert.match(html, /data-theme-choice="light"[^>]*aria-pressed="false"/);
  assert.match(html, /data-theme-choice="dark"[^>]*aria-pressed="false"/);
  assert.match(app, /legacyThemeChoice\(await database\.getSetting\("legacyAppSetting:theme"/);
  assert.match(app, /resolveThemeChoice\(databaseTheme, localTheme, importedLegacyTheme\s*\?/);
  assert.match(app, /localStorage\?\.setItem\("mac-analyzer-theme", theme\)/);
  assert.match(app, /database\.setSetting\("theme", theme\)/);
  assert.match(app, /aria-pressed", String\(active\)/);
});

test("batch XLSX queue reuses per-file previews and submits streamable table metadata", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /headers: entry\.headers,[\s\S]*?rows: entry\.previewRows,[\s\S]*?preview: true,[\s\S]*?sheet: entry\.sheet/);
  assert.match(app, /tables\[role\] = await readTable\(entry\.file\)/);
  const editor = app.slice(app.indexOf("function batchMappingEditor("), app.indexOf("function refreshBatchValidation(", app.indexOf("function batchMappingEditor(")));
  assert.match(editor, /state\.inventoryColumnConfig\.columns\.filter\(\(\{ custom \}\) => custom\)/);
  assert.match(editor, /customColumns\.map\(\(\{ key \}\) => key\)/);
  assert.match(editor, /FIELD_LABELS\[field\] \|\| field/);
});

test("batch date UI labels unknown observation dates explicitly and Final keeps runtime time", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /entry\.date\.date\.slice\(0, 10\) \|\| "Дата неизвестна"/);
  assert.match(app, /entry\.date\.date\.slice\(0, 10\) \|\| "не определена"/);
  assert.match(app, /const createdAt = mainObservationDate\.date \|\| new Date\(\)\.toISOString\(\)/);
});

test("large analysis and comparison JSON exports use the bounded writer and Save File picker", () => {
  const app = readFileSync("src/app.js", "utf8");
  const config = readFileSync("scripts/build-config.js", "utf8");
  assert.match(config, /src\/core\/json-stream\.js/);
  assert.match(app, /import \{ writePrettyJson \} from "\.\/core\/json-stream\.js"/);
  assert.match(app, /await writePrettyJson\(value, writable\)/);
  assert.match(app, /exportJsonFile\("single-file-analysis\.json", state\.singleFile\.result\)/);
  assert.match(app, /exportJsonFile\("file-comparison\.json", async \(\) => \{[\s\S]*?analyzeFileCompareInput\(0,[\s\S]*?analyzeFileCompareInput\(1,[\s\S]*?fileComparisonJsonFromDevices\(before\.devices, after\.devices, summaryComparison\)[\s\S]*?fullExportAnalysis = \{ \.\.\.analysis, before, after, comparison, ouiFormats: state\.ouiFormats \};[\s\S]*?return fullExportAnalysis;/);
  assert.match(app, /async function exportJsonFile\(filename, valueOrFactory\)[\s\S]*?showSaveFilePicker[\s\S]*?await \(typeof valueOrFactory === "function" \? valueOrFactory\(\) : valueOrFactory\)/);
  assert.match(app, /async function exportJsonFile\(filename, valueOrFactory\)[\s\S]*?new globalThis\.TransformStream\(\{[\s\S]*?encoder\.encode\(String\(chunk\)\)/);
  assert.match(app, /async function exportJsonFile\(filename, valueOrFactory\)[\s\S]*?writePrettyJson\(value, writable\)[\s\S]*?await writable\.close\(\)[\s\S]*?await blobPromise/);
  assert.doesNotMatch(app, /JSON\.stringify\(state\.(?:singleFile\.result|fileCompare\.result), null, 2\)/);
});

test("batch queue commits each pair serially and applies its explicit failure policy", () => {
  const app = readFileSync("src/app.js", "utf8");
  const batch = readFileSync("src/core/batch.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  const runBatchStart = app.indexOf("async function runBatch(");
  const runBatch = app.slice(runBatchStart, app.indexOf("\nfunction ", runBatchStart));
  const queueStart = batch.indexOf("export async function runBatchQueue(");
  const queueRunner = batch.slice(queueStart, batch.indexOf("\nconst STRONG_FIELDS", queueStart));
  assert.match(html, /id="batchPreview"/);
  assert.match(html, /id="runBatchButton"/);
  assert.match(html, /id="batchFailurePolicy"[\s\S]*value="continue"[\s\S]*value="stop"/);
  assert.match(runBatch, /runBatchQueue\(pairs, async \(pair, index\)/);
  assert.match(runBatch, /failurePolicy,[\s\S]*onError:/);
  assert.match(batch, /for \(let index = 0; index < pairs\.length; index \+= 1\)/);
  assert.match(batch, /await executePair\(pair, index\)/);
  assert.match(batch, /batchFailureAction\(failurePolicy, error\) === "stop"/);
  assert.match(batch, /pair\.status = error\?\.name === "AbortError" \? "cancelled" : "error"/);
  assert.match(runBatch, /state\.batch\.failurePolicy/);
  assert.match(app, /pair\.status === "cancelled" \? pair\.errorMessage/);
  assert.match(app, /pair\.queueMessage \|\|/);
  assert.match(runBatch, /onStart:[\s\S]*?refreshBatchValidation\(\)/);
  assert.doesNotMatch(queueRunner, /Promise\.all/);
});

test("batch scheduler supports named queues, serial execution, and engineering-session cleanup", () => {
  const app = readFileSync("src/app.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /id="batchScheduleTime"/);
  assert.match(html, /id="batchScheduleName"/);
  assert.match(html, /id="batchScheduleMode"/);
  assert.match(html, /id="batchScheduleInterval"/);
  assert.match(html, /id="batchScheduleDaily"/);
  assert.match(html, /id="scheduleBatchButton"/);
  assert.match(html, /id="stopScheduledBatchButton"/);
  assert.match(html, /id="scheduledBatchStatus"/);
  assert.match(html, /id="scheduledBatchList"/);
  assert.match(app, /import \{ createDailyScheduler, createSerialQueue, nextIntervalExecution, nextLocalExecution, normalizeScheduleName \} from "\.\/core\/daily-scheduler\.js"/);
  const schedule = app.slice(app.indexOf("function scheduleBatch()"), app.indexOf("\nasync function exportInventoryXlsx", app.indexOf("function scheduleBatch()")));
  assert.match(schedule, /batchQueueProblems\(state\.batch\.pairs\)/);
  assert.match(schedule, /state\.scheduledBatches\.values\(\)/);
  assert.match(schedule, /normalizeScheduleName\(\$\("#batchScheduleName"\)\.value/);
  assert.doesNotMatch(schedule, /stopScheduledBatch\("Предыдущее расписание/, "adding a named schedule must keep existing schedules active");
  assert.match(schedule, /nextLocalExecution\(hour, minute\)/);
  assert.match(schedule, /nextIntervalExecution\(intervalMinutes\)/);
  assert.match(schedule, /cloneBatchEntry\(pair\.main\)/);
  assert.match(schedule, /failurePolicy: state\.batch\.failurePolicy/);
  assert.match(schedule, /repeatDaily: \$\("#batchScheduleDaily"\)\.checked/);
  assert.match(schedule, /intervalMinutes: schedule\.intervalMinutes/);
  assert.match(schedule, /start\(\{ hour, minute, repeatDaily: schedule\.repeatDaily, intervalMinutes: schedule\.intervalMinutes \}\)/);
  assert.match(schedule, /scheduledBatchQueue\.enqueue\(\(\) =>/);
  assert.match(schedule, /runBatch\(schedule\.pairs, schedule\.strategy, schedule\.failurePolicy\)/);
  assert.match(app, /function renderScheduledBatches\(\)/);
  assert.match(app, /data-schedule-delete/);
  assert.match(app, /#runBatchButton"\)\.addEventListener\("click", \(\) => scheduledBatchQueue\.enqueue/);
  assert.match(schedule, /stopScheduledBatch\("Планировщик остановлен: инженерная сессия завершилась/);
  const endSession = app.slice(app.indexOf("function endEngineeringSession("), app.indexOf("\nasync function initializeEngineeringMode", app.indexOf("function endEngineeringSession(")));
  assert.match(endSession, /stopScheduledBatch\(/);
});

test("quality analysis is engineer-only and streams the complete selected Final locally", () => {
  const app = readFileSync("src/app.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /id="dataQualityPanel"/);
  assert.match(html, /id="runDataQualityButton"/);
  assert.match(html, /Данные не отправляются во внешние сервисы/);
  const quality = app.slice(app.indexOf("async function runDataQualityAnalysis()"), app.indexOf("\nasync function renderDataQualityHistory", app.indexOf("async function runDataQualityAnalysis()")));
  assert.match(quality, /if \(!isEngineerActive\(\)\)/);
  assert.match(quality, /database\.forEachSnapshotChunk\(snapshot\.id/);
  assert.match(quality, /createDataQualityAccumulator\(\)/);
  assert.match(quality, /escapeHtml\(issue\.title\)/);
  assert.match(quality, /database\.saveDataQualityReport\(snapshot, report\)/);
  assert.match(app, /database\.dataQualityReportsPage\(\{ offset, limit: 20 \}\)/);
  assert.match(app, /dataQualityHistoryPreviousButton/);
  assert.match(app, /dataQualityHistoryNextButton/);
  assert.match(html, /id="dataQualityHistoryPreviousButton"/);
  assert.match(html, /id="dataQualityHistoryNextButton"/);
  assert.match(html, /id="dataQualityHistoryStatus"/);
  assert.match(html, /id="dataQualityHistory"/);
  assert.match(app, /dataQualityPanel\.hidden = !engineer/);
});

test("every successful import passes its source File objects into atomic Final storage", () => {
  const app = readFileSync("src/app.js", "utf8");
  const database = readFileSync("src/data/database.js", "utf8");
  const html = readFileSync("index.html", "utf8");
  assert.match(app, /originalFiles: Object\.entries\(files\)\.filter\(\(\[, file\]\) => file\)\.map\(\(\[role, file\]\) => \(\{ role, file \}\)\)/);
  assert.match(app, /data-download-original=/);
  assert.match(app, /database\.getOriginalFile\(snapshotId, role\)/);
  assert.match(html, /id="snapshotList"/);
  assert.match(database, /const stores = \[[\s\S]*?"originalFiles"\]/);
  assert.match(database, /this\.#putOriginalFiles\(tx\.objectStore\("originalFiles"\), id, originalFiles\)/);
  assert.match(database, /createObjectStore\("originalFiles", \{ keyPath: \["snapshotId", "role"\] \}\)/);
});

test("source-key reuse includes a bounded streaming digest of each imported file", () => {
  const app = readFileSync("src/app.js", "utf8");
  const digest = readFileSync("src/core/incremental-sha256.js", "utf8");
  const sourceKey = readFileSync("src/core/source-key.js", "utf8");
  assert.match(app, /sourceDigests\[role\] = await sha256File\(file/);
  assert.match(app, /buildSourceKey\(\{ strategy, files, mappings, sourceDigests \}\)/);
  assert.match(sourceKey, /sha256: String\(sourceDigests\[role\] \|\| ""\)/);
  assert.match(digest, /file\.slice\(offset, Math\.min\(file\.size, offset \+ chunkSize\)\)\.arrayBuffer\(\)/);
  assert.doesNotMatch(digest, /file\.arrayBuffer\(\)/);
});

test("enrichment caps diagnostic samples and the UI reports exact totals and truncation", () => {
  const core = readFileSync("src/core/enrichment.js", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  assert.match(core, /MAX_DIAGNOSTIC_SAMPLES = 1_000/);
  assert.match(core, /retainDiagnosticSample\(diagnostics, "invalid"/);
  assert.match(core, /retainDiagnosticSample\(diagnostics, "unmatched"/);
  assert.match(core, /retainDiagnosticSample\(diagnostics, "decisions"/);
  assert.match(app, /counts\.unmatchedTruncated \|\| 0/);
  assert.match(app, /counts\.invalidTruncated \|\| 0/);
  assert.match(app, /counts\.conflictsTruncated \|\| 0/);
  assert.match(app, /identityConflictDetails\(result\.diagnostics\.conflicts, result\.diagnostics\.counts\.identityConflictsTotal\)/);
  assert.match(renderer, /Показаны первые \$\{preview\.length\} из \$\{total\.toLocaleString/);
});

test("Inventory candidate lookup iterates Final devices without building a second full reference list", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(database, /async inventoryCandidatesForDevices\(devices = \[\], \{ batchSize = 250, onPage = null \} = \{\}\)[\s\S]*?for \(let offset = 0; offset < devices\.length; offset \+= pageLimit\)[\s\S]*?page\.clear\(\)/);
  assert.doesNotMatch(database, /const uniqueDevices = \[\.\.\.new Map\(devices\.filter/);
});

test("Final switch-address and Smartroom evidence maps are scoped to one source chunk", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  const start = database.indexOf("async saveFinal(");
  const end = database.indexOf("async saveOriginalFiles(", start);
  assert.ok(start >= 0 && end > start, "saveFinal implementation must be discoverable");
  const saveFinal = database.slice(start, end);
  const chunkLoop = saveFinal.indexOf("for (let position = 0; position < initialChunkCount; position += 1)");
  const addressMap = saveFinal.indexOf("const addressEvidence = new Map()", chunkLoop);
  const roomMap = saveFinal.indexOf("const roomObservations = new Map()", chunkLoop);
  assert.ok(chunkLoop >= 0 && addressMap > chunkLoop && roomMap > chunkLoop);
  assert.match(saveFinal, /const chunkIndex = position/);
  assert.match(saveFinal, /const sourceChunk = devices\.slice\(start, end\)/);
  assert.match(saveFinal, /if \(consumeDevices\) for \(let index = start; index < end; index \+= 1\) devices\[index\] = null/);
  assert.ok(saveFinal.indexOf("if (consumeDevices) for (let index = start; index < end; index += 1) devices[index] = null", chunkLoop) < addressMap, "release raw records before building per-chunk evidence");
  assert.match(saveFinal, /for \(const device of cleanChunk\) \{\s*const switchIp = String\(device\.switchIp/);
  assert.ok(saveFinal.indexOf("const addressEvidence = new Map()") === addressMap, "address grouping must not precede chunk iteration");
  assert.ok(saveFinal.indexOf("const roomObservations = new Map()") === roomMap, "room grouping must not precede chunk iteration");
  assert.match(saveFinal, /await deleteCursorRows\(evidenceStore, "by_snapshot", IDBKeyRange\.only\(id\)\)/);
  assert.match(saveFinal, /await deleteCursorRows\(roomMappingStore, "by_snapshot", IDBKeyRange\.only\(id\)\)/);
});

test("local archive metadata listing uses a cursor and targeted archive lookups", () => {
  const database = readFileSync("src/data/database.js", "utf8");
  assert.match(database, /async listLocalArchives\(\) \{[\s\S]*?openCursor\(\)[\s\S]*?cursor\.continue\(\)/);
  assert.doesNotMatch(database, /async listLocalArchives\(\) \{[\s\S]*?getAll\(\)/);
  assert.match(database, /async #localArchiveMetadata\(archiveId\) \{[\s\S]*?get\(archiveId\)/);
  assert.match(database, /async exportLocalArchiveStream\(archiveId\) \{\s*const record = await this\.#localArchiveMetadata\(archiveId\)/);
  assert.match(database, /async restoreLocalArchive\(archiveId, \{ preserveActiveSnapshot = false \} = \{\}\) \{\s*const archive = await this\.#localArchiveMetadata\(archiveId\)/);
});

test("Dashboard and details reuse freshly loaded comparison baselines for history backfill", () => {
  const app = readFileSync("src/app.js", "utf8");
  assert.equal([...app.matchAll(/backfillComparisonDevices\(/g)].length, 2);
  assert.match(app, /async function ensureDashboardComparisonIndex\([\s\S]*?backfillComparisonDevices\([\s\S]*?inPlace: true/);
  assert.equal([...app.matchAll(/ensureDashboardComparisonIndex\(/g)].length, 3);
  assert.match(app, /visitPreviousChunks: previousIndex\.snapshotId/);
  assert.match(app, /resolveIdentityChunk: previousIndex\.snapshotId/);
  assert.match(app, /backfillStats\.restoredFieldCount \+= restored\.restoredFieldCount/);
  assert.match(app, /historyBackfill = \{\s*restoredFields: previousIndex\.restoredFieldCount/);
  assert.doesNotMatch(app, /packAlternateMacsInPlace\(previous\.devices\)/);
});

test("MAC churn deduplicates each snapshot with indexed positions, not a full MAC-keyed map", () => {
  const analytics = readFileSync("src/core/analytics.js", "utf8");
  const tracker = analytics.match(/export function createPresenceChurnTracker\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(tracker, /let seenInSnapshot = new Uint32Array\(0\)/);
  assert.match(tracker, /incoming\.positions\[incoming\.count\+\+\] = index/);
  assert.match(tracker, /previousPositions = current\.positions/);
  assert.match(tracker, /current\.details\.get\(mac\)/);
  assert.doesNotMatch(tracker, /incoming\.devices\s*=\s*new Map/);
});

test("Dashboard ambiguity excludes candidate objects without a flattened temporary array", () => {
  const analytics = readFileSync("src/core/analytics.js", "utf8");
  assert.match(analytics, /const devices = new WeakSet\(\)/);
  assert.match(analytics, /const ambiguousDevices = new WeakSet\(\)/);
  assert.match(analytics, /function addAmbiguousDevices\(target, row\)[\s\S]*?for \(const candidate of row\?\.candidates \|\| \[\]\) \{\s*if \(candidate && typeof candidate === "object"\) target\.add\(candidate\)/);
  assert.match(analytics, /onAmbiguous: \(row\) => \{\s*if \(ambiguous\.length < MAX_COMPARISON_DIAGNOSTIC_PREVIEW\) ambiguous\.push\(row\);\s*addAmbiguousDevices\(ambiguousDevices, row\)/);
  assert.match(analytics, /collectAmbiguousDevices\(comparison\.ambiguous \|\| \[\]\)/);
  assert.doesNotMatch(analytics, /ambiguous\.flatMap\(/);
});

test("Dashboard identity diagnostics keep bounded previews and reload exact pages from Final chunks", () => {
  const app = readFileSync("src/app.js", "utf8");
  const comparison = readFileSync("src/core/comparison.js", "utf8");
  const renderer = readFileSync("src/ui/render.js", "utf8");
  assert.match(comparison, /export async function compareFinalIdentityDiagnosticPage[\s\S]*?rows\.push\(\{ type, row \}\)[\s\S]*?total !== summary\.ambiguous \+ summary\.identityConflicts/);
  assert.match(app, /compareFinalIdentityDiagnosticPage\([\s\S]*?database\.forEachSnapshotChunk\(currentId, visit\)/);
  assert.match(app, /loadIdentityDiagnosticsMarkup\(analytics, offset\)/);
  assert.match(app, /return ambiguous\.length \|\| identityConflicts\.length\s*\? pagedComparisonContent\([\s\S]*?: "";/);
  assert.match(app, /data-comparison-diagnostic-page/);
  assert.match(renderer, /export function comparisonDiagnosticsPageContent\(page\)/);
  assert.match(renderer, /Диагностика идентичности .*из \$\{total\.toLocaleString/);
});

test("first-baseline identity diagnostics use the sparse index and validate exact summary counts", () => {
  const app = readFileSync("src/app.js", "utf8");
  const comparison = readFileSync("src/core/comparison.js", "utf8");
  assert.match(app, /kind === "identityDiagnostics"\s*\? compareFinalIdentityDiagnosticPage/);
  assert.match(app, /result\.ambiguousCount !== Number\(analytics\.comparison\.ambiguousCount/);
  assert.match(comparison, /resolveIdentityChunk = null/);
  assert.match(comparison, /identityConflictCount \+= conflicts\.length/);
});

