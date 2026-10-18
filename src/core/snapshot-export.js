import { MAX_SHEET_DATA_ROWS } from "./xlsx-export.js";

function csvQuote(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function createSnapshotXlsxSheets(database, snapshot, columns, { maxDataRowsPerSheet = MAX_SHEET_DATA_ROWS } = {}) {
  if (!snapshot?.id || typeof database?.iterateSnapshotDevices !== "function") throw new TypeError("Для экспорта XLSX нужен Final и потоковое чтение его строк");
  if (!Array.isArray(columns) || !columns.length) throw new TypeError("Для экспорта XLSX нужен список колонок");
  const deviceCount = Number(snapshot.deviceCount);
  if (!Number.isSafeInteger(deviceCount) || deviceCount < 0) throw new TypeError("Для экспорта XLSX нужно точное число устройств Final");
  const maximum = Math.max(1, Math.min(MAX_SHEET_DATA_ROWS, Math.floor(Number(maxDataRowsPerSheet) || MAX_SHEET_DATA_ROWS)));
  const metadata = [
    ["ID Final", snapshot.id], ["Название", snapshot.name || ""], ["Источник", snapshot.source || ""],
    ["Дата наблюдения", snapshot.createdAt || ""], ["Тип снимка", snapshot.snapshotType || "final"],
    ["Устройств", deviceCount], ["Некорректных строк", Number(snapshot.invalidCount || 0)],
    ["Время обработки, мс", Number(snapshot.processingTimeMs || 0)],
  ];
  const sheets = [{
    name: "Сведения о Final",
    headings: ["Поле", "Значение"],
    rows: (async function* rows() { for (const row of metadata) yield row; })(),
  }];
  const sheetCount = Math.max(1, Math.ceil(deviceCount / maximum));
  for (let index = 0; index < sheetCount; index += 1) {
    const start = index * maximum;
    const count = Math.min(maximum, Math.max(0, deviceCount - start));
    sheets.push({
      name: index === 0 ? "Устройства" : `Устройства ${index + 1}`,
      headings: columns.map(({ label }) => label),
      rows: (async function* rows() {
        let exported = 0;
        for await (const device of database.iterateSnapshotDevices(snapshot.id, { start, limit: count })) {
          yield columns.map(({ key }) => {
            const value = device?.[key];
            return value && typeof value === "object" ? JSON.stringify(value) : value ?? "";
          });
          exported += 1;
        }
        if (exported !== count) throw new Error(`Final ${snapshot.name || snapshot.id}: экспортировано ${exported} из ${count} устройств листа`);
      })(),
    });
  }
  return sheets;
}

async function writeSnapshotRows(snapshot, visitSnapshotChunks, writable, formatRow, {
  firstPrefix = "",
  separator = "\n",
  maxBytes = 256 * 1024,
} = {}) {
  let rows = [];
  let bytes = 0;
  let hasRows = false;
  const flush = async () => {
    if (!rows.length) return;
    await writable.write(`${hasRows ? separator : firstPrefix}${rows.join(separator)}`);
    hasRows = true;
    rows = [];
    bytes = 0;
  };
  await visitSnapshotChunks(snapshot.id, async (devices) => {
    for (const device of devices) {
      const row = formatRow(device);
      const rowBytes = row.length * 2;
      const separatorBytes = rows.length ? separator.length * 2 : 0;
      if (rows.length && bytes + separatorBytes + rowBytes > maxBytes) await flush();
      if (!rows.length) bytes = (hasRows ? separator : firstPrefix).length * 2;
      else bytes += separatorBytes;
      rows.push(row);
      bytes += rowBytes;
      if (bytes >= maxBytes) await flush();
    }
  });
  await flush();
  return hasRows;
}

function writableOrThrow(snapshot, visitSnapshotChunks, writable, format) {
  if (!snapshot?.id || typeof visitSnapshotChunks !== "function") throw new TypeError(`Для экспорта ${format} нужен Final и поток его чанков`);
  if (!writable || typeof writable.write !== "function") throw new TypeError(`Для потокового экспорта ${format} нужен файловый поток`);
}

export async function snapshotCsvBlob(snapshot, visitSnapshotChunks, columns = []) {
  if (!snapshot?.id || typeof visitSnapshotChunks !== "function") throw new TypeError("Для экспорта CSV нужен Final и поток его чанков");
  const parts = [`\uFEFF${columns.map((column) => csvQuote(column.label)).join(";")}`];
  let rows = [];
  const flush = () => {
    if (!rows.length) return;
    parts.push(`\r\n${rows.join("\r\n")}`);
    rows = [];
  };
  await visitSnapshotChunks(snapshot.id, (devices) => {
    for (const device of devices) {
      rows.push(columns.map(({ key }) => csvQuote(device?.[key])).join(";"));
      if (rows.length >= 500) flush();
    }
  });
  flush();
  return new Blob(parts, { type: "text/csv;charset=utf-8" });
}

export async function writeSnapshotCsv(snapshot, visitSnapshotChunks, columns = [], writable) {
  writableOrThrow(snapshot, visitSnapshotChunks, writable, "CSV");
  if (!Array.isArray(columns)) throw new TypeError("Для экспорта CSV нужен список колонок");
  await writable.write(`\uFEFF${columns.map((column) => csvQuote(column.label)).join(";")}`);
  await writeSnapshotRows(snapshot, visitSnapshotChunks, writable,
    (device) => columns.map(({ key }) => csvQuote(device?.[key])).join(";"), { firstPrefix: "\r\n", separator: "\r\n" });
}

function snapshotTextHeader(snapshot, columns) {
  const metadata = [
    ["ID Final", snapshot.id], ["Название", snapshot.name || ""], ["Источник", snapshot.source || ""],
    ["Дата", snapshot.createdAt || ""], ["Устройств", Number(snapshot.deviceCount || 0)],
    ["Некорректных строк", Number(snapshot.invalidCount || 0)],
  ];
  return `Final MAC Analyzer Pro Next\n${metadata.map(([label, value]) => `${label}: ${JSON.stringify(value ?? "")}`).join("\n")}\n\nУстройства\n${columns.map(({ label }) => label).join("\t")}`;
}

export async function snapshotTextBlob(snapshot, visitSnapshotChunks, columns = []) {
  if (!snapshot?.id || typeof visitSnapshotChunks !== "function") throw new TypeError("Для экспорта TXT нужен Final и поток его чанков");
  if (!Array.isArray(columns)) throw new TypeError("Для экспорта TXT нужен список колонок");
  const parts = [snapshotTextHeader(snapshot, columns)];
  let rows = [];
  const flush = () => {
    if (!rows.length) return;
    parts.push(`\n${rows.join("\n")}`);
    rows = [];
  };
  await visitSnapshotChunks(snapshot.id, (devices) => {
    for (const device of devices) {
      rows.push(columns.map(({ key }) => JSON.stringify(device?.[key] ?? "")).join("\t"));
      if (rows.length >= 500) flush();
    }
  });
  flush();
  return new globalThis.Blob(parts, { type: "text/plain;charset=utf-8" });
}

export async function writeSnapshotText(snapshot, visitSnapshotChunks, columns = [], writable) {
  writableOrThrow(snapshot, visitSnapshotChunks, writable, "TXT");
  if (!Array.isArray(columns)) throw new TypeError("Для экспорта TXT нужен список колонок");
  await writable.write(snapshotTextHeader(snapshot, columns));
  await writeSnapshotRows(snapshot, visitSnapshotChunks, writable,
    (device) => columns.map(({ key }) => JSON.stringify(device?.[key] ?? "")).join("\t"),
    { firstPrefix: "\n", separator: "\n", maxBytes: 64 * 1024 });
}

export async function snapshotJsonBlob(snapshot, visitSnapshotChunks) {
  if (!snapshot?.id || typeof visitSnapshotChunks !== "function") throw new TypeError("Для экспорта JSON нужен Final и поток его чанков");
  const metadata = JSON.stringify(snapshot, null, 2);
  if (!metadata || metadata[0] !== "{" || metadata.at(-1) !== "}") throw new TypeError("Метаданные Final имеют некорректный формат");
  const parts = [`${metadata.slice(0, -1)},\n  "devices": [\n`];
  let hasDevice = false;
  await visitSnapshotChunks(snapshot.id, (devices) => {
    for (const device of devices) {
      const row = JSON.stringify(device, null, 2).split("\n").map((line) => `    ${line}`).join("\n");
      parts.push(`${hasDevice ? ",\n" : ""}${row}`);
      hasDevice = true;
    }
  });
  parts.push("\n  ]\n}");
  return new Blob(parts, { type: "application/json" });
}

export async function writeSnapshotJson(snapshot, visitSnapshotChunks, writable) {
  writableOrThrow(snapshot, visitSnapshotChunks, writable, "JSON");
  const metadata = JSON.stringify(snapshot, null, 2);
  if (!metadata || metadata[0] !== "{" || metadata.at(-1) !== "}") throw new TypeError("Метаданные Final имеют некорректный формат");
  await writable.write(`${metadata.slice(0, -1)},\n  "devices": [\n`);
  const hasRows = await writeSnapshotRows(snapshot, visitSnapshotChunks, writable,
    (device) => JSON.stringify(device, null, 2).split("\n").map((line) => `    ${line}`).join("\n"),
    { separator: ",\n" });
  await writable.write(`${hasRows ? "\n" : ""}  ]\n}`);
}

export async function snapshotYamlBlob(snapshot, visitSnapshotChunks) {
  if (!snapshot?.id || typeof visitSnapshotChunks !== "function") throw new TypeError("Для экспорта YAML нужен Final и поток его чанков");
  const metadata = Object.entries(snapshot).filter(([key, value]) => key !== "devices" && value !== undefined);
  const parts = ["---\n", ...metadata.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}\n`), '"devices":'];
  let rows = [];
  let hasDevices = false;
  const flush = () => {
    if (!rows.length) return;
    parts.push(`\n  - ${rows.join("\n  - ")}\n`);
    hasDevices = true;
    rows = [];
  };
  await visitSnapshotChunks(snapshot.id, (devices) => {
    for (const device of devices) {
      const value = JSON.stringify(device ?? null);
      rows.push(value === undefined ? "null" : value);
      if (rows.length >= 500) flush();
    }
  });
  flush();
  if (!hasDevices) parts.push(" []\n");
  return new Blob(parts, { type: "application/yaml;charset=utf-8" });
}

export async function writeSnapshotYaml(snapshot, visitSnapshotChunks, writable) {
  writableOrThrow(snapshot, visitSnapshotChunks, writable, "YAML");
  const metadata = Object.entries(snapshot).filter(([key, value]) => key !== "devices" && value !== undefined);
  await writable.write(`---\n${metadata.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}\n`).join("")}"devices":`);
  const hasRows = await writeSnapshotRows(snapshot, visitSnapshotChunks, writable, (device) => {
    const value = JSON.stringify(device ?? null);
    return value === undefined ? "null" : value;
  }, { firstPrefix: "\n  - ", separator: "\n  - " });
  await writable.write(hasRows ? "\n" : " []\n");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function htmlHeader(snapshot, metadata, exportColumns) {
  return [
    "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    `<title>${escapeHtml(snapshot.name || "Final")}</title>`,
    "<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#172b28}h1{font-size:22px}dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border:1px solid #cbd5d1;padding:5px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{position:sticky;top:0;background:#edf4f1}tr:nth-child(even){background:#f8faf9}@media print{body{margin:8mm}.table-wrap{overflow:visible}th{position:static}}</style></head><body>",
    `<h1>${escapeHtml(snapshot.name || "Final")}</h1><dl>${metadata.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(JSON.stringify(value) ?? "")}</dd>`).join("")}</dl>`,
    `<div class="table-wrap"><table><thead><tr>${exportColumns.map(({ label }) => `<th scope="col">${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>`,
  ].join("");
}

function htmlRow(device, columns) {
  const cellText = (value) => value && typeof value === "object" ? JSON.stringify(value) : value;
  return `<tr>${columns.map(({ key }) => `<td>${escapeHtml(cellText(device?.[key]))}</td>`).join("")}</tr>`;
}

export async function writeSnapshotHtml(snapshot, visitSnapshotChunks, columns = [], writable) {
  if (!snapshot?.id || typeof visitSnapshotChunks !== "function") throw new TypeError("Для экспорта HTML нужен Final и поток его чанков");
  if (!Array.isArray(columns)) throw new TypeError("Для экспорта HTML нужен список колонок");
  if (!writable || typeof writable.write !== "function") throw new TypeError("Для потокового HTML-экспорта нужен файловый поток");
  const metadata = Object.entries(snapshot).filter(([key, value]) => key !== "devices" && value !== undefined);
  const resolvedColumns = new Map(columns.map((column) => [String(column.key), column]));
  await visitSnapshotChunks(snapshot.id, (devices) => {
    for (const device of devices) for (const key of Object.keys(device || {})) {
      if (!resolvedColumns.has(key)) resolvedColumns.set(key, { key, label: key });
    }
  });
  const exportColumns = [...resolvedColumns.values()];
  await writable.write(htmlHeader(snapshot, metadata, exportColumns));
  let rows = [];
  let bytes = 0;
  const flush = async () => {
    if (!rows.length) return;
    await writable.write(rows.join(""));
    rows = [];
    bytes = 0;
  };
  await visitSnapshotChunks(snapshot.id, async (devices) => {
    for (const device of devices) {
      const row = htmlRow(device, exportColumns);
      const rowBytes = row.length * 2;
      if (rows.length && bytes + rowBytes > 256 * 1024) await flush();
      rows.push(row);
      bytes += rowBytes;
      if (bytes >= 256 * 1024) await flush();
    }
  });
  await flush();
  await writable.write("</tbody></table></div></body></html>");
}

export async function snapshotHtmlBlob(snapshot, visitSnapshotChunks, columns = []) {
  if (!snapshot?.id || typeof visitSnapshotChunks !== "function") throw new TypeError("Для экспорта HTML нужен Final и поток его чанков");
  if (!Array.isArray(columns)) throw new TypeError("Для экспорта HTML нужен список колонок");
  const metadata = Object.entries(snapshot).filter(([key, value]) => key !== "devices" && value !== undefined);
  const resolvedColumns = new Map(columns.map((column) => [String(column.key), column]));
  await visitSnapshotChunks(snapshot.id, (devices) => {
    for (const device of devices) {
      for (const key of Object.keys(device || {})) if (!resolvedColumns.has(key)) resolvedColumns.set(key, { key, label: key });
    }
  });
  const exportColumns = [...resolvedColumns.values()];
  const parts = [htmlHeader(snapshot, metadata, exportColumns)];
  let rows = [];
  const flush = () => {
    if (!rows.length) return;
    parts.push(rows.join(""));
    rows = [];
  };
  await visitSnapshotChunks(snapshot.id, (devices) => {
    for (const device of devices) {
      rows.push(htmlRow(device, exportColumns));
      if (rows.length >= 500) flush();
    }
  });
  flush();
  parts.push("</tbody></table></div></body></html>");
  return new Blob(parts, { type: "text/html;charset=utf-8" });
}
