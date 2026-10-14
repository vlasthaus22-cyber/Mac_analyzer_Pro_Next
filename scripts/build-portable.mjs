import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modules = [
  "src/core/normalize.js",
  "src/core/identity.js",
  "src/core/enrichment.js",
  "src/core/comparison.js",
  "src/core/analytics.js",
  "src/data/importer.js",
  "src/data/database.js",
  "src/ui/render.js",
  "src/app.js",
];

function stripModules(source) {
  return source
    .replace(/^import\s+[\s\S]*?\s+from\s+["'][^"']+["'];\s*/gm, "")
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, "")
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/g, "");
}

const [htmlSource, css, oui, ...sources] = await Promise.all([
  readFile(join(root, "index.html"), "utf8"),
  readFile(join(root, "styles.css"), "utf8"),
  readFile(join(root, "assets/oui.csv"), "utf8"),
  ...modules.map((name) => readFile(join(root, name), "utf8")),
]);
const bundle = sources.map((source, index) => `\n/* ${modules[index]} */\n${stripModules(source)}`).join("\n");
const script = `globalThis.__MAC_ANALYZER_OUI_CSV__=${JSON.stringify(oui)};\n(()=>{\n"use strict";\n${bundle}\n})();`;
const html = htmlSource
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="src/app.js"></script>', () => `<script>\n${script.replaceAll("</script>", "<\\/script>")}\n</script>`);
const output = join(root, "dist", "MAC-Analyzer-Pro-Next.html");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html, "utf8");
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(html), modules: modules.length }));

