export function tableRowsTsv(rows = [], columns = [], { includeHeaders = true, rowOffset = 0 } = {}) {
  const quote = (value) => {
    const text = value === null || value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value);
    return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
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
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  yield `\uFEFF${columns.map(({ label }) => quote(label)).join(";")}\r\n`;
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
      lines.push(columns.map(({ key }) => quote(cellText(device, key, rowNumber))).join(";"));
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
