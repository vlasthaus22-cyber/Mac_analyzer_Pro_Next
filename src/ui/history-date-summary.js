import { normalizeMac } from "../core/normalize.js";
import { escapeHtml } from "./render.js";

export function historyDateSummaryHtml(days, macs) {
  const dayRows = days.map((row) => `<tr><td>${escapeHtml(row.date)}</td><td>${Number(row.total || 0).toLocaleString("ru-RU")}</td><td>${Number(row.added || 0).toLocaleString("ru-RU")}</td><td>${Number(row.removed || 0).toLocaleString("ru-RU")}</td><td>${Number(row.modified || 0).toLocaleString("ru-RU")}</td></tr>`).join("");
  const macRows = macs.map((row) => {
    const value = String(row.value ?? "");
    const mac = normalizeMac(value).replace(/[^A-F0-9]/g, "");
    const action = mac.length === 12
      ? `<button class="link-button" type="button" data-open-history-mac="${mac}" aria-label="Открыть историю MAC ${escapeHtml(value)}">${escapeHtml(value)}</button>`
      : escapeHtml(value);
    return `<tr><td>${action}</td><td>${Number(row.count || 0).toLocaleString("ru-RU")}</td><td>${escapeHtml(row.data?.lastTimestamp || "—")}</td></tr>`;
  }).join("");
  return `<h4>Статистика по датам</h4><div class="table-scroll"><table class="data-table history-date-rows" data-virtual-scroll="true"><thead><tr><th>Дата</th><th>Всего</th><th>Добавлено</th><th>Удалено</th><th>Изменено</th></tr></thead><tbody>${dayRows || '<tr><td colspan="5">Нет событий за период</td></tr>'}</tbody></table></div><h4>Топ MAC</h4><div class="table-scroll"><table class="data-table"><thead><tr><th>MAC</th><th>Изменений</th><th>Последнее изменение</th></tr></thead><tbody>${macRows || '<tr><td colspan="3">Нет событий с MAC</td></tr>'}</tbody></table></div>`;
}

export function openHistoryFromDateSummary(event, { activateHistory, macInput, openHistory, onError } = {}) {
  const button = event?.target?.closest?.("[data-open-history-mac]");
  if (!button) return false;
  const mac = normalizeMac(button.dataset.openHistoryMac).replace(/[^A-F0-9]/g, "");
  if (mac.length !== 12) return false;
  activateHistory?.();
  if (macInput) macInput.value = mac;
  Promise.resolve().then(() => openHistory?.()).catch((error) => onError?.(error));
  return true;
}
