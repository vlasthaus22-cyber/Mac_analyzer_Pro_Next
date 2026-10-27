import test from "node:test";
import assert from "node:assert/strict";
import { build, chartsSvg, clustersCsv, collectAnalyticsBuckets, collectClusterBuckets, collectTopologyBuckets, applyAnalyticsAggregateView, createCollector, pyqtFieldCoverageChartItems, pyqtRoomDistributionChartItems, pyqtVendorShareChartItems, pyqtVendorTopChartItems, renderClusters, renderStatistics, renderTopology, topologyDocument, writeClustersCsv, writeTopologyHtml } from "../src/core/analytics-detail.js";

test("PyQt field coverage chart uses full Final counts for the seven reference fields", () => {
  const rows = pyqtFieldCoverageChartItems({ summary: {
    devices: 100, knownVendors: 75, withModel: 80, withAddress: 65, withIp: 90,
    withRoom: 60, withSwitch: 55, withSwitchPort: 45,
  } });
  assert.deepEqual(rows, [
    { label: "Производитель", value: 75, filled: 75, total: 100 },
    { label: "Модель", value: 80, filled: 80, total: 100 },
    { label: "Адрес", value: 65, filled: 65, total: 100 },
    { label: "IP", value: 90, filled: 90, total: 100 },
    { label: "Помещение", value: 60, filled: 60, total: 100 },
    { label: "IP коммутатора", value: 55, filled: 55, total: 100 },
    { label: "Порт", value: 45, filled: 45, total: 100 },
  ]);
  assert.deepEqual(pyqtFieldCoverageChartItems({ summary: { devices: 0 } }), []);
});

test("analytics SVG export includes the same seven-field coverage chart", () => {
  const svg = chartsSvg({ summary: {
    devices: 20, knownVendors: 15, withModel: 12, withAddress: 10, withIp: 18,
    withRoom: 16, withSwitch: 9, withSwitchPort: 7,
  }, charts: { vendors: [{ label: "Unknown", value: 5 }, { label: "Acme", value: 15 }] } });
  assert.match(svg, /Заполненность полей \(%\)/);
  assert.match(svg, /Производитель/);
  assert.match(svg, /IP коммутатора/);
  assert.match(svg, /75/);
  assert.match(svg, /35/);
  assert.match(svg, /Доля ведущих производителей/);
  assert.match(svg, /Acme/);
});

test("PyQt vendor-share chart filters only the source Unknown marker and keeps the leading eight", () => {
  const dataset = { charts: { vendors: [
    { label: "Unknown", value: 100 }, { label: "Acme", value: 90 }, { label: "Bravo", value: 80 },
    { label: "Charlie", value: 70 }, { label: "Delta", value: 60 }, { label: "Echo", value: 50 },
    { label: "Foxtrot", value: 40 }, { label: "Golf", value: 30 }, { label: "Hotel", value: 20 },
    { label: "India", value: 10 }, { label: "unknown", value: 5 }, { label: "Empty", value: 0 },
  ] } };
  assert.deepEqual(pyqtVendorShareChartItems(dataset), [
    { label: "Acme", value: 90 }, { label: "Bravo", value: 80 }, { label: "Charlie", value: 70 },
    { label: "Delta", value: 60 }, { label: "Echo", value: 50 }, { label: "Foxtrot", value: 40 },
    { label: "Golf", value: 30 }, { label: "Hotel", value: 20 },
  ]);
  assert.deepEqual(pyqtVendorShareChartItems({ charts: { vendors: [] } }), []);
});

test("PyQt AnalyticsChart top-ten vendor and room charts exclude source placeholders and retain exact counts", () => {
  const vendors = Array.from({ length: 12 }, (_, index) => ({ label: `Vendor ${index + 1}`, value: 120 - index * 10 }));
  const rooms = [
    { label: "Unknown", value: 50 }, { label: "Не указано", value: 40 },
    ...Array.from({ length: 12 }, (_, index) => ({ label: `Room ${index + 1}`, value: 30 - index })),
  ];
  const dataset = { charts: { vendors: [{ label: "Unknown", value: 500 }, ...vendors], rooms } };
  assert.deepEqual(pyqtVendorTopChartItems(dataset), vendors.slice(0, 10));
  assert.deepEqual(pyqtRoomDistributionChartItems(dataset), rooms.slice(2, 12));

  const svg = chartsSvg({ charts: dataset.charts });
  assert.match(svg, /Топ-10 производителей/);
  assert.match(svg, /Распределение по помещениям/);
  assert.match(svg, /Vendor 10/);
  assert.doesNotMatch(svg, /Vendor 11/);
  assert.match(svg, /Room 10/);
  assert.doesNotMatch(svg, /Room 11/);
});

test("Final statistics aggregate unsorted snapshot metadata in one pass without mapping or sorting copies", () => {
  const source = [
    { id: "later", createdAt: "2026-03-01T00:00:00Z", deviceCount: 10 },
    { id: "early", createdAt: "2026-01-01T00:00:00Z", deviceCount: 15 },
    { id: "middle", createdAt: "2026-02-01T00:00:00Z", deviceCount: 5 },
  ];
  const snapshots = new Proxy(source, {
    get(target, property, receiver) {
      if (property === "map" || property === "sort") throw new Error(`statistics must not call ${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  });
  const html = renderStatistics(snapshots, 99, 7);
  assert.match(html, /<span>Финальных выгрузок<\/span><strong>3<\/strong>/);
  assert.match(html, /<span>Устройств в последней<\/span><strong>10<\/strong>/);
  assert.match(html, /<span>Максимум устройств<\/span><strong>15<\/strong>/);
  assert.match(html, /<span>Среднее по выгрузкам<\/span><strong>10<\/strong>/);
  assert.match(html, /<span>Изменений<\/span><strong>7<\/strong>/);
});

test("Final statistics scan large metadata arrays without creating sorted row/count arrays", () => {
  const snapshots = new Proxy(Array.from({ length: 100_000 }, (_, index) => ({
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    deviceCount: index % 1_001,
  })), {
    get(target, property, receiver) {
      if (property === "map" || property === "sort") throw new Error(`statistics must not call ${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  });
  const html = renderStatistics(snapshots);
  assert.match(html, /<span>Финальных выгрузок<\/span><strong>100[\s\u00a0]000<\/strong>/);
  assert.match(html, /<span>Устройств в последней<\/span><strong>900<\/strong>/);
  assert.match(html, /<span>Максимум устройств<\/span><strong>1[\s\u00a0]000<\/strong>/);
});

test("full Final aggregation counts manufacturers, clusters and switch ports", () => {
  const payload = build([
    { mac: "00:11:22:33:44:01", manufacturer: "Acme", model: "Room Kit", room: "101", switchIp: "10.0.0.1", switchPort: "1" },
    { mac: "00:11:22:33:44:02", manufacturer: "Acme", model: "Room Kit", room: "101", switchIp: "10.0.0.1", switchPort: "2" },
    { mac: "00:11:22:33:44:03", manufacturer: "Other", model: "Display", room: "101", switchIp: "10.0.0.2", switchPort: "3" },
  ]);

  assert.equal(payload.summary.devices, 3);
  assert.equal(payload.summary.uniqueVendors, 2);
  assert.equal(payload.summary.withSwitchPort, 3);
  assert.equal(payload.coverage.port.count, 3);
  assert.equal(payload.clusters.summary.devices, 3);
  assert.equal(payload.topology.summary.switches, 2);
  assert.equal(payload.topology.nodes[0].ports.length, 2);
  assert.match(clustersCsv(payload), /Производитель/);
  assert.match(topologyDocument(payload), /10\.0\.0\.1/);
});

test("cluster analytics keeps every unique group and renders every page", () => {
  const count = 20_005;
  const payload = build(Array.from({ length: count }, (_, index) => ({ manufacturer: `Vendor ${index}` })));
  assert.equal(payload.summary.uniqueVendors, count);
  assert.equal(payload.clusters.items.length, count);
  assert.equal(payload.clusters.summary.clusters, count);
  assert.equal(payload.clusters.summary.devices, count);
  assert.equal(payload.clusters.overflowRows, 0);
  assert.equal((clustersCsv(payload).match(/\n/g) || []).length, count);

  const first = renderClusters(payload, 50, 0);
  const last = renderClusters(payload, 50, 400);
  assert.match(first, /Кластеры 1–50 из 20/);
  assert.match(first, /data-cluster-page="1"/);
  assert.match(last, /Кластеры 20001–20005 из 20/);
  assert.match(last, /disabled>Дальше/);
  const indexedPage = renderClusters({ clusters: { fields: ["vendor"], pageItems: payload.clusters.items.slice(50, 100), page: 1, pageTotal: count + 5, pageHasMore: true } }, 50, 1);
  assert.match(indexedPage, /Кластеры 51–100 из 20\s010/);
  assert.match(indexedPage, /data-cluster-page="0"/);
  assert.match(indexedPage, /data-cluster-page="2"/);
});

test("cluster buckets aggregate per chunk without making the streaming collector retain full cluster rows", () => {
  const rows = [
    { manufacturer: "Acme", room: "101", switchIp: "10.0.0.1" },
    { manufacturer: "Acme", room: "101", switchIp: "10.0.0.1" },
    { manufacturer: "Other", room: "202", switchIp: "10.0.0.2" },
  ];
  const buckets = collectClusterBuckets(rows);
  assert.deepEqual(buckets.map(({ count }) => count), [2, 1]);
  const collector = createCollector({ includeClusters: false, includeTopologyDevices: false });
  collector.accept(rows);
  const report = collector.finish();
  assert.equal(report.summary.devices, rows.length);
  assert.equal(report.clusters.items.length, 0);
  assert.equal(report.clusters.summary.clusters, 0);
});

test("analytics ranking buckets preserve exact unique totals and displayed top rows without retained maps", () => {
  const rows = [
    { manufacturer: "Acme", model: "Room Kit", room: "101", smartroomId: "sr-1", switchIp: "10.0.0.1" },
    { manufacturer: "Acme", model: "Room Kit", room: "101", smartroomId: "sr-1", switchIp: "10.0.0.1" },
    { manufacturer: "Other", model: "Display", room: "202", switchIp: "10.0.0.2" },
  ];
  const collector = createCollector({ includeClusters: false, includeRankings: false, includeTopologyDevices: false });
  collector.accept(rows);
  const dataset = collector.finish();
  const metrics = collectAnalyticsBuckets(rows);
  const tops = Object.fromEntries(Object.entries(metrics).map(([metric, values]) => [metric, values
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, "ru"))
    .slice(0, 50)]));
  const counts = Object.fromEntries(Object.entries(metrics).map(([metric, values]) => [metric, values.length]));
  applyAnalyticsAggregateView(dataset, { tops, counts });
  assert.equal(dataset.summary.uniqueVendors, 2);
  assert.equal(dataset.summary.uniqueModels, 2);
  assert.equal(dataset.summary.uniqueRooms, 2);
  assert.equal(dataset.summary.uniqueSmartrooms, 1);
  assert.equal(dataset.summary.uniqueSwitches, 2);
  assert.deepEqual(dataset.charts.vendors.slice(0, 2), [{ label: "Acme", value: 2 }, { label: "Other", value: 1 }]);
  assert.deepEqual(dataset.roomOccupancy.rooms.map(({ label, count }) => [label, count]), [["101", 2], ["202", 1]]);
  assert.match(dataset.reportText, /=== ПРОИЗВОДИТЕЛИ ===[\s\S]*Acme: 2 \(66\.7%\)/);
});

test("model analytics excludes unknown placeholders from unique counts, rankings, and completeness", () => {
  const devices = [
    { manufacturer: "Acme", model: "Unknown" },
    { manufacturer: "Acme", model: "Не определено" },
    { manufacturer: "Acme", model: "Room Kit" },
    { manufacturer: "Acme", model: "" },
  ];
  const payload = build(devices);
  const modelBuckets = collectAnalyticsBuckets(devices).model;
  assert.equal(payload.summary.uniqueModels, 1);
  assert.equal(payload.summary.withModel, 1);
  assert.deepEqual(modelBuckets.map(({ value }) => value), ["Room Kit"]);
});

test("analytics uses shared empty markers for vendor, model, room, IP, address, and port coverage", () => {
  const payload = build([{
    mac: "00:11:22:33:44:80",
    manufacturer: "Неизвестный вендор",
    model: "Неизвестная модель",
    room: "Без помещения",
    ip: "нет данных",
    address: "не заполнено",
    switchIp: "Unknown vendor",
    switchPort: "Неизвестен",
  }]);
  assert.equal(payload.summary.devices, 1);
  assert.equal(payload.summary.uniqueVendors, 0);
  assert.equal(payload.summary.uniqueModels, 0);
  assert.equal(payload.summary.uniqueRooms, 0);
  assert.equal(payload.summary.withModel, 0);
  assert.equal(payload.summary.withRoom, 0);
  assert.equal(payload.summary.withIp, 0);
  assert.equal(payload.summary.withAddress, 0);
  assert.equal(payload.summary.withSwitch, 0);
  assert.equal(payload.summary.withSwitchPort, 0);
});

test("unknown switch IP markers are excluded from switch analytics and topology", () => {
  const devices = [
    { mac: "00:11:22:33:44:01", switchIp: "10.0.0.1", switchPort: "1" },
    { mac: "00:11:22:33:44:02", switchIp: "Unknown", switchPort: "2" },
    { mac: "00:11:22:33:44:03", switchIp: "Не указано", switchPort: "3" },
    { mac: "00:11:22:33:44:04", switchIp: "192.0.2.999", switchPort: "4" },
  ];
  const buckets = collectAnalyticsBuckets(devices);
  assert.deepEqual(buckets.switch.map(({ value }) => value), ["10.0.0.1"]);
  assert.deepEqual(collectTopologyBuckets(devices)["topology-switch"].map(({ value }) => value), ["10.0.0.1"]);
  const dataset = build(devices);
  assert.equal(dataset.summary.uniqueSwitches, 1);
  assert.equal(dataset.topology.summary.switches, 1);
  assert.deepEqual(dataset.topology.nodes.map(({ switchIp }) => switchIp), ["10.0.0.1"]);
});

test("topology switch, port and room buckets stay per-input-batch when topology maps are disabled", () => {
  const devices = [
    { switchIp: "10.0.0.1", switchPort: "1", room: "A", mac: "00:11:22:33:44:01" },
    { switchIp: "10.0.0.1", switchPort: "1", room: "A", mac: "00:11:22:33:44:02" },
    { switchIp: "10.0.0.1", switchPort: "2", room: "B", mac: "00:11:22:33:44:03" },
    { switchIp: "10.0.0.2", switchPort: "1", room: "C", mac: "00:11:22:33:44:04" },
  ];
  const collector = createCollector({ includeClusters: false, includeRankings: false, includeTopologySummary: false, includeTopologyDevices: false });
  collector.accept(devices);
  const dataset = collector.finish();
  const buckets = collectTopologyBuckets(devices);
  assert.deepEqual(buckets["topology-switch"].map(({ value, count }) => [value, count]), [["10.0.0.1", 3], ["10.0.0.2", 1]]);
  assert.deepEqual(buckets["topology-port:10.0.0.1"].map(({ value, count }) => [value, count]), [["1", 2], ["2", 1]]);
  assert.deepEqual(buckets["topology-room:10.0.0.1"].map(({ value, count }) => [value, count]), [["A", 2], ["B", 1]]);
  assert.equal(dataset.summary.devices, devices.length);
  assert.equal(dataset.topology.nodes.length, 0);
});

test("analytics and topology bucket materialization preserves every high-cardinality value", () => {
  const devices = Array.from({ length: 1_205 }, (_, index) => ({
    manufacturer: `Vendor ${index}`,
    model: `Model ${index}`,
    room: `Room ${index}`,
    smartroomId: `SR-${index}`,
    switchIp: `10.0.${Math.floor(index / 254)}.${(index % 254) + 1}`,
    switchPort: `Port ${index}`,
  }));
  const analytics = collectAnalyticsBuckets(devices);
  const topology = collectTopologyBuckets(devices);
  assert.equal(analytics.vendor.length, devices.length);
  assert.equal(analytics.model.length, devices.length);
  assert.equal(analytics.room.length, devices.length);
  assert.equal(analytics.smartroom.length, devices.length);
  assert.equal(topology["topology-port-total"].length, devices.length);
  assert.equal(topology["topology-switch"].reduce((sum, row) => sum + row.count, 0), devices.length);
});

test("topology renderer uses exact totals and cursor pages for switches, ports and rooms", () => {
  const payload = { topology: {
    pageItems: [{
      switchIp: "10.0.0.21", deviceCount: 500, portCount: 51,
      ports: Array.from({ length: 50 }, (_, index) => ({ port: String(index + 1), deviceCount: 10 })),
      portPageData: { page: 0, hasMore: true },
      rooms: Array.from({ length: 50 }, (_, index) => `Room ${index + 1}`),
      roomCount: 75, roomPageData: { page: 0, hasMore: true },
    }],
    page: 1, pageTotal: 21, pageHasMore: true, unassigned: [], summary: { unassignedDevices: 0 },
  } };
  const html = renderTopology(payload, 20, 1);
  assert.match(html, /Коммутаторы 21–21 из 21/);
  assert.match(html, /data-topology-switch-page="0"/);
  assert.match(html, /data-topology-switch-page="2"/);
  assert.match(html, /Порты 1–50 из 51/);
  assert.match(html, /data-topology-port-page="1"/);
  assert.match(html, /Помещения 1–50 из 75/);
  assert.match(html, /data-topology-room-page="1"/);
});

test("streamed cluster CSV preserves the full CSV bytes across page boundaries", async () => {
  const payload = build([
    { manufacturer: "Acme", room: "101", switchIp: "10.0.0.1" },
    { manufacturer: "Acme", room: "101", switchIp: "10.0.0.1" },
    { manufacturer: "Other; Inc", room: "202", switchIp: "10.0.0.2" },
  ]);
  const rows = payload.clusters.items.map((item) => ({ value: item.id, count: item.count, data: item }));
  const chunks = [rows.slice(0, 1), rows.slice(1)];
  const writes = [];
  await writeClustersCsv(payload.clusters.fields, async (visit) => {
    for (const page of chunks) await visit(page);
  }, { write: async (text) => writes.push(text) }, { maxBytes: 80 });
  assert.equal(writes.join(""), clustersCsv(payload));
});

test("cluster CSV fallback honors stream backpressure and produces the same Blob bytes", async () => {
  const payload = build(Array.from({ length: 1_205 }, (_, index) => ({
    manufacturer: `Vendor ${index % 17}`,
    room: `Room ${index % 43}`,
    switchIp: `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`,
  })));
  const rows = payload.clusters.items.map((item) => ({ value: item.id, count: item.count, data: item }));
  const encoder = new globalThis.TextEncoder();
  const transform = new globalThis.TransformStream({
    transform(chunk, controller) { controller.enqueue(encoder.encode(String(chunk))); },
  });
  const writable = transform.writable.getWriter();
  const blobPromise = new globalThis.Response(transform.readable, { headers: { "Content-Type": "text/csv;charset=utf-8" } }).blob();
  await writeClustersCsv(payload.clusters.fields, async (visit) => {
    for (let offset = 0; offset < rows.length; offset += 500) await visit(rows.slice(offset, offset + 500));
  }, writable, { maxBytes: 256 });
  await writable.close();
  const blob = await blobPromise;
  assert.equal(new globalThis.TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer()), clustersCsv(payload));
});

test("topology retains every switch, port and port device with paged access", () => {
  const devices = Array.from({ length: 2_050 }, (_, index) => ({
    mac: (index + 1).toString(16).padStart(12, "0"),
    manufacturer: "Acme",
    model: `Model ${index}`,
    ip: `10.1.${Math.floor(index / 250)}.${(index % 250) + 1}`,
    switchIp: "10.0.0.1",
    switchPort: `Port ${String(index).padStart(4, "0")}`,
    room: "Room A",
    address: "Address A",
  }));
  const sharedPortDevices = Array.from({ length: 55 }, (_, index) => ({
    mac: (100_000 + index).toString(16).padStart(12, "0"),
    manufacturer: "Acme",
    model: `Shared ${index}`,
    switchIp: "10.0.0.1",
    switchPort: "Shared port",
  }));
  const payload = build([...devices, ...sharedPortDevices]);
  const node = payload.topology.nodes[0];
  const sharedPort = node.ports.find((port) => port.port === "Shared port");
  assert.equal(payload.topology.nodes.length, 1);
  assert.equal(node.portCount, 2_051);
  assert.equal(node.ports.length, 2_051);
  assert.equal(sharedPort.devices.length, 55);
  assert.equal(sharedPort.devices[54].model, "Shared 54");
  assert.equal(payload.topology.summary.ports, 2_051);
  assert.equal(payload.topology.summary.linkedDevices, 2_105);

  const portIndex = node.ports.indexOf(sharedPort);
  const html = renderTopology(payload, 20, 0, 50, { "10.0.0.1": Math.floor(portIndex / 50) }, {
    [JSON.stringify(["10.0.0.1", "Shared port"])]: 1,
  });
  assert.match(html, /data-topology-device-page="0"/);
  assert.match(html, /Устройства 51–55 из 55/);
  assert.match(topologyDocument(payload), /Shared 54/);
});

test("topology does not truncate switch records after the former 20,000 switch cap", () => {
  const count = 20_005;
  const payload = build(Array.from({ length: count }, (_, index) => ({
    mac: (index + 1).toString(16).padStart(12, "0"),
    switchIp: `10.0.${Math.floor(index / 254) + 1}.${(index % 254) + 1}`,
    switchPort: "1",
  })));
  assert.equal(payload.topology.nodes.length, count);
  assert.equal(payload.topology.summary.switches, count);
  assert.equal(payload.topology.summary.ports, count);
  assert.match(renderTopology(payload, 20, 1_000), /Коммутаторы 20001–20005 из/);
});

test("topology preserves and pages devices without a switch, including an all-unassigned Final", () => {
  const devices = Array.from({ length: 55 }, (_, index) => ({
    mac: (200_000 + index).toString(16).padStart(12, "0"),
    manufacturer: "Acme",
    model: `Unassigned ${index}`,
    ip: `192.0.2.${index + 1}`,
    room: "Room U",
    address: "Address U",
    switchPort: "Candidate port",
  }));
  const payload = build(devices);
  assert.equal(payload.topology.nodes.length, 0);
  assert.equal(payload.topology.unassigned.length, 55);
  assert.equal(payload.topology.summary.unassignedDevices, 55);
  assert.match(renderTopology(payload, 20, 0, 50, {}, {}, 1), /Устройства 51–55 из 55/);
  assert.match(renderTopology(payload, 20, 0, 50, {}, {}, 1), /Unassigned 54/);
  assert.match(topologyDocument(payload), /Unassigned 54/);
});

test("topology HTML export streams every Final row in bounded writes with escaping", async () => {
  const chunks = Array.from({ length: 8 }, (_, chunkIndex) => Array.from({ length: 75 }, (_, rowIndex) => {
    const index = chunkIndex * 75 + rowIndex;
    return {
      switchIp: index % 2 ? "10.0.0.1" : index === 0 ? "192.0.2.999" : "Unknown",
      switchPort: `Port ${index}`,
      mac: (index + 1).toString(16).padStart(12, "0"),
      vendor: index === 0 ? "Acme & Sons" : "Acme",
      model: index === 1 ? "<Panel>" : `Model ${index}`,
      ip: `192.0.2.${index + 1}`,
      room: "Room A",
      address: "Building A",
    };
  }));
  const writes = [];
  let writing = false;
  const writable = { write: async (text) => {
    assert.equal(writing, false, "each output write must be awaited before the next one");
    writing = true;
    await Promise.resolve();
    writes.push(text);
    writing = false;
  } };
  let visited = 0;
  await writeTopologyHtml({ id: "topology-final" }, async (id, visit) => {
    assert.equal(id, "topology-final");
    for (const chunk of chunks) {
      visited += chunk.length;
      await visit(chunk);
    }
  }, { switches: 1, ports: 600, linkedDevices: 300, unassignedDevices: 300 }, writable, { maxBytes: 512 });
  const html = writes.join("");
  assert.equal(visited, 600);
  assert.equal((html.match(/<tr>/g) || []).length, 601);
  assert.match(html, /Коммутаторов: 1 · портов: 600 · связанных устройств: 300 · без коммутатора: 300/);
  assert.match(html, /Acme &amp; Sons/);
  assert.match(html, /&lt;Panel&gt;/);
  assert.match(html, /Без коммутатора/);
  assert.ok(writes.slice(1, -1).every((part) => part.length <= 256), "body writes should stay within the configured byte target");
});

test("topology HTML TransformStream fallback preserves the complete UTF-8 document", async () => {
  const rows = Array.from({ length: 305 }, (_, index) => ({
    switchIp: "10.0.0.1",
    switchPort: `Порт ${index}`,
    mac: (index + 1).toString(16).padStart(12, "0"),
    vendor: index === 0 ? "Acme & Sons" : "Acme",
    model: index === 1 ? "<Panel>" : `Model ${index}`,
    ip: `192.0.2.${(index % 250) + 1}`,
    room: "Переговорная A",
    address: "Корпус A",
  }));
  const visitRows = async (visit) => {
    for (let offset = 0; offset < rows.length; offset += 100) await visit(rows.slice(offset, offset + 100));
  };
  const expectedParts = [];
  await writeTopologyHtml({ id: "topology-final" }, async (_id, visit) => visitRows(visit), { switches: 1, ports: 305, linkedDevices: 305, unassignedDevices: 0 }, {
    write: async (chunk) => expectedParts.push(chunk),
  });
  const encoder = new globalThis.TextEncoder();
  const transform = new globalThis.TransformStream({
    transform(chunk, controller) { controller.enqueue(encoder.encode(String(chunk))); },
  });
  const writable = transform.writable.getWriter();
  const blobPromise = new globalThis.Response(transform.readable, { headers: { "Content-Type": "text/html;charset=utf-8" } }).blob();
  await writeTopologyHtml({ id: "topology-final" }, async (_id, visit) => visitRows(visit), { switches: 1, ports: 305, linkedDevices: 305, unassignedDevices: 0 }, writable, { maxBytes: 512 });
  await writable.close();
  const blob = await blobPromise;
  assert.equal(new globalThis.TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer()), expectedParts.join(""));
});

test("topology HTML export preserves the empty-state report without opening a row stream", async () => {
  const writes = [];
  let visited = false;
  await writeTopologyHtml({ id: "empty-final", deviceCount: 0 }, async () => { visited = true; }, {}, { write: async (text) => writes.push(text) });
  const html = writes.join("");
  assert.equal(visited, false);
  assert.match(html, /Нет данных топологии\./);
  assert.match(html, /Коммутаторов: 0 · портов: 0 · связанных устройств: 0 · без коммутатора: 0/);
});

test("full Final report calculates room coverage, unassigned devices and room ranking", () => {
  const payload = build([
    { vendor: "Acme", model: "Panel", room: "101", address: "A", ip: "10.0.0.1", switchIp: "10.0.0.2" },
    { vendor: "Acme", model: "Panel", room: "101", address: "A", ip: "10.0.0.3", switchIp: "10.0.0.2" },
    { vendor: "Other", model: "Screen", room: "202", address: "Unknown", ip: "Unknown", switchIp: "" },
    { vendor: "Other", model: "Screen", room: "Не указано", address: "B", ip: "10.0.0.4", switchIp: "10.0.0.3" },
  ]);
  assert.deepEqual(payload.roomOccupancy, {
    assignedDevices: 3,
    unassignedDevices: 1,
    assignedPercent: 75,
    uniqueRooms: 2,
    averageDevicesPerRoom: 1.5,
    mostOccupied: { label: "101", count: 2, percent: 66.7, percentOfAssigned: 66.7, percentOfAll: 50 },
    rooms: [
      { label: "101", count: 2, percent: 66.7, percentOfAssigned: 66.7, percentOfAll: 50 },
      { label: "202", count: 1, percent: 33.3, percentOfAssigned: 33.3, percentOfAll: 25 },
    ],
  });
  assert.equal(payload.coverage.address.count, 3);
  assert.equal(payload.coverage.ip.count, 3);
  assert.match(payload.reportText, /=== ЗАПОЛНЕННОСТЬ ПОМЕЩЕНИЙ ===/);
  assert.match(payload.reportText, /Без помещения: 1/);
});
