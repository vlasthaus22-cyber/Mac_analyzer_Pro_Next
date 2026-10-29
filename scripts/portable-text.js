import { readFile } from "node:fs/promises";

export function normalizePortableText(source) {
  if (typeof source !== "string") throw new TypeError("Portable text input must be a string");
  return source.replace(/\r\n?/g, "\n");
}

export async function readPortableText(path) {
  return normalizePortableText(await readFile(path, "utf8"));
}
