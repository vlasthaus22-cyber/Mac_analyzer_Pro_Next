import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SHA256_CHUNK_BYTES, estimateSha256WorkingSetBytes, IncrementalSha256, sha256File } from "../src/core/incremental-sha256.js";

test("SHA-256 heap preflight scales with concurrent chunks, not full input file sizes", () => {
  assert.equal(estimateSha256WorkingSetBytes([
    { size: 64 * 1024 * 1024 },
    { size: 2 * 1024 * 1024 },
    { size: 8 },
  ]), DEFAULT_SHA256_CHUNK_BYTES * 2 + 8);
  assert.equal(estimateSha256WorkingSetBytes([{ size: 5 * 1024 * 1024 }], 1024 * 1024), 1024 * 1024);
  assert.equal(estimateSha256WorkingSetBytes([{ size: -10 }]), 0);
});

test("incremental SHA-256 matches standard empty, short, and multi-block vectors", () => {
  const encoder = new globalThis.TextEncoder();
  assert.equal(new IncrementalSha256().digestHex(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(new IncrementalSha256().update(encoder.encode("abc")).digestHex(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const millionA = new Uint8Array(1_000_000).fill(0x61);
  const digest = new IncrementalSha256();
  for (let offset = 0; offset < millionA.length; offset += 17_003) digest.update(millionA.subarray(offset, offset + 17_003));
  assert.equal(digest.digestHex(), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  assert.throws(() => digest.digestHex(), /уже завершён/);
});

test("sha256File reads bounded slices, reports progress, and supports cancellation", async () => {
  const bytes = new globalThis.TextEncoder().encode("source file whose bytes distinguish source keys");
  const blob = new globalThis.Blob([bytes]);
  const file = { size: blob.size, slice: (...args) => blob.slice(...args) };
  const progress = [];
  const digest = await sha256File(file, { chunkBytes: 7, onProgress: ({ bytesRead }) => progress.push(bytesRead) });
  const expected = new IncrementalSha256().update(bytes).digestHex();
  assert.equal(digest, expected);
  assert.deepEqual(progress.at(-1), bytes.byteLength);
  assert.ok(progress.length > 1);
  const sameMetadataA = { size: 7, slice: (...args) => new globalThis.Blob(["input-A"]).slice(...args) };
  const sameMetadataB = { size: 7, slice: (...args) => new globalThis.Blob(["input-B"]).slice(...args) };
  assert.notEqual(await sha256File(sameMetadataA), await sha256File(sameMetadataB));
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(sha256File(file, { signal: controller.signal }), { name: "AbortError" });
});
