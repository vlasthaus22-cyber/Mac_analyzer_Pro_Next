import { csvQuote } from "./csv-cell.js";
import { firstMac, normalizeMac } from "./normalize.js";
import { comparisonChanges, createFinalComparisonEventPlan, hasFinalComparisonFieldChange } from "./comparison.js";
import { buildPositionedIdentityIndex, findIdentityMatch, identityLookupKeys, identityTokens } from "./identity.js";

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
  function* events(type, { offset = 0, limit = Number.POSITIVE_INFINITY } = {}) {
    const pageOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const pageLimit = Math.max(0, Math.floor(Number(limit)) || 0);
    if (pageLimit === 0) return;
    if (type === "modified") {
      for (const event of base.events(type, { predicate: selectedChange, offset: pageOffset, limit: pageLimit })) {
        const changes = selectChanges(event.row, selected);
        if (changes.length) yield { ...event, row: { ...event.row, changes } };
      }
      return;
    }
    if (type === "unchanged") {
      const notSelectedChange = (beforeDevice, afterDevice) => !selectedChange(beforeDevice, afterDevice);
      const unchangedOffset = Math.min(pageOffset, base.unchangedCount);
      let remaining = pageLimit;
      for (const event of base.events(type, { offset: unchangedOffset, limit: remaining })) {
        yield event;
        remaining -= 1;
      }
      if (remaining <= 0) return;
      const filteredModifiedOffset = Math.max(0, pageOffset - base.unchangedCount);
      for (const event of base.events("modified", { predicate: notSelectedChange, includeChanges: false, offset: filteredModifiedOffset, limit: remaining })) {
        yield { type, row: event.row };
      }
      return;
    }
    yield* base.events(type, { offset: pageOffset, limit: pageLimit });
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

/** Move a non-streamable analysis result into bounded staging pages, releasing its source rows as they commit. */
export async function consumeMultiFileAnalysisIntoStage(analysis, deviceStore, { signal, batchSize = 500 } = {}) {
  if (!Array.isArray(analysis?.devices)) throw new TypeError("Анализ нескольких файлов не содержит массива устройств для staging");
  if (!deviceStore || typeof deviceStore.appendPage !== "function" || typeof deviceStore.readIdentityEntries !== "function") throw new TypeError("Для staging сравнения нужен пакетный временный store с индексом идентичности");
  const devices = analysis.devices;
  const total = devices.length;
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(batchSize) || 500)));
  try {
    for (let offset = 0; offset < total; offset += pageSize) {
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      const end = Math.min(total, offset + pageSize);
      const page = devices.slice(offset, end);
      const keys = [...new Set(page.flatMap((device) => identityLookupKeys(device)))];
      const identityEntries = await deviceStore.readIdentityEntries(keys);
      const index = { devices: { length: total }, tokens: identityEntries };
      page.forEach((device, indexInPage) => addStagedIdentity(index, device, offset + indexInPage));
      await deviceStore.appendPage(page, { offset, total, identityEntries });
      page.length = 0;
      for (let index = offset; index < end; index += 1) devices[index] = null;
    }
    if (total) await deviceStore.finalize?.(total);
    return total;
  } finally {
    devices.length = 0;
  }
}

function addStagedIdentity(index, device, position) {
  for (const token of identityTokens(device)) {
    const current = index.tokens.get(token.key);
    if (current === undefined) index.tokens.set(token.key, position);
    else if (typeof current === "number") {
      if (current !== position) index.tokens.set(token.key, [2, current, position]);
    } else if (current[1] !== position && current[2] !== position) {
      current[0] += 1;
      if (current[0] <= 2) current[current[0]] = position;
    }
  }
}

/** Compare two IndexedDB staging stores without materializing either full device set. */
export async function createStagedMultiFileComparisonPlan(beforeStore, afterStore, timestamp = new Date().toISOString(), selected = {}, { signal, batchSize = 500 } = {}) {
  if (!beforeStore || !afterStore || typeof beforeStore.readPage !== "function" || typeof afterStore.readPage !== "function"
    || typeof beforeStore.readIdentityEntries !== "function" || typeof beforeStore.readPositions !== "function") {
    throw new TypeError("Для потокового сравнения нужны временные IndexedDB stores с пакетным чтением и индексом идентичности");
  }
  const beforeCount = beforeStore.count;
  const afterCount = afterStore.count;
  if (!Number.isSafeInteger(beforeCount) || beforeCount < 0 || !Number.isSafeInteger(afterCount) || afterCount < 0) throw new RangeError("Некорректное число устройств во временном хранилище");
  const size = Math.max(1, Math.min(500, Math.floor(Number(batchSize) || 500)));
  const STATUS = { added: 1, absent: 2, modified: 3, unchanged: 4, ambiguous: 5 };
  const currentStatus = new Uint8Array(afterCount);
  const matchedPosition = new Int32Array(afterCount).fill(-1);
  const ambiguousDetails = new Map();
  const matchedBefore = new Uint8Array(Math.ceil(beforeCount / 8));
  const ambiguousTokens = new Set();
  const counts = { addedCount: 0, absentCount: 0, modifiedDeviceCount: 0, unchangedCount: 0, ambiguousCount: 0, identityConflictCount: 0 };
  const wasMatched = (position) => (matchedBefore[position >> 3] & (1 << (position & 7))) !== 0;
  const markMatched = (position) => { if (position >= 0 && position < beforeCount) matchedBefore[position >> 3] |= 1 << (position & 7); };
  for (let offset = 0; offset < afterCount; offset += size) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const currentPage = await afterStore.readPage(offset, Math.min(size, afterCount - offset));
    const keys = [...new Set(currentPage.flatMap((device) => identityLookupKeys(device)))];
    const entries = await beforeStore.readIdentityEntries(keys);
    const positions = new Set();
    for (const entry of entries.values()) {
      if (typeof entry === "number") positions.add(entry);
      else if (Array.isArray(entry)) { if (Number.isInteger(entry[1])) positions.add(entry[1]); if (Number.isInteger(entry[2])) positions.add(entry[2]); }
    }
    const candidateDevices = await beforeStore.readPositions([...positions]);
    const candidates = [...positions].map((position) => ({ position, device: candidateDevices.get(position) })).filter((item) => item.device);
    const identityIndex = buildPositionedIdentityIndex(candidates, beforeCount);
    identityIndex.tokens = entries;
    for (let local = 0; local < currentPage.length; local += 1) {
      const position = offset + local;
      const after = currentPage[local];
      const match = findIdentityMatch(after, identityIndex);
      if (match.status === "ambiguous" && !match.strongIdentityUnmatched) {
        currentStatus[position] = STATUS.ambiguous; counts.ambiguousCount += 1;
        const candidatePositions = match.candidates.map(({ position: candidatePosition }) => candidatePosition);
        candidatePositions.forEach(markMatched);
        (match.ambiguousTokenKeys || []).forEach((key) => ambiguousTokens.add(key));
        ambiguousDetails.set(position, { positions: candidatePositions, conflicts: false });
      } else if (match.status !== "matched") {
        currentStatus[position] = STATUS.added; counts.addedCount += 1;
      } else if (match.identityConflicts?.length) {
        currentStatus[position] = STATUS.ambiguous; counts.ambiguousCount += 1; counts.identityConflictCount += match.identityConflicts.length;
        markMatched(match.position); match.identityConflicts.forEach(({ position: candidatePosition }) => markMatched(candidatePosition));
        ambiguousDetails.set(position, { positions: [match.position, ...match.identityConflicts.map(({ position: candidatePosition }) => candidatePosition)], conflicts: true });
      } else {
        markMatched(match.position); matchedPosition[position] = match.position;
        const before = match.match;
        if (hasSelectedChanges(before, after, selected)) { currentStatus[position] = STATUS.modified; counts.modifiedDeviceCount += 1; }
        else { currentStatus[position] = STATUS.unchanged; counts.unchangedCount += 1; }
      }
    }
    identityIndex.clearCandidates?.();
    currentPage.length = 0;
  }
  for (let offset = 0; offset < beforeCount; offset += size) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const page = await beforeStore.readPage(offset, Math.min(size, beforeCount - offset));
    for (let local = 0; local < page.length; local += 1) {
      const position = offset + local;
      if (!wasMatched(position) && !identityTokens(page[local]).some(({ key }) => ambiguousTokens.has(key))) counts.absentCount += 1;
    }
    page.length = 0;
  }
  const statusOffsets = {};
  let nextStatusOffset = 0;
  for (const type of ["added", "modified", "unchanged", "ambiguous"]) {
    statusOffsets[type] = nextStatusOffset;
    nextStatusOffset += type === "added" ? counts.addedCount : type === "modified" ? counts.modifiedDeviceCount : type === "unchanged" ? counts.unchangedCount : counts.ambiguousCount;
  }
  const statusPositions = new Uint32Array(afterCount);
  const statusCursors = { ...statusOffsets };
  for (let position = 0; position < currentStatus.length; position += 1) {
    const code = currentStatus[position];
    const type = code === STATUS.added ? "added" : code === STATUS.modified ? "modified" : code === STATUS.unchanged ? "unchanged" : code === STATUS.ambiguous ? "ambiguous" : "";
    if (type) statusPositions[statusCursors[type]++] = position;
  }
  const absentPositions = new Uint32Array(counts.absentCount);
  let absentCursor = 0;
  for (let offset = 0; offset < beforeCount; offset += size) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const page = await beforeStore.readPage(offset, Math.min(size, beforeCount - offset));
    for (let local = 0; local < page.length; local += 1) {
      const position = offset + local;
      if (!wasMatched(position) && !identityTokens(page[local]).some(({ key }) => ambiguousTokens.has(key))) absentPositions[absentCursor++] = position;
    }
    page.length = 0;
  }
  if (absentCursor !== counts.absentCount) throw new Error("Число строк отсутствия изменилось при построении индекса сравнения");
  let disposed = false;
  const eventsPage = async (type, { offset = 0, limit = 500 } = {}) => {
    if (disposed) throw new Error("План сравнения уже освобождён");
    const max = Math.max(0, Math.min(1_000, Math.floor(Number(limit) || 0)));
    const skip = Math.max(0, Math.floor(Number(offset) || 0));
    if (!max) return [];
    if (type !== "absent" && statusOffsets[type] === undefined) throw new TypeError(`Неизвестный статус сравнения: ${type}`);
    const positions = type === "absent"
      ? absentPositions.subarray(skip, Math.min(absentPositions.length, skip + max))
      : statusPositions.subarray(statusOffsets[type] + skip, Math.min(statusOffsets[type] + (type === "added" ? counts.addedCount : type === "modified" ? counts.modifiedDeviceCount : type === "unchanged" ? counts.unchangedCount : counts.ambiguousCount), statusOffsets[type] + skip + max));
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const found = [];
    if (type === "added" || type === "absent") {
      const store = type === "absent" ? beforeStore : afterStore;
      const devices = await store.readPositions([...positions]);
      for (const position of positions) found.push({ type, device: devices.get(position) });
    } else if (type === "modified" || type === "unchanged") {
      const currentPositions = [...positions];
      const beforePositions = currentPositions.map((position) => matchedPosition[position]);
      const [beforeDevices, afterDevices] = await Promise.all([beforeStore.readPositions(beforePositions), afterStore.readPositions(currentPositions)]);
      for (const position of currentPositions) {
        const before = beforeDevices.get(matchedPosition[position]); const after = afterDevices.get(position);
        const changes = type === "modified" ? selectChanges({ before, after, changes: comparisonChanges(before, after, timestamp) }, selected) : [];
        found.push({ type, row: { identity: "", before, after, changes } });
      }
    } else {
      const candidatePositions = [...new Set(Array.from(positions).flatMap((position) => ambiguousDetails.get(position)?.positions || []))];
      const [candidateDevices, afterDevices] = await Promise.all([beforeStore.readPositions(candidatePositions), afterStore.readPositions([...positions])]);
      for (const position of positions) {
        const details = ambiguousDetails.get(position) || { positions: [], conflicts: false };
        const after = afterDevices.get(position);
        found.push({ type, item: { after, candidates: details.positions.map((candidatePosition) => candidateDevices.get(candidatePosition)).filter(Boolean), reason: details.conflicts ? "conflicting-strong-identifiers" : "insufficient-strong-identity" } });
      }
    }
    return found;
  };
  const countModifiedWhere = () => counts.modifiedDeviceCount;
  return {
    ...counts,
    timestamp,
    async eventsPage(type, options) { return eventsPage(type, options); },
    countModifiedWhere,
    clear() { disposed = true; ambiguousDetails.clear(); ambiguousTokens.clear(); matchedBefore.fill(0); currentStatus.fill(0); matchedPosition.fill(-1); statusPositions.fill(0); absentPositions.fill(0); },
  };
}

export async function multiFileComparisonRowsPageAsync(pair, result, { offset = 0, limit = 100 } = {}) {
  if (!pair || !result?.comparisonPlan?.eventsPage) return multiFileComparisonRowsPage(pair, result, { offset, limit });
  const plan = result.comparisonPlan;
  const pageSize = Math.max(1, Math.min(1_000, Math.floor(Number(limit) || 100)));
  const counts = [plan.addedCount, plan.absentCount, plan.modifiedDeviceCount, plan.unchangedCount, plan.ambiguousCount];
  const total = counts.reduce((sum, count) => sum + count, 0);
  const lastOffset = total ? Math.floor((total - 1) / pageSize) * pageSize : 0;
  const pageOffset = Math.min(lastOffset, Math.floor(Math.max(0, Number(offset) || 0) / pageSize) * pageSize);
  const types = ["added", "absent", "modified", "unchanged", "ambiguous"];
  const labels = { added: "Только во втором файле", absent: "Только в первом файле", modified: "Изменено", unchanged: "Без изменений", ambiguous: "Неоднозначно" };
  const rows = [];
  let skipped = pageOffset;
  for (let index = 0; index < types.length && rows.length < pageSize; index += 1) {
    const type = types[index];
    if (skipped >= counts[index]) { skipped -= counts[index]; continue; }
    const events = await plan.eventsPage(type, { offset: skipped, limit: pageSize - rows.length });
    skipped = 0;
    for (const event of events) {
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
    }
  }
  return { rows, total, offset: pageOffset, limit: pageSize, page: Math.floor(pageOffset / pageSize) + 1, pageCount: Math.max(1, Math.ceil(total / pageSize)), hasPrevious: pageOffset > 0, hasNext: pageOffset + rows.length < total };
}

async function* planEventsInOrderAsync(plan, order = ["added", "absent", "modified", "unchanged", "ambiguous"], signal) {
  for (const type of order) {
    const count = type === "added" ? plan.addedCount : type === "absent" ? plan.absentCount : type === "modified" ? plan.modifiedDeviceCount : type === "unchanged" ? plan.unchangedCount : plan.ambiguousCount;
    for (let offset = 0; offset < count; offset += 500) {
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      for (const event of await plan.eventsPage(type, { offset, limit: Math.min(500, count - offset) })) yield { type, value: planRow(type, event) };
    }
  }
}

export async function* pairwiseComparisonCsvChunksAsync(pair, result, { signal } = {}) {
  if (!result?.comparisonPlan?.eventsPage) { yield* pairwiseComparisonCsvChunks(pair, result); return; }
  if (!pair) throw new TypeError("Для CSV сравнения нужны пара файлов и результат сравнения");
  for await (const { type, value } of planEventsInOrderAsync(result.comparisonPlan, undefined, signal)) {
    if (type === "added") yield `${[pair.file1, pair.file2, "Только во втором файле", value.mac, "", describe(value), ""].map(csvQuote).join(";")}\r\n`;
    else if (type === "absent") yield `${[pair.file1, pair.file2, "Только в первом файле", value.mac, describe(value), "", ""].map(csvQuote).join(";")}\r\n`;
    else if (type === "modified") yield `${[pair.file1, pair.file2, "Изменено", value.after.mac || value.before.mac, describe(value.before), describe(value.after), value.changes.map((change) => `${change.label}: ${change.oldValue} → ${change.newValue}`).join("; ")].map(csvQuote).join(";")}\r\n`;
    else if (type === "unchanged") yield `${[pair.file1, pair.file2, "Без изменений", value.after.mac || value.before.mac, describe(value.before), describe(value.after), ""].map(csvQuote).join(";")}\r\n`;
    else yield `${[pair.file1, pair.file2, "Неоднозначно", value.after.mac, value.candidates.map(describe).join(" | "), describe(value.after), "Сильные идентификаторы конфликтуют; проверьте вручную"].map(csvQuote).join(";")}\r\n`;
  }
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
      const remaining = pageSize - rows.length;
      for (const event of plan.events(type, { offset: skipped, limit: remaining })) {
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
    if (result.comparisonPlan.eventsPage) {
      for await (const { type, value } of planEventsInOrderAsync(result.comparisonPlan, ["absent", "added", "modified", "unchanged", "ambiguous"], signal)) {
        if (type === "absent") yield [firstMac(value.macFormatted, value.mac), "Только в первом файле", deviceSummary(value), "—", "Устройство отсутствует во втором файле"];
        else if (type === "added") yield [firstMac(value.macFormatted, value.mac), "Только во втором файле", "—", deviceSummary(value), "Устройство отсутствует в первом файле"];
        else if (type === "modified") yield [firstMac(value.after.macFormatted, value.after.mac, value.before.mac), "Изменено", deviceSummary(value.before), deviceSummary(value.after), value.changes.map(({ label, oldValue, newValue }) => `${label}: ${oldValue} → ${newValue}`).join("\n")];
        else if (type === "unchanged") yield [firstMac(value.after.macFormatted, value.after.mac, value.before.mac), "Без изменений", deviceSummary(value.before), deviceSummary(value.after), "Данные совпадают"];
        else yield [firstMac(value.after.macFormatted, value.after.mac), "Неоднозначно", value.candidates.map(deviceSummary).join(" | "), deviceSummary(value.after), "Сильные идентификаторы конфликтуют; проверьте вручную"];
      }
      throwIfAborted(signal);
      return;
    }
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
        pairResult.comparisonPlan?.clear?.();
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
