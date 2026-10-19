import { buildIdentityIndex, conflictingStrongFields, findIdentityMatch } from "./identity.js";
import { text } from "./normalize.js";

const BACKFILL_FIELDS = Object.freeze([
  "mac", "macFormatted", "alternateMacs", "ip", "switchIp", "switchPort",
  "manufacturer", "vendor", "model", "deviceType", "hostname", "serial", "deviceId", "id", "deviceName",
  "smartroomId", "businessUnit", "city", "site", "floor", "room", "address", "physicalAddress",
  "authenticationTime", "observedAt", "possibleIps",
]);
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "string" && !text(value);
}

/** Restore missing fields in a comparison copy, scanning prior Final chunks newest-first. */
export async function backfillComparisonDevices(devices = [], historySnapshots = [], visitSnapshotChunks, { inPlace = false, resolveSnapshotIdentityIndex = null } = {}) {
  if (typeof visitSnapshotChunks !== "function") throw new Error("Требуется потоковое чтение исторических Final");
  if (resolveSnapshotIdentityIndex !== null && typeof resolveSnapshotIdentityIndex !== "function") throw new TypeError("Для исторического backfill нужен обработчик identity index");
  const result = inPlace ? devices : devices.map((device) => ({ ...device }));
  const needed = result.map((device) => new Set(BACKFILL_FIELDS.filter((field) => isBlank(device[field]))));
  const blocked = new Set();
  const diagnostics = [];
  let restoredFieldCount = 0;
  const ordered = [...historySnapshots].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id)));

  for (const snapshot of ordered) {
    const pending = result.map((_, index) => index).filter((index) => needed[index].size && !blocked.has(index));
    if (!pending.length) break;
    const candidates = new Map(pending.map((index) => [index, { count: 0, candidate: null, conflict: false }]));
    const recordMatch = (index, match) => {
      const found = candidates.get(index);
      if (match.status === "ambiguous") {
        found.conflict = true;
        found.candidate = match.candidates.map((item) => item.device);
        return;
      }
      if (match.status !== "matched") return;
      if (match.identityConflicts?.length) {
        found.conflict = true;
        found.candidate = [match.match, ...match.identityConflicts.map((conflict) => conflict.alternative).filter(Boolean)];
        found.fields = ["identity"];
        return;
      }
      const strongConflicts = conflictingStrongFields(result[index], match.match);
      if (strongConflicts.length) {
        found.conflict = true;
        found.candidate = [match.match];
        found.fields = strongConflicts;
        return;
      }
      found.count += 1;
      found.candidate = match.match;
      if (found.count > 1) found.conflict = true;
    };
    if (resolveSnapshotIdentityIndex) {
      const identityIndex = await resolveSnapshotIdentityIndex(snapshot, pending.map((index) => result[index]));
      if (!identityIndex) throw new Error(`Не удалось построить identity index исторического Final ${snapshot.id}`);
      for (const index of pending) recordMatch(index, findIdentityMatch(result[index], identityIndex));
    } else {
      await visitSnapshotChunks(snapshot.id, (chunk) => {
        if (!chunk.length) return;
        const identityIndex = buildIdentityIndex(chunk);
        for (const index of pending) recordMatch(index, findIdentityMatch(result[index], identityIndex));
      }, snapshot);
    }

    for (const index of pending) {
      const found = candidates.get(index);
      if (found.conflict || found.count > 1) {
        blocked.add(index);
        diagnostics.push({ device: result[index], snapshotId: snapshot.id, snapshotName: snapshot.name || "Final", candidates: Array.isArray(found.candidate) ? found.candidate : found.candidate ? [found.candidate] : [], conflictingFields: found.fields || [] });
        continue;
      }
      if (found.count !== 1 || !found.candidate) continue;
      for (const field of [...needed[index]]) {
        const value = found.candidate[field];
        if (isBlank(value)) continue;
        result[index][field] = Array.isArray(value) ? [...value] : value;
        if (found.candidate.fieldSources?.[field]) {
          result[index].fieldSources = { ...(result[index].fieldSources || {}), [field]: found.candidate.fieldSources[field] };
        }
        result[index].historicalEvidence = {
          ...(result[index].historicalEvidence || {}),
          [field]: { snapshotId: snapshot.id, snapshotName: snapshot.name || "Final", observedAt: snapshot.createdAt || "" },
        };
        needed[index].delete(field);
        restoredFieldCount += 1;
      }
    }
  }
  return { devices: result, diagnostics, restoredFieldCount };
}
