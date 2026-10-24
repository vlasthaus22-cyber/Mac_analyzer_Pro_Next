function hasKnownValue(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== null && value !== undefined;
}

function mergeKnownRecord(previous = {}, incoming = {}) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) if (hasKnownValue(value)) merged[key] = value;
  return merged;
}

/** Merge two Inventory observations with the newer known values taking priority. */
export function mergeInventoryObservations(existing, incoming) {
  const incomingTime = Date.parse(incoming?.lastSeen || incoming?.updatedAt || "") || 0;
  const existingTime = Date.parse(existing?.lastSeen || existing?.updatedAt || "") || 0;
  const merged = mergeKnownRecord(
    incomingTime > existingTime ? existing : incoming,
    incomingTime > existingTime ? incoming : existing || incoming,
  );
  merged.id = incoming?.id ?? existing?.id;
  return merged;
}
