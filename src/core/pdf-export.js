import { assertBrowserHeapCapacity } from "./import-limits.js";

const PDF_ROWS_PER_PAGE = 50;
const PAGE_MARGIN = 22;
const PDF_ESTIMATED_BYTES_PER_CELL = 768;
const PDF_ESTIMATED_BYTES_PER_PAGE = 16 * 1024;
const PDF_FONT_HEAP_MULTIPLIER = 2;
const MAX_ESTIMATED_PDF_HEAP_BYTES = 512 * 1024 * 1024;
const FIELD_ALIASES = Object.freeze({
  ip: ["ip", "deviceIp", "device_ip"],
  switchIp: ["switchIp", "switch_ip"],
  switchPort: ["switchPort", "switch_port"],
  manufacturer: ["manufacturer", "vendor"],
  smartroomId: ["smartroomId", "smartroom_id"],
  authenticationTime: ["authenticationTime", "authTime", "lastSeen"],
  serial: ["serial", "serialNumber", "serial_number"],
  deviceId: ["deviceId", "device_id", "asset_id"],
  deviceName: ["deviceName", "device_name"],
  physicalAddress: ["physicalAddress", "physical_address"],
});

function columnWeight(key) {
  if (/address|location/i.test(key)) return 1.55;
  if (/manufacturer|vendor|model|hostname|serial|authenticationTime/i.test(key)) return 1.4;
  if (/mac|ip|smartroom/i.test(key)) return 1.2;
  if (/type|room/i.test(key)) return 1.05;
  return 0.9;
}

function columnValue(device, column, rowNumber) {
  if (typeof column.value === "function") return column.value(device, rowNumber);
  const aliases = FIELD_ALIASES[column.key] || [column.key];
  for (const key of aliases) {
    const value = device?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return "";
}

function displayValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

function fitText(pdf, value, width) {
  const text = displayValue(value);
  if (!text || pdf.getTextWidth(text) <= width) return text;
  const suffix = "…";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (pdf.getTextWidth(`${text.slice(0, middle)}${suffix}`) <= width) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}${suffix}`;
}

async function fontBinaryString(fontData) {
  if (typeof fontData === "string" && fontData.length) return fontData;
  const embeddedBase64 = globalThis.__MAC_ANALYZER_PDF_FONT_BASE64__;
  if (typeof embeddedBase64 === "string" && embeddedBase64.length) return globalThis.atob(embeddedBase64);
  const response = await globalThis.fetch("assets/NotoSans-Regular.ttf");
  if (!response.ok) throw new Error("Не удалось загрузить встроенный кириллический шрифт для PDF");
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const batchSize = 16_384;
  for (let offset = 0; offset < bytes.length; offset += batchSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + batchSize));
  }
  return binary;
}

function pageColumnWidths(pdf, columns) {
  const width = pdf.internal.pageSize.getWidth() - PAGE_MARGIN * 2;
  const totalWeight = columns.reduce((sum, column) => sum + columnWeight(column.key), 0);
  return columns.map((column) => width * columnWeight(column.key) / totalWeight);
}

function drawPageHeader(pdf, snapshot, columns, widths, pageNumber, pageCount) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const title = snapshot.name || snapshot.id;
  pdf.setFont("NotoSans", "normal");
  pdf.setFontSize(13);
  pdf.setTextColor(23, 43, 40);
  pdf.text("MAC Analyzer Pro - Отчет", PAGE_MARGIN, 25);
  pdf.setFontSize(7);
  pdf.setTextColor(74, 87, 84);
  pdf.text(`Final: ${title}`, PAGE_MARGIN, 39);
  pdf.text(`Дата экспорта: ${new Date().toISOString().slice(0, 19).replace("T", " ")} · Страница ${pageNumber} из ${pageCount}`, PAGE_MARGIN, 50);

  const top = 60;
  const height = 23;
  pdf.setFillColor(75, 85, 99);
  pdf.rect(PAGE_MARGIN, top, pageWidth - PAGE_MARGIN * 2, height, "F");
  pdf.setDrawColor(150, 160, 164);
  pdf.setLineWidth(0.25);
  let x = PAGE_MARGIN;
  columns.forEach((column, index) => {
    const cellWidth = widths[index];
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(6.2);
    pdf.text(fitText(pdf, column.label || column.key, cellWidth - 6), x + 3, top + 14);
    pdf.setDrawColor(190, 198, 201);
    pdf.rect(x, top, cellWidth, height);
    x += cellWidth;
  });
  pdf.setFont("NotoSans", "normal");
  return top + height;
}

function drawDeviceRow(pdf, device, columns, widths, index, y, rowHeight) {
  let x = PAGE_MARGIN;
  const fontSize = 6.2;
  pdf.setFontSize(fontSize);
  columns.forEach((column, columnIndex) => {
    const width = widths[columnIndex];
    const fill = index % 2 ? [248, 250, 249] : [255, 255, 255];
    pdf.setFillColor(...fill);
    pdf.setDrawColor(180, 190, 191);
    pdf.rect(x, y, width, rowHeight, "FD");
    pdf.setTextColor(23, 43, 40);
    const text = fitText(pdf, columnValue(device, column, index + 1), width - 6);
    if (text) pdf.text(text, x + 3, y + rowHeight * 0.68);
    x += width;
  });
}

export async function createSnapshotPdfBlob(snapshot, visitSnapshotChunks, columns = [], {
  jsPDF = globalThis.jspdf?.jsPDF,
  fontData = "",
  onProgress = null,
  memoryInfo = globalThis.performance?.memory,
} = {}) {
  if (!snapshot?.id || typeof visitSnapshotChunks !== "function") throw new TypeError("Для PDF нужен Final и потоковое чтение его строк");
  if (!Array.isArray(columns) || !columns.length) throw new TypeError("Для PDF нужен хотя бы один столбец");
  if (typeof jsPDF !== "function") throw new Error("Не загружен локальный модуль PDF");
  const deviceCount = Number(snapshot.deviceCount);
  if (!Number.isSafeInteger(deviceCount) || deviceCount < 0) throw new TypeError("Для PDF нужно точное число устройств Final");
  const estimatedBytes = estimateSnapshotPdfMemoryBytes(deviceCount, columns.length, fontData.length || globalThis.__MAC_ANALYZER_PDF_FONT_BASE64__?.length || 0);
  if (estimatedBytes > MAX_ESTIMATED_PDF_HEAP_BYTES) {
    const error = new Error(`Оценка памяти PDF превышает ${Math.round(MAX_ESTIMATED_PDF_HEAP_BYTES / 1024 / 1024)} МиБ. Для этого объёма экспортируйте XLSX или CSV.`);
    error.code = "PDF_HEAP_LIMIT";
    error.actual = estimatedBytes;
    error.maximum = MAX_ESTIMATED_PDF_HEAP_BYTES;
    throw error;
  }
  try {
    assertBrowserHeapCapacity(estimatedBytes, memoryInfo);
  } catch (cause) {
    const error = new Error(`Недостаточно свободной памяти для PDF. Оценка: ${Math.ceil(estimatedBytes / 1024 / 1024)} МиБ. Закройте другие вкладки или выберите XLSX/CSV.`, { cause });
    error.code = "PDF_HEAP_LIMIT";
    error.actual = estimatedBytes;
    error.maximum = cause.maximum;
    throw error;
  }
  const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4", compress: true });
  pdf.addFileToVFS("NotoSans-Regular.ttf", await fontBinaryString(fontData));
  pdf.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  pdf.setFont("NotoSans", "normal");
  pdf.setProperties({ title: `MAC Analyzer Pro - ${snapshot.name || snapshot.id}`, subject: "Экспорт полного Final", creator: "MAC Analyzer Pro Next" });

  const widths = pageColumnWidths(pdf, columns);
  const pageCount = Math.max(1, Math.ceil(deviceCount / PDF_ROWS_PER_PAGE));
  const contentTop = pdf.internal.pageSize.getHeight() - PAGE_MARGIN - 8;
  const tableTop = drawPageHeader(pdf, snapshot, columns, widths, 1, pageCount);
  const rowHeight = (contentTop - tableTop) / PDF_ROWS_PER_PAGE;
  let exported = 0;
  let currentPage = 1;
  let pageRow = 0;
  if (!deviceCount) {
    pdf.setFontSize(9);
    pdf.setTextColor(90, 100, 100);
    pdf.text("В этом Final нет устройств.", PAGE_MARGIN, tableTop + 20);
  }
  await visitSnapshotChunks(snapshot.id, async (devices = []) => {
    for (const device of devices) {
      if (exported >= deviceCount) throw new Error("PDF остановлен: строк больше, чем указано в метаданных Final");
      if (pageRow === PDF_ROWS_PER_PAGE) {
        pdf.addPage("a4", "landscape");
        currentPage += 1;
        pageRow = 0;
        drawPageHeader(pdf, snapshot, columns, widths, currentPage, pageCount);
      }
      drawDeviceRow(pdf, device, columns, widths, exported, tableTop + pageRow * rowHeight, rowHeight);
      pageRow += 1;
      exported += 1;
    }
    if (typeof onProgress === "function") onProgress({ exported, total: deviceCount });
  });
  if (exported !== deviceCount) throw new Error(`PDF остановлен: ожидалось ${deviceCount.toLocaleString("ru-RU")} строк, прочитано ${exported.toLocaleString("ru-RU")}`);
  const blob = pdf.output("blob");
  if (!(blob instanceof globalThis.Blob) || blob.size < 8 || blob.type !== "application/pdf") throw new Error("PDF не сформирован корректно");
  return blob;
}

export const SNAPSHOT_PDF_ROWS_PER_PAGE = PDF_ROWS_PER_PAGE;

export function estimateSnapshotPdfMemoryBytes(deviceCount, columnCount, fontCharacters = 0) {
  const rows = Math.max(0, Number(deviceCount) || 0);
  const columns = Math.max(0, Number(columnCount) || 0);
  const pages = Math.max(1, Math.ceil(rows / PDF_ROWS_PER_PAGE));
  return rows * columns * PDF_ESTIMATED_BYTES_PER_CELL
    + pages * PDF_ESTIMATED_BYTES_PER_PAGE
    + Math.max(0, Number(fontCharacters) || 0) * PDF_FONT_HEAP_MULTIPLIER;
}

export const MAX_ESTIMATED_PDF_HEAP_BYTES_EXCLUSIVE = MAX_ESTIMATED_PDF_HEAP_BYTES;
