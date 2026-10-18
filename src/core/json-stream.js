const DEFAULT_CHUNK_CHARS = 256 * 1024;
const JSON_ARRAY_STREAM = Symbol("json-array-stream");

export function streamJsonArray(iterable) {
  if (!iterable || (typeof iterable[Symbol.iterator] !== "function" && typeof iterable[Symbol.asyncIterator] !== "function")) {
    throw new TypeError("Поток JSON-массива должен быть итерируемым");
  }
  return { [JSON_ARRAY_STREAM]: iterable };
}

function omitted(value) {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function jsonValue(value) {
  if (value && typeof value.toJSON === "function") return value.toJSON();
  return value;
}

export async function writePrettyJson(value, writable, { chunkChars = DEFAULT_CHUNK_CHARS, indentation = 2 } = {}) {
  if (!writable || typeof writable.write !== "function") throw new TypeError("Для JSON-экспорта нужен поток записи");
  const maxChunkChars = Math.max(2, Math.floor(Number(chunkChars) || DEFAULT_CHUNK_CHARS));
  const indentSize = Math.max(0, Math.min(8, Math.floor(Number(indentation) || 0)));
  const indentUnit = " ".repeat(indentSize);
  const pending = [];
  let pendingChars = 0;
  const flush = async () => {
    if (!pendingChars) return;
    const chunk = pending.join("");
    pending.length = 0;
    pendingChars = 0;
    await writable.write(chunk);
  };
  const append = async (text) => {
    const valueText = String(text);
    let offset = 0;
    while (offset < valueText.length) {
      const available = maxChunkChars - pendingChars;
      let end = Math.min(valueText.length, offset + available);
      if (end < valueText.length && end > offset) {
        const codeUnit = valueText.charCodeAt(end - 1);
        if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) end -= 1;
      }
      if (end === offset) {
        await flush();
        continue;
      }
      const part = valueText.slice(offset, end);
      pending.push(part);
      pendingChars += part.length;
      offset = end;
      if (pendingChars >= maxChunkChars) await flush();
    }
  };
  const seen = new WeakSet();
  const render = async (rawValue, depth, inArray = false) => {
    let current = jsonValue(rawValue);
    if (omitted(current)) {
      if (inArray) await append("null");
      return false;
    }
    if (current === null || typeof current !== "object") {
      const encoded = JSON.stringify(current);
      if (encoded === undefined) {
        if (inArray) await append("null");
        return false;
      }
      await append(encoded);
      return true;
    }
    if (seen.has(current)) throw new TypeError("Циклические ссылки нельзя экспортировать в JSON");
    seen.add(current);
    try {
      const streamedArray = current[JSON_ARRAY_STREAM];
      if (Array.isArray(current) || streamedArray) {
        const values = streamedArray || current;
        if (!streamedArray && !current.length) {
          await append("[]");
          return true;
        }
        let index = 0;
        for await (const item of values) {
          if (!index) await append("[\n");
          if (index) await append(",\n");
          await append(`${indentUnit.repeat(depth + 1)}`);
          await render(item, depth + 1, true);
          index += 1;
        }
        if (!index) {
          await append("[]");
          return true;
        }
        await append("\n");
        await append(`${indentUnit.repeat(depth)}]`);
        return true;
      }
      const keys = Object.keys(current).filter((key) => !omitted(current[key]));
      if (!keys.length) {
        await append("{}");
        return true;
      }
      await append("{\n");
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        await append(`${indentUnit.repeat(depth + 1)}${JSON.stringify(key)}: `);
        await render(current[key], depth + 1, false);
        await append(index + 1 === keys.length ? "\n" : ",\n");
      }
      await append(`${indentUnit.repeat(depth)}}`);
      return true;
    } finally {
      seen.delete(current);
    }
  };

  const rendered = await render(value, 0);
  if (!rendered) throw new TypeError("Корневое значение нельзя экспортировать в JSON");
  await append("\n");
  await flush();
}
