import path from "node:path";

export function getOutputDirectory(projectRoot = process.cwd()) {
  const configured = process.env.MAC_ANALYZER_DIST_DIR?.trim();
  return configured ? path.resolve(projectRoot, configured) : path.join(projectRoot, "dist");
}
