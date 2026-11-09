import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDate, normalizeDevice } from "../src/core/normalize.js";
import { mergeDevice } from "../src/core/enrichment.js";

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
  const aliasGroups = [
    ["id", "internalDeviceId", "internal_device_id"],
    ["deviceId", "device_id", "asset_id"],
    ["serial", "serialNumber", "serial_number"],
    ["mac", "macAddress", "mac_address", "macFormatted", "mac_formatted", "CallingStationID"],
    ["ip", "deviceIp", "device_ip"],
    ["switchIp", "ipSwitch", "ip_switch", "nasIp"],
    ["manufacturer", "vendor"],
    ["switchPort", "port", "nasPortId"],
    ["smartroomId", "smartroom_id"],
    ["hostname", "host", "host_name"],
    ["deviceName", "name"],
    ["deviceType", "type"],
    ["vendorConfidence", "vendor_confidence"],
    ["vendorSource", "vendor_source"],
  ];
  const aliasValues = ["", null, false, 0, " unknown ", " Alpha ", "02-00-00-00-00-01"];
  for (const aliases of aliasGroups) {
    for (let left = 0; left < aliases.length; left += 1) {
      for (let right = left + 1; right < aliases.length; right += 1) {
        for (const first of aliasValues) {
          for (const second of aliasValues) {
            const id = `alias-${cases.length}`;
            const stableIdentity = aliases[0] === "id" ? { deviceId: `fallback-${id}` } : { internalDeviceId: id };
            cases.push({ ...stableIdentity, [aliases[left]]: first, [aliases[right]]: second });
          }
        }
      }
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
    "id", "mac", "oui", "alternateMacs", "alternateMacsTruncated", "ip", "switchIp", "switchPort", "smartroomId", "businessUnit", "city", "site", "floor",
    "room", "address", "physicalAddress", "manufacturer", "model", "hostname", "deviceName", "deviceType", "serial", "deviceId", "authenticationTime",
    "possibleIps", "possibleIpsTruncated", "sources", "fieldSources", "vendorConfidence", "modelConfidence", "vendorSource", "modelSource", "customFields",
    "customFieldSources", "conflicts", "conflictsTruncated",
  ];
  for (let index = 0; index < browserRows.length; index += 1) {
    assert.equal(hostRows[index].__error__, undefined, `SQLite rejected normalized row ${index}: ${hostRows[index].__error__}`);
    const projected = normalizeDevice(hostRows[index]);
    for (const field of projectionFields) {
      // SQLite may assign a stable storage ID from a strong deviceId/serial/MAC
      // when the pre-resolution browser projection has no internal ID yet.
      if (field === "id" && !browserRows[index].id) continue;
      assert.deepEqual(projected[field], browserRows[index][field], `row ${index}, input field ${fields[Math.floor(index / values.length)]}, projection ${field}`);
    }
  }
});

test("browser and SQLite REST date normalization agree across deterministic legacy timestamp variants", {
  skip: !python && "Python 3.10+ is unavailable for the cross-runtime parity probe",
}, () => {
  // Current/future years exercise shared machine timezone rules. Historical
  // Windows/ICU offsets are covered separately because the runtimes ship
  // different timezone databases for past local-time parsing.
  const years = [2024, 2025, 2026, 2038, 2100];
  const months = [1, 2, 6, 12];
  const days = [0, 1, 28, 29, 30, 31, 32];
  const separators = ["-", "/", "."];
  const timeSeparators = ["T", "t", " "];
  const times = ["00:00", "9:05", "10:20:30", "23:59:59", "24:00:00", "25:00:00", "10:60:00"];
  const zones = ["", "Z", "z", "+00:00", "+03:00", "+03", "-0500", "+030000"];
  const fractions = ["", ".1", ".123", ".123456", ",123"];
  const values = [];
  for (const year of years) {
    for (const month of months) {
      for (const day of days) {
        for (const separator of separators) {
          const date = `${year}${separator}${String(month).padStart(2, "0")}${separator}${String(day).padStart(2, "0")}`;
          values.push(date);
          for (const timeSeparator of timeSeparators) {
            for (const time of times) {
              for (const zone of zones) {
                for (const fraction of fractions) values.push(`${date}${timeSeparator}${time}${fraction}${zone}`);
              }
            }
          }
        }
      }
    }
  }
  const browserValues = values.map(normalizeDate);
  const pythonCode = [
    "import json,sys",
    "from backend.services.system.sqlite_store import _browser_normalize_date",
    "print(json.dumps([_browser_normalize_date(value) for value in json.load(sys.stdin)], ensure_ascii=True))",
  ].join("\n");
  const result = spawnSync(python.command, [...python.prefix, "-X", "utf8", "-c", pythonCode], {
    input: JSON.stringify(values), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || `Python exited with status ${result.status}`);
  const hostValues = JSON.parse(result.stdout);
  assert.equal(hostValues.length, browserValues.length);
  for (let index = 0; index < values.length; index += 1) {
    assert.equal(hostValues[index], browserValues[index], `timestamp ${JSON.stringify(values[index])}`);
  }
});

test("browser enrichment and SQLite resolved Inventory merges agree on shared fields", {
  skip: !python && "Python 3.10+ is unavailable for the cross-runtime merge probe",
}, () => {
  const pairs = [];
  const mergeFields = [
    "oui", "ip", "switchIp", "switchPort", "smartroomId", "businessUnit", "city", "site", "floor",
    "room", "address", "physicalAddress", "manufacturer", "model", "deviceType", "hostname", "serial",
    "deviceId", "deviceName", "authenticationTime",
  ];
  const sampleValue = (field, index, variant) => {
    if (field === "ip") return `192.0.2.${1 + ((index + variant) % 250)}`;
    if (field === "switchIp") return `198.51.100.${1 + ((index + variant) % 250)}`;
    if (field === "authenticationTime") return variant ? "2026-01-16T10:12:00.000Z" : "2026-01-15T10:12:00.000Z";
    return `${field}-${variant ? "incoming" : "existing"}-${index}`;
  };
  for (let index = 0; index < 60; index += 1) {
    const id = `merge-parity-${index}`;
    const mac = (offset) => `02:00:00:00:00:${(index * 3 + offset).toString(16).padStart(2, "0")}`;
    const primaryMac = mac(1);
    const firstAlternateMac = mac(2);
    const secondAlternateMac = mac(3);
    const baseInput = {
      internalDeviceId: id,
      mac: primaryMac,
      alternateMacs: index % 4 === 0 ? [firstAlternateMac] : [],
      ip: index % 3 === 1 ? "192.0.2.1" : "",
      switchIp: index % 5 === 0 ? "192.0.2.254" : "",
      room: index % 4 === 1 ? "Room A" : "",
      manufacturer: index % 6 === 0 ? "Existing vendor" : "",
      model: index % 7 === 0 ? "Existing model" : "",
      sources: ["Existing"],
    };
    const incomingInput = {
      internalDeviceId: id,
      mac: primaryMac,
      alternateMacs: [firstAlternateMac, secondAlternateMac],
      possibleIps: ["192.0.2.10", "192.0.2.11"],
      ip: index % 3 === 1 ? "198.51.100.1" : "192.0.2.1",
      switchIp: "198.51.100.254",
      room: "Room B",
      manufacturer: index % 6 === 0 ? "Incoming vendor" : "Acme",
      model: index % 7 === 0 ? "Incoming model" : "Model B",
      vendorConfidence: 0.8,
      vendorSource: "OUI fixture",
      customFields: { "custom_00000000-0000-4000-8000-000000000001": "Incoming custom" },
      customFieldSources: { "custom_00000000-0000-4000-8000-000000000001": "Main fixture" },
      sources: ["Main fixture"],
    };
    for (const [fieldIndex, field] of mergeFields.entries()) {
      if (field === "serial" || field === "deviceId") {
        const identityValue = `${field}-${index}`;
        baseInput[field] = identityValue;
        incomingInput[field] = identityValue;
      } else {
        const knownInBase = (index + fieldIndex) % 3 === 0;
        baseInput[field] = knownInBase ? sampleValue(field, index, 0) : "";
        incomingInput[field] = sampleValue(field, index, index % 2 === 0 || !knownInBase ? 1 : 0);
      }
    }
    const base = normalizeDevice(baseInput, "Existing");
    const incoming = normalizeDevice(incomingInput, "Main fixture");
    const browserMerged = JSON.parse(JSON.stringify(base));
    mergeDevice(browserMerged, incoming, "Main fixture");
    pairs.push({ id, base, incoming, browserMerged });
  }

  const pythonCode = [
    "import json,sys,tempfile",
    "from pathlib import Path",
    "from backend.services.system.sqlite_store import initialize_database,save_resolved_devices,list_resolved_devices",
    "pairs=json.load(sys.stdin)",
    "with tempfile.TemporaryDirectory() as directory:",
    " path=Path(directory)/'merge.db'",
    " initialize_database(path)",
    " save_resolved_devices(path,[item['base'] for item in pairs])",
    " save_resolved_devices(path,[item['incoming'] for item in pairs])",
    " print(json.dumps(list_resolved_devices(path,limit=len(pairs))['devices'],ensure_ascii=True))",
  ].join("\n");
  const result = spawnSync(python.command, [...python.prefix, "-X", "utf8", "-c", pythonCode], {
    input: JSON.stringify(pairs), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || `Python exited with status ${result.status}`);
  const hostRows = JSON.parse(result.stdout);
  assert.equal(hostRows.length, pairs.length);
  const projectionFields = [
    ...mergeFields, "possibleIps", "possibleIpsTruncated", "sources", "customFields", "customFieldSources",
    "fieldSources", "conflicts", "conflictsTruncated",
  ];
  const browserById = new Map(pairs.map(({ id, browserMerged }) => [id, browserMerged]));
  for (const row of hostRows) {
    const browser = browserById.get(row.internalDeviceId);
    assert.ok(browser, `unexpected SQLite row ${row.internalDeviceId}`);
    const projected = normalizeDevice(row);
    for (const field of projectionFields) {
      const hostValue = field === "conflicts"
        ? [...projected[field]].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
        : projected[field];
      const browserValue = field === "conflicts"
        ? [...browser[field]].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
        : browser[field];
      assert.deepEqual(hostValue, browserValue, `${row.internalDeviceId}, projection ${field}`);
    }
  }
});
