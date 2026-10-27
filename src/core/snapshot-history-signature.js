import { IncrementalSha256 } from "./incremental-sha256.js";

const encoder = () => new globalThis.TextEncoder();

export function snapshotCreatedAtSortKey(snapshot = {}) {
  return String(snapshot.createdAt ?? "");
}

function compareKey(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSnapshotHistoryMetadata(left, right) {
  return compareKey(snapshotCreatedAtSortKey(left), snapshotCreatedAtSortKey(right))
    || compareKey(left?.id, right?.id);
}

export class SnapshotHistorySignatureAccumulator {
  constructor() {
    this.hash = new IncrementalSha256();
    this.textEncoder = encoder();
    this.count = 0;
    this.finished = false;
    this.hash.update(this.textEncoder.encode('["snapshot-history-v3",['));
  }

  add(snapshot = {}) {
    if (this.finished) throw new Error("Подпись истории снимков уже завершена");
    const tuple = [
      snapshot.id,
      snapshotCreatedAtSortKey(snapshot),
      Number(snapshot.deviceCount || 0),
      Number(snapshot.chunkCount || 0),
      Number(snapshot.dataRevision || 0),
    ];
    this.hash.update(this.textEncoder.encode(`${this.count ? "," : ""}${JSON.stringify(tuple)}`));
    this.count += 1;
    return this;
  }

  digest() {
    if (this.finished) throw new Error("Подпись истории снимков уже завершена");
    this.hash.update(this.textEncoder.encode("]]"));
    this.finished = true;
    return `snapshot-history-v3:${this.hash.digestHex()}`;
  }
}
