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

function deviceSummary(device = {}) {
  return [
    device.manufacturer && device.manufacturer !== "Unknown" && `Произв: ${device.manufacturer}`,
    device.model && `Модель: ${device.model}`,
    device.ip && `IP: ${device.ip}`,
    device.address && `Адрес: ${device.address}`,
    device.room && `Помещ: ${device.room}`,
    device.switchIp && `Комм: ${device.switchIp}`,
    device.switchPort && `Порт: ${device.switchPort}`,
  ].filter(Boolean).join("; ") || "Нет данных";
}

async function* comparisonWorkbookRows(result) {
  const comparison = result.comparison;
  for (const device of comparison.absent) {
    yield [device.macFormatted || device.mac || "", "Только в первом файле", deviceSummary(device), "—", "Устройство отсутствует во втором файле"];
  }
  for (const device of comparison.added) {
    yield [device.macFormatted || device.mac || "", "Только во втором файле", "—", deviceSummary(device), "Устройство отсутствует в первом файле"];
  }
  for (const item of comparison.modified) {
    yield [item.after.macFormatted || item.after.mac || item.before.mac || "", "Изменено", deviceSummary(item.before), deviceSummary(item.after),
      item.changes.map(({ label, oldValue, newValue }) => `${label}: ${oldValue} → ${newValue}`).join("\n")];
  }
  for (const item of comparison.unchanged) {
    yield [item.after.macFormatted || item.after.mac || item.before.mac || "", "Без изменений", deviceSummary(item.before), deviceSummary(item.after), "Данные совпадают"];
  }
  for (const item of comparison.ambiguous) {
    yield [item.after.macFormatted || item.after.mac || "", "Неоднозначно", item.candidates.map(deviceSummary).join(" | "), deviceSummary(item.after), "Сильные идентификаторы конфликтуют; проверьте вручную"];
  }
}

/** Build a bounded XLSX sheet stream for every directed pair and PyQt-style statistics. */
export function multiFileComparisonWorkbookSheets(pairs = [], files = [], loadPair) {
  if (!Array.isArray(pairs) || !pairs.length || !Array.isArray(files) || typeof loadPair !== "function") {
    throw new TypeError("Для XLSX сравнения нужны пары, файлы и загрузчик результата");
  }
  const fileCounts = Array(files.length).fill(null);
  const sheets = [];
  for (const pair of pairs) {
    const first = files[pair.first];
    const second = files[pair.second];
    if (!first || !second) throw new Error("Пара сравнения ссылается на отсутствующий файл");
    const baseName = `${first.file.name} vs ${second.file.name}`;
    let pairResult = null;
    const getResult = async () => {
      if (!pairResult) {
        pairResult = await loadPair(pair);
        fileCounts[pair.first] = pairResult.before.summary.valid;
        fileCounts[pair.second] = pairResult.after.summary.valid;
      }
      return pairResult;
    };
    sheets.push({
      name: baseName,
      headings: ["MAC", "Тип", "Значение файла 1", "Значение файла 2", "Изменения"],
      rows: (async function* () { yield* comparisonWorkbookRows(await getResult()); })(),
    });
    sheets.push({
      name: `Статистика ${baseName}`,
      headings: ["Показатель", "Значение"],
      rows: (async function* () {
        const comparison = (await getResult()).comparison;
        const counts = [
          ["Устройств только в первом файле", comparison.absent.length],
          ["Устройств только во втором файле", comparison.added.length],
          ["Общих устройств", comparison.modified.length + comparison.unchanged.length],
          ["Изменённых устройств", comparison.modified.length],
          ["Совпадающих устройств", comparison.unchanged.length],
          ["Неоднозначных соответствий", comparison.ambiguous.length],
        ];
        for (const row of counts) yield row;
        pairResult = null;
      })(),
    });
  }
  sheets.push({
    name: "Общая статистика",
    headings: ["Файл", "Устройств"],
    rows: (async function* () {
      for (let index = 0; index < files.length; index += 1) {
        if (fileCounts[index] === null) throw new Error(`Не рассчитано число устройств файла ${files[index].file.name}`);
        yield [files[index].file.name, fileCounts[index]];
      }
    })(),
  });
  return sheets;
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

