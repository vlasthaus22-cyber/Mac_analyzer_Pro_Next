import { IncrementalSha256 } from "./incremental-sha256.js";

const SIGNATURE_TEXT_BATCH_CHARACTERS = 64 * 1024;
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
    this.pendingText = "";
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
    this.pendingText += `${this.count ? "," : ""}${JSON.stringify(tuple)}`;
    this.count += 1;
    if (this.pendingText.length >= SIGNATURE_TEXT_BATCH_CHARACTERS) this.#flushPendingText();
    return this;
  }

  digest() {
    if (this.finished) throw new Error("Подпись истории снимков уже завершена");
    this.#flushPendingText();
    this.hash.update(this.textEncoder.encode("]]"));
    this.finished = true;
    return `snapshot-history-v3:${this.hash.digestHex()}`;
  }

  #flushPendingText() {
    if (!this.pendingText) return;
    this.hash.update(this.textEncoder.encode(this.pendingText));
    this.pendingText = "";
  }
}
