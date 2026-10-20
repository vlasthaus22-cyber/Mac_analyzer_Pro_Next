const COMPLETED_STATUS = /^(?:Полностью|Выполнено)(?::|\s)/;

export function inspectReleaseReadiness(rows = []) {
  const pending = rows.filter((row) => !COMPLETED_STATUS.test(String(row?.status || "")));
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
    } else if (/browser|браузер|smoke|E2E|проверка.*UI|UI.*провер/i.test(status)) {
      categories.runtimeVerification.push(row);
    } else {
      categories.implementation.push(row);
    }
  }
  return categories;
}

export function inspectProgressCheckpoint(markdown, readiness) {
  const text = String(markdown || "");
  const match = text.match(/^Текущий прогресс активной цели.*?: \*\*([\d,]+(?:\.[\d]+)?)% проверенного переноса \((\d+)\/(\d+) требований\); (\d+) пункт/m);
  const codeMatch = text.match(/^Отдельный показатель переноса на уровне кода и автотестов: \*\*([\d,]+(?:\.[\d]+)?)% \((\d+)\/(\d+)\)\*\*/m);
  if (!match || !codeMatch) return { valid: false, issue: "В PARITY_REGISTRY.md отсутствует актуальная сводка прогресса активной цели" };
  const runtimeVerification = categorizePendingParityRows(readiness.pending).runtimeVerification.length;
  const codeCovered = readiness.completed + runtimeVerification;
  const codePercent = readiness.total ? Math.round((codeCovered / readiness.total) * 1000) / 10 : 0;
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
    codePercent,
    codeCovered,
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
