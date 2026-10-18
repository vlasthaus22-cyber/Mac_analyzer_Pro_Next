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
