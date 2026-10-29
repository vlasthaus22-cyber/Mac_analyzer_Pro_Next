import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTABLE_MODULES, PORTABLE_WORKER_MODULES } from "./build-config.js";
import { bundleModules } from "./module-bundler.js";
import { getOutputDirectory } from "./output-directory.js";
import { readPortableText } from "./portable-text.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sqliteDist = join(root, "node_modules/@subframe7536/sqlite-wasm/dist");
const sqlitePackage = "vendor/sqlite";
const jsPdfDist = join(root, "node_modules/jspdf/dist");

const [htmlSource, css, ieeeRegistryJson, chartSource, chartLicense, xlsxSource, xlsxLicense, jsPdfSource, jsPdfLicense, pdfFont, pdfFontLicense, sqliteLicense, sqliteWasm, sqliteSources, sources, workerSources] = await Promise.all([
  readPortableText(join(root, "index.html")),
  readPortableText(join(root, "styles.css")),
  readPortableText(join(root, "assets/ieee-vendor-registry.json")),
  readPortableText(join(root, "vendor/chart.umd.min.js")),
  readPortableText(join(root, "licenses/Chart.js.LICENSE.md")),
  readPortableText(join(root, "vendor/xlsx.full.min.js")),
  readPortableText(join(root, "licenses/SheetJS.LICENSE.md")),
  readPortableText(join(jsPdfDist, "jspdf.umd.min.js")),
  readPortableText(join(root, "licenses/jsPDF.LICENSE.txt")),
  readFile(join(root, "assets/NotoSans-Regular.ttf")),
  readPortableText(join(root, "licenses/NotoSans-OFL.txt")),
  readPortableText(join(root, "licenses/SQLite-WASM.LICENSE.md")),
  readFile(join(sqliteDist, "wa-sqlite-async.wasm")),
  Promise.all([
    ["index.js", readPortableText(join(sqliteDist, "index.js"))],
    ["idb.js", readPortableText(join(sqliteDist, "idb.js"))],
    ["constant.js", readPortableText(join(sqliteDist, "constant.js"))],
    ["FacadeVFS-K9VOkEDE.js", readPortableText(join(sqliteDist, "FacadeVFS-K9VOkEDE.js"))],
    ["WebLocksMixin-CYVJdS-i.js", readPortableText(join(sqliteDist, "WebLocksMixin-CYVJdS-i.js"))],
    ["wa-sqlite-bT14NS4h.js", readPortableText(join(sqliteDist, "wa-sqlite-bT14NS4h.js"))],
    ["wa-sqlite-async-BT-3e9EP.js", readPortableText(join(sqliteDist, "wa-sqlite-async-BT-3e9EP.js"))],
  ].map(async ([name, source]) => [`${sqlitePackage}/${name}`, await source])),
  Promise.all(PORTABLE_MODULES.map((name) => readPortableText(join(root, name)))),
  Promise.all(PORTABLE_WORKER_MODULES.map((name) => readPortableText(join(root, name)))),
]);
const ieeeRegistry = JSON.parse(ieeeRegistryJson);
const bundle = bundleModules(sources.map((source, index) => [PORTABLE_MODULES[index], source]));
const sqliteEntry = `${sqlitePackage}/entry.js`;
const sqliteModules = sqliteSources.map(([path, source]) => [
  path,
  source
    .replace(/^import ["'][^"']+FacadeVFS-K9VOkEDE\.js["'];?\s*$/gm, "")
    .replaceAll("import.meta.url", 'globalThis.location?.href || "file:///"'),
]);
sqliteModules.push([sqliteEntry, `import { initSQLite, iterator, withExistDB } from "./index.js";\nimport { useIdbStorage } from "./idb.js";\nexport { initSQLite, iterator, useIdbStorage, withExistDB };`]);
const sqliteBundle = bundleModules(sqliteModules, { entryPath: sqliteEntry, exposeResult: true })
  .replace("__MAC_ANALYZER_BUNDLE_RESULT__", "__MAC_ANALYZER_SQLITE_RUNTIME__");
const workerBundle = bundleModules(workerSources.map((source, index) => [PORTABLE_WORKER_MODULES[index], source]), {
  entryPath: "src/core/analytics-history-worker.js",
  exposeResult: true,
});
const workerScript = `${workerBundle}\nglobalThis.__MAC_ANALYZER_BUNDLE_RESULT__.installAnalyticsHistoryWorker(globalThis);`;
const licenseComment = `/*\n${chartLicense.trim().replaceAll("*/", "* /")}\n*/`;
const xlsxLicenseComment = `/*\n${xlsxLicense.trim().replaceAll("*/", "* /")}\n*/`;
const jsPdfLicenseComment = `/*\n${jsPdfLicense.trim().replaceAll("*/", "* /")}\n*/`;
const pdfFontLicenseComment = `/* Noto Sans Regular font; ${pdfFontLicense.trim().replaceAll("*/", "* /")} */`;
const sqliteLicenseComment = `/*\n${sqliteLicense.trim().replaceAll("*/", "* /")}\n*/`;
const sqliteWasmUrl = `data:application/wasm;base64,${sqliteWasm.toString("base64")}`;
const script = `globalThis.__MAC_ANALYZER_IEEE_REGISTRY__=${JSON.stringify(ieeeRegistry)};\nglobalThis.__MAC_ANALYZER_HISTORY_WORKER_SOURCE__=${JSON.stringify(workerScript)};\nglobalThis.__MAC_ANALYZER_SQLITE_WASM_URL__=${JSON.stringify(sqliteWasmUrl)};\nglobalThis.__MAC_ANALYZER_PDF_FONT_BASE64__=${JSON.stringify(pdfFont.toString("base64"))};\n${licenseComment}\n${chartSource}\n${xlsxLicenseComment}\n${xlsxSource}\n${jsPdfLicenseComment}\n${pdfFontLicenseComment}\n${jsPdfSource}\n${sqliteLicenseComment}\n${sqliteBundle}\n${bundle}`;
const html = htmlSource
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script src="vendor/xlsx.full.min.js"></script>', "")
  .replace('<script src="node_modules/jspdf/dist/jspdf.umd.min.js"></script>', "")
  .replace('<script type="module" src="src/app.js"></script>', () => `<script>\n${script.replaceAll("</script>", "<\\/script>")}\n</script>`);
const output = join(getOutputDirectory(root), "MAC-Analyzer-Pro-Next.html");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html, "utf8");
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(html), modules: PORTABLE_MODULES.length, workerModules: PORTABLE_WORKER_MODULES.length }));

