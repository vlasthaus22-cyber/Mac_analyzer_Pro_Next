export function requestReadableStreamFileHandle({
  suggestedName,
  description = "JSON",
  mimeType = "application/json",
  extension = ".json",
  picker = globalThis.showSaveFilePicker,
} = {}) {
  if (typeof picker !== "function") return null;
  return picker({
    suggestedName: String(suggestedName || "export.json"),
    types: [{ description, accept: { [mimeType]: [extension] } }],
  });
}

export async function saveReadableStreamToFile(stream, {
  suggestedName,
  description = "JSON",
  mimeType = "application/json",
  extension = ".json",
  picker = globalThis.showSaveFilePicker,
  fileHandle = null,
} = {}) {
  if (!stream || typeof stream.pipeTo !== "function") throw new TypeError("Ожидался ReadableStream для записи файла");
  const handle = fileHandle || await requestReadableStreamFileHandle({ suggestedName, description, mimeType, extension, picker });
  if (!handle) return false;
  const writable = await handle.createWritable();
  await stream.pipeTo(writable);
  return true;
}
