export const DEFAULT_ENRICHMENT_FIELD_SETTINGS = Object.freeze({
  model: true,
  address: true,
  ip: true,
  vendor: true,
  room: true,
  switch_ip: true,
  switch_port: true,
});

export function normalizeEnrichmentFieldSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const settings = { ...DEFAULT_ENRICHMENT_FIELD_SETTINGS };
  for (const field of Object.keys(settings)) {
    if (typeof source[field] === "boolean") settings[field] = source[field];
  }
  return settings;
}
