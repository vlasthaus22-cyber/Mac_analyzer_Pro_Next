import { firstMac, text } from "./normalize.js";
import { normalizeOuiPrefix } from "./ieee-registry.js";
import { normalizeMacPrefix } from "./model-knowledge.js";

const EMPTY_VALUES = new Set([
  "unknown", "unknown vendor", "unknown model", "not found", "не найдено",
  "не определено", "неизвестно", "неизвестен", "не указана", "неизвестная модель", "неизвестный вендор",
]);

function known(value) {
  const result = text(value);
  return result && !EMPTY_VALUES.has(result.toLocaleLowerCase("ru-RU")) ? result : "";
}

function historyKey(prefix, value) {
  return `${prefix}\u0000${value.toLocaleLowerCase("ru-RU")}`;
}

function addLoadObservation(loads, source, vendor, model, observedAt) {
  const name = String(source || "Источник не указан");
  let record = loads.get(name);
  if (!record) {
    record = { source: name, records: 0, vendors: new Set(), models: new Set(), lastSeen: "" };
    loads.set(name, record);
  }
  record.records += 1;
  if (vendor) record.vendors.add(vendor);
  if (model) record.models.add(model);
  if (observedAt && observedAt > record.lastSeen) record.lastSeen = observedAt;
}

function addImportedLoad(loads, observation = {}) {
  const payload = observation.payload && typeof observation.payload === "object" ? observation.payload : {};
  const id = String(observation.id || payload.id || "").trim();
  if (!id) return false;
  const rawFilename = String(payload.filename || "").trim();
  const filename = rawFilename.split(/[\\/]/).filter(Boolean).at(-1) || rawFilename || id;
  const source = `SQLite · ${filename}`;
  const key = `legacy-load:${id}`;
  if (loads.has(key)) return false;
  const observedAt = String(observation.observedAt || payload.loadDate || "");
  const nonNegative = (value) => Math.max(0, Number(value) || 0);
  loads.set(key, {
    source,
    records: nonNegative(payload.devicesCount),
    vendors: [],
    models: [],
    lastSeen: observedAt,
    devicesCount: nonNegative(payload.devicesCount),
    newVendorsAdded: nonNegative(payload.newVendorsAdded),
    newModelsAdded: nonNegative(payload.newModelsAdded),
    enrichedFromHistory: nonNegative(payload.enrichedFromHistory),
    importedLoadId: id,
  });
  return true;
}

export class VendorModelHistoryAccumulator {
  constructor() {
    this.vendors = new Map();
    this.models = new Map();
    this.loads = new Map();
    this.totalSnapshots = 0;
    this.totalImportedObservations = 0;
    this.totalImportedLoads = 0;
    this.totalMappingRules = 0;
    this.activeSnapshot = null;
  }

  beginSnapshot(snapshot) {
    if (this.activeSnapshot) throw new Error("Сначала завершите текущий Final в истории производителей и моделей");
    this.activeSnapshot = {
      createdAt: String(snapshot?.createdAt || ""),
      source: String(snapshot?.name || snapshot?.source || snapshot?.id || "Final"),
      vendorKeys: new Set(),
      modelKeys: new Set(),
    };
    this.totalSnapshots += 1;
  }

  addDevice(device = {}) {
    if (!this.activeSnapshot) throw new Error("Начните Final перед добавлением устройств в историю");
    const mac = firstMac(device.mac, device.macFormatted, device.mac_formatted).replaceAll(":", "");
    if (!mac) return;
    const vendor = known(device.manufacturer) || known(device.vendor);
    addLoadObservation(this.loads, this.activeSnapshot.source, vendor, known(device.model), this.activeSnapshot.createdAt);
    const oui = mac.slice(0, 6).toUpperCase();
    if (vendor && oui) {
      const key = historyKey(oui, vendor);
      let record = this.vendors.get(key);
      if (!record) {
        record = { oui, vendor, occurrences: 0, snapshots: 0, importedObservations: 0, sources: new Set(), firstSeen: this.activeSnapshot.createdAt, lastSeen: this.activeSnapshot.createdAt };
        this.vendors.set(key, record);
      }
      record.occurrences += 1;
      if (this.activeSnapshot.source) record.sources.add(this.activeSnapshot.source);
      if (this.activeSnapshot.createdAt && (!record.firstSeen || this.activeSnapshot.createdAt < record.firstSeen)) record.firstSeen = this.activeSnapshot.createdAt;
      if (this.activeSnapshot.createdAt > record.lastSeen) record.lastSeen = this.activeSnapshot.createdAt;
      this.activeSnapshot.vendorKeys.add(key);
    }
    const model = known(device.model);
    const mac5 = mac.slice(0, 10).toUpperCase();
    if (model && mac5) {
      const key = historyKey(mac5, model);
      let record = this.models.get(key);
      if (!record) {
        record = { prefix: mac5, model, occurrences: 0, snapshots: 0, importedObservations: 0, sources: new Set(), firstSeen: this.activeSnapshot.createdAt, lastSeen: this.activeSnapshot.createdAt };
        this.models.set(key, record);
      }
      record.occurrences += 1;
      if (this.activeSnapshot.source) record.sources.add(this.activeSnapshot.source);
      if (this.activeSnapshot.createdAt && (!record.firstSeen || this.activeSnapshot.createdAt < record.firstSeen)) record.firstSeen = this.activeSnapshot.createdAt;
      if (this.activeSnapshot.createdAt > record.lastSeen) record.lastSeen = this.activeSnapshot.createdAt;
      this.activeSnapshot.modelKeys.add(key);
    }
  }

  addObservation(observation = {}) {
    if (observation.kind === "history_loads") {
      const added = addImportedLoad(this.loads, observation);
      if (added) this.totalImportedLoads += 1;
      return added;
    }
    if (observation.kind && !["vendor_model_history", "mac_history", "resolved_device_history"].includes(observation.kind)) return false;
    const payload = observation.payload && typeof observation.payload === "object" ? observation.payload : {};
    const decoded = payload.decodedPayload && typeof payload.decodedPayload === "object" ? payload.decodedPayload : {};
    const mac = firstMac(observation.mac, payload.mac, payload.macFormatted, payload.mac_formatted, decoded.mac, decoded.mac_formatted).replaceAll(":", "");
    if (!mac) return false;
    const vendor = known(payload.vendor || payload.manufacturer || decoded.vendor || decoded.manufacturer);
    const model = known(payload.model || payload.device_model || decoded.model || decoded.device_model);
    const observedAt = String(observation.observedAt || payload.observed_at || payload.recorded_at || "");
    const source = String(payload.source_file || decoded.source_file || payload.source || decoded.source || payload.filename || observation.source || observation.sourceTable || "Imported history");
    addLoadObservation(this.loads, source, vendor, model, observedAt);
    const addImported = (collection, prefix, value, field) => {
      if (!value) return;
      const key = historyKey(prefix, value);
      let record = collection.get(key);
      if (!record) {
        record = field === "vendor"
          ? { oui: prefix, vendor: value, occurrences: 0, snapshots: 0, importedObservations: 0, sources: new Set(), firstSeen: observedAt, lastSeen: observedAt }
          : { prefix, model: value, occurrences: 0, snapshots: 0, importedObservations: 0, sources: new Set(), firstSeen: observedAt, lastSeen: observedAt };
        collection.set(key, record);
      }
      record.occurrences += 1;
      record.importedObservations += 1;
      if (source) record.sources.add(source);
      if (observedAt && (!record.firstSeen || observedAt < record.firstSeen)) record.firstSeen = observedAt;
      if (observedAt && (!record.lastSeen || observedAt > record.lastSeen)) record.lastSeen = observedAt;
    };
    this.totalImportedObservations += 1;
    addImported(this.vendors, mac.slice(0, 6).toUpperCase(), vendor, "vendor");
    addImported(this.models, mac.slice(0, 10).toUpperCase(), model, "model");
    return true;
  }

  addMappingRule({ kind = "vendor", prefix = "", value = "", source = "Пользовательское правило", updatedAt = "", occurrences, firstSeen = "", lastSeen = "" } = {}) {
    const label = known(value);
    const timestamp = String(updatedAt || "");
    const sourceName = String(source || "Пользовательское правило");
    const count = occurrences === undefined ? 1 : Math.max(0, Number(occurrences) || 0);
    const earliest = String(firstSeen || timestamp);
    const latest = String(lastSeen || timestamp);
    if (kind === "model") {
      const normalizedPrefix = normalizeMacPrefix(prefix);
      if (!normalizedPrefix || !label) return false;
      const key = historyKey(normalizedPrefix, label);
      let record = this.models.get(key);
      if (!record) {
        record = { prefix: normalizedPrefix, model: label, occurrences: 0, snapshots: 0, importedObservations: 0, sources: new Set(), firstSeen: timestamp, lastSeen: timestamp };
        this.models.set(key, record);
      }
      record.occurrences += count;
      record.sources.add(sourceName);
      if (earliest && (!record.firstSeen || earliest < record.firstSeen)) record.firstSeen = earliest;
      if (latest && (!record.lastSeen || latest > record.lastSeen)) record.lastSeen = latest;
      addLoadObservation(this.loads, sourceName, "", label, timestamp);
    } else {
      const normalizedPrefix = normalizeOuiPrefix(prefix);
      if (!normalizedPrefix || !label) return false;
      const oui = normalizedPrefix.slice(0, 6);
      const key = historyKey(oui, label);
      let record = this.vendors.get(key);
      if (!record) {
        record = { oui, vendor: label, occurrences: 0, snapshots: 0, importedObservations: 0, sources: new Set(), firstSeen: timestamp, lastSeen: timestamp };
        this.vendors.set(key, record);
      }
      record.occurrences += count;
      record.sources.add(sourceName);
      if (earliest && (!record.firstSeen || earliest < record.firstSeen)) record.firstSeen = earliest;
      if (latest && (!record.lastSeen || latest > record.lastSeen)) record.lastSeen = latest;
      addLoadObservation(this.loads, sourceName, label, "", timestamp);
    }
    this.totalMappingRules += 1;
    return true;
  }

  endSnapshot() {
    if (!this.activeSnapshot) throw new Error("Нет активного Final для завершения");
    for (const key of this.activeSnapshot.vendorKeys) this.vendors.get(key).snapshots += 1;
    for (const key of this.activeSnapshot.modelKeys) this.models.get(key).snapshots += 1;
    this.activeSnapshot = null;
  }

  result() {
    if (this.activeSnapshot) throw new Error("Завершите текущий Final перед чтением истории");
    const withSources = (record) => ({ ...record, sources: [...record.sources].sort((left, right) => left.localeCompare(right, "ru")) });
    const vendors = [...this.vendors.values()].map(withSources).sort((left, right) => right.occurrences - left.occurrences || left.vendor.localeCompare(right.vendor, "ru") || left.oui.localeCompare(right.oui));
    const models = [...this.models.values()].map(withSources).sort((left, right) => right.occurrences - left.occurrences || left.model.localeCompare(right.model, "ru") || left.prefix.localeCompare(right.prefix));
    const loads = [...this.loads.values()].map((record) => ({
      ...record,
      vendors: [...record.vendors].sort((left, right) => left.localeCompare(right, "ru")),
      models: [...record.models].sort((left, right) => left.localeCompare(right, "ru")),
    })).sort((left, right) => right.records - left.records || left.source.localeCompare(right.source, "ru"));
    return {
      vendors,
      models,
      loads,
      statistics: {
        totalSnapshots: this.totalSnapshots,
        importedObservations: this.totalImportedObservations,
        importedLoads: this.totalImportedLoads,
        mappingRules: this.totalMappingRules,
        loadRecords: loads.length,
        ouiVendorRecords: vendors.length,
        uniqueOuis: new Set(vendors.map((item) => item.oui)).size,
        uniqueVendors: new Set(vendors.map((item) => item.vendor.toLocaleLowerCase("ru-RU"))).size,
        mac5ModelRecords: models.length,
        uniqueModels: new Set(models.map((item) => item.model.toLocaleLowerCase("ru-RU"))).size,
      },
    };
  }
}

export function selectVendorModelHistoryPage(history, { kind = "vendors", query = "", page = 1, limit = 50 } = {}) {
  const filtered = filterVendorModelHistory(history, { kind, query });
  const safeLimit = Math.max(1, Number(limit) || 50);
  const pageCount = Math.max(1, Math.ceil(filtered.length / safeLimit));
  const safePage = Math.min(pageCount, Math.max(1, Number(page) || 1));
  const start = (safePage - 1) * safeLimit;
  return { rows: filtered.slice(start, start + safeLimit), total: filtered.length, page: safePage, pageCount, hasPrevious: safePage > 1, hasNext: safePage < pageCount };
}

export function filterVendorModelHistory(history, { kind = "vendors", query = "" } = {}) {
  const rows = kind === "models" ? history?.models || [] : kind === "loads" ? history?.loads || [] : history?.vendors || [];
  const normalizedQuery = normalizeVendorModelHistoryQuery(query);
  return normalizedQuery
    ? rows.filter((row) => matchesVendorModelHistoryQuery(row, kind, normalizedQuery))
    : [...rows];
}

function normalizeVendorModelHistoryQuery(query) {
  return String(query || "").trim().toLocaleLowerCase("ru-RU");
}

function matchesVendorModelHistoryQuery(row, kind, normalizedQuery) {
  const fields = kind === "models" ? ["prefix", "model", "sources", "firstSeen", "lastSeen"]
    : kind === "loads" ? ["source", "vendors", "models", "lastSeen"]
      : ["oui", "vendor", "sources", "firstSeen", "lastSeen"];
  return fields.some((field) => String(row[field] ?? "").toLocaleLowerCase("ru-RU").includes(normalizedQuery));
}

export function* vendorModelHistoryCsvChunks(history, { kind = "vendors", query = "", columns = [] } = {}) {
  const rows = kind === "models" ? history?.models || [] : kind === "loads" ? history?.loads || [] : history?.vendors || [];
  const normalizedQuery = normalizeVendorModelHistoryQuery(query);
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  yield `\uFEFF${columns.map(([, label]) => quote(label)).join(";")}`;
  for (const row of rows) {
    if (normalizedQuery && !matchesVendorModelHistoryQuery(row, kind, normalizedQuery)) continue;
    yield `\r\n${columns.map(([key]) => quote(Array.isArray(row[key]) ? row[key].join("; ") : row[key])).join(";")}`;
  }
}
