import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { categorizePendingParityRows, formatReleaseReadinessSummary, inspectProgressCheckpoint, inspectReleaseReadiness, summarizeParityProgress } from "../scripts/release-readiness.js";
import { inspectParityRegistry } from "../scripts/parity-registry.js";

test("release readiness requires every parity requirement to be explicitly complete", () => {
  const rows = [
    { id: 1, status: "Полностью: implemented and verified" },
    { id: 2, status: "Выполнено: tested" },
    { id: 3, status: "Частично: browser check remains open" },
    { id: 4, status: "Не закрыто: not implemented" },
  ];
  const result = inspectReleaseReadiness(rows);
  assert.equal(result.ready, false);
  assert.equal(result.completed, 2);
  assert.equal(result.percent, 50);
  assert.deepEqual(result.pending.map(({ id }) => id), [3, 4]);
});

test("browser importer parity is backed by the Edge all-format smoke and codec regressions", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 413);
  assert.ok(row);
  assert.match(row.status, /^Полностью:/);
  assert.match(row.status, /Edge smoke 2026-11-07/);
  assert.match(row.status, /21 синтетический файл/);
  assert.match(row.tests, /tests\/importer\.test\.js/);
  assert.match(row.tests, /tests\/batch\.test\.js/);
});

test("successive Final parity is backed by an Edge UI smoke that checks the active Final and Inventory", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 432);
  assert.ok(row);
  assert.match(row.status, /^Полностью:/);
  assert.match(row.status, /Edge smoke 2026-11-07/);
  assert.match(row.status, /три последовательных Final/);
  assert.match(row.tests, /tests\/database\.test\.js/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /process\.argv\.includes\("--inventory-field-history-only"\)/);
});

test("workspace-state, source-file, and batch-folder Edge smokes close parity requirement 242", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 242);
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /--workspace-state-persistence-only/);
  assert.match(row.status, /--workspace-batch-directory-restart-only/);
  assert.match(row.status, /--workspace-source-handle-restart-only/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /process\.argv\.includes\("--workspace-state-persistence-only"\)/);
  assert.match(smoke, /analyticsCacheCount/);
  assert.match(smoke, /deleteWorkspaceStateButton/);
  assert.match(smoke, /process\.argv\.includes\("--workspace-source-handle-restart-only"\)/);
  assert.match(smoke, /process\.argv\.includes\("--workspace-batch-directory-restart-only"\)/);
  assert.match(smoke, /nested\/main_2026-11-07-nested\.csv/);
  assert.match(smoke, /__workspaceSourceContentReads/);
});

test("Inventory column manager parity is backed by a persistent Edge workflow", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 438);
  assert.ok(row);
  assert.match(row.status, /^Полностью:/);
  assert.match(row.status, /Edge smoke 2026-11-07/);
  assert.match(row.status, /full Inventory/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /process\.argv\.includes\("--inventory-column-manager-only"\)/);
});

test("MAC history parity is backed by Edge UI exports, filters, groups and deletion", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 476);
  assert.ok(row);
  assert.match(row.status, /^Полностью:/);
  assert.match(row.status, /--device-analytics-appearances-only/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /process\.argv\.includes\("--device-analytics-appearances-only"\)/);
  assert.match(smoke, /History vendor\/model\/room\/date filters did not preserve exact matching rows/);
  assert.match(smoke, /Selected History deletion did not remove exactly one event/);
});

test("PyQt-style clustering is verified in the Dashboard browser UI", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find(({ id }) => id === 528);
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /три кластера 2\/3\/1/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /runPyqtClusteringButton/);
  assert.match(smoke, /clusterCounts\.reduce\(\(sum, count\) => sum \+ count, 0\) !== 6/);
});

test("two-Final analytics reuse has real Edge runtime heap evidence", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find(({ id }) => id === 155);
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /--stress-only --stress-rows=5000/);
  assert.match(row.status, /72 352 476 bytes/);
  assert.match(row.status, /обработку Worker ровно Final 1\/2 и 2\/2/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  const app = readFileSync("src/app.js", "utf8");
  assert.match(smoke, /Runtime\.getHeapUsage/);
  assert.match(smoke, /--stress-rows=/);
  assert.match(app, /Worker истории Final \$\{snapshotIndex \+ 1\}\/\$\{snapshotCount\}/);
});

test("vendor/model upload history parity is backed by Edge UI rebuild, exports and deletion", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 484);
  assert.ok(row);
  assert.match(row.status, /^Полностью:/);
  assert.match(row.status, /--vendor-model-history-only/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /process\.argv\.includes\("--vendor-model-history-only"\)/);
  assert.match(smoke, /Vendor\/model \$\{kind\} search did not find the expected matching rows/);
  assert.match(smoke, /Deleting imported load history changed unrelated records or left entries/);
});

test("Final history management parity is backed by isolated Edge and optional-host multi-delete smoke", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 485);
  assert.ok(row);
  assert.match(row.status, /^Полностью:/);
  assert.match(row.status, /--final-history-management-only/);
  assert.match(row.status, /--optional-host-transfer-only/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /process\.argv\.includes\("--final-history-management-only"\)/);
  assert.match(smoke, /Selected Final deletion did not preserve unrelated user data/);
  assert.match(smoke, /Clear Final history did not remove the full snapshot scope/);
  assert.match(smoke, /Selecting both transferred host Finals did not enable multi-delete/);
  assert.match(smoke, /Optional-host selected Final delete did not preserve Inventory/);
});

test("integration package code coverage is separate from external runtime verification", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 402);
  assert.ok(row);
  assert.match(row.implementation, /backend\/services\/integrations\/notifications\.py/);
  assert.match(row.implementation, /backend\/services\/integrations\/external_vendor\.py/);
  assert.match(row.tests, /tests\/test_notifications\.py/);
  assert.match(row.tests, /tests\/test_external_vendor\.py/);
  assert.match(row.tests, /tests\/engineering-session\.test\.js/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /--notifications-settings-ui-only/);

  const vendorRow = rows.find(({ id }) => id === 541);
  assert.ok(vendorRow);
  assert.match(vendorRow.status, /кодовая часть проверена/i);
  assert.match(vendorRow.status, /MACVendorAPI\.API_SERVICES/);
  assert.match(vendorRow.status, /исторический mac2vendor endpoint возвращает HTTP 404/i);

  const progress = summarizeParityProgress(rows);
  const sqliteImportRow = rows.find(({ id }) => id === 387);
  assert.ok(sqliteImportRow);
  assert.match(sqliteImportRow.status, /^Полностью подтверждено:/);
  assert.match(sqliteImportRow.status, /mac_analyzer_web\.db.*373112832 bytes/);
  assert.match(sqliteImportRow.status, /smoke завершился `ok:true`/);
  assert.deepEqual(progress.codeAndTests, { count: 188, total: 188, percent: 100 });
  assert.ok(progress.blockers.find(({ key }) => key === "externalIntegration").ids.includes(541));
  assert.ok(progress.blockers.find(({ key }) => key === "externalIntegration").ids.includes(673));
  assert.deepEqual(progress.fullyVerified, { count: 176, total: 188, percent: 93.6 });
  assert.equal(progress.openOrPartial, 12);
  assert.deepEqual(progress.blockers.find(({ key }) => key === "backendUnavailable")?.ids, [13]);
  assert.equal(progress.releaseReady, false);
  assert.equal(progress.blockers.find(({ key }) => key === "externalIntegration").ids.includes(402), false);
});

test("full Dashboard analytics has real Edge memory evidence for 10,000-device snapshots", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find(({ id }) => id === 25);
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /--stress-only --stress-rows=10000/);
  assert.match(row.status, /20 000 \/ 10 000/);
  assert.match(row.status, /peak 90 MiB\/final 52 MiB/);
  assert.doesNotMatch(row.status, /browser memory smoke остаётся открытым/i);
});

test("offline full analytics parity is verified by a disposable Edge smoke and documented", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 529);
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  assert.match(row.status, /--analytics-cache-reopen-only/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /process\.argv\.includes\("--analytics-cache-reopen-only"\)/);
  assert.match(smoke, /Portable vendor\/room filters did not isolate/);
  assert.match(readFileSync("docs/TESTING.md", "utf8"), /#529 автономной полной аналитики/);
});

test("optional SQLite Inventory search and additive transfer parity is verified in Edge", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 353);
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /--optional-host-transfer-only/);
  assert.match(row.status, /поиск SQLite по serial/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /HOST-SERIAL-99/);
  assert.match(smoke, /Optional-host full Inventory search omitted source fields/);
  assert.match(smoke, /Repeated Inventory transfer changed host identities/);
  assert.match(readFileSync("docs/TESTING.md", "utf8"), /#353.*optional-host-transfer-only/);
});

test("single-device and MAC-prefix dialogs have focused Edge verification", () => {
  const { rows } = inspectParityRegistry(readFileSync("PARITY_REGISTRY.md", "utf8"));
  const row = rows.find(({ id }) => id === 534);
  assert.ok(row);
  assert.match(row.status, /^Полностью подтверждено:/);
  assert.match(row.status, /--device-analytics-appearances-only/);
  assert.match(row.status, /--search-doubleclick-only/);
  assert.match(row.status, /точную\/частичную модель/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
});

test("single-file format, conflict, cancellation, and persistence-failure browser checks close parity row 488", () => {
  const markdown = readFileSync("PARITY_REGISTRY.md", "utf8");
  const { rows, issues } = inspectParityRegistry(markdown);
  assert.deepEqual(issues, []);
  const row = rows.find(({ id }) => id === 488);
  assert.ok(row);
  assert.match(row.status, /^Полностью:/);
  assert.match(row.status, /--single-file-all-formats-only/);
  assert.match(row.status, /--single-file-safety-only/);
  assert.match(row.tests, /tools\/browser-smoke\.mjs/);
  const smoke = readFileSync("tools/browser-smoke.mjs", "utf8");
  assert.match(smoke, /process\.argv\.includes\("--single-file-all-formats-only"\)/);
  assert.match(smoke, /process\.argv\.includes\("--single-file-safety-only"\)/);
  assert.match(smoke, /Synthetic disposable quota failure/);
  assert.match(smoke, /afterSaveFailure\.activeId !== afterCancel\.activeId/);
});

test("an empty parity matrix cannot accidentally pass release readiness", () => {
  assert.deepEqual(inspectReleaseReadiness([]), { ready: false, total: 0, completed: 0, percent: 0, pending: [] });
});

test("all complete requirements pass release readiness", () => {
  const rows = [{ id: 1, status: "Полностью: verified" }, { id: 2, status: "Выполнено: verified" }];
  assert.deepEqual(inspectReleaseReadiness(rows), { ready: true, total: 2, completed: 2, percent: 100, pending: [] });
});

test("release readiness output distinguishes full verification from code coverage", () => {
  const readiness = inspectReleaseReadiness([
    { id: 1, status: "Выполнено: verified" },
    { id: 2, status: "Частично: browser smoke remains open" },
    { id: 3, status: "Частично: browser smoke remains open" },
  ]);
  const checkpoint = inspectProgressCheckpoint(
    "Текущий прогресс активной цели: **33,3% проверенного переноса (1/3 требований); 2 пункта остаются открытыми.**\nОтдельный показатель переноса на уровне кода и автотестов: **100,0% (3/3)**",
    readiness,
  );
  assert.equal(checkpoint.valid, true);
  assert.equal(
    formatReleaseReadinessSummary(readiness, checkpoint),
    "Release blocked: 33.3% fully verified (1/3 parity requirements); 2 remain open or partial; code coverage 100% (3/3).",
  );
});

test("an explicitly open browser check prevents a false complete status from passing release readiness", () => {
  const result = inspectReleaseReadiness([
    { id: 1, status: "Полностью: implementation passed; browser smoke остаётся открытым" },
    { id: 2, status: "Выполнено: unit and browser verification passed" },
  ]);
  assert.equal(result.ready, false);
  assert.equal(result.completed, 1);
  assert.deepEqual(result.pending.map(({ id }) => id), [1]);
});

test("progress rounds to one decimal place and counts only fully closed rows", () => {
  const result = inspectReleaseReadiness([
    { id: 1, status: "Выполнено: verified" },
    { id: 2, status: "Частично: browser smoke remains open" },
    { id: 3, status: "Не проверено: pending" },
  ]);
  assert.equal(result.completed, 1);
  assert.equal(result.percent, 33.3);
});

test("release blockers distinguish runtime, backend, external, source-policy, and implementation work", () => {
  const rows = [
    { id: 13, status: "Частично: browser smoke remains open" },
    { id: 614, status: "Не закрыто: backend REST service is absent" },
    { id: 673, status: "Не реализовано: PyQt NotificationService conflicts with Web removal; Direct Web-reference audit records a source divergence and privacy policy conflict" },
    { id: 402, status: "Не закрыто: сторонние уведомления/API intentionally do not send network data" },
    { id: 371, status: "Частично: внешний MACVendor API не подключается из-за локальной обработки; browser smoke открыт" },
    { id: 546, status: "Частично: локальный анализ качества данных работает; внешний API не предлагается; browser smoke открыт" },
    { id: 391, status: "Частично: кодовая часть проверена; browser smoke остаётся открытым; IndexedDB остаётся основным runtime, а UI optional SQLite backup/restore подключён" },
    { id: 128, status: "Частично: Кодовая часть проверена; архив PyQt импортируется в отдельную UUID-профильную IndexedDB; browser restart/switchback smoke remains open" },
    { id: 700, status: "Частично: missing merge behavior" },
  ];
  const categories = categorizePendingParityRows(rows);
  assert.deepEqual(Object.fromEntries(Object.entries(categories).map(([key, values]) => [key, values.map(({ id }) => id)])), {
    runtimeVerification: [13, 546, 391, 128],
    backendUnavailable: [614],
    externalIntegration: [402, 371],
    sourcePolicyConflict: [673],
    implementation: [700],
  });
});

test("approved PyQt integrations stay open until every provider and notification channel is verified", () => {
  const rows = [541, 673].map((id) => {
    const line = readFileSync("PARITY_REGISTRY.md", "utf8").split(/\r?\n/).find((entry) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(entry));
    assert.ok(line, `parity row #${id} must remain present`);
    return { id, status: line.split("|").slice(1, -1)[4] };
  });
  const categories = categorizePendingParityRows(rows);
  assert.deepEqual(categories.sourcePolicyConflict, []);
  assert.deepEqual(categories.externalIntegration.map(({ id }) => id), [541, 673]);
  assert.deepEqual(categories.runtimeVerification.map(({ id }) => id), []);
  assert.deepEqual(categories.implementation, []);
});

test("parity progress report is derived from matrix statuses and shows blocker counts and IDs", () => {
  const report = summarizeParityProgress([
    { id: 1, status: "Выполнено: implementation and tests pass" },
    { id: 2, status: "Частично: browser smoke remains open; кодовая часть проверена" },
    { id: 3, status: "Частично: browser smoke remains open" },
    { id: 4, status: "Не закрыто: backend REST is absent" },
    { id: 5, status: "Не реализовано: SMTP external integration" },
    { id: 6, status: "Частично: merge behavior is not implemented" },
  ]);
  assert.deepEqual(report, {
    releaseReady: false,
    fullyVerified: { count: 1, total: 6, percent: 16.7 },
    codeAndTests: { count: 3, total: 6, percent: 50 },
    openOrPartial: 5,
    blockers: [
      { key: "runtimeVerification", label: "browser smoke/E2E", count: 2, ids: [2, 3] },
      { key: "backendUnavailable", label: "backend/REST", count: 1, ids: [4] },
      { key: "externalIntegration", label: "external integrations", count: 1, ids: [5] },
      { key: "implementation", label: "implementation or verification", count: 1, ids: [6] },
    ],
  });
});

test("progress CLI is compact by default and offers detailed IDs on request", () => {
  const compact = spawnSync(process.execPath, ["scripts/report-parity-progress.mjs"], { encoding: "utf8" });
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /Полностью подтверждено: 176\/188 \(93\.6%\)/);
  assert.match(compact.stdout, /Код и автотесты: 188\/188 \(100%\)/);
  assert.match(compact.stdout, /Открыто\/частично: 12/);
  assert.match(compact.stdout, /browser smoke\/E2E: 9/);
  assert.match(compact.stdout, /backend\/REST: 1/);
  assert.match(compact.stdout, /external integrations: 2/);
  assert.doesNotMatch(compact.stdout, /reference\/policy conflicts:/);
  assert.doesNotMatch(compact.stdout, /#25/);

  const detailed = spawnSync(process.execPath, ["scripts/report-parity-progress.mjs", "--verbose"], { encoding: "utf8" });
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.match(detailed.stdout, /browser smoke\/E2E: 9 \[#38,/);
  assert.doesNotMatch(detailed.stdout, /#387/);
  assert.doesNotMatch(detailed.stdout, /#221|#273|#391|#614/);
  assert.doesNotMatch(detailed.stdout, /reference\/policy conflicts:/);
});

test("active-goal checkpoint must match the verified completion count in the parity matrix", () => {
  const readiness = inspectReleaseReadiness([
    { id: 1, status: "Выполнено: verified" },
    { id: 2, status: "Частично: browser check remains open" },
    { id: 3, status: "Не проверено: pending" },
  ]);
  const current = "Текущий прогресс активной цели (2026-10-20): **33,3% проверенного переноса (1/3 требований); 2 пункта остаётся открытым или частичным.**\nОтдельный показатель переноса на уровне кода и автотестов: **66,7% (2/3)**";
  assert.deepEqual(inspectProgressCheckpoint(current, readiness), {
    valid: true,
    actual: { percent: 33.3, completed: 1, total: 3, pending: 2, codePercent: 66.7, codeCovered: 2, codeTotal: 3 },
    expected: { percent: 33.3, completed: 1, total: 3, pending: 2, codePercent: 66.7, codeCovered: 2, codeTotal: 3 },
    issue: "",
  });
  const stale = inspectProgressCheckpoint(current.replace("33,3%", "50,0%"), readiness);
  assert.equal(stale.valid, false);
  assert.match(stale.issue, /Сводка прогресса устарела/);
  const staleCode = inspectProgressCheckpoint(current.replace("66,7% (2/3)", "33,3% (1/3)"), readiness);
  assert.equal(staleCode.valid, false);
  assert.match(staleCode.issue, /кодовый перенос 33.3% \(1\/3\) против 66.7% \(2\/3\)/);
});

test("code-transfer progress counts smoke-pending rows but excludes backend, integrations, and open implementation", () => {
  const readiness = inspectReleaseReadiness([
    { id: 1, status: "Выполнено: verified" },
    { id: 2, status: "Частично: browser smoke remains open" },
    { id: 3, status: "Не закрыто: backend REST service is absent" },
    { id: 4, status: "Не реализовано: SMTP external integration" },
    { id: 5, status: "Частично: merge behavior is not implemented" },
  ]);
  const markdown = "Текущий прогресс активной цели: **20,0% проверенного переноса (1/5 требований); 4 пункта остаются открытыми.**\nОтдельный показатель переноса на уровне кода и автотестов: **40,0% (2/5)**";
  const checkpoint = inspectProgressCheckpoint(markdown, readiness);
  assert.equal(checkpoint.valid, true);
  assert.equal(checkpoint.expected.codeCovered, 2);
  assert.equal(checkpoint.expected.codePercent, 40);
});

test("code-transfer progress counts a row marked both browser-pending and code-tested once", () => {
  const readiness = inspectReleaseReadiness([
    { id: 1, status: "Выполнено: verified" },
    { id: 2, status: "Частично: browser smoke remains open; кодовая часть проверена" },
    { id: 3, status: "Частично: browser smoke remains open" },
    { id: 4, status: "Не закрыто: backend REST service is absent" },
  ]);
  const markdown = "Текущий прогресс активной цели: **25,0% проверенного переноса (1/4 требований); 3 пункта остаются открытыми.**\nОтдельный показатель переноса на уровне кода и автотестов: **75,0% (3/4)**";
  const checkpoint = inspectProgressCheckpoint(markdown, readiness);
  assert.equal(checkpoint.valid, true);
  assert.equal(checkpoint.expected.codeCovered, 3);
  assert.equal(checkpoint.expected.codePercent, 75);
});

test("missing active-goal progress checkpoint is reported", () => {
  const result = inspectProgressCheckpoint("# Registry", inspectReleaseReadiness([{ id: 1, status: "Выполнено: verified" }]));
  assert.equal(result.valid, false);
  assert.match(result.issue, /отсутствует актуальная сводка/);
});
