import { firstMac, macHex, text } from "./normalize.js";

export const BUILTIN_MAC_MODEL_RULES = new Map(Object.entries({
  "00112233": "Cisco Catalyst 2960", "00112244": "Cisco Catalyst 3560",
  "00112255": "Cisco Catalyst 3750", "00112266": "Cisco Catalyst 4500",
  "00112277": "Cisco Catalyst 6500", "00112288": "Cisco ASR 1000",
  "00112299": "Cisco ISR 4000", "005055AA": "Cisco Nexus 3000",
  "005055BB": "Cisco Nexus 5000", "005055CC": "Cisco Nexus 7000",
  "0010B5AA": "Dell PowerEdge R740", "0010B5BB": "Dell PowerEdge R640",
  "0010B5CC": "Dell PowerEdge T340", "0010B5DD": "Dell OptiPlex 7070",
  "0010B5EE": "Dell Latitude 5400", "0010B5FF": "Dell XPS 15",
  "00215AAB": "HP ProLiant DL380", "00215ACC": "HP ProLiant DL360",
  "00215ADD": "HP EliteBook 840", "00215AEE": "HP ZBook 15",
  "00215AFF": "HP LaserJet Pro", "00215A11": "HP OfficeJet Pro",
  "001A1101": "iPhone 13", "001A1102": "iPhone 14", "001A1103": "iPhone 15",
  "001A1120": "iPad Pro", "001A1121": "iPad Air", "001A1130": "MacBook Pro",
  "001A1131": "MacBook Air", "001A1140": 'iMac 24"', "001A1150": "Mac Studio",
  "00259001": "Samsung Galaxy S23", "00259002": "Samsung Galaxy S22",
  "00259010": "Samsung Galaxy Tab", "00259020": "Samsung SSD 980 Pro",
  "00259030": "Samsung Smart Monitor", "00259040": "Samsung M7",
  "001EC901": "Huawei Mate 50", "001EC902": "Huawei P60",
  "001EC910": "Huawei MateBook X", "001EC920": "Huawei Watch GT",
  "00236C01": "Xiaomi Mi 11", "00236C02": "Xiaomi 12T",
  "00236C10": "Xiaomi Mi Band", "00236C20": "Xiaomi Robot Vacuum",
  "0022B001": "TP-Link Archer AX73", "0022B002": "TP-Link Deco X60",
  "0022B010": "TP-Link Tapo C200", "0022B020": "TP-Link Kasa KP115",
  "001E5201": "Netgear Nighthawk RAX200", "001E5202": "Netgear Orbi RBK852",
  "001E5210": "Netgear GS308", "001E5220": "Netgear ReadyNAS",
  "F832E401": "ASUS ROG Zephyrus", "F832E402": "ASUS TUF Gaming",
  "F832E410": "ASUS RT-AX88U", "F832E420": "ASUS ZenBook",
  "00231401": "Lenovo ThinkPad X1", "00231402": "Lenovo ThinkPad T14",
  "00231410": "Lenovo Legion 5", "00231420": "Lenovo Yoga 9i",
}));

export function normalizeMacPrefix(value) {
  const prefix = String(value ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  return /^(?:[0-9A-F]{6}|[0-9A-F]{8}|[0-9A-F]{10})$/.test(prefix) ? prefix : "";
}

export function compileMacModelRules(customRules = [], { includeBuiltins = false } = {}) {
  const byLength = new Map([[6, new Map()], [8, new Map()], [10, new Map()]]);
  if (includeBuiltins) {
    for (const [prefix, model] of BUILTIN_MAC_MODEL_RULES) byLength.get(prefix.length)?.set(prefix, model);
  }
  const entries = customRules instanceof Map
    ? customRules
    : Array.isArray(customRules)
      ? customRules.map((row) => [row?.prefix, row?.model])
      : Object.entries(customRules || {});
  for (const [rawPrefix, rawModel] of entries) {
    const prefix = normalizeMacPrefix(rawPrefix);
    const model = text(rawModel);
    if (prefix && model) byLength.get(prefix.length).set(prefix, model);
  }
  return { kind: "mac-model-prefix-index", byLength };
}

export function lookupMacModel(mac, rules = new Map()) {
  const hex = macHex(mac);
  if (hex.length !== 12) return null;
  if (rules?.kind === "mac-model-prefix-index" && rules.byLength instanceof Map) {
    for (const length of [10, 8, 6]) {
      const prefix = hex.slice(0, length);
      const model = rules.byLength.get(length)?.get(prefix);
      if (text(model)) return { model: text(model), prefix };
    }
    return null;
  }
  const entries = rules instanceof Map ? [...rules] : Object.entries(rules || {});
  const matches = entries
    .map(([rawPrefix, model]) => [normalizeMacPrefix(rawPrefix), text(model)])
    .filter(([prefix, model]) => prefix && model && hex.startsWith(prefix))
    .sort((left, right) => right[0].length - left[0].length);
  return matches.length ? { model: matches[0][1], prefix: matches[0][0] } : null;
}

export function createModelPrefixAnalyticsCollector(modelQuery, customRules = []) {
  const query = text(modelQuery).toLocaleLowerCase("ru-RU");
  const rules = new Map([...BUILTIN_MAC_MODEL_RULES].map(([prefix, model]) => [prefix, { prefix, model, source: "Встроенная база" }]));
  const custom = customRules instanceof Map
    ? [...customRules].map(([prefix, model]) => ({ prefix, model }))
    : Array.isArray(customRules)
      ? customRules
      : Object.entries(customRules || {}).map(([prefix, model]) => ({ prefix, model }));
  for (const row of custom) {
    const prefix = normalizeMacPrefix(row?.prefix);
    const name = text(row?.model);
    if (prefix && name) rules.set(prefix, { prefix, model: name, source: row.source || "Пользовательское правило" });
  }
  const prefixes = [...rules.values()]
    .filter((item) => query && item.model.toLocaleLowerCase("ru-RU").includes(query))
    .sort((left, right) => left.model.localeCompare(right.model, "ru") || left.prefix.localeCompare(right.prefix))
    .map((item) => ({ ...item, formattedPrefix: item.prefix.match(/.{1,2}/g).join(":") }));
  const vendors = new Set();
  let matchedDevices = 0;
  function accept(devices = []) {
    for (const device of Array.isArray(devices) ? devices : []) {
      const model = text(device?.model).toLocaleLowerCase("ru-RU");
      const mac = macHex(firstMac(device?.mac, device?.macFormatted, device?.mac_formatted));
      if (!query || (model !== query && !prefixes.some((item) => mac.startsWith(item.prefix)))) continue;
      matchedDevices += 1;
      const vendor = text(device?.manufacturer || device?.vendor);
      if (vendor) vendors.add(vendor);
    }
  }
  function finish() {
    return {
      model: text(modelQuery),
      prefixes,
      metrics: { prefixes: prefixes.length, matchedDevices, vendors: vendors.size },
    };
  }
  return Object.freeze({ accept, finish });
}

export function buildModelPrefixAnalytics(modelQuery, customRules = [], devices = []) {
  const collector = createModelPrefixAnalyticsCollector(modelQuery, customRules);
  collector.accept(devices);
  return collector.finish();
}

export function createMac5OccurrenceCollector(prefixes = []) {
  const counts = new Map();
  for (const value of prefixes) {
    const prefix = normalizeMacPrefix(typeof value === "string" ? value : value?.prefix);
    if (prefix && !counts.has(prefix)) counts.set(prefix, 0);
  }
  const lengths = [6, 8, 10].filter((length) => [...counts.keys()].some((prefix) => prefix.length === length));
  function accept(devices = []) {
    for (const device of Array.isArray(devices) ? devices : []) {
      const mac = macHex(firstMac(device?.mac, device?.macFormatted, device?.mac_formatted));
      if (mac.length !== 12) continue;
      for (const length of lengths) {
        const prefix = mac.slice(0, length);
        if (counts.has(prefix)) counts.set(prefix, counts.get(prefix) + 1);
      }
    }
  }
  function finish() {
    return new Map(counts);
  }
  return Object.freeze({ accept, finish });
}
