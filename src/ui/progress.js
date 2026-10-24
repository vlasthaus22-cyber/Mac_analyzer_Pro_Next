const BYTE_PROGRESS_STAGES = new Set(["copying", "checkpointing", "hashing"]);
const RECORD_PROGRESS_STAGES = new Set(["validating", "restoring"]);

export function sqliteImportStageProgress({ stage, bytesRead, totalBytes, recordsProcessed, totalRecords } = {}) {
  const usesBytes = BYTE_PROGRESS_STAGES.has(stage);
  const usesRecords = RECORD_PROGRESS_STAGES.has(stage);
  if (!usesBytes && !usesRecords) return { value: null, label: "Выполняется" };

  const completed = Number(usesBytes ? bytesRead : recordsProcessed);
  const total = Number(usesBytes ? totalBytes : totalRecords);
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
    return { value: null, label: "Выполняется" };
  }

  const value = Math.round(Math.min(1, Math.max(0, completed / total)) * 100);
  return { value, label: `${value}% этапа` };
}
