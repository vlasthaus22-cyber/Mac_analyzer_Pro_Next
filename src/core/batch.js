import { detectMapping, fileObservationDate, readTablePreview } from "../data/importer.js";
import { batchSourceFileRelativePath } from "./batch-directory-handles.js";

export const BATCH_ROLES = Object.freeze(["main", "smartroom", "ddio"]);
export const BATCH_FAILURE_POLICIES = Object.freeze(["continue", "stop"]);

export function normalizeBatchPairing(options = {}) {
  const value = Number(options.toleranceHours);
  return {
    mode: options.mode === "same-date" ? "same-date" : "nearest",
    toleranceHours: Number.isFinite(value) ? Math.max(0, Math.min(720, value)) : 24,
  };
}

export function batchFailureAction(policy, error) {
  if (error?.name === "AbortError") return "stop";
  if (!BATCH_FAILURE_POLICIES.includes(policy)) throw new Error(`Неизвестная политика очереди: ${policy}`);
  return policy === "stop" ? "stop" : "continue";
}

export async function runBatchQueue(pairs = [], executePair, options = {}) {
  if (typeof executePair !== "function") throw new Error("Для массовой очереди требуется обработчик пары");
  const failurePolicy = options.failurePolicy || "continue";
  if (!BATCH_FAILURE_POLICIES.includes(failurePolicy)) throw new Error(`Неизвестная политика очереди: ${failurePolicy}`);
  const onStart = options.onStart || (() => {});
  const onComplete = options.onComplete || (() => {});
  const onError = options.onError || (() => {});
  const onQueueState = options.onQueueState || (() => {});
  let completed = 0;
  let stopped = false;
  let failedPairIndex = null;
  let cancelled = false;
  const errors = [];
  const observerErrors = [];
  const notify = async (phase, callback, pair, index, ...args) => {
    try {
      return await callback(...args);
    } catch (error) {
      observerErrors.push({ phase, pairIndex: index + 1, pair, error });
      return undefined;
    }
  };

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair.enabled === false) {
      pair.status = "skipped";
      pair.queueMessage = "Цикл отключён пользователем.";
      await notify("queue-state", onQueueState, pair, index, pair, index);
      continue;
    }
    pair.status = "processing";
    pair.result = null;
    pair.errorMessage = "";
    pair.queueMessage = "";
    await notify("start", onStart, pair, index, pair, index);
    try {
      pair.result = await executePair(pair, index);
      pair.status = pair.result?.metadata?.reused ? "reused" : "completed";
      completed += 1;
      await notify("complete", onComplete, pair, index, pair, index);
    } catch (error) {
      pair.status = error?.name === "AbortError" ? "cancelled" : "error";
      pair.errorMessage = await notify("error", onError, pair, index, error, pair, index)
        || (error instanceof Error ? error.message : String(error));
      errors.push({ pairIndex: index + 1, pair, error, message: pair.errorMessage });
      if (error?.name === "AbortError") cancelled = true;
      if (batchFailureAction(failurePolicy, error) === "stop") {
        if (error?.name !== "AbortError") {
          stopped = true;
          failedPairIndex = index + 1;
        }
        break;
      }
    }
  }
  if (stopped || cancelled) {
    const reason = cancelled ? "обработка отменена" : `очередь остановлена после ошибки пары №${failedPairIndex}`;
    const firstUnvisited = errors.at(-1)?.pairIndex ?? pairs.length;
    for (let index = firstUnvisited; index < pairs.length; index += 1) {
      const pair = pairs[index];
      if (pair.status !== "ready") continue;
      if (pair.enabled === false) {
        pair.status = "skipped";
        pair.queueMessage = "Цикл отключён пользователем.";
      } else {
        pair.queueMessage = `Не запускался: ${reason}.`;
      }
      await notify("queue-state", onQueueState, pair, index, pair, index);
    }
  }
  return { completed, errors, observerErrors, stopped, failedPairIndex, cancelled };
}

const STRONG_FIELDS = Object.freeze({
  main: ["id", "deviceId", "serial", "mac", "mac2"],
  smartroom: ["id", "deviceId", "serial", "mac", "mac2"],
});

function supported(file) {
  return file && /\.(csv|tsv|txt|json|xlsx|xlsm|xls)$/i.test(file.name || "");
}

export function compactSupportedBatchFiles(files = []) {
  const accepted = Array.isArray(files) ? files : Array.from(files || []);
  let write = 0;
  for (let read = 0; read < accepted.length; read += 1) {
    if (supported(accepted[read])) accepted[write++] = accepted[read];
  }
  accepted.length = write;
  return accepted;
}

function fileId(role, file, index) {
  return [role, index, batchSourceFileRelativePath(file), file.size || 0, file.lastModified || 0].join(":");
}

export async function prepareBatchEntries(files = [], role, onProgress = () => {}) {
  if (!BATCH_ROLES.includes(role)) throw new Error(`Неизвестный источник массового обогащения: ${role}`);
  const source = Array.isArray(files) || Number.isSafeInteger(files?.length) ? files : Array.from(files || []);
  const sourceCount = source.length;
  let acceptedCount = 0;
  for (let index = 0; index < sourceCount; index += 1) if (supported(source[index])) acceptedCount += 1;
  const entries = new Array(acceptedCount);
  let nextSourceIndex = 0;
  let nextEntryIndex = 0;
  const worker = async () => {
    while (true) {
      const sourceIndex = nextSourceIndex++;
      if (sourceIndex >= sourceCount) return;
      const file = source[sourceIndex];
      if (!supported(file)) continue;
      const index = nextEntryIndex++;
      const relativePath = batchSourceFileRelativePath(file);
      onProgress({ role, index, total: acceptedCount, file });
      try {
        const preview = await readTablePreview(file);
        entries[index] = {
          id: fileId(role, file, index),
          role,
          file,
          relativePath,
          date: fileObservationDate(file, preview.workbookCreatedAt, preview.workbookModifiedAt),
          headers: preview.headers,
          previewRows: preview.rows,
          rowCount: preview.rowCount,
          sheet: preview.sheet || "",
          workbookCreatedAt: preview.workbookCreatedAt || "",
          workbookModifiedAt: preview.workbookModifiedAt || "",
          mapping: detectMapping(preview.headers, preview.rows, role),
          error: "",
        };
      } catch (error) {
        entries[index] = {
          id: fileId(role, file, index),
          role,
          file,
          relativePath,
          date: fileObservationDate(file),
          headers: [],
          previewRows: [],
          rowCount: null,
          mapping: {},
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, acceptedCount) }, () => worker()));
  return entries;
}

function entryTime(entry) {
  if (entry?.date?.source === "import-time") return 0;
  const value = Date.parse(entry?.date?.date || "");
  return Number.isFinite(value) ? value : 0;
}

export function pairBatchEntries(mainEntries = [], smartroomEntries = [], ddioEntries = [], options = {}) {
  const { mode, toleranceHours } = normalizeBatchPairing(options);
  const toleranceMs = toleranceHours * 60 * 60 * 1000;
  const assign = (mains, candidates) => {
    const orderedCandidates = [];
    candidates.forEach((candidate, index) => {
      const time = entryTime(candidate);
      if (time) orderedCandidates.push({ candidate, time, index });
    });
    orderedCandidates.sort((left, right) => left.time - right.time
      || (left.candidate.relativePath || batchSourceFileRelativePath(left.candidate.file)).localeCompare(right.candidate.relativePath || batchSourceFileRelativePath(right.candidate.file), "ru", { numeric: true })
      || left.index - right.index);
    const mainTimes = mains.map(entryTime);
    const allowed = (mainIndex, candidateIndex) => {
      const mainTime = mainTimes[mainIndex];
      const candidateTime = orderedCandidates[candidateIndex].time;
      if (!mainTime || !candidateTime) return false;
      if (mode !== "same-date") return Math.abs(candidateTime - mainTime) <= toleranceMs;
      const dayStart = Math.floor(mainTime / 86_400_000) * 86_400_000;
      return candidateTime >= dayStart && candidateTime < dayStart + 86_400_000;
    };
    const scoreAlignment = (mainStart, mainEnd, candidateStart, candidateEnd, reverse = false) => {
      const width = candidateEnd - candidateStart;
      let previousCounts = new Uint32Array(width + 1);
      let previousCosts = new Float64Array(width + 1);
      for (let row = 1; row <= mainEnd - mainStart; row += 1) {
        const mainIndex = reverse ? mainEnd - row : mainStart + row - 1;
        const currentCounts = new Uint32Array(width + 1);
        const currentCosts = new Float64Array(width + 1);
        for (let column = 1; column <= width; column += 1) {
          const candidateIndex = reverse ? candidateEnd - column : candidateStart + column - 1;
          let bestCount = previousCounts[column];
          let bestCost = previousCosts[column];
          if (currentCounts[column - 1] > bestCount
            || (currentCounts[column - 1] === bestCount && currentCosts[column - 1] < bestCost)) {
            bestCount = currentCounts[column - 1];
            bestCost = currentCosts[column - 1];
          }
          if (allowed(mainIndex, candidateIndex)) {
            const matchCount = previousCounts[column - 1] + 1;
            const matchCost = previousCosts[column - 1] + Math.abs(mainTimes[mainIndex] - orderedCandidates[candidateIndex].time);
            if (matchCount > bestCount || (matchCount === bestCount && matchCost < bestCost)) {
              bestCount = matchCount;
              bestCost = matchCost;
            }
          }
          currentCounts[column] = bestCount;
          currentCosts[column] = bestCost;
        }
        previousCounts = currentCounts;
        previousCosts = currentCosts;
      }
      return { counts: previousCounts, costs: previousCosts };
    };
    const candidateSplitFor = (mainStart, middle, mainEnd, candidateStart, candidateEnd) => {
      const candidateCount = candidateEnd - candidateStart;
      const left = scoreAlignment(mainStart, middle, candidateStart, candidateEnd);
      const right = scoreAlignment(middle, mainEnd, candidateStart, candidateEnd, true);
      let split = 0;
      let bestCount = -1;
      let bestCost = Infinity;
      for (let prefixCount = 0; prefixCount <= candidateCount; prefixCount += 1) {
        const count = left.counts[prefixCount] + right.counts[candidateCount - prefixCount];
        const cost = left.costs[prefixCount] + right.costs[candidateCount - prefixCount];
        if (count > bestCount || (count === bestCount && (cost < bestCost || (cost === bestCost && prefixCount > split)))) {
          split = prefixCount;
          bestCount = count;
          bestCost = cost;
        }
      }
      return split;
    };
    const mainAssignments = new Map();
    const align = (mainStart, mainEnd, candidateStart, candidateEnd) => {
      const mainCount = mainEnd - mainStart;
      const candidateCount = candidateEnd - candidateStart;
      if (!mainCount || !candidateCount) return;
      if (mainCount === 1) {
        let selected = -1;
        let nearest = Infinity;
        for (let index = candidateStart; index < candidateEnd; index += 1) {
          if (!allowed(mainStart, index)) continue;
          const distance = Math.abs(mainTimes[mainStart] - orderedCandidates[index].time);
          if (distance < nearest) { selected = index; nearest = distance; }
        }
        if (selected >= 0) mainAssignments.set(mainStart, orderedCandidates[selected].candidate);
        return;
      }
      if (candidateCount === 1) {
        let selected = -1;
        let nearest = Infinity;
        for (let index = mainStart; index < mainEnd; index += 1) {
          if (!allowed(index, candidateStart)) continue;
          const distance = Math.abs(mainTimes[index] - orderedCandidates[candidateStart].time);
          if (distance < nearest) { selected = index; nearest = distance; }
        }
        if (selected >= 0) mainAssignments.set(selected, orderedCandidates[candidateStart].candidate);
        return;
      }
      const middle = mainStart + Math.floor(mainCount / 2);
      const split = candidateSplitFor(mainStart, middle, mainEnd, candidateStart, candidateEnd);
      const candidateMiddle = candidateStart + split;
      align(mainStart, middle, candidateStart, candidateMiddle);
      align(middle, mainEnd, candidateMiddle, candidateEnd);
    };
    align(0, mains.length, 0, orderedCandidates.length);
    const matches = new Map([...mainAssignments].map(([mainIndex, candidate]) => [mains[mainIndex].id, candidate]));
    const assignedCandidates = new Set([...mainAssignments.values()].map(({ id }) => id));
    return { matches, assignedCandidates };
  };
  const orderedMain = [...mainEntries]
    .sort((left, right) => entryTime(left) - entryTime(right)
      || (left.relativePath || batchSourceFileRelativePath(left.file)).localeCompare(right.relativePath || batchSourceFileRelativePath(right.file), "ru", { numeric: true }))
  const smartroomAssignments = assign(orderedMain, smartroomEntries);
  const ddioAssignments = assign(orderedMain, ddioEntries);
  const pairs = orderedMain.map((main, index) => ({
      id: `batch-pair-${index + 1}`,
      date: main.date,
      main,
      smartroom: smartroomAssignments.matches.get(main.id) || null,
      ddio: ddioAssignments.matches.get(main.id) || null,
      status: "ready",
      result: null,
      reviewed: false,
      enabled: true,
    }));
  pairs.unmatched = [
    ...smartroomEntries.filter((entry) => !smartroomAssignments.assignedCandidates.has(entry.id)),
    ...ddioEntries.filter((entry) => !ddioAssignments.assignedCandidates.has(entry.id)),
  ];
  return pairs;
}

export function reassignBatchSource(pairs, entries, pairIndex, role, entryId) {
  if (!Array.isArray(pairs) || !["smartroom", "ddio"].includes(role)) throw new TypeError("Для ручного сопоставления выберите пару и источник SmartRoom или DDIO");
  const pair = pairs[pairIndex];
  if (!pair) throw new RangeError("Пара массового объединения не найдена");
  const candidates = entries?.[role] || [];
  const selected = entryId ? candidates.find((entry) => entry.id === entryId) || null : null;
  if (entryId && !selected) throw new Error(`Файл ${role} не найден в плане сопоставления`);
  if (selected) {
    for (const other of pairs) if (other !== pair && other[role]?.id === selected.id) other[role] = null;
  }
  pair[role] = selected;
  pair.reviewed = false;
  return pair;
}

export function unmatchedBatchEntries(pairs = [], entries = {}) {
  const selectedIds = new Set(pairs.flatMap((pair) => [pair.smartroom?.id, pair.ddio?.id]).filter(Boolean));
  return ["smartroom", "ddio"].flatMap((role) => (entries[role] || []).filter((entry) => !selectedIds.has(entry.id)));
}

export function batchMappingProblems(role, mapping = {}, entry = null) {
  const problems = [];
  if (entry?.error) return [`${entry.file.name}: ${entry.error}`];
  if (role === "main" && entry?.rowCount === 0) problems.push("Main: основной файл не содержит строк устройств");
  if (role === "main" && !STRONG_FIELDS.main.some((field) => Number.isInteger(mapping[field]))) {
    problems.push("Main: выберите внутренний ID, Device ID, Serial, MAC или дополнительный MAC");
  }
  if (role === "smartroom" && !STRONG_FIELDS.smartroom.some((field) => Number.isInteger(mapping[field]))) {
    problems.push("SmartRoom: выберите внутренний ID, Device ID, Serial, основной или дополнительный MAC");
  }
  if (role === "ddio") {
    const reservation = Number.isInteger(mapping.reservationMac) && Number.isInteger(mapping.reservationIp);
    const lease = Number.isInteger(mapping.leaseMac) && Number.isInteger(mapping.leaseIp);
    const generic = Number.isInteger(mapping.mac) && Number.isInteger(mapping.ip);
    const possible = Number.isInteger(mapping.possibleIps) && ["mac", "reservationMac", "leaseMac"].some((field) => Number.isInteger(mapping[field]));
    const byId = Number.isInteger(mapping.deviceId) && ["reservationIp", "leaseIp", "ip", "possibleIps"].some((field) => Number.isInteger(mapping[field]));
    if (!reservation && !lease && !generic && !possible && !byId) problems.push("DDIO: выберите пару MAC/IP, MAC/Possible IPs либо Device ID и IP");
  }
  const selected = Object.values(mapping).filter(Number.isInteger);
  if (new Set(selected).size !== selected.length) problems.push(`${role}: одна колонка выбрана для нескольких полей`);
  return problems;
}

export function batchPairProblems(pair) {
  if (!pair?.main) return ["Не выбран Main-файл"];
  const problems = batchMappingProblems("main", pair.main.mapping, pair.main);
  if (pair.smartroom) problems.push(...batchMappingProblems("smartroom", pair.smartroom.mapping, pair.smartroom));
  if (pair.ddio) problems.push(...batchMappingProblems("ddio", pair.ddio.mapping, pair.ddio));
  return problems;
}

export function batchQueueProblems(pairs = []) {
  const enabled = pairs.filter((pair) => pair.enabled !== false);
  if (!enabled.length) return ["Включите хотя бы один цикл массового объединения"];
  return enabled.flatMap((pair) => {
    const index = pairs.indexOf(pair);
    const problems = batchPairProblems(pair).map((problem) => `Пара №${index + 1}: ${problem}`);
    if (!pair.reviewed) problems.push(`Пара №${index + 1}: подтвердите проверку файлов и mapping`);
    return problems;
  });
}
