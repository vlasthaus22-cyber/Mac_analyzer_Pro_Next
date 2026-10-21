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

/** Collect text through a one-chunk-at-a-time stream when file or transform writers are unavailable. */
export function createTextBlobStreamSink(mime) {
  if (typeof globalThis.ReadableStream !== "function" || typeof globalThis.Response !== "function") return null;
  let closed = false;
  let failure = null;
  let pendingWrite = null;
  const readers = [];
  const abortError = () => new DOMException("Поток экспорта отменён", "AbortError");
  const iterator = {
    next() {
      if (failure) return Promise.reject(failure);
      if (pendingWrite) {
        const write = pendingWrite;
        pendingWrite = null;
        write.resolve();
        return Promise.resolve({ value: write.value, done: false });
      }
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => readers.push({ resolve, reject }));
    },
    return(reason) {
      if (!failure && !closed) failure = reason instanceof Error ? reason : abortError();
      closed = true;
      pendingWrite?.reject(failure);
      pendingWrite = null;
      while (readers.length) readers.shift().reject(failure);
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() { return this; },
  };
  const readable = readableTextStreamFromIterable(iterator);
  const blobPromise = new globalThis.Response(readable, { headers: { "Content-Type": String(mime || "text/plain;charset=utf-8") } }).blob();
  const writable = {
    async write(chunk) {
      if (failure) throw failure;
      if (closed) throw new TypeError("Поток экспорта уже закрыт");
      if (pendingWrite) await pendingWrite.promise;
      if (failure) throw failure;
      if (closed) throw new TypeError("Поток экспорта уже закрыт");
      const value = String(chunk ?? "");
      if (readers.length) {
        readers.shift().resolve({ value, done: false });
        return;
      }
      let resolve;
      let reject;
      const promise = new Promise((settle, fail) => { resolve = settle; reject = fail; });
      pendingWrite = { value, promise, resolve, reject };
      await promise;
    },
    async close() {
      if (failure) throw failure;
      if (closed) return;
      closed = true;
      while (readers.length) readers.shift().resolve({ value: undefined, done: true });
    },
    async abort(error = new Error("Запись экспорта отменена")) {
      if (!failure) failure = error;
      closed = true;
      pendingWrite?.reject(failure);
      pendingWrite = null;
      while (readers.length) readers.shift().reject(failure);
    },
  };
  return { writable, blobPromise };
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
