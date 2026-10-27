const COMPLETED_STATUS = /^(?:Полностью|Выполнено)(?::|\s)/;
const OPEN_RUNTIME_CHECK = /(?:browser|браузер|smoke|E2E|runtime).{0,100}(?:remains? open|not run|unverified|pending|оста[её]тся открытым|не выполнен[ао]?|не проверен[ао]?|не запускал[ао]?)/i;

function isCompleteStatus(status) {
  const text = String(status || "");
  return COMPLETED_STATUS.test(text) && !OPEN_RUNTIME_CHECK.test(text);
}

export function inspectReleaseReadiness(rows = []) {
  const pending = rows.filter((row) => !isCompleteStatus(row?.status));
  const completed = rows.length - pending.length;
  const percent = rows.length ? Math.round((completed / rows.length) * 1000) / 10 : 0;
  return { ready: rows.length > 0 && pending.length === 0, total: rows.length, completed, percent, pending };
}

export function categorizePendingParityRows(rows = []) {
  const categories = {
    runtimeVerification: [],
    backendUnavailable: [],
    externalIntegration: [],
    implementation: [],
  };
  for (const row of rows) {
    const status = String(row?.status || "");
    const explicitlyNotIntegrated = /(?:внешн|сторонн).{0,40}(?:API|уведом|интеграц).{0,40}(?:не предлага|не рекомендуется|не требуется|не нужен|не используется)/i.test(status);
    if (!explicitlyNotIntegrated && /(?:MACVendorAPI|NotificationSettingsDialog|NotificationService|SMTP|Telegram|Slack|сторонн.{0,40}(?:API|уведом)|внешн.{0,40}(?:API|уведом)|(?:API|уведом).{0,40}(?:внешн|сторонн))/i.test(status)) {
      categories.externalIntegration.push(row);
    } else if (/\bbackend\b|\bREST(?: API)?\b|сервер|service endpoint/i.test(status)) {
      categories.backendUnavailable.push(row);
    } else if (!/browser\s+IndexedDB/i.test(status) && /browser|браузер|smoke|E2E|проверка.*UI|UI.*провер/i.test(status)) {
      categories.runtimeVerification.push(row);
    } else {
      categories.implementation.push(row);
    }
  }
  return categories;
}

function codeCoverageFor(readiness) {
  const runtimeVerification = categorizePendingParityRows(readiness.pending).runtimeVerification;
  const explicitlyCodeTested = readiness.pending.filter(({ status }) => /кодовая часть проверена/i.test(String(status || "")));
  const covered = readiness.completed + new Set([...runtimeVerification, ...explicitlyCodeTested]).size;
  return {
    covered,
    percent: readiness.total ? Math.round((covered / readiness.total) * 1000) / 10 : 0,
  };
}

const PROGRESS_BLOCKER_LABELS = Object.freeze({
  runtimeVerification: "browser smoke/E2E",
  backendUnavailable: "backend/REST",
  externalIntegration: "external integrations",
  implementation: "implementation or verification",
});

export function summarizeParityProgress(rows = []) {
  const readiness = inspectReleaseReadiness(rows);
  const codeCoverage = codeCoverageFor(readiness);
  const pendingByCategory = categorizePendingParityRows(readiness.pending);
  const blockers = Object.entries(pendingByCategory).map(([key, categoryRows]) => ({
    key,
    label: PROGRESS_BLOCKER_LABELS[key],
    count: categoryRows.length,
    ids: categoryRows.map(({ id }) => id),
  }));
  return {
    releaseReady: readiness.ready,
    fullyVerified: { count: readiness.completed, total: readiness.total, percent: readiness.percent },
    codeAndTests: { count: codeCoverage.covered, total: readiness.total, percent: codeCoverage.percent },
    openOrPartial: readiness.pending.length,
    blockers,
  };
}

export function inspectProgressCheckpoint(markdown, readiness) {
  const text = String(markdown || "");
  const match = text.match(/^Текущий прогресс активной цели.*?: \*\*([\d,]+(?:\.[\d]+)?)% проверенного переноса \((\d+)\/(\d+) требований\); (\d+) пункт/m);
  const codeMatch = text.match(/^Отдельный показатель переноса на уровне кода и автотестов: \*\*([\d,]+(?:\.[\d]+)?)% \((\d+)\/(\d+)\)\*\*/m);
  if (!match || !codeMatch) return { valid: false, issue: "В PARITY_REGISTRY.md отсутствует актуальная сводка прогресса активной цели" };
  const codeCoverage = codeCoverageFor(readiness);
  const actual = {
    percent: Number(match[1].replace(",", ".")),
    completed: Number(match[2]),
    total: Number(match[3]),
    pending: Number(match[4]),
    codePercent: Number(codeMatch[1].replace(",", ".")),
    codeCovered: Number(codeMatch[2]),
    codeTotal: Number(codeMatch[3]),
  };
  const expected = {
    percent: readiness.percent,
    completed: readiness.completed,
    total: readiness.total,
    pending: readiness.total - readiness.completed,
    codePercent: codeCoverage.percent,
    codeCovered: codeCoverage.covered,
    codeTotal: readiness.total,
  };
  const valid = Object.keys(expected).every((key) => actual[key] === expected[key]);
  return {
    valid,
    actual,
    expected,
    issue: valid ? "" : `Сводка прогресса устарела: полное подтверждение ${actual.percent}% (${actual.completed}/${actual.total}, открыто ${actual.pending}) против ${expected.percent}% (${expected.completed}/${expected.total}, открыто ${expected.pending}); кодовый перенос ${actual.codePercent}% (${actual.codeCovered}/${actual.codeTotal}) против ${expected.codePercent}% (${expected.codeCovered}/${expected.codeTotal})`,
  };
}

export function formatReleaseReadinessSummary(readiness, checkpoint) {
  const code = checkpoint?.valid ? checkpoint.actual : null;
  const codeCoverage = code
    ? `; code coverage ${code.codePercent}% (${code.codeCovered}/${code.codeTotal})`
    : "";
  if (readiness.ready) {
    return `Release readiness passed: 100% fully verified (${readiness.completed}/${readiness.total} parity requirements are complete)${codeCoverage}.`;
  }
  return `Release blocked: ${readiness.percent}% fully verified (${readiness.completed}/${readiness.total} parity requirements); ${readiness.pending.length} remain open or partial${codeCoverage}.`;
}
