import { firstMac, macHex, text } from "./normalize.js";

export const DEFAULT_VENDOR_DETECTOR_SETTINGS = Object.freeze({
  enabled: true,
  useOui3: true,
  useMac5: true,
  useText: true,
  useInference: true,
  confidenceThreshold: 0.6,
});

export function normalizeVendorDetectorSettings(value = {}) {
  const threshold = Number(value.confidenceThreshold ?? DEFAULT_VENDOR_DETECTOR_SETTINGS.confidenceThreshold);
  return {
    enabled: value.enabled !== false,
    useOui3: value.useOui3 !== false,
    useMac5: value.useMac5 !== false,
    useText: value.useText !== false,
    useInference: value.useInference !== false,
    confidenceThreshold: Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : DEFAULT_VENDOR_DETECTOR_SETTINGS.confidenceThreshold,
  };
}

export function legacyVendorDetectorSettings(value) {
  let settings = value;
  if (typeof settings === "string") {
    try { settings = JSON.parse(settings); } catch { return null; }
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  return normalizeVendorDetectorSettings({
    ...settings,
    useOui3: settings.useOui3 ?? settings.use_oui_3byte,
    useMac5: settings.useMac5 ?? settings.use_oui_5byte,
    useText: settings.useText ?? settings.use_text_analysis,
    useInference: settings.useInference ?? settings.use_inference,
    confidenceThreshold: settings.confidenceThreshold ?? settings.confidence_threshold,
  });
}

function fieldValue(device, fields) {
  for (const field of fields) {
    const value = text(device?.[field]);
    if (value && !/^(unknown|не указано|неизвестен|-)$/i.test(value)) return value;
  }
  return "";
}

const VENDOR_KEYWORDS = Object.freeze({
  Apple: ["apple", "iphone", "ipad", "macbook", "imac", "mac", "ios", "ipod", "airport"],
  Samsung: ["samsung", "galaxy", "note", "s series", "gear", "odyssey", "ssd"],
  Huawei: ["huawei", "honor", "mate", "p series", "mediapad", "ascend"],
  Xiaomi: ["xiaomi", "mi ", "redmi", "poco", "black shark", "mijia"],
  Lenovo: ["lenovo", "thinkpad", "ideapad", "yoga", "legion", "thinkcentre"],
  Dell: ["dell", "xps", "latitude", "inspiron", "precision", "alienware", "poweredge"],
  HP: ["hp", "hewlett packard", "elitebook", "probook", "spectre", "envy", "pavilion", "laserjet"],
  Acer: ["acer", "aspire", "predator", "nitro", "swift", "travelmate"],
  ASUS: ["asus", "rog", "zenbook", "vivobook", "tuf", "prime", "expertbook"],
  Microsoft: ["microsoft", "surface", "xbox", "hololens", "windows", "lumia"],
  Cisco: ["cisco", "catalyst", "meraki", "asa", "nexus", "router", "switch", "firepower"],
  Juniper: ["juniper", "mx", "ex", "srx", "qfx", "netscreen"],
  "TP-Link": ["tp-link", "tplink", "archer", "deco", "kasa", "tapo"],
  Netgear: ["netgear", "orbi", "nighthawk", "prosafe", "insight"],
  Intel: ["intel", "core i", "xeon", "pentium", "celeron", "ethernet"],
  AMD: ["amd", "ryzen", "threadripper", "epyc", "radeon", "athlon"],
  NVIDIA: ["nvidia", "geforce", "quadro", "tesla", "rtx", "gtx"],
  "Raspberry Pi": ["raspberry", "rpi", "pi 3", "pi 4", "pi 5", "pico"],
  Arduino: ["arduino", "uno", "mega", "nano", "esp"],
  ESP32: ["esp32", "esp8266", "espressif"],
});

function detectVendorFromText(device) {
  const sources = [device?.model, device?.description, device?.name, device?.hostname, device?.deviceName, device?.device_name]
    .map((value) => text(value)).filter(Boolean);
  let best = null;
  for (const source of sources) {
    const lower = source.toLocaleLowerCase("ru-RU");
    for (const [vendor, keywords] of Object.entries(VENDOR_KEYWORDS)) {
      const score = keywords.reduce((count, keyword) => count + Number(lower.includes(keyword)), 0);
      const confidence = keywords.length ? Math.min(score / keywords.length * 2, 1) * 0.8 : 0;
      if (score && (!best || confidence > best.confidence)) best = { vendor, confidence, source: `Text: ${source.slice(0, 50)}` };
    }
  }
  return best;
}

const VENDOR_DETECTION_BATCH_SIZE = 500;

function createVendorDetectionState(rawSettings) {
  return {
    settings: normalizeVendorDetectorSettings(rawSettings),
    result: { vendor: 0, model: 0, vendorFromText: 0, vendorFromInference: 0 },
    groups: new Map(),
  };
}

function addVendorGroupDevice(groups, device) {
  const hex = macHex(firstMac(device?.mac, device?.macFormatted, device?.mac_formatted));
  if (hex.length !== 12) return;
  const vendor = fieldValue(device, ["manufacturer", "vendor"]);
  if (!vendor) return;
  const key = hex.slice(0, 8);
  let group = groups.get(key);
  if (!group) {
    group = { vendors: new Map(), macs: new Map(), vendorRanking: [] };
    groups.set(key, group);
  }
  const vendorKey = vendor.toLocaleLowerCase("ru-RU");
  let candidate = group.vendors.get(vendorKey);
  if (!candidate) {
    candidate = { key: vendorKey, vendor, count: 0, models: new Map() };
    group.vendors.set(vendorKey, candidate);
  }
  candidate.count += 1;
  let macVendors = group.macs.get(hex);
  if (!macVendors) {
    macVendors = new Map();
    group.macs.set(hex, macVendors);
  }
  let macVendor = macVendors.get(vendorKey);
  if (!macVendor) {
    macVendor = { count: 0, models: new Map() };
    macVendors.set(vendorKey, macVendor);
  }
  macVendor.count += 1;
  const model = fieldValue(device, ["model"]);
  if (model) {
    const modelKey = model.toLocaleLowerCase("ru-RU");
    let modelCandidate = candidate.models.get(modelKey);
    if (!modelCandidate) {
      modelCandidate = { key: modelKey, model, count: 0 };
      candidate.models.set(modelKey, modelCandidate);
    }
    modelCandidate.count += 1;
    macVendor.models.set(modelKey, (macVendor.models.get(modelKey) || 0) + 1);
  }
}

function mostCommonExcludingMac(candidates, excludedCounts, candidateIndex) {
  let bestCount = 0;
  let best = null;
  let tied = false;
  for (const candidate of candidates) {
    if (excludedCounts?.has(candidate.key)) continue;
    bestCount = candidate.count;
    best = candidate;
    break;
  }
  if (best) {
    for (const candidate of candidates) {
      if (excludedCounts?.has(candidate.key)) continue;
      if (candidate.count < bestCount) break;
      if (candidate.count === bestCount && candidate !== best) tied = true;
    }
  }
  for (const [key, excludedCount] of excludedCounts || []) {
    const candidate = candidateIndex?.get(key) || candidates.find((item) => item.key === key);
    if (!candidate) continue;
    const count = candidate.count - (typeof excludedCount === "number" ? excludedCount : excludedCount.count);
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
      tied = false;
    } else if (count > 0 && count === bestCount) {
      tied = true;
    }
  }
  return { best, tied };
}

function finalizeVendorGroups(groups) {
  for (const group of groups.values()) {
    group.vendorRanking = [...group.vendors.values()].sort((left, right) => right.count - left.count);
    for (const candidate of group.vendorRanking) {
      candidate.modelRanking = [...candidate.models.values()].sort((left, right) => right.count - left.count);
    }
  }
}

function applyVendorGroupDevice(device, groups, settings, result) {
  const hex = macHex(firstMac(device?.mac, device?.macFormatted, device?.mac_formatted));
  const group = hex.length === 12 ? groups.get(hex.slice(0, 8)) : null;
  const macVendors = group?.macs.get(hex);
  const vendorEvidence = group ? mostCommonExcludingMac(group.vendorRanking, macVendors, group.vendors) : { best: null, tied: false };
  const best = vendorEvidence.best;
  const tied = vendorEvidence.tied;
  const missingVendor = !fieldValue(device, ["manufacturer", "vendor"]);
  if (settings.enabled && missingVendor) {
    const candidates = [];
    if (settings.useText) {
      const textMatch = detectVendorFromText(device);
      if (textMatch) candidates.push(textMatch);
    }
    if (settings.useInference && best && !tied) candidates.push({ vendor: best.vendor, confidence: 0.7, source: "Similar device inference" });
    candidates.sort((left, right) => right.confidence - left.confidence);
    const selected = candidates[0];
    if (selected && selected.confidence >= settings.confidenceThreshold) {
      device.manufacturer = selected.vendor;
      if (!fieldValue(device, ["vendor"])) device.vendor = selected.vendor;
      device.vendorConfidence = selected.confidence;
      device.vendorSource = selected.source;
      device.fieldSources ||= {};
      device.fieldSources.manufacturer = selected.source;
      result.vendor += 1;
      if (selected.source === "Similar device inference") result.vendorFromInference += 1;
      else result.vendorFromText += 1;
    }
  }
  const modelEvidence = best && !tied
    ? mostCommonExcludingMac(best.modelRanking, macVendors?.get(best.key)?.models, best.models)
    : { best: null, tied: false };
  const inferredModel = !modelEvidence.tied ? modelEvidence.best?.model || "" : "";
  if (settings.enabled && settings.useInference && !fieldValue(device, ["model"]) && inferredModel && 0.63 >= settings.confidenceThreshold) {
    device.model = inferredModel;
    device.modelConfidence = 0.63;
    device.modelSource = "Similar device inference";
    device.fieldSources ||= {};
    device.fieldSources.model = "Similar device inference";
    result.model += 1;
  }
}

export function applyVendorDetection(devices = [], rawSettings = DEFAULT_VENDOR_DETECTOR_SETTINGS) {
  const { settings, result, groups } = createVendorDetectionState(rawSettings);
  if (!Array.isArray(devices) || !devices.length) return result;
  for (const device of devices) addVendorGroupDevice(groups, device);
  finalizeVendorGroups(groups);
  for (const device of devices) applyVendorGroupDevice(device, groups, settings, result);
  return result;
}

export async function applyVendorDetectionAsync(devices = [], rawSettings = DEFAULT_VENDOR_DETECTOR_SETTINGS, { signal } = {}) {
  const { settings, result, groups } = createVendorDetectionState(rawSettings);
  if (!Array.isArray(devices) || !devices.length) return result;
  const abort = () => {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  };
  const yieldToTask = async () => {
    if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
    else if (typeof globalThis.setImmediate === "function") await new Promise((resolve) => globalThis.setImmediate(resolve));
    else await new Promise((resolve) => setTimeout(resolve, 0));
    abort();
  };
  abort();
  for (let index = 0; index < devices.length; index += 1) {
    if (index % VENDOR_DETECTION_BATCH_SIZE === 0) abort();
    addVendorGroupDevice(groups, devices[index]);
    if ((index + 1) % VENDOR_DETECTION_BATCH_SIZE === 0 && index + 1 < devices.length) await yieldToTask();
  }
  finalizeVendorGroups(groups);
  abort();
  for (let index = 0; index < devices.length; index += 1) {
    if (index % VENDOR_DETECTION_BATCH_SIZE === 0) abort();
    applyVendorGroupDevice(devices[index], groups, settings, result);
    if ((index + 1) % VENDOR_DETECTION_BATCH_SIZE === 0 && index + 1 < devices.length) await yieldToTask();
  }
  abort();
  return result;
}
