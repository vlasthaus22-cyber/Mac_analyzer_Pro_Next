import { spawnSync } from "node:child_process";
import process from "node:process";

if (process.platform !== "win32") {
  console.log("Windows backend runtime check skipped on a non-Windows host.");
  process.exit(0);
}

const candidates = process.env.PYTHON
  ? [[process.env.PYTHON, []]]
  : [["py", ["-3"]], ["python3", []], ["python", []]];
let selected = null;
for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, "--version"], { encoding: "utf8", windowsHide: true });
  const version = `${probe.stdout || ""} ${probe.stderr || ""}`.match(/Python\s+(\d+)\.(\d+)/);
  if (!probe.error && probe.status === 0 && version && (Number(version[1]) > 3 || Number(version[1]) === 3 && Number(version[2]) >= 10)) {
    selected = { command, prefix };
    break;
  }
}
if (!selected) throw new Error("Python 3.10+ is required to verify the packaged Windows host.");
const result = spawnSync(selected.command, [...selected.prefix, "scripts/check-windows-backend.py"], { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
