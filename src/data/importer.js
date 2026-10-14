import { keyText, normalizeDate, normalizeIp, normalizeMac, text } from "../core/normalize.js";

export const FIELD_LABELS = Object.freeze({
  mac: "MAC",
  mac2: "Дополнительный MAC",
  ip: "IP устройства",
  switchIp: "IP коммутатора",
  switchPort: "Порт коммутатора",
  smartroomId: "Smartroom ID",
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
  mac: ["callingstationid", "calling station id", "mac", "mac address", "мак", "mac-адрес"],
  mac2: ["mac 2", "mac2", "secondary mac", "дополнительный mac", "mac второго интерфейса"],
  ip: ["ip", "ip address", "ip адрес", "ip-адрес", "ip устройства"],
  switchIp: ["nasip", "nas ip", "ip switch", "ip коммутатора", "коммутатор"],
  switchPort: ["nasportid", "nas port id", "port", "порт", "порт коммутатора"],
  smartroomId: ["smartroom id", "smartroom id локации", "id комнаты", "id помещения"],
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
  deviceId: ["device id", "deviceid", "идентификатор устройства"],
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
  if (/\.tsv$/i.test(name)) return "\t";
  const firstLines = String(sample).split(/\r?\n/).slice(0, 10);
  const candidates = [";", ",", "\t", "|"];
  return candidates.map((delimiter) => ({
    delimiter,
    score: firstLines.reduce((sum, line) => sum + line.split(delimiter).length - 1, 0),
  })).sort((a, b) => b.score - a.score)[0].delimiter;
}

export function parseDelimited(source, delimiter = ",") {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => text(cell))) rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  row.push(value);
  if (row.some((cell) => text(cell))) rows.push(row);
  return rows;
}

function findEocd(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) return offset;
  }
  throw new Error("XLSX: не найдена ZIP-директория");
}

function zipDirectory(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEocd(bytes);
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const result = new Map();
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("XLSX: повреждён ZIP-каталог");
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replaceAll("\\", "/");
    result.set(name, { name, method, compressed, uncompressed, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, view, entries: result };
}

async function zipText(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return "";
  const offset = entry.localOffset;
  if (zip.view.getUint32(offset, true) !== 0x04034b50) throw new Error(`XLSX: повреждена запись ${name}`);
  const nameLength = zip.view.getUint16(offset + 26, true);
  const extraLength = zip.view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = zip.bytes.slice(start, start + entry.compressed);
  let output;
  if (entry.method === 0) output = compressed;
  else if (entry.method === 8 && typeof DecompressionStream !== "undefined") {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    output = new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new Error("Этот браузер не поддерживает распаковку XLSX. Используйте актуальный Chrome или Edge.");
  return new TextDecoder("utf-8").decode(output);
}

function parseSharedStrings(xml) {
  const values = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    values.push([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1])).join(""));
  }
  return values;
}

function columnIndex(reference) {
  const letters = String(reference).match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const body = cell[2];
      const reference = attrs.match(/\br="([^"]+)"/)?.[1] || "A1";
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || "";
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        ?? body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1]
        ?? "";
      const value = type === "s" ? sharedStrings[Number(raw)] ?? "" : decodeXml(raw);
      row[columnIndex(reference)] = value;
    }
    rows.push(row);
  }
  return rows;
}

async function readXlsx(file) {
  const buffer = await file.arrayBuffer();
  const zip = zipDirectory(buffer);
  const shared = parseSharedStrings(await zipText(zip, "xl/sharedStrings.xml"));
  const workbook = await zipText(zip, "xl/workbook.xml");
  const relationships = await zipText(zip, "xl/_rels/workbook.xml.rels");
  const relationshipId = workbook.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  const target = relationshipId
    ? relationships.match(new RegExp(`<Relationship\\b[^>]*Id="${relationshipId}"[^>]*Target="([^"]+)"`))?.[1]
    : "worksheets/sheet1.xml";
  const sheetPath = target?.startsWith("/") ? target.slice(1) : `xl/${target || "worksheets/sheet1.xml"}`.replace("xl/xl/", "xl/");
  const rows = parseWorksheet(await zipText(zip, sheetPath), shared);
  if (!rows.length) throw new Error("XLSX не содержит строк на первом листе");
  const headers = rows.shift().map(text);
  return { headers, rows, rowCount: rows.length };
}

function rowsFromObjects(items) {
  const headers = [...new Set(items.flatMap((item) => Object.keys(item || {})))];
  return { headers, rows: items.map((item) => headers.map((header) => item?.[header] ?? "")), rowCount: items.length };
}

export async function readTable(file) {
  if (!file) throw new Error("Файл не выбран");
  if (/\.xlsx$/i.test(file.name)) return readXlsx(file);
  const source = await file.text();
  if (/\.json$/i.test(file.name)) {
    const parsed = JSON.parse(source);
    const items = Array.isArray(parsed) ? parsed : parsed.devices || parsed.rows || parsed.data;
    if (!Array.isArray(items)) throw new Error("JSON должен содержать массив строк");
    if (items.length && Array.isArray(items[0])) return { headers: items[0].map(text), rows: items.slice(1), rowCount: items.length - 1 };
    return rowsFromObjects(items);
  }
  const rows = parseDelimited(source, detectDelimiter(source, file.name));
  if (!rows.length) throw new Error("Файл не содержит строк");
  const headers = rows.shift().map(text);
  return { headers, rows, rowCount: rows.length };
}

function sampleScore(rows, index, field) {
  const sample = rows.slice(0, 80).map((row) => row[index]).filter((value) => text(value));
  if (!sample.length) return 0;
  if (field.toLocaleLowerCase().includes("mac")) return sample.filter(normalizeMac).length / sample.length;
  if (field.toLocaleLowerCase().includes("ip")) return sample.filter(normalizeIp).length / sample.length;
  if (field === "authenticationTime") return sample.filter(normalizeDate).length / sample.length;
  return 0;
}

export function detectMapping(headers = [], rows = [], role = "main") {
  const allowed = role === "ddio"
    ? ["reservationMac", "reservationIp", "leaseMac", "leaseIp"]
    : role === "smartroom"
      ? Object.keys(FIELD_LABELS).filter((field) => !field.startsWith("reservation") && !field.startsWith("lease") && field !== "switchPort")
      : ["mac", "ip", "switchIp", "switchPort", "authenticationTime", "hostname", "serial", "deviceId"];
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
      return { index, score: aliasScore + sampleScore(rows, index, field) * 40 };
    }).sort((a, b) => b.score - a.score);
    return { field, ranked, bestScore: ranked[0]?.score || 0 };
  }).sort((left, right) => right.bestScore - left.bestScore || allowed.indexOf(left.field) - allowed.indexOf(right.field));
  const mapping = {};
  const usedColumns = new Set();
  for (const { field, ranked } of fieldCandidates) {
    const candidate = ranked.find((item) => item.score >= 40 && !usedColumns.has(item.index));
    if (!candidate) continue;
    mapping[field] = candidate.index;
    usedColumns.add(candidate.index);
  }
  return mapping;
}

export function mapToObjects(table) {
  return table.rows.map((row) => Object.fromEntries(table.headers.map((header, index) => [header, row[index] ?? ""])));
}

export function fileObservationDate(file) {
  const patterns = [
    /(20\d{2})[-_.](\d{2})[-_.](\d{2})/,
    /(\d{2})[-_.](\d{2})[-_.](20\d{2})/,
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = file.name.match(pattern);
    if (!match) continue;
    const [year, month, day] = index === 0 ? match.slice(1) : [match[3], match[2], match[1]];
    const date = new Date(Date.UTC(+year, +month - 1, +day));
    if (!Number.isNaN(date.getTime())) return { date: date.toISOString(), source: "filename" };
  }
  return { date: new Date(file.lastModified || Date.now()).toISOString(), source: "file.lastModified" };
}

