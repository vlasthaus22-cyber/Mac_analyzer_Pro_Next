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

function addMacEvidenceCount(evidence, key) {
  evidence.set(key, (evidence.get(key) || 0) + 1);
}

function macEvidenceView(evidence, prefix) {
  if (!evidence?.size) return null;
  return {
    has: (key) => evidence.has(`${prefix}${key}`),
    *[Symbol.iterator]() {
      for (const [key, count] of evidence) {
        if (key.startsWith(prefix)) yield [key.slice(prefix.length), count];
      }
    },
  };
}

const macVendorModelPrefix = (vendorKey) => `vendor-model:${JSON.stringify(vendorKey)}:`;

function addVendorGroupDevice(groups, device, similarityGroups = null) {
  const hex = macHex(firstMac(device?.mac, device?.macFormatted, device?.mac_formatted));
  const vendor = fieldValue(device, ["manufacturer", "vendor"]);
  const model = fieldValue(device, ["model"]);
  const missingKnowledge = !vendor || !model;
  if (hex.length !== 12 || (!vendor && !model)) return missingKnowledge;
  const key = hex.slice(0, 8);
  let group = groups.get(key);
  if (!group) {
    group = { vendors: new Map(), models: new Map(), macs: new Map(), vendorRanking: [], modelRanking: [] };
    groups.set(key, group);
  }
  let sameMacEvidence = group.macs.get(hex);
  if (!sameMacEvidence) {
    sameMacEvidence = new Map();
    group.macs.set(hex, sameMacEvidence);
  }
  if (model) {
    const modelKey = model.toLocaleLowerCase("ru-RU");
    let modelCandidate = group.models.get(modelKey);
    if (!modelCandidate) {
      modelCandidate = { key: modelKey, model, count: 0 };
      group.models.set(modelKey, modelCandidate);
    }
    modelCandidate.count += 1;
    addMacEvidenceCount(sameMacEvidence, `model:${modelKey}`);
  }
  if (vendor) {
    const vendorKey = vendor.toLocaleLowerCase("ru-RU");
    const candidate = vendorCandidateFor(group, vendor);
    candidate.count += 1;
    addMacEvidenceCount(sameMacEvidence, `vendor:${vendorKey}`);
    if (model) {
      const modelKey = model.toLocaleLowerCase("ru-RU");
      let modelCandidate = candidate.models.get(modelKey);
      if (!modelCandidate) {
        modelCandidate = { key: modelKey, model, count: 0 };
        candidate.models.set(modelKey, modelCandidate);
      }
      modelCandidate.count += 1;
      addMacEvidenceCount(sameMacEvidence, `${macVendorModelPrefix(vendorKey)}${modelKey}`);
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
  return missingKnowledge;
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
  const macEvidence = group4?.macs.get(hex);
  const sameMacVendors = macEvidenceView(macEvidence, "vendor:");
  const candidates = [
    { group: similarityGroups.get(10)?.get(hex.slice(0, 10)), confidence: 0.78 },
    { group: group4, confidence: 0.7 },
    { group: similarityGroups.get(6)?.get(hex.slice(0, 6)), confidence: 0.62 },
  ];
  for (const candidate of candidates) {
    if (!candidate.group) continue;
    const evidence = mostCommonExcludingMac(candidate.group.vendorRanking, sameMacVendors, candidate.group.vendors);
    const sameMacModels = macEvidenceView(macEvidence, "model:");
    const modelEvidence = mostCommonExcludingMac(candidate.group.modelRanking, sameMacModels, candidate.group.models);
    if (evidence.best || evidence.tied || modelEvidence.best || modelEvidence.tied) {
      return { ...candidate, evidence, modelEvidence };
    }
  }
  return null;
}

function applyVendorGroupDevice(device, groups, similarityGroups, settings, result) {
  const previousVendor = fieldValue(device, ["manufacturer", "vendor"]);
  const previousModel = fieldValue(device, ["model"]);
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
  const macEvidence = groups.get(hex.slice(0, 8))?.macs.get(hex);
  const sameMacModels = macEvidenceView(macEvidence, macVendorModelPrefix(best?.key || ""));
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
  return fieldValue(device, ["manufacturer", "vendor"]) !== previousVendor
    || fieldValue(device, ["model"]) !== previousModel;
}

function hasMissingKnowledge(devices) {
  for (const device of devices) {
    if (!fieldValue(device, ["manufacturer", "vendor"]) || !fieldValue(device, ["model"])) return true;
  }
  return false;
}

async function hasMissingKnowledgeAsync(devices, options) {
  let hasMissing = false;
  await forEachDetectionPage(devices, (page) => {
    for (const device of page) {
      if (!fieldValue(device, ["manufacturer", "vendor"]) || !fieldValue(device, ["model"])) {
        hasMissing = true;
        return false;
      }
    }
  }, options);
  return hasMissing;
}

async function forEachDetectionPage(devices, visit, { signal, yieldToTask, writeBack = false } = {}) {
  const count = Array.isArray(devices) ? devices.length : Number(devices?.count);
  if (!Number.isSafeInteger(count) || count < 0
    || (!Array.isArray(devices) && (typeof devices?.readPage !== "function" || typeof devices?.writePage !== "function"))) {
    throw new TypeError("Ожидался массив устройств или постраничное хранилище Final");
  }
  for (let offset = 0; offset < count; offset += VENDOR_DETECTION_BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const limit = Math.min(VENDOR_DETECTION_BATCH_SIZE, count - offset);
    const page = Array.isArray(devices) ? devices.slice(offset, offset + limit) : await devices.readPage(offset, limit);
    if (!Array.isArray(page) || page.length !== limit || page.some((device) => !device || typeof device !== "object")) {
      throw new Error(`Хранилище Final вернуло неполную страницу устройств ${offset + 1}–${offset + limit}`);
    }
    const visitResult = await visit(page, offset);
    const shouldWriteBack = typeof writeBack === "function"
      ? await writeBack(page, visitResult, offset)
      : writeBack;
    if (!Array.isArray(devices) && shouldWriteBack) await devices.writePage(offset, page);
    page.length = 0;
    if (visitResult === false) break;
    if (offset + limit < count) await yieldToTask();
  }
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
  const deviceCount = Array.isArray(devices) ? devices.length : Number(devices?.count);
  if (!Number.isSafeInteger(deviceCount) || deviceCount < 0) throw new TypeError("Некорректное хранилище устройств для автоопределения");
  if (!deviceCount) return result;
  const abort = () => {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  };
  const yieldToTask = async () => {
    if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
    else if (typeof globalThis.setImmediate === "function") await new Promise((resolve) => globalThis.setImmediate(resolve));
    else await new Promise((resolve) => setTimeout(resolve, 0));
    abort();
  };
  const pageOptions = { signal, yieldToTask };
  if (!settings.enabled || (!settings.useText && !settings.useInference)) return result;
  abort();
  if (settings.useInference) {
    if (!await hasMissingKnowledgeAsync(devices, pageOptions)) return result;
    await forEachDetectionPage(devices, (page) => {
      for (const device of page) addVendorGroupDevice(groups, device, similarityGroups);
    }, pageOptions);
    finalizeVendorGroups(groups);
    finalizeSimilarityGroups(similarityGroups);
    abort();
  }
  await forEachDetectionPage(devices, (page) => {
    let changed = false;
    for (const device of page) {
      if (applyVendorGroupDevice(device, groups, similarityGroups, settings, result)) changed = true;
    }
    return { changed };
  }, { ...pageOptions, writeBack: (_page, result) => result?.changed === true });
  abort();
  return result;
}
