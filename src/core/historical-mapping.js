import { keyText, normalizeIp, normalizeMac, text } from "./normalize.js";
import { conflictingStrongFields } from "./identity.js";

const MIN_SNAPSHOTS = 2;
const MIN_DEVICES = 3;
const MIN_CONSENSUS = 0.9;
const MIN_CONFIDENCE = 0.8;

export function summarizeHistoricalAddressDevices(devices = []) {
  const candidateIps = new Set();
  const appliedIps = new Set();
  for (const device of devices) {
    const switchIp = device?.switchIp;
    const appliedFromHistory = device?.fieldSources?.address === "Historical switch IP mapping";
    if (switchIp && (!text(device.address) || appliedFromHistory)) candidateIps.add(switchIp);
    if (appliedFromHistory && switchIp) appliedIps.add(switchIp);
  }
  return { candidateIps, appliedCount: appliedIps.size };
}

export function summarizeAppliedSmartroomMappings(devices = []) {
  const historicalIds = new Set();
  const importedIds = new Set();
  for (const device of devices) {
    const source = device?.fieldSources?.room;
    const smartroomId = keyText(device.smartroomId);
    if (!smartroomId) continue;
    if (source === "Historical Smartroom ID mapping") historicalIds.add(smartroomId);
    else if (source === "Imported SQLite Smartroom room mapping") importedIds.add(smartroomId);
  }
  return { historicalCount: historicalIds.size, importedCount: importedIds.size };
}

export function mappingIndexPage(index, { offset = 0, limit = 100 } = {}) {
  const pageLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const total = Number(index?.size) || 0;
  const actualOffset = total > 0
    ? Math.min(safeOffset, Math.floor((total - 1) / pageLimit) * pageLimit)
    : 0;
  const rows = [];
  let skipped = 0;
  let reviewCount = 0;
  for (const value of index?.values?.() || []) {
    if (value?.status !== "confirmed") reviewCount += 1;
    if (skipped < actualOffset) {
      skipped += 1;
      continue;
    }
    if (rows.length < pageLimit) rows.push(value);
  }
  return {
    rows,
    total,
    reviewCount,
    offset: actualOffset,
    limit: pageLimit,
    hasPrevious: actualOffset > 0,
    hasNext: actualOffset + rows.length < total,
  };
}

export function createHistoricalAddressAccumulator() {
  const byIp = new Map();
  return {
    add(record) {
      if (!record) return;
      const switchIp = normalizeIp(record.switchIp);
      const address = text(record.address);
      if (!switchIp || !address || !record.snapshotId) return;
      if (!byIp.has(switchIp)) byIp.set(switchIp, new Map());
      const addresses = byIp.get(switchIp);
      if (!addresses.has(address)) addresses.set(address, new Map());
      addresses.get(address).set(record.snapshotId, record);
    },
    finish() {
      const result = new Map();
      for (const [switchIp, addresses] of byIp) {
        const candidates = [...addresses.entries()].map(([address, snapshots]) => {
      const recordsForAddress = [...snapshots.values()];
      const deviceCount = recordsForAddress.reduce((sum, item) => sum + Number(item.deviceCount || 0), 0);
      return {
        address,
        snapshotCount: snapshots.size,
        deviceCount,
        observations: recordsForAddress.map((item) => ({
          snapshotId: item.snapshotId,
          snapshotName: item.snapshotName || item.snapshotId,
          createdAt: item.createdAt || "",
          deviceCount: Number(item.deviceCount || 0),
          sampleMacs: item.sampleMacs || [],
        })),
      };
        }).sort((left, right) => right.snapshotCount - left.snapshotCount
          || right.deviceCount - left.deviceCount
          || left.address.localeCompare(right.address, "ru", { numeric: true }));
        const winner = candidates[0];
        const totalObservations = candidates.reduce((sum, item) => sum + item.deviceCount, 0);
        const agreement = totalObservations ? winner.deviceCount / totalObservations : 0;
        const confidence = Math.min(1,
          agreement * 0.65
          + Math.min(winner.snapshotCount / 3, 1) * 0.2
          + Math.min(winner.deviceCount / 5, 1) * 0.15);
        const confirmed = winner.snapshotCount >= MIN_SNAPSHOTS
          && winner.deviceCount >= MIN_DEVICES
          && agreement >= MIN_CONSENSUS
          && confidence >= MIN_CONFIDENCE;
        result.set(switchIp, {
          switchIp,
          status: confirmed ? "confirmed" : "review",
          address: confirmed ? winner.address : "",
          confidence,
          evidence: winner.observations,
          alternatives: candidates.slice(1).map(({ address, snapshotCount, deviceCount }) => ({ address, snapshotCount, deviceCount })),
        });
      }
      return result;
    },
  };
}

export function buildHistoricalAddressIndex(records = []) {
  const accumulator = createHistoricalAddressAccumulator();
  for (const record of records) accumulator.add(record);
  return accumulator.finish();
}

export function applyHistoricalAddress(device, index) {
  const switchIp = normalizeIp(device.switchIp);
  const suggestion = switchIp ? index.get(switchIp) : null;
  if (!suggestion || suggestion.status !== "confirmed" || text(device.address)) return null;
  device.address = suggestion.address;
  device.fieldSources ||= {};
  device.fieldSources.address = "Historical switch IP mapping";
  device.addressConfidence = suggestion.confidence;
  device.addressEvidence = suggestion.evidence;
  return suggestion;
}

export function buildSmartroomRoomIndex(records = []) {
  const result = new Map();
  for (const record of records) {
    const smartroomId = keyText(record.smartroomId);
    if (!smartroomId) continue;
    result.set(smartroomId, {
      smartroomId: text(record.smartroomId),
      room: text(record.room),
      status: record.status === "confirmed" && text(record.room) ? "confirmed" : "review",
      sourceFinalId: record.sourceFinalId || "",
      snapshotName: record.snapshotName || "",
      createdAt: record.createdAt || "",
      deviceCount: Number(record.deviceCount || 0),
      alternatives: Array.isArray(record.alternatives) ? record.alternatives : [],
      sampleMacs: Array.isArray(record.sampleMacs) ? record.sampleMacs : [],
    });
  }
  return result;
}

export function buildImportedSmartroomRoomIndex(records = []) {
  const candidates = new Map();
  for (const record of records) {
    const smartroomId = text(record?.smartroomId);
    const idKey = keyText(smartroomId);
    const room = text(record?.room);
    if (!idKey || !room) continue;
    if (!candidates.has(idKey)) candidates.set(idKey, { smartroomId, rooms: new Set(), source: text(record.source), updatedAt: text(record.updatedAt) });
    const candidate = candidates.get(idKey);
    candidate.rooms.add(room);
    if (record.updatedAt > candidate.updatedAt) {
      candidate.source = text(record.source);
      candidate.updatedAt = text(record.updatedAt);
    }
  }
  return new Map([...candidates].map(([key, value]) => [key, {
    smartroomId: value.smartroomId,
    room: value.rooms.size === 1 ? [...value.rooms][0] : "",
    status: value.rooms.size === 1 ? "confirmed" : "review",
    alternatives: [...value.rooms].sort((left, right) => left.localeCompare(right, "ru")).map((room) => ({ room })),
    source: value.source,
    updatedAt: value.updatedAt,
  }]));
}

export function applyImportedSmartroomRoom(device, index) {
  const smartroomId = text(device.smartroomId);
  const mapping = smartroomId ? index.get(keyText(smartroomId)) : null;
  if (!mapping || mapping.status !== "confirmed" || !mapping.room || text(device.room)) return null;
  device.room = mapping.room;
  device.fieldSources ||= {};
  device.fieldSources.room = "Imported SQLite Smartroom room mapping";
  device.roomConfidence = 1;
  device.roomEvidence = {
    smartroomId: mapping.smartroomId,
    source: mapping.source || "SQLite smartroom_room_mappings",
    updatedAt: mapping.updatedAt || "",
    mappingType: "explicit-imported-mapping",
  };
  return mapping;
}

function addCurrentSmartroomRoomDevice(roomsById, device) {
  const smartroomId = text(device.smartroomId);
  const idKey = keyText(smartroomId);
  const room = text(device.room);
  if (!idKey || !room) return;
  if (!roomsById.has(idKey)) roomsById.set(idKey, { smartroomId, rooms: new Set(), deviceCount: 0, sampleMacs: [] });
  const evidence = roomsById.get(idKey);
  evidence.rooms.add(room);
  evidence.deviceCount += 1;
  const mac = normalizeMac(device.mac);
  if (mac && evidence.sampleMacs.length < 5 && !evidence.sampleMacs.includes(mac)) evidence.sampleMacs.push(mac);
}

function currentSmartroomRoomEntry(evidence) {
  return {
    smartroomId: evidence.smartroomId,
    room: evidence.rooms.size === 1 ? [...evidence.rooms][0] : "",
    status: evidence.rooms.size === 1 ? "confirmed" : "review",
    deviceCount: evidence.deviceCount,
    sampleMacs: evidence.sampleMacs,
    alternatives: [...evidence.rooms].filter(Boolean).sort((left, right) => left.localeCompare(right, "ru")).map((room) => ({ room })),
  };
}

function finishCurrentSmartroomRoomIndex(roomsById) {
  const index = new Map();
  for (const [idKey, evidence] of roomsById) index.set(idKey, currentSmartroomRoomEntry(evidence));
  return index;
}

export function buildCurrentSmartroomRoomIndex(devices = []) {
  const roomsById = new Map();
  for (const device of devices) {
    addCurrentSmartroomRoomDevice(roomsById, device);
  }
  return finishCurrentSmartroomRoomIndex(roomsById);
}

export async function buildCurrentSmartroomRoomIndexAsync(devices = [], { signal } = {}) {
  const roomsById = new Map();
  const batchSize = 500;
  const abort = () => {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  };
  abort();
  for (let index = 0; index < devices.length; index += 1) {
    if (index % batchSize === 0) abort();
    addCurrentSmartroomRoomDevice(roomsById, devices[index]);
    if ((index + 1) % batchSize === 0) {
      if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
      else if (typeof globalThis.setImmediate === "function") await new Promise((resolve) => globalThis.setImmediate(resolve));
      else await new Promise((resolve) => setTimeout(resolve, 0));
      abort();
    }
  }
  abort();
  const result = new Map();
  let position = 0;
  for (const [idKey, evidence] of roomsById) {
    abort();
    result.set(idKey, currentSmartroomRoomEntry(evidence));
    position += 1;
    if (position % batchSize === 0) {
      if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
      else if (typeof globalThis.setImmediate === "function") await new Promise((resolve) => globalThis.setImmediate(resolve));
      else await new Promise((resolve) => setTimeout(resolve, 0));
      abort();
    }
  }
  abort();
  return result;
}

export function applySmartroomRoom(device, index, source = "Historical Smartroom ID mapping") {
  const smartroomId = text(device.smartroomId);
  const suggestion = smartroomId ? index.get(keyText(smartroomId)) : null;
  if (!suggestion || suggestion.status !== "confirmed" || !suggestion.room || text(device.room)) return null;
  device.room = suggestion.room;
  device.fieldSources ||= {};
  device.fieldSources.room = source;
  device.roomConfidence = source === "Current Smartroom ID mapping" ? 1 : 0.9;
  device.roomEvidence = {
    smartroomId: suggestion.smartroomId,
    sourceFinalId: suggestion.sourceFinalId || "",
    snapshotName: suggestion.snapshotName || "",
    createdAt: suggestion.createdAt || "",
    deviceCount: suggestion.deviceCount || 0,
    sampleMacs: suggestion.sampleMacs || [],
  };
  return suggestion;
}

export function compareSwitchIpHistory(devices = [], inventoryById = new Map()) {
  const changes = [];
  for (const device of devices) {
    const candidates = device?.id ? inventoryById.get(String(device.id)) : null;
    let record = null;
    if (candidates?.exactId && candidates.records?.length === 1) record = candidates.records[0];
    else if (candidates?.records?.length === 1) {
      const candidate = candidates.records[0];
      const currentDeviceId = keyText(device.deviceId);
      const previousDeviceId = keyText(candidate.deviceId);
      const currentSerial = keyText(device.serial);
      const previousSerial = keyText(candidate.serial);
      const deviceMacs = new Set([device.mac, ...(Array.isArray(device.alternateMacs) ? device.alternateMacs : [])].map(normalizeMac).filter(Boolean));
      const candidateMacs = [candidate.mac, ...(Array.isArray(candidate.alternateMacs) ? candidate.alternateMacs : [])].map(normalizeMac).filter(Boolean);
      const matchingMac = candidateMacs.some((mac) => deviceMacs.has(mac));
      const deviceIdConflict = currentDeviceId && previousDeviceId && currentDeviceId !== previousDeviceId;
      const serialConflict = currentSerial && previousSerial && currentSerial !== previousSerial;
      if (!deviceIdConflict && ((currentDeviceId && currentDeviceId === previousDeviceId)
        || (!serialConflict && ((currentSerial && currentSerial === previousSerial) || matchingMac)))) record = candidate;
    }
    const previousIp = normalizeIp(record?.switchIp);
    const currentIp = normalizeIp(device?.switchIp);
    if (!previousIp || !currentIp || previousIp === currentIp) continue;
    const possibleIps = [...new Set((Array.isArray(device.possibleIps) ? device.possibleIps : []).map(normalizeIp).filter(Boolean))];
    changes.push({
      id: String(device.id),
      mac: normalizeMac(device.mac) || "",
      previousIp,
      currentIp,
      deviceIp: normalizeIp(device.ip),
      possibleIps,
      identityConflicts: record ? conflictingStrongFields(device, record) : [],
      lastSeen: String(record.lastSeen || ""),
      previousSnapshotId: String(record.snapshotId || ""),
    });
  }
  return changes;
}

export async function compareSwitchIpHistoryInBatches(devices = [], loadInventoryCandidates, { batchSize = 250, onChangesBatch = null, signal = null } = {}) {
  if (typeof loadInventoryCandidates !== "function") throw new TypeError("Нужен загрузчик кандидатов Inventory");
  if (onChangesBatch !== null && typeof onChangesBatch !== "function") throw new TypeError("Обработчик пакетных изменений должен быть функцией");
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new DOMException("Сверка IP коммутаторов отменена", "AbortError");
  };
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(batchSize) || 250)));
  const changes = [];
  let total = 0;
  for (let offset = 0; offset < devices.length; offset += pageSize) {
    throwIfAborted();
    const page = devices.slice(offset, offset + pageSize);
    const candidates = await loadInventoryCandidates(page);
    throwIfAborted();
    const batchChanges = compareSwitchIpHistory(page, candidates);
    total += batchChanges.length;
    if (onChangesBatch) await onChangesBatch(batchChanges, { offset, total });
    else changes.push(...batchChanges);
    throwIfAborted();
  }
  return onChangesBatch ? { total } : changes;
}

export function selectSwitchIpHistoryPage(changes = [], { offset = 0, limit = 100 } = {}) {
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const total = changes.length;
  const lastOffset = Math.max(0, Math.floor((Math.max(total, 1) - 1) / pageSize) * pageSize);
  const currentOffset = Math.max(0, Math.min(lastOffset, Math.floor(Number(offset) || 0) - (Math.floor(Number(offset) || 0) % pageSize)));
  const rows = changes.slice(currentOffset, currentOffset + pageSize);
  return {
    rows,
    total,
    offset: currentOffset,
    limit: pageSize,
    hasPrevious: currentOffset > 0,
    hasNext: currentOffset + rows.length < total,
  };
}
