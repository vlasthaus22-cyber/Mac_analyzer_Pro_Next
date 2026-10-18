export function buildSourceKey({ strategy, files = {}, mappings = {}, sourceDigests = {} } = {}) {
  const sources = Object.entries(files).filter(([, file]) => file).map(([role, file]) => ({
    role,
    name: String(file.name || ""),
    size: Number(file.size || 0),
    lastModified: Number(file.lastModified || 0),
    sha256: String(sourceDigests[role] || ""),
  }));
  return JSON.stringify({ strategy: String(strategy || ""), sources, mappings });
}
