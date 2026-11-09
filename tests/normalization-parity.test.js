import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDevice } from "../src/core/normalize.js";

const localPython = path.join(process.cwd(), ".codex-release-venv", "Scripts", "python.exe");
const pythonCandidates = process.env.PYTHON
  ? [[process.env.PYTHON, []]]
  : process.platform === "win32"
    ? [
        ...(existsSync(localPython) ? [[localPython, []]] : []),
        ["py", ["-3"]], ["python", []], ["python3", []],
      ]
    : [["python3", []], ["python", []]];

function resolvePython() {
  for (const [command, prefix] of pythonCandidates) {
    const result = spawnSync(command, [...prefix, "--version"], { encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) continue;
    const match = `${result.stdout || ""} ${result.stderr || ""}`.match(/Python\s+(\d+)\.(\d+)/);
    if (match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 10))) {
      return { command, prefix };
    }
  }
  return null;
}

const python = resolvePython();

test("browser-normalized Inventory matches the optional SQLite REST projection across fields and scalar types", {
  skip: !python && "Python 3.10+ is unavailable for the cross-runtime parity probe",
}, () => {
  const fields = [
    "id", "internalDeviceId", "internal_device_id", "mac", "macAddress", "mac_address", "macFormatted", "mac_formatted", "CallingStationID",
    "mac2", "secondaryMac", "secondary_mac", "additionalMac", "additional_mac", "deviceId", "device_id", "asset_id", "serial", "serialNumber", "serial_number",
    "vendor", "manufacturer", "model", "oui", "vendorConfidence", "vendor_confidence", "modelConfidence", "model_confidence", "vendorSource", "vendor_source",
    "modelSource", "model_source", "deviceType", "type", "ip", "deviceIp", "device_ip", "address", "physicalAddress", "room", "location", "locationPath",
    "smartroomId", "smartroom_id", "switchIp", "ipSwitch", "ip_switch", "nasIp", "switchPort", "port", "nasPortId", "hostname", "host", "host_name",
    "deviceName", "name", "businessUnit", "city", "site", "floor", "authenticationTime", "receiptTime", "firstSeen", "lastSeen", "lastMissing", "present",
    "snapshotId", "possibleIps", "possibleIpsTruncated", "source", "sources", "alternateMacs", "alternateMacsTruncated", "customFields", "customFieldSources",
    "fieldSources", "conflicts", "conflictsTruncated", "observationCount",
  ];
  const values = ["", null, true, false, 0, 3.5, "unknown", "  value  ", "not found", "n/a", "—", "ß", "İ", "１２３", {}, [], ["nested"]];
  const cases = [];
  for (const field of fields) {
    for (const value of values) {
      const id = `fuzz-${cases.length}`;
      const record = { internalDeviceId: id, [field]: value };
      if (field === "internalDeviceId" || field === "internal_device_id") record.internalDeviceId = id;
      cases.push(record);
    }
  }

  const browserRows = cases.map((record) => normalizeDevice(record));
  const pythonCode = [
    "import json,sys",
    "from backend.services.system.sqlite_store import _device_api_record",
    "rows=[]",
    "for item in json.load(sys.stdin):",
    " try: rows.append(_device_api_record(item)[1])",
    " except Exception as error: rows.append({'__error__':str(error)})",
    "print(json.dumps(rows,ensure_ascii=True))",
  ].join("\n");
  const result = spawnSync(python.command, [...python.prefix, "-X", "utf8", "-c", pythonCode], {
    input: JSON.stringify(browserRows), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || `Python exited with status ${result.status}`);
  const hostRows = JSON.parse(result.stdout);
  assert.equal(hostRows.length, browserRows.length);

  const projectionFields = [
    "mac", "oui", "alternateMacs", "alternateMacsTruncated", "ip", "switchIp", "switchPort", "smartroomId", "businessUnit", "city", "site", "floor",
    "room", "address", "physicalAddress", "manufacturer", "model", "hostname", "deviceName", "deviceType", "serial", "deviceId", "authenticationTime",
    "possibleIps", "possibleIpsTruncated", "sources", "fieldSources", "vendorConfidence", "modelConfidence", "vendorSource", "modelSource", "customFields",
    "customFieldSources", "conflicts", "conflictsTruncated",
  ];
  for (let index = 0; index < browserRows.length; index += 1) {
    assert.equal(hostRows[index].__error__, undefined, `SQLite rejected normalized row ${index}: ${hostRows[index].__error__}`);
    const projected = normalizeDevice(hostRows[index]);
    for (const field of projectionFields) {
      assert.deepEqual(projected[field], browserRows[index][field], `row ${index}, input field ${fields[Math.floor(index / values.length)]}, projection ${field}`);
    }
  }
});
