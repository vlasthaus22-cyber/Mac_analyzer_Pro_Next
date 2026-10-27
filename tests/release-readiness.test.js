import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { categorizePendingParityRows, formatReleaseReadinessSummary, inspectProgressCheckpoint, inspectReleaseReadiness, summarizeParityProgress } from "../scripts/release-readiness.js";

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
    { id: 700, status: "Частично: missing merge behavior" },
  ];
  const categories = categorizePendingParityRows(rows);
  assert.deepEqual(Object.fromEntries(Object.entries(categories).map(([key, values]) => [key, values.map(({ id }) => id)])), {
    runtimeVerification: [13, 546, 391],
    backendUnavailable: [614],
    externalIntegration: [402, 371],
    sourcePolicyConflict: [673],
    implementation: [700],
  });
});

test("PyQt integrations that conflict with the audited Web reference and local-only policy get their own blocker", () => {
  const rows = [370, 673].map((id) => {
    const line = readFileSync("PARITY_REGISTRY.md", "utf8").split(/\r?\n/).find((entry) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(entry));
    assert.ok(line, `parity row #${id} must remain present`);
    return { id, status: line.split("|").slice(1, -1)[4] };
  });
  const categories = categorizePendingParityRows(rows);
  assert.deepEqual(categories.sourcePolicyConflict.map(({ id }) => id), [370, 673]);
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
  assert.match(compact.stdout, /Полностью подтверждено: 45\/188 \(23\.9%\)/);
  assert.match(compact.stdout, /browser smoke\/E2E: 133/);
  assert.match(compact.stdout, /external integrations: 2/);
  assert.match(compact.stdout, /reference\/policy conflicts: 2/);
  assert.doesNotMatch(compact.stdout, /#25/);

  const detailed = spawnSync(process.execPath, ["scripts/report-parity-progress.mjs", "--verbose"], { encoding: "utf8" });
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.match(detailed.stdout, /browser smoke\/E2E: 133 \[#25,/);
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
