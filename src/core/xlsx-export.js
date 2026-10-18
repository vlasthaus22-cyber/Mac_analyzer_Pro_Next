const encoder = new globalThis.TextEncoder();
const ZIP32_LIMIT = 0xffffffff;
const MAX_SHEET_ROWS = 1_048_576;
const MAX_SHEET_DATA_ROWS = MAX_SHEET_ROWS - 1;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function write16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function write32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function xml(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function columnName(number) {
  let result = "";
  for (let value = number + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  }
  return result;
}

function cellXml(value, reference) {
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  const text = xml(value);
  const space = /^\s|\s$/.test(String(value ?? "")) ? ' xml:space="preserve"' : "";
  return `<c r="${reference}" t="inlineStr"><is><t${space}>${text}</t></is></c>`;
}

async function* sheetXml(sheet) {
  yield encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
  let rowNumber = 1;
  let buffer = `<row r="1">${sheet.headings.map((value, index) => cellXml(value, `${columnName(index)}1`)).join("")}</row>`;
  for await (const values of sheet.rows) {
    rowNumber += 1;
    if (rowNumber > MAX_SHEET_ROWS) throw new Error(`Лист ${sheet.name} превышает предел Excel ${MAX_SHEET_ROWS.toLocaleString("ru-RU")} строк`);
    buffer += `<row r="${rowNumber}">${values.map((value, index) => cellXml(value, `${columnName(index)}${rowNumber}`)).join("")}</row>`;
    if (buffer.length >= 64 * 1024) {
      yield encoder.encode(buffer);
      buffer = "";
    }
  }
  if (buffer) yield encoder.encode(buffer);
  yield encoder.encode("</sheetData></worksheet>");
}

function normalizeSheets(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error("Для XLSX нужна хотя бы одна таблица");
  if (sheets.length >= 0xffff) throw new Error("В XLSX слишком много листов");
  const names = new Set();
  return sheets.map((sheet, index) => {
    const rawName = String(sheet.name || `Лист ${index + 1}`).replace(/[\\/?*:[\]]/g, " ").trim().slice(0, 31) || `Лист ${index + 1}`;
    let name = rawName;
    let suffix = 2;
    while (names.has(name.toLocaleLowerCase())) {
      const tail = ` ${suffix++}`;
      name = `${rawName.slice(0, 31 - tail.length)}${tail}`;
    }
    names.add(name.toLocaleLowerCase());
    if (!Array.isArray(sheet.headings) || !sheet.headings.length) throw new Error(`У листа ${name} нет заголовков`);
    if (sheet.headings.length > 16_384) throw new Error(`У листа ${name} слишком много колонок`);
    if (!sheet.rows || typeof sheet.rows[Symbol.asyncIterator] !== "function") throw new Error(`Строки листа ${name} должны поступать потоком`);
    return { name, headings: sheet.headings, rows: sheet.rows };
  });
}

function staticEntries(sheets) {
  const worksheetOverrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const workbookSheets = sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const workbookRelationships = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  return [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${worksheetOverrides}</Types>` },
    { name: "_rels/.rels", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelationships}</Relationships>` },
  ];
}

async function* zipChunks(entries) {
  const central = [];
  let offset = 0;
  const emit = async function* (chunk) {
    offset += chunk.byteLength;
    if (offset > ZIP32_LIMIT) throw new Error("XLSX превысил ограничение ZIP32 в 4 ГиБ");
    yield chunk;
  };
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const localOffset = offset;
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, 0x0808);
    write16(localView, 8, 0);
    write16(localView, 26, name.length);
    local.set(name, 30);
    yield* emit(local);

    let crc = 0xffffffff;
    let size = 0;
    const source = typeof entry.content === "string" ? [encoder.encode(entry.content)] : entry.content;
    for await (const chunkValue of source) {
      const chunk = chunkValue instanceof Uint8Array ? chunkValue : encoder.encode(String(chunkValue));
      size += chunk.byteLength;
      if (size > ZIP32_LIMIT) throw new Error(`XLSX-часть ${entry.name} превысила ограничение ZIP32`);
      for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      yield* emit(chunk);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = new Uint8Array(16);
    const descriptorView = new DataView(descriptor.buffer);
    write32(descriptorView, 0, 0x08074b50);
    write32(descriptorView, 4, crc);
    write32(descriptorView, 8, size);
    write32(descriptorView, 12, size);
    yield* emit(descriptor);
    central.push({ name, crc, size, localOffset });
  }

  const centralOffset = offset;
  for (const entry of central) {
    const record = new Uint8Array(46 + entry.name.length);
    const view = new DataView(record.buffer);
    write32(view, 0, 0x02014b50);
    write16(view, 4, 20);
    write16(view, 6, 20);
    write16(view, 8, 0x0808);
    write16(view, 10, 0);
    write32(view, 16, entry.crc);
    write32(view, 20, entry.size);
    write32(view, 24, entry.size);
    write16(view, 28, entry.name.length);
    write32(view, 42, entry.localOffset);
    record.set(entry.name, 46);
    yield* emit(record);
  }
  const centralSize = offset - centralOffset;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 8, central.length);
  write16(endView, 10, central.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, centralOffset);
  yield* emit(end);
}

export function createXlsxWorkbookStream(inputSheets) {
  const sheets = normalizeSheets(inputSheets);
  const entries = [
    ...staticEntries(sheets),
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: sheetXml(sheet) })),
  ];
  const iterator = zipChunks(entries);
  return new globalThis.ReadableStream({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      return iterator.return();
    },
  });
}

export { MAX_SHEET_DATA_ROWS };
