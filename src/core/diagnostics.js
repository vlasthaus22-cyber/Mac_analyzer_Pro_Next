import { isFinalSnapshot } from "./snapshot-kind.js";

const REQUIRED_STORES = Object.freeze([
  "snapshots", "snapshotChunks", "inventory", "history", "settings", "fileHandles",
  "originalFiles", "knownModels", "mac5Models", "oui", "archives", "archiveRecords",
  "analyticsCache", "finalAnalytics", "finalAnalyticsMetadata", "smartroomRoomMappings",
  "switchAddressEvidence", "singleAnalyses", "singleAnalysisChunks", "dataQualityReports", "legacySmartroomRoomMappings", "legacyObservationQueryScratch",
]);
const REQUIRED_INDEXES = Object.freeze({
  snapshots: ["by_created", "by_source_key"],
  inventory: ["by_mac", "by_smartroom", "by_switch", "by_alternate_mac", "by_sort_mac", "by_device_id", "by_serial_identity", "by_device_id_normalized", "by_serial_normalized"],
  history: ["by_snapshot", "by_device", "by_timestamp", "by_device_timestamp"],
  archiveRecords: ["by_archive", "by_archive_collection"],
  finalAnalytics: ["by_snapshot"],
  smartroomRoomMappings: ["by_snapshot"],
  switchAddressEvidence: ["by_switch", "by_snapshot"],
  singleAnalyses: ["by_processed_at", "by_filename"],
  dataQualityReports: ["by_created", "by_snapshot_created"],
  legacySmartroomRoomMappings: ["by_updated_at"],
  legacyObservationQueryScratch: ["by_query_metric_count", "by_query_metric_rank"],
});

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function check(checks, id, title, status, detail) {
  checks.push({ id, title, status, detail });
}

export async function runBrowserDiagnostics({ database, directoryPermission = "unavailable", storage = globalThis.navigator?.storage, onProgress = () => {} }) {
  const checks = [];
  let db;
  try {
    db = await database.open();
  } catch (error) {
    check(checks, "indexeddb", "IndexedDB доступна", "error", error.message);
    check(checks, "backend", "Backend / SQLite", "info", "В автономной browser-only сборке backend и SQLite не входят в состав.");
    return { checks, passed: 0, errors: 1, warnings: 0 };
  }

  const storeNames = new Set(Array.from(db.objectStoreNames));
  const missingStores = REQUIRED_STORES.filter((name) => !storeNames.has(name));
    check(checks, "stores", "Структура базы", missingStores.length ? "error" : "ok", missingStores.length ? `Нет хранилищ: ${missingStores.join(", ")}` : `Версия схемы ${db.version}; присутствуют все ${REQUIRED_STORES.length} хранилищ Final, Inventory, анализа, импорта, аналитики и переноса.`);

  if (!missingStores.length) {
    try {
      const tx = db.transaction(Object.keys(REQUIRED_INDEXES), "readonly");
      const missingIndexes = [];
      for (const [storeName, indexes] of Object.entries(REQUIRED_INDEXES)) {
        const available = tx.objectStore(storeName).indexNames;
        for (const indexName of indexes) if (!available.contains(indexName)) missingIndexes.push(`${storeName}.${indexName}`);
      }
      await transactionDone(tx);
      check(checks, "indexes", "Индексы базы", missingIndexes.length ? "error" : "ok", missingIndexes.length ? `Нет индексов: ${missingIndexes.join(", ")}` : "Ключевые индексы Final, сильной идентичности Inventory, History, анализа, архивов, аналитики и evidence на месте.");
    } catch (error) {
      check(checks, "indexes", "Индексы базы", "error", error.message);
    }
  } else check(checks, "indexes", "Индексы базы", "info", "Проверка индексов пропущена: отсутствует часть хранилищ.");

  try {
    const snapshots = await database.listSnapshots();
    const activeId = await database.getSetting("activeSnapshotId", "");
    const finalSnapshots = snapshots.filter(isFinalSnapshot);
    let devicesChecked = 0;
    let corruptCount = 0;
    const corruptExamples = [];
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];
      try {
        await database.forEachSnapshotChunk(snapshot.id, (chunk) => { devicesChecked += chunk.length; });
      } catch (error) {
        corruptCount += 1;
        if (corruptExamples.length < 5) corruptExamples.push(`${snapshot.name || snapshot.id}: ${error.message}`);
      }
      onProgress({ completed: index + 1, total: snapshots.length, snapshot: snapshot.name || snapshot.id });
    }
    const activeFinal = activeId ? finalSnapshots.find((snapshot) => snapshot.id === activeId) : null;
    const activeValid = activeId ? Boolean(activeFinal) : finalSnapshots.length === 0;
    const activeDetail = activeValid
      ? (activeId ? `Указатель связан с Final: ${activeId}.` : "Final пока не сохранён.")
      : (activeId ? `Указатель ${activeId} не связан с сохранённым Final.` : `Сохранено Final: ${finalSnapshots.length.toLocaleString("ru-RU")}, но активный указатель отсутствует.`);
    check(checks, "active-final", "Активный Final", activeValid ? "ok" : "error", activeDetail);
    check(checks, "final-integrity", "Целостность Final", corruptCount ? "error" : "ok", corruptCount ? `Повреждены ${corruptCount} снимка: ${corruptExamples.join("; ")}` : `${snapshots.length} снимков проверено; целыми чанками прочитано ${devicesChecked.toLocaleString("ru-RU")} устройств.`);
  } catch (error) {
    check(checks, "final-integrity", "Целостность Final", "error", error.message);
  }

  try {
    let afterId = "";
    let analysesChecked = 0;
    let analysisDevicesChecked = 0;
    let corrupted = 0;
    const examples = [];
    let total = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await database.singleAnalysisMetadataPage({ afterId, limit: 100 });
      total = page.total;
      for (const metadata of page.rows) {
        analysesChecked += 1;
        try {
          await database.forEachSingleAnalysisChunk(metadata.id, (chunk) => {
            analysisDevicesChecked += chunk.devices.length;
          });
        } catch (error) {
          corrupted += 1;
          if (examples.length < 5) examples.push(String(metadata.filename || metadata.id) + ": " + error.message);
        }
      }
      hasMore = page.hasMore;
      if (!hasMore) continue;
      if (!page.nextCursor || page.nextCursor === afterId) throw new Error("Страница анализов не продвинула курсор");
      afterId = page.nextCursor;
    }
    check(
      checks,
      "single-analysis-integrity",
      "Целостность анализов файлов",
      corrupted ? "error" : "ok",
      corrupted
        ? "Повреждены " + corrupted + " из " + total + " анализов: " + examples.join("; ")
        : analysesChecked.toLocaleString("ru-RU") + " анализов проверено; потоково прочитано " + analysisDevicesChecked.toLocaleString("ru-RU") + " устройств.",
    );
  } catch (error) {
    check(checks, "single-analysis-integrity", "Целостность анализов файлов", "error", error.message);
  }

  try {
    const tx = db.transaction(["inventory", "history"], "readonly");
    const done = transactionDone(tx);
    const [inventory, history] = await Promise.all([
      requestResult(tx.objectStore("inventory").count()),
      requestResult(tx.objectStore("history").count()),
    ]);
    await done;
    check(checks, "record-counts", "Inventory и History", "ok", `Inventory: ${inventory.toLocaleString("ru-RU")} · History: ${history.toLocaleString("ru-RU")}.`);
  } catch (error) {
    check(checks, "record-counts", "Inventory и History", "error", error.message);
  }

  if (directoryPermission === "granted") check(checks, "directory", "Папка данных", "ok", "Браузерное разрешение на чтение и запись действует.");
  else if (directoryPermission === "prompt") check(checks, "directory", "Папка данных", "warning", "Браузер просит повторную авторизацию папки.");
  else if (directoryPermission === "denied") check(checks, "directory", "Папка данных", "warning", "Доступ к папке не предоставлен; можно продолжать с IndexedDB и MADB.");
  else check(checks, "directory", "Папка данных", "info", "File System Access не подключён; доступен перенос через MADB.");

  try {
    if (typeof storage?.estimate !== "function") check(checks, "quota", "Квота браузерного хранилища", "info", "Браузер не сообщает оценку занятого места и квоты.");
    else {
      const estimate = await storage.estimate();
      const usage = Number(estimate.usage || 0);
      const quota = Number(estimate.quota || 0);
      const ratio = quota > 0 ? usage / quota : 0;
      const status = ratio >= 0.9 ? "warning" : "ok";
      const detail = quota > 0
        ? `Использовано ${(usage / 1024 ** 2).toFixed(1)} МиБ из ${(quota / 1024 ** 2).toFixed(1)} МиБ (${Math.round(ratio * 100)}%).`
        : "Браузер не вернул размер квоты.";
      check(checks, "quota", "Квота браузерного хранилища", status, detail);
    }
  } catch (error) {
    check(checks, "quota", "Квота браузерного хранилища", "warning", `Оценка квоты недоступна: ${error.message}`);
  }

  check(checks, "backend", "Backend / SQLite / REST API", "info", "В автономной browser-only сборке backend, SQLite и REST API не входят в состав.");
  return {
    checks,
    passed: checks.filter((item) => item.status === "ok").length,
    errors: checks.filter((item) => item.status === "error").length,
    warnings: checks.filter((item) => item.status === "warning").length,
  };
}
