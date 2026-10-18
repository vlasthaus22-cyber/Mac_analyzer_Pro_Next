import { createWeeklyComparisonAccumulator, createPresenceChurnTracker } from "./analytics.js";
import { createFinalComparisonSummary } from "./comparison.js";
import { compactComparisonDevice } from "./compact-final-analytics.js";
import { dashboardDeviceMatchesFilters } from "./dashboard-filter.js";

export function createAnalyticsHistoryWorkerRuntime(scope) {
  let session = null;

  function requireSession() {
    if (!session) throw new Error("Сессия аналитики истории не запущена");
    return session;
  }

  function begin(filters = {}) {
    if (session) throw new Error("Предыдущая сессия аналитики истории не завершена");
    session = {
      weekly: createWeeklyComparisonAccumulator(),
      churn: createPresenceChurnTracker(),
      snapshots: [],
      snapshotChanges: [],
      previousDevices: [],
      pending: null,
      uniqueMacs: 0,
      filters,
    };
  }

  function beginSnapshot(snapshot, index) {
    const current = requireSession();
    if (current.pending) throw new Error("Предыдущий Final ещё обрабатывается");
    current.pending = {
      snapshot,
      index,
      devices: [],
      comparison: index > 0 ? createFinalComparisonSummary(current.previousDevices, snapshot.createdAt, { deviceMatches: (device) => dashboardDeviceMatchesFilters(device, current.filters) }) : null,
      filteredDeviceCount: 0,
    };
    current.churn.beginSnapshot(snapshot);
  }

  function ingest(devices) {
    const current = requireSession();
    if (!current.pending) throw new Error("Перед блоком устройств не начат Final");
    if (!Array.isArray(devices)) throw new Error("Блок устройств должен быть массивом");
    const pending = current.pending;
    for (const device of devices) {
      pending.devices.push(compactComparisonDevice(device));
      if (!dashboardDeviceMatchesFilters(device, current.filters)) continue;
      pending.filteredDeviceCount += 1;
      current.churn.observeDevice(device);
    }
    pending.comparison?.observeChunk(devices);
  }

  function endSnapshot() {
    const current = requireSession();
    const pending = current.pending;
    if (!pending) throw new Error("Нет обрабатываемого Final");
    const { snapshot, index, devices, comparison } = pending;
    current.churn.endSnapshot();
    if (comparison) {
      const summary = comparison.finish();
      current.weekly.observeSummary(snapshot, summary);
      current.snapshotChanges.push({ label: snapshot.name || snapshot.createdAt, added: summary.added, absent: summary.absent });
    }
    current.snapshots.push({
      label: snapshot.name || snapshot.createdAt,
      value: pending.filteredDeviceCount,
    });
    current.previousDevices = devices;
    current.uniqueMacs = current.churn.uniqueCount();
    current.pending = null;
    return { index, deviceCount: devices.length };
  }

  function finish() {
    const current = requireSession();
    if (current.pending) throw new Error("Нельзя завершить аналитику до сохранения текущего Final");
    const result = {
      weekly: current.weekly.result(),
      snapshotChanges: current.snapshotChanges,
      totals: current.snapshots,
      churn: current.churn.result(),
      history: {
        snapshots: current.snapshots.length,
        deviceTotal: current.snapshots.reduce((sum, snapshot) => sum + Math.max(0, Number(snapshot.value) || 0), 0),
        uniqueMacs: current.uniqueMacs,
      },
    };
    session = null;
    return result;
  }

  function dispatch(action, data = {}) {
    if (action === "start") return begin(data.filters || {});
    if (action === "beginSnapshot") return beginSnapshot(data.snapshot, data.index);
    if (action === "ingest") return ingest(data.devices);
    if (action === "endSnapshot") return endSnapshot();
    if (action === "finish") return finish();
    throw new Error(`Неизвестная команда worker: ${action}`);
  }

  scope.onmessage = ({ data = {} }) => {
    const { requestId, action, ...payload } = data;
    try {
      scope.postMessage({ requestId, value: dispatch(action, payload) });
    } catch (error) {
      scope.postMessage({ requestId, error: error?.message || String(error) });
    }
  };
  return Object.freeze({ dispatch });
}

export function installAnalyticsHistoryWorker(scope = globalThis) {
  return createAnalyticsHistoryWorkerRuntime(scope);
}
