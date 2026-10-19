import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTABLE_MODULES, PORTABLE_WORKER_MODULES } from "./build-config.js";
import { bundleModules } from "./module-bundler.js";
import { getOutputDirectory } from "./output-directory.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sqliteDist = join(root, "node_modules/@subframe7536/sqlite-wasm/dist");
const sqlitePackage = "vendor/sqlite";
const jsPdfDist = join(root, "node_modules/jspdf/dist");

const [htmlSource, css, ieeeRegistryJson, chartSource, chartLicense, xlsxSource, xlsxLicense, jsPdfSource, jsPdfLicense, pdfFont, pdfFontLicense, sqliteLicense, sqliteWasm, sqliteSources, sources, workerSources] = await Promise.all([
  readFile(join(root, "index.html"), "utf8"),
  readFile(join(root, "styles.css"), "utf8"),
  readFile(join(root, "assets/ieee-vendor-registry.json"), "utf8"),
  readFile(join(root, "vendor/chart.umd.min.js"), "utf8"),
  readFile(join(root, "licenses/Chart.js.LICENSE.md"), "utf8"),
  readFile(join(root, "vendor/xlsx.full.min.js"), "utf8"),
  readFile(join(root, "licenses/SheetJS.LICENSE.md"), "utf8"),
  readFile(join(jsPdfDist, "jspdf.umd.min.js"), "utf8"),
  readFile(join(root, "licenses/jsPDF.LICENSE.txt"), "utf8"),
  readFile(join(root, "assets/NotoSans-Regular.ttf")),
  readFile(join(root, "licenses/NotoSans-OFL.txt"), "utf8"),
  readFile(join(root, "licenses/SQLite-WASM.LICENSE.md"), "utf8"),
  readFile(join(sqliteDist, "wa-sqlite-async.wasm")),
  Promise.all([
    ["index.js", readFile(join(sqliteDist, "index.js"), "utf8")],
    ["idb.js", readFile(join(sqliteDist, "idb.js"), "utf8")],
    ["constant.js", readFile(join(sqliteDist, "constant.js"), "utf8")],
    ["FacadeVFS-K9VOkEDE.js", readFile(join(sqliteDist, "FacadeVFS-K9VOkEDE.js"), "utf8")],
    ["WebLocksMixin-CYVJdS-i.js", readFile(join(sqliteDist, "WebLocksMixin-CYVJdS-i.js"), "utf8")],
    ["wa-sqlite-bT14NS4h.js", readFile(join(sqliteDist, "wa-sqlite-bT14NS4h.js"), "utf8")],
    ["wa-sqlite-async-BT-3e9EP.js", readFile(join(sqliteDist, "wa-sqlite-async-BT-3e9EP.js"), "utf8")],
  ].map(async ([name, source]) => [`${sqlitePackage}/${name}`, await source])),
  Promise.all(PORTABLE_MODULES.map((name) => readFile(join(root, name), "utf8"))),
  Promise.all(PORTABLE_WORKER_MODULES.map((name) => readFile(join(root, name), "utf8"))),
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

