import { keyText, text } from "./normalize.js";
import { addCustomInventoryColumn } from "./inventory-columns.js";

export const SOURCE_MAPPING_ROLES = Object.freeze(["main", "smartroom", "ddio"]);
export const MAX_SOURCE_MAPPING_PREFERENCES_PER_ROLE = 8;
const MAX_HEADER_COUNT = 512;
const MAX_HEADER_LENGTH = 512;
const isMappingFieldKey = (field) => /^[a-z][a-zA-Z0-9_]{0,63}$/.test(field) || /^custom_[0-9a-f-]{36}$/i.test(field);

function normalizedHeaders(headers = []) {
  if (!Array.isArray(headers) || headers.length > MAX_HEADER_COUNT) return null;
  const values = headers.map((header) => text(header));
  if (values.some((header) => header.length > MAX_HEADER_LENGTH)) return null;
  return values.map(keyText);
}

export function normalizeSourceMappingPreferences(value = {}) {
  const result = Object.fromEntries(SOURCE_MAPPING_ROLES.map((role) => [role, []]));
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const role of SOURCE_MAPPING_ROLES) {
    const entries = Array.isArray(value[role]) ? value[role] : [];
    for (const candidate of entries.slice(-MAX_SOURCE_MAPPING_PREFERENCES_PER_ROLE)) {
      const headers = normalizedHeaders(candidate?.headers);
      const mapping = candidate?.mapping;
      if (!headers || !headers.length || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
      const fields = {};
      for (const [field, index] of Object.entries(mapping)) {
        if (isMappingFieldKey(field) && Number.isInteger(index) && index >= 0 && index < headers.length) fields[field] = index;
      }
      result[role].push({ headers, mapping: fields });
    }
  }
  return result;
}

export function rememberSourceMapping(headers = [], mapping = {}) {
  const normalized = normalizedHeaders(headers);
  if (!normalized || !normalized.length) return null;
  const fields = {};
  for (const [field, index] of Object.entries(mapping || {})) {
    if (isMappingFieldKey(field) && Number.isInteger(index) && index >= 0 && index < normalized.length) fields[field] = index;
  }
  return { headers: normalized, mapping: fields };
}

export function restoreSourceMapping(headers = [], preferences = [], fallback = {}) {
  const normalized = normalizedHeaders(headers);
  if (!normalized) return { ...(fallback || {}) };
  const match = [...(Array.isArray(preferences) ? preferences : [])].reverse()
    .find((preference) => Array.isArray(preference?.headers)
      && preference.headers.length === normalized.length
      && preference.headers.every((header, index) => header === normalized[index]));
  if (!match) return { ...(fallback || {}) };
  return Object.fromEntries(Object.entries(match.mapping || {}).filter(([, index]) => Number.isInteger(index) && index >= 0 && index < normalized.length));
}

export function upsertSourceMappingPreference(preferences = [], preference) {
  if (!preference?.headers?.length) return (Array.isArray(preferences) ? preferences : []).slice(-MAX_SOURCE_MAPPING_PREFERENCES_PER_ROLE);
  const entries = Array.isArray(preferences) ? preferences : [];
  const remaining = entries.filter((entry) => !(Array.isArray(entry?.headers)
    && entry.headers.length === preference.headers.length
    && entry.headers.every((header, index) => header === preference.headers[index])));
  return [...remaining, preference].slice(-MAX_SOURCE_MAPPING_PREFERENCES_PER_ROLE);
}

export function createCustomSourceFieldMapping(config, mapping = {}, label, columnIndex, headerCount) {
  const nextConfig = addCustomInventoryColumn(config, label);
  const field = nextConfig.columns.at(-1);
  field.visible = false;
  const nextMapping = { ...mapping };
  if (columnIndex !== "" && columnIndex !== null && columnIndex !== undefined) {
    const index = Number(columnIndex);
    if (!Number.isInteger(index) || index < 0 || index >= Number(headerCount)) {
      throw new RangeError("Выберите существующую колонку источника");
    }
    if (Object.values(nextMapping).some((value) => Number.isInteger(value) && value === index)) {
      throw new Error("Эта колонка уже назначена другому полю");
    }
    nextMapping[field.key] = index;
  }
  return { config: nextConfig, mapping: nextMapping, field };
}
