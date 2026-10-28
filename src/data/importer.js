import { firstMac, keyText, normalizeDate, normalizeIp, normalizeMac, normalizeDevice, text } from "../core/normalize.js";
import { stableId } from "../core/identity.js";
import { normalizeIpEnrichmentSettings, normalizeIpMappings } from "../core/ip-mapping.js";
import { normalizeMacPrefix } from "../core/model-knowledge.js";
import { normalizeOuiPrefix } from "../core/ieee-registry.js";
import { inventoryColumnConfigFromLegacyPreferences } from "../core/inventory-columns.js";
import { normalizeHistoryEnrichmentSettings, normalizeLegacyWorkspaceFiles } from "../core/history-enrichment-settings.js";
import { assertBrowserHeapCapacity, assertBrowserHeapReserve, assertSharedStringCapacity, assertSourceFileCapacity, assertTableCapacity, assertZipDirectoryCapacity, assertZipDirectoryHeaderCapacity, IMPORT_LIMITS } from "../core/import-limits.js";
import { PORTABLE_ARCHIVE_RECORD_COLLECTIONS } from "../core/portable-archive.js";

const ZIP_CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, initial) => {
  let crc = initial;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const SUPPORTED_ZIP_FLAGS = 0x080e;
const fileObservationDateOverrides = new WeakMap();

function updateZipCrc32(crc, bytes) {
  let next = crc;
  for (const byte of bytes) next = ZIP_CRC32_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
  return next >>> 0;
}

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
  possibleIps: "Возможные IP (DDIO)",
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
  possibleIps: ["possible ips", "possible ip", "возможные ip", "список ip"],
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
  let fieldStart = true;
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
    if (char === '"' && fieldStart) { quoted = true; fieldStart = false; hasContent = true; }
    else if (char === '"') { fieldStart = false; hasContent = true; }
    else if (char === "\r" || char === "\n") {
      if (hasContent || Object.values(counts).some(Boolean)) records.push(counts);
      counts = Object.fromEntries([";", ",", "\t", "|"].map((delimiter) => [delimiter, 0]));
      hasContent = false;
      fieldStart = true;
    } else {
      if (Object.hasOwn(counts, char)) { counts[char] += 1; fieldStart = true; }
      else fieldStart = false;
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

function normalizeDelimitedRowWidth(row, headers, rowNumber) {
  if (row.length > headers.length) {
    throw new SyntaxError(`CSV: строка ${rowNumber} содержит ${row.length} полей при ${headers.length} заголовках`);
  }
  while (row.length < headers.length) row.push("");
}

export function parseDelimited(source, delimiter = ",", limits = {}) {
  const maxRows = Math.max(1, Number(limits.maxRows || 150_000));
  const maxCells = Math.max(1, Number(limits.maxCells || 1_500_000));
  const truncate = Boolean(limits.truncate);
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  let fieldStart = true;
  let cells = 0;
  let truncated = false;
  const appendCellCharacter = (char) => {
    if (value.length >= IMPORT_LIMITS.cellCharacters) {
      throw new Error(`CSV: значение ячейки превышает ${IMPORT_LIMITS.cellCharacters.toLocaleString("ru-RU")} символов`);
    }
    value += char;
  };
  const addCell = () => {
    if (truncated) { value = ""; row = []; return; }
    cells += 1;
    if (cells > maxCells) throw new Error(`Слишком много ячеек: предел ${maxCells.toLocaleString("ru-RU")}`);
    row.push(value);
    value = "";
    fieldStart = true;
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
        appendCellCharacter('"');
        index += 1;
      } else if (quoted) quoted = false;
      else if (fieldStart) { quoted = true; fieldStart = false; }
      else { if (!truncated) appendCellCharacter('"'); fieldStart = false; }
    } else if (char === delimiter && !quoted) {
      addCell();
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      addCell();
      addRow();
    } else if (!truncated) { appendCellCharacter(char); fieldStart = false; }
  }
  if (quoted && !limits.allowIncomplete && !truncated) throw new SyntaxError("CSV: незакрытая кавычка в конце файла");
  addCell();
  addRow();
  assertTableCapacity(rows.length, cells);
  if (truncated) rows.truncated = true;
  return rows;
}

function decodeLatin1(bytes) {
  let output = "";
  const chunkSize = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(bytes.length, offset + chunkSize);
    output += String.fromCharCode(...bytes.subarray(offset, end));
  }
  return output;
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

async function* delimitedRowBatches(file, { batchSize = 500, signal, onHeaders = () => {}, onProgress = () => {}, allowEmptyData = false } = {}) {
  const { encoding, sample } = await delimitedTextEncoding(file, signal);
  const delimiter = detectDelimiter(sample, file.name);
  const decoder = textDecoder(encoding);
  let headers = null;
  let row = [];
  let value = "";
  let quoted = false;
  let fieldStart = true;
  let quotePending = false;
  let skipLf = false;
  let cells = 0;
  let rowsRead = 0;
  let batch = [];
  let ready = null;
  const appendCellCharacter = (char) => {
    if (value.length >= IMPORT_LIMITS.cellCharacters) {
      throw new Error(`CSV: значение ячейки превышает ${IMPORT_LIMITS.cellCharacters.toLocaleString("ru-RU")} символов`);
    }
    value += char;
  };
  const addCell = () => {
    cells += 1;
    if (cells > IMPORT_LIMITS.cellCount) throw new Error(`Слишком много ячеек: предел ${IMPORT_LIMITS.cellCount.toLocaleString("ru-RU")}`);
    row.push(value);
    value = "";
    fieldStart = true;
  };
  const addRow = () => {
    if (!row.some((cell) => text(cell))) { row = []; return; }
    if (!headers) {
      headers = row.map(text);
      assertTableCapacity(0, cells);
      onHeaders({ headers, sheet: "", workbookCreatedAt: "", workbookModifiedAt: "" });
    } else {
      normalizeDelimitedRowWidth(row, headers, rowsRead + 2);
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
          if (char === '"') { appendCellCharacter('"'); quotePending = false; continue; }
          quoted = false;
          quotePending = false;
        } else {
          if (char === '"') quotePending = true;
          else appendCellCharacter(char);
          continue;
        }
      }
      if (skipLf) {
        skipLf = false;
        if (char === "\n") continue;
      }
      if (char === '"' && fieldStart) { quoted = true; fieldStart = false; }
      else if (char === '"') { appendCellCharacter('"'); fieldStart = false; }
      else if (char === delimiter) addCell();
      else if (char === "\r" || char === "\n") {
        addCell();
        addRow();
        skipLf = char === "\r";
        if (ready) { yield ready; ready = null; }
      } else { appendCellCharacter(char); fieldStart = false; }
    }
  };
  for await (const bytes of fileByteChunks(file, 64 * 1024, signal)) {
    for (const batchRows of consume(decoder.decode(bytes, { stream: true }))) yield batchRows;
  }
  for (const batchRows of consume(decoder.decode())) yield batchRows;
  if (quotePending) { quoted = false; quotePending = false; }
  if (quoted) throw new SyntaxError("CSV: незакрытая кавычка в конце файла");
  addCell();
  addRow();
  if (ready) {
    yield ready;
    ready = null;
  }
  if (!headers) throw new Error("Файл не содержит строк");
  if (rowsRead === 0 && !allowEmptyData) throw new Error("Файл не содержит строк данных");
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
        if (stringRaw.length >= IMPORT_LIMITS.cellCharacters + 2) {
          throw new Error(`JSON: значение ячейки превышает ${IMPORT_LIMITS.cellCharacters.toLocaleString("ru-RU")} символов`);
        }
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

const MAX_JSON_NESTING_DEPTH = 128;

function assertJsonNestingDepth(token, depth) {
  if ((token?.type === "[" || token?.type === "{") && depth >= MAX_JSON_NESTING_DEPTH) {
    throw new SyntaxError(`JSON: превышена максимальная глубина вложенности (${MAX_JSON_NESTING_DEPTH})`);
  }
}

async function parseJsonValue(reader, first = undefined, depth = 0) {
  const token = first === undefined ? await reader.take() : first;
  if (!token) throw new SyntaxError("JSON неожиданно закончился");
  assertJsonNestingDepth(token, depth);
  if (token.type === "value" || token.type === "string") return token.value;
  if (token.type === "[") {
    const values = [];
    let next = await reader.take();
    if (next?.type === "]") return values;
    while (next) {
      values.push(await parseJsonValue(reader, next, depth + 1));
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
      value[key.value] = await parseJsonValue(reader, undefined, depth + 1);
      const separator = await reader.take();
      if (separator?.type === "}") return value;
      if (separator?.type !== ",") throw new SyntaxError("JSON: ожидалась запятая в объекте");
      key = await reader.take();
    }
    throw new SyntaxError("JSON: не закрыт объект");
  }
  throw new SyntaxError("JSON: ожидалось значение");
}

async function skipJsonValue(reader, first = undefined, depth = 0) {
  const token = first === undefined ? await reader.take() : first;
  if (!token) throw new SyntaxError("JSON неожиданно закончился");
  assertJsonNestingDepth(token, depth);
  if (token.type === "value" || token.type === "string") return;
  if (token.type === "[") {
    let next = await reader.peek();
    if (next?.type === "]") { await reader.take(); return; }
    while (true) {
      await skipJsonValue(reader, undefined, depth + 1);
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
      await skipJsonValue(reader, undefined, depth + 1);
      const separator = await reader.take();
      if (separator?.type === "}") return;
      if (separator?.type !== ",") throw new SyntaxError("JSON: ожидалась запятая в объекте");
      if (!await reader.peek()) throw new SyntaxError("JSON: не закрыт объект");
    }
  }
  throw new SyntaxError("JSON: ожидалось значение");
}

const SOURCE_FILE_ARCHIVE_CHUNK_BYTES = 192 * 1024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const legacyXlsSheetNames = new WeakMap();

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
  if (header.format === "mac-analyzer-devices-json" && header.version === 2) return { ...header, sourceFormat: header.format };
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
  const mac = firstMac(value.mac, value.macFormatted, value.mac_formatted);
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
    if (separator?.type === "}") { key = separator; break; }
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
        || (metadata.type !== undefined && (typeof metadata.type !== "string" || metadata.type.length > 256))
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

async function* portableLegacyTaskQueueFileEvents(reader, signal, firstToken) {
  if (firstToken?.type !== "{") throw new Error("Некорректный файл очереди расписания в архиве");
  const metadata = Object.create(null);
  const seen = new Set();
  let chunksStarted = false;
  let actualSize = 0;
  let key = await reader.take();
  while (key && key.type !== "}") {
    if (key.type !== "string" || (await reader.take())?.type !== ":") throw new SyntaxError("Некорректная структура файла очереди расписания");
    if (seen.has(key.value)) throw new Error(`Файл очереди расписания содержит повторное поле ${key.value}`);
    seen.add(key.value);
    if (key.value !== "chunks") {
      if (chunksStarted) throw new Error("Метаданные файла очереди должны идти до блоков файла");
      metadata[key.value] = await parseJsonValue(reader);
    } else {
      chunksStarted = true;
      if (typeof metadata.id !== "string" || !metadata.id || metadata.id.length > 512
        || typeof metadata.taskId !== "string" || !metadata.taskId || metadata.taskId.length > 512
        || typeof metadata.filename !== "string" || !metadata.filename || metadata.filename.length > 1024
        || (metadata.type !== undefined && (typeof metadata.type !== "string" || metadata.type.length > 256))
        || !Number.isSafeInteger(metadata.size) || metadata.size < 1) {
        throw new Error("Некорректные метаданные файла очереди расписания");
      }
      if ((await reader.take())?.type !== "[") throw new Error("Блоки файла очереди должны быть массивом");
      yield { type: "legacyTaskQueueFileStart", metadata: { ...metadata, type: String(metadata.type || "application/octet-stream") } };
      let chunk = await reader.take();
      if (chunk?.type !== "]") {
        while (chunk) {
          if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
          const byteLength = archivedSourceChunkSize(chunk.value);
          if (byteLength === 0) throw new Error("Пустой блок файла очереди в архиве");
          actualSize += byteLength;
          if (actualSize > metadata.size) throw new Error("Размер файла очереди превышает объявленное значение");
          yield { type: "legacyTaskQueueFileChunk", chunk: chunk.value };
          const separator = await reader.take();
          if (separator?.type === "]") { chunk = separator; break; }
          if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая между блоками файла очереди");
          if (byteLength !== SOURCE_FILE_ARCHIVE_CHUNK_BYTES) throw new Error("Неполный промежуточный блок файла очереди");
          chunk = await reader.take();
        }
      }
      if (chunk?.type !== "]") throw new SyntaxError("JSON архива: не закрыт массив блоков файла очереди");
    }
    const separator = await reader.take();
    if (separator?.type === "}") { key = separator; break; }
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая в файле очереди");
    key = await reader.take();
  }
  if (key?.type !== "}" || !chunksStarted || !seen.has("chunks")) throw new Error("В архиве отсутствуют блоки файла очереди");
  if (actualSize !== metadata.size) throw new Error("Размер файла очереди не совпадает");
  yield { type: "legacyTaskQueueFileEnd" };
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

async function* legacyWorkspaceRuleEvents(reader, collection, { batchSize, signal, onProgress, processedAt }) {
  if ((await reader.take())?.type !== "{") throw new Error(`Некорректная таблица локальных правил ${collection} в архиве MAC Analyzer Pro`);
  let key = await reader.take();
  let batch = [];
  let recordsRead = 0;
  while (key && key.type !== "}") {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    if (key.type !== "string" || (await reader.take())?.type !== ":") throw new SyntaxError("JSON архива: неверное локальное правило");
    const prefix = collection === "oui" ? normalizeOuiPrefix(key.value) : normalizeMacPrefix(key.value);
    const value = await parseJsonValue(reader);
    if (!prefix || typeof value !== "string" || !text(value)) {
      throw new Error(`Локальное правило ${key.value} нельзя перенести в Next без потери поведения`);
    }
    batch.push(collection === "oui"
      ? { prefix, vendor: text(value), source: "MAC Analyzer Pro" }
      : { prefix, model: text(value), updatedAt: processedAt || new Date().toISOString(), source: "MAC Analyzer Pro" });
    recordsRead += 1;
    if (batch.length >= batchSize) {
      onProgress({ collection, recordsRead, batchSize: batch.length });
      yield { type: "records", collection, records: batch };
      batch = [];
    }
    const separator = await reader.take();
    if (separator?.type === "}") { key = separator; break; }
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая между локальными правилами");
    key = await reader.take();
  }
  if (batch.length) {
    onProgress({ collection, recordsRead, batchSize: batch.length });
    yield { type: "records", collection, records: batch };
  }
  if (key?.type !== "}") throw new SyntaxError("JSON архива: не закрыта таблица локальных правил");
}

async function readLegacyWorkspaceColumnList(reader, name) {
  if ((await reader.take())?.type !== "[") throw new Error(`Список столбцов ${name} в архиве MAC Analyzer Pro должен быть массивом`);
  const values = [];
  let item = await reader.take();
  while (item && item.type !== "]") {
    if (item.type !== "string" || values.length >= 512) throw new Error(`Список столбцов ${name} содержит недопустимое значение или слишком много пунктов`);
    values.push(item.value);
    const separator = await reader.take();
    if (separator?.type === "]") return values;
    if (separator?.type !== ",") throw new SyntaxError(`JSON архива: ожидалась запятая в ${name}`);
    item = await reader.take();
  }
  if (item?.type !== "]") throw new SyntaxError(`JSON архива: не закрыт список ${name}`);
  return values;
}

async function readLegacyWorkspaceFileMapping(reader) {
  const first = await reader.take();
  if (first?.type === "null") return {};
  if (first?.type !== "{") throw new Error("Сопоставление колонок исходного файла должно быть объектом");
  const mapping = Object.create(null);
  let fieldCount = 0;
  let key = await reader.take();
  while (key && key.type !== "}") {
    if (key.type !== "string" || key.value.length > 80 || (await reader.take())?.type !== ":") throw new SyntaxError("Некорректное поле сопоставления колонок");
    if (Object.hasOwn(mapping, key.value)) throw new Error(`Повторное поле сопоставления ${key.value}`);
    if (++fieldCount > 128) throw new Error("В сводке файла слишком много сопоставлений колонок");
    const value = await reader.take();
    const index = value?.type === "value" && typeof value.value === "number" ? value.value : NaN;
    if (Number.isSafeInteger(index) && index >= 0 && index <= 16_383) mapping[key.value] = index;
    else if (value?.type === "value" && value.value === null || value?.type === "string" && value.value === "") { /* unmapped field */ }
    else throw new Error(`Индекс колонки для ${key.value} некорректен`);
    const separator = await reader.take();
    if (separator?.type === "}") return mapping;
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая в сопоставлениях колонок");
    key = await reader.take();
  }
  if (key?.type !== "}") throw new SyntaxError("JSON архива: не закрыты сопоставления колонок");
  return mapping;
}

async function readLegacyWorkspaceFile(reader, firstToken) {
  if (firstToken?.type !== "{") throw new Error("Сводка исходного файла должна быть объектом");
  const file = Object.create(null);
  const seen = new Set();
  let key = await reader.take();
  while (key && key.type !== "}") {
    if (key.type !== "string" || (await reader.take())?.type !== ":") throw new SyntaxError("Некорректная сводка исходного файла");
    if (seen.has(key.value)) throw new Error(`Сводка исходного файла содержит повторное поле ${key.value}`);
    seen.add(key.value);
    if (key.value === "mapping") file.mapping = await readLegacyWorkspaceFileMapping(reader);
    else if (["id", "name", "role", "sheet", "createdAt", "fileDateSource", "rowCount"].includes(key.value)) {
      file[key.value] = await parseJsonValue(reader);
    } else await skipJsonValue(reader);
    const separator = await reader.take();
    if (separator?.type === "}") return normalizeLegacyWorkspaceFiles([file])[0];
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая в сводке файла");
    key = await reader.take();
  }
  if (key?.type !== "}") throw new SyntaxError("JSON архива: не закрыта сводка файла");
  return normalizeLegacyWorkspaceFiles([file])[0];
}

async function readLegacyWorkspaceFiles(reader) {
  if ((await reader.take())?.type !== "[") throw new Error("Список сводок файлов должен быть массивом");
  const files = [];
  let file = await reader.take();
  while (file && file.type !== "]") {
    if (files.length >= 500) throw new Error("В архиве слишком много сводок исходных файлов");
    files.push(await readLegacyWorkspaceFile(reader, file));
    const separator = await reader.take();
    if (separator?.type === "]") return files;
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая между сводками файлов");
    file = await reader.take();
  }
  if (file?.type !== "]") throw new SyntaxError("JSON архива: не закрыт список сводок файлов");
  return files;
}

async function* legacyWorkspaceSettingEvents(reader, signal, onProgress) {
  if ((await reader.take())?.type !== "{") throw new Error("Некорректная рабочая область архива MAC Analyzer Pro");
  const keys = new Map([
    ["theme", "legacyAppSetting:theme"],
    ["dashboardSettings", "legacyAppSetting:dashboard"],
    ["historyEnrichmentSettings", "historyEnrichmentSettings"],
    ["ipEnrichmentSettings", "ipEnrichmentSettings"],
    ["vendorDetectorSettings", "legacyAppSetting:vendor_detector"],
    ["ipMappings", "ipAddressMappings"],
  ]);
  let visibleColumns = null;
  let columnOrder = null;
  let ouiLength = 3;
  let sourceFiles = null;
  let key = await reader.take();
  if (key?.type === "}") return;
  while (key) {
    if (key.type !== "string" || (await reader.take())?.type !== ":") throw new SyntaxError("JSON архива: неверное поле рабочей области");
    const settingKey = keys.get(key.value);
    if (key.value === "localVendorMappings" || key.value === "localModelMappings") {
      yield* legacyWorkspaceRuleEvents(reader, key.value === "localVendorMappings" ? "oui" : "mac5Models", {
        batchSize: 500, signal, onProgress, processedAt: "",
      });
    } else if (key.value === "visibleColumns") {
      visibleColumns = await readLegacyWorkspaceColumnList(reader, key.value);
    } else if (key.value === "columnOrder") {
      columnOrder = await readLegacyWorkspaceColumnList(reader, key.value);
    } else if (key.value === "ouiLength") {
      const value = await parseJsonValue(reader);
      if (!Number.isInteger(value) || value < 3 || value > 6) throw new Error("Длина OUI в архиве MAC Analyzer Pro должна быть от 3 до 6 байт");
      ouiLength = value;
    } else if (key.value === "files") {
      sourceFiles = await readLegacyWorkspaceFiles(reader);
    } else if (settingKey) {
      const parsed = await parseJsonValue(reader);
      const value = key.value === "ipMappings" ? normalizeIpMappings(parsed)
        : key.value === "historyEnrichmentSettings" ? normalizeHistoryEnrichmentSettings(parsed)
        : key.value === "ipEnrichmentSettings" ? normalizeIpEnrichmentSettings(parsed) : parsed;
      onProgress({ collection: "settings", recordsRead: 1, batchSize: 1 });
      yield { type: "records", collection: "settings", records: [{ key: settingKey, value }] };
    } else await skipJsonValue(reader);
    const separator = await reader.take();
    if (separator?.type === "}") break;
    if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая в рабочей области");
    key = await reader.take();
  }
  if (visibleColumns || columnOrder) {
    const toInventoryColumn = (key) => key === "macFormatted" ? "mac" : key;
    const config = inventoryColumnConfigFromLegacyPreferences({
      visible: (visibleColumns || columnOrder || []).map(toInventoryColumn),
      order: (columnOrder || visibleColumns || []).map(toInventoryColumn),
      ouiLength,
    });
    if (!config) throw new Error("Настройки столбцов MAC Analyzer Pro не содержат совместимых колонок");
    onProgress({ collection: "settings", recordsRead: 1, batchSize: 1 });
    yield { type: "records", collection: "settings", records: [{ key: "inventoryColumnConfig", value: config }] };
  }
  if (sourceFiles) {
    onProgress({ collection: "settings", recordsRead: 1, batchSize: 1 });
    yield { type: "records", collection: "settings", records: [{ key: "legacyAppSetting:sourceFiles", value: normalizeLegacyWorkspaceFiles(sourceFiles) }] };
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
  let referenceCurrentDevices = 0;
  let referenceInvalidRows = 0;
  let referenceCurrentAnalysisPresent = false;
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
    } else if (sourceFormat === "mac-analyzer-devices-json" && key.value === "devices") {
      yield* portableMappedRecordEvents(reader, "inventory", { batchSize, signal, onProgress, transform: legacyReportDevice });
    } else if (sourceFormat === "mac-analyzer-full-json" && key.value === "currentDevices") {
      referenceCurrentAnalysisPresent = true;
      for await (const event of portableMappedRecordEvents(reader, "referenceCurrentDevices", {
        batchSize: 500, signal, onProgress, transform: legacyReportDevice,
      })) {
        referenceCurrentDevices += event.records.length;
        yield event;
      }
    } else if (sourceFormat === "mac-analyzer-full-json" && key.value === "invalidRows") {
      referenceCurrentAnalysisPresent = true;
      for await (const event of portableMappedRecordEvents(reader, "referenceInvalidRows", {
        batchSize: 500, signal, onProgress, transform: (row) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Некорректная строка ошибок в архиве MAC Analyzer Pro");
          return row;
        },
      })) {
        referenceInvalidRows += event.records.length;
        yield event;
      }
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
    } else if (key.value === "legacyTaskQueueFiles") {
      if ((await reader.take())?.type !== "[") throw new Error("Некорректная структура архива: legacyTaskQueueFiles");
      let next = await reader.take();
      while (next && next.type !== "]") {
        yield* portableLegacyTaskQueueFileEvents(reader, signal, next);
        recordsRead += 1;
        onProgress({ collection: "legacyTaskQueueFiles", recordsRead, batchSize: 1 });
        const separator = await reader.take();
        if (separator?.type === "]") { next = separator; break; }
        if (separator?.type !== ",") throw new SyntaxError("JSON архива: ожидалась запятая между файлами очереди");
        next = await reader.take();
      }
      if (next?.type !== "]") throw new SyntaxError("JSON архива: не закрыт массив legacyTaskQueueFiles");
    } else if (PORTABLE_ARCHIVE_RECORD_COLLECTIONS.includes(key.value)) {
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
  if (sourceFormat === "mac-analyzer-full-json" && referenceCurrentAnalysisPresent) {
    const archiveStamp = exportedAt.replace(/\D/g, "");
    yield {
      type: "referenceCurrentAnalysis",
      id: `reference-current-${archiveStamp || crypto.randomUUID()}-${referenceCurrentDevices}-${referenceInvalidRows}`,
      processedAt: exportedAt,
      deviceCount: referenceCurrentDevices,
      invalidCount: referenceInvalidRows,
    };
  }
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

function findEocd(bytes, absoluteOffset = 0) {
  let fallback = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b || bytes[offset + 2] !== 0x05 || bytes[offset + 3] !== 0x06) continue;
    const commentLength = bytes[offset + 20] | (bytes[offset + 21] << 8);
    const directoryBytes = bytes[offset + 12] | (bytes[offset + 13] << 8) | (bytes[offset + 14] << 16) | (bytes[offset + 15] << 24);
    const directoryOffset = bytes[offset + 16] | (bytes[offset + 17] << 8) | (bytes[offset + 18] << 16) | (bytes[offset + 19] << 24);
    if (offset + 22 + commentLength !== bytes.length) continue;
    if (directoryOffset + directoryBytes === absoluteOffset + offset) return offset;
    if (fallback < 0) fallback = offset;
  }
  if (fallback >= 0) return fallback;
  throw new Error("XLSX: не найдена ZIP-директория");
}

async function zipDirectory(file) {
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = await file.slice(tailStart).arrayBuffer();
  const tailBytes = new Uint8Array(tail);
  const tailView = new DataView(tail);
  const eocd = findEocd(tailBytes, tailStart);
  const diskNumber = tailView.getUint16(eocd + 4, true);
  const directoryDisk = tailView.getUint16(eocd + 6, true);
  const entriesOnDisk = tailView.getUint16(eocd + 8, true);
  const entries = tailView.getUint16(eocd + 10, true);
  const directoryBytes = tailView.getUint32(eocd + 12, true);
  const directoryOffset = tailView.getUint32(eocd + 16, true);
  const absoluteEocdOffset = tailStart + eocd;
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entries) {
    throw new Error("XLSX: многотомный ZIP-каталог не поддерживается");
  }
  assertZipDirectoryHeaderCapacity(entries, directoryBytes);
  if (directoryOffset + directoryBytes > file.size) throw new Error("XLSX: каталог выходит за границы файла");
  if (directoryOffset + directoryBytes !== absoluteEocdOffset) throw new Error("XLSX: ZIP-каталог не совпадает с границами EOCD");
  const directory = await file.slice(directoryOffset, directoryOffset + directoryBytes).arrayBuffer();
  const view = new DataView(directory);
  let offset = 0;
  const result = new Map();
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > view.byteLength) throw new Error("XLSX: усечён ZIP-каталог");
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("XLSX: повреждён ZIP-каталог");
    const flags = view.getUint16(offset + 8, true);
    if ((flags & ~SUPPORTED_ZIP_FLAGS) !== 0) throw new Error("XLSX: зашифрованные или неподдерживаемые ZIP-флаги");
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
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
    if (result.has(name)) throw new Error(`XLSX: повторяется ZIP-путь ${name}`);
    const entry = { name, flags, method, crc, compressed, uncompressed, localOffset };
    result.set(name, entry);
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== view.byteLength) {
    const hasDigitalSignature = offset + 6 <= view.byteLength && view.getUint32(offset, true) === 0x05054b50;
    const signatureLength = hasDigitalSignature ? view.getUint16(offset + 4, true) : -1;
    if (!hasDigitalSignature || offset + 6 + signatureLength !== view.byteLength) {
      throw new Error("XLSX: число записей не совпадает с размером ZIP-каталога");
    }
  }
  const localEntries = [...result.values()].sort((left, right) => left.localOffset - right.localOffset);
  for (let index = 0; index < localEntries.length; index += 1) {
    const entry = localEntries[index];
    const next = localEntries[index + 1];
    if (next && next.localOffset === entry.localOffset) throw new Error(`XLSX: локальные записи перекрываются (${entry.name}, ${next.name})`);
    entry.nextLocalOffset = next?.localOffset ?? directoryOffset;
  }
  assertZipDirectoryCapacity(result);
  return { file, entries: result, directoryOffset };
}

async function zipEntryStream(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;
  const offset = entry.localOffset;
  const recordBoundary = entry.nextLocalOffset ?? zip.directoryOffset;
  if (offset + 30 > recordBoundary) throw new Error(`XLSX: локальная запись ${name} выходит за границы следующей записи`);
  const header = await zip.file.slice(offset, offset + 30).arrayBuffer();
  const headerView = new DataView(header);
  if (headerView.getUint32(0, true) !== 0x04034b50) throw new Error(`XLSX: повреждена запись ${name}`);
  const flags = headerView.getUint16(6, true);
  const method = headerView.getUint16(8, true);
  const crc = headerView.getUint32(14, true);
  const compressed = headerView.getUint32(18, true);
  const uncompressed = headerView.getUint32(22, true);
  const nameLength = headerView.getUint16(26, true);
  const extraLength = headerView.getUint16(28, true);
  const start = offset + 30 + nameLength + extraLength;
  if (start > recordBoundary) throw new Error(`XLSX: локальная запись ${name} выходит за границы следующей записи`);
  const hasDataDescriptor = Boolean(flags & 0x0008);
  const metadataMatches = hasDataDescriptor
    ? [crc, compressed, uncompressed].every((value, index) => value === 0 || value === [entry.crc, entry.compressed, entry.uncompressed][index])
    : crc === entry.crc && compressed === entry.compressed && uncompressed === entry.uncompressed;
  if (flags !== entry.flags || method !== entry.method || !metadataMatches) {
    throw new Error(`XLSX: локальный заголовок ${name} не совпадает с ZIP-каталогом`);
  }
  const localNameBytes = await zip.file.slice(offset + 30, offset + 30 + nameLength).arrayBuffer();
  const localName = new TextDecoder().decode(localNameBytes).replaceAll("\\", "/");
  if (localName !== entry.name) throw new Error(`XLSX: имя локальной записи не совпадает с ZIP-каталогом (${name})`);
  if (start + entry.compressed > recordBoundary) throw new Error(`XLSX: данные записи ${name} перекрываются со следующей локальной записью`);
  let stream = zip.file.slice(start, start + entry.compressed).stream();
  if (entry.method === 8 && typeof globalThis.DecompressionStream !== "undefined") {
    stream = stream.pipeThrough(new globalThis.DecompressionStream("deflate-raw"));
  } else if (entry.method !== 0) {
    throw new Error("Этот браузер не поддерживает распаковку XLSX. Используйте актуальный Chrome или Edge.");
  }
  const dataEnd = start + entry.compressed;
  if (hasDataDescriptor) {
    const available = recordBoundary - dataEnd;
    if (available < 12) throw new Error(`XLSX: отсутствует ZIP data descriptor записи ${name}`);
    const descriptorLength = Math.min(16, available);
    const descriptorBuffer = await zip.file.slice(dataEnd, dataEnd + descriptorLength).arrayBuffer();
    const descriptor = new DataView(descriptorBuffer);
    const descriptorMatchesAt = (descriptorOffset) => descriptor.byteLength >= descriptorOffset + 12
      && descriptor.getUint32(descriptorOffset, true) === entry.crc
      && descriptor.getUint32(descriptorOffset + 4, true) === entry.compressed
      && descriptor.getUint32(descriptorOffset + 8, true) === entry.uncompressed;
    const signedDescriptor = descriptor.byteLength >= 16
      && descriptor.getUint32(0, true) === 0x08074b50
      && descriptorMatchesAt(4);
    const unsignedDescriptor = descriptorMatchesAt(0);
    const consumedDescriptorBytes = signedDescriptor ? 16 : unsignedDescriptor ? 12 : 0;
    const descriptorMatches = consumedDescriptorBytes > 0;
    if (!descriptorMatches || dataEnd + consumedDescriptorBytes !== recordBoundary) {
      throw new Error(`XLSX: ZIP data descriptor записи ${name} не совпадает с ZIP-каталогом`);
    }
  } else if (dataEnd !== recordBoundary) {
    throw new Error(`XLSX: между локальными ZIP-записями ${name} обнаружены лишние данные`);
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
  let crc = 0xffffffff;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    expandedBytes += value.byteLength;
    crc = updateZipCrc32(crc, value);
    if (expandedBytes > entry.uncompressed) {
      await reader.cancel();
      throw new Error(`XLSX: распакованная часть ${name} превышает размер из ZIP-каталога`);
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  if (expandedBytes !== entry.uncompressed) throw new Error(`XLSX: размер распакованной части ${name} не совпадает с ZIP-каталогом`);
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error(`XLSX: CRC32 распакованной части ${name} не совпадает с ZIP-каталогом`);
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

async function* zipXmlElements(zip, name, tag, { maxElementCharacters = 0, signal } = {}) {
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
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
  let crc = 0xffffffff;
  let streamEnded = false;
  const cancelOnAbort = () => { void reader.cancel(); };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    while (!streamEnded) {
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      const result = await reader.read();
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      streamEnded = result.done;
      if (!streamEnded) {
        expandedBytes += result.value.byteLength;
        crc = updateZipCrc32(crc, result.value);
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
          if (maxElementCharacters > 0 && pending.length > maxElementCharacters) {
            throw new Error(`XLSX: элемент <${tag}> в ${name} превышает безопасный размер ${maxElementCharacters.toLocaleString("ru-RU")} символов`);
          }
          break;
        }
        const itemEnd = end + closing.length;
        if (maxElementCharacters > 0 && itemEnd - start > maxElementCharacters) {
          throw new Error(`XLSX: элемент <${tag}> в ${name} превышает безопасный размер ${maxElementCharacters.toLocaleString("ru-RU")} символов`);
        }
        const element = pending.slice(start, itemEnd);
        pending = pending.slice(itemEnd);
        yield element;
      }
    }
    if (expandedBytes !== entry.uncompressed) throw new Error(`XLSX: размер распакованной части ${name} не совпадает с ZIP-каталогом`);
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error(`XLSX: CRC32 распакованной части ${name} не совпадает с ZIP-каталогом`);
    if (findXmlElementStart(pending, tag) >= 0) throw new Error(`XLSX: незакрытый элемент <${tag}> в ${name}`);
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    if (!streamEnded) await reader.cancel();
    reader.releaseLock();
  }
}

const SHARED_STRING_CHUNK_CHARACTERS = 64 * 1024;

class CompactSharedStringTable {
  constructor() {
    this.chunks = [];
    this.pending = [];
    this.pendingCharacters = 0;
    this.count = 0;
    this.valueBytes = 0;
    this.chunkIndexes = new Uint32Array(256);
    this.offsets = new Uint32Array(256);
    this.lengths = new Uint32Array(256);
  }

  #ensureCapacity(required) {
    if (required <= this.chunkIndexes.length) return;
    const capacity = Math.min(IMPORT_LIMITS.sharedStringCount, Math.max(required, this.chunkIndexes.length * 2));
    const copy = (source) => { const target = new Uint32Array(capacity); target.set(source); return target; };
    this.chunkIndexes = copy(this.chunkIndexes);
    this.offsets = copy(this.offsets);
    this.lengths = copy(this.lengths);
  }

  #flushChunk() {
    if (!this.pending.length) return;
    this.chunks.push(this.pending.join(""));
    this.pending = [];
    this.pendingCharacters = 0;
  }

  append(value) {
    const textValue = String(value ?? "");
    const nextCount = this.count + 1;
    const nextBytes = this.valueBytes + textValue.length * 2;
    assertSharedStringCapacity(nextCount, nextBytes);
    this.#ensureCapacity(nextCount);
    if (!textValue.length) {
      this.chunkIndexes[this.count] = 0;
      this.offsets[this.count] = 0;
      this.lengths[this.count] = 0;
    } else if (textValue.length > SHARED_STRING_CHUNK_CHARACTERS) {
      this.#flushChunk();
      this.chunkIndexes[this.count] = this.chunks.length;
      this.offsets[this.count] = 0;
      this.lengths[this.count] = textValue.length;
      this.chunks.push(textValue);
    } else {
      if (this.pendingCharacters + textValue.length > SHARED_STRING_CHUNK_CHARACTERS) this.#flushChunk();
      this.chunkIndexes[this.count] = this.chunks.length;
      this.offsets[this.count] = this.pendingCharacters;
      this.lengths[this.count] = textValue.length;
      this.pending.push(textValue);
      this.pendingCharacters += textValue.length;
    }
    this.count = nextCount;
    this.valueBytes = nextBytes;
  }

  finish() {
    this.#flushChunk();
    return this;
  }

  get(index) {
    const position = Number(index);
    if (!Number.isSafeInteger(position) || position < 0 || position >= this.count) return "";
    const length = this.lengths[position];
    if (!length) return "";
    const chunk = this.chunks[this.chunkIndexes[position]];
    if (typeof chunk !== "string") throw new Error("XLSX: индекс общей строки ссылается на отсутствующий компактный блок");
    return chunk.slice(this.offsets[position], this.offsets[position] + length);
  }
}

function xlsxRichTextValue(xml) {
  return [...String(xml ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

async function readSharedStrings(zip, signal) {
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  const values = new CompactSharedStringTable();
  const entry = zip.entries.get("xl/sharedStrings.xml");
  if (entry) assertSharedStringCapacity(0, entry.uncompressed);
  for await (const item of zipXmlElements(zip, "xl/sharedStrings.xml", "si", { maxElementCharacters: IMPORT_LIMITS.cellCharacters, signal })) {
    const content = item.replace(/^<si\b[^>]*>/, "").replace(/<\/si>$/, "");
    values.append(xlsxRichTextValue(content));
  }
  return values.finish();
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
      const inlineText = type === "inlineStr"
        ? xlsxRichTextValue(body)
        : null;
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        ?? body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1]
        ?? "";
      const value = type === "s"
        ? (typeof sharedStrings?.get === "function" ? sharedStrings.get(Number(raw)) : sharedStrings[Number(raw)]) ?? ""
        : type === "inlineStr" ? inlineText : decodeXml(raw);
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
  for await (const rowXml of zipXmlElements(zip, path, "row", { maxElementCharacters: IMPORT_LIMITS.xlsxRowCharacters, signal })) {
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

function stripXmlComments(xml) {
  return String(xml || "").replace(/<!--[\s\S]*?-->/g, "");
}

function normalizeWorkbookSheetPath(target) {
  let source;
  try {
    source = decodeURIComponent(String(target || "").replaceAll("\\", "/")).replaceAll("\\", "/");
  } catch {
    return "";
  }
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
  const workbook = stripXmlComments(await zipText(zip, "xl/workbook.xml"));
  const relationships = stripXmlComments(await zipText(zip, "xl/_rels/workbook.xml.rels"));
  if (!workbook) throw new Error("XLSX: не найден xl/workbook.xml");
  const relationshipById = new Map();
  const relationshipTypeById = new Map();
  for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attrs = match[1];
    const id = xmlAttribute(attrs, "Id");
    const targetMode = xmlAttribute(attrs, "TargetMode");
    const target = xmlAttribute(attrs, "Target");
    const type = xmlAttribute(attrs, "Type");
    if (id) {
      if (relationshipTypeById.has(id)) throw new Error(`XLSX: повторяющийся relationship Id ${id}`);
      relationshipTypeById.set(id, type);
      if (targetMode.toLocaleLowerCase("en-US") !== "external") relationshipById.set(id, target ? normalizeWorkbookSheetPath(target) : "");
    }
  }
  const fallbackPaths = [...zip.entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((left, right) => Number(left.match(/sheet(\d+)/i)?.[1]) - Number(right.match(/sheet(\d+)/i)?.[1]));
  const sheets = [];
  const sheetNameKeys = new Set();
  let defaultSheetName = "";
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const attrs = match[1];
    const name = xmlAttribute(attrs, "name");
    const normalizedName = name.toLocaleLowerCase("en-US");
    if (name && sheetNameKeys.has(normalizedName)) throw new Error(`XLSX: повторяющееся имя листа ${name}`);
    if (name) sheetNameKeys.add(normalizedName);
    const relationshipId = xmlAttribute(attrs, "r:id") || xmlAttribute(attrs, "id");
    const path = relationshipId ? relationshipById.get(relationshipId) || "" : fallbackPaths[sheets.length] || "";
    const relationshipType = relationshipTypeById.get(relationshipId) || "";
    const isChartSheet = relationshipType.toLocaleLowerCase("en-US").endsWith("/chartsheet") || path.startsWith("xl/chartsheets/");
    if (!defaultSheetName && name && !isChartSheet) defaultSheetName = name;
    if (!name || !path.startsWith("xl/worksheets/") || !zip.entries.has(path)) continue;
    sheets.push({ name, path });
  }
  if (!sheets.length) throw new Error("XLSX не содержит читаемых листов");
  return { sheets, defaultSheetName };
}

export async function listXlsxSheets(file) {
  if (!file || !/\.(xlsx|xlsm|xls)$/i.test(file.name || "")) return [];
  if (/\.xls$/i.test(file.name || "")) {
    const names = await parseLegacyXlsSheetNames(file);
    legacyXlsSheetNames.set(file, names);
    return [...names];
  }
  assertSourceFileCapacity(file);
  return (await xlsxSheets(await zipDirectory(file))).sheets.map(({ name }) => name);
}

function legacyXlsLibrary() {
  const library = globalThis.XLSX;
  if (typeof library?.read !== "function" || typeof library?.utils?.decode_range !== "function") {
    throw new Error("Компонент чтения XLS не загружен. Перезапустите автономный HTML или откройте приложение из комплекта Next.");
  }
  return library;
}

function assertLegacyXlsCapacity(file, memoryInfo) {
  const heapLimit = Number(memoryInfo?.jsHeapSizeLimit);
  const heapUsed = Number(memoryInfo?.usedJSHeapSize);
  const hasHeapTelemetry = Number.isFinite(heapLimit) && heapLimit > 0 && Number.isFinite(heapUsed) && heapUsed >= 0;
  const maximumBytes = hasHeapTelemetry ? IMPORT_LIMITS.sourceFileBytes : IMPORT_LIMITS.legacyXlsFileBytes;
  const sourceBytes = assertSourceFileCapacity(file, maximumBytes);
  assertBrowserHeapCapacity(sourceBytes * 4, memoryInfo);
}

async function readLegacyXlsBytes(file, memoryInfo) {
  if (typeof file.arrayBuffer !== "function") throw new Error("Браузер не может прочитать выбранный XLS-файл");
  const bytes = new Uint8Array(await file.arrayBuffer());
  // XLS can expand substantially inside SheetJS. Re-read the browser heap after
  // allocating the input bytes so a low-memory change during the read stops
  // before workbook materialization begins.
  assertLegacyXlsCapacity(file, globalThis.performance?.memory || memoryInfo);
  return bytes;
}

async function parseLegacyXlsSheetNames(file, memoryInfo = globalThis.performance?.memory) {
  assertLegacyXlsCapacity(file, memoryInfo);
  const library = legacyXlsLibrary();
  const bytes = await readLegacyXlsBytes(file, memoryInfo);
  const workbook = library.read(bytes, {
    type: "array", bookSheets: true, cellFormula: false, cellHTML: false,
    cellNF: false, cellStyles: false, cellText: false, cellDates: false,
  });
  if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length === 0) throw new Error("XLS не содержит листов для чтения");
  return [...workbook.SheetNames];
}

async function parseLegacyXlsWorkbook(file, memoryInfo = globalThis.performance?.memory, sheetName = "", maxRows = Number.POSITIVE_INFINITY) {
  const knownSheetNames = legacyXlsSheetNames.get(file);
  if (sheetName && knownSheetNames && !knownSheetNames.includes(sheetName)) throw new Error(`XLS лист не найден: ${sheetName}`);
  assertLegacyXlsCapacity(file, memoryInfo);
  const library = legacyXlsLibrary();
  const bytes = await readLegacyXlsBytes(file, memoryInfo);
  // SheetJS otherwise builds the entire BIFF worksheet before we can enforce
  // the shared table limits. Keep one extra row as a truncation sentinel; the
  // worksheet's !fullref is checked below before any rows are emitted.
  const sheetRows = Number.isFinite(maxRows)
    ? Math.max(2, Math.floor(maxRows) + 2)
    : IMPORT_LIMITS.rowCount + 1;
  const workbook = library.read(bytes, {
    type: "array", dense: true, cellFormula: false, cellHTML: false,
    cellNF: false, cellStyles: false, cellText: true, cellDates: false,
    ...(sheetRows ? { sheetRows } : {}),
  });
  if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length === 0) throw new Error("XLS не содержит листов для чтения");
  const selectedName = sheetName || workbook.SheetNames[0];
  if (!workbook.Sheets?.[selectedName]) throw new Error(`XLS лист не найден: ${selectedName}`);
  // A BIFF workbook may contain many large sheets. Analysis consumes exactly
  // one selected sheet, so drop the other parser-owned worksheet graphs before
  // producing row batches. Keep the ordered names for the UI's sheet selector.
  for (const name of Object.keys(workbook.Sheets)) {
    if (name !== selectedName) delete workbook.Sheets[name];
  }
  return workbook;
}

function legacyXlsSheet(workbook, sheetName, { enforceFullCapacity = false } = {}) {
  const library = globalThis.XLSX;
  const selectedName = sheetName || workbook.SheetNames[0];
  const sheet = workbook.Sheets[selectedName];
  if (!sheet) throw new Error(`XLS лист не найден: ${selectedName}`);
  if (!sheet["!ref"]) throw new Error(`XLS лист «${selectedName}» не содержит строк заголовков`);
  if (enforceFullCapacity && sheet["!fullref"]) {
    const fullRange = library.utils.decode_range(sheet["!fullref"]);
    const fullRows = fullRange.e.r - fullRange.s.r + 1;
    const fullColumns = fullRange.e.c - fullRange.s.c + 1;
    assertTableCapacity(fullRows, fullRows * fullColumns);
  }
  const range = library.utils.decode_range(sheet["!ref"]);
  const rowCount = range.e.r - range.s.r + 1;
  const columnCount = range.e.c - range.s.c + 1;
  assertTableCapacity(rowCount, rowCount * columnCount);
  return { name: selectedName, sheet, range, rowCount, columnCount };
}

function legacyXlsCell(workbook, sheet, row, column) {
  const address = globalThis.XLSX.utils.encode_cell({ r: row, c: column });
  const cell = Array.isArray(sheet)
    ? sheet[row]?.[column]
    : sheet?.["!data"]?.[row]?.[column] ?? sheet[address];
  return cell?.v === undefined || cell.v === null ? "" : String(cell.v);
}

function releaseLegacyXlsRow(sheet, rowIndex, firstColumn, columnCount) {
  if (Array.isArray(sheet)) {
    sheet[rowIndex] = undefined;
    return;
  }
  if (Array.isArray(sheet?.["!data"])) {
    sheet["!data"][rowIndex] = undefined;
    return;
  }
  for (let offset = 0; offset < columnCount; offset += 1) {
    delete sheet[globalThis.XLSX.utils.encode_cell({ r: rowIndex, c: firstColumn + offset })];
  }
}

function legacyXlsMetadata(workbook) {
  const created = workbook.Props?.CreatedDate;
  const modified = workbook.Props?.ModifiedDate;
  const iso = (value) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : "";
  return { workbookCreatedAt: iso(created), workbookModifiedAt: iso(modified) };
}

async function* legacyXlsRowBatches(file, { sheetName = "", batchSize = 500, maxRows = Number.POSITIVE_INFINITY, signal, memoryInfo, onHeaders = () => {}, onProgress = () => {} } = {}) {
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  const workbook = await parseLegacyXlsWorkbook(file, memoryInfo, sheetName, maxRows);
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  const context = legacyXlsSheet(workbook, sheetName, { enforceFullCapacity: !Number.isFinite(maxRows) });
  const { range, sheet, columnCount } = context;
  const normalizedBatchSize = Math.max(1, Math.min(5_000, Math.floor(Number(batchSize) || 500)));
  const metadata = { sheet: context.name, ...legacyXlsMetadata(workbook) };
  const headers = Array.from({ length: columnCount }, (_, offset) => {
    const value = legacyXlsCell(workbook, sheet, range.s.r, range.s.c + offset);
    return text(value) || `Column ${offset + 1}`;
  });
  releaseLegacyXlsRow(sheet, range.s.r, range.s.c, columnCount);
  onHeaders({ headers, ...metadata });
  let rowsRead = 0;
  let batch = [];
  for (let rowIndex = range.s.r + 1; rowIndex <= range.e.r; rowIndex += 1) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const row = Array.from({ length: columnCount }, (_, offset) => legacyXlsCell(workbook, sheet, rowIndex, range.s.c + offset));
    const hasValue = row.some((value) => value !== "");
    releaseLegacyXlsRow(sheet, rowIndex, range.s.c, columnCount);
    if (!hasValue) continue;
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

async function prepareXlsx(file, sheetName, signal) {
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  assertSourceFileCapacity(file);
  const zip = await zipDirectory(file);
  if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
  const metadata = await readXlsxMetadata(zip);
  const shared = await readSharedStrings(zip, signal);
  const catalog = await xlsxSheets(zip);
  const selected = sheetName
    ? catalog.sheets.find((sheet) => sheet.name === sheetName)
    : catalog.sheets.find((sheet) => sheet.name === catalog.defaultSheetName);
  if (!selected && !sheetName && catalog.defaultSheetName) {
    throw new Error(`XLSX: связь первого листа «${catalog.defaultSheetName}» не найдена или повреждена; выберите доступный лист вручную`);
  }
  if (!selected) throw new Error(`XLSX лист не найден: ${sheetName}`);
  return { zip, shared, selected, ...metadata };
}

async function* xlsxRowBatches(file, { sheetName = "", batchSize = 500, signal, onHeaders = () => {}, onProgress = () => {} } = {}) {
  const context = await prepareXlsx(file, sheetName, signal);
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
  let batches;
  if (/\.(xlsx|xlsm)$/i.test(file.name)) {
    batches = xlsxRowBatches(file, { ...options, batchSize });
  } else if (/\.xls$/i.test(file.name)) {
    batches = legacyXlsRowBatches(file, { ...options, batchSize });
  } else if (/\.(csv|tsv|txt)$/i.test(file.name) && typeof file.slice === "function") {
    batches = delimitedRowBatches(file, { ...options, batchSize });
  } else if (/\.json$/i.test(file.name) && typeof file.slice === "function") {
    batches = jsonRowBatches(file, { ...options, batchSize });
  } else if (typeof file.slice === "function") {
    batches = delimitedRowBatches(file, { ...options, batchSize, allowEmptyData: true });
  } else {
    const table = await readTable(file, { memoryInfo: options.memoryInfo });
    options.onHeaders?.({ headers: table.headers, sheet: table.sheet || "", workbookCreatedAt: table.workbookCreatedAt || "", workbookModifiedAt: table.workbookModifiedAt || "" });
    batches = consumeStoredTableRows(table, {
      batchSize,
      previewRows: 0,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }
  for await (const rows of batches) {
    assertBrowserHeapReserve(options.memoryInfo);
    yield rows;
  }
}

/** Yield cached parsed rows in bounded batches and release each consumed row.
 * Keep a small sample for mapping previews; callers reload from the retained
 * File if processing is retried after consumption.
 */
export async function* consumeStoredTableRows(table, { batchSize = 500, previewRows = 100, signal, onProgress = () => {} } = {}) {
  const rows = table?.rows;
  if (!Array.isArray(rows)) return;
  const size = Math.max(1, Math.min(5_000, Math.floor(Number(batchSize) || 500)));
  const rowCount = rows.length;
  const previewLimit = Math.max(0, Math.min(1_000, Math.floor(Number(previewRows) || 0)));
  const preview = rows.slice(0, previewLimit);
  let offset = 0;
  try {
    while (offset < rowCount) {
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      const end = Math.min(rowCount, offset + size);
      const batch = rows.slice(offset, end);
      rows.fill(null, offset, end);
      offset = end;
      onProgress({ rowsRead: offset, batchSize: batch.length });
      yield batch;
    }
  } finally {
    rows.length = 0;
    if (table.rows === rows) table.rows = preview;
    table.rowsConsumed = true;
  }
}

async function readXlsx(file, { maxRows = Number.POSITIVE_INFINITY, sheetName = "", memoryInfo } = {}) {
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
    assertBrowserHeapReserve(memoryInfo);
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

async function readLegacyXls(file, { maxRows = Number.POSITIVE_INFINITY, sheetName = "", memoryInfo } = {}) {
  const rows = [];
  let headers = null;
  let workbookMetadata = {};
  let rowCount = 0;
  let truncated = false;
  const reader = legacyXlsRowBatches(file, {
    sheetName,
    memoryInfo,
    maxRows,
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
    assertBrowserHeapReserve(memoryInfo);
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

export async function readTable(file, { sheetName = "", memoryInfo = globalThis.performance?.memory } = {}) {
  if (!file) throw new Error("Файл не выбран");
  assertSourceFileCapacity(file);
  if (/\.xls$/i.test(file.name)) return readLegacyXls(file, { sheetName, memoryInfo });
  if (/\.(xlsx|xlsm)$/i.test(file.name)) return readXlsx(file, { sheetName, memoryInfo });
  if (/\.json$/i.test(file.name) && typeof file.slice === "function") {
    assertBrowserHeapCapacity(Number(file.size || 0) * 3, memoryInfo);
    let headers = [];
    let rowCount = 0;
    const rows = [];
    for await (const batch of jsonRowBatches(file, {
      onHeaders: (value) => { headers = value.headers || []; rowCount = value.rowCount; },
    })) {
      assertBrowserHeapReserve(memoryInfo);
      rows.push(...batch);
    }
    return { headers, rows, rowCount };
  }
  if (/\.(csv|tsv|txt)$/i.test(file.name) && typeof file.slice === "function") {
    assertBrowserHeapCapacity(Number(file.size || 0) * 3, memoryInfo);
    let headers = [];
    let rowCount = 0;
    const rows = [];
    for await (const batch of delimitedRowBatches(file, {
      batchSize: 500,
      allowEmptyData: true,
      onHeaders: (value) => { headers = value.headers; },
      onProgress: (value) => { rowCount = value.rowsRead; },
    })) {
      assertBrowserHeapReserve(memoryInfo);
      rows.push(...batch);
    }
    return { headers, rows, rowCount };
  }
  if (typeof file.slice === "function") {
    assertBrowserHeapCapacity(Number(file.size || 0) * 3, memoryInfo);
    let headers = [];
    let rowCount = 0;
    const rows = [];
    for await (const batch of delimitedRowBatches(file, {
      batchSize: 500,
      allowEmptyData: true,
      onHeaders: (value) => { headers = value.headers; },
      onProgress: (value) => { rowCount = value.rowsRead; },
    })) {
      assertBrowserHeapReserve(memoryInfo);
      rows.push(...batch);
    }
    return { headers, rows, rowCount };
  }
  assertBrowserHeapCapacity(Number(file.size || 0) * 3, memoryInfo);
  const source = await readTextFile(file);
  const rows = parseDelimited(source, detectDelimiter(source, file.name));
  if (!rows.length) throw new Error("Файл не содержит строк");
  const headers = rows.shift().map(text);
  for (let index = 0; index < rows.length; index += 1) normalizeDelimitedRowWidth(rows[index], headers, index + 2);
  assertTableCapacity(rows.length, (rows.length + 1) * headers.length);
  return { headers, rows, rowCount: rows.length };
}

export async function readTablePreview(file, { maxBytes = 2 * 1024 * 1024, maxRows = 100, sheetName = "" } = {}) {
  if (!file) throw new Error("Файл не выбран");
  assertSourceFileCapacity(file);
  const requestedPreviewBytes = Number(maxBytes);
  const previewByteLimit = Number.isFinite(requestedPreviewBytes)
    ? Math.min(IMPORT_LIMITS.sourceFileBytes, Math.max(0, Math.floor(requestedPreviewBytes)))
    : 2 * 1024 * 1024;
  const sourceSize = Number(file.size);
  const hasKnownSourceSize = Number.isSafeInteger(sourceSize) && sourceSize >= 0;
  if (!hasKnownSourceSize) throw new Error("Предпросмотр требует выбранный файл с известным размером");
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
    const canSlice = typeof file.slice === "function";
    if (!canSlice && sourceSize > previewByteLimit) assertSourceFileCapacity(file, previewByteLimit);
    const bytesRead = canSlice ? Math.min(sourceSize, previewByteLimit) : sourceSize;
    assertBrowserHeapCapacity(bytesRead * 3);
    const sourceFile = canSlice && sourceSize > previewByteLimit ? file.slice(0, previewByteLimit) : file;
    const source = await readTextFile(sourceFile);
    const parsed = parseDelimited(source, detectDelimiter(source, file.name), {
      maxRows: maxRows + 1,
      truncate: true,
      allowIncomplete: sourceSize > previewByteLimit,
    });
    const rows = parsed;
    if (!rows.length) throw new Error("Файл не содержит строк");
    const headers = rows.shift().map(text);
    for (let index = 0; index < rows.length; index += 1) normalizeDelimitedRowWidth(rows[index], headers, index + 2);
    const truncated = Boolean(rows.truncated) || sourceSize > previewByteLimit;
    return {
      headers,
      rows: rows.slice(0, maxRows),
      rowCount: truncated ? null : rows.length,
      preview: true,
    };
  }
  if (typeof file.slice !== "function") {
    if (sourceSize > previewByteLimit) assertSourceFileCapacity(file, previewByteLimit);
    assertBrowserHeapCapacity(sourceSize * 3);
    const table = await readTable(file);
    return { ...table, rows: table.rows.slice(0, maxRows), preview: true };
  }
  let headers = null;
  let rowCount = 0;
  const previewRows = [];
  const previewLimit = Math.max(0, Math.floor(Number(maxRows) || 0));
  for await (const batch of delimitedRowBatches(file, {
    batchSize: 500,
    allowEmptyData: true,
    onHeaders: (value) => { headers = value.headers; },
    onProgress: ({ rowsRead }) => { rowCount = rowsRead; },
  })) {
    const remaining = Math.max(0, previewLimit - previewRows.length);
    if (remaining) previewRows.push(...batch.slice(0, remaining));
  }
  return { headers: headers || [], rows: previewRows, rowCount: rowCount > previewLimit ? null : rowCount, preview: true };
}

function dateSample(value) {
  return /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[./-]\d{1,2}[./-]\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d+(?:\.\d+)?)$/.test(value) && Boolean(normalizeDate(value));
}

function sampleScore(rows, index, field) {
  const sample = rows.slice(0, 100).map((row) => row[index]).filter((value) => text(value));
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
  possibleIps: ["possible", "возможные", "ip list", "список ip"],
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

const PYQT_AI_FIELDS = Object.freeze({
  mac: { keywords: ["mac", "address"], weight: 1, minScore: 0.25, patterns: [/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i, /^[0-9a-f]{12}$/i] },
  ip: { keywords: ["ip", "address"], weight: 0.9, minScore: 0.2, patterns: [/^\d{1,3}(?:\.\d{1,3}){3}$/] },
  manufacturer: { keywords: ["vendor", "manufacturer"], weight: 0.8, minScore: 0.2, patterns: [/^(?:vendor|manufacturer)/i] },
  model: { keywords: ["model", "product"], weight: 0.7, minScore: 0.2, patterns: [/^(?:model|product)/i] },
  address: { keywords: ["address", "location"], weight: 0.7, minScore: 0.2, patterns: [/^(?:address|location)/i] },
  room: { keywords: ["room", "office"], weight: 0.8, minScore: 0.2, patterns: [/^(?:room|office)/i] },
  switchIp: { keywords: ["switch"], weight: 0.75, minScore: 0.2, patterns: [/^(?:switch|коммутатор)/i] },
  switchPort: { keywords: ["port"], weight: 0.75, minScore: 0.2, patterns: [/^(?:port|interface)/i] },
});

function pyqtAiColumnScore(rows, index, header, field) {
  const config = PYQT_AI_FIELDS[field];
  if (!config) return 0;
  const headerText = String(header ?? "").toLocaleLowerCase("en-US");
  const nameScore = config.keywords.filter((keyword) => headerText.includes(keyword.toLocaleLowerCase("en-US"))).length / config.keywords.length;
  const sample = [];
  for (const row of rows.slice(0, 100)) {
    const value = row?.[index];
    if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) continue;
    sample.push(String(value));
    if (sample.length >= 50) break;
  }
  const valid = sample.filter((value) => value !== "" && value !== "nan" && value !== "None");
  const patternMatches = valid.filter((value) => config.patterns.some((pattern) => pattern.test(value))).length;
  const patternScore = valid.length ? Math.min(patternMatches / valid.length, 1) : 0;
  return Math.min((nameScore * 0.25 + patternScore * 0.75) * config.weight, 1);
}

function valueProfile(rows, index) {
  const values = rows.slice(0, 100).map((row) => text(row?.[index])).filter(Boolean);
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

function mappingCandidateReason(aliasScore, sampleFit, semanticReasons, pyqtAiScore = 0) {
  const reasons = [];
  if (aliasScore) reasons.push("заголовок совпадает с названием поля");
  if (sampleFit >= 0.75) reasons.push("значения сильно подходят по типу");
  else if (sampleFit >= 0.35) reasons.push("значения частично подходят по типу");
  if (pyqtAiScore > 0.2) reasons.push("совпадает с оценкой AI-детектора PyQt");
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
    (candidate.pyqtAiScore || 0) * 100,
  )));
}

export function detectMappingReport(headers = [], rows = [], role = "main") {
  const allowed = role === "ddio"
    ? ["reservationMac", "reservationIp", "leaseMac", "leaseIp", "deviceId", "mac", "ip", "possibleIps"]
    : Object.keys(FIELD_LABELS).filter((field) => !field.startsWith("reservation") && !field.startsWith("lease") && field !== "possibleIps");
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
      const pyqtAiScore = pyqtAiColumnScore(rows, index, header, field);
      const score = Math.max(aliasScore + sampleFit * 40 + semantic.score * 100, pyqtAiScore * 100);
      const reason = mappingCandidateReason(aliasScore, sampleFit, semantic.reasons, pyqtAiScore);
      const examples = rows.slice(0, 100)
        .map((row) => text(row?.[index]))
        .filter(Boolean)
        .slice(0, 3);
      return { index, score, aliasScore, sampleFit, semanticScore: semantic.score, pyqtAiScore, reason, examples };
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
      const pyqtThreshold = PYQT_AI_FIELDS[field]?.minScore || Infinity;
      const pyqtRecognized = item.pyqtAiScore > pyqtThreshold;
      return (field === "mac2" ? item.aliasScore > 0 : item.score >= 40 || pyqtRecognized)
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
      pyqtAiScore: item.pyqtAiScore,
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
      pyqtAiScore: candidate?.pyqtAiScore || 0,
      recommendedIndex: best && best.score > 0 ? best.index : null,
      recommendedConfidence: mappingConfidence(best),
      recommendedPyqtAiScore: best?.pyqtAiScore || 0,
      recommendedScore: Math.round(best?.score || 0),
      recommendedReason: best?.reason || "нет уверенного совпадения",
      score: Math.round(candidate?.score || 0),
      sampleFit: candidate?.sampleFit || 0,
      semanticScore: candidate?.semanticScore || 0,
      reason: candidate?.reason || "нет уверенного совпадения",
      sampleCount: Math.min(100, rows.length),
      examples: candidate?.examples || [],
      alternatives,
      conflict: Boolean(selectedColumnTaken || nearTie || (best && candidate && best.index !== candidate.index)),
    };
    if (!candidate) continue;
    mapping[field] = candidate.index;
    usedColumns.add(candidate.index);
  }
  const recommendations = { ...mapping };
  const recommendationColumns = new Set(Object.values(recommendations).filter(Number.isInteger));
  const pyqtDialogOrder = ["mac", "manufacturer", "model", "address", "ip", "room", "switchIp", "switchPort"];
  for (const field of pyqtDialogOrder) {
    if (Number.isInteger(recommendations[field])) continue;
    if (field === "mac" && ["id", "deviceId", "serial", "mac2"].some((identityField) => Number.isInteger(recommendations[identityField]))) continue;
    const fieldCandidatesForReview = fieldCandidates.find((entry) => entry.field === field)?.ranked || [];
    const candidate = [...fieldCandidatesForReview]
      .filter((item) => item.pyqtAiScore > 0.15 && !recommendationColumns.has(item.index))
      .filter((item) => !["manufacturer", "model", "room"].includes(field) || item.aliasScore > 0 || item.semanticScore >= 0.5)
      .sort((left, right) => right.pyqtAiScore - left.pyqtAiScore || right.score - left.score || left.index - right.index)[0];
    if (!candidate) continue;
    recommendations[field] = candidate.index;
    recommendationColumns.add(candidate.index);
  }
  const identityFields = role === "ddio"
    ? []
    : role === "main" || role === "smartroom" || role === "single"
      ? ["id", "deviceId", "serial", "mac", "mac2"]
      : ["mac"];
  const hasStrongIdentity = identityFields.some((field) => Number.isInteger(mapping[field]));
  const validDdIoPair = role !== "ddio"
    || (Number.isInteger(mapping.reservationMac) && Number.isInteger(mapping.reservationIp))
    || (Number.isInteger(mapping.leaseMac) && Number.isInteger(mapping.leaseIp))
    || (Number.isInteger(mapping.mac) && Number.isInteger(mapping.ip))
    || (Number.isInteger(mapping.possibleIps) && ["mac", "reservationMac", "leaseMac"].some((field) => Number.isInteger(mapping[field])))
    || (Number.isInteger(mapping.deviceId) && ["reservationIp", "leaseIp", "ip", "possibleIps"].some((field) => Number.isInteger(mapping[field])));
  return { mapping, recommendations, details, hasStrongIdentity, validDdIoPair, identityFields };
}

export function mappingRecommendationsWithoutReservedColumns(report, reservedColumns = []) {
  const recommendations = report?.recommendations || report?.mapping || {};
  const reserved = new Set(reservedColumns.filter(Number.isInteger));
  return Object.fromEntries(Object.entries(recommendations).filter(([, index]) => !reserved.has(index)));
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
  const filesystemOverride = file && typeof file === "object" ? fileObservationDateOverrides.get(file) : null;
  if (filesystemOverride) return filesystemOverride;
  const lastModified = Number(file?.lastModified || 0);
  if (lastModified > 0 && Number.isFinite(lastModified)) {
    const lastModifiedDate = normalizeDate(new Date(lastModified));
    if (lastModifiedDate) return { date: lastModifiedDate, source: "file.lastModified" };
  }
  return { date: "", source: "import-time" };
}

export function setFileObservationDateOverride(file, value) {
  if (!file || typeof file !== "object") return false;
  const source = String(value?.source || "");
  const date = normalizeDate(value?.date);
  if (!date || !["filesystem.created", "filesystem.modified"].includes(source)) return false;
  fileObservationDateOverrides.set(file, { date, source });
  return true;
}

export function clearFileObservationDateOverride(file) {
  return Boolean(file && typeof file === "object" && fileObservationDateOverrides.delete(file));
}

