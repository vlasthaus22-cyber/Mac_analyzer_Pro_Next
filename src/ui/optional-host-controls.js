const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function optionalHostDatabaseExportHref(locationLike = globalThis.location) {
  if (locationLike?.protocol !== "http:") return "";
  const hostname = String(locationLike.hostname || "").toLowerCase();
  const port = Number(locationLike.port);
  if (!LOOPBACK_HOSTS.has(hostname) || !Number.isInteger(port) || port < 1024 || port > 65535) return "";
  return "/api/database/export";
}
