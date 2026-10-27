import { batchSourceFileRelativePath } from "./batch-directory-handles.js";

const ROLES = Object.freeze(["main", "smartroom", "ddio"]);

function normalizedPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").normalize("NFC").toLocaleLowerCase("en-US");
}

function fileKey(role, path, name, size) {
  return `${role}\u0000${path}\u0000${String(name || "").normalize("NFC").toLocaleLowerCase("en-US")}\u0000${Number(size) || 0}`;
}

function addIndex(index, key, value) {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
}

export function matchBatchFileMetadata(selectedFilesByRole = {}, metadataFiles = []) {
  const byPath = new Map();
  const byNameAndSize = new Map();
  for (const metadata of Array.isArray(metadataFiles) ? metadataFiles : []) {
    if (!metadata || !ROLES.includes(metadata.role) || !Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) < 0) continue;
    const relativePath = normalizedPath(metadata.relativePath);
    const name = String(metadata.name || "");
    if (!relativePath || !name) continue;
    const record = { ...metadata, size: Number(metadata.size) };
    addIndex(byPath, fileKey(record.role, relativePath, name, record.size), record);
    addIndex(byNameAndSize, fileKey(record.role, "", name, record.size), record);
  }

  const matches = [];
  let unmatchedCount = 0;
  let ambiguousCount = 0;
  for (const role of ROLES) {
    const files = Array.isArray(selectedFilesByRole[role]) ? selectedFilesByRole[role] : Array.from(selectedFilesByRole[role] || []);
    for (const file of files) {
      const fullPath = normalizedPath(batchSourceFileRelativePath(file));
      const pathCandidates = [fullPath];
      const parts = fullPath.split("/");
      if (parts.length > 1) pathCandidates.push(parts.slice(1).join("/"));
      const candidateRecords = new Set();
      for (const relativePath of pathCandidates) {
        for (const record of byPath.get(fileKey(role, relativePath, file?.name, file?.size)) || []) candidateRecords.add(record);
      }
      if (candidateRecords.size === 0) {
        for (const record of byNameAndSize.get(fileKey(role, "", file?.name, file?.size)) || []) candidateRecords.add(record);
      }
      if (candidateRecords.size === 1) matches.push({ role, file, metadata: candidateRecords.values().next().value });
      else if (candidateRecords.size > 1) ambiguousCount += 1;
      else unmatchedCount += 1;
    }
  }
  return { matches, matchedCount: matches.length, unmatchedCount, ambiguousCount };
}
