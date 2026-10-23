import { csvQuote, tsvQuote } from "./csv-cell.js";

export async function* tableRowsTsvChunks(rows, columns = [], { chunkRows = 500, rowOffset = 0, includeHeaders = true, signal = null, isCurrent = () => true } = {}) {
  if (!rows || (typeof rows[Symbol.iterator] !== "function" && typeof rows[Symbol.asyncIterator] !== "function")) {
    throw new TypeError("Для TSV-потока требуется последовательность строк");
  }
  const batchSize = Math.max(1, Math.min(2_000, Math.floor(Number(chunkRows) || 500)));
  if (includeHeaders) yield `${tableRowsTsv([], columns)}\r\n`;
  let rowNumber = Math.max(0, Math.floor(Number(rowOffset) || 0));
  let lines = [];
  for await (const row of rows) {
    if (signal?.aborted || !isCurrent()) throw new DOMException("Копирование TSV отменено", "AbortError");
    rowNumber += 1;
    lines.push(columns.map((column) => {
      const key = Array.isArray(column) ? column[0] : column.key;
      const value = typeof column.value === "function" ? column.value(row, rowNumber) : row?.[key];
      return tsvQuote(Array.isArray(value) ? value.join(", ") : value);
    }).join("\t"));
    if (lines.length >= batchSize) {
      yield `${lines.join("\r\n")}\r\n`;
      lines = [];
    }
  }
  if (signal?.aborted || !isCurrent()) throw new DOMException("Копирование TSV отменено", "AbortError");
  if (lines.length) yield lines.join("\r\n");
}

export async function* inventorySearchTsvChunks({
  readPage,
  query = "",
  columns = [],
  matches = () => true,
  cellText = (device, key) => device?.[key],
  pageSize = 500,
  chunkRows = 500,
  signal = null,
  onProgress = () => {},
} = {}) {
  if (typeof readPage !== "function") throw new TypeError("Для TSV Inventory требуется постраничное чтение");
  const size = Math.max(1, Math.min(2_000, Math.floor(Number(pageSize) || 500)));
  const batchSize = Math.max(1, Math.min(2_000, Math.floor(Number(chunkRows) || 500)));
  yield `${columns.map(({ label }) => tsvQuote(label)).join("\t")}\r\n`;
  let afterId = null;
  let rowsScanned = 0;
  let rowsMatched = 0;
  let lines = [];
  while (true) {
    if (signal?.aborted) throw new DOMException("Копирование Inventory отменено", "AbortError");
    const page = await readPage({ afterId, limit: size });
    if (!Array.isArray(page?.rows)) throw new TypeError("Постраничное чтение Inventory вернуло неверный результат");
    for (let index = 0; index < page.rows.length; index += 1) {
      if (signal?.aborted) throw new DOMException("Копирование Inventory отменено", "AbortError");
      const device = page.rows[index];
      page.rows[index] = null;
      rowsScanned += 1;
      if (matches(device, query)) {
        rowsMatched += 1;
        lines.push(columns.map(({ key }) => tsvQuote(cellText(device, key, rowsMatched))).join("\t"));
        if (lines.length >= batchSize) {
          const chunk = `${lines.join("\r\n")}\r\n`;
          lines = [];
          yield chunk;
        }
      }
      if (rowsScanned % 5_000 === 0) onProgress({ rowsScanned, rowsMatched });
    }
    onProgress({ rowsScanned, rowsMatched });
    if (!page.hasMore) break;
    if (page.nextCursor === null || page.nextCursor === undefined || page.nextCursor === afterId) {
      throw new Error("Постраничное чтение Inventory не продвинуло курсор");
    }
    afterId = page.nextCursor;
  }
  if (lines.length) yield lines.join("\r\n");
}

export function tableRowsTsv(rows = [], columns = [], { includeHeaders = true, rowOffset = 0 } = {}) {
  const quote = (value) => tsvQuote(Array.isArray(value) ? value.join(", ") : value);
  return [
    ...(includeHeaders ? [columns.map((column) => quote(Array.isArray(column) ? column[1] : column.label)).join("\t")] : []),
    ...rows.map((row, rowIndex) => columns.map((column) => {
      const key = Array.isArray(column) ? column[0] : column.key;
      return quote(typeof column.value === "function" ? column.value(row, Number(rowOffset) + rowIndex + 1) : row?.[key]);
    }).join("\t")),
  ].join("\r\n");
}

export async function* inventorySearchCsvChunks({
  readPage,
  query = "",
  columns = [],
  matches = () => true,
  cellText = (device, key) => device?.[key],
  pageSize = 500,
  chunkRows = 500,
} = {}) {
  if (typeof readPage !== "function") throw new TypeError("Для CSV Inventory требуется постраничное чтение");
  const size = Math.max(1, Math.min(2_000, Math.floor(Number(pageSize) || 500)));
  const batchSize = Math.max(1, Math.min(2_000, Math.floor(Number(chunkRows) || 500)));
  yield `\uFEFF${columns.map(({ label }) => csvQuote(label)).join(";")}\r\n`;
  let afterId = null;
  let rowNumber = 0;
  let lines = [];
  while (true) {
    const page = await readPage({ afterId, limit: size });
    if (!Array.isArray(page?.rows)) throw new TypeError("Постраничное чтение Inventory вернуло неверный результат");
    for (let index = 0; index < page.rows.length; index += 1) {
      const device = page.rows[index];
      page.rows[index] = null;
      if (!matches(device, query)) continue;
      rowNumber += 1;
      lines.push(columns.map(({ key }) => csvQuote(cellText(device, key, rowNumber))).join(";"));
      if (lines.length >= batchSize) {
        const chunk = `${lines.join("\r\n")}\r\n`;
        lines = [];
        yield chunk;
      }
    }
    if (!page.hasMore) break;
    if (page.nextCursor === null || page.nextCursor === undefined || page.nextCursor === afterId) {
      throw new Error("Постраничное чтение Inventory не продвинуло курсор");
    }
    afterId = page.nextCursor;
  }
  if (lines.length) yield lines.join("\r\n");
}

export class TableTsvCollector {
  constructor(columns = [], { chunkRows = 500 } = {}) {
    this.columns = columns;
    this.chunkRows = Math.max(1, Number(chunkRows) || 500);
    this.parts = [tableRowsTsv([], columns)];
    this.rows = [];
    this.rowCount = 0;
    this.chunkCount = 0;
    this.rowOffset = 0;
    this.finished = false;
  }

  add(row) {
    if (this.finished) throw new Error("TSV collector is already finished");
    this.rows.push(row);
    this.rowCount += 1;
    if (this.rows.length >= this.chunkRows) this.flush();
  }

  flush() {
    if (!this.rows.length) return;
    this.parts.push(`\r\n${tableRowsTsv(this.rows, this.columns, { includeHeaders: false, rowOffset: this.rowOffset })}`);
    this.rowOffset += this.rows.length;
    this.rows = [];
    this.chunkCount += 1;
  }

  finish() {
    if (this.finished) throw new Error("TSV collector is already finished");
    this.flush();
    this.finished = true;
    const blob = new Blob(this.parts, { type: "text/plain" });
    this.parts = [];
    return { blob, rowCount: this.rowCount, chunkCount: this.chunkCount };
  }
}
