function normalizeSliceIndex(value, size, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (Number.isNaN(number) || number === 0) return 0;
  if (!Number.isFinite(number)) return number < 0 ? 0 : size;
  const integer = Math.trunc(number);
  return integer < 0 ? Math.max(size + integer, 0) : Math.min(integer, size);
}

/** Expose retained Base64 bytes as a Blob-like file without decoding the full payload. */
export function createBase64FileView(contentBase64, { name = "queued-file", type = "", lastModified = Date.now() } = {}) {
  if (typeof contentBase64 !== "string" || contentBase64.length % 4 !== 0) {
    throw new Error("В очереди сохранён некорректный Base64-файл");
  }
  if (typeof globalThis.atob !== "function" || typeof globalThis.Blob !== "function") {
    throw new Error("Браузер не поддерживает потоковое чтение файла из очереди");
  }
  const padding = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
  const size = contentBase64.length / 4 * 3 - padding;
  const decodeSlice = (start, end, sliceType) => {
    const byteStart = normalizeSliceIndex(start, size, 0);
    const byteEnd = Math.max(byteStart, normalizeSliceIndex(end, size, size));
    if (byteEnd === byteStart) return new Blob([], { type: sliceType });
    const alignedStart = Math.floor(byteStart / 3) * 3;
    const alignedEnd = Math.min(size, Math.ceil(byteEnd / 3) * 3);
    const encodedStart = alignedStart / 3 * 4;
    const encodedEnd = Math.min(contentBase64.length, Math.ceil(alignedEnd / 3) * 4);
    const binary = globalThis.atob(contentBase64.slice(encodedStart, encodedEnd));
    const decoded = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
    const offset = byteStart - alignedStart;
    return new Blob([decoded.subarray(offset, offset + byteEnd - byteStart)], { type: sliceType });
  };
  return Object.freeze({
    name: String(name),
    type: String(type).toLowerCase(),
    size,
    lastModified: Number.isFinite(Number(lastModified)) ? Number(lastModified) : Date.now(),
    slice(start = 0, end = size, sliceType = "") {
      return decodeSlice(start, end, sliceType);
    },
    async arrayBuffer() {
      return decodeSlice(0, size, type).arrayBuffer();
    },
  });
}
