export function readableTextStreamFromIterable(iterable, { signal = null, encoder = new globalThis.TextEncoder() } = {}) {
  if (!iterable || (typeof iterable[Symbol.asyncIterator] !== "function" && typeof iterable[Symbol.iterator] !== "function")) {
    throw new TypeError("Ожидалась синхронная или асинхронная последовательность текстовых частей");
  }
  if (typeof globalThis.ReadableStream !== "function") throw new Error("ReadableStream недоступен в этом браузере");
  const iterator = typeof iterable[Symbol.asyncIterator] === "function" ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
  let finished = false;
  const stop = async (reason) => {
    if (finished) return;
    finished = true;
    await iterator.return?.(reason);
  };
  return new globalThis.ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        await stop(signal.reason);
        controller.error(new DOMException("Операция отменена", "AbortError"));
        return;
      }
      try {
        const result = await iterator.next();
        if (result.done) {
          finished = true;
          controller.close();
          return;
        }
        if (signal?.aborted) {
          await stop(signal.reason);
          controller.error(new DOMException("Операция отменена", "AbortError"));
          return;
        }
        controller.enqueue(encoder.encode(String(result.value ?? "")));
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
    async cancel(reason) {
      await stop(reason);
    },
  }, { highWaterMark: 1 });
}

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
