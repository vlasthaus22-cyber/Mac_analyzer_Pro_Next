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
    similarityGroups: new Map([[10, new Map()], [6, new Map()]]),
  };
}

function vendorCandidateFor(group, vendor) {
  const vendorKey = vendor.toLocaleLowerCase("ru-RU");
  let candidate = group.vendors.get(vendorKey);
  if (!candidate) {
    candidate = { key: vendorKey, vendor, count: 0, models: new Map() };
    group.vendors.set(vendorKey, candidate);
  }
  return candidate;
}

function addVendorGroupDevice(groups, device, similarityGroups = null) {
  const hex = macHex(firstMac(device?.mac, device?.macFormatted, device?.mac_formatted));
  if (hex.length !== 12) return;
  const vendor = fieldValue(device, ["manufacturer", "vendor"]);
  const model = fieldValue(device, ["model"]);
  if (!vendor && !model) return;
  const key = hex.slice(0, 8);
  let group = groups.get(key);
  if (!group) {
    group = { vendors: new Map(), models: new Map(), macs: new Map(), vendorRanking: [], modelRanking: [] };
    groups.set(key, group);
  }
  let sameMac = group.macs.get(hex);
  if (!sameMac) {
    sameMac = { vendors: new Map(), models: new Map() };
    group.macs.set(hex, sameMac);
  }
  if (model) {
    const modelKey = model.toLocaleLowerCase("ru-RU");
    let modelCandidate = group.models.get(modelKey);
    if (!modelCandidate) {
      modelCandidate = { key: modelKey, model, count: 0 };
      group.models.set(modelKey, modelCandidate);
    }
    modelCandidate.count += 1;
    sameMac.models.set(modelKey, (sameMac.models.get(modelKey) || 0) + 1);
  }
  if (vendor) {
    const vendorKey = vendor.toLocaleLowerCase("ru-RU");
    const candidate = vendorCandidateFor(group, vendor);
    candidate.count += 1;
    let macVendor = sameMac.vendors.get(vendorKey);
    if (!macVendor) {
      macVendor = { count: 0, models: new Map() };
      sameMac.vendors.set(vendorKey, macVendor);
    }
    macVendor.count += 1;
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
  for (const [length, prefixGroups] of similarityGroups || []) {
    const prefix = hex.slice(0, length);
    let prefixGroup = prefixGroups.get(prefix);
    if (!prefixGroup) {
      prefixGroup = { vendors: new Map(), models: new Map(), vendorRanking: [], modelRanking: [] };
      prefixGroups.set(prefix, prefixGroup);
    }
    const prefixCandidate = vendor ? vendorCandidateFor(prefixGroup, vendor) : null;
    if (prefixCandidate) prefixCandidate.count += 1;
    if (model) {
      const modelKey = model.toLocaleLowerCase("ru-RU");
      let modelCandidate = prefixGroup.models.get(modelKey);
      if (!modelCandidate) {
        modelCandidate = { key: modelKey, model, count: 0 };
        prefixGroup.models.set(modelKey, modelCandidate);
      }
      modelCandidate.count += 1;
      if (prefixCandidate) {
        let vendorModel = prefixCandidate.models.get(modelKey);
        if (!vendorModel) {
          vendorModel = { key: modelKey, model, count: 0 };
          prefixCandidate.models.set(modelKey, vendorModel);
        }
        vendorModel.count += 1;
      }
    }
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
    group.modelRanking = [...group.models.values()].sort((left, right) => right.count - left.count);
    for (const candidate of group.vendorRanking) {
      candidate.modelRanking = [...candidate.models.values()].sort((left, right) => right.count - left.count);
    }
  }
}

function finalizeSimilarityGroups(groups) {
  for (const prefixGroups of groups.values()) {
    for (const group of prefixGroups.values()) {
      group.vendorRanking = [...group.vendors.values()].sort((left, right) => right.count - left.count);
      group.modelRanking = [...group.models.values()].sort((left, right) => right.count - left.count);
      for (const candidate of group.vendorRanking) {
        candidate.modelRanking = [...candidate.models.values()].sort((left, right) => right.count - left.count);
      }
    }
  }
}

function similarDeviceEvidence(hex, groups, similarityGroups) {
  if (hex.length !== 12) return null;
  const group4 = groups.get(hex.slice(0, 8));
  const sameMacVendors = group4?.macs.get(hex)?.vendors;
  const candidates = [
    { group: similarityGroups.get(10)?.get(hex.slice(0, 10)), confidence: 0.78 },
    { group: group4, confidence: 0.7 },
    { group: similarityGroups.get(6)?.get(hex.slice(0, 6)), confidence: 0.62 },
  ];
  for (const candidate of candidates) {
    if (!candidate.group) continue;
    const evidence = mostCommonExcludingMac(candidate.group.vendorRanking, sameMacVendors, candidate.group.vendors);
    const sameMacModels = groups.get(hex.slice(0, 8))?.macs.get(hex)?.models;
    const modelEvidence = mostCommonExcludingMac(candidate.group.modelRanking, sameMacModels, candidate.group.models);
    if (evidence.best || evidence.tied || modelEvidence.best || modelEvidence.tied) {
      return { ...candidate, evidence, modelEvidence };
    }
  }
  return null;
}

function applyVendorGroupDevice(device, groups, similarityGroups, settings, result) {
  const hex = settings.useInference ? macHex(firstMac(device?.mac, device?.macFormatted, device?.mac_formatted)) : "";
  const similar = settings.useInference ? similarDeviceEvidence(hex, groups, similarityGroups) : null;
  const vendorEvidence = similar?.evidence || { best: null, tied: false };
  const best = vendorEvidence.best;
  const tied = vendorEvidence.tied;
  const missingVendor = !fieldValue(device, ["manufacturer", "vendor"]);
  if (settings.enabled && missingVendor) {
    const candidates = [];
    if (settings.useText) {
      const textMatch = detectVendorFromText(device);
      if (textMatch) candidates.push(textMatch);
    }
    if (settings.useInference && best && !tied) candidates.push({ vendor: best.vendor, confidence: similar.confidence, source: "Similar device inference" });
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
  const sameMacModels = groups.get(hex.slice(0, 8))?.macs.get(hex)?.vendors.get(best?.key)?.models;
  const modelEvidence = best && !tied
    ? mostCommonExcludingMac(best.modelRanking, sameMacModels, best.models)
    : (similar && !tied ? similar.modelEvidence : { best: null, tied: false });
  const inferredModel = !modelEvidence.tied ? modelEvidence.best?.model || "" : "";
  const modelConfidence = similar ? similar.confidence * 0.9 : 0;
  if (settings.enabled && settings.useInference && !fieldValue(device, ["model"]) && inferredModel && modelConfidence >= settings.confidenceThreshold) {
    device.model = inferredModel;
    device.modelConfidence = modelConfidence;
    device.modelSource = "Similar device inference";
    device.fieldSources ||= {};
    device.fieldSources.model = "Similar device inference";
    result.model += 1;
  }
}

function hasMissingKnowledge(devices) {
  for (const device of devices) {
    if (!fieldValue(device, ["manufacturer", "vendor"]) || !fieldValue(device, ["model"])) return true;
  }
  return false;
}

export function applyVendorDetection(devices = [], rawSettings = DEFAULT_VENDOR_DETECTOR_SETTINGS) {
  const { settings, result, groups, similarityGroups } = createVendorDetectionState(rawSettings);
  if (!Array.isArray(devices) || !devices.length || !settings.enabled
    || (!settings.useText && !settings.useInference) || !hasMissingKnowledge(devices)) return result;
  if (settings.useInference) {
    for (const device of devices) addVendorGroupDevice(groups, device, similarityGroups);
    finalizeVendorGroups(groups);
    finalizeSimilarityGroups(similarityGroups);
  }
  for (const device of devices) applyVendorGroupDevice(device, groups, similarityGroups, settings, result);
  return result;
}

export async function applyVendorDetectionAsync(devices = [], rawSettings = DEFAULT_VENDOR_DETECTOR_SETTINGS, { signal } = {}) {
  const { settings, result, groups, similarityGroups } = createVendorDetectionState(rawSettings);
  if (!Array.isArray(devices) || !devices.length) return result;
  if (!settings.enabled || (!settings.useText && !settings.useInference) || !hasMissingKnowledge(devices)) return result;
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
  if (settings.useInference) {
    for (let index = 0; index < devices.length; index += 1) {
      if (index % VENDOR_DETECTION_BATCH_SIZE === 0) abort();
      addVendorGroupDevice(groups, devices[index], similarityGroups);
      if ((index + 1) % VENDOR_DETECTION_BATCH_SIZE === 0 && index + 1 < devices.length) await yieldToTask();
    }
    finalizeVendorGroups(groups);
    finalizeSimilarityGroups(similarityGroups);
    abort();
  }
  for (let index = 0; index < devices.length; index += 1) {
    if (index % VENDOR_DETECTION_BATCH_SIZE === 0) abort();
    applyVendorGroupDevice(devices[index], groups, similarityGroups, settings, result);
    if ((index + 1) % VENDOR_DETECTION_BATCH_SIZE === 0 && index + 1 < devices.length) await yieldToTask();
  }
  abort();
  return result;
}
