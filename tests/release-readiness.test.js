import test from "node:test";
import assert from "node:assert/strict";
import { categorizePendingParityRows, inspectProgressCheckpoint, inspectReleaseReadiness } from "../scripts/release-readiness.js";

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

test("progress rounds to one decimal place and counts only fully closed rows", () => {
  const result = inspectReleaseReadiness([
    { id: 1, status: "Выполнено: verified" },
    { id: 2, status: "Частично: browser smoke remains open" },
    { id: 3, status: "Не проверено: pending" },
  ]);
  assert.equal(result.completed, 1);
  assert.equal(result.percent, 33.3);
});

test("release blockers are grouped by runtime verification, backend, external integration, and implementation", () => {
  const rows = [
    { id: 13, status: "Частично: browser smoke remains open" },
    { id: 614, status: "Не закрыто: backend REST service is absent" },
    { id: 673, status: "Не реализовано: SMTP and Telegram external notifications" },
    { id: 402, status: "Не закрыто: сторонние уведомления/API intentionally do not send network data" },
    { id: 371, status: "Частично: внешний MACVendor API не подключается из-за локальной обработки; browser smoke открыт" },
    { id: 546, status: "Частично: локальный анализ качества данных работает; внешний API не предлагается; browser smoke открыт" },
    { id: 700, status: "Частично: missing merge behavior" },
  ];
  const categories = categorizePendingParityRows(rows);
  assert.deepEqual(Object.fromEntries(Object.entries(categories).map(([key, values]) => [key, values.map(({ id }) => id)])), {
    runtimeVerification: [13, 546],
    backendUnavailable: [614],
    externalIntegration: [673, 402, 371],
    implementation: [700],
  });
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

test("missing active-goal progress checkpoint is reported", () => {
  const result = inspectProgressCheckpoint("# Registry", inspectReleaseReadiness([{ id: 1, status: "Выполнено: verified" }]));
  assert.equal(result.valid, false);
  assert.match(result.issue, /отсутствует актуальная сводка/);
});
