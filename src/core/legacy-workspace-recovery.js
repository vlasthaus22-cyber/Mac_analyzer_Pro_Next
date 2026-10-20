const ROLE_MAP = Object.freeze({ primary: "main", smartroom: "smartroom", ddio: "ddio" });

function columnIndex(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : NaN;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return NaN;
}

export function legacyWorkspaceSourceRole(role) {
  return ROLE_MAP[String(role || "").toLowerCase()] || "";
}

export function restoreLegacyWorkspaceMapping(summary, headers, allowedFields, fallback = {}) {
  if (!Array.isArray(headers)) return { ...(fallback || {}) };
  const allowed = new Set(Array.isArray(allowedFields) ? allowedFields : []);
  const mapping = {};
  const usedColumns = new Set();
  const source = summary?.mapping && typeof summary.mapping === "object" && !Array.isArray(summary.mapping)
    ? summary.mapping : {};
  for (const [rawField, rawIndex] of Object.entries(source)) {
    const field = rawField === "macFormatted" ? "mac" : rawField === "vendor" ? "manufacturer" : rawField;
    const index = columnIndex(rawIndex);
    if (!allowed.has(field) || !Number.isInteger(index) || index < 0 || index >= headers.length || usedColumns.has(index)) continue;
    mapping[field] = index;
    usedColumns.add(index);
  }
  for (const [field, rawIndex] of Object.entries(fallback || {})) {
    const index = columnIndex(rawIndex);
    if (!allowed.has(field) || Object.hasOwn(mapping, field) || !Number.isInteger(index) || index < 0 || index >= headers.length || usedColumns.has(index)) continue;
    mapping[field] = index;
    usedColumns.add(index);
  }
  return mapping;
}
