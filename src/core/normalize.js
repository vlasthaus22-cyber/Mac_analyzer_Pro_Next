const EMPTY_VALUES = new Set([
  "",
  "-",
  "—",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "unknown",
  "неизвестно",
  "не заполнено",
  "нет данных",
]);

export function text(value) {
  if (value === null || value === undefined) return "";
  const normalized = String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return EMPTY_VALUES.has(normalized.toLocaleLowerCase("ru-RU")) ? "" : normalized;
}

export function keyText(value) {
  return text(value).normalize("NFKC").toLocaleLowerCase("ru-RU");
}

export function normalizeMac(value) {
  const source = text(value);
  if (!source) return "";
  const canonical = source.match(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i)?.[0]
    || source.match(/[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}/i)?.[0]
    || source.match(/[0-9a-f]{12}/i)?.[0];
  if (!canonical) return "";
  const hex = canonical.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 12 || /^0{12}$/.test(hex) || /^F{12}$/.test(hex)) return "";
  return hex.match(/.{2}/g).join(":");
}

export function macHex(value) {
  return normalizeMac(value).replaceAll(":", "");
}

export function normalizeIp(value) {
  const source = text(value).replace(/^\[|\]$/g, "");
  if (!source) return "";
  // A six-group MAC such as 00:11:22:33:44:55 is syntactically similar to a
  // shortened IPv6 address, but must never be accepted as an IP value.
  if (normalizeMac(source)) return "";
  const ipv4 = source.match(/(?:^|\s)((?:\d{1,3}\.){3}\d{1,3})(?:\s|$)/)?.[1];
  if (ipv4) {
    const parts = ipv4.split(".").map(Number);
    if (parts.every((part) => part >= 0 && part <= 255)) return parts.join(".");
  }
  if (/^[0-9a-f:]+$/i.test(source) && source.includes(":")) {
    const groups = source.split(":");
    if (groups.length >= 3 && groups.length <= 8 && groups.every((group) => !group || /^[0-9a-f]{1,4}$/i.test(group))) {
      return source.toLocaleLowerCase("en-US");
    }
  }
  return "";
}

export function normalizeDate(value) {
  if (!text(value)) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const result = new Date(excelEpoch + value * 86_400_000);
    return Number.isNaN(result.getTime()) ? "" : result.toISOString();
  }
  const match = text(value).match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const [, day, month, year, hour = "0", minute = "0", second = "0"] = match;
    const result = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
    return Number.isNaN(result.getTime()) ? "" : result.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export function unique(values, normalizer = text) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = normalizer(value);
    const key = keyText(normalized);
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

export function firstKnown(...values) {
  return values.map(text).find(Boolean) || "";
}

export function normalizeRoom(device = {}) {
  return {
    smartroomId: text(device.smartroomId),
    businessUnit: text(device.businessUnit),
    city: text(device.city),
    site: text(device.site),
    floor: text(device.floor),
    room: text(device.room),
    address: text(device.address),
  };
}

export function locationKey(device = {}) {
  const room = normalizeRoom(device);
  if (room.smartroomId) return `sr:${keyText(room.smartroomId)}`;
  if (!room.room) return "";
  return `location:${[
    room.businessUnit,
    room.city,
    room.site,
    room.floor,
    room.room,
    room.address,
  ].map(keyText).join("|")}`;
}

export function normalizeDevice(input = {}, source = "") {
  const mac = normalizeMac(input.mac || input.macAddress || input.CallingStationID);
  const alternateMacs = unique([
    ...(Array.isArray(input.alternateMacs) ? input.alternateMacs : []),
    input.mac2,
    input.secondaryMac,
  ], normalizeMac).filter((item) => item !== mac);
  return {
    id: text(input.id),
    mac,
    alternateMacs,
    ip: normalizeIp(input.ip || input.deviceIp),
    switchIp: normalizeIp(input.switchIp || input.ipSwitch || input.nasIp),
    switchPort: text(input.switchPort || input.port || input.nasPortId),
    smartroomId: text(input.smartroomId),
    businessUnit: text(input.businessUnit),
    city: text(input.city),
    site: text(input.site),
    floor: text(input.floor),
    room: text(input.room),
    address: text(input.address),
    physicalAddress: text(input.physicalAddress),
    manufacturer: text(input.manufacturer || input.vendor),
    model: text(input.model),
    deviceType: text(input.deviceType || input.type),
    hostname: text(input.hostname || input.host),
    serial: text(input.serial || input.serialNumber),
    deviceId: text(input.deviceId),
    deviceName: text(input.deviceName || input.name),
    authenticationTime: normalizeDate(input.authenticationTime || input.receiptTime),
    possibleIps: unique(input.possibleIps || [], normalizeIp),
    sources: unique([...(input.sources || []), source || input.source]),
    fieldSources: { ...(input.fieldSources || {}) },
    conflicts: Array.isArray(input.conflicts) ? [...input.conflicts] : [],
  };
}

export function hasStrongIdentity(device = {}) {
  return Boolean(text(device.deviceId) || text(device.serial) || normalizeMac(device.mac));
}

