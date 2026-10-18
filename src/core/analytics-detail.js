
import { firstMac, normalizeIp } from "./normalize.js";

  const unknownVendors = new Set(["", "unknown", "не определено", "неизвестный вендор", "unknown vendor"]);
  const unknownValues = new Set(["", "unknown", "не указано", "не определено", "без помещения"]);
  const unknownModels = new Set(["", "unknown", "не указана", "не указано", "не определено"]);
  const fieldLabels = {
    vendor: "Производитель",
    model: "Модель",
    room: "Помещение",
    smartroomId: "Smartroom ID",
    switchIp: "IP коммутатора",
    switchPort: "Порт",
    address: "Адрес",
  };

  function text(value, fallback = "") {
    const result = value === null || value === undefined ? "" : String(value).trim();
    return result || fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeXml(value) {
    return escapeHtml(value);
  }

  function normalizeMac(value) {
    return String(value || "").toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 12);
  }

  function deviceValue(device, field) {
    if (field === "switchIp") return text(device?.switchIp || device?.switch_ip, "Без коммутатора");
    if (field === "switchPort") return text(device?.switchPort || device?.switch_port, "Без порта");
    if (field === "smartroomId") return text(device?.smartroomId || device?.smartroom_id, "Без Smartroom ID");
    return text(field === "vendor" ? (device?.vendor || device?.manufacturer) : device?.[field], {
      vendor: "Unknown",
      model: "Не определено",
      room: "Без помещения",
      address: "Без адреса",
    }[field] || "Не указано");
  }

  function tally(map, value) {
    const key = text(value, "Unknown");
    map.set(key, (map.get(key) || 0) + 1);
  }

  function ranked(map, limit = 50) {
    return Array.from(map.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ru"))
      .slice(0, Math.max(1, Number(limit) || 50))
      .map(([label, value]) => ({ label, value }));
  }

  function roomDescriptor(device = {}) {
    const smartroomId = text(device.smartroomId || device.smartroom_id);
    const room = text(device.room || device.room_name);
    const address = text(device.address || device.physicalAddress);
    const parsed = typeof globalThis.window !== "undefined" && globalThis.window.MacAnalyzerRoomLocation?.parse
      ? globalThis.window.MacAnalyzerRoomLocation.parse(device)
      : { tb: text(device.tb), city: text(device.city), site: text(device.site), floor: text(device.floor), room };
    const resolvedRoom = text(parsed.room || room);
    const hierarchy = [parsed.tb, parsed.city, parsed.site, parsed.floor]
      .map((value) => text(value).replace(/\s+/g, " ").toLocaleLowerCase("ru-RU"));
    const normalizedRoom = resolvedRoom.replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
    const normalizedAddress = address.replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
    // A room name is mandatory for a fallback identity. Address alone often
    // names a whole site and must never merge all rooms of that site.
    const locationContext = hierarchy.some(Boolean) ? hierarchy : [normalizedAddress];
    const locationKey = normalizedRoom
      ? `location:${[...locationContext, normalizedRoom].join("\u0000")}`
      : "";
    const smartroomKey = smartroomId ? `smartroom:${smartroomId.toLocaleLowerCase("ru-RU")}` : "";
    return {
      key: smartroomKey || locationKey,
      smartroomKey,
      locationKey,
      smartroomId,
      room: resolvedRoom,
      address,
      tb: text(parsed.tb),
      city: text(parsed.city),
      site: text(parsed.site),
      floor: text(parsed.floor),
    };
  }

  function compactRoomSwitchDevice(device = {}, switchIp = "") {
    return {
      mac: normalizeMac(firstMac(device.mac, device.macFormatted, device.mac_formatted)),
      vendor: text(device.vendor),
      model: text(device.model),
      deviceType: text(device.deviceType || device.device_type || device.modelType || device.model_type || device.type),
      ip: text(device.ip),
      switchIp,
      switchPort: text(device.switchPort || device.switch_port),
      authenticationTime: text(device.authenticationTime || device.authentication_time),
      hostname: text(device.hostname || device.host_name),
      serialNumber: text(device.serialNumber || device.serial_number || device.serial),
      deviceId: text(device.deviceId || device.device_id),
      deviceName: text(device.deviceName || device.device_name || device.name),
      source: text(device.source || (Array.isArray(device.sourceFiles) ? device.sourceFiles.join(" + ") : "")),
    };
  }

  function mergeRoomSwitchRow(target, source, roomDeviceSampleLimit) {
    if (!target) return source;
    target.totalDevices += source.totalDevices;
    target.missingSwitchDevices += source.missingSwitchDevices;
    const missingCapacity = Math.max(0, roomDeviceSampleLimit - target.missingDevices.length);
    for (let index = 0; index < Math.min(missingCapacity, source.missingDevices.length); index += 1)
      target.missingDevices.push(source.missingDevices[index]);
    source.missingDevices.length = 0;
    for (const field of ["smartroomId", "room", "address", "tb", "city", "site", "floor", "locationKey", "smartroomKey"])
      if (!target[field] && source[field]) target[field] = source[field];
    for (const [switchIp, sourceSwitch] of source.switches.entries()) {
      const targetSwitch = target.switches.get(switchIp) || { count: 0, devices: [] };
      targetSwitch.count += sourceSwitch.count;
      const sampleCapacity = Math.max(0, roomDeviceSampleLimit - targetSwitch.devices.length);
      for (let index = 0; index < Math.min(sampleCapacity, sourceSwitch.devices.length); index += 1)
        targetSwitch.devices.push(sourceSwitch.devices[index]);
      sourceSwitch.devices.length = 0;
      target.switches.set(switchIp, targetSwitch);
    }
    return target;
  }

  function reconcileRoomSwitchRows(roomSwitchRows, locationSmartroomKeys, roomDeviceSampleLimit) {
    const reconciled = new Map();
    for (const row of roomSwitchRows.values()) {
      let targetKey = row.key;
      if (!row.smartroomId && row.locationKey) {
        const smartroomKeys = locationSmartroomKeys.get(row.locationKey) || new Set();
        // Missing IDs are attached only when the physical room location maps
        // to exactly one observed Smartroom ID. Ambiguous rows remain isolated.
        if (smartroomKeys.size === 1) targetKey = smartroomKeys.values().next().value;
        else if (smartroomKeys.size > 1) row.ambiguousSmartroomIds = Array.from(smartroomKeys);
      }
      const existing = reconciled.get(targetKey);
      const merged = mergeRoomSwitchRow(existing, row, roomDeviceSampleLimit);
      merged.key = targetKey;
      reconciled.set(targetKey, merged);
    }
    return reconciled;
  }

  function finishRoomSwitchAnomalies(roomSwitchRows) {
    const rooms = [];
    let analyzedRooms = 0;
    for (const row of roomSwitchRows.values()) {
      const switches = Array.from(row.switches.entries())
        .map(([switchIp, value]) => ({ switchIp, count: value.count, devices: value.devices }))
        .sort((left, right) => right.count - left.count || left.switchIp.localeCompare(right.switchIp, "ru"));
      const knownSwitchDevices = switches.reduce((total, item) => total + item.count, 0);
      // Several Smartroom IDs at the same fallback location make anonymous
      // devices impossible to assign safely. Do not manufacture an anomaly.
      if ((row.ambiguousSmartroomIds || []).length) continue;
      if (knownSwitchDevices >= 3) analyzedRooms += 1;
      const dominant = switches[0];
      const runnerUp = switches[1];
      // A deviation requires a unique strict majority. A 1:1 split is a
      // conflict without enough evidence to call either switch the expected one.
      if (!dominant || !runnerUp || knownSwitchDevices < 3 || dominant.count < 2
          || dominant.count <= runnerUp.count || dominant.count <= knownSwitchDevices / 2) continue;
      const deviations = switches.slice(1).flatMap((item) => item.devices);
      const devices = switches.flatMap((item) => item.devices.map((device) => ({
        ...device,
        isDeviation: item.switchIp !== dominant.switchIp,
      }))).concat(row.missingDevices.map((device) => ({ ...device, isDeviation: false, missingSwitchIp: true })));
      rooms.push({
        key: row.key,
        smartroomId: row.smartroomId,
        room: row.room,
        address: row.address,
        tb: row.tb,
        city: row.city,
        site: row.site,
        floor: row.floor,
        totalDevices: row.totalDevices,
        knownSwitchDevices,
        missingSwitchDevices: row.missingSwitchDevices,
        expectedSwitchIp: dominant.switchIp,
        expectedCount: dominant.count,
        deviationCount: knownSwitchDevices - dominant.count,
        switchIps: switches.map(({ switchIp, count }) => ({ switchIp, count })),
        devices,
        deviations,
        devicesTruncated: devices.length < row.totalDevices,
        identitySource: row.smartroomId ? "smartroom-id" : "location",
        ambiguousSmartroomIds: row.ambiguousSmartroomIds || [],
      });
    }
    rooms.sort((left, right) => right.deviationCount - left.deviationCount
      || (left.room || left.smartroomId).localeCompare(right.room || right.smartroomId, "ru"));
    return { totalRooms: roomSwitchRows.size, analyzedRooms, anomalyRoomCount: rooms.length, rooms };
  }

  function createRoomSwitchIpAnomalyCollector(options = {}) {
    const rows = new Map();
    const locationSmartroomKeys = new Map();
    const roomDeviceSampleLimit = Math.max(20, Math.min(2_000, Number(options.roomDeviceSampleLimit || 500)));
    const totalDeviceSampleLimit = Math.max(500, Math.min(100_000, Number(options.roomDeviceTotalSampleLimit || 50_000)));
    let sampledDevices = 0;
    let finishedResult = null;
    function acceptOne(device) {
      if (finishedResult) throw new Error("Сборщик анализа комнат уже завершён");
      if (!device || typeof device !== "object") return;
      const descriptor = roomDescriptor(device);
      if (!descriptor.key) return;
      if (descriptor.smartroomKey && descriptor.locationKey) {
        const keys = locationSmartroomKeys.get(descriptor.locationKey) || new Set();
        keys.add(descriptor.smartroomKey);
        locationSmartroomKeys.set(descriptor.locationKey, keys);
      }
      let roomSwitch = rows.get(descriptor.key);
      if (!roomSwitch) {
        roomSwitch = { ...descriptor, totalDevices: 0, missingSwitchDevices: 0, missingDevices: [], switches: new Map() };
        rows.set(descriptor.key, roomSwitch);
      }
      roomSwitch.totalDevices += 1;
      const switchIp = normalizeIp(device.switchIp || device.switch_ip);
      if (!switchIp) {
        roomSwitch.missingSwitchDevices += 1;
        if (roomSwitch.missingDevices.length < roomDeviceSampleLimit && sampledDevices < totalDeviceSampleLimit) {
          roomSwitch.missingDevices.push(compactRoomSwitchDevice(device, ""));
          sampledDevices += 1;
        }
        return;
      }
      let switchRow = roomSwitch.switches.get(switchIp);
      if (!switchRow) {
        switchRow = { count: 0, devices: [] };
        roomSwitch.switches.set(switchIp, switchRow);
      }
      switchRow.count += 1;
      if (switchRow.devices.length < roomDeviceSampleLimit && sampledDevices < totalDeviceSampleLimit) {
        switchRow.devices.push(compactRoomSwitchDevice(device, switchIp));
        sampledDevices += 1;
      }
    }
    function accept(devices = []) {
      if (finishedResult) throw new Error("Сборщик анализа комнат уже завершён");
      for (const device of Array.isArray(devices) ? devices : []) acceptOne(device);
    }
    function finish() {
      if (finishedResult) return finishedResult;
      const reconciled = reconcileRoomSwitchRows(rows, locationSmartroomKeys, roomDeviceSampleLimit);
      finishedResult = finishRoomSwitchAnomalies(reconciled);
      rows.clear();
      locationSmartroomKeys.clear();
      reconciled.clear();
      return finishedResult;
    }
    return Object.freeze({
      accept,
      acceptOne,
      finish,
    });
  }

  function analyzeRoomSwitchIpAnomalies(devices = [], options = {}) {
    const collector = createRoomSwitchIpAnomalyCollector(options);
    collector.accept(devices);
    return collector.finish();
  }

  function collectClusterBuckets(devices = [], clusterFields = ["vendor", "room", "switchIp"]) {
    const groups = new Map();
    const fields = Array.isArray(clusterFields) && clusterFields.length ? clusterFields : ["vendor", "room", "switchIp"];
    for (const device of Array.isArray(devices) ? devices : []) {
      if (!device || typeof device !== "object") continue;
      const values = Object.fromEntries(fields.map((field) => [field, deviceValue(device, field)]));
      const value = fields.map((field) => values[field]).join("\u0000");
      let group = groups.get(value);
      if (!group) {
        group = { value, count: 0, data: { id: value, label: fields.map((field) => values[field]).join(" · "), fields: values } };
        groups.set(value, group);
      }
      group.count += 1;
    }
    return Array.from(groups.values());
  }

  function collectAnalyticsBuckets(devices = []) {
    const metrics = new Map();
    const fields = ["vendor", "model", "room", "smartroom", "switch", "known-vendor", "room-identity", "occupancy-room"];
    for (const field of fields) metrics.set(field, new Map());
    const add = (metric, value) => {
      const label = String(value ?? "");
      if (!label) return;
      metrics.get(metric).set(label, (metrics.get(metric).get(label) || 0) + 1);
    };
    for (const device of Array.isArray(devices) ? devices : []) {
      if (!device || typeof device !== "object") continue;
      const vendor = deviceValue(device, "vendor");
      const model = text(device.model);
      const room = text(device.room);
      const smartroomId = text(device.smartroomId || device.smartroom_id);
      const switchIp = normalizeIp(device.switchIp || device.switch_ip);
      add("vendor", vendor);
      if (!unknownVendors.has(vendor.toLowerCase())) add("known-vendor", vendor);
      if (!unknownModels.has(model.toLowerCase())) add("model", model);
      if (room) add("room", room);
      if (room && !unknownValues.has(room.toLowerCase())) add("occupancy-room", room);
      if (smartroomId) add("smartroom", smartroomId);
      if (switchIp && !unknownValues.has(switchIp.toLowerCase())) add("switch", switchIp);
      if (smartroomId || room) add("room-identity", smartroomId || room);
    }
    return Object.fromEntries([...metrics].map(([metric, rows]) => [metric, [...rows].map(([value, count]) => ({ value, count, data: { label: value } }))]));
  }

  function collectTopologyBuckets(devices = []) {
    const metrics = new Map([["topology-switch", new Map()]]);
    const add = (metric, value) => {
      if (!metrics.has(metric)) metrics.set(metric, new Map());
      const rows = metrics.get(metric);
      rows.set(value, (rows.get(value) || 0) + 1);
    };
    for (const device of Array.isArray(devices) ? devices : []) {
      if (!device || typeof device !== "object") continue;
      const switchIp = normalizeIp(device.switchIp || device.switch_ip);
      if (!switchIp || unknownValues.has(switchIp.toLowerCase())) continue;
      const switchPort = text(device.switchPort || device.switch_port, "Не указан");
      const room = text(device.room);
      add("topology-switch", switchIp);
      add(`topology-port:${switchIp}`, switchPort);
      add("topology-port-total", `${switchIp}\u0000${switchPort}`);
      if (room) add(`topology-room:${switchIp}`, room);
    }
    return Object.fromEntries([...metrics].map(([metric, rows]) => [metric, [...rows].map(([value, count]) => ({ value, count, data: { label: value } }))]));
  }

  function applyAnalyticsAggregateView(dataset, { tops = {}, counts = {} } = {}) {
    const devices = Number(dataset?.summary?.devices || 0);
    const roomCount = Number(dataset?.summary?.withRoom || 0);
    const makeRanked = (metric) => (tops[metric] || []).map((row) => ({ label: row.data?.label || row.value, value: Number(row.count || 0) }));
    const makeTop = (metric, denominator, limit = 20) => (tops[metric] || []).slice(0, limit).map((row) => ({
      label: row.data?.label || row.value,
      count: Number(row.count || 0),
      percent: denominator ? Math.round(Number(row.count || 0) / denominator * 1000) / 10 : 0,
    }));
    const vendors = makeTop("vendor", devices);
    const models = makeTop("model", devices);
    const rooms = makeTop("room", devices);
    const occupancyRooms = (tops["occupancy-room"] || []).map((row) => {
      const count = Number(row.count || 0);
      const percent = roomCount ? Math.round(count / roomCount * 1000) / 10 : 0;
      return { label: row.data?.label || row.value, count, percent, percentOfAssigned: percent, percentOfAll: devices ? Math.round(count / devices * 1000) / 10 : 0 };
    });
    dataset.summary.uniqueVendors = Number(counts["known-vendor"] || 0);
    dataset.summary.uniqueModels = Number(counts.model || 0);
    dataset.summary.uniqueRooms = Number(counts["room-identity"] || 0);
    dataset.summary.uniqueSmartrooms = Number(counts.smartroom || 0);
    dataset.summary.uniqueSwitches = Number(counts.switch || 0);
    dataset.charts = {
      ...dataset.charts,
      vendors: makeRanked("vendor"),
      models: makeRanked("model"),
      rooms: makeRanked("room"),
      smartrooms: makeRanked("smartroom"),
      switches: makeRanked("switch"),
    };
    dataset.roomOccupancy = {
      ...dataset.roomOccupancy,
      uniqueRooms: occupancyRooms.length ? Number(counts["occupancy-room"] || 0) : 0,
      mostOccupied: occupancyRooms[0] || null,
      rooms: occupancyRooms,
    };
    const formatLines = (title, rows) => [title, ...rows.map((item) => `  ${item.label}: ${item.count} (${item.percent.toFixed(1)}%)`)];
    dataset.reportText = [
      "=== АНАЛИТИКА ПО УСТРОЙСТВАМ ===", "", `Всего устройств: ${devices}`, "",
      ...formatLines("=== ПРОИЗВОДИТЕЛИ ===", vendors), "", ...formatLines("=== МОДЕЛИ ===", models), "",
      ...formatLines("=== ПОМЕЩЕНИЯ ===", rooms), "", "=== ЗАПОЛНЕННОСТЬ ===",
      `  Производитель: ${dataset.summary.uniqueVendors} уникальных`, `  Модель: ${dataset.summary.uniqueModels} уникальных`,
      `  Адрес: ${dataset.coverage.address.count} (${dataset.coverage.address.percent.toFixed(1)}%)`,
      `  Помещение: ${roomCount} (${dataset.coverage.room.percent.toFixed(1)}%)`,
      `  IP-адрес: ${dataset.coverage.ip.count} (${dataset.coverage.ip.percent.toFixed(1)}%)`,
      `  Коммутатор: ${dataset.coverage.switch.count} (${dataset.coverage.switch.percent.toFixed(1)}%)`,
      "", "=== ЗАПОЛНЕННОСТЬ ПОМЕЩЕНИЙ ===", `  Распределено по помещениям: ${roomCount} (${dataset.roomOccupancy.assignedPercent.toFixed(1)}%)`,
      `  Без помещения: ${dataset.roomOccupancy.unassignedDevices}`, `  Уникальных помещений: ${dataset.roomOccupancy.uniqueRooms}`,
      `  Среднее устройств на помещение: ${dataset.roomOccupancy.averageDevicesPerRoom.toFixed(1)}`,
    ].join("\n");
    return dataset;
  }

  function createCollector(options = {}) {
    const vendors = new Map();
    const models = new Map();
    const rooms = new Map();
    const roomIdentities = new Set();
    const smartrooms = new Map();
    const switchCounts = new Map();
    const clusterMap = new Map();
    const topologyMap = new Map();
    const topologyUnassigned = [];
    const includeTopologyDevices = options.includeTopologyDevices !== false;
    const includeTopologySummary = options.includeTopologySummary !== false;
    const includeClusters = options.includeClusters !== false;
    const includeRankings = options.includeRankings !== false;
    const clusterFields = Array.isArray(options.clusterFields) && options.clusterFields.length
      ? options.clusterFields
      : ["vendor", "room", "switchIp"];
    const vendorFilter = text(options.vendor);
    const roomFilter = text(options.room);
    const showUnknown = options.showUnknown !== false;
    let devices = 0;
    let knownVendors = 0;
    let withIp = 0;
    let withRoom = 0;
    let withAddress = 0;
    let withSwitch = 0;
    let withSwitchPort = 0;
    let withModel = 0;

    function accept(rows) {
      for (const device of Array.isArray(rows) ? rows : []) {
        if (!device || typeof device !== "object") continue;
        const vendor = deviceValue(device, "vendor");
        const model = text(device.model);
        const room = text(device.room);
        if (vendorFilter && vendor !== vendorFilter) continue;
        if (roomFilter && room !== roomFilter) continue;
        if (!showUnknown && unknownVendors.has(vendor.toLowerCase())) continue;
        const smartroomId = text(device.smartroomId || device.smartroom_id);
        const switchIp = normalizeIp(device.switchIp || device.switch_ip);
        const switchPortValue = text(device.switchPort || device.switch_port);
        const switchPort = switchPortValue || "Не указан";
        const mac = normalizeMac(firstMac(device.mac, device.macFormatted, device.mac_formatted));
        devices += 1;
        if (includeRankings) {
          tally(vendors, vendor);
          if (!unknownModels.has(model.toLowerCase())) tally(models, model);
          if (room) tally(rooms, room);
          if (smartroomId) tally(smartrooms, smartroomId);
          if (smartroomId || room) roomIdentities.add(smartroomId || room);
          if (switchIp && !unknownValues.has(switchIp.toLowerCase())) tally(switchCounts, switchIp);
        }
        if (!unknownVendors.has(vendor.toLowerCase())) knownVendors += 1;
        if (text(device.ip) && !unknownValues.has(text(device.ip).toLowerCase())) withIp += 1;
        if (room && !unknownValues.has(room.toLowerCase())) withRoom += 1;
        if (text(device.address) && !unknownValues.has(text(device.address).toLowerCase())) withAddress += 1;
        if (switchIp && !unknownValues.has(switchIp.toLowerCase())) withSwitch += 1;
        if (switchPortValue && !unknownValues.has(switchPortValue.toLowerCase())) withSwitchPort += 1;
        if (!unknownModels.has(model.toLowerCase())) withModel += 1;

        if (includeClusters) {
          const clusterValues = Object.fromEntries(clusterFields.map((field) => [field, deviceValue(device, field)]));
          const clusterKey = clusterFields.map((field) => clusterValues[field]).join("\u0000");
          let cluster = clusterMap.get(clusterKey);
          if (!cluster) {
            cluster = { id: clusterKey, label: clusterFields.map((field) => clusterValues[field]).join(" · "), fields: clusterValues, count: 0 };
            clusterMap.set(clusterKey, cluster);
          }
          cluster.count += 1;
        }

        const topologyDevice = {
          mac,
          vendor,
          model,
          ip: text(device.ip),
          room,
          address: text(device.address),
          port: switchPort,
        };
        if (!switchIp || unknownValues.has(switchIp.toLowerCase())) {
          if (includeTopologyDevices) topologyUnassigned.push(topologyDevice);
          continue;
        }
        if (!includeTopologySummary) continue;
        let switchNode = topologyMap.get(switchIp);
        if (!switchNode) {
          switchNode = { switchIp, deviceCount: 0, rooms: new Set(), ports: new Map(), sampleMacs: [] };
          topologyMap.set(switchIp, switchNode);
        }
        switchNode.deviceCount += 1;
        if (room) switchNode.rooms.add(room);
        if (mac && switchNode.sampleMacs.length < 12) switchNode.sampleMacs.push(mac);
        let port = switchNode.ports.get(switchPort);
        if (!port) {
          port = { port: switchPort, deviceCount: 0, sampleMacs: [], devices: includeTopologyDevices ? [] : undefined };
          switchNode.ports.set(switchPort, port);
        }
        if (includeTopologyDevices) port.devices.push(topologyDevice);
        if (port) {
          port.deviceCount += 1;
          if (mac && port.sampleMacs.length < 8) port.sampleMacs.push(mac);
        }
      }
      return devices;
    }

    function finish() {
      const clusters = Array.from(clusterMap.values())
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "ru"));
      const nodes = Array.from(topologyMap.values())
        .map((node) => ({
          switchIp: node.switchIp,
          deviceCount: node.deviceCount,
          rooms: Array.from(node.rooms).sort((left, right) => left.localeCompare(right, "ru")),
          ports: Array.from(node.ports.values()).sort((left, right) => left.port.localeCompare(right.port, "ru")),
          portCount: node.ports.size,
          sampleMacs: node.sampleMacs,
        }))
        .sort((left, right) => right.deviceCount - left.deviceCount || left.switchIp.localeCompare(right.switchIp));
      const invalid = Math.max(0, Number(options.invalidCount || 0));
      const top = (counter, denominator, limit = 20) => Array.from(counter, ([label, count]) => ({
        label, count, percent: denominator ? Math.round(count / denominator * 1000) / 10 : 0,
      })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "ru")).slice(0, limit);
      const filledRooms = new Map(Array.from(rooms).filter(([label]) => !unknownValues.has(label.toLowerCase())));
      const occupancyRooms = top(filledRooms, withRoom, 50).map((item) => ({
        ...item,
        percentOfAssigned: item.percent,
        percentOfAll: devices ? Math.round(item.count / devices * 1000) / 10 : 0,
      }));
      const coverage = {
        uniqueVendors: vendors.size,
        uniqueModels: models.size,
        address: { count: withAddress, percent: devices ? Math.round(withAddress / devices * 1000) / 10 : 0 },
        room: { count: withRoom, percent: devices ? Math.round(withRoom / devices * 1000) / 10 : 0 },
        ip: { count: withIp, percent: devices ? Math.round(withIp / devices * 1000) / 10 : 0 },
        switch: { count: withSwitch, percent: devices ? Math.round(withSwitch / devices * 1000) / 10 : 0 },
        port: { count: withSwitchPort, percent: devices ? Math.round(withSwitchPort / devices * 1000) / 10 : 0 },
      };
      const roomOccupancy = {
        assignedDevices: withRoom,
        unassignedDevices: Math.max(0, devices - withRoom),
        assignedPercent: coverage.room.percent,
        uniqueRooms: filledRooms.size,
        averageDevicesPerRoom: filledRooms.size ? Math.round(withRoom / filledRooms.size * 10) / 10 : 0,
        mostOccupied: occupancyRooms[0] || null,
        rooms: occupancyRooms,
      };
      const reportLines = [
        "=== АНАЛИТИКА ПО УСТРОЙСТВАМ ===", "", `Всего устройств: ${devices}`, "", "=== ПРОИЗВОДИТЕЛИ ===",
        ...top(vendors, devices).map((item) => `  ${item.label}: ${item.count} (${item.percent.toFixed(1)}%)`),
        "", "=== МОДЕЛИ ===", ...top(models, devices).map((item) => `  ${item.label}: ${item.count} (${item.percent.toFixed(1)}%)`),
        "", "=== ПОМЕЩЕНИЯ ===", ...top(rooms, devices).map((item) => `  ${item.label}: ${item.count} (${item.percent.toFixed(1)}%)`),
        "", "=== ЗАПОЛНЕННОСТЬ ===",
        `  Производитель: ${coverage.uniqueVendors} уникальных`, `  Модель: ${coverage.uniqueModels} уникальных`,
        `  Адрес: ${withAddress} (${coverage.address.percent.toFixed(1)}%)`, `  Помещение: ${withRoom} (${coverage.room.percent.toFixed(1)}%)`,
        `  IP-адрес: ${withIp} (${coverage.ip.percent.toFixed(1)}%)`, `  Коммутатор: ${withSwitch} (${coverage.switch.percent.toFixed(1)}%)`,
        "", "=== ЗАПОЛНЕННОСТЬ ПОМЕЩЕНИЙ ===", `  Распределено по помещениям: ${withRoom} (${roomOccupancy.assignedPercent.toFixed(1)}%)`,
        `  Без помещения: ${roomOccupancy.unassignedDevices}`, `  Уникальных помещений: ${roomOccupancy.uniqueRooms}`,
        `  Среднее устройств на помещение: ${roomOccupancy.averageDevicesPerRoom.toFixed(1)}`,
      ];
      return {
        summary: {
          devices,
          knownVendors,
          unknownVendors: Math.max(0, devices - knownVendors),
          uniqueVendors: Array.from(vendors.keys()).filter((value) => !unknownVendors.has(value.toLowerCase())).length,
          uniqueModels: models.size,
          uniqueRooms: roomIdentities.size,
          uniqueSmartrooms: smartrooms.size,
          uniqueSwitches: topologyMap.size,
          withIp,
          withRoom,
          withAddress,
          withSwitch,
          withSwitchPort,
          withModel,
          invalid,
        },
        charts: {
          vendors: ranked(vendors),
          models: ranked(models),
          rooms: ranked(rooms),
          smartrooms: ranked(smartrooms),
          switches: ranked(switchCounts),
        },
        clusters: {
          fields: clusterFields,
          items: clusters,
          overflowRows: 0,
          summary: {
            clusters: clusters.length,
            devices: clusters.reduce((total, item) => total + item.count, 0),
            largestCluster: clusters[0]?.count || 0,
          },
        },
        topology: {
          nodes,
          unassigned: topologyUnassigned,
          overflowRows: 0,
          summary: {
            switches: nodes.length,
            ports: nodes.reduce((total, node) => total + node.portCount, 0),
            linkedDevices: withSwitch,
            unassignedDevices: Math.max(0, devices - withSwitch),
          },
        },
        coverage,
        roomOccupancy,
        reportText: devices ? reportLines.join("\n") : "Нет данных",
      };
    }

    return Object.freeze({ accept, finish });
  }

  function build(devices, options = {}) {
    const collector = createCollector(options);
    collector.accept(devices);
    return collector.finish();
  }

  function barHtml(items, emptyText = "Недостаточно данных.") {
    const rows = Array.isArray(items) ? items : [];
    const max = Math.max(1, ...rows.map((item) => Number(item?.value ?? item?.[1] ?? 0)));
    if (!rows.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
    return rows.map((item) => {
      const label = item?.label ?? item?.[0] ?? "";
      const value = Number(item?.value ?? item?.[1] ?? 0);
      return `<div class="bar-item"><div class="bar-label"><span>${escapeHtml(label)}</span><strong>${value.toLocaleString("ru-RU")}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${Math.round(value / max * 100)}%"></div></div></div>`;
    }).join("");
  }

  function renderOverview(payload) {
    const summary = payload?.summary || {};
    return barHtml([
      { label: "Устройств", value: summary.devices || 0 },
      { label: "Производителей", value: summary.uniqueVendors || 0 },
      { label: "Моделей", value: summary.uniqueModels || 0 },
      { label: "Помещений", value: summary.uniqueRooms || 0 },
      { label: "Smartroom ID", value: summary.uniqueSmartrooms || 0 },
      { label: "Коммутаторов", value: summary.uniqueSwitches || 0 },
    ]);
  }

  function renderClusters(payload, limit = 30, page = 0) {
    const clusterData = payload?.clusters || {};
    const clusters = clusterData.pageItems || clusterData.items || [];
    const total = Math.max(0, Number(clusterData.pageTotal ?? clusters.length) || 0);
    if (!total) return '<p class="muted">Нет данных для кластеризации.</p>';
    const pageSize = Math.max(1, Math.floor(Number(limit) || 30));
    const pageCount = Math.ceil(total / pageSize);
    const currentPage = Math.max(0, Math.min(pageCount - 1, Math.floor(Number(clusterData.page ?? page) || 0)));
    const start = currentPage * pageSize;
    const visibleClusters = clusterData.pageItems ? clusters : clusters.slice(start, start + pageSize);
    const rows = visibleClusters.map((cluster) => (
      `<div class="summary-line local-cluster-row"><strong>${escapeHtml(cluster.label)}</strong><span>${Number(cluster.count || 0).toLocaleString("ru-RU")} устройств</span></div>`
    )).join("");
    const hasPrevious = currentPage > 0;
    const hasNext = clusterData.pageHasMore ?? currentPage < pageCount - 1;
    const pagination = pageCount > 1
      ? `<nav class="table-pagination" aria-label="Страницы кластеров"><span>Кластеры ${start + 1}–${Math.min(start + visibleClusters.length, total)} из ${total.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-cluster-page="${currentPage - 1}" ${hasPrevious ? "" : "disabled"}>Назад</button><span>Страница ${currentPage + 1} из ${pageCount.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-cluster-page="${currentPage + 1}" ${hasNext ? "" : "disabled"}>Дальше</button></nav>`
      : "";
    const overflow = Number(payload?.clusters?.overflowRows || 0);
    return `${rows}${pagination}${overflow ? `<p class="muted">Не удалось отобразить ${overflow.toLocaleString("ru-RU")} строк кластеризации.</p>` : ""}`;
  }

  function renderTopology(payload, switchPageSize = 20, switchPage = 0, portPageSize = 50, portPages = {}, devicePages = {}, unassignedPage = 0, devicePageData = {}, unassignedPageData = null) {
    const topology = payload?.topology || {};
    const nodes = topology.pageItems || topology.nodes || [];
    const unassigned = payload?.topology?.unassigned || [];
    if (!Number(topology.pageTotal ?? nodes.length) && !unassigned.length && !Number(topology.summary?.unassignedDevices || 0)) return '<p class="muted">Нет устройств для топологии.</p>';
    const switchLimit = Math.max(1, Math.floor(Number(switchPageSize) || 20));
    const totalSwitches = Math.max(0, Number(topology.pageTotal ?? nodes.length) || 0);
    const switchPageCount = Math.ceil(totalSwitches / switchLimit);
    const currentSwitchPage = Math.max(0, Math.min(Math.max(0, switchPageCount - 1), Math.floor(Number(topology.page ?? switchPage) || 0)));
    const switchStart = currentSwitchPage * switchLimit;
    const portsLimit = Math.max(1, Math.floor(Number(portPageSize) || 50));
    const pageNodes = topology.pageItems || nodes.slice(switchStart, switchStart + switchLimit);
    const renderedNodes = pageNodes.map((node) => {
      const totalPorts = Math.max(0, Number(node.portCount ?? node.ports.length) || 0);
      const portPageCount = Math.max(1, Math.ceil(totalPorts / portsLimit));
      const currentPortPage = Math.max(0, Math.min(portPageCount - 1, Math.floor(Number(node.portPageData?.page ?? portPages[node.switchIp]) || 0)));
      const portStart = currentPortPage * portsLimit;
      const pagePorts = node.portPageData?.page === currentPortPage ? node.ports : node.ports.slice(portStart, portStart + portsLimit);
      const ports = pagePorts.map((port) => {
        const portKey = JSON.stringify([node.switchIp, port.port]);
        const totalDevices = Number(port.deviceCount ?? port.devices?.length ?? 0);
        const devicePageCount = Math.max(1, Math.ceil(totalDevices / 50));
        const currentDevicePage = Math.max(0, Math.min(devicePageCount - 1, Math.floor(Number(devicePages[portKey]) || 0)));
        const storedPage = devicePageData[portKey]?.page === currentDevicePage ? devicePageData[portKey].devices : null;
        const allDevices = Array.isArray(port.devices) ? port.devices : null;
        const sourceDevices = storedPage || allDevices?.slice(currentDevicePage * 50, (currentDevicePage + 1) * 50) || null;
        const deviceStart = currentDevicePage * 50;
        const deviceRows = (sourceDevices || []).map((device) =>
          `<tr><td>${escapeHtml(device.mac || "")}</td><td>${escapeHtml(device.vendor || device.manufacturer || "")}</td><td>${escapeHtml(device.model || "")}</td><td>${escapeHtml(device.ip || "")}</td><td>${escapeHtml(device.room || "")}</td><td>${escapeHtml(device.address || "")}</td></tr>`
        ).join("");
        const loadDevices = sourceDevices ? "" : `<p class="muted"><button type="button" class="button secondary" data-topology-load-device-page="${currentDevicePage}" data-topology-port-key="${escapeHtml(portKey)}">Загрузить устройства (${totalDevices.toLocaleString("ru-RU")})</button></p>`;
        const deviceTable = sourceDevices ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>MAC</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Помещение</th><th>Адрес</th></tr></thead><tbody>${deviceRows}</tbody></table></div>` : "";
        const devicePagination = sourceDevices && devicePageCount > 1
          ? `<nav class="table-pagination" aria-label="Устройства порта ${escapeHtml(port.port)}"><span>Устройства ${deviceStart + 1}–${Math.min(deviceStart + sourceDevices.length, totalDevices)} из ${totalDevices.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-topology-device-page="${currentDevicePage - 1}" data-topology-port-key="${escapeHtml(portKey)}" ${currentDevicePage === 0 ? "disabled" : ""}>Назад</button><span>Страница ${currentDevicePage + 1} из ${devicePageCount.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-topology-device-page="${currentDevicePage + 1}" data-topology-port-key="${escapeHtml(portKey)}" ${currentDevicePage >= devicePageCount - 1 ? "disabled" : ""}>Дальше</button></nav>`
          : "";
        return `<details class="local-topology-port" data-topology-port-detail="${escapeHtml(portKey)}"><summary><strong>Порт ${escapeHtml(port.port)}</strong><span>${totalDevices.toLocaleString("ru-RU")} устройств</span></summary>${loadDevices}${deviceTable}${devicePagination}</details>`;
      }).join("");
      const portPagination = portPageCount > 1
        ? `<nav class="table-pagination" aria-label="Порты коммутатора ${escapeHtml(node.switchIp)}"><span>Порты ${portStart + 1}–${Math.min(portStart + pagePorts.length, totalPorts)} из ${totalPorts.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-topology-port-page="${currentPortPage - 1}" data-topology-switch="${escapeHtml(node.switchIp)}" ${currentPortPage === 0 ? "disabled" : ""}>Назад</button><span>Страница ${currentPortPage + 1} из ${portPageCount.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-topology-port-page="${currentPortPage + 1}" data-topology-switch="${escapeHtml(node.switchIp)}" ${node.portPageData ? (node.portPageData.hasMore ? "" : "disabled") : currentPortPage >= portPageCount - 1 ? "disabled" : ""}>Дальше</button></nav>`
        : "";
      const roomPageData = node.roomPageData;
      const roomTotal = Math.max(0, Number(node.roomCount ?? node.rooms.length) || 0);
      const roomPageCount = Math.max(1, Math.ceil(roomTotal / portsLimit));
      const currentRoomPage = Math.max(0, Number(roomPageData?.page) || 0);
      const roomPagination = roomPageCount > 1
        ? `<nav class="table-pagination" aria-label="Помещения коммутатора ${escapeHtml(node.switchIp)}"><span>Помещения ${currentRoomPage * portsLimit + 1}–${Math.min(currentRoomPage * portsLimit + node.rooms.length, roomTotal)} из ${roomTotal.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-topology-room-page="${currentRoomPage - 1}" data-topology-switch="${escapeHtml(node.switchIp)}" ${currentRoomPage === 0 ? "disabled" : ""}>Назад</button><span>Страница ${currentRoomPage + 1} из ${roomPageCount.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-topology-room-page="${currentRoomPage + 1}" data-topology-switch="${escapeHtml(node.switchIp)}" ${roomPageData?.hasMore ? "" : "disabled"}>Дальше</button></nav>`
        : "";
      const portLoadButton = totalPorts && !node.portPageData ? `<p class="muted"><button type="button" class="button secondary" data-topology-load-ports="${escapeHtml(node.switchIp)}">Загрузить порты (${totalPorts.toLocaleString("ru-RU")})</button></p>` : "";
      return `<details class="local-topology-node" data-topology-node="${escapeHtml(node.switchIp)}"><summary><strong>${escapeHtml(node.switchIp)}</strong><span>${Number(node.deviceCount || 0).toLocaleString("ru-RU")} устройств · ${totalPorts} портов</span></summary><div class="local-topology-details"><p class="muted">Помещения: ${escapeHtml(node.rooms.join(", ") || "не указаны")}</p>${roomPagination}${portLoadButton}${ports}${portPagination}</div></details>`;
    }).join("");
    const switchPagination = switchPageCount > 1
      ? `<nav class="table-pagination" aria-label="Страницы коммутаторов"><span>Коммутаторы ${switchStart + 1}–${Math.min(switchStart + pageNodes.length, totalSwitches)} из ${totalSwitches.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-topology-switch-page="${currentSwitchPage - 1}" ${currentSwitchPage === 0 ? "disabled" : ""}>Назад</button><span>Страница ${currentSwitchPage + 1} из ${switchPageCount.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-topology-switch-page="${currentSwitchPage + 1}" ${topology.pageHasMore ?? currentSwitchPage < switchPageCount - 1 ? "" : "disabled"}>Дальше</button></nav>`
      : "";
    const unassignedSize = 50;
    const unassignedTotal = Number(payload?.topology?.summary?.unassignedDevices ?? unassigned.length);
    const unassignedPageCount = Math.ceil(unassignedTotal / unassignedSize);
    const currentUnassignedPage = Math.max(0, Math.min(Math.max(0, unassignedPageCount - 1), Math.floor(Number(unassignedPage) || 0)));
    const unassignedStart = currentUnassignedPage * unassignedSize;
    const storedUnassigned = unassignedPageData?.page === currentUnassignedPage ? unassignedPageData.devices : null;
    const allUnassigned = unassigned.length ? unassigned.slice(unassignedStart, unassignedStart + unassignedSize) : null;
    const unassignedDevices = storedUnassigned || allUnassigned;
    const unassignedRows = (unassignedDevices || []).map((device) =>
      `<tr><td>${escapeHtml(device.mac || "")}</td><td>${escapeHtml(device.vendor || device.manufacturer || "")}</td><td>${escapeHtml(device.model || "")}</td><td>${escapeHtml(device.ip || "")}</td><td>${escapeHtml(device.room || "")}</td><td>${escapeHtml(device.address || "")}</td><td>${escapeHtml(device.port || device.switchPort || "")}</td></tr>`
    ).join("");
    const unassignedLoadButton = unassignedDevices ? "" : `<p class="muted"><button type="button" class="button secondary" data-topology-load-unassigned-page="${currentUnassignedPage}">Загрузить устройства</button></p>`;
    const unassignedTable = unassignedDevices ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>MAC</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Помещение</th><th>Адрес</th><th>Порт</th></tr></thead><tbody>${unassignedRows}</tbody></table></div>` : "";
    const unassignedPagination = unassignedDevices && unassignedPageCount > 1
      ? `<nav class="table-pagination" aria-label="Устройства без коммутатора"><span>Устройства ${unassignedStart + 1}–${Math.min(unassignedStart + unassignedDevices.length, unassignedTotal)} из ${unassignedTotal.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-topology-unassigned-page="${currentUnassignedPage - 1}" ${currentUnassignedPage === 0 ? "disabled" : ""}>Назад</button><span>Страница ${currentUnassignedPage + 1} из ${unassignedPageCount.toLocaleString("ru-RU")}</span><button type="button" class="button secondary" data-topology-unassigned-page="${currentUnassignedPage + 1}" ${currentUnassignedPage >= unassignedPageCount - 1 ? "disabled" : ""}>Дальше</button></nav>`
      : "";
    const unassignedContent = unassignedTotal
      ? `<details class="local-topology-unassigned"><summary>Устройства без коммутатора · ${unassignedTotal.toLocaleString("ru-RU")}</summary>${unassignedLoadButton}${unassignedTable}${unassignedPagination}</details>`
      : "";
    return `${renderedNodes}${switchPagination}${unassignedContent}`;
  }

  function snapshotRows(snapshots) {
    return (Array.isArray(snapshots) ? snapshots : [])
      .map((snapshot, index) => ({
        id: text(snapshot?.id, `snapshot-${index + 1}`),
        name: text(snapshot?.name || snapshot?.source, `Выгрузка ${index + 1}`),
        date: text(snapshot?.fileCreatedAt || snapshot?.createdAt || snapshot?.savedAt || snapshot?.date),
        count: Math.max(0, Number(snapshot?.deviceCount ?? snapshot?.devices?.length ?? 0)),
      }))
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  function renderStatistics(snapshots, currentDevices = 0, changes = 0) {
    const rows = snapshotRows(snapshots);
    const counts = rows.map((item) => item.count);
    const average = counts.length ? Math.round(counts.reduce((total, value) => total + value, 0) / counts.length) : 0;
    return barHtml([
      { label: "Финальных выгрузок", value: rows.length },
      { label: "Устройств в последней", value: rows.at(-1)?.count || Number(currentDevices || 0) },
      { label: "Максимум устройств", value: counts.length ? Math.max(...counts) : Number(currentDevices || 0) },
      { label: "Среднее по выгрузкам", value: average },
      { label: "Изменений", value: Number(changes || 0) },
    ]);
  }

  function renderTemporal(snapshots, limit = 24) {
    const rows = snapshotRows(snapshots).slice(-Math.max(1, Number(limit) || 24));
    return barHtml(rows.map((item) => ({ label: `${item.date.slice(0, 10) || "Без даты"} · ${item.name}`, value: item.count })), "Сохранённых выгрузок пока нет.");
  }

  function csvCell(value) {
    const source = String(value ?? "");
    return /[",\r\n;]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source;
  }

  function clustersCsv(payload) {
    const fields = payload?.clusters?.fields || [];
    const lines = [[...fields.map((field) => fieldLabels[field] || field), "Устройств"]];
    for (const cluster of payload?.clusters?.pageItems || payload?.clusters?.items || []) {
      lines.push([...fields.map((field) => cluster.fields?.[field] || ""), cluster.count || 0]);
    }
    return "\uFEFF" + lines.map((row) => row.map(csvCell).join(";")).join("\r\n");
  }

  async function writeClustersCsv(clusterFields, visitPages, writable, { maxBytes = 256 * 1024 } = {}) {
    if (!Array.isArray(clusterFields) || typeof visitPages !== "function" || !writable || typeof writable.write !== "function") {
      throw new TypeError("Для потокового CSV кластеров нужны поля, страницы и файловый поток");
    }
    const header = [...clusterFields.map((field) => fieldLabels[field] || field), "Устройств"].map(csvCell).join(";");
    await writable.write(`\uFEFF${header}`);
    let rows = [];
    let bytes = 0;
    const flush = async () => {
      if (!rows.length) return;
      await writable.write(`\r\n${rows.join("\r\n")}`);
      rows = [];
      bytes = 0;
    };
    await visitPages(async (clusters) => {
      for (const cluster of clusters) {
        const row = [...clusterFields.map((field) => cluster.data?.fields?.[field] || ""), cluster.count || 0].map(csvCell).join(";");
        const rowBytes = row.length * 2;
        if (rows.length && bytes + rowBytes + 4 > maxBytes) await flush();
        rows.push(row);
        bytes += rowBytes + (rows.length > 1 ? 4 : 0);
        if (bytes >= maxBytes) await flush();
      }
    });
    await flush();
  }

  function topologyDocument(payload) {
    const summary = payload?.topology?.summary || {};
    const sections = (payload?.topology?.nodes || []).map((node) => {
      const rows = node.ports.map((port) => (port.devices || []).map((device) =>
        `<tr><td>${escapeHtml(port.port)}</td><td>${escapeHtml(device.mac || "")}</td><td>${escapeHtml(device.vendor || "")}</td><td>${escapeHtml(device.model || "")}</td><td>${escapeHtml(device.ip || "")}</td><td>${escapeHtml(device.room || "")}</td><td>${escapeHtml(device.address || "")}</td></tr>`
      ).join("")).join("");
      return `<section><h2>${escapeHtml(node.switchIp)}</h2><p>Устройств: ${Number(node.deviceCount || 0)} · Помещения: ${escapeHtml(node.rooms.join(", ") || "-")}</p><table><thead><tr><th>Порт</th><th>MAC</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Помещение</th><th>Адрес</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }).join("");
    const unassigned = payload?.topology?.unassigned || [];
    const unassignedRows = unassigned.map((device) => `<tr><td>${escapeHtml(device.mac || "")}</td><td>${escapeHtml(device.vendor || "")}</td><td>${escapeHtml(device.model || "")}</td><td>${escapeHtml(device.ip || "")}</td><td>${escapeHtml(device.room || "")}</td><td>${escapeHtml(device.address || "")}</td><td>${escapeHtml(device.port || "")}</td></tr>`).join("");
    const unassignedSection = unassigned.length ? `<section><h2>Устройства без коммутатора</h2><table><thead><tr><th>MAC</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Помещение</th><th>Адрес</th><th>Порт</th></tr></thead><tbody>${unassignedRows}</tbody></table></section>` : "";
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>MAC Analyzer: топология</title><style>body{font:14px Arial;margin:32px;color:#172033}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left}th{background:#eef2f7}h1,h2{color:#0f766e}</style></head><body><h1>Топология MAC Analyzer</h1><p>Коммутаторов: ${Number(summary.switches || 0)} · портов: ${Number(summary.ports || 0)} · связанных устройств: ${Number(summary.linkedDevices || 0)} · без коммутатора: ${Number(summary.unassignedDevices || 0)}</p>${sections || "<p>Нет данных топологии.</p>"}${unassignedSection}</body></html>`;
  }

  async function writeTopologyHtml(snapshot, visitSnapshotChunks, summary, writable, { maxBytes = 256 * 1024 } = {}) {
    if (!snapshot?.id || typeof visitSnapshotChunks !== "function") throw new TypeError("Для экспорта топологии нужен Final и поток его чанков");
    if (!writable || typeof writable.write !== "function") throw new TypeError("Для потокового экспорта топологии нужен файловый поток");
    const totals = summary && typeof summary === "object" ? summary : {};
    if (Number(snapshot.deviceCount) === 0) {
      await writable.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>MAC Analyzer: топология</title></head><body><h1>Топология MAC Analyzer</h1><p>Коммутаторов: 0 · портов: 0 · связанных устройств: 0 · без коммутатора: 0</p><p>Нет данных топологии.</p></body></html>`);
      return;
    }
    await writable.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAC Analyzer: топология</title><style>body{font:14px Arial;margin:32px;color:#172033}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#eef2f7;position:sticky;top:0}tbody tr:nth-child(even){background:#f8fafc}@media print{body{margin:8mm}th{position:static}}</style></head><body><h1>Топология MAC Analyzer</h1><p>Коммутаторов: ${Number(totals.switches || 0)} · портов: ${Number(totals.ports || 0)} · связанных устройств: ${Number(totals.linkedDevices || 0)} · без коммутатора: ${Number(totals.unassignedDevices || 0)}</p><div style="overflow:auto"><table><thead><tr><th>Коммутатор</th><th>Порт</th><th>MAC</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Помещение</th><th>Адрес</th></tr></thead><tbody>`);
    let rows = [];
    let bytes = 0;
    const flush = async () => {
      if (!rows.length) return;
      await writable.write(rows.join(""));
      rows = [];
      bytes = 0;
    };
    await visitSnapshotChunks(snapshot.id, async (devices) => {
      for (const device of devices) {
        const switchIp = normalizeIp(device?.switchIp || device?.switch_ip) || "Без коммутатора";
        const port = text(device?.switchPort || device?.switch_port, "Не указан");
        const mac = normalizeMac(firstMac(device?.mac, device?.macFormatted, device?.mac_formatted));
        const values = [switchIp, port, mac, text(device?.vendor || device?.manufacturer), text(device?.model), text(device?.ip), text(device?.room || device?.room_name), text(device?.address || device?.physicalAddress)];
        const row = `<tr>${values.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`;
        const rowBytes = row.length * 2;
        if (rows.length && bytes + rowBytes > maxBytes) await flush();
        rows.push(row);
        bytes += rowBytes;
        if (bytes >= maxBytes) await flush();
      }
    });
    await flush();
    await writable.write("</tbody></table></div></body></html>");
  }

  function chartsSvg(payload) {
    const charts = [
      ["Производители", payload?.charts?.vendors || []],
      ["Модели", payload?.charts?.models || []],
      ["Помещения", payload?.charts?.rooms || []],
      ["Коммутаторы", payload?.charts?.switches || []],
    ];
    const width = 1_200;
    const sectionHeight = 280;
    const height = 90 + charts.length * sectionHeight;
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      '<rect width="100%" height="100%" fill="#ffffff"/>',
      '<text x="32" y="44" font-family="Arial" font-size="26" font-weight="700" fill="#172033">MAC Analyzer: аналитика</text>',
    ];
    let y = 90;
    for (const [title, items] of charts) {
      const rows = items.slice(0, 8);
      const max = Math.max(1, ...rows.map((item) => Number(item.value || 0)));
      parts.push(`<text x="32" y="${y}" font-family="Arial" font-size="19" font-weight="700" fill="#0f766e">${escapeXml(title)}</text>`);
      let rowY = y + 18;
      for (const item of rows) {
        const value = Number(item.value || 0);
        const barWidth = Math.round(720 * value / max);
        parts.push(`<text x="32" y="${rowY + 17}" font-family="Arial" font-size="13" fill="#334155">${escapeXml(item.label)}</text>`);
        parts.push(`<rect x="330" y="${rowY}" width="${barWidth}" height="20" rx="3" fill="#0f766e"/>`);
        parts.push(`<text x="${340 + barWidth}" y="${rowY + 16}" font-family="Arial" font-size="13" fill="#172033">${value}</text>`);
        rowY += 27;
      }
      y += sectionHeight;
    }
    parts.push("</svg>");
    return parts.join("");
  }

export { createCollector, createRoomSwitchIpAnomalyCollector, build, analyzeRoomSwitchIpAnomalies, collectAnalyticsBuckets, collectClusterBuckets, collectTopologyBuckets, applyAnalyticsAggregateView, barHtml, renderOverview, renderClusters, renderTopology, renderStatistics, renderTemporal, clustersCsv, writeClustersCsv, topologyDocument, writeTopologyHtml, chartsSvg, snapshotRows };

