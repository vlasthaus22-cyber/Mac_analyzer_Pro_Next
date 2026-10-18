import { firstMac, text } from "./normalize.js";

export const TEMPORAL_PERIODS = Object.freeze(["day", "week", "month"]);
export const TEMPORAL_RANGE_DAYS = Object.freeze([30, 90, 365]);

export function selectTemporalSnapshotWindow(snapshots = [], { rangeDays = 30, now = Date.now() } = {}) {
  const normalizedDays = TEMPORAL_RANGE_DAYS.includes(Number(rangeDays)) ? Number(rangeDays) : TEMPORAL_RANGE_DAYS[0];
  const nowTimestamp = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowTimestamp)) throw new TypeError("Для временного диапазона нужна корректная дата отсчёта");
  const cutoff = nowTimestamp - normalizedDays * 86_400_000;
  const selected = [];
  for (const snapshot of snapshots) {
    const timestamp = Date.parse(snapshot?.createdAt || "");
    if (Number.isFinite(timestamp) && timestamp >= cutoff) selected.push(snapshot);
  }
  return selected.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function parsedDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function temporalPeriodKey(value, period = "day") {
  if (!TEMPORAL_PERIODS.includes(period)) throw new Error("Период должен быть day, week или month");
  const date = parsedDate(value);
  if (!date) return "Без даты";
  if (period === "month") return date.toISOString().slice(0, 7);
  if (period === "day") return date.toISOString().slice(0, 10);
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3));
  const weekYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4 - jan4Day + 3));
  const week = 1 + Math.round((thursday - firstThursday) / 604_800_000);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

export class TemporalStatisticsAccumulator {
  constructor(period = "day", { deviceMatches, macStore = null, queryId = "" } = {}) {
    if (!TEMPORAL_PERIODS.includes(period)) throw new Error("Период должен быть day, week или month");
    if (macStore && (!queryId || typeof macStore.addAnalyticsDistinctBatch !== "function")) throw new TypeError("Для disk-backed MAC статистики нужны queryId и analytics store");
    this.period = period;
    this.deviceMatches = typeof deviceMatches === "function" ? deviceMatches : null;
    this.macStore = macStore;
    this.queryId = queryId;
    this.periodSequence = 0;
    this.previousMetric = "";
    this.snapshotDeviceCount = 0;
    this.current = null;
    this.previousMacs = null;
    this.everMacs = macStore ? null : new Set();
    this.rows = [];
  }

  async startSnapshot(snapshot = {}) {
    const key = temporalPeriodKey(snapshot.createdAt, this.period);
    if (this.current && this.current.period !== key) await this.#finishPeriod();
    if (!this.current) this.current = {
      period: key,
      metric: this.macStore ? `period-${this.periodSequence++}` : "",
      snapshotCount: 0,
      deviceTotal: 0,
      maxDevices: 0,
      latestDeviceCount: 0,
      macs: this.macStore ? null : new Set(),
      vendors: new Set(),
      rooms: new Set(),
      sources: new Set(),
      snapshots: [],
    };
    const deviceCount = this.deviceMatches ? 0 : Math.max(0, Number(snapshot.deviceCount || 0));
    this.current.snapshotCount += 1;
    this.current.deviceTotal += deviceCount;
    this.current.maxDevices = Math.max(this.current.maxDevices, deviceCount);
    this.current.latestDeviceCount = deviceCount;
    this.snapshotDeviceCount = 0;
    for (const source of snapshot.sourceFiles || []) {
      const name = text(typeof source === "string" ? source : source?.name);
      if (name) this.current.sources.add(name);
    }
    if (text(snapshot.source)) this.current.sources.add(text(snapshot.source));
    this.current.snapshots.push({
      id: text(snapshot.id),
      name: text(snapshot.name),
      createdAt: text(snapshot.createdAt),
      deviceCount,
      processingTimeMs: Math.max(0, Number(snapshot.processingTimeMs || 0)),
    });
  }

  async observeChunk(devices = []) {
    if (!this.current) throw new Error("Сначала начните обработку снимка");
    const macs = [];
    for (const device of devices) {
      if (this.deviceMatches && !this.deviceMatches(device)) continue;
      if (this.deviceMatches) this.snapshotDeviceCount += 1;
      const mac = firstMac(device.mac, device.macFormatted);
      if (mac) {
        if (this.macStore) macs.push(mac);
        else {
          this.current.macs.add(mac);
          this.everMacs.add(mac);
        }
      }
      const vendor = text(device.manufacturer || device.vendor);
      if (vendor) this.current.vendors.add(vendor.toLocaleLowerCase("ru-RU"));
      const room = text(device.smartroomId || device.room);
      if (room) this.current.rooms.add(room.toLocaleLowerCase("ru-RU"));
    }
    if (this.macStore) {
      await this.macStore.addAnalyticsDistinctBatch(this.queryId, this.current.metric, macs, "ever");
    }
  }

  endSnapshot() {
    if (!this.current || !this.deviceMatches) return;
    const count = this.snapshotDeviceCount;
    this.current.deviceTotal += count;
    this.current.maxDevices = Math.max(this.current.maxDevices, count);
    this.current.latestDeviceCount = count;
    const snapshot = this.current.snapshots.at(-1);
    if (snapshot) snapshot.deviceCount = count;
  }

  async #finishPeriod() {
    if (!this.current) return;
    let uniqueMacs;
    let added;
    let removed = 0;
    if (this.macStore) {
      uniqueMacs = await this.macStore.analyticsAggregateCount(this.queryId, this.current.metric);
      if (this.previousMetric) {
        const comparison = await this.macStore.compareAnalyticsDistinctMetrics(this.queryId, this.previousMetric, this.current.metric);
        added = comparison.added;
        removed = comparison.removed;
        await this.macStore.clearAnalyticsAggregateQuery(this.queryId, this.previousMetric);
      } else added = uniqueMacs;
      this.previousMetric = this.current.metric;
    } else {
      const macs = this.current.macs;
      uniqueMacs = macs.size;
      added = macs.size;
      if (this.previousMacs) {
        added = 0;
        for (const mac of macs) if (!this.previousMacs.has(mac)) added += 1;
        for (const mac of this.previousMacs) if (!macs.has(mac)) removed += 1;
      }
      this.previousMacs = macs;
    }
    this.rows.push({
      period: this.current.period,
      periodType: this.period,
      snapshotCount: this.current.snapshotCount,
      deviceTotal: this.current.deviceTotal,
      maxDevices: this.current.maxDevices,
      latestDeviceCount: this.current.latestDeviceCount,
      uniqueMacs,
      added,
      removed,
      vendors: this.current.vendors.size,
      rooms: this.current.rooms.size,
      sources: [...this.current.sources].sort((a, b) => a.localeCompare(b, "ru")),
      snapshots: this.current.snapshots,
    });
    this.current = null;
  }

  async finish() {
    await this.#finishPeriod();
    const uniqueMacs = this.macStore
      ? await this.macStore.analyticsAggregateCount(this.queryId, "ever")
      : this.everMacs.size;
    return {
      period: this.period,
      summary: {
        periods: this.rows.length,
        snapshots: this.rows.reduce((sum, row) => sum + row.snapshotCount, 0),
        uniqueMacs,
        deviceTotal: this.rows.reduce((sum, row) => sum + row.deviceTotal, 0),
        latestDeviceCount: this.rows.at(-1)?.latestDeviceCount || 0,
        maxDevices: this.rows.reduce((max, row) => Math.max(max, row.maxDevices), 0),
      },
      periods: this.rows.map((row) => ({ ...row, sources: [...row.sources], snapshots: [...row.snapshots] })),
    };
  }

  async cleanup() {
    if (this.macStore) await this.macStore.clearAnalyticsAggregateQuery(this.queryId);
  }
}

export function temporalStatisticsCsv(result) {
  const columns = [
    ["period", "Период"], ["periodType", "Шаг"], ["snapshotCount", "Число снимков"],
    ["deviceTotal", "Сумма устройств по снимкам"], ["maxDevices", "Максимум устройств"],
    ["uniqueMacs", "Уникальных MAC"], ["added", "Появились MAC"], ["removed", "Исчезли MAC"],
    ["vendors", "Производителей"], ["rooms", "Помещений"], ["sources", "Источники"], ["snapshots", "Снимки"],
  ];
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [columns.map(([, label]) => quote(label)).join(";"), ...result.periods.map((row) => columns.map(([field]) => {
    const value = Array.isArray(row[field]) ? row[field].map((item) => typeof item === "string" ? item : `${item.name || item.id} (${item.deviceCount}, ${item.processingTimeMs} ms)`).join(" | ") : row[field];
    return quote(value);
  }).join(";"))].join("\r\n");
}
