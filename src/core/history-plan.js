import { createFinalHistoryComparisonStream } from "./comparison.js";
import { createPositionedIdentityIndex } from "./identity.js";
import { finalAnalyticsIndexSignature } from "./compact-final-analytics.js";

function compactHistoryPlanEvent(event) {
  if (event?.type === "added" || event?.type === "absent") {
    return { type: event.type, device: { id: event.device?.id, mac: event.device?.mac } };
  }
  if (event?.type === "modified" && event.row?.after && Array.isArray(event.row.changes)) {
    return {
      type: "modified",
      row: {
        after: {
          id: event.row.after.id,
          mac: event.row.after.mac,
          possibleIps: event.row.after.possibleIps,
          possibleIpsTruncated: event.row.after.possibleIpsTruncated,
        },
        changes: event.row.changes,
      },
    };
  }
  throw new Error("Сравнение Final сформировало некорректное событие History");
}

export async function stageFinalHistoryPlan({
  snapshotId = "",
  devices = [],
  deviceCount = Array.isArray(devices) ? devices.length : 0,
  loadDevicePage = null,
  timestamp,
  signal,
  loadPreviousIdentityIndex,
  visitPreviousChunks,
  verifyPreviousSnapshot,
  appendEvents,
  clearEvents,
  queryId = `history-plan:${Date.now()}:${crypto.randomUUID()}`,
}) {
  if ((!Array.isArray(devices) && typeof loadDevicePage !== "function")
    || !Number.isSafeInteger(deviceCount) || deviceCount < 0
    || typeof appendEvents !== "function" || typeof clearEvents !== "function") {
    throw new TypeError("Для подготовки History нужны устройства и операции временного плана");
  }
  if (snapshotId && (typeof loadPreviousIdentityIndex !== "function" || typeof visitPreviousChunks !== "function")) {
    throw new TypeError("Для History с Previous Final нужны пакетный индекс и обход чанков");
  }
  let nextEventOffset = 0;
  let comparator = null;
  let previousIdentityIndex = null;
  let snapshotSignature = "";
  const append = async (events) => {
    if (events.length) {
      await appendEvents(queryId, events.map(compactHistoryPlanEvent), { offset: nextEventOffset });
      nextEventOffset += events.length;
    } else if (nextEventOffset === 0) await appendEvents(queryId, [], { offset: 0 });
  };
  try {
    for (let offset = 0; offset < deviceCount; offset += 500) {
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      const expectedLength = Math.min(500, deviceCount - offset);
      const batch = loadDevicePage
        ? await loadDevicePage(offset, expectedLength)
        : devices.slice(offset, Math.min(deviceCount, offset + 500));
      if (!Array.isArray(batch) || batch.length !== expectedLength) throw new Error("Пакет временного Final неполон");
      const candidates = snapshotId
        ? await loadPreviousIdentityIndex(snapshotId, batch, snapshotSignature)
        : createPositionedIdentityIndex(0);
      if (!candidates?.devices || typeof candidates.forEachCandidate !== "function") {
        throw new Error("Не удалось прочитать индекс Previous Final для History");
      }
      if (!comparator) {
        previousIdentityIndex = createPositionedIdentityIndex(candidates.devices.length);
        comparator = createFinalHistoryComparisonStream(previousIdentityIndex.devices, timestamp, { previousIdentityIndex });
        snapshotSignature = candidates.snapshotSignature || "";
      }
      if (candidates.devices.length !== previousIdentityIndex.devices.length) {
        throw new Error("Предыдущий Final изменился во время подготовки History");
      }
      if (snapshotId && (!snapshotSignature || candidates.snapshotSignature !== snapshotSignature)) {
        throw new Error("Previous Final изменился во время подготовки History");
      }
      candidates.forEachCandidate((device, position) => previousIdentityIndex.addCandidate(position, device));
      const events = [];
      comparator.process(batch, (event) => events.push(event));
      previousIdentityIndex.clearCandidates();
      await append(events);
    }
    if (!comparator) {
      previousIdentityIndex = createPositionedIdentityIndex(0);
      comparator = createFinalHistoryComparisonStream(previousIdentityIndex.devices, timestamp, { previousIdentityIndex });
    }
    let historyComparison = null;
    if (snapshotId) {
      const metadata = await visitPreviousChunks(snapshotId, async (chunk, chunkIndex) => {
        if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
        const events = [];
        historyComparison = comparator.finishChunk(chunk, chunkIndex * 500, (event) => events.push(event)) || historyComparison;
        await append(events);
      });
      if (!metadata || finalAnalyticsIndexSignature(metadata) !== snapshotSignature) {
        throw new Error("Previous Final изменился во время чтения History baseline");
      }
      if (typeof verifyPreviousSnapshot === "function") await verifyPreviousSnapshot(snapshotId, snapshotSignature);
    }
    if (!historyComparison) {
      const events = [];
      historyComparison = comparator.finishChunk([], 0, (event) => events.push(event));
      await append(events);
    }
    previousIdentityIndex.clearCandidates();
    return { queryId, eventCount: nextEventOffset, historyComparison, snapshotSignature };
  } catch (error) {
    previousIdentityIndex?.clearCandidates();
    await clearEvents(queryId).catch(() => {});
    error.batchStage ||= "сверка с предыдущим Final";
    throw error;
  }
}
