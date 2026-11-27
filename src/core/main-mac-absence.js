import { normalizeMac } from "./normalize.js";

export const MAIN_MAC_ABSENCE_WINDOW = 5;

const DEVICE_FIELDS = [
  "id", "manufacturer", "vendor", "model", "deviceType", "deviceName", "hostname",
  "serial", "deviceId", "smartroomId", "address", "physicalAddress", "room",
  "businessUnit", "city", "site", "floor", "ip", "switchIp", "switchPort", "authenticationTime",
];

export async function mainMacAbsenceReport(snapshots, visitSnapshotChunks, { isCurrent = () => true, onProgress = () => {} } = {}) {
  const windowSize = MAIN_MAC_ABSENCE_WINDOW;
  if (snapshots.length <= windowSize) return { rows: [], available: snapshots.length, unknown: [] };
  const recent = new Set();
  const missing = new Map();
  const unknown = [];
  let countedSnapshots = 0;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    if (!isCurrent()) return null;
    const snapshot = snapshots[index];
    const recentSnapshot = snapshots.length - index <= windowSize;
    const seen = new Set();
    let hasProvenance = snapshot.mainUniqueMacs != null;
    await visitSnapshotChunks(snapshot.id, (chunk) => {
      if (!isCurrent()) return false;
      for (const device of chunk) {
        const inMain = device.source === "Main" || device.sources?.includes("Main");
        if (!inMain && !device.mainMacs?.length) continue;
        hasProvenance = true;
        for (const value of device.mainMacs || [device.mac]) {
          const mac = normalizeMac(value);
          if (!mac || seen.has(mac)) continue;
          seen.add(mac);
          if (recentSnapshot) {
            recent.add(mac);
          } else if (!recent.has(mac)) {
            const existing = missing.get(mac);
            if (existing) existing.appearances += 1;
            else {
              const details = {};
              for (const field of DEVICE_FIELDS) if (device[field] !== undefined) details[field] = device[field];
              missing.set(mac, {
                ...details, mac, snapshotId: snapshot.id, snapshotName: snapshot.name,
                lastSeen: snapshot.createdAt, missingSnapshots: snapshots.length - index - 1,
                appearances: 1,
              });
            }
          }
        }
      }
    });
    if (!isCurrent()) return null;
    countedSnapshots += 1;
    onProgress(countedSnapshots, snapshots.length);
    const count = Number(snapshot.mainUniqueMacs);
    const expectedCount = snapshot.mainUniqueMacs != null && Number.isSafeInteger(count) ? count : null;
    if (!hasProvenance || (expectedCount !== null && expectedCount !== seen.size)) {
      unknown.push({ id: snapshot.id, name: snapshot.name, recent: recentSnapshot });
    }
  }
  const rows = unknown.some(({ recent }) => recent) ? [] : [...missing.values()]
    .sort((a, b) => b.missingSnapshots - a.missingSnapshots || a.mac.localeCompare(b.mac));
  return { rows, available: snapshots.length, unknown };
}
