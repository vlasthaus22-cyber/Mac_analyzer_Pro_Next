import { createHash } from "node:crypto";

const UTF8_FLAG = 0x0800;
const ZIP_STORED = 0;
const ZIP_EOCD = 0x06054b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedU32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${label} exceeds classic ZIP limits`);
  return value;
}

export function createZip(entries) {
  if (entries.length > 0xffff) throw new RangeError("Release ZIP contains too many files");
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const normalizedName = String(entry.name).replaceAll("\\", "/");
    if (normalizedName.startsWith("/") || normalizedName.split("/").includes("..")) throw new TypeError(`Unsafe release ZIP path: ${normalizedName}`);
    const name = Buffer.from(normalizedName, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    if (!name.length || name.length > 0xffff || name.includes(0)) throw new TypeError("Release ZIP contains an invalid file name");
    const size = checkedU32(data.length, `File ${entry.name}`);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(ZIP_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(ZIP_STORED, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2821, 12); // deterministic DOS date: 2000-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(ZIP_CENTRAL, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(ZIP_STORED, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(checkedU32(localOffset, "ZIP local-header offset"), 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + data.length;
    checkedU32(localOffset, "ZIP local data");
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_EOCD, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(checkedU32(centralDirectory.length, "ZIP central directory"), 12);
  end.writeUInt32LE(checkedU32(localOffset, "ZIP central directory offset"), 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readZipEntries(zip) {
  const bytes = Buffer.isBuffer(zip) ? zip : Buffer.from(zip);
  const floor = Math.max(0, bytes.length - 0xffff - 22);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= floor; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_EOCD) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error("Release artifact has no ZIP end record");
  const count = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize > endOffset) throw new Error("Release artifact has an invalid ZIP directory range");
  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > endOffset || bytes.readUInt32LE(offset) !== ZIP_CENTRAL) throw new Error("Release artifact has a corrupt ZIP directory entry");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (!(flags & UTF8_FLAG) || method !== ZIP_STORED || compressedSize !== size || !name || name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`Release artifact has an unsafe or unsupported ZIP entry: ${name}`);
    }
    if (entries.has(name)) throw new Error(`Release artifact contains duplicate path: ${name}`);
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== ZIP_LOCAL) throw new Error(`Release artifact has an invalid local header: ${name}`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + size;
    if (dataEnd > centralOffset) throw new Error(`Release artifact entry is truncated: ${name}`);
    const data = bytes.subarray(dataOffset, dataEnd);
    if (crc32(data) !== crc) throw new Error(`Release artifact CRC mismatch: ${name}`);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) throw new Error("Release artifact ZIP directory size does not match its entries");
  return entries;
}
