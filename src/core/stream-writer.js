export async function writeReadableStreamToWritable(stream, writable, { signal = null } = {}) {
  if (!stream || typeof stream.getReader !== "function") throw new TypeError("Ожидался поток для записи в файл");
  if (!writable || typeof writable.write !== "function" || typeof writable.close !== "function") throw new TypeError("Ожидался разрешённый поток записи файла");
  const reader = stream.getReader();
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      await writable.write(value);
    }
    await writable.close();
    return true;
  } catch (error) {
    try { await writable.abort?.(error); } catch { /* Preserve the original write error. */ }
    try { await reader.cancel(error); } catch { /* Preserve the original write error. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
