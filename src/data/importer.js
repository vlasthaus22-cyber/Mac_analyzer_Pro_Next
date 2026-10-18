import { keyText, normalizeDate, normalizeIp, normalizeMac, normalizeDevice, text } from "../core/normalize.js";
import { stableId } from "../core/identity.js";
import { assertSharedStringCapacity, assertSourceFileCapacity, assertTableCapacity, assertZipDirectoryCapacity, IMPORT_LIMITS } from "../core/import-limits.js";

export const FIELD_LABELS = Object.freeze({
  id: "Внутренний ID",
  mac: "MAC",
  mac2: "Дополнительный MAC",
  ip: "IP устройства",
  switchIp: "IP коммутатора",
  switchPort: "Порт коммутатора",
  smartroomId: "Smartroom ID",
  locationPath: "Полный путь помещения",
  businessUnit: "ТБ",
  city: "Город",
  site: "Площадка",
  floor: "Этаж",
  room: "Помещение",
  address: "Адрес",
  physicalAddress: "Физический адрес",
  manufacturer: "Производитель",
  model: "Модель",
  deviceType: "Тип устройства",
  hostname: "Hostname",
  serial: "Серийный номер",
  deviceId: "Device ID",
  deviceName: "Название устройства",
  authenticationTime: "Время аутентификации",
  reservationMac: "MAC резервации",
  reservationIp: "IP резервации",
  leaseMac: "MAC аренды",
  leaseIp: "IP аренды",
});

const ALIASES = Object.freeze({
  id: ["internal id", "internalid", "внутренний id", "внутренний идентификатор"],
  mac: ["callingstationid", "calling station id", "callingstarionid", "mac", "mac address", "мак", "mac-адрес"],
  mac2: ["mac 2", "mac2", "mac-адрес 2", "mac дополнительного интерфейса", "secondary mac", "дополнительный mac", "mac второго интерфейса"],
  ip: ["ip", "ip address", "ip адрес", "ip-адрес", "ip устройства"],
  switchIp: ["nasip", "nas ip", "ip switch", "ip коммутатора", "коммутатор"],
  switchPort: ["nasportid", "nas port id", "port", "порт", "порт коммутатора"],
  smartroomId: ["smartroom id", "smartroom id локации", "id комнаты", "id помещения"],
  locationPath: ["location path", "locationpath", "путь локации", "путь помещения", "иерархия помещения"],
  businessUnit: ["тб", "территориальный банк", "business unit"],
  city: ["город", "city"],
  site: ["площадка", "site", "локация"],
  floor: ["этаж", "floor"],
  room: ["помещение", "название комнаты", "наименование локации", "room"],
  address: ["адрес", "адрес локации", "адрес комнаты", "address"],
  physicalAddress: ["физический адрес", "physical address"],
  manufacturer: ["производитель", "vendor", "manufacturer"],
  model: ["модель", "model"],
  deviceType: ["тип модели", "тип устройства", "тип", "device type"],
  hostname: ["hostname", "host name", "имя хоста"],
  serial: ["serial", "serial number", "серийный номер"],
  deviceId: ["device id", "deviceid", "идентификатор устройства", "id устройства"],
  deviceName: ["device name", "название устройства", "наименование устройства"],
  authenticationTime: ["b_receipttime", "receipt time", "время аутентификации устройства", "время аутентификации"],
  reservationMac: ["column3", "mac резервации", "reservation mac"],
  reservationIp: ["column2", "ip резервации", "reservation ip"],
  leaseMac: ["column10", "mac аренды", "lease mac"],
  leaseIp: ["column9", "ip аренды", "lease ip"],
});

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function detectDelimiter(sample, name = "") {
  const preferred = /\.tsv$/i.test(name) ? "\t" : "";
  const records = [];
  let counts = Object.fromEntries([";", ",", "\t", "|"].map((delimiter) => [delimiter, 0]));
  let quoted = false;
  let quotePending = false;
  let hasContent = false;
  for (const char of String(sample)) {
    if (quoted) {
      if (quotePending) {
        if (char === '"') { quotePending = false; hasContent = true; continue; }
        quoted = false;
        quotePending = false;
      } else {
        if (char === '"') quotePending = true;
        else hasContent = true;
        continue;
      }
    }
    if (char === '"') { quoted = true; hasContent = true; }
    else if (char === "\r" || char === "\n") {
      if (hasContent || Object.values(counts).some(Boolean)) records.push(counts);
      counts = Object.fromEntries([";", ",", "\t", "|"].map((delimiter) => [delimiter, 0]));
      hasContent = false;
    } else {
      if (Object.hasOwn(counts, char)) counts[char] += 1;
      if (!/\s/.test(char)) hasContent = true;
    }
  }
  if (hasContent || Object.values(counts).some(Boolean)) records.push(counts);
  const candidates = [";", ",", "\t", "|"];
  const scored = candidates.map((delimiter) => {
    const frequencies = new Map();
    for (const record of records) {
      if (record[delimiter] > 0) frequencies.set(record[delimiter], (frequencies.get(record[delimiter]) || 0) + 1);
    }
    const consistentRows = Math.max(0, ...frequencies.values());
    const fields = Math.max(0, ...frequencies.keys());
    return { delimiter, consistentRows, fields, total: records.reduce((sum, record) => sum + record[delimiter], 0) };
  });
  const best = scored.sort((a, b) => b.consistentRows - a.consistentRows || b.fields - a.fields || b.total - a.total
    || Number(b.delimiter === preferred) - Number(a.delimiter === preferred))[0];
  if (best.consistentRows > 0) return best.delimiter;
  if (preferred) return preferred;
  return ";";
}

export function parseDelimited(source, delimiter = ",", limits = {}) {
  const maxRows = Math.max(1, Number(limits.maxRows || 150_000));
  const maxCells = Math.max(1, Number(limits.maxCells || 1_500_000));
  const truncate = Boolean(limits.truncate);
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  let cells = 0;
  let truncated = false;
  const addCell = () => {
    if (truncated) { value = ""; row = []; return; }
    cells += 1;
    if (cells > maxCells) throw new Error(`Слишком много ячеек: предел ${maxCells.toLocaleString("ru-RU")}`);
    row.push(value);
    value = "";
  };
  const addRow = () => {
    if (truncated) { row = []; return; }
    if (!row.some((cell) => text(cell))) return;
    if (rows.length >= maxRows) {
      if (!truncate) throw new Error(`Слишком много строк: предел ${maxRows.toLocaleString("ru-RU")}`);
      truncated = true;
      row = [];
      value = "";
      return;
    }
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      addCell();
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      addCell();
      addRow();
    } else if (!truncated) value += char;
  }
  addCell();
  addRow();
  assertTableCapacity(rows.length, cells);
  if (truncated) rows.truncated = true;
  return rows;
}

function decodeLatin1(bytes) {
  const chunks = [];
  const chunkSize = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(bytes.length, offset + chunkSize);
    let value = "";
    for (let index = offset; index < end; index += 1) value += String.fromCharCode(bytes[index]);
    chunks.push(value);
  }
  return chunks.join("");
}

function textDecoder(encoding) {
  if (encoding !== "latin1") return new TextDecoder(encoding);
  return {
    decode(input = new Uint8Array()) {
      return decodeLatin1(new Uint8Array(input));
    },
  };
}

export function decodeTextBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "";
  if (encoding) return new TextDecoder(encoding).decode(buffer).replace(/\0/g, "");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    // Python's cp1251 codec rejects byte 0x98; WHATWG TextDecoder maps it to U+0098.
    if (!bytes.includes(0x98)) return new TextDecoder("windows-1251", { fatal: true }).decode(buffer);
    return decodeLatin1(bytes);
  }
}

async function readTextFile(file) {
  return decodeTextBuffer(await file.arrayBuffer());
}

async function* fileByteChunks(file, chunkBytes = 64 * 1024, signal) {
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    yield new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkBytes)).arrayBuffer());
  }
}

async function delimitedTextEncoding(file, signal) {
  const first = new Uint8Array(await file.slice(0, Math.min(file.size, 64 * 1024)).arrayBuffer());
  if (first[0] === 0xff && first[1] === 0xfe) return { encoding: "utf-16le", sample: new TextDecoder("utf-16le").decode(first) };
  if (first[0] === 0xfe && first[1] === 0xff) return { encoding: "utf-16be", sample: new TextDecoder("utf-16be").decode(first) };
  const sample = new TextDecoder("utf-8").decode(first);
  const validator = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of fileByteChunks(file, 64 * 1024, signal)) validator.decode(chunk, { stream: true });
    validator.decode();
    return { encoding: "utf-8", sample };
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  try {
    for await (const chunk of fileByteChunks(file, 64 * 1024, signal)) {
      // Python's cp1251 codec rejects byte 0x98; WHATWG TextDecoder maps it to U+0098.
      if (chunk.includes(0x98)) throw new Error("Undefined Windows-1251 byte");
    }
    return { encoding: "windows-1251", sample: new TextDecoder("windows-1251").decode(first) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { encoding: "latin1", sample: decodeLatin1(first) };
  }
}

async function* delimitedRowBatches(file, { batchSize = 500, signal, onHeaders = () => {}, onProgress = () => {} } = {}) {
  const { encoding, sample } = await delimitedTextEncoding(file, signal);
  const delimiter = detectDelimiter(sample, file.name);
  const decoder = textDecoder(encoding);
  let headers = null;
  let row = [];
  let value = "";
  let quoted = false;
  let quotePending = false;
  let skipLf = false;
  let cells = 0;
  let rowsRead = 0;
  let batch = [];
  let ready = null;
  const addCell = () => {
    cells += 1;
    if (cells > IMPORT_LIMITS.cellCount) throw new Error(`Слишком много ячеек: предел ${IMPORT_LIMITS.cellCount.toLocaleString("ru-RU")}`);
    row.push(value);
    value = "";
  };
  const addRow = () => {
    if (!row.some((cell) => text(cell))) { row = []; return; }
    if (!headers) {
      headers = row.map(text);
      assertTableCapacity(0, cells);
      onHeaders({ headers, sheet: "", workbookCreatedAt: "", workbookModifiedAt: "" });
    } else {
      rowsRead += 1;
      assertTableCapacity(rowsRead + 1, cells);
      batch.push(row);
      if (batch.length >= batchSize) {
        ready = batch;
        batch = [];
        onProgress({ rowsRead, batchSize: ready.length });
      }
    }
    row = [];
  };
  const consume = function* (chunk) {
    for (const char of chunk) {
      if (quoted) {
        if (quotePending) {
          if (char === '"') { value += '"'; quotePending = false; continue; }
          quoted = false;
          quotePending = false;
        } else {
          if (char === '"') quotePending = true;
          else value += char;
          continue;
        }
      }
      if (skipLf) {
        skipLf = false;
        if (char === "\n") continue;
      }
      if (char === '"') quoted = true;
      else if (char === delimiter) addCell();
      else if (char === "\r" || char === "\n") {
        addCell();
        addRow();
        skipLf = char === "\r";
        if (ready) { yield ready; ready = null; }
      } else value += char;
    }
  };
  for await (const bytes of fileByteChunks(file, 64 * 1024, signal)) {
    for (const batchRows of consume(decoder.decode(bytes, { stream: true }))) yield batchRows;
  }
  for (const batchRows of consume(decoder.decode())) yield batchRows;
  if (quotePending) { quoted = false; quotePending = false; }
  addCell();
  addRow();
  if (ready) {
    yield ready;
    ready = null;
  }
  if (!headers) throw new Error("Файл не содержит строк");
  if (rowsRead === 0) throw new Error("Файл не содержит строк данных");
  if (batch.length) {
    onProgress({ rowsRead, batchSize: batch.length });
    yield batch;
  }
}

async function* jsonTokens(file, encoding, signal) {
  const decoder = textDecoder(encoding);
  let stringRaw = "";
  let inString = false;
  let escaped = false;
  let primitive = "";
  const consume = function* (chunk) {
    const emitPrimitive = () => {
      if (!primitive) return null;
      const value = JSON.parse(primitive);
      primitive = "";
      return { type: "value", value };
    };
    for (const char of chunk) {
      if (inString) {
        stringRaw += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          const value = JSON.parse(stringRaw);
          stringRaw = "";
          inString = false;
          yield { type: "string", value };
        }
        continue;
      }
      if (primitive) {
        if (char === "{" || char === "}" || char === "[" || char === "]" || char === "," || char === ":" || /[\t\r\n ]/.test(char)) {
          const token = emitPrimitive();
          if (token) yield token;
        } else {
          primitive += char;
          continue;
        }
      }
      if (char === '"') { inString = true; stringRaw = '"'; }
      else if (char === "{" || char === "}" || char === "[" || char === "]" || char === "," || char === ":") yield { type: char };
      else if (/[\t\r\n ]/.test(char)) continue;
      else primitive = char;
    }
  };
  for await (const bytes of fileByteChunks(file, 64 * 1024, signal)) {
    for (const token of consume(decoder.decode(bytes, { stream: true }))) yield token;
  }
  for (const token of consume(decoder.decode())) yield token;
  if (inString) throw new SyntaxError("JSON содержит незакрытую строку");
  if (primitive) yield { type: "value", value: JSON.parse(primitive) };
}

function jsonTokenReader(file, encoding, signal) {
  const iterator = jsonTokens(file, encoding, signal)[Symbol.asyncIterator]();
  let buffered = null;
  return {
    async peek() {
      if (!buffered) buffered = await iterator.next();
      return buffered.done ? null : buffered.value;
    },
    async take() {
      if (buffered) {
        const item = buffered;
        buffered = null;
        return item.done ? null : item.value;
      }
      const item = await iterator.next();
      return item.done ? null : item.value;
    },
  };
}

async function parseJsonValue(reader, first = undefined) {
  const token = first === undefined ? await reader.take() : first;
  if (!token) throw new SyntaxError("JSON неожиданно закончился");
  if (token.type === "value" || token.type === "string") return token.value;
  if (token.type === "[") {
    const values = [];
    let next = await reader.take();
    if (next?.type === "]") return values;
    while (next) {
      values.push(await parseJsonValue(reader, next));
      const separator = await reader.take();
      if (separator?.type === "]") return values;
      if (separator?.type !== ",") throw new SyntaxError("JSON: ожидалась запятая в массиве");
      next = await reader.take();
    }
    throw new SyntaxError("JSON: не закрыт массив");
  }
  if (token.type === "{") {
    const value = Object.create(null);
    let key = await reader.take();
    if (key?.type === "}") return value;
    while (key) {
      if (key.type !== "string") throw new SyntaxError("JSON: ожидалось имя свойства");
      if ((await reader.take())?.type !== ":") throw new SyntaxError("JSON: ожидалось двоеточие после свойства");
      value[key.value] = await parseJsonValue(reader);
      const separator = await reader.take();
      if (separator?.type === "}") return value;
      if (separator?.type !== ",") throw new SyntaxError("JSON: ожидалась запятая в объекте");
      key = await reader.take();
    }
    throw new SyntaxError("JSON: не закрыт объект");
  }
  throw new SyntaxError("JSON: ожидалось значение");
}

async function skipJsonValue(reader, first = undefined) {
  const token = first === undefined ? await reader.take() : first;
  if (!token) throw new SyntaxError("JSON неожиданно закончился");
  if (token.type === "value" || token.type === "string") return;
  if (token.type === "[") {
    let next = await reader.peek();
    if (next?.type === "]") { await reader.take(); return; }
    while (true) {
      await skipJsonValue(reader);
      const separator = await reader.take();
      if (separator?.type === "]") return;
      if (separator?.type !== ",") throw new SyntaxError("JSON: ожидалась запятая в массиве");
      next = await reader.peek();
      if (!next) throw new SyntaxError("JSON: не закрыт массив");
    }
  }
  if (token.type === "{") {
    let key = await reader.peek();
    if (key?.type === "}") { await reader.take(); return; }
    while (true) {
      key = await reader.take();
      if (key?.type !== "string") throw new SyntaxError("JSON: ожидалось имя свойства");
      if ((await reader.take())?.type !== ":") throw new SyntaxError("JSON: ожидалось двоеточие после свойства");
      await skipJsonValue(reader);
      const separator = await reader.take();
      if (separator?.type === "}") return;
      if (separator?.type !== ",") throw new SyntaxError("JSON: ожидалась запятая в объекте");
      if (!await reader.peek()) throw new SyntaxError("JSON: не закрыт объект");
    }
  }
  throw new SyntaxError("JSON: ожидалось значение");
}

const PORTABLE_ARCHIVE_COLLECTIONS = Object.freeze([
  "snapshots", "inventory", "history", "settings", "knownModels", "oui",
  "switchAddressEvidence", "mac5Models", "smartroomRoomMappings", "legacySmartroomRoomMappings", "singleAnalyses", "singleAnalysisChunks",
]);

const SOURCE_FILE_ARCHIVE_CHUNK_BYTES = 192 * 1024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const legacyXlsWorkbooks = new WeakMap();

function archivedSourceChunkSize(value) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Некорректный блок исходного файла в архиве");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = value.length / 4 * 3 - padding;
  if (bytes > SOURCE_FILE_ARCHIVE_CHUNK_BYTES) throw new Error("Слишком большой блок исходного файла в архиве");
  return bytes;
}

export async function inspectPortableArchiveHeader(file, { signal } = {}) {
  const reader = jsonTokenReader(file, "utf-8", signal);
  if ((await reader.take())?.type !== "{") throw new Error("Неподдерживаемый формат архива");
  const header = Object.create(null);
  const seen = new Set();
  let key = await reader.take();
  if (key?.type === "}") throw new Error("Неподдерживаемый формат архива");
  while (key) {
    if (key.type !== "string" || (await reader.take())?.type !== ":") throw new SyntaxError("JSON архива: неверная структура корневого объекта");
    if (key.value === "format" || key.value === "version") {
      if (seen.has(key.value)) throw new Error(`JSON архива содержит повторное поле ${key.value}`);
      seen.add(key.value);
      header[key.value] = await parseJsonValue(reader);
    } else await skipJsonValue(reader);
    const separator = await reader.take();
    if (separator?.type === "}") break;
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая в объекте");
    key = await reader.take();
  }
  if (await reader.take()) throw new SyntaxError("JSON содержит данные после корневого объекта");
  if (header.format === "MAC_ANALYZER_NEXT_ARCHIVE" && header.version === 1) return header;
  if (header.format === "mac-analyzer-full-json" && header.version === 2) return { ...header, sourceFormat: header.format };
  throw new Error("Неподдерживаемый формат архива");
}

function legacyReportDevice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Некорректное устройство в архиве MAC Analyzer Pro");
  const normalized = normalizeDevice(value, text(value.source) || "MAC Analyzer Pro");
  if (!normalized.id && !normalized.deviceId && !normalized.serial && !normalized.mac && !normalized.alternateMacs.length) {
    throw new Error("Устройство архива MAC Analyzer Pro не содержит сильного идентификатора");
  }
  return { ...value, ...normalized, id: normalized.id || stableId(normalized) };
}

function legacyReportMovement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Некорректное событие истории в архиве MAC Analyzer Pro");
  const mac = normalizeMac(value.mac || value.macFormatted || value.mac_formatted);
  const rawType = text(value.type || value.change_type).toLowerCase();
  const type = ["added", "add", "добавлено", "добавлен"].includes(rawType) ? "added"
    : ["absent", "removed", "remove", "deleted", "удалено", "удалён", "отсутствует"].includes(rawType) ? "absent" : "modified";
  const deviceId = text(value.deviceId || value.internalDeviceId || value.internal_device_id);
  const field = text(value.field || value.field_name);
  const timestamp = text(value.timestamp || value.changedAt || value.changed_at || value.date || value.date_str);
  const oldValue = value.before ?? value.from_value ?? value.old_value ?? "";
  const newValue = value.after ?? value.to_value ?? value.new_value ?? "";
  const source = text(value.source || value.file_name) || "MAC Analyzer Pro archive";
  const stableFields = JSON.stringify([mac, deviceId, type, field, oldValue, newValue, timestamp, source]);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < stableFields.length; index += 1) {
    hash ^= BigInt(stableFields.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return {
    ...value,
    id: text(value.id) || `macarchive-history-${hash.toString(16).padStart(16, "0")}`,
    mac,
    macKey: mac,
    deviceId,
    type,
    field,
    oldValue,
    newValue,
    timestamp,
    source,
  };
}

async function* portableSnapshotEvents(reader, ordinal, signal, onProgress, firstToken, { sourceFormat = "", exportedAt = "" } = {}) {
  if (firstToken?.type !== "{") throw new Error("Некорректная структура Final в архиве");
  const metadata = Object.create(null);
  let devicesFound = false;
  let deviceCount = 0;
  let chunkIndex = 0;
  let key = await reader.take();
  if (key?.type === "}") throw new Error("Некорректная структура Final в архиве");
  while (key) {
    if (key.type !== "string" || (await reader.take())?.type !== ":") throw new SyntaxError("JSON архива: неверное поле Final");
    if (sourceFormat === "mac-analyzer-full-json" && key.value === "metadata") {
      const nested = await parseJsonValue(reader);
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) throw new Error("Некорректные метаданные Final в архиве MAC Analyzer Pro");
      Object.assign(metadata, nested);
    } else if (key.value !== "devices") metadata[key.value] = await parseJsonValue(reader);
    else {
      if (devicesFound) throw new Error("Final архива содержит повторное поле devices");
      devicesFound = true;
      if ((await reader.take())?.type !== "[") throw new Error("Некорректная структура Final в архиве");
      let next = await reader.take();
      let devices = [];
      if (next?.type !== "]") {
        while (next) {
          if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
          const device = await parseJsonValue(reader, next);
          devices.push(sourceFormat === "mac-analyzer-full-json" ? legacyReportDevice(device) : device);
          deviceCount += 1;
          if (devices.length >= 500) {
            onProgress({ collection: "snapshots", recordsRead: deviceCount, batchSize: devices.length });
            yield { type: "snapshotChunk", ordinal, index: chunkIndex++, devices };
            devices = [];
          }
          const separator = await reader.take();
          if (separator?.type === "]") break;
          if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая между устройствами");
          next = await reader.take();
        }
        if (next === null) throw new SyntaxError("JSON архива: не закрыт список устройств");
      }
      if (devices.length) {
        onProgress({ collection: "snapshots", recordsRead: deviceCount, batchSize: devices.length });
        yield { type: "snapshotChunk", ordinal, index: chunkIndex++, devices };
      }
    }
    const separator = await reader.take();
    if (separator?.type === "}") break;
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая в Final");
    key = await reader.take();
  }
  if (!devicesFound || typeof metadata.id !== "string" || !metadata.id) throw new Error("Некорректная структура Final в архиве");
  const suppliedDeviceCount = metadata.deviceCount;
  const suppliedChunkCount = metadata.chunkCount;
  if (suppliedDeviceCount !== undefined && Number(suppliedDeviceCount) !== deviceCount) throw new Error(`Архив Final ${metadata.id}: число устройств не совпадает`);
  if (suppliedChunkCount !== undefined && Number(suppliedChunkCount) !== chunkIndex) throw new Error(`Архив Final ${metadata.id}: число чанков не совпадает`);
  metadata.deviceCount = deviceCount;
  metadata.chunkCount = chunkIndex;
  if (sourceFormat === "mac-analyzer-full-json") {
    metadata.createdAt = text(metadata.fileCreatedAt || metadata.savedAt || exportedAt);
    metadata.snapshotType = "final";
  }
  yield { type: "snapshot", ordinal, value: metadata };
}

async function* portableOriginalFileEvents(reader, signal, firstToken) {
  if (firstToken?.type !== "{") throw new Error("Некорректный оригинал исходного файла в архиве");
  const metadata = Object.create(null);
  const seen = new Set();
  let chunksStarted = false;
  let actualSize = 0;
  let key = await reader.take();
  while (key && key.type !== "}") {
    if (key.type !== "string" || (await reader.take())?.type !== ":") throw new SyntaxError("Некорректная структура оригинала исходного файла");
    if (seen.has(key.value)) throw new Error(`Оригинал исходного файла содержит повторное поле ${key.value}`);
    seen.add(key.value);
    if (key.value !== "chunks") {
      if (chunksStarted) throw new Error("Метаданные оригинала должны идти до блоков файла");
      metadata[key.value] = await parseJsonValue(reader);
    } else {
      chunksStarted = true;
      if (typeof metadata.snapshotId !== "string" || !metadata.snapshotId
        || !["main", "smartroom", "ddio"].includes(metadata.role)
        || typeof metadata.name !== "string" || metadata.name.length > 1024
        || (metadata.type !== undefined && typeof metadata.type !== "string")
        || (metadata.lastModified !== undefined && (!Number.isSafeInteger(metadata.lastModified) || metadata.lastModified < 0))
        || !Number.isSafeInteger(metadata.size)
        || metadata.size < 0 || metadata.size > MAX_SOURCE_FILE_BYTES) {
        throw new Error("Некорректные метаданные оригинала исходного файла");
      }
      if ((await reader.take())?.type !== "[") throw new Error("Блоки оригинала должны быть массивом");
      yield { type: "originalFileStart", metadata: { ...metadata, type: String(metadata.type || "application/octet-stream"), lastModified: Math.max(0, Number(metadata.lastModified || 0)) } };
      let chunk = await reader.take();
      if (chunk?.type !== "]") {
        while (chunk) {
          if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
          const byteLength = archivedSourceChunkSize(chunk.value);
          if (byteLength === 0) throw new Error("Пустой блок исходного файла в архиве");
          actualSize += byteLength;
          if (actualSize > metadata.size) throw new Error("Размер оригинала превышает объявленное значение");
          yield { type: "originalFileChunk", chunk: chunk.value };
          const separator = await reader.take();
          if (separator?.type === "]") { chunk = separator; break; }
          if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая между блоками файла");
          if (byteLength !== SOURCE_FILE_ARCHIVE_CHUNK_BYTES) throw new Error("Неполный промежуточный блок исходного файла");
          chunk = await reader.take();
        }
      }
      if (chunk?.type !== "]") throw new SyntaxError("JSON архива: не закрыт массив блоков файла");
    }
    const separator = await reader.take();
    if (separator?.type === "}") { key = separator; break; }
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая в оригинале файла");
    key = await reader.take();
  }
  if (key?.type !== "}" || !chunksStarted || !seen.has("chunks")) throw new Error("В архиве отсутствуют блоки исходного файла");
  if (actualSize !== metadata.size) throw new Error("Размер оригинала исходного файла не совпадает");
  yield { type: "originalFileEnd" };
}

async function* portableMappedRecordEvents(reader, collection, { batchSize, signal, onProgress, transform }) {
  if ((await reader.take())?.type !== "[") throw new Error(`Некорректный раздел архива: ${collection}`);
  let next = await reader.take();
  let batch = [];
  let recordsRead = 0;
  while (next && next.type !== "]") {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    batch.push(transform(await parseJsonValue(reader, next)));
    recordsRead += 1;
    if (batch.length >= batchSize) {
      onProgress({ collection, recordsRead, batchSize: batch.length });
      yield { type: "records", collection, records: batch };
      batch = [];
    }
    const separator = await reader.take();
    if (separator?.type === "]") { next = separator; break; }
    if (separator?.type !== ",") throw new SyntaxError(`JSON архива: ожидалась запятая в ${collection}`);
    next = await reader.take();
  }
  if (batch.length) {
    onProgress({ collection, recordsRead, batchSize: batch.length });
    yield { type: "records", collection, records: batch };
  }
  if (next?.type !== "]") throw new SyntaxError(`JSON архива: не закрыт раздел ${collection}`);
}

async function* legacyWorkspaceSettingEvents(reader, signal, onProgress) {
  if ((await reader.take())?.type !== "{") throw new Error("Некорректная рабочая область архива MAC Analyzer Pro");
  const keys = new Map([
    ["theme", "legacyAppSetting:theme"],
    ["dashboardSettings", "legacyAppSetting:dashboard"],
    ["vendorDetectorSettings", "legacyAppSetting:vendor_detector"],
  ]);
  let key = await reader.take();
  if (key?.type === "}") return;
  while (key) {
    if (key.type !== "string" || (await reader.take())?.type !== ":") throw new SyntaxError("JSON архива: неверное поле рабочей области");
    const settingKey = keys.get(key.value);
    if (settingKey) {
      const value = await parseJsonValue(reader);
      onProgress({ collection: "settings", recordsRead: 1, batchSize: 1 });
      yield { type: "records", collection: "settings", records: [{ key: settingKey, value }] };
    } else await skipJsonValue(reader);
    const separator = await reader.take();
    if (separator?.type === "}") break;
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая в рабочей области");
    key = await reader.take();
  }
}

export async function* readPortableArchiveEvents(file, { batchSize = 128, signal, onProgress = () => {}, sourceFormat = "" } = {}) {
  if (!file || typeof file.slice !== "function" || !Number.isFinite(file.size)) throw new Error("Файл архива не поддерживает потоковое чтение");
  const reader = jsonTokenReader(file, "utf-8", signal);
  if ((await reader.take())?.type !== "{") throw new Error("Неподдерживаемый формат архива");
  const seen = new Set();
  let recordsRead = 0;
  let snapshotOrdinal = 0;
  let exportedAt = "";
  let key = await reader.take();
  if (key?.type === "}") throw new Error("Неподдерживаемый формат архива");
  while (key) {
    if (key.type !== "string" || (await reader.take())?.type !== ":") throw new SyntaxError("JSON архива: неверная структура корневого объекта");
    if (seen.has(key.value)) throw new Error(`Архив содержит повторное поле ${key.value}`);
    seen.add(key.value);
    if (key.value === "snapshots") {
      if ((await reader.take())?.type !== "[") throw new Error("Некорректная структура архива: snapshots");
      let next = await reader.take();
      if (next?.type !== "]") {
        while (next) {
          yield* portableSnapshotEvents(reader, snapshotOrdinal++, signal, onProgress, next, { sourceFormat, exportedAt });
          const separator = await reader.take();
          if (separator?.type === "]") break;
          if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая между Final");
          next = await reader.take();
        }
      }
    } else if (sourceFormat === "mac-analyzer-full-json" && key.value === "exportedAt") {
      exportedAt = text(await parseJsonValue(reader));
    } else if (sourceFormat === "mac-analyzer-full-json" && key.value === "allDevices") {
      yield* portableMappedRecordEvents(reader, "inventory", { batchSize, signal, onProgress, transform: legacyReportDevice });
    } else if (sourceFormat === "mac-analyzer-full-json" && key.value === "movementHistory") {
      yield* portableMappedRecordEvents(reader, "history", { batchSize, signal, onProgress, transform: legacyReportMovement });
    } else if (sourceFormat === "mac-analyzer-full-json" && key.value === "workspace") {
      yield* legacyWorkspaceSettingEvents(reader, signal, onProgress);
    } else if (key.value === "originalFiles") {
      if ((await reader.take())?.type !== "[") throw new Error("Некорректная структура архива: originalFiles");
      let next = await reader.take();
      while (next && next.type !== "]") {
        yield* portableOriginalFileEvents(reader, signal, next);
        recordsRead += 1;
        onProgress({ collection: "originalFiles", recordsRead, batchSize: 1 });
        const separator = await reader.take();
        if (separator?.type === "]") { next = separator; break; }
        if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая между оригиналами");
        next = await reader.take();
      }
      if (next?.type !== "]") throw new SyntaxError("JSON архива: не закрыт массив originalFiles");
    } else if (PORTABLE_ARCHIVE_COLLECTIONS.includes(key.value)) {
      if ((await reader.take())?.type !== "[") throw new Error(`Некорректная структура архива: ${key.value}`);
      let next = await reader.take();
      let batch = [];
      while (next && next.type !== "]") {
        batch.push(await parseJsonValue(reader, next));
        recordsRead += 1;
        if (batch.length >= batchSize) {
          onProgress({ collection: key.value, recordsRead, batchSize: batch.length });
          yield { type: "records", collection: key.value, records: batch };
          batch = [];
        }
        const separator = await reader.take();
        if (separator?.type === "]") { next = separator; break; }
        if (separator?.type !== ",") throw new SyntaxError(`JSON архива: ожидалась запятая в ${key.value}`);
        next = await reader.take();
      }
      if (batch.length) {
        onProgress({ collection: key.value, recordsRead, batchSize: batch.length });
        yield { type: "records", collection: key.value, records: batch };
      }
      if (next?.type !== "]") throw new SyntaxError(`JSON архива: не закрыт массив ${key.value}`);
    } else await skipJsonValue(reader);
    const separator = await reader.take();
    if (separator?.type === "}") break;
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая в объекте");
    key = await reader.take();
  }
  if (await reader.take()) throw new SyntaxError("JSON содержит данные после корневого объекта");
}

function objectPropertyNames(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || Array.isArray(value)) return Object.keys(value);
  if (typeof value === "object") return Object.keys(value);
  return [];
}

async function inspectJsonArray(reader) {
  let headers = [];
  const headerSet = new Set();
  let rowCount = 0;
  let arrayHeader = false;
  let itemIndex = 0;
  let closed = false;
  let next = await reader.take();
  if (next?.type === "]") return { headers, rowCount, arrayHeader };
  while (next) {
    const item = await parseJsonValue(reader, next);
    if (itemIndex === 0 && Array.isArray(item)) {
      arrayHeader = true;
      headers = item.map(text);
      assertTableCapacity(0, headers.length);
    } else if (arrayHeader) {
      rowCount += 1;
      assertTableCapacity(rowCount, rowCount * headers.length);
    } else {
      rowCount += 1;
      for (const name of objectPropertyNames(item)) headerSet.add(name);
      headers = [...headerSet];
      assertTableCapacity(rowCount, rowCount * headers.length);
    }
    itemIndex += 1;
    const separator = await reader.take();
    if (separator?.type === "]") { closed = true; break; }
    if (separator?.type !== ",") throw new SyntaxError("JSON: ожидалась запятая в массиве");
    next = await reader.take();
  }
  if (!closed) throw new SyntaxError("JSON: не закрыт массив");
  return { headers, rowCount, arrayHeader };
}

function tokenTruthy(token) {
  if (token.type === "[" || token.type === "{") return true;
  if (token.type === "string") return Boolean(token.value);
  return Boolean(token.value);
}

async function inspectJsonCollection(file, encoding, signal) {
  const reader = jsonTokenReader(file, encoding, signal);
  const root = await reader.take();
  if (root?.type === "[") {
    const metadata = await inspectJsonArray(reader);
    if (await reader.take()) throw new SyntaxError("JSON содержит данные после корневого массива");
    return { key: "", ...metadata };
  }
  if (root?.type !== "{") throw new Error("JSON должен содержать массив строк");
  const properties = new Map();
  const collectionKeys = new Set(["devices", "rows", "data"]);
  let key = await reader.take();
  if (key?.type === "}") throw new Error("JSON должен содержать массив строк");
  while (key) {
    if (key.type !== "string") throw new SyntaxError("JSON: ожидалось имя свойства");
    if ((await reader.take())?.type !== ":") throw new SyntaxError("JSON: ожидалось двоеточие после свойства");
    const first = await reader.take();
    if (!first) throw new SyntaxError("JSON неожиданно закончился");
    if (collectionKeys.has(key.value)) {
      const prior = properties.get(key.value);
      const occurrence = (prior?.occurrence || 0) + 1;
      let metadata = null;
      if (first.type === "[") metadata = await inspectJsonArray(reader);
      else await skipJsonValue(reader, first);
      properties.set(key.value, { truthy: tokenTruthy(first), isArray: first.type === "[", metadata, occurrence });
    } else await skipJsonValue(reader, first);
    const separator = await reader.take();
    if (separator?.type === "}") break;
    if (separator?.type !== ",") throw new SyntaxError("JSON: ожидалась запятая в объекте");
    key = await reader.take();
  }
  if (!key) throw new SyntaxError("JSON: не закрыт корневой объект");
  if (await reader.take()) throw new SyntaxError("JSON содержит данные после корневого объекта");
  const selectedKey = ["devices", "rows", "data"].find((candidate) => properties.get(candidate)?.truthy);
  const selected = properties.get(selectedKey);
  if (!selectedKey || !selected?.isArray) throw new Error("JSON должен содержать массив строк");
  return { key: selectedKey, occurrence: selected.occurrence, ...selected.metadata, wrapper: true };
}

async function* readJsonCollectionRows(file, encoding, collection, { batchSize, signal, onProgress = () => {} } = {}) {
  const reader = jsonTokenReader(file, encoding, signal);
  const root = await reader.take();
  const streamArray = async function* () {
    let rowIndex = 0;
    let rowsRead = 0;
    let batch = [];
    let closed = false;
    let next = await reader.take();
    if (next?.type === "]") return;
    while (next) {
      const item = await parseJsonValue(reader, next);
      if (!(collection.arrayHeader && rowIndex === 0)) {
        const row = collection.arrayHeader ? item : collection.headers.map((header) => item?.[header] ?? "");
        batch.push(row);
        rowsRead += 1;
        if (batch.length >= batchSize) {
          onProgress({ rowsRead, batchSize: batch.length });
          yield batch;
          batch = [];
        }
      }
      rowIndex += 1;
      const separator = await reader.take();
      if (separator?.type === "]") { closed = true; break; }
      if (separator?.type !== ",") throw new SyntaxError("JSON: ожидалась запятая в массиве");
      next = await reader.take();
    }
    if (batch.length) {
      onProgress({ rowsRead, batchSize: batch.length });
      yield batch;
    }
    if (!closed) throw new SyntaxError("JSON: не закрыт массив");
    if (rowsRead !== collection.rowCount) throw new Error("JSON изменился между проверкой и чтением");
  };
  if (!collection.wrapper) {
    if (root?.type !== "[") throw new Error("JSON изменился между проверкой и чтением");
    yield* streamArray();
    if (await reader.take()) throw new SyntaxError("JSON содержит данные после корневого массива");
    return;
  }
  if (root?.type !== "{") throw new Error("JSON изменился между проверкой и чтением");
  let collectionOccurrence = 0;
  let key = await reader.take();
  if (key?.type === "}") return;
  while (key) {
    if (key.type !== "string" || (await reader.take())?.type !== ":") throw new SyntaxError("JSON: неверная структура корневого объекта");
    const first = await reader.take();
    if (key.value === collection.key) {
      collectionOccurrence += 1;
      if (collectionOccurrence === collection.occurrence) {
        if (first?.type !== "[") throw new Error("JSON изменился между проверкой и чтением");
        yield* streamArray();
      } else await skipJsonValue(reader, first);
    } else await skipJsonValue(reader, first);
    const separator = await reader.take();
    if (separator?.type === "}") break;
    if (separator?.type !== ",") throw new SyntaxError("JSON: ожидалась запятая в объекте");
    key = await reader.take();
  }
  if (await reader.take()) throw new SyntaxError("JSON содержит данные после корневого объекта");
}

async function* jsonRowBatches(file, { batchSize = 500, signal, onHeaders = () => {}, onProgress = () => {} } = {}) {
  const { encoding } = await delimitedTextEncoding(file, signal);
  const collection = await inspectJsonCollection(file, encoding, signal);
  assertTableCapacity(collection.rowCount, collection.rowCount * collection.headers.length);
  onHeaders({ headers: collection.headers, rowCount: collection.rowCount, sheet: "", workbookCreatedAt: "", workbookModifiedAt: "" });
  yield* readJsonCollectionRows(file, encoding, collection, { batchSize, signal, onProgress });
}

function findEocd(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) return offset;
  }
  throw new Error("XLSX: не найдена ZIP-директория");
}

async function zipDirectory(file) {
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = await file.slice(tailStart).arrayBuffer();
  const tailBytes = new Uint8Array(tail);
  const tailView = new DataView(tail);
  const eocd = findEocd(tailBytes);
  const entries = tailView.getUint16(eocd + 10, true);
  const directoryBytes = tailView.getUint32(eocd + 12, true);
  const directoryOffset = tailView.getUint32(eocd + 16, true);
  if (directoryOffset + directoryBytes > file.size) throw new Error("XLSX: каталог выходит за границы файла");
  const directory = await file.slice(directoryOffset, directoryOffset + directoryBytes).arrayBuffer();
  const view = new DataView(directory);
  let offset = 0;
  const result = new Map();
  const capacityEntries = [];
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > view.byteLength) throw new Error("XLSX: усечён ZIP-каталог");
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("XLSX: повреждён ZIP-каталог");
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > view.byteLength) throw new Error("XLSX: повреждено имя ZIP-записи");
    const name = new TextDecoder().decode(new Uint8Array(directory, nameStart, nameLength)).replaceAll("\\", "/");
    const entry = { name, method, compressed, uncompressed, localOffset };
    capacityEntries.push(entry);
    result.set(name, entry);
    offset = nameEnd + extraLength + commentLength;
  }
  assertZipDirectoryCapacity(capacityEntries);
  return { file, entries: result };
}

async function zipEntryStream(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;
  const offset = entry.localOffset;
  if (offset + 30 > zip.file.size) throw new Error(`XLSX: повреждена запись ${name}`);
  const header = await zip.file.slice(offset, offset + 30).arrayBuffer();
  const headerView = new DataView(header);
  if (headerView.getUint32(0, true) !== 0x04034b50) throw new Error(`XLSX: повреждена запись ${name}`);
  const nameLength = headerView.getUint16(26, true);
  const extraLength = headerView.getUint16(28, true);
  const start = offset + 30 + nameLength + extraLength;
  if (start + entry.compressed > zip.file.size) throw new Error(`XLSX: данные записи ${name} выходят за границы файла`);
  let stream = zip.file.slice(start, start + entry.compressed).stream();
  if (entry.method === 8 && typeof globalThis.DecompressionStream !== "undefined") {
    stream = stream.pipeThrough(new globalThis.DecompressionStream("deflate-raw"));
  } else if (entry.method !== 0) {
    throw new Error("Этот браузер не поддерживает распаковку XLSX. Используйте актуальный Chrome или Edge.");
  }
  return { entry, stream };
}

async function zipText(zip, name, maximumBytes = 4 * 1024 * 1024) {
  const metadata = zip.entries.get(name);
  if (metadata && metadata.uncompressed > maximumBytes) {
    throw new Error(`XLSX: раздел метаданных ${name} превышает допустимый размер`);
  }
  const source = await zipEntryStream(zip, name);
  if (!source) return "";
  const { entry, stream } = source;
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const parts = [];
  let expandedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    expandedBytes += value.byteLength;
    if (expandedBytes > entry.uncompressed) {
      await reader.cancel();
      throw new Error(`XLSX: распакованная часть ${name} превышает размер из ZIP-каталога`);
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  if (expandedBytes !== entry.uncompressed) throw new Error(`XLSX: размер распакованной части ${name} не совпадает с ZIP-каталогом`);
  return parts.join("");
}

function findXmlElementStart(source, tag, from = 0) {
  const token = `<${tag}`;
  let index = source.indexOf(token, from);
  while (index >= 0) {
    const next = source[index + token.length];
    if (!next || /[\s/>]/.test(next)) return index;
    index = source.indexOf(token, index + 1);
  }
  return -1;
}

async function* zipXmlElements(zip, name, tag) {
  const source = await zipEntryStream(zip, name);
  if (!source) return;
  const { entry, stream } = source;
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const token = `<${tag}`;
  const closing = `</${tag}>`;
  const overlap = token.length + 2;
  let pending = "";
  let expandedBytes = 0;
  let streamEnded = false;
  try {
    while (!streamEnded) {
      const result = await reader.read();
      streamEnded = result.done;
      if (!streamEnded) {
        expandedBytes += result.value.byteLength;
        if (expandedBytes > entry.uncompressed) throw new Error(`XLSX: распакованная часть ${name} превышает размер из ZIP-каталога`);
        pending += decoder.decode(result.value, { stream: true });
      } else {
        pending += decoder.decode();
      }

      while (true) {
        const start = findXmlElementStart(pending, tag);
        if (start < 0) {
          pending = pending.slice(-overlap);
          break;
        }
        const openEnd = pending.indexOf(">", start + token.length);
        if (openEnd < 0) {
          pending = pending.slice(start);
          break;
        }
        if (pending[openEnd - 1] === "/") {
          pending = pending.slice(openEnd + 1);
          continue;
        }
        const end = pending.indexOf(closing, openEnd + 1);
        if (end < 0) {
          pending = pending.slice(start);
          break;
        }
        const itemEnd = end + closing.length;
        const element = pending.slice(start, itemEnd);
        pending = pending.slice(itemEnd);
        yield element;
      }
    }
    if (expandedBytes !== entry.uncompressed) throw new Error(`XLSX: размер распакованной части ${name} не совпадает с ZIP-каталогом`);
    if (findXmlElementStart(pending, tag) >= 0) throw new Error(`XLSX: незакрытый элемент <${tag}> в ${name}`);
  } finally {
    if (!streamEnded) await reader.cancel();
    reader.releaseLock();
  }
}

async function readSharedStrings(zip) {
  const values = [];
  const entry = zip.entries.get("xl/sharedStrings.xml");
  if (entry) assertSharedStringCapacity(0, entry.uncompressed);
  let valueBytes = 0;
  for await (const item of zipXmlElements(zip, "xl/sharedStrings.xml", "si")) {
    const content = item.replace(/^<si\b[^>]*>/, "").replace(/<\/si>$/, "");
    const value = [...content.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])).join("");
    valueBytes += value.length * 2;
    assertSharedStringCapacity(values.length + 1, valueBytes);
    values.push(value);
  }
  return values;
}

function columnIndex(reference) {
  const letters = String(reference).match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function parseWorksheetRow(xml, sharedStrings) {
  const row = [];
  for (const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const body = cell[2];
      const reference = attrs.match(/\br="([^"]+)"/)?.[1] || "A1";
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || "";
      const index = columnIndex(reference);
      if (index >= IMPORT_LIMITS.cellCount) assertTableCapacity(0, index + 1);
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        ?? body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1]
        ?? "";
      const value = type === "s" ? sharedStrings[Number(raw)] ?? "" : decodeXml(raw);
      row[index] = value;
  }
  return row;
}

async function* readWorksheetBatches(zip, path, sharedStrings, { batchSize = 500, signal, onHeaders = () => {}, onProgress = () => {} } = {}) {
  let headers = null;
  let headerWidth = 0;
  let cellCount = 0;
  let rowCount = 0;
  let batch = [];
  for await (const rowXml of zipXmlElements(zip, path, "row")) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const row = parseWorksheetRow(rowXml, sharedStrings);
    if (!headers) {
      headerWidth = row.length;
      cellCount = headerWidth;
      assertTableCapacity(0, cellCount);
      headers = row.map(text);
      onHeaders(headers);
    } else {
      rowCount += 1;
      cellCount += Math.max(headerWidth, row.length);
      assertTableCapacity(rowCount + 1, cellCount);
      batch.push(row);
      if (batch.length >= batchSize) {
        onProgress({ rowsRead: rowCount, batchSize: batch.length });
        yield batch;
        batch = [];
      }
    }
  }
  if (!headers) throw new Error("Лист XLSX не содержит строки заголовков");
  if (batch.length) {
    onProgress({ rowsRead: rowCount, batchSize: batch.length });
    yield batch;
  }
  return { headers, rowCount };
}

function xmlAttribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = attributes.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return decodeXml(value?.[1] ?? value?.[2] ?? "");
}

function normalizeWorkbookSheetPath(target) {
  const source = String(target || "").replaceAll("\\", "/");
  const path = source.startsWith("/") ? source.slice(1) : `xl/${source}`;
  const segments = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

async function xlsxSheets(zip) {
  const workbook = await zipText(zip, "xl/workbook.xml");
  const relationships = await zipText(zip, "xl/_rels/workbook.xml.rels");
  if (!workbook) throw new Error("XLSX: не найден xl/workbook.xml");
  const relationshipById = new Map();
  for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attrs = match[1];
    const id = xmlAttribute(attrs, "Id");
    const targetMode = xmlAttribute(attrs, "TargetMode");
    const target = xmlAttribute(attrs, "Target");
    if (id && target && targetMode.toLocaleLowerCase("en-US") !== "external") {
      relationshipById.set(id, normalizeWorkbookSheetPath(target));
    }
  }
  const fallbackPaths = [...zip.entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((left, right) => Number(left.match(/sheet(\d+)/i)?.[1]) - Number(right.match(/sheet(\d+)/i)?.[1]));
  const sheets = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const attrs = match[1];
    const name = xmlAttribute(attrs, "name");
    const relationshipId = xmlAttribute(attrs, "r:id") || xmlAttribute(attrs, "id");
    const path = relationshipById.get(relationshipId) || fallbackPaths[sheets.length] || "";
    if (!name || !path.startsWith("xl/worksheets/") || !zip.entries.has(path)) continue;
    sheets.push({ name, path });
  }
  if (!sheets.length) throw new Error("XLSX не содержит читаемых листов");
  return sheets;
}

export async function listXlsxSheets(file) {
  if (!file || !/\.(xlsx|xlsm|xls)$/i.test(file.name || "")) return [];
  if (/\.xls$/i.test(file.name || "")) {
    const workbook = await parseLegacyXlsWorkbook(file);
    legacyXlsWorkbooks.set(file, workbook);
    return [...workbook.SheetNames];
  }
  assertSourceFileCapacity(file);
  return (await xlsxSheets(await zipDirectory(file))).map(({ name }) => name);
}

async function parseLegacyXlsWorkbook(file) {
  assertSourceFileCapacity(file, IMPORT_LIMITS.legacyXlsFileBytes);
  const library = globalThis.XLSX;
  if (typeof library?.read !== "function" || typeof library?.utils?.decode_range !== "function") {
    throw new Error("Компонент чтения XLS не загружен. Перезапустите автономный HTML или откройте приложение из комплекта Next.");
  }
  if (typeof file.arrayBuffer !== "function") throw new Error("Браузер не может прочитать выбранный XLS-файл");
  const bytes = await file.arrayBuffer();
  const workbook = library.read(bytes, {
    type: "array", cellFormula: false, cellHTML: false,
    cellNF: false, cellStyles: false, cellText: true, cellDates: false,
  });
  if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length === 0) throw new Error("XLS не содержит листов для чтения");
  return workbook;
}

function legacyXlsSheet(workbook, sheetName) {
  const library = globalThis.XLSX;
  const selectedName = sheetName || workbook.SheetNames[0];
  const sheet = workbook.Sheets[selectedName];
  if (!sheet) throw new Error(`XLS лист не найден: ${selectedName}`);
  if (!sheet["!ref"]) throw new Error(`XLS лист «${selectedName}» не содержит строк заголовков`);
  const range = library.utils.decode_range(sheet["!ref"]);
  const rowCount = range.e.r - range.s.r + 1;
  const columnCount = range.e.c - range.s.c + 1;
  assertTableCapacity(rowCount, rowCount * columnCount);
  return { name: selectedName, sheet, range, rowCount, columnCount };
}

function legacyXlsCell(workbook, sheet, row, column) {
  const address = globalThis.XLSX.utils.encode_cell({ r: row, c: column });
  const cell = Array.isArray(sheet) ? sheet[row]?.[column] : sheet[address];
  return cell?.v === undefined || cell.v === null ? "" : String(cell.v);
}

function legacyXlsMetadata(workbook) {
  const created = workbook.Props?.CreatedDate;
  const modified = workbook.Props?.ModifiedDate;
  const iso = (value) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : "";
  return { workbookCreatedAt: iso(created), workbookModifiedAt: iso(modified) };
}

async function* legacyXlsRowBatches(file, { sheetName = "", batchSize = 500, signal, onHeaders = () => {}, onProgress = () => {} } = {}) {
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  const workbook = legacyXlsWorkbooks.get(file) || await parseLegacyXlsWorkbook(file);
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  legacyXlsWorkbooks.delete(file);
  const context = legacyXlsSheet(workbook, sheetName);
  const { range, sheet, columnCount } = context;
  const normalizedBatchSize = Math.max(1, Math.min(5_000, Math.floor(Number(batchSize) || 500)));
  const metadata = { sheet: context.name, ...legacyXlsMetadata(workbook) };
  const headers = Array.from({ length: columnCount }, (_, offset) => {
    const value = legacyXlsCell(workbook, sheet, range.s.r, range.s.c + offset);
    return text(value) || `Column ${offset + 1}`;
  });
  onHeaders({ headers, ...metadata });
  let rowsRead = 0;
  let batch = [];
  for (let rowIndex = range.s.r + 1; rowIndex <= range.e.r; rowIndex += 1) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const row = Array.from({ length: columnCount }, (_, offset) => legacyXlsCell(workbook, sheet, rowIndex, range.s.c + offset));
    if (!row.some((value) => value !== "")) continue;
    rowsRead += 1;
    assertTableCapacity(rowsRead + 1, (rowsRead + 1) * columnCount);
    batch.push(row);
    if (batch.length >= normalizedBatchSize) {
      onProgress({ rowsRead, batchSize: batch.length, ...metadata });
      yield batch;
      batch = [];
    }
  }
  if (batch.length) {
    onProgress({ rowsRead, batchSize: batch.length, ...metadata });
    yield batch;
  }
  return { headers, rowCount: rowsRead, ...metadata };
}

async function readXlsxMetadata(zip) {
  const coreProperties = zip.entries.get("docProps/core.xml");
  let workbookCreatedAt = "";
  let workbookModifiedAt = "";
  if (coreProperties && coreProperties.uncompressed <= 64 * 1024) {
    const xml = await zipText(zip, "docProps/core.xml");
    for (const property of ["created", "modified"]) {
      const match = xml.match(new RegExp(`<(?:\\w+:)?${property}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${property}\\s*>`, "i"));
      const value = decodeXml(match?.[1]).trim();
      const normalizedDate = normalizeDate(value);
      if (!normalizedDate) continue;
      if (property === "created") workbookCreatedAt = normalizedDate;
      else workbookModifiedAt = normalizedDate;
    }
  }
  return { workbookCreatedAt, workbookModifiedAt };
}

async function prepareXlsx(file, sheetName) {
  assertSourceFileCapacity(file);
  const zip = await zipDirectory(file);
  const metadata = await readXlsxMetadata(zip);
  const shared = await readSharedStrings(zip);
  const sheets = await xlsxSheets(zip);
  const selected = sheetName ? sheets.find((sheet) => sheet.name === sheetName) : sheets[0];
  if (!selected) throw new Error(`XLSX лист не найден: ${sheetName}`);
  return { zip, shared, selected, ...metadata };
}

async function* xlsxRowBatches(file, { sheetName = "", batchSize = 500, signal, onHeaders = () => {}, onProgress = () => {} } = {}) {
  const context = await prepareXlsx(file, sheetName);
  const normalizedBatchSize = Math.max(1, Math.min(5_000, Math.floor(Number(batchSize) || 500)));
  const metadata = { sheet: context.selected.name, workbookCreatedAt: context.workbookCreatedAt, workbookModifiedAt: context.workbookModifiedAt };
  let headers = null;
  let rowCount = 0;
  const batches = readWorksheetBatches(context.zip, context.selected.path, context.shared, {
    batchSize: normalizedBatchSize,
    signal,
    onHeaders: (value) => { headers = value; onHeaders({ headers: value, ...metadata }); },
    onProgress: (value) => { rowCount = value.rowsRead; onProgress({ ...value, ...metadata }); },
  });
  for await (const batch of batches) yield batch;
  if (!headers) throw new Error(`XLSX лист «${context.selected.name}» не содержит строк`);
  return { headers, rowCount, ...metadata };
}

export async function* readTableRowBatches(file, options = {}) {
  if (!file) throw new Error("Файл не выбран");
  assertSourceFileCapacity(file);
  const batchSize = Math.max(1, Math.min(5_000, Math.floor(Number(options.batchSize) || 500)));
  if (/\.(xlsx|xlsm)$/i.test(file.name)) {
    yield* xlsxRowBatches(file, { ...options, batchSize });
    return;
  }
  if (/\.xls$/i.test(file.name)) {
    yield* legacyXlsRowBatches(file, { ...options, batchSize });
    return;
  }
  if (/\.(csv|tsv|txt)$/i.test(file.name) && typeof file.slice === "function") {
    yield* delimitedRowBatches(file, { ...options, batchSize });
    return;
  }
  if (/\.json$/i.test(file.name) && typeof file.slice === "function") {
    yield* jsonRowBatches(file, { ...options, batchSize });
    return;
  }
  const table = await readTable(file);
  options.onHeaders?.({ headers: table.headers, sheet: table.sheet || "", workbookCreatedAt: table.workbookCreatedAt || "", workbookModifiedAt: table.workbookModifiedAt || "" });
  for (let offset = 0; offset < table.rows.length; offset += batchSize) {
    if (options.signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const rows = table.rows.slice(offset, offset + batchSize);
    options.onProgress?.({ rowsRead: offset + rows.length, batchSize: rows.length });
    yield rows;
  }
}

async function readXlsx(file, { maxRows = Number.POSITIVE_INFINITY, sheetName = "" } = {}) {
  const rows = [];
  let headers = null;
  let workbookMetadata = {};
  let truncated = false;
  const reader = xlsxRowBatches(file, {
    sheetName,
    batchSize: Number.isFinite(maxRows) ? Math.max(1, maxRows + 1) : 500,
    onHeaders: (value) => { headers = value.headers; workbookMetadata = value; },
  });
  while (true) {
    const result = await reader.next();
    if (result.done) break;
    const batch = result.value;
    const remaining = Number.isFinite(maxRows) ? Math.max(0, maxRows - rows.length) : batch.length;
    rows.push(...batch.slice(0, remaining));
    if (Number.isFinite(maxRows) && rows.length >= maxRows && batch.length > remaining) {
      truncated = true;
      await reader.return();
      break;
    }
  }
  if (!headers) throw new Error("XLSX лист не содержит строки заголовков");
  return {
    headers,
    rows,
    rowCount: truncated ? null : rows.length,
    ...workbookMetadata,
    ...(Number.isFinite(maxRows) ? { preview: true } : {}),
  };
}

async function readLegacyXls(file, { maxRows = Number.POSITIVE_INFINITY, sheetName = "" } = {}) {
  const rows = [];
  let headers = null;
  let workbookMetadata = {};
  let rowCount = 0;
  let truncated = false;
  const reader = legacyXlsRowBatches(file, {
    sheetName,
    batchSize: Number.isFinite(maxRows) ? Math.max(1, maxRows + 1) : 500,
    onHeaders: (value) => { headers = value.headers; workbookMetadata = value; },
    onProgress: (value) => { rowCount = value.rowsRead; },
  });
  while (true) {
    const result = await reader.next();
    if (result.done) {
      rowCount = result.value?.rowCount ?? rowCount;
      break;
    }
    const batch = result.value;
    const remaining = Number.isFinite(maxRows) ? Math.max(0, maxRows - rows.length) : batch.length;
    rows.push(...batch.slice(0, remaining));
    if (Number.isFinite(maxRows) && rows.length >= maxRows && batch.length > remaining) {
      truncated = true;
      await reader.return();
      break;
    }
  }
  if (!headers) throw new Error("XLS не содержит строки заголовков");
  return {
    headers,
    rows,
    rowCount: truncated ? null : rowCount,
    ...workbookMetadata,
    ...(Number.isFinite(maxRows) ? { preview: true } : {}),
  };
}

export async function readTable(file, { sheetName = "" } = {}) {
  if (!file) throw new Error("Файл не выбран");
  assertSourceFileCapacity(file);
  if (/\.xls$/i.test(file.name)) return readLegacyXls(file, { sheetName });
  if (/\.(xlsx|xlsm)$/i.test(file.name)) return readXlsx(file, { sheetName });
  const source = await readTextFile(file);
  if (/\.json$/i.test(file.name) && typeof file.slice === "function") {
    const parsed = JSON.parse(source);
    const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object"
      ? parsed.devices || parsed.rows || parsed.data
      : null;
    if (!Array.isArray(items)) throw new Error("JSON должен содержать массив строк");
    const headers = Array.isArray(items[0]) ? items[0] : [...new Set(items.flatMap((item) => Object.keys(item || {})))];
    const rowCount = Array.isArray(items[0]) ? Math.max(0, items.length - 1) : items.length;
    assertTableCapacity(rowCount, rowCount * headers.length);
    if (items.length && Array.isArray(items[0])) return { headers: items[0].map(text), rows: items.slice(1), rowCount: items.length - 1 };
    return { headers, rows: items.map((item) => headers.map((header) => item?.[header] ?? "")), rowCount };
  }
  const rows = parseDelimited(source, detectDelimiter(source, file.name));
  if (!rows.length) throw new Error("Файл не содержит строк");
  const headers = rows.shift().map(text);
  assertTableCapacity(rows.length, (rows.length + 1) * headers.length);
  return { headers, rows, rowCount: rows.length };
}

export async function readTablePreview(file, { maxBytes = 2 * 1024 * 1024, maxRows = 80, sheetName = "" } = {}) {
  if (!file) throw new Error("Файл не выбран");
  assertSourceFileCapacity(file);
  if (/\.xls$/i.test(file.name)) return readLegacyXls(file, { maxRows, sheetName });
  if (/\.(xlsx|xlsm)$/i.test(file.name)) return readXlsx(file, { maxRows, sheetName });
  if (/\.json$/i.test(file.name)) {
    let headers = null;
    let rowCount = null;
    const rows = [];
    for await (const batch of jsonRowBatches(file, {
      batchSize: Math.max(1, maxRows + 1),
      onHeaders: (value) => { headers = value.headers; rowCount = value.rowCount; },
    })) {
      rows.push(...batch.slice(0, Math.max(0, maxRows - rows.length)));
      if (rows.length >= maxRows) break;
    }
    return { headers: headers || [], rows, rowCount, preview: true };
  }
  if (/\.(csv|tsv|txt)$/i.test(file.name)) {
    const sourceFile = typeof file.slice === "function" && Number(file.size || 0) > maxBytes
      ? file.slice(0, maxBytes)
      : file;
    const source = await readTextFile(sourceFile);
    const parsed = parseDelimited(source, detectDelimiter(source, file.name), { maxRows: maxRows + 1, truncate: true });
    const rows = parsed;
    if (!rows.length) throw new Error("Файл не содержит строк");
    const headers = rows.shift().map(text);
    const truncated = Boolean(rows.truncated) || Number(file.size || 0) > maxBytes;
    return {
      headers,
      rows: rows.slice(0, maxRows),
      rowCount: truncated ? null : rows.length,
      preview: true,
    };
  }
  const table = await readTable(file);
  return { ...table, rows: table.rows.slice(0, maxRows), preview: true };
}

function dateSample(value) {
  return /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[./-]\d{1,2}[./-]\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d+(?:\.\d+)?)$/.test(value) && Boolean(normalizeDate(value));
}

function sampleScore(rows, index, field) {
  const sample = rows.slice(0, 80).map((row) => row[index]).filter((value) => text(value));
  if (!sample.length) return 0;
  const fit = (predicate) => sample.filter((value) => predicate(String(value).trim())).length / sample.length;
  if (field.toLocaleLowerCase().includes("mac")) return fit(normalizeMac);
  if (field.toLocaleLowerCase().includes("ip")) return fit(normalizeIp);
  if (field === "authenticationTime") return fit(dateSample);
  if (field === "switchPort") return fit((value) => /^(?:Gi|Fa|Eth|Te|Po|Gig(?:abit)?Ethernet|FastEthernet|Ethernet)\s*\d+(?:\/\d+)*(?:\.\d+)?$|^\d+(?:\/\d+)*$/i.test(value));
  if (field === "manufacturer") {
    const vendors = ["intel", "apple", "samsung", "cisco", "dell", "hp", "hewlett", "microsoft", "google", "huawei", "xiaomi", "lenovo", "juniper", "netgear", "tplink", "tp-link", "raspberry"];
    return fit((value) => vendors.some((vendor) => value.toLocaleLowerCase("ru-RU").includes(vendor)));
  }
  if (field === "room" || field === "floor") {
    const hints = field === "room"
      ? ["room", "office", "cabinet", "серверная", "офис", "этаж", "кабинет", "помещ"]
      : ["floor", "этаж"];
    return fit((value) => hints.some((hint) => value.toLocaleLowerCase("ru-RU").includes(hint)));
  }
  if (field === "address" || field === "physicalAddress") {
    return fit((value) => /^(?:\d{1,5}\s+\S+|ул\.?\s|улица\s|проспект\s|пр-т\s|шоссе\s|street\s|st\.?\s)/i.test(value));
  }
  if (field === "locationPath") return fit((value) => value.split(/[;,/]/).filter((part) => text(part)).length >= 2);
  if (["id", "deviceId", "serial", "smartroomId"].includes(field)) {
    const distinctRatio = new Set(sample.map((value) => keyText(value))).size / sample.length;
    const formattedRatio = fit((value) => {
      if (normalizeMac(value) || normalizeIp(value) || dateSample(value)) return false;
      if (field === "serial") return /^(?:SN|SER|S\/N)[-_ ]?[A-Z0-9-]{3,}$/i.test(value) || (/^(?=.*[A-Z])(?=.*\d)[A-Z0-9._/-]{6,}$/i.test(value));
      if (field === "deviceId") return /^(?:DEV|DEVICE|ID)[-_ :#]?[A-Z0-9-]{3,}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
      if (field === "smartroomId") return /^(?:SR|SMARTROOM|ROOM)[-_ :#]?[A-Z0-9-]{2,}$/i.test(value);
      return /^(?:ID|INTERNAL)[-_ :#]?[A-Z0-9-]{3,}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
    });
    return Math.min(distinctRatio, formattedRatio);
  }
  if (field === "hostname") return fit((value) => /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/i.test(value) && !normalizeIp(value) && !/^(?:SN|SER|S\/N)[-_ ]/i.test(value));
  if (field === "model") {
    return fit((value) => value.length >= 3 && /[a-zа-я]/i.test(value) && /\d/.test(value) && !normalizeMac(value) && !normalizeIp(value) && !dateSample(value));
  }
  if (field === "deviceType") return fit((value) => /\b(?:switch|router|firewall|printer|server|camera|access point|телефон|коммутатор|маршрутизатор|принтер|сервер|камера)\b/i.test(value));
  if (field === "businessUnit") return fit((value) => /\b(?:тб|банк|business unit|territorial bank)\b/i.test(value));
  if (field === "city") return fit((value) => /\b(?:город|г\.|москва|санкт-петербург|новосибирск|екатеринбург|казань|city)\b/i.test(value));
  if (field === "site") return fit((value) => /\b(?:площадка|site|филиал|branch)\b/i.test(value));
  return 0;
}

const MAPPING_KEYWORDS = Object.freeze({
  id: ["internal", "внутренний", "asset", "record", "записи"],
  mac: ["mac", "hardware", "ethernet", "device", "client", "идентификатор", "адрес"],
  mac2: ["secondary", "additional", "second", "дополнительный", "второй", "интерфейс", "mac"],
  manufacturer: ["vendor", "manufacturer", "brand", "maker", "producer", "производитель", "бренд"],
  model: ["model", "device", "type", "equipment", "platform", "series", "модель", "устройство", "тип", "оборудование"],
  deviceType: ["device", "model", "equipment", "type", "category", "тип", "категория"],
  switchIp: ["switch", "gateway", "node", "router", "uplink", "коммутатор", "шлюз", "узел", "маршрутизатор"],
  ip: ["ip", "host", "client", "endpoint", "address", "хост", "клиент", "устройства"],
  address: ["address", "location", "place", "site", "building", "rack", "street", "адрес", "локация", "место", "площадка", "здание", "улица", "шкаф"],
  physicalAddress: ["address", "location", "place", "site", "building", "rack", "street", "адрес", "локация", "место", "здание", "улица", "шкаф"],
  locationPath: ["location", "path", "place", "hierarchy", "локация", "путь", "место", "иерархия", "помещение"],
  room: ["room", "office", "cabinet", "floor", "auditorium", "помещение", "комната", "офис", "кабинет", "этаж", "аудитория"],
  smartroomId: ["smartroom", "smart", "room", "id", "смартрум", "помещения", "комнаты"],
  switchPort: ["port", "interface", "iface", "ifname", "if", "порт", "интерфейс"],
  authenticationTime: ["authentication", "authorization", "auth", "time", "timestamp", "last", "аутентификация", "авторизация", "время", "последний"],
  hostname: ["hostname", "host", "dns", "fqdn", "имя", "хоста"],
  serial: ["serial", "number", "sn", "серийный", "номер"],
  deviceId: ["device", "equipment", "asset", "id", "устройства", "идентификатор"],
  deviceName: ["device", "equipment", "asset", "name", "устройства", "название", "наименование"],
  businessUnit: ["business", "unit", "bank", "territorial", "тб", "банк", "территориальный"],
  city: ["city", "город"],
  site: ["site", "branch", "площадка", "филиал", "локация"],
  floor: ["floor", "этаж"],
  reservationMac: ["reservation", "reserve", "резервация", "резервирование", "mac"],
  reservationIp: ["reservation", "reserve", "резервация", "резервирование", "ip"],
  leaseMac: ["lease", "аренда", "dhcp", "mac"],
  leaseIp: ["lease", "аренда", "dhcp", "ip"],
});

const MAPPING_NEGATIVE_KEYWORDS = Object.freeze({
  mac2: ["ip", "switch", "port", "адрес", "коммутатор", "порт"],
  ip: ["switch", "gateway", "router", "коммутатор", "шлюз", "маршрутизатор"],
  switchIp: ["host", "client", "endpoint", "address", "хост", "клиент", "устройство", "адрес"],
  address: ["ip", "mac"], physicalAddress: ["ip", "mac"], locationPath: ["ip", "mac", "port"], room: ["ip", "mac", "port", "адрес"],
  smartroomId: ["ip", "mac", "port"], model: ["ip", "mac", "port"], deviceType: ["ip", "mac", "port"],
  hostname: ["ip", "mac", "port"], serial: ["ip", "mac", "port"], deviceId: ["ip", "mac", "port", "name"],
  deviceName: ["ip", "mac", "port", "id"], authenticationTime: ["ip", "mac", "port", "name", "id"],
});

function valueProfile(rows, index) {
  const values = rows.slice(0, 80).map((row) => text(row?.[index])).filter(Boolean);
  const total = values.length;
  const isIp = (value) => Boolean(normalizeIp(value));
  const isMac = (value) => Boolean(normalizeMac(value));
  const isPort = (value) => /^(?:(?:gi|fa|te|eth|xe|ge|po|gigabitethernet|fastethernet|ethernet)\s*)?\d+(?:\/\d+){0,3}(?:\.\d+)?$/i.test(value);
  const ratio = (predicate) => total ? values.filter(predicate).length / total : 0;
  return {
    values,
    mac: ratio(isMac),
    ip: ratio(isIp),
    port: ratio(isPort),
    text: ratio((value) => !isIp(value) && !isMac(value) && !isPort(value)),
  };
}

function mappingSemanticScore(field, header, profile) {
  const words = new Set(String(header).toLocaleLowerCase("ru-RU").replaceAll("ё", "е").match(/[0-9a-zа-я]+/g) || []);
  const keywords = MAPPING_KEYWORDS[field] || [];
  const matches = keywords.filter((word) => words.has(word.replaceAll("ё", "е")));
  const negatives = (MAPPING_NEGATIVE_KEYWORDS[field] || []).filter((word) => words.has(word.replaceAll("ё", "е")));
  let score = matches.length ? Math.min(0.28, 0.12 + 0.05 * matches.length) : 0;
  const reasons = [];
  if (matches.length) reasons.push(`слова заголовка: ${matches.slice(0, 4).join(", ")}`);
  if (negatives.length) {
    score -= Math.min(0.25, 0.08 + 0.05 * negatives.length);
    reasons.push(`исключающие слова: ${negatives.slice(0, 4).join(", ")}`);
  }
  if (field === "mac" && profile.mac >= 0.8) { score += 0.22; reasons.push("значения похожи на MAC"); }
  else if (field === "mac2" && profile.mac >= 0.8 && ["secondary", "additional", "second", "дополнительный", "второй"].some((word) => words.has(word))) { score += 0.22; reasons.push("значения похожи на дополнительный MAC"); }
  else if (["ip", "switchIp", "reservationIp", "leaseIp"].includes(field) && profile.ip >= 0.8) { score += 0.18; reasons.push("значения похожи на IPv4"); }
  else if (field === "switchPort" && profile.port >= 0.75) { score += 0.18; reasons.push("значения похожи на порты коммутатора"); }
  else if (["manufacturer", "model", "deviceType", "address", "physicalAddress", "room", "smartroomId", "authenticationTime", "businessUnit", "city", "site", "floor"].includes(field) && profile.text >= 0.8) { score += 0.1; reasons.push("образец содержит описательные значения"); }
  if (field === "room" && ["room", "office", "floor", "cabinet", "помещение", "комната", "офис", "этаж", "кабинет"].some((word) => words.has(word))) { score += 0.16; reasons.push("заголовок обозначает помещение"); }
  if (["address", "physicalAddress", "locationPath"].includes(field) && ["rack", "building", "site", "street", "location", "place", "path", "шкаф", "здание", "улица", "площадка", "локация", "путь"].some((word) => words.has(word))) { score += 0.14; reasons.push("заголовок обозначает физическое расположение"); }
  if (field === "switchIp" && ["switch", "gateway", "router", "node", "коммутатор", "шлюз", "маршрутизатор"].some((word) => words.has(word))) { score += 0.18; reasons.push("заголовок обозначает сетевое оборудование"); }
  if (field === "ip" && ["host", "client", "endpoint", "хост", "клиент", "устройство"].some((word) => words.has(word))) { score += 0.18; reasons.push("заголовок обозначает конечное устройство"); }
  if (field === "model" && profile.text >= 0.8 && ["model", "series", "platform", "модель", "серия", "платформа"].some((word) => words.has(word))) { score += 0.1; reasons.push("заголовок и значения похожи на модель"); }
  return { score: Math.max(-0.25, score), reasons };
}

function mappingCandidateReason(aliasScore, sampleFit, semanticReasons) {
  const reasons = [];
  if (aliasScore) reasons.push("заголовок совпадает с названием поля");
  if (sampleFit >= 0.75) reasons.push("значения сильно подходят по типу");
  else if (sampleFit >= 0.35) reasons.push("значения частично подходят по типу");
  reasons.push(...semanticReasons);
  return reasons.join("; ") || "слабое эвристическое совпадение";
}

const MAPPING_FIELD_PRIORITY = Object.freeze([
  "id", "deviceId", "serial", "mac", "mac2", "smartroomId", "deviceName", "locationPath", "manufacturer", "deviceType",
  "model", "ip", "switchIp", "switchPort", "authenticationTime", "hostname", "address",
  "physicalAddress", "room", "businessUnit", "city", "site", "floor",
]);

function mappingConfidence(candidate) {
  if (!candidate) return 0;
  const headerSignal = candidate.aliasScore > 0 ? 55 : 0;
  return Math.round(Math.min(100, Math.max(0,
    headerSignal + candidate.sampleFit * 65 + candidate.semanticScore * 100,
  )));
}

export function detectMappingReport(headers = [], rows = [], role = "main") {
  const allowed = role === "ddio"
    ? ["reservationMac", "reservationIp", "leaseMac", "leaseIp", "deviceId"]
    : Object.keys(FIELD_LABELS).filter((field) => !field.startsWith("reservation") && !field.startsWith("lease"));
  const profiles = headers.map((_, index) => valueProfile(rows, index));
  const fieldCandidates = allowed.map((field) => {
    const aliases = ALIASES[field] || [];
    const ranked = headers.map((header, index) => {
      const normalized = keyText(header).replace(/[_-]+/g, " ");
      const aliasScore = aliases.reduce((score, alias) => {
        const candidate = keyText(alias).replace(/[_-]+/g, " ");
        return Math.max(score,
          normalized === candidate ? 100
            : candidate.length >= 4 && normalized.includes(candidate) ? 65 : 0);
      }, 0);
      const profile = profiles[index];
      const semantic = mappingSemanticScore(field, header, profile);
      const descriptiveFields = ["manufacturer", "model", "address", "physicalAddress", "locationPath", "room", "smartroomId", "authenticationTime"];
      const inferredFloor = field === "floor" && aliasScore === 0 ? 0 : sampleScore(rows, index, field);
      const sampleFit = Math.max(inferredFloor, descriptiveFields.includes(field) ? Math.min(profile.text, 0.45) : 0);
      const score = aliasScore + sampleFit * 40 + semantic.score * 100;
      const reason = mappingCandidateReason(aliasScore, sampleFit, semantic.reasons);
      const examples = rows.slice(0, 80)
        .map((row) => text(row?.[index]))
        .filter(Boolean)
        .slice(0, 3);
      return { index, score, aliasScore, sampleFit, semanticScore: semantic.score, reason, examples };
    }).sort((a, b) => b.score - a.score);
    return { field, ranked, bestScore: ranked[0]?.score || 0 };
  }).sort((left, right) => right.bestScore - left.bestScore
    || MAPPING_FIELD_PRIORITY.indexOf(left.field) - MAPPING_FIELD_PRIORITY.indexOf(right.field)
    || allowed.indexOf(left.field) - allowed.indexOf(right.field));
  const mapping = {};
  const details = {};
  const usedColumns = new Set();
  for (const { field, ranked } of fieldCandidates) {
    const candidate = ranked.find((item) => {
      const profile = profiles[item.index];
      const stableIdentity = ["id", "deviceId", "serial", "smartroomId"].includes(field);
      const samplesConflictWithIdentity = stableIdentity && (profile.mac >= 0.8 || profile.ip >= 0.8 || profile.port >= 0.8);
      const needsLabeledHeader = ["manufacturer", "model", "room"].includes(field);
      const weakSemanticOnlyMatch = needsLabeledHeader && item.aliasScore === 0 && item.semanticScore < 0.5;
      return (field === "mac2" ? item.aliasScore > 0 : item.score >= 40)
        && !usedColumns.has(item.index)
        && !samplesConflictWithIdentity
        && !weakSemanticOnlyMatch;
    });
    const best = ranked[0];
    const alternatives = ranked.filter((item) => item.score > 0).slice(0, 3).map((item) => ({
      index: item.index,
      header: text(headers[item.index]) || `Колонка ${item.index + 1}`,
      score: Math.round(item.score),
      confidence: mappingConfidence(item),
      aliasMatch: item.aliasScore > 0,
      sampleFit: item.sampleFit,
      semanticScore: item.semanticScore,
      reason: item.reason,
      examples: item.examples,
    }));
    const selectedColumnTaken = Boolean(best && usedColumns.has(best.index));
    const nearTie = Boolean(best && ranked.some((item) => item.index !== best.index && item.score > 0 && best.score - item.score < 16));
    details[field] = {
      selectedIndex: candidate?.index ?? null,
      confidence: mappingConfidence(candidate),
      recommendedIndex: best && best.score > 0 ? best.index : null,
      recommendedConfidence: mappingConfidence(best),
      recommendedScore: Math.round(best?.score || 0),
      recommendedReason: best?.reason || "нет уверенного совпадения",
      score: Math.round(candidate?.score || 0),
      sampleFit: candidate?.sampleFit || 0,
      semanticScore: candidate?.semanticScore || 0,
      reason: candidate?.reason || "нет уверенного совпадения",
      sampleCount: Math.min(80, rows.length),
      examples: candidate?.examples || [],
      alternatives,
      conflict: Boolean(selectedColumnTaken || nearTie || (best && candidate && best.index !== candidate.index)),
    };
    if (!candidate) continue;
    mapping[field] = candidate.index;
    usedColumns.add(candidate.index);
  }
  const identityFields = role === "ddio"
    ? []
    : role === "main" || role === "smartroom" || role === "single"
      ? ["id", "deviceId", "serial", "mac", "mac2"]
      : ["mac"];
  const hasStrongIdentity = identityFields.some((field) => Number.isInteger(mapping[field]));
  const validDdIoPair = role !== "ddio"
    || (Number.isInteger(mapping.reservationMac) && Number.isInteger(mapping.reservationIp))
    || (Number.isInteger(mapping.leaseMac) && Number.isInteger(mapping.leaseIp));
  return { mapping, details, hasStrongIdentity, validDdIoPair, identityFields };
}

export function detectMapping(headers = [], rows = [], role = "main") {
  return detectMappingReport(headers, rows, role).mapping;
}

export function mapToObjects(table) {
  return table.rows.map((row) => Object.fromEntries(table.headers.map((header, index) => [header, row[index] ?? ""])));
}

function filenameObservationDate(filename) {
  const name = String(filename || "");
  const yearFirst = name.match(/(?:^|\D)(20\d{2})[-_. ](0?[1-9]|1[0-2])[-_. ](0?[1-9]|[12]\d|3[01])(?:[T _-](\d{1,2})[-_.:](\d{2})(?:[-_.:](\d{2}))?)?(?:\D|$)/);
  const dayFirst = name.match(/(?:^|\D)(0?[1-9]|[12]\d|3[01])[-_. ](0?[1-9]|1[0-2])[-_. ](20\d{2})(?:[T _-](\d{1,2})[-_.:](\d{2})(?:[-_.:](\d{2}))?)?(?:\D|$)/);
  const compactYearFirst = name.match(/(?:^|\D)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[_-]?(\d{2})(\d{2})(\d{2})?)?(?:\D|$)/);
  const compactDayFirst = name.match(/(?:^|\D)(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])(20\d{2})(?:[_-]?(\d{2})(\d{2})(\d{2})?)?(?:\D|$)/);
  const parts = yearFirst
    ? { year: yearFirst[1], month: yearFirst[2], day: yearFirst[3], hour: yearFirst[4], minute: yearFirst[5], second: yearFirst[6] }
    : dayFirst
      ? { year: dayFirst[3], month: dayFirst[2], day: dayFirst[1], hour: dayFirst[4], minute: dayFirst[5], second: dayFirst[6] }
      : compactYearFirst
        ? { year: compactYearFirst[1], month: compactYearFirst[2], day: compactYearFirst[3], hour: compactYearFirst[4], minute: compactYearFirst[5], second: compactYearFirst[6] }
        : compactDayFirst
          ? { year: compactDayFirst[3], month: compactDayFirst[2], day: compactDayFirst[1], hour: compactDayFirst[4], minute: compactDayFirst[5], second: compactDayFirst[6] }
          : null;
  if (!parts) return "";
  const hour = Number(parts.hour || 0);
  const minute = Number(parts.minute || 0);
  const second = Number(parts.second || 0);
  if (hour > 23 || minute > 59 || second > 59) return "";
  const stamp = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, minute, second);
  const parsed = new Date(stamp);
  if (parsed.getUTCFullYear() !== Number(parts.year)
    || parsed.getUTCMonth() !== Number(parts.month) - 1
    || parsed.getUTCDate() !== Number(parts.day)) return "";
  return parsed.toISOString();
}

export function fileObservationDate(file, workbookCreatedAt = "", workbookModifiedAt = "") {
  const filenameDate = filenameObservationDate(file?.name);
  if (filenameDate) return { date: filenameDate, source: "filename" };
  if (/\.(xlsx|xlsm|xls)$/i.test(file?.name || "")) {
    const workbookKind = /\.xls$/i.test(file?.name || "") ? "xls" : "xlsx";
    const createdAt = normalizeDate(workbookCreatedAt);
    if (createdAt) return { date: createdAt, source: `${workbookKind}.created` };
    const modifiedAt = normalizeDate(workbookModifiedAt);
    if (modifiedAt) return { date: modifiedAt, source: `${workbookKind}.modified` };
  }
  const lastModified = Number(file?.lastModified || 0);
  if (lastModified > 0 && Number.isFinite(lastModified)) {
    const lastModifiedDate = normalizeDate(new Date(lastModified));
    if (lastModifiedDate) return { date: lastModifiedDate, source: "file.lastModified" };
  }
  return { date: "", source: "import-time" };
}

