import { macHex, text } from "./normalize.js";

const EMPTY_VALUES = new Set([
  "unknown", "unknown vendor", "unknown model", "not found", "не найдено",
  "не определено", "неизвестно", "неизвестен", "не указана", "неизвестная модель", "неизвестный вендор",
]);
const PREFIX_LENGTHS = Object.freeze([6, 8, 10]);

function known(value) {
  const valueText = text(value);
  return valueText && !EMPTY_VALUES.has(valueText.toLocaleLowerCase("ru-RU")) ? valueText : "";
}

function compareValues(left, right) {
  return left.toLocaleLowerCase("ru-RU").localeCompare(right.toLocaleLowerCase("ru-RU"), "ru-RU") || left.localeCompare(right, "ru-RU");
}

function increment(groups, prefix, value) {
  if (!prefix || !value) return;
  let values = groups.get(prefix);
  if (!values) groups.set(prefix, values = new Map());
  const key = value.toLocaleLowerCase("ru-RU");
  const entry = values.get(key);
  if (entry) entry.count += 1;
  else values.set(key, { value, count: 1 });
}

function bestPerPrefix(groups, minimumCount, existingPrefixes) {
  const suggestions = [];
  for (const [prefix, values] of groups) {
    if (existingPrefixes?.has(prefix)) continue;
    let best = null;
    for (const candidate of values.values()) {
      if (!best || candidate.count > best.count || (candidate.count === best.count && compareValues(candidate.value, best.value) < 0)) best = candidate;
    }
    if (best && best.count >= minimumCount) suggestions.push({ prefix, value: best.value, observations: best.count });
  }
  return suggestions.sort((left, right) => left.prefix.localeCompare(right.prefix));
}

export function createVendorModelRuleLearner({ minimumCount = 2, sourceFilter = "" } = {}) {
  const minCount = Math.max(1, Math.min(999, Math.trunc(Number(minimumCount) || 2)));
  const sourceNeedle = text(sourceFilter).toLocaleLowerCase("ru-RU");
  const vendorGroups = new Map();
  const modelGroups = new Map();
  let scannedDevices = 0;
  let matchedDevices = 0;

  return {
    add(device = {}, snapshot = {}) {
      scannedDevices += 1;
      if (sourceNeedle) {
        const sourceNames = [
          device.source,
          ...(Array.isArray(device.sources) ? device.sources : []),
          ...(Array.isArray(device.sourceFiles) ? device.sourceFiles : []),
          snapshot.name,
          ...(Array.isArray(snapshot.sourceFiles) ? snapshot.sourceFiles.map((file) => typeof file === "string" ? file : file?.name) : []),
        ].filter(Boolean).join(" ").toLocaleLowerCase("ru-RU");
        if (!sourceNames.includes(sourceNeedle)) return;
      }
      const mac = macHex(device.mac || device.macFormatted || device.mac_formatted);
      if (mac.length !== 12) return;
      const vendor = known(device.manufacturer) || known(device.vendor);
      const model = known(device.model);
      if (!vendor && !model) return;
      matchedDevices += 1;
      for (const length of PREFIX_LENGTHS) {
        const prefix = mac.slice(0, length);
        increment(vendorGroups, prefix, vendor);
        increment(modelGroups, prefix, model);
      }
    },
    result({ existingVendorPrefixes = new Set(), existingModelPrefixes = new Set() } = {}) {
      const vendors = bestPerPrefix(vendorGroups, minCount, existingVendorPrefixes)
        .map(({ prefix, value, observations }) => ({ prefix, vendor: value, observations }));
      const models = bestPerPrefix(modelGroups, minCount, existingModelPrefixes)
        .map(({ prefix, value, observations }) => ({ prefix, model: value, observations }));
      return { minimumCount: minCount, scannedDevices, matchedDevices, vendors, models };
    },
  };
}
