import { createUniqueAnalyticsDeviceFilter } from "./analytics.js";
import { createDashboardDeviceMatcher } from "./dashboard-filter.js";
import { pyqtVendorTopChartItems, pyqtRoomDistributionChartItems } from "./analytics-detail.js";
import { hasKnownRoom, isFloorOnlyAddress, text as identityText, normalizeMac } from "./normalize.js";

const KPI_KEYS = ["devices", "modified", "absent", "unchanged", "manufacturers", "rooms", "withoutRoom"];
const SOURCE_COUNTS = ["mainRaw", "mainUnique", "mainUniqueMacs", "smartroomRaw", "afterSmartroom", "finalUnique", "ddioRaw", "ddioMatchedIp", "identityConflictsTotal", "smartroomMatchedMacs", "smartroomMatchedWithRoom", "smartroomMacLocationConflicts", "ipMappingFilled", "historicalAddressFilled", "currentSmartroomRoomFilled", "historicalSmartroomRoomFilled"];
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "QuotaExceededError", "InvalidStateError", "NotFoundError", "TransactionInactiveError"]);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Explicit numeric allowlists are intentional: never serialize metadata, filters,
// exceptions or imported records into a report intended to leave a closed network.
export async function buildAnalyticsBugReport({ analytics, visitCurrentChunks, visitLatestChunks, applicationLog = [], uiCounts = {}, chartCounts = {}, listCounts = {}, comparisonReadFailures = 0, changeReportMode, periodEventCount }) {
  const filters = analytics?.dashboardFilters || {};
  const filtered = Boolean(filters.query || filters.manufacturer || filters.room);
  const matches = createDashboardDeviceMatcher(filters);
  const unique = createUniqueAnalyticsDeviceFilter();
  const uniqueSelected = filtered ? createUniqueAnalyticsDeviceFilter() : null;
  const mainMacs = new Set();
  const scan = { rows: 0, uniqueDevices: 0, selectedDevices: 0, emptyRoom: 0, idWithoutRoom: 0, emptyAddress: 0, floorOnlyAddress: 0, fullerAddressAvailable: 0 };
  let scanFailed = false;
  const metadata = await visitCurrentChunks((chunk) => {
    scan.rows += chunk.length;
    for (const device of chunk) {
      const first = unique(device);
      if (first) scan.uniqueDevices++;
      if (!matches(device) || !(uniqueSelected ? uniqueSelected(device) : first)) continue;
      scan.selectedDevices++;
      for (const value of device.mainMacs || (device.sources?.includes("Main") ? [device.mac] : [])) {
        const mac = normalizeMac(value);
        if (mac) mainMacs.add(mac);
      }
      if (!hasKnownRoom(device)) {
        scan.emptyRoom++;
        if (identityText(device.smartroomId)) scan.idWithoutRoom++;
      }
      const address = identityText(device.address);
      if (!address) scan.emptyAddress++;
      if (isFloorOnlyAddress(address)) {
        scan.floorOnlyAddress++;
        if ([device.physicalAddress, device.locationPath, device.city, device.site].some((value) => identityText(value) && identityText(value) !== address)) scan.fullerAddressAvailable++;
      }
    }
  }).catch(() => { scanFailed = true; return null; });
  let latestEmptyRoom = scanFailed ? null : scan.emptyRoom;
  let latestScanFailed = false;
  if (visitLatestChunks) {
    latestEmptyRoom = 0;
    const uniqueLatest = createUniqueAnalyticsDeviceFilter();
    try {
      await visitLatestChunks((chunk) => {
        for (const row of chunk) if (matches(row) && uniqueLatest(row) && !hasKnownRoom(row)) latestEmptyRoom++;
      });
    } catch { latestScanFailed = true; latestEmptyRoom = null; }
  }
  const appVersion = /^\d+\.\d+\.\d+$/.test(globalThis.__MAC_ANALYZER_APP_VERSION__ || "") ? globalThis.__MAC_ANALYZER_APP_VERSION__ : "сборка из исходников";
  const lines = ["MAC Analyzer Pro Next — отчёт проверки аналитики", `Версия: ${appVersion}`, "Формат: analytics-audit-1", `Создан: ${new Date().toISOString()}`,
    "Содержит только счётчики и типы ошибок. Строки устройств, идентификаторы, адреса, имена файлов, тексты поиска и ошибок не включаются.",
    `Фильтры поиска/производителя/помещения: ${filtered ? "включены (значения скрыты)" : "выключены"}`,
    `Статус сравнения: ${["all", "changed", "missing", "unchanged"].includes(filters.status) ? filters.status : "all"}`,
    `Подтверждённые изменения: ${changeReportMode === "period" ? `история за отдельный период · событий ${count(periodEventCount) ?? "недоступно"}` : "сравнение выбранных снимков"}`,
    "", "Этапы обработки:"];
  for (const key of SOURCE_COUNTS) lines.push(`source.${key}=${count(metadata?.diagnostics?.counts?.[key]) ?? "не сохранено"}`);
  lines.push(`final.metadataRows=${count(metadata?.deviceCount) ?? "не сохранено"}`, `final.metadataMainMacs=${count(metadata?.mainUniqueMacs) ?? "не сохранено"}`);
  for (const [key, value] of Object.entries(scan)) lines.push(`scan.${key}=${value}`);
  lines.push(`scan.selectedMainMacs=${mainMacs.size}`, "", "Показатели интерфейса и расчёта:");
  for (const key of KPI_KEYS) {
    lines.push(`ui.${key}=${count(uiCounts[key]) ?? "недоступно"}`);
    lines.push(`${key === "rooms" ? "pair.roomIdentities" : "pair." + key}=${count(analytics?.kpis?.[key]) ?? "недоступно"}`);
  }
  for (const key of ["addedCount", "absentCount", "modifiedDeviceCount", "unchangedCount", "ambiguousCount", "identityConflictCount"]) lines.push(`comparison.${key}=${count(analytics?.comparison?.[key]) ?? "недоступно"}`);
  for (const key of ["modified", "absent", "unchanged"]) lines.push(`list.${key}=${count(listCounts[key]) ?? "недоступно"}`);
  const dataset = analytics?.dataset;
  const status = filters.status || "all";
  const statusCount = status === "all" ? dataset?.summary?.devices : analytics?.kpis?.[{ changed: "modified", missing: "absent", unchanged: "unchanged" }[status]];
  lines.push(`latest.emptyRoom=${latestEmptyRoom ?? "недоступно"}`);
  lines.push(`dataset.devices=${count(dataset?.summary?.devices) ?? "недоступно"}`, `dataset.emptyRoom=${count(dataset?.roomOccupancy?.unassignedDevices) ?? "недоступно"}`,
    `status.devices=${count(statusCount) ?? "недоступно"}`);
  for (const key of ["statusVendors", "vendorTop", "roomTop", "roomOverview", "changedFields", "absentVendors"]) lines.push(`chart.${key}=${count(chartCounts[key]) ?? "недоступно"}`);
  lines.push("Топ производителей/помещений может содержать только первые категории; изменения по полям — число событий, не устройств.", "", "Сверка:");
  const checks = [];
  if (latestScanFailed) lines.push("BUG LATEST_SCAN: не удалось прочитать последний Final");
  if (scanFailed) lines.push("BUG FINAL_SCAN: чтение Final завершилось ошибкой; счётчики scan могут быть неполными");
  if (count(comparisonReadFailures) > 0) lines.push(`BUG COMPARISON_SCAN: не удалось прочитать списки сравнения (${comparisonReadFailures})`);
  const check = (code, actual, expected) => {
    if (count(actual) === null || count(expected) === null) { lines.push(`SKIP ${code}: показатель недоступен`); return; }
    const ok = actual === expected;
    checks.push({ code, ok });
    lines.push(`${ok ? "OK" : "BUG"} ${code}: ${actual} / ${expected}`);
  };
  check("FINAL_ROWS", scan.rows, metadata?.deviceCount);
  check("DATASET_CURRENT_FINAL", dataset?.summary?.devices, scan.selectedDevices);
  check("EMPTY_ROOM_DATASET", dataset?.roomOccupancy?.unassignedDevices, scan.emptyRoom);
  check("EMPTY_ROOM_UI", uiCounts.withoutRoom, latestEmptyRoom);
  check("DEVICES_UI", uiCounts.devices, !filtered && count(metadata?.mainUniqueMacs) !== null ? metadata.mainUniqueMacs : scan.selectedDevices);
  const sum = (items = []) => items.reduce((total, item) => total + (count(item.value) ?? 0), 0);
  check("ROOMS_UI", uiCounts.rooms, dataset?.roomOccupancy?.uniqueRooms);
  check("ROOM_OVERVIEW", chartCounts.roomOverview, dataset?.roomOccupancy?.uniqueRooms);
  check("VENDOR_CHART", chartCounts.vendorTop, dataset ? sum(pyqtVendorTopChartItems(dataset)) : null);
  const statusVendors = status === "all" ? dataset?.charts?.vendors : analytics?.dashboardExportSummary?.statusVendors;
  check("STATUS_VENDOR_CHART", chartCounts.statusVendors, statusVendors ? sum(statusVendors.slice(0, 10)) : null);
  check("ROOM_CHART", chartCounts.roomTop, dataset ? sum(pyqtRoomDistributionChartItems(dataset)) : null);
  check("FIELD_CHART", chartCounts.changedFields, analytics?.dashboardExportSummary ? sum(analytics.dashboardExportSummary.fieldChanges) : null);
  check("ABSENT_CHART", chartCounts.absentVendors, analytics?.dashboardExportSummary ? sum(analytics.dashboardExportSummary.absentVendors) : null);
  for (const key of ["modified", "absent", "unchanged"]) {
    check(`LIST_${key.toUpperCase()}`, listCounts[key], analytics?.kpis?.[key]);
    check(`UI_${key.toUpperCase()}`, uiCounts[key], listCounts[key]);
  }
  if (scan.fullerAddressAvailable) lines.push(`BUG ADDRESS_FRAGMENT: ${scan.fullerAddressAvailable} — сохранён только этаж при наличии других частей адреса`);
  if (mainMacs.size && mainMacs.size !== scan.selectedDevices) lines.push("INFO MAIN_MAC_VS_DEVICE: несколько исходных MAC могут относиться к одному устройству; проверьте сильные идентификаторы в локальной диагностике объединения.");
  lines.push("", "Журнал технических ошибок (последние 100):");
  for (const entry of applicationLog.slice(-100)) lines.push(`event=${entry.event === "ui_error" ? "ui_error" : "other"}; type=${ERROR_NAMES.has(entry.errorName) ? entry.errorName : "Other"}`);
  lines.push("", "Исходные файлы не перечитываются этой проверкой. Счётчики импорта берутся из сохранённой диагностики; полная сверка с источником требует повторного объединения в закрытом сегменте.");
  return { text: lines.join("\n"), mismatchCount: checks.filter(({ ok }) => !ok).length + Number(scan.fullerAddressAvailable > 0) + Number(scanFailed) + Number(latestScanFailed) + Number(comparisonReadFailures > 0) };
}
