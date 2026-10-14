import { buildIdentityIndex, findIdentityMatch, stableIdentity } from "./identity.js";
import { keyText, text } from "./normalize.js";

export const COMPARED_FIELDS = Object.freeze([
  ["ip", "IP устройства"],
  ["switchIp", "IP коммутатора"],
  ["switchPort", "Порт"],
  ["mac", "MAC"],
  ["physicalAddress", "Физический адрес"],
  ["smartroomId", "Smartroom ID"],
  ["room", "Помещение"],
  ["address", "Адрес"],
  ["manufacturer", "Производитель"],
  ["model", "Модель"],
  ["deviceType", "Тип устройства"],
  ["hostname", "Hostname"],
  ["serial", "Серийный номер"],
]);

export function compareFinals(previous = [], current = [], timestamp = new Date().toISOString()) {
  const previousIndex = buildIdentityIndex(previous);
  const matchedPrevious = new Set();
  const added = [];
  const modified = [];
  const unchanged = [];

  for (const after of current) {
    const resolution = findIdentityMatch(after, previousIndex);
    if (resolution.status !== "matched") {
      added.push(after);
      continue;
    }
    const before = resolution.match;
    matchedPrevious.add(before);
    const changes = [];
    for (const [field, label] of COMPARED_FIELDS) {
      const oldValue = text(before[field]);
      const newValue = text(after[field]);
      if (!oldValue || !newValue || keyText(oldValue) === keyText(newValue)) continue;
      changes.push({ field, label, oldValue, newValue, timestamp });
    }
    const row = { identity: stableIdentity(after), before, after, changes };
    if (changes.length) modified.push(row);
    else unchanged.push(row);
  }

  const absent = previous.filter((device) => !matchedPrevious.has(device));
  const critical = modified.filter((row) => row.changes.some((change) => ["switchIp", "ip", "mac", "physicalAddress", "smartroomId"].includes(change.field)));
  return { added, absent, modified, unchanged, critical, timestamp };
}

export function buildMacTimeline(mac, snapshots = []) {
  const normalized = String(mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  const events = [];
  let previous = null;
  for (const snapshot of [...snapshots].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    const device = (snapshot.devices || []).find((item) => [item.mac, ...(item.alternateMacs || [])]
      .some((value) => String(value || "").replace(/[^0-9a-f]/gi, "").toUpperCase() === normalized));
    if (!device) {
      if (previous) events.push({ date: snapshot.createdAt, status: "absent", before: previous, after: null, changes: [] });
      previous = null;
      continue;
    }
    const changes = previous ? COMPARED_FIELDS.filter(([field]) => {
      const before = text(previous[field]);
      const after = text(device[field]);
      return before && after && keyText(before) !== keyText(after);
    }).map(([field, label]) => ({ field, label, oldValue: previous[field], newValue: device[field] })) : [];
    events.push({ date: snapshot.createdAt, status: previous ? (changes.length ? "changed" : "present") : "first", before: previous, after: device, changes });
    previous = device;
  }
  return events;
}

