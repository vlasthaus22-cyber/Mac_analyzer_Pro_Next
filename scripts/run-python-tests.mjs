import { spawnSync } from "node:child_process";

const candidates = process.env.PYTHON
  ? [[process.env.PYTHON, []]]
  : process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];

let selected = null;
for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, "--version"], { encoding: "utf8", windowsHide: true });
  if (probe.error || probe.status !== 0) continue;
  const version = `${probe.stdout || ""} ${probe.stderr || ""}`.match(/Python\s+(\d+)\.(\d+)/);
  if (!version) continue;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  if (major > 3 || (major === 3 && minor >= 10)) {
    selected = { command, prefix };
    break;
  }
}

if (!selected) {
  throw new Error("Python 3.10+ is required for the optional-host integration suite; install Python or set PYTHON to its executable path.");
}

console.log(`Python integration tests: ${selected.command} -m unittest discover -s tests -p test_*.py`);
const result = spawnSync(selected.command, [
  ...selected.prefix,
  "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v",
], { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
