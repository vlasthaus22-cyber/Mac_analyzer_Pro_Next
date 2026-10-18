import { normalizeMac } from "./normalize.js";

export function pairwiseComparisonPairs(fileCount) {
  const count = Number(fileCount);
  if (!Number.isInteger(count) || count < 2) throw new Error("Для сравнения выберите не менее двух файлов");
  if (count > 10) throw new Error("Можно сравнить не более 10 файлов за один раз");
  const pairs = [];
  for (let first = 0; first < count; first += 1) {
    for (let second = 0; second < count; second += 1) {
      if (first !== second) pairs.push({ first, second, id: `${first}:${second}` });
    }
  }
  return pairs;
}

export function comparisonRows(pair, result) {
  const { comparison } = result;
  return [
    ...comparison.added.map((device) => ({ status: "Только во втором файле", mac: device.mac, before: "", after: describe(device), changes: "" })),
    ...comparison.absent.map((device) => ({ status: "Только в первом файле", mac: device.mac, before: describe(device), after: "", changes: "" })),
    ...comparison.modified.map((item) => ({
      status: "Изменено",
      mac: item.after.mac || item.before.mac,
      before: describe(item.before),
      after: describe(item.after),
      changes: item.changes.map((change) => `${change.label}: ${change.oldValue} → ${change.newValue}`).join("; "),
    })),
    ...comparison.unchanged.map((item) => ({ status: "Без изменений", mac: item.after.mac || item.before.mac, before: describe(item.before), after: describe(item.after), changes: "" })),
    ...comparison.ambiguous.map((item) => ({ status: "Неоднозначно", mac: item.after.mac, before: item.candidates.map(describe).join(" | "), after: describe(item.after), changes: "Сильные идентификаторы конфликтуют; проверьте вручную" })),
  ].map((row) => ({ ...row, file1: pair.file1, file2: pair.file2 }));
}

export function selectMultiFileComparisonFields(comparison, selected = {}) {
  const fieldSelection = {
    mac: Boolean(selected.mac),
    manufacturer: Boolean(selected.vendor),
    model: Boolean(selected.model),
    ip: Boolean(selected.ip),
    address: Boolean(selected.address),
    physicalAddress: Boolean(selected.address),
    room: Boolean(selected.room),
  };
  const modified = [];
  const unchangedFromFiltered = [];
  for (const row of comparison.modified) {
    const changes = row.changes.filter((change) => fieldSelection[change.field]);
    if (selected.oui) {
      const beforeOui = normalizeMac(row.before.mac).replaceAll(":", "").slice(0, 6);
      const afterOui = normalizeMac(row.after.mac).replaceAll(":", "").slice(0, 6);
      if (beforeOui && afterOui && beforeOui !== afterOui) {
        changes.push({ field: "oui", label: "OUI", oldValue: beforeOui, newValue: afterOui });
      }
    }
    const macBefore = normalizeMac(row.before.mac);
    const macAfter = normalizeMac(row.after.mac);
    if (selected.mac && macBefore && macAfter && macBefore !== macAfter
      && !changes.some((change) => change.field === "mac")) {
      changes.push({ field: "mac", label: "MAC", oldValue: macBefore, newValue: macAfter });
    }
    if (changes.length) modified.push({ ...row, changes });
    else unchangedFromFiltered.push({ identity: row.identity, before: row.before, after: row.after, changes: [] });
  }
  const unchanged = [...comparison.unchanged, ...unchangedFromFiltered];
  const critical = modified.filter((row) => row.changes.some((change) => ["switchIp", "ip", "mac", "physicalAddress", "smartroomId"].includes(change.field)));
  return { ...comparison, modified, unchanged, critical };
}

export function allPairwiseCsv(results = []) {
  return `${pairwiseCsvHeader()}${results.map(({ pair, result }) => pairwiseComparisonCsv(pair, result)).join("")}`;
}

const CSV_COLUMNS = Object.freeze([
    { key: "file1", label: "Первый файл" },
    { key: "file2", label: "Второй файл" },
    { key: "status", label: "Статус" },
    { key: "mac", label: "MAC" },
    { key: "before", label: "Было" },
    { key: "after", label: "Стало" },
    { key: "changes", label: "Изменения" },
]);

export function pairwiseCsvHeader() {
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return `${CSV_COLUMNS.map((item) => quote(item.label)).join(";")}\r\n`;
}

export function pairwiseComparisonCsv(pair, result) {
  const rows = comparisonRows(pair, result);
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return rows.map((row) => `${CSV_COLUMNS.map((item) => quote(row[item.key])).join(";")}\r\n`).join("");
}

function describe(device = {}) {
  return [
    device.manufacturer && `Производитель: ${device.manufacturer}`,
    device.model && `Модель: ${device.model}`,
    device.ip && `IP: ${device.ip}`,
    device.address && `Адрес: ${device.address}`,
    device.room && `Помещение: ${device.room}`,
    device.switchIp && `IP коммутатора: ${device.switchIp}`,
  ].filter(Boolean).join("; ") || "—";
}

