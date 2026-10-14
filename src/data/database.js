const DB_NAME = "mac-analyzer-pro-next";
const DB_VERSION = 1;
const CHUNK_SIZE = 500;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Ошибка IndexedDB"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Транзакция IndexedDB завершилась ошибкой"));
    transaction.onabort = () => reject(transaction.error || new Error("Транзакция IndexedDB отменена"));
  });
}

function serializable(value) {
  return JSON.parse(JSON.stringify(value));
}

export class Database {
  constructor(name = DB_NAME) {
    this.name = name;
    this.connection = null;
  }

  async open() {
    if (this.connection) return this.connection;
    const request = indexedDB.open(this.name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("snapshots")) {
        const store = db.createObjectStore("snapshots", { keyPath: "id" });
        store.createIndex("by_created", "createdAt");
      }
      if (!db.objectStoreNames.contains("snapshotChunks")) db.createObjectStore("snapshotChunks", { keyPath: ["snapshotId", "index"] });
      if (!db.objectStoreNames.contains("inventory")) {
        const store = db.createObjectStore("inventory", { keyPath: "id" });
        store.createIndex("by_mac", "mac", { unique: false });
        store.createIndex("by_smartroom", "smartroomId", { unique: false });
      }
      if (!db.objectStoreNames.contains("history")) {
        const store = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
        store.createIndex("by_snapshot", "snapshotId");
        store.createIndex("by_device", "deviceId");
        store.createIndex("by_timestamp", "timestamp");
      }
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("knownModels")) db.createObjectStore("knownModels", { keyPath: "mac" });
      if (!db.objectStoreNames.contains("oui")) db.createObjectStore("oui", { keyPath: "prefix" });
      if (!db.objectStoreNames.contains("archives")) db.createObjectStore("archives", { keyPath: "id" });
    };
    this.connection = await requestResult(request);
    this.connection.onversionchange = () => {
      this.connection.close();
      this.connection = null;
    };
    return this.connection;
  }

  async listSnapshots() {
    const db = await this.open();
    const tx = db.transaction("snapshots", "readonly");
    const records = await requestResult(tx.objectStore("snapshots").getAll());
    await transactionDone(tx);
    return records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async loadSnapshot(id) {
    const db = await this.open();
    const tx = db.transaction(["snapshots", "snapshotChunks"], "readonly");
    const metadata = await requestResult(tx.objectStore("snapshots").get(id));
    if (!metadata) {
      tx.abort();
      throw new Error("Final-снимок не найден");
    }
    const chunks = await requestResult(tx.objectStore("snapshotChunks").getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])));
    await transactionDone(tx);
    chunks.sort((a, b) => a.index - b.index);
    return { ...metadata, devices: chunks.flatMap((chunk) => chunk.devices) };
  }

  async loadSnapshots(ids = null) {
    const metadata = await this.listSnapshots();
    const selected = ids ? metadata.filter((item) => ids.includes(item.id)) : metadata;
    const result = [];
    for (const item of selected) result.push(await this.loadSnapshot(item.id));
    return result;
  }

  async activeSnapshot() {
    const id = await this.getSetting("activeSnapshotId", "");
    if (!id) return null;
    try {
      return await this.loadSnapshot(id);
    } catch {
      return null;
    }
  }

  async saveFinal({ id = crypto.randomUUID(), name, createdAt = new Date().toISOString(), devices, diagnostics = {}, comparison = null, sourceFiles = [] }) {
    const cleanDevices = serializable(devices);
    const existingInventory = new Map((await this.inventory()).map((item) => [item.id, item]));
    const db = await this.open();
    const stores = ["snapshots", "snapshotChunks", "inventory", "history", "settings", "knownModels"];
    const tx = db.transaction(stores, "readwrite", { durability: "strict" });
    const metadata = {
      id,
      name: name || `Final ${new Date(createdAt).toLocaleString("ru-RU")}`,
      createdAt,
      deviceCount: cleanDevices.length,
      chunkCount: Math.ceil(cleanDevices.length / CHUNK_SIZE),
      diagnostics: serializable(diagnostics),
      sourceFiles: serializable(sourceFiles),
      schemaVersion: 1,
    };
    tx.objectStore("snapshots").put(metadata);
    const chunkStore = tx.objectStore("snapshotChunks");
    for (let index = 0; index < cleanDevices.length; index += CHUNK_SIZE) {
      chunkStore.put({ snapshotId: id, index: index / CHUNK_SIZE, devices: cleanDevices.slice(index, index + CHUNK_SIZE) });
    }
    const inventory = tx.objectStore("inventory");
    const models = tx.objectStore("knownModels");
    for (const device of cleanDevices) {
      const previous = existingInventory.get(device.id);
      inventory.put({
        ...(previous || {}),
        ...device,
        firstSeen: previous?.firstSeen || createdAt,
        lastSeen: createdAt,
        present: true,
        snapshotId: id,
      });
      if (device.mac && device.model) models.put({ mac: device.mac, model: device.model, updatedAt: createdAt });
    }
    if (comparison) {
      const history = tx.objectStore("history");
      for (const row of comparison.modified || []) {
        for (const change of row.changes || []) history.add({ snapshotId: id, deviceId: row.after.id, mac: row.after.mac, type: "modified", ...change });
      }
      for (const device of comparison.added || []) history.add({ snapshotId: id, deviceId: device.id, mac: device.mac, type: "added", timestamp: createdAt });
      for (const device of comparison.absent || []) {
        history.add({ snapshotId: id, deviceId: device.id, mac: device.mac, type: "absent", timestamp: createdAt });
        const previous = existingInventory.get(device.id);
        if (previous) inventory.put({ ...previous, present: false, lastMissing: createdAt });
      }
    }
    tx.objectStore("settings").put({ key: "activeSnapshotId", value: id });
    tx.objectStore("settings").put({ key: "analyticsRevision", value: Date.now() });
    try {
      await transactionDone(tx);
      return metadata;
    } catch (error) {
      try { tx.abort(); } catch {}
      throw new Error(`Final не сохранён, предыдущий снимок не изменён: ${error.message}`);
    }
  }

  async inventory() {
    const db = await this.open();
    const tx = db.transaction("inventory", "readonly");
    const result = await requestResult(tx.objectStore("inventory").getAll());
    await transactionDone(tx);
    return result;
  }

  async history(deviceId = "") {
    const db = await this.open();
    const tx = db.transaction("history", "readonly");
    const store = tx.objectStore("history");
    const result = deviceId
      ? await requestResult(store.index("by_device").getAll(deviceId))
      : await requestResult(store.getAll());
    await transactionDone(tx);
    return result.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  }

  async getSetting(key, fallback = null) {
    const db = await this.open();
    const tx = db.transaction("settings", "readonly");
    const record = await requestResult(tx.objectStore("settings").get(key));
    await transactionDone(tx);
    return record?.value ?? fallback;
  }

  async setSetting(key, value) {
    const db = await this.open();
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key, value: serializable(value) });
    await transactionDone(tx);
  }

  async knownModels() {
    const db = await this.open();
    const tx = db.transaction("knownModels", "readonly");
    const records = await requestResult(tx.objectStore("knownModels").getAll());
    await transactionDone(tx);
    return new Map(records.map((item) => [item.mac, item.model]));
  }

  async importOui(records) {
    const db = await this.open();
    const tx = db.transaction("oui", "readwrite");
    const store = tx.objectStore("oui");
    for (const record of records) if (record.prefix && record.vendor) store.put(record);
    await transactionDone(tx);
    return records.length;
  }

  async ouiIndex() {
    const db = await this.open();
    const tx = db.transaction("oui", "readonly");
    const records = await requestResult(tx.objectStore("oui").getAll());
    await transactionDone(tx);
    return new Map(records.map((item) => [item.prefix, item.vendor]));
  }

  async exportArchive() {
    const [snapshots, inventory, history, settings, knownModels, oui] = await Promise.all([
      this.loadSnapshots(),
      this.inventory(),
      this.history(),
      this.#all("settings"),
      this.#all("knownModels"),
      this.#all("oui"),
    ]);
    return { format: "MAC_ANALYZER_NEXT_ARCHIVE", version: 1, exportedAt: new Date().toISOString(), snapshots, inventory, history, settings, knownModels, oui };
  }

  async importArchive(archive) {
    if (archive?.format !== "MAC_ANALYZER_NEXT_ARCHIVE" || archive.version !== 1) throw new Error("Неподдерживаемый формат архива");
    for (const snapshot of archive.snapshots || []) {
      const existing = (await this.listSnapshots()).some((item) => item.id === snapshot.id);
      if (!existing) await this.saveFinal({ ...snapshot, comparison: null });
    }
    const db = await this.open();
    const tx = db.transaction(["inventory", "history", "settings", "knownModels", "oui"], "readwrite");
    for (const item of archive.inventory || []) tx.objectStore("inventory").put(item);
    for (const item of archive.history || []) tx.objectStore("history").put(item);
    for (const item of archive.settings || []) tx.objectStore("settings").put(item);
    for (const item of archive.knownModels || []) tx.objectStore("knownModels").put(item);
    for (const item of archive.oui || []) tx.objectStore("oui").put(item);
    await transactionDone(tx);
  }

  async #all(storeName) {
    const db = await this.open();
    const tx = db.transaction(storeName, "readonly");
    const result = await requestResult(tx.objectStore(storeName).getAll());
    await transactionDone(tx);
    return result;
  }
}

export const database = new Database();

