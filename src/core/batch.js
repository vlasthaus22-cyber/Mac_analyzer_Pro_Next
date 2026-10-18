import { detectMapping, fileObservationDate, readTablePreview } from "../data/importer.js";

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

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair.enabled === false) {
      pair.status = "skipped";
      pair.queueMessage = "Цикл отключён пользователем.";
      await onQueueState(pair, index);
      continue;
    }
    pair.status = "processing";
    pair.result = null;
    pair.errorMessage = "";
    pair.queueMessage = "";
    try {
      await onStart(pair, index);
      pair.result = await executePair(pair, index);
      pair.status = pair.result?.metadata?.reused ? "reused" : "completed";
      completed += 1;
      await onComplete(pair, index);
    } catch (error) {
      pair.status = error?.name === "AbortError" ? "cancelled" : "error";
      pair.errorMessage = await onError(error, pair, index) || (error instanceof Error ? error.message : String(error));
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
      await onQueueState(pair, index);
    }
  }
  return { completed, errors, stopped, failedPairIndex, cancelled };
}

const STRONG_FIELDS = Object.freeze({
  main: ["id", "deviceId", "serial", "mac", "mac2"],
  smartroom: ["id", "deviceId", "serial", "mac", "mac2"],
});

function supported(file) {
  return file && /\.(csv|tsv|txt|json|xlsx|xlsm|xls)$/i.test(file.name || "");
}

function fileId(role, file, index) {
  return [role, index, file.webkitRelativePath || file.name, file.size || 0, file.lastModified || 0].join(":");
}

export async function prepareBatchEntries(files = [], role, onProgress = () => {}) {
  if (!BATCH_ROLES.includes(role)) throw new Error(`Неизвестный источник массового обогащения: ${role}`);
  const accepted = [...files].filter(supported);
  const entries = new Array(accepted.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= accepted.length) return;
      const file = accepted[index];
      onProgress({ role, index, total: accepted.length, file });
      try {
        const preview = await readTablePreview(file);
        entries[index] = {
          id: fileId(role, file, index),
          role,
          file,
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
  await Promise.all(Array.from({ length: Math.min(3, accepted.length) }, () => worker()));
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
    const edges = [];
    for (const main of mains) {
      const mainTime = entryTime(main);
      if (!mainTime) continue;
      for (const candidate of candidates) {
        const candidateTime = entryTime(candidate);
        if (!candidateTime) continue;
        const distance = Math.abs(candidateTime - mainTime);
        const sameDate = new Date(mainTime).toISOString().slice(0, 10) === new Date(candidateTime).toISOString().slice(0, 10);
        if (mode === "same-date" ? sameDate : distance <= toleranceMs) edges.push({ main, candidate, distance });
      }
    }
    edges.sort((left, right) => left.distance - right.distance
      || entryTime(left.main) - entryTime(right.main)
      || left.main.file.name.localeCompare(right.main.file.name, "ru", { numeric: true })
      || left.candidate.file.name.localeCompare(right.candidate.file.name, "ru", { numeric: true }));
    const assignedMains = new Set();
    const assignedCandidates = new Set();
    const matches = new Map();
    for (const edge of edges) {
      if (assignedMains.has(edge.main.id) || assignedCandidates.has(edge.candidate.id)) continue;
      assignedMains.add(edge.main.id);
      assignedCandidates.add(edge.candidate.id);
      matches.set(edge.main.id, edge.candidate);
    }
    return { matches, assignedCandidates };
  };
  const orderedMain = [...mainEntries]
    .sort((left, right) => entryTime(left) - entryTime(right) || left.file.name.localeCompare(right.file.name, "ru", { numeric: true }))
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
    if (!reservation && !lease) problems.push("DDIO: выберите хотя бы одну пару MAC/IP — резервацию или аренду");
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
