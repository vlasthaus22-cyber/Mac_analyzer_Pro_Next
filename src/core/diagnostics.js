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

async function probeIndexedDbWriteAccess(db) {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const key = `__diagnostics_write_probe__:${token}`;
  await new Promise((resolve, reject) => {
    let transaction;
    let request;
    let writeAccepted = false;
    try {
      transaction = db.transaction("settings", "readwrite");
      transaction.oncomplete = () => reject(new Error("Проверочная транзакция неожиданно зафиксирована"));
      transaction.onerror = () => {};
      transaction.onabort = () => {
        if (writeAccepted) resolve();
        else reject(transaction.error || request?.error || new Error("Проверочная запись отклонена"));
      };
      request = transaction.objectStore("settings").add({ key, value: "temporary-diagnostic-probe" });
      request.onsuccess = () => {
        writeAccepted = true;
        transaction.abort();
      };
      request.onerror = () => {};
    } catch (error) {
      reject(error);
    }
  });
  const verify = db.transaction("settings", "readonly");
  const done = transactionDone(verify);
  const persisted = await requestResult(verify.objectStore("settings").get(key));
  await done;
  if (persisted) throw new Error("Проверочная запись сохранилась после отмены");
}

function check(checks, id, title, status, detail) {
  checks.push({ id, title, status, detail });
}

function boundedDiagnosticExample(label, error) {
  const example = `${label || "Запись"}: ${error?.message || String(error)}`;
  return example.length > 300 ? `${example.slice(0, 299)}…` : example;
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

  if (storeNames.has("settings")) {
    try {
      await probeIndexedDbWriteAccess(db);
      check(checks, "write-access", "Запись в IndexedDB", "ok", "Тестовая запись принята, транзакция отменена; в базе не осталось диагностических данных.");
    } catch (error) {
      check(checks, "write-access", "Запись в IndexedDB", "error", `Проверочная запись не сохранена: ${error?.name || "ошибка"}.`);
    }
  } else check(checks, "write-access", "Запись в IndexedDB", "info", "Проверка недоступна: хранилище настроек отсутствует.");

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
    let afterId = "";
    let total = 0;
    let checked = 0;
    const activeId = await database.getSetting("activeSnapshotId", "");
    let finalSnapshotCount = 0;
    let activeFinalFound = false;
    let devicesChecked = 0;
    let corruptCount = 0;
    const corruptExamples = [];
    let hasMore = true;
    while (hasMore) {
      const page = await database.snapshotMetadataPage({ afterId, limit: 100 });
      if (!Array.isArray(page?.rows) || !Number.isSafeInteger(page.total) || page.total < 0 || typeof page.hasMore !== "boolean") {
        throw new Error("Страница метаданных Final имеет неверный формат");
      }
      total = page.total;
      for (const snapshot of page.rows) {
        checked += 1;
        if (isFinalSnapshot(snapshot)) {
          finalSnapshotCount += 1;
          if (String(snapshot.id) === String(activeId)) activeFinalFound = true;
        }
        try {
          await database.forEachSnapshotChunk(snapshot.id, (chunk) => { devicesChecked += chunk.length; });
        } catch (error) {
          corruptCount += 1;
          if (corruptExamples.length < 5) {
            corruptExamples.push(boundedDiagnosticExample(snapshot.name || snapshot.id, error));
          }
        }
        onProgress({ completed: checked, total, snapshot: snapshot.name || snapshot.id });
      }
      hasMore = page.hasMore;
      if (!hasMore) continue;
      if (!page.nextCursor || page.nextCursor === afterId) throw new Error("Страница метаданных Final не продвинула курсор");
      afterId = page.nextCursor;
    }
    const activeValid = activeId ? activeFinalFound : finalSnapshotCount === 0;
    const activeDetail = activeValid
      ? (activeId ? `Указатель связан с Final: ${activeId}.` : "Final пока не сохранён.")
      : (activeId ? `Указатель ${activeId} не связан с сохранённым Final.` : `Сохранено Final: ${finalSnapshotCount.toLocaleString("ru-RU")}, но активный указатель отсутствует.`);
    check(checks, "active-final", "Активный Final", activeValid ? "ok" : "error", activeDetail);
    check(checks, "final-integrity", "Целостность Final", corruptCount ? "error" : "ok", corruptCount ? `Повреждены ${corruptCount} снимка: ${corruptExamples.join("; ")}` : `${checked} снимков проверено; целыми чанками прочитано ${devicesChecked.toLocaleString("ru-RU")} устройств.`);
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
          if (examples.length < 5) examples.push(boundedDiagnosticExample(metadata.filename || metadata.id, error));
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
