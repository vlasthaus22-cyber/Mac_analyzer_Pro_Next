export const IMPORT_LIMITS = Object.freeze({
  sourceFileBytes: 64 * 1024 * 1024,
  legacyXlsFileBytes: 16 * 1024 * 1024,
  rowCount: 150_000,
  xlsxRowCharacters: 4 * 1024 * 1024,
  cellCount: 1_500_000,
  zipEntryCount: 10_000,
  zipDirectoryBytes: 16 * 1024 * 1024,
  expandedZipBytes: 192 * 1024 * 1024,
  expandedEntryBytes: 128 * 1024 * 1024,
  sharedStringCount: 500_000,
  sharedStringBytes: 64 * 1024 * 1024,
});

const MINIMUM_HEAP_RESERVE_BYTES = 64 * 1024 * 1024;

export function assertBrowserHeapReserve(memoryInfo = globalThis.performance?.memory) {
  const heapLimit = Number(memoryInfo?.jsHeapSizeLimit);
  const heapUsed = Number(memoryInfo?.usedJSHeapSize);
  if (!Number.isFinite(heapLimit) || heapLimit <= 0 || !Number.isFinite(heapUsed) || heapUsed < 0) return { checked: false };
  const availableBytes = Math.max(0, heapLimit - heapUsed);
  const reserveBytes = Math.max(MINIMUM_HEAP_RESERVE_BYTES, heapLimit * 0.1);
  if (availableBytes < reserveBytes) {
    const error = new Error("В ходе обработки свободная память JavaScript опустилась ниже обязательного резерва " + reserveBytes.toLocaleString("ru-RU") + " байт. Закройте другие вкладки или разделите данные и повторите операцию.");
    error.code = "BROWSER_HEAP_RESERVE";
    error.actual = availableBytes;
    error.maximum = reserveBytes;
    error.heapLimit = heapLimit;
    error.heapUsed = heapUsed;
    throw error;
  }
  return { checked: true, availableBytes, reserveBytes };
}

export function assertBrowserHeapCapacity(estimatedAdditionalBytes, memoryInfo = globalThis.performance?.memory) {
  const estimate = Math.max(0, Number(estimatedAdditionalBytes) || 0);
  const heapLimit = Number(memoryInfo?.jsHeapSizeLimit);
  const heapUsed = Number(memoryInfo?.usedJSHeapSize);
  if (!Number.isFinite(heapLimit) || heapLimit <= 0 || !Number.isFinite(heapUsed) || heapUsed < 0) {
    return { checked: false, estimatedBytes: estimate };
  }
  const availableBytes = Math.max(0, heapLimit - heapUsed);
  const reserveBytes = Math.max(MINIMUM_HEAP_RESERVE_BYTES, heapLimit * 0.1);
  const safeAvailableBytes = Math.max(0, availableBytes - reserveBytes);
  if (estimate > safeAvailableBytes) {
    const error = new Error(`Недостаточно доступной памяти JavaScript: безопасная оценка требует ${estimate.toLocaleString("ru-RU")} байт, после резерва доступно ${safeAvailableBytes.toLocaleString("ru-RU")} байт. Закройте другие вкладки или разделите импорт.`);
    error.code = "BROWSER_HEAP_LIMIT";
    error.actual = estimate;
    error.maximum = safeAvailableBytes;
    error.heapLimit = heapLimit;
    error.heapUsed = heapUsed;
    throw error;
  }
  return { checked: true, estimatedBytes: estimate, safeAvailableBytes };
}

function limitError(kind, actual, maximum) {
  const formatCount = (value) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("ru-RU") : String(value);
  const error = new Error(`${kind}: предел автономного браузерного импорта ${formatCount(maximum)}, получено ${formatCount(actual)}. Разделите файл на части.`);
  error.code = "IMPORT_CAPACITY_LIMIT";
  error.actual = actual;
  error.maximum = maximum;
  return error;
}

export function assertSourceFileCapacity(file, maximum = IMPORT_LIMITS.sourceFileBytes) {
  const actual = Math.max(0, Number(file?.size || 0));
  if (actual > maximum) throw limitError("Слишком большой файл", actual, maximum);
  return actual;
}

export function assertFilePairCapacity(files, memoryInfo = globalThis.performance?.memory) {
  if (!Array.isArray(files) || files.length !== 2) throw new TypeError("Для сравнения нужны ровно два файла");
  const totalSourceBytes = files.reduce((total, file) => total + assertSourceFileCapacity(file), 0);
  const heap = assertBrowserHeapCapacity(totalSourceBytes * 2, memoryInfo);
  return { totalSourceBytes, estimatedAdditionalBytes: heap.estimatedBytes, heapChecked: heap.checked };
}

export function assertTableCapacity(rowCount, cellCount, limits = IMPORT_LIMITS) {
  if (rowCount > limits.rowCount) throw limitError("Слишком много строк", rowCount, limits.rowCount);
  if (cellCount > limits.cellCount) throw limitError("Слишком много ячеек", cellCount, limits.cellCount);
  return { rowCount, cellCount };
}

export function assertZipDirectoryHeaderCapacity(entryCount, directoryBytes, limits = IMPORT_LIMITS) {
  if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > limits.zipEntryCount) {
    throw limitError("Слишком много частей XLSX", entryCount, limits.zipEntryCount);
  }
  if (!Number.isSafeInteger(directoryBytes) || directoryBytes < 0 || directoryBytes > limits.zipDirectoryBytes) {
    throw limitError("Слишком большой каталог XLSX", directoryBytes, limits.zipDirectoryBytes);
  }
  return { entryCount, directoryBytes };
}

export function assertZipDirectoryCapacity(entries, limits = IMPORT_LIMITS, memoryInfo = globalThis.performance?.memory) {
  const entryCount = entries instanceof Map ? entries.size : Array.isArray(entries) ? entries.length : 0;
  const values = entries instanceof Map ? entries.values() : Array.isArray(entries) ? entries : [];
  if (entryCount > limits.zipEntryCount) throw limitError("Слишком много частей XLSX", entryCount, limits.zipEntryCount);
  let expandedBytes = 0;
  for (const entry of values) {
    const size = entry?.uncompressed;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw limitError(`Некорректный размер части XLSX (${entry?.name || "unknown"})`, size, limits.expandedEntryBytes);
    }
    if (size > limits.expandedEntryBytes) throw limitError(`Слишком большая часть XLSX (${entry?.name || "unknown"})`, size, limits.expandedEntryBytes);
    expandedBytes += size;
  }
  if (expandedBytes > limits.expandedZipBytes) throw limitError("Слишком большой распакованный XLSX", expandedBytes, limits.expandedZipBytes);
  assertBrowserHeapCapacity(expandedBytes * 2, memoryInfo);
  return { entryCount, expandedBytes };
}

export function assertSharedStringCapacity(count, bytes, limits = IMPORT_LIMITS) {
  if (count > limits.sharedStringCount) throw limitError("Слишком много общих строк XLSX", count, limits.sharedStringCount);
  if (bytes > limits.sharedStringBytes) throw limitError("Слишком большой раздел общих строк XLSX", bytes, limits.sharedStringBytes);
  return { count, bytes };
}
