const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

export const DEFAULT_SHA256_CHUNK_BYTES = 256 * 1024;

export function estimateSha256WorkingSetBytes(files = [], chunkBytes = DEFAULT_SHA256_CHUNK_BYTES) {
  const chunkSize = Math.max(1, Math.min(1024 * 1024, Math.floor(Number(chunkBytes) || DEFAULT_SHA256_CHUNK_BYTES)));
  return files.reduce((total, file) => total + Math.min(Math.max(0, Number(file?.size) || 0), chunkSize), 0);
}

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}

export class IncrementalSha256 {
  constructor() {
    this.hash = INITIAL_HASH.slice();
    this.block = new Uint8Array(64);
    this.blockLength = 0;
    this.byteLength = 0;
    this.finished = false;
  }

  update(bytes) {
    if (this.finished) throw new Error("SHA-256 уже завершён");
    if (!(bytes instanceof Uint8Array)) throw new TypeError("SHA-256 принимает только Uint8Array");
    this.byteLength += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.length) {
      const copied = Math.min(64 - this.blockLength, bytes.length - offset);
      this.block.set(bytes.subarray(offset, offset + copied), this.blockLength);
      this.blockLength += copied;
      offset += copied;
      if (this.blockLength === 64) {
        this.#compress(this.block);
        this.blockLength = 0;
      }
    }
    return this;
  }

  #compress(block) {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const prior15 = words[index - 15];
      const prior2 = words[index - 2];
      const sigma0 = rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ (prior15 >>> 3);
      const sigma1 = rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ (prior2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.hash[0] = (this.hash[0] + a) >>> 0;
    this.hash[1] = (this.hash[1] + b) >>> 0;
    this.hash[2] = (this.hash[2] + c) >>> 0;
    this.hash[3] = (this.hash[3] + d) >>> 0;
    this.hash[4] = (this.hash[4] + e) >>> 0;
    this.hash[5] = (this.hash[5] + f) >>> 0;
    this.hash[6] = (this.hash[6] + g) >>> 0;
    this.hash[7] = (this.hash[7] + h) >>> 0;
  }

  digestHex() {
    if (this.finished) throw new Error("SHA-256 уже завершён");
    const bitLength = this.byteLength * 8;
    const highBits = Math.floor(bitLength / 0x1_0000_0000);
    const lowBits = bitLength >>> 0;
    this.block[this.blockLength++] = 0x80;
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.#compress(this.block);
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength, 56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, highBits, false);
    view.setUint32(60, lowBits, false);
    this.#compress(this.block);
    this.finished = true;
    return [...this.hash].map((word) => word.toString(16).padStart(8, "0")).join("");
  }
}

export async function sha256File(file, { chunkBytes = DEFAULT_SHA256_CHUNK_BYTES, signal, onProgress = () => {} } = {}) {
  if (!file || typeof file.slice !== "function" || !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 0) {
    throw new Error("Файл не поддерживает потоковое хеширование");
  }
  const chunkSize = Math.max(1, Math.min(1024 * 1024, Math.floor(Number(chunkBytes) || 256 * 1024)));
  const hash = new IncrementalSha256();
  let bytesRead = 0;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const part = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
    const bytes = new Uint8Array(part);
    hash.update(bytes);
    bytesRead += bytes.length;
    onProgress({ bytesRead, totalBytes: file.size });
  }
  return hash.digestHex();
}
