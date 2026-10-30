import { text } from "./normalize.js";

export function createNotificationSummaryAccumulator() {
  const counts = { filledAddresses: 0, rooms: 0 };
  return {
    acceptChunk(devices) {
      if (!Array.isArray(devices)) throw new TypeError("Final chunk must be an array");
      for (const device of devices) {
        if (text(device?.address)) counts.filledAddresses += 1;
        if (text(device?.room)) counts.rooms += 1;
      }
    },
    finish() {
      return { ...counts };
    },
  };
}
