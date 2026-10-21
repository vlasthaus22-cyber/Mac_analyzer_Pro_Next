import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

if (process.platform !== "win32") {
  console.log("Windows backend build skipped on a non-Windows host.");
  process.exit(0);
}

const candidates = process.env.PYTHON
  ? [[process.env.PYTHON, []]]
  : [["py", ["-3"]], ["python3", []], ["python", []]];
let selected = null;
const packagingVersionProbe = "import importlib.metadata as metadata; print(metadata.version('PyInstaller') + '|' + metadata.version('pyinstaller-hooks-contrib'))";
for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, "-c", packagingVersionProbe], { encoding: "utf8", windowsHide: true });
  if (!probe.error && probe.status === 0 && probe.stdout.trim() === "6.22.3|2026.8") {
    selected = { command, prefix };
    break;
  }
}
if (!selected) {
  throw new Error("Windows backend packaging requires PyInstaller 6.22.3 and pyinstaller-hooks-contrib 2026.8. Install them with: python -m pip install -r requirements-windows-packaging.txt");
}

const root = process.cwd();
const output = path.resolve("dist");
const work = path.join(output, ".windows-backend-build");
const html = path.join(output, "MAC-Analyzer-Pro-Next.html");
const executable = path.join(output, "MAC-Analyzer-Pro-Next-Host.exe");
const manifest = path.resolve("packaging/mac-analyzer-as-invoker.manifest");
if (!(await stat(html).catch(() => null))?.isFile()) throw new Error("Build the autonomous HTML before packaging the Windows host.");
await mkdir(work, { recursive: true });
const args = [
  ...selected.prefix,
  "-m", "PyInstaller", "--clean", "--noconfirm", "--onefile", "--console",
  "--name", "MAC-Analyzer-Pro-Next-Host",
  "--distpath", output,
  "--workpath", path.join(work, "work"),
  "--specpath", path.join(work, "spec"),
  "--paths", root,
  "--manifest", manifest,
  "--add-data", `${html};dist`,
  "scripts/packaged_host.py",
];
const build = spawnSync(selected.command, args, { stdio: "inherit", cwd: root, windowsHide: true, shell: false });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
const info = await stat(executable).catch(() => null);
if (!info?.isFile() || info.size < 1_000_000) throw new Error("PyInstaller did not produce the expected standalone Windows host executable.");
console.log(`Windows host built: ${executable} (${info.size.toLocaleString("en-US")} bytes)`);
