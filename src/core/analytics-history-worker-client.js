import { compactComparisonDevice } from "./compact-final-analytics.js";
import { createDashboardDeviceMatcher } from "./dashboard-filter.js";

export async function aggregateSnapshotHistoryInWorker(snapshots, visitSnapshotChunks, options = {}) {
  if (!Array.isArray(snapshots) || typeof visitSnapshotChunks !== "function") throw new Error("Для аналитики Worker нужны снимки и потоковый читатель чанков");
  const source = options.source ?? globalThis.__MAC_ANALYZER_HISTORY_WORKER_SOURCE__;
  const WorkerConstructor = options.WorkerConstructor ?? globalThis.Worker;
  const BlobConstructor = options.BlobConstructor ?? globalThis.Blob;
  const urlApi = options.urlApi ?? globalThis.URL;
  const isCurrent = options.isCurrent || (() => true);
  const matchesFilters = createDashboardDeviceMatcher(options.filters || {});
  if (typeof source !== "string" || !source || typeof WorkerConstructor !== "function"
    || typeof BlobConstructor !== "function" || typeof urlApi?.createObjectURL !== "function") return null;

  let worker;
  let objectUrl;
  let sequence = 0;
  const pending = new Map();
  const rejectPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  try {
    objectUrl = urlApi.createObjectURL(new BlobConstructor([source], { type: "text/javascript" }));
    worker = new WorkerConstructor(objectUrl);
  } catch {
    if (objectUrl) urlApi.revokeObjectURL?.(objectUrl);
    return null;
  }

  worker.onmessage = ({ data = {} }) => {
    const request = pending.get(data.requestId);
    if (!request) return;
    pending.delete(data.requestId);
    if (data.error) request.reject(new Error(String(data.error)));
    else request.resolve(data.value);
  };
  worker.onerror = (event) => rejectPending(new Error(event?.message || "Web Worker аналитики завершился с ошибкой"));
  worker.onmessageerror = () => rejectPending(new Error("Web Worker аналитики вернул нечитаемое сообщение"));

  const request = (action, payload = {}) => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const timeoutMs = Math.max(1_000, Number(options.requestTimeoutMs) || 60_000);
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Web Worker аналитики не ответил на ${action} за ${timeoutMs} мс`));
    }, timeoutMs);
    pending.set(requestId, {
      resolve: (value) => { globalThis.clearTimeout(timeout); resolve(value); },
      reject: (error) => { globalThis.clearTimeout(timeout); reject(error); },
    });
    try {
      worker.postMessage({ requestId, action, ...payload });
    } catch (error) {
      pending.delete(requestId);
      reject(error);
    }
  });

  try {
    if (!isCurrent()) {
      const error = new Error("Аналитика истории устарела");
      error.name = "AbortError";
      throw error;
    }
    const startupTimeout = Math.max(100, Number(options.startupTimeoutMs) || 1500);
    let timeout;
    const initialized = await Promise.race([
      request("start", { filters: options.filters || {} }).then(() => true, () => false),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(false), startupTimeout); }),
    ]);
    globalThis.clearTimeout(timeout);
    if (!initialized) return null;

    const ordered = options.snapshotsAscending ? snapshots : [...snapshots].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    for (let index = 0; index < ordered.length; index += 1) {
      if (!isCurrent()) {
        const error = new Error("Аналитика истории устарела");
        error.name = "AbortError";
        throw error;
      }
      const snapshot = ordered[index];
      options.onProgress?.({ phase: "snapshot-start", snapshot, snapshotIndex: index, snapshotCount: ordered.length });
      await request("beginSnapshot", { snapshot, index });
      let observedChunkCount = 0;
      await visitSnapshotChunks(snapshot.id, async (devices, chunkIndex) => {
        if (!isCurrent()) {
          const error = new Error("Аналитика истории устарела");
          error.name = "AbortError";
          throw error;
        }
        const currentChunkIndex = Number.isInteger(chunkIndex) ? chunkIndex : observedChunkCount;
        observedChunkCount += 1;
        const chunkCount = Math.max(currentChunkIndex + 1, Number(snapshot.chunkCount || 0), observedChunkCount);
        options.onProgress?.({ phase: "worker-start", snapshot, snapshotIndex: index, snapshotCount: ordered.length, chunkIndex: currentChunkIndex, chunkCount, deviceCount: devices.length });
        try {
          const projectedDevices = new Array(devices.length);
          const matchedFilters = new Array(devices.length);
          for (let index = 0; index < devices.length; index += 1) {
            projectedDevices[index] = compactComparisonDevice(devices[index]);
            matchedFilters[index] = matchesFilters(devices[index]);
          }
          await request("ingest", { devices: projectedDevices, matchedFilters, projected: true });
        } catch (error) {
          const contextualError = new Error(`Web Worker истории Final ${index + 1}/${ordered.length} «${snapshot.name || snapshot.id}», чанк ${currentChunkIndex + 1}/${chunkCount}: ${error?.message || error}`, { cause: error });
          options.onProgress?.({ phase: "worker-error", snapshot, snapshotIndex: index, snapshotCount: ordered.length, chunkIndex: currentChunkIndex, chunkCount, error: contextualError.message });
          throw contextualError;
        }
        options.onProgress?.({ phase: "chunk-complete", snapshot, snapshotIndex: index, snapshotCount: ordered.length, chunkIndex: currentChunkIndex, chunkCount, deviceCount: devices.length });
        if (!isCurrent()) {
          const error = new Error("Аналитика истории устарела");
          error.name = "AbortError";
          throw error;
        }
      }, snapshot, index);
      await request("endSnapshot");
      options.onProgress?.({ phase: "snapshot-complete", snapshot, snapshotIndex: index, snapshotCount: ordered.length });
    }
    if (!isCurrent()) {
      const error = new Error("Аналитика истории устарела");
      error.name = "AbortError";
      throw error;
    }
    options.onProgress?.({ phase: "finish-start", snapshotCount: ordered.length });
    const result = await request("finish");
    options.onProgress?.({ phase: "finish-complete", snapshotCount: ordered.length });
    if (!isCurrent()) {
      const error = new Error("Аналитика истории устарела");
      error.name = "AbortError";
      throw error;
    }
    return result;
  } finally {
    rejectPending(new Error("Web Worker аналитики закрыт"));
    worker.terminate?.();
    urlApi.revokeObjectURL?.(objectUrl);
  }
}
