function safeSpreadsheetText(value) {
  const text = String(value ?? "");
  if (typeof value === "number") return text;
  return /^[\s\u0000-\u001f]*[=+\-@]/u.test(text) ? `'${text}` : text;
}

export function csvQuote(value) {
  return `"${safeSpreadsheetText(value).replaceAll('"', '""')}"`;
}

export function csvQuoteMinimal(value) {
  const text = safeSpreadsheetText(value);
  return /[",\r\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function tsvQuote(value) {
  const text = safeSpreadsheetText(value);
  return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
