export const CRITICAL_CHANGE_FIELDS = Object.freeze(["mac", "ip", "switchIp"]);
const criticalFields = new Set(CRITICAL_CHANGE_FIELDS);
const fieldAliases = new Map([
  ["mac", "mac"], ["macaddress", "mac"], ["mac address", "mac"], ["mac-адрес", "mac"], ["мак", "mac"], ["мак-адрес", "mac"], ["mac-адрес устройства", "mac"],
  ["ip", "ip"], ["deviceip", "ip"], ["device_ip", "ip"], ["ipaddress", "ip"], ["ip address", "ip"], ["ip-адрес", "ip"], ["ip адрес", "ip"], ["ip устройства", "ip"], ["адрес устройства", "ip"],
  ["switchip", "switchIp"], ["switch_ip", "switchIp"], ["switch-ip", "switchIp"], ["switch ip", "switchIp"], ["ip коммутатора", "switchIp"], ["адрес коммутатора", "switchIp"], ["коммутатор", "switchIp"],
]);
const typeAliases = new Map([
  ["added", "added"], ["add", "added"], ["new", "added"], ["появление", "added"], ["добавлено", "added"], ["добавлен", "added"], ["добавлена", "added"],
  ["absent", "absent"], ["removed", "absent"], ["remove", "absent"], ["deleted", "absent"], ["disappeared", "absent"], ["удаление", "absent"], ["удалено", "absent"], ["удален", "absent"], ["удалён", "absent"], ["отсутствует", "absent"], ["исчезло", "absent"],
  ["modified", "modified"], ["changed", "modified"], ["change", "modified"], ["изменено", "modified"], ["изменение", "modified"], ["изменён", "modified"], ["изменен", "modified"],
]);

export function normalizeChangeField(field) {
  const value = String(field ?? "").trim().toLocaleLowerCase("ru-RU");
  return fieldAliases.get(value) || value;
}

export function normalizeChangeType(type) {
  const value = String(type ?? "modified").trim().toLocaleLowerCase("ru-RU");
  return typeAliases.get(value) || value;
}

export function isCriticalHistoryChange(type, field, oldValue, newValue) {
  const normalizedType = normalizeChangeType(type);
  if (normalizedType === "absent") return true;
  const before = String(oldValue ?? "").trim();
  const after = String(newValue ?? "").trim();
  return normalizedType === "modified" && criticalFields.has(normalizeChangeField(field)) && before !== "" && after !== "" && before !== after;
}
export const CHANGE_CATEGORIES = Object.freeze(["all", "critical", "added", "absent", "modified"]);
export const CHANGE_CATEGORY_LABELS = Object.freeze({ all: "Все", critical: "Критические", added: "Добавлены", absent: "Отсутствуют", modified: "Изменены" });

function eventMatches(category, type, severity) {
  if (category === "all") return true;
  if (category === "critical") return severity === "critical";
  return category === type;
}

function visitEvents(comparison = {}, visit, category = "all") {
  const added = comparison.added || [];
  const addedCount = Math.max(added.length, Math.floor(Number(comparison.addedCount) || 0));
  for (let position = 0; position < addedCount; position += 1) {
    visit({ type: "added", severity: "low", device: added[position] || null, additionOffset: position, change: null });
  }
  const absent = comparison.absent || [];
  const absentCount = Math.max(absent.length, Math.floor(Number(comparison.absentCount) || 0));
  for (let position = 0; position < absentCount; position += 1) {
    visit({ type: "absent", severity: "critical", device: absent[position] || null, absenceOffset: position, change: null });
  }
  let modifiedOffset = 0;
  let criticalModificationOffset = 0;
  for (const row of comparison.modified || []) {
    for (const change of row.changes || []) {
      const critical = isCriticalHistoryChange("modified", change.field, change.oldValue, change.newValue);
      visit({
        type: "modified",
        severity: critical ? "critical" : "other",
        device: row.after,
        before: row.before,
        change,
        modificationOffset: modifiedOffset,
        ...(critical ? { criticalModificationOffset } : {}),
      });
      modifiedOffset += 1;
      if (critical) criticalModificationOffset += 1;
    }
  }
  const observedModifiedCount = modifiedOffset;
  const observedCriticalCount = criticalModificationOffset;
  const modifiedCount = Math.max(observedModifiedCount, Math.floor(Number(comparison.modifiedEventCount) || 0));
  const criticalCount = Math.max(observedCriticalCount, Math.floor(Number(comparison.criticalModifiedEventCount) || 0));
  if (category === "critical") {
    for (let position = observedCriticalCount; position < criticalCount; position += 1) {
      visit({ type: "modified", severity: "critical", device: null, before: null, change: null, criticalModificationOffset: position });
    }
  } else if (category === "all" || category === "modified") {
    for (let position = observedModifiedCount; position < modifiedCount; position += 1) {
      visit({ type: "modified", severity: "other", device: null, before: null, change: null, modificationOffset: position });
    }
  }
}

export function summarizeChangeCategories(comparison = {}) {
  const counts = { all: 0, critical: 0, added: 0, absent: 0, modified: 0 };
  counts.added = Math.max((comparison.added || []).length, Math.floor(Number(comparison.addedCount) || 0));
  counts.absent = Math.max((comparison.absent || []).length, Math.floor(Number(comparison.absentCount) || 0));
  counts.critical = counts.absent;
  let criticalModified = 0;
  for (const row of comparison.modified || []) {
    for (const change of row.changes || []) {
      counts.modified += 1;
      if (isCriticalHistoryChange("modified", change.field, change.oldValue, change.newValue)) criticalModified += 1;
    }
  }
  counts.modified = Math.max(counts.modified, Math.floor(Number(comparison.modifiedEventCount) || 0));
  counts.critical += Math.max(criticalModified, Math.floor(Number(comparison.criticalModifiedEventCount) || 0));
  counts.all = counts.added + counts.absent + counts.modified;
  return counts;
}

export function pageComparisonChanges(comparison = {}, category = "all", { offset = 0, limit = 100 } = {}) {
  const selectedCategory = CHANGE_CATEGORIES.includes(category) ? category : "all";
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const rows = [];
  let total = 0;
  visitEvents(comparison, (event) => {
    if (!eventMatches(selectedCategory, event.type, event.severity)) return;
    if (total >= start && rows.length < pageSize) rows.push(event);
    total += 1;
  }, selectedCategory);
  return { category: selectedCategory, offset: start, limit: pageSize, total, rows, hasMore: start + rows.length < total };
}
