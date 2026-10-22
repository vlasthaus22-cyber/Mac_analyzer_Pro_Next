import { csvQuote } from "./csv-cell.js";
import { firstMac, normalizeMac } from "./normalize.js";
import { createFinalComparisonEventPlan, hasFinalComparisonFieldChange } from "./comparison.js";

function selectChanges(row, selected = {}) {
  const fieldSelection = {
    mac: Boolean(selected.mac),
    manufacturer: Boolean(selected.vendor),
    model: Boolean(selected.model),
    ip: Boolean(selected.ip),
    address: Boolean(selected.address),
    physicalAddress: Boolean(selected.address),
    room: Boolean(selected.room),
  };
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
  return changes;
}

function hasSelectedChanges(before, after, selected = {}) {
  if ((selected.mac && hasFinalComparisonFieldChange(before, after, "mac"))
    || (selected.vendor && hasFinalComparisonFieldChange(before, after, "manufacturer"))
    || (selected.model && hasFinalComparisonFieldChange(before, after, "model"))
    || (selected.ip && hasFinalComparisonFieldChange(before, after, "ip"))
    || (selected.address && (hasFinalComparisonFieldChange(before, after, "address")
      || hasFinalComparisonFieldChange(before, after, "physicalAddress")))
    || (selected.room && hasFinalComparisonFieldChange(before, after, "room"))) return true;
  if (selected.oui) {
    const beforeOui = normalizeMac(before.mac).replaceAll(":", "").slice(0, 6);
    const afterOui = normalizeMac(after.mac).replaceAll(":", "").slice(0, 6);
    if (beforeOui && afterOui && beforeOui !== afterOui) return true;
  }
  return false;
}

/** Keep comparison details as typed marks and regenerate rows only for a requested page or export chunk. */
export function createMultiFileComparisonPlan(before = [], after = [], timestamp = new Date().toISOString(), selected = {}) {
  const base = createFinalComparisonEventPlan(before, after, timestamp);
  const selectedChange = (beforeDevice, afterDevice) => hasSelectedChanges(beforeDevice, afterDevice, selected);
  const modifiedDeviceCount = base.countModifiedWhere(selectedChange);
  const filteredUnchangedCount = base.modifiedDeviceCount - modifiedDeviceCount;
  const unchangedCount = base.unchangedCount + filteredUnchangedCount;
  function* events(type) {
    if (type === "modified") {
      for (const event of base.events(type, { predicate: selectedChange })) {
        const changes = selectChanges(event.row, selected);
        if (changes.length) yield { ...event, row: { ...event.row, changes } };
      }
      return;
    }
    if (type === "unchanged") {
      yield* base.events(type);
      const notSelectedChange = (beforeDevice, afterDevice) => !selectedChange(beforeDevice, afterDevice);
      for (const event of base.events("modified", { predicate: notSelectedChange, includeChanges: false })) {
        yield { type, row: event.row };
      }
      return;
    }
    yield* base.events(type);
  }
  return Object.freeze({
    addedCount: base.addedCount,
    absentCount: base.absentCount,
    modifiedDeviceCount,
    unchangedCount,
    ambiguousCount: base.ambiguousCount,
    identityConflictCount: base.identityConflictCount,
    timestamp,
    events,
  });
}

function planRow(type, event) {
  if (type === "added" || type === "absent") return event.device;
  if (type === "modified" || type === "unchanged") return event.row;
  return event.item;
}

function planCounts(plan) {
  return [plan.addedCount, plan.absentCount, plan.modifiedDeviceCount, plan.unchangedCount, plan.ambiguousCount];
}

function* planEventsInOrder(plan, order = ["added", "absent", "modified", "unchanged", "ambiguous"]) {
  for (const type of order) for (const event of plan.events(type)) yield { type, value: planRow(type, event) };
}

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

export function multiFileComparisonRowsPage(pair, result, { offset = 0, limit = 100 } = {}) {
  if (!pair || (!result?.comparison && !result?.comparisonPlan)) throw new TypeError("Для страницы сравнения нужны пара файлов и результат сравнения");
  const pageSize = Math.max(1, Math.min(1_000, Math.floor(Number(limit) || 100)));
  if (result.comparisonPlan) {
    const plan = result.comparisonPlan;
    const counts = planCounts(plan);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const lastOffset = total ? Math.floor((total - 1) / pageSize) * pageSize : 0;
    const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const pageOffset = Math.min(lastOffset, Math.floor(requestedOffset / pageSize) * pageSize);
    const rows = [];
    let skipped = pageOffset;
    const statusCounts = {
      added: plan.addedCount,
      absent: plan.absentCount,
      modified: plan.modifiedDeviceCount,
      unchanged: plan.unchangedCount,
      ambiguous: plan.ambiguousCount,
    };
    const labels = {
      added: "Только во втором файле",
      absent: "Только в первом файле",
      modified: "Изменено",
      unchanged: "Без изменений",
      ambiguous: "Неоднозначно",
    };
    for (const type of ["added", "absent", "modified", "unchanged", "ambiguous"]) {
      if (skipped >= statusCounts[type]) {
        skipped -= statusCounts[type];
        continue;
      }
      for (const event of plan.events(type)) {
        if (skipped > 0) { skipped -= 1; continue; }
        const value = planRow(type, event);
        const row = type === "added"
          ? { status: labels[type], mac: value.mac, before: "", after: describe(value), changes: "" }
          : type === "absent"
            ? { status: labels[type], mac: value.mac, before: describe(value), after: "", changes: "" }
            : type === "modified"
              ? { status: labels[type], mac: value.after.mac || value.before.mac, before: describe(value.before), after: describe(value.after), changes: value.changes.map((change) => `${change.label}: ${change.oldValue} → ${change.newValue}`).join("; ") }
              : type === "unchanged"
                ? { status: labels[type], mac: value.after.mac || value.before.mac, before: describe(value.before), after: describe(value.after), changes: "" }
                : { status: labels[type], mac: value.after.mac, before: value.candidates.map(describe).join(" | "), after: describe(value.after), changes: "Сильные идентификаторы конфликтуют; проверьте вручную" };
        rows.push({ ...row, file1: pair.file1, file2: pair.file2 });
        if (rows.length >= pageSize) break;
      }
      if (rows.length >= pageSize) break;
      skipped = 0;
    }
    return {
      rows,
      total,
      offset: pageOffset,
      limit: pageSize,
      page: Math.floor(pageOffset / pageSize) + 1,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      hasPrevious: pageOffset > 0,
      hasNext: pageOffset + rows.length < total,
    };
  }
  const comparison = result.comparison;
  const segments = [
    { status: "Только во втором файле", rows: comparison.added, create: (device) => ({ status: "Только во втором файле", mac: device.mac, before: "", after: describe(device), changes: "" }) },
    { status: "Только в первом файле", rows: comparison.absent, create: (device) => ({ status: "Только в первом файле", mac: device.mac, before: describe(device), after: "", changes: "" }) },
    { status: "Изменено", rows: comparison.modified, create: (item) => ({ status: "Изменено", mac: item.after.mac || item.before.mac, before: describe(item.before), after: describe(item.after), changes: item.changes.map((change) => `${change.label}: ${change.oldValue} → ${change.newValue}`).join("; ") }) },
    { status: "Без изменений", rows: comparison.unchanged, create: (item) => ({ status: "Без изменений", mac: item.after.mac || item.before.mac, before: describe(item.before), after: describe(item.after), changes: "" }) },
    { status: "Неоднозначно", rows: comparison.ambiguous, create: (item) => ({ status: "Неоднозначно", mac: item.after.mac, before: item.candidates.map(describe).join(" | "), after: describe(item.after), changes: "Сильные идентификаторы конфликтуют; проверьте вручную" }) },
  ];
  const total = segments.reduce((count, segment) => count + segment.rows.length, 0);
  const lastOffset = total ? Math.floor((total - 1) / pageSize) * pageSize : 0;
  const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const pageOffset = Math.min(lastOffset, Math.floor(requestedOffset / pageSize) * pageSize);
  const rows = [];
  let skipped = pageOffset;
  for (const segment of segments) {
    if (skipped >= segment.rows.length) {
      skipped -= segment.rows.length;
      continue;
    }
    for (let index = skipped; index < segment.rows.length && rows.length < pageSize; index += 1) rows.push(segment.create(segment.rows[index]));
    skipped = 0;
    if (rows.length >= pageSize) break;
  }
  return {
    rows: rows.map((row) => ({ ...row, file1: pair.file1, file2: pair.file2 })),
    total,
    offset: pageOffset,
    limit: pageSize,
    page: pageSize ? Math.floor(pageOffset / pageSize) + 1 : 1,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    hasPrevious: pageOffset > 0,
    hasNext: pageOffset + rows.length < total,
  };
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
  return `${CSV_COLUMNS.map((item) => csvQuote(item.label)).join(";")}\r\n`;
}

export function pairwiseComparisonCsv(pair, result) {
  return [...pairwiseComparisonCsvChunks(pair, result)].join("");
}

export function* pairwiseComparisonCsvChunks(pair, result) {
  if (!pair || (!result?.comparison && !result?.comparisonPlan)) throw new TypeError("Для CSV сравнения нужны пара файлов и результат сравнения");
  if (result.comparisonPlan) {
    for (const { type, value } of planEventsInOrder(result.comparisonPlan)) {
      if (type === "added") yield `${[pair.file1, pair.file2, "Только во втором файле", value.mac, "", describe(value), ""].map(csvQuote).join(";")}\r\n`;
      else if (type === "absent") yield `${[pair.file1, pair.file2, "Только в первом файле", value.mac, describe(value), "", ""].map(csvQuote).join(";")}\r\n`;
      else if (type === "modified") yield `${[pair.file1, pair.file2, "Изменено", value.after.mac || value.before.mac, describe(value.before), describe(value.after), value.changes.map((change) => `${change.label}: ${change.oldValue} → ${change.newValue}`).join("; ")].map(csvQuote).join(";")}\r\n`;
      else if (type === "unchanged") yield `${[pair.file1, pair.file2, "Без изменений", value.after.mac || value.before.mac, describe(value.before), describe(value.after), ""].map(csvQuote).join(";")}\r\n`;
      else yield `${[pair.file1, pair.file2, "Неоднозначно", value.after.mac, value.candidates.map(describe).join(" | "), describe(value.after), "Сильные идентификаторы конфликтуют; проверьте вручную"].map(csvQuote).join(";")}\r\n`;
    }
    return;
  }
  const comparison = result.comparison;
  const csvRow = (status, mac, before = "", after = "", changes = "") => `${[
    pair.file1,
    pair.file2,
    status,
    mac,
    before,
    after,
    changes,
  ].map(csvQuote).join(";")}\r\n`;
  for (const device of comparison.added) yield csvRow("Только во втором файле", device.mac, "", describe(device));
  for (const device of comparison.absent) yield csvRow("Только в первом файле", device.mac, describe(device));
  for (const item of comparison.modified) {
    yield csvRow("Изменено", item.after.mac || item.before.mac, describe(item.before), describe(item.after), item.changes.map((change) => `${change.label}: ${change.oldValue} → ${change.newValue}`).join("; "));
  }
  for (const item of comparison.unchanged) yield csvRow("Без изменений", item.after.mac || item.before.mac, describe(item.before), describe(item.after));
  for (const item of comparison.ambiguous) {
    const candidates = item.candidates.map(describe).join(" | ");
    yield csvRow("Неоднозначно", item.after.mac, candidates, describe(item.after), "Сильные идентификаторы конфликтуют; проверьте вручную");
  }
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
}

async function* comparisonWorkbookRows(result, signal) {
  if (result.comparisonPlan) {
    for (const { type, value } of planEventsInOrder(result.comparisonPlan, ["absent", "added", "modified", "unchanged", "ambiguous"])) {
      throwIfAborted(signal);
      if (type === "absent") yield [firstMac(value.macFormatted, value.mac), "Только в первом файле", deviceSummary(value), "—", "Устройство отсутствует во втором файле"];
      else if (type === "added") yield [firstMac(value.macFormatted, value.mac), "Только во втором файле", "—", deviceSummary(value), "Устройство отсутствует в первом файле"];
      else if (type === "modified") yield [firstMac(value.after.macFormatted, value.after.mac, value.before.mac), "Изменено", deviceSummary(value.before), deviceSummary(value.after), value.changes.map(({ label, oldValue, newValue }) => `${label}: ${oldValue} → ${newValue}`).join("\n")];
      else if (type === "unchanged") yield [firstMac(value.after.macFormatted, value.after.mac, value.before.mac), "Без изменений", deviceSummary(value.before), deviceSummary(value.after), "Данные совпадают"];
      else yield [firstMac(value.after.macFormatted, value.after.mac), "Неоднозначно", value.candidates.map(deviceSummary).join(" | "), deviceSummary(value.after), "Сильные идентификаторы конфликтуют; проверьте вручную"];
    }
    throwIfAborted(signal);
    return;
  }
  const comparison = result.comparison;
  for (const device of comparison.absent) {
    throwIfAborted(signal);
    yield [firstMac(device.macFormatted, device.mac), "Только в первом файле", deviceSummary(device), "—", "Устройство отсутствует во втором файле"];
  }
  for (const device of comparison.added) {
    throwIfAborted(signal);
    yield [firstMac(device.macFormatted, device.mac), "Только во втором файле", "—", deviceSummary(device), "Устройство отсутствует в первом файле"];
  }
  for (const item of comparison.modified) {
    throwIfAborted(signal);
    yield [firstMac(item.after.macFormatted, item.after.mac, item.before.mac), "Изменено", deviceSummary(item.before), deviceSummary(item.after),
      item.changes.map(({ label, oldValue, newValue }) => `${label}: ${oldValue} → ${newValue}`).join("\n")];
  }
  for (const item of comparison.unchanged) {
    throwIfAborted(signal);
    yield [firstMac(item.after.macFormatted, item.after.mac, item.before.mac), "Без изменений", deviceSummary(item.before), deviceSummary(item.after), "Данные совпадают"];
  }
  for (const item of comparison.ambiguous) {
    throwIfAborted(signal);
    yield [firstMac(item.after.macFormatted, item.after.mac), "Неоднозначно", item.candidates.map(deviceSummary).join(" | "), deviceSummary(item.after), "Сильные идентификаторы конфликтуют; проверьте вручную"];
  }
  throwIfAborted(signal);
}

/** Build a bounded XLSX sheet stream for every directed pair and PyQt-style statistics. */
export function multiFileComparisonWorkbookSheets(pairs = [], files = [], loadPair, { signal } = {}) {
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
      throwIfAborted(signal);
      if (!pairResult) {
        pairResult = await loadPair(pair);
        throwIfAborted(signal);
        fileCounts[pair.first] = pairResult.before.summary.valid;
        fileCounts[pair.second] = pairResult.after.summary.valid;
      }
      return pairResult;
    };
    sheets.push({
      name: baseName,
      headings: ["MAC", "Тип", "Значение файла 1", "Значение файла 2", "Изменения"],
      rows: (async function* () { yield* comparisonWorkbookRows(await getResult(), signal); })(),
    });
    sheets.push({
      name: `Статистика ${baseName}`,
      headings: ["Показатель", "Значение"],
      rows: (async function* () {
        const comparison = (await getResult()).comparison;
        const plan = pairResult.comparisonPlan;
        const added = plan?.addedCount ?? comparison.added.length;
        const absent = plan?.absentCount ?? comparison.absent.length;
        const modified = plan?.modifiedDeviceCount ?? comparison.modified.length;
        const unchanged = plan?.unchangedCount ?? comparison.unchanged.length;
        const ambiguous = plan?.ambiguousCount ?? comparison.ambiguous.length;
        const counts = [
          ["Устройств только в первом файле", absent],
          ["Устройств только во втором файле", added],
          ["Общих устройств", modified + unchanged],
          ["Изменённых устройств", modified],
          ["Совпадающих устройств", unchanged],
          ["Неоднозначных соответствий", ambiguous],
        ];
        for (const row of counts) {
          throwIfAborted(signal);
          yield row;
        }
        pairResult = null;
      })(),
    });
  }
  sheets.push({
    name: "Общая статистика",
    headings: ["Файл", "Устройств"],
    rows: (async function* () {
      for (let index = 0; index < files.length; index += 1) {
        throwIfAborted(signal);
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
