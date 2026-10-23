export async function saveReadableStreamToFile(stream, {
  suggestedName,
  description = "JSON",
  mimeType = "application/json",
  extension = ".json",
  picker = globalThis.showSaveFilePicker,
} = {}) {
  if (!stream || typeof stream.pipeTo !== "function") throw new TypeError("Ожидался ReadableStream для записи файла");
  if (typeof picker !== "function") return false;
  const handle = await picker({
    suggestedName: String(suggestedName || "export.json"),
    types: [{ description, accept: { [mimeType]: [extension] } }],
  });
  const writable = await handle.createWritable();
  await stream.pipeTo(writable);
  return true;
}
