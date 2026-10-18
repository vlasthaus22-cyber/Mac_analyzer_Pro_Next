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
  "unknown vendor",
  "unknown model",
  "not found",
  "not available",
  "неизвестно",
  "неизвестен",
  "не определено",
  "не найдено",
  "неизвестный вендор",
  "неизвестная модель",
  "не указана",
  "не указано",
  "не задано",
  "не заполнено",
  "нет данных",
]);
export const MAX_DEVICE_ALTERNATIVES = 100;
export const MAX_DEVICE_CONFLICTS = 100;

export function text(value) {
  if (value === null || value === undefined) return "";
  const normalized = String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return EMPTY_VALUES.has(normalized.toLocaleLowerCase("ru-RU")) ? "" : normalized;
}

function identityText(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  return text(value);
}

export function keyText(value) {
  return text(value).normalize("NFKC").toLocaleLowerCase("ru-RU");
}

export function normalizeMac(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  if (typeof value === "number" && !Number.isFinite(value)) return "";
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
  const source = identityText(value).replace(/^\[|\]$/g, "");
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
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  const normalized = identityText(value);
  if (!normalized) return "";
  const excelSerial = typeof value === "number"
    ? value
    : /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (Number.isFinite(excelSerial) && excelSerial >= 1 && excelSerial <= 2_958_465) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const result = new Date(excelEpoch + excelSerial * 86_400_000);
    return Number.isNaN(result.getTime()) ? "" : result.toISOString();
  }
  const match = normalized.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const [, day, month, year, hour = "0", minute = "0", second = "0"] = match;
    const result = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
    return Number.isNaN(result.getTime()) ? "" : result.toISOString();
  }
  const parsed = new Date(normalized);
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

export function uniqueLimited(values, normalizer = text, limit = MAX_DEVICE_ALTERNATIVES) {
  const result = [];
  const seen = new Set();
  let truncated = false;
  for (const value of values || []) {
    const normalized = normalizer(value);
    const key = keyText(normalized);
    if (!normalized || seen.has(key)) continue;
    if (result.length >= limit) { truncated = true; break; }
    seen.add(key);
    result.push(normalized);
  }
  return { values: result, truncated };
}

export function firstKnown(...values) {
  for (const value of values) {
    const normalized = identityText(value);
    if (normalized) return normalized;
  }
  return "";
}

export function normalizeRoom(device = {}) {
  return {
    smartroomId: identityText(device.smartroomId),
    businessUnit: identityText(device.businessUnit),
    city: identityText(device.city),
    site: identityText(device.site),
    floor: identityText(device.floor),
    room: identityText(device.room),
    address: identityText(device.address),
  };
}

export function locationKey(device = {}) {
  const room = normalizeRoom(device);
  if (room.smartroomId) return `sr:${keyText(room.smartroomId)}`;
  if (!room.room) return "";
  const hierarchy = [room.businessUnit, room.city, room.site, room.floor].map(keyText);
  const locationContext = hierarchy.some(Boolean) ? hierarchy : [keyText(room.address)];
  return `location:${[
    ...locationContext,
    room.room,
  ].map(keyText).join("|")}`;
}

function parseLocationPath(value) {
  const parts = String(value ?? "").split(",").map(text);
  if (parts.length < 5) return null;
  return {
    businessUnit: parts[0],
    city: parts[1],
    site: parts[2],
    floor: parts[3],
    room: parts[4],
    address: parts.slice(5).join(", "),
  };
}

function locationInference(input) {
  for (const [field, value] of [["locationPath", input.locationPath], ["location", input.location], ["room", input.room], ["address", input.address]]) {
    if (!identityText(value)) continue;
    const parsed = parseLocationPath(value);
    if (parsed) return { ...parsed, sourceField: field };
  }
  return null;
}

export function normalizeDevice(input = {}, source = "") {
  const inferredLocation = locationInference(input);
  const inputRoomIsPath = Boolean(inferredLocation && inferredLocation.sourceField === "room");
  const inputAddressIsPath = Boolean(inferredLocation && inferredLocation.sourceField === "address");
  const mac = [input.mac, input.macAddress, input.macFormatted, input.mac_formatted, input.CallingStationID].map(normalizeMac).find(Boolean) || "";
  function* alternateMacCandidates() {
    for (const value of Array.isArray(input.alternateMacs) ? input.alternateMacs : []) if (normalizeMac(value) !== mac) yield value;
    for (const value of [input.mac2, input.secondaryMac, input.secondary_mac, input.additionalMac, input.additional_mac]) {
      if (normalizeMac(value) !== mac) yield value;
    }
  }
  const alternateMacResult = uniqueLimited(alternateMacCandidates(), normalizeMac);
  const alternateMacs = alternateMacResult.values.filter((item) => item !== mac);
  const possibleIpResult = uniqueLimited(input.possibleIps || [], normalizeIp);
  const inputConflicts = Array.isArray(input.conflicts) ? input.conflicts : [];
  const customFields = {};
  const customFieldSources = {};
  for (const [key, value] of Object.entries(input.customFields && typeof input.customFields === "object" && !Array.isArray(input.customFields) ? input.customFields : {})) {
    if (!/^custom_[0-9a-f-]{36}$/i.test(key) || !["string", "number", "boolean"].includes(typeof value)) continue;
    const normalized = text(value);
    if (normalized) customFields[key] = normalized;
  }
  for (const [key, value] of Object.entries(input.customFieldSources && typeof input.customFieldSources === "object" && !Array.isArray(input.customFieldSources) ? input.customFieldSources : {})) {
    if (/^custom_[0-9a-f-]{36}$/i.test(key) && customFields[key] && text(value)) customFieldSources[key] = text(value);
  }
  const sourceName = text(source || input.source) || "Импорт";
  const identityAliasConflicts = [];
  const collectAliasConflicts = (field, aliases, normalize) => {
    const values = [];
    for (const [name, raw] of aliases) {
      const value = normalize === normalizeMac ? normalize(raw) : identityText(raw);
      if (value && !values.some((item) => item.key === keyText(value))) values.push({ name, value, key: keyText(value) });
    }
    for (const alternative of values.slice(1)) {
      identityAliasConflicts.push({
        field: "identity",
        identifier: field,
        selected: values[0].value,
        alternative: alternative.value,
        source: sourceName,
        reason: `Конфликтующие алиасы сильного идентификатора (${values[0].name} / ${alternative.name})`,
      });
    }
  };
  collectAliasConflicts("id", [
    ["id", input.id], ["internalDeviceId", input.internalDeviceId], ["internal_device_id", input.internal_device_id],
  ], identityText);
  collectAliasConflicts("deviceId", [
    ["deviceId", input.deviceId], ["device_id", input.device_id], ["asset_id", input.asset_id],
  ], identityText);
  collectAliasConflicts("serial", [
    ["serial", input.serial], ["serialNumber", input.serialNumber], ["serial_number", input.serial_number],
  ], identityText);
  collectAliasConflicts("mac", [
    ["mac", input.mac], ["macAddress", input.macAddress], ["macFormatted", input.macFormatted],
    ["mac_formatted", input.mac_formatted], ["CallingStationID", input.CallingStationID],
  ], normalizeMac);
  const combinedConflicts = [...identityAliasConflicts, ...inputConflicts];
  return {
    id: [input.id, input.internalDeviceId, input.internal_device_id].map(identityText).find(Boolean) || "",
    mac,
    alternateMacs,
    alternateMacsTruncated: Boolean(input.alternateMacsTruncated || alternateMacResult.truncated),
    ip: normalizeIp(input.ip) || normalizeIp(input.deviceIp) || normalizeIp(input.device_ip),
    switchIp: normalizeIp(input.switchIp) || normalizeIp(input.ipSwitch) || normalizeIp(input.ip_switch) || normalizeIp(input.nasIp),
    switchPort: firstKnown(input.switchPort, input.port, input.nasPortId),
    smartroomId: firstKnown(input.smartroomId, input.smartroom_id),
    businessUnit: firstKnown(input.businessUnit, inferredLocation?.businessUnit),
    city: firstKnown(input.city, inferredLocation?.city),
    site: firstKnown(input.site, inferredLocation?.site),
    floor: firstKnown(input.floor, inferredLocation?.floor),
    room: firstKnown(inputRoomIsPath ? "" : input.room, inferredLocation?.room),
    address: firstKnown(inputAddressIsPath ? "" : input.address, inferredLocation?.address),
    physicalAddress: firstKnown(input.physicalAddress),
    manufacturer: firstKnown(input.manufacturer, input.vendor),
    model: firstKnown(input.model),
    deviceType: firstKnown(input.deviceType, input.type),
    hostname: firstKnown(input.hostname, input.host, input.host_name),
    serial: [input.serial, input.serialNumber, input.serial_number].map(identityText).find(Boolean) || "",
    deviceId: [input.deviceId, input.device_id, input.asset_id].map(identityText).find(Boolean) || "",
    deviceName: firstKnown(input.deviceName, input.name),
    authenticationTime: [input.authenticationTime, input.receiptTime].map(normalizeDate).find(Boolean) || "",
    possibleIps: possibleIpResult.values,
    possibleIpsTruncated: Boolean(input.possibleIpsTruncated || possibleIpResult.truncated),
    sources: unique([...(input.sources || []), source || input.source]),
    fieldSources: { ...(input.fieldSources || {}) },
    customFields,
    customFieldSources,
    conflicts: combinedConflicts.slice(0, MAX_DEVICE_CONFLICTS),
    conflictsTruncated: Boolean(input.conflictsTruncated || combinedConflicts.length > MAX_DEVICE_CONFLICTS),
  };
}

export function hasStrongIdentity(device = {}) {
  const alternateMacs = Array.isArray(device.alternateMacs) ? device.alternateMacs : [];
  return Boolean(identityText(device.id) || identityText(device.deviceId) || identityText(device.serial)
    || normalizeMac(device.mac)
    || normalizeMac(device.mac2)
    || normalizeMac(device.secondaryMac)
    || alternateMacs.some((mac) => normalizeMac(mac)));
}

