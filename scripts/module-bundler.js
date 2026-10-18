import { posix } from "node:path";

function resolveModulePath(from, specifier) {
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  return target.endsWith(".js") ? target : `${target}.js`;
}

function transformModule(source, modulePath) {
  const imported = [];
  let transformed = source.replace(/^import\s+\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];?\s*/gm, (_match, bindings, specifier) => {
    const resolved = resolveModulePath(modulePath, specifier);
    const members = bindings.split(",").map((binding) => binding.trim()).filter(Boolean).map((binding) => {
      const [importedName, localName] = binding.split(/\s+as\s+/);
      return localName ? `${importedName}: ${localName}` : importedName;
    });
    imported.push(`const { ${members.join(", ")} } = __macAnalyzerRequire(${JSON.stringify(resolved)});`);
    return "";
  });
  const exports = [];
  transformed = transformed.replace(/^export\s+(?:(async)\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_match, asyncKeyword = "", kind, name) => {
    exports.push(name);
    return `${asyncKeyword ? `${asyncKeyword} ` : ""}${kind} ${name}`;
  });
  transformed = transformed.replace(/^export\s*\{([^}]+)\};?\s*$/gm, (_match, names) => {
    for (const item of names.split(",").map((name) => name.trim()).filter(Boolean)) {
      const [localName, exportedName] = item.split(/\s+as\s+/);
      exports.push(exportedName ? `${JSON.stringify(exportedName)}: ${localName}` : localName);
    }
    return "";
  });
  if (/^\s*import\s/m.test(transformed) || /^\s*export\s/m.test(transformed)) {
    throw new Error(`Unsupported module syntax in portable build: ${modulePath}`);
  }
  const exportObject = exports.map((item) => item.includes(":") ? item : `${JSON.stringify(item)}: ${item}`);
  return `function(module, exports) {\n${imported.join("\n")}\n${transformed}\nObject.assign(module.exports, { ${exportObject.join(", ")} });\n}`;
}

export function bundleModules(sources, { entryPath = "src/app.js", exposeResult = false } = {}) {
  const bundledPaths = new Set(sources.map(([modulePath]) => modulePath));
  for (const [modulePath, source] of sources) {
    for (const match of source.matchAll(/^import\s+\{[\s\S]*?\}\s+from\s+["']([^"']+)["'];?/gm)) {
      const resolved = resolveModulePath(modulePath, match[1]);
      if (!bundledPaths.has(resolved)) throw new Error(`Imported module is missing from portable build: ${modulePath} → ${resolved}`);
    }
  }
  if (!bundledPaths.has(entryPath)) throw new Error(`Portable entry module is missing: ${entryPath}`);
  const definitions = sources.map(([modulePath, source]) => `${JSON.stringify(modulePath)}: ${transformModule(source, modulePath)}`).join(",\n");
  const runEntry = exposeResult
    ? `globalThis.__MAC_ANALYZER_BUNDLE_RESULT__ = __macAnalyzerRequire(${JSON.stringify(entryPath)});`
    : `__macAnalyzerRequire(${JSON.stringify(entryPath)});`;
  return `(() => {\n"use strict";\nconst __macAnalyzerModules = {\n${definitions}\n};\nconst __macAnalyzerCache = new Map();\nfunction __macAnalyzerRequire(path) {\n  if (__macAnalyzerCache.has(path)) return __macAnalyzerCache.get(path).exports;\n  const factory = __macAnalyzerModules[path];\n  if (!factory) throw new Error("Portable module not found: " + path);\n  const module = { exports: {} };\n  __macAnalyzerCache.set(path, module);\n  factory(module, module.exports);\n  return module.exports;\n}\n${runEntry}\n})();`;
}
