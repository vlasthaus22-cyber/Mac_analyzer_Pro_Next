import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getOutputDirectory } from "./output-directory.js";

function formatCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value).toLocaleString("en-US") : "?";
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}h ${minutes}m ${remainder}s`
    : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function formatReferenceImportHeartbeat({ elapsedMs = 0, lastProgress = null, now = Date.now() } = {}) {
  const elapsed = formatDuration(elapsedMs);
  if (!lastProgress) return `[heartbeat] import still running; elapsed ${elapsed}; waiting for the first checkpoint`;

  const subject = lastProgress.subject ? ` ${lastProgress.subject}` : "";
  const processed = formatCount(lastProgress.processed);
  const total = Number.isFinite(lastProgress.total) && lastProgress.total > 0
    ? `/${formatCount(lastProgress.total)}`
    : "";
  const idle = formatDuration(Math.max(0, now - lastProgress.at));
  return `[heartbeat] ${lastProgress.stage}${subject} ${processed}${total}; last checkpoint ${idle} ago; elapsed ${elapsed}`;
}

export function writeReferenceImportCheckpoint(checkpoint, outputDirectory = getOutputDirectory()) {
  const targetPath = path.join(outputDirectory, "reference-sqlite-import-progress.json");
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
  renameSync(temporaryPath, targetPath);
  return targetPath;
}
