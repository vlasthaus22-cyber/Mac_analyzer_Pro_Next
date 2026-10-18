import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { refreshVirtualTable, virtualTableRows, virtualTableWindow } from "../src/ui/virtual-table.js";

const read = (path) => readFileSync(new globalThis.URL(`../${path}`, import.meta.url), "utf8");

test("inactive views are detached and remain queryable and restorable", () => {
  const source = read("src/ui/lazy-tabs.js");
  const app = read("src/app.js");
  assert.match(source, /document\.createDocumentFragment\(\)/);
  assert.match(source, /export function activateLazyTab\(name\)/);
  assert.match(source, /entry\.fragment\.querySelector\(selector\)/);
  assert.match(source, /entry\.panel\.append\(entry\.fragment\)/);
  assert.match(app, /activateLazyTab\(name\)/);
  assert.match(app, /initializeLazyTabs\(\$\$\("\.view"\), initialView\)/);
  assert.match(app, /queryAllLazyTabs\(selector\)/);
});

test("history log view skips unchanged revisions and reloads its first page after database changes", () => {
  const app = read("src/app.js");
  const config = read("scripts/build-config.js");
  assert.match(app, /historyLogNeedsRefresh\(state\.historyLog, state\.temporalDataRevision\)/);
  assert.match(app, /const dataRevision = state\.temporalDataRevision/);
  assert.match(app, /if \(dataRevision !== state\.temporalDataRevision\)\s*\{\s*return loadHistoryLog\(\{ filters, cursor: null, previous: \[\] \}\)/);
  assert.match(app, /loadedRevision: dataRevision/);
  assert.match(app, /cursor: null, previous: \[\]/);
  assert.match(config, /"src\/core\/history-log-state\.js"/);
});

test("MAC5 rule list uses bounded searchable cursor pages with navigation", () => {
  const app = read("src/app.js");
  const database = read("src/data/database.js");
  const html = read("index.html");
  assert.match(app, /database\.mac5ModelPage\(\{ afterPrefix: current\.cursor, query: current\.query, limit: 100 \}\)/);
  assert.match(app, /database\.mac5ModelsMatchingModel\(model\)/);
  assert.doesNotMatch(app.match(/async function renderMac5RuleList\(\) \{([\s\S]*?)\n\}/)?.[1] || "", /mac5Models\(\)/);
  assert.match(database, /mac5ModelPage\(\{ afterPrefix = "", query = "", limit = 100 \} = \{\}\)/);
  assert.match(database, /store\.openCursor\(range, "next"\)/);
  assert.match(html, /id="mac5ModelRuleFilter"/);
  assert.match(html, /id="mac5ModelRulePrevious"/);
  assert.match(html, /id="mac5ModelRuleNext"/);
});

test("Inventory result rows open device analytics on double click and Enter", () => {
  const app = read("src/app.js");
  const renderRows = app.match(/async function renderDeviceTable\(\) \{([\s\S]*?)\n\}\n\nfunction setDeviceSelected/)?.[1] || "";
  assert.match(renderRows, /addEventListener\("dblclick", \(\) => \{/);
  assert.match(renderRows, /openDeviceAnalytics\(device\)\.catch\(showError\)/);
  assert.match(renderRows, /event\.key === "Enter"[\s\S]*?openDeviceAnalytics\(device\)\.catch\(showError\)/);
  assert.match(app, /async function openDeviceAnalytics\(device\)/);
});

test("large history, analytics and inventory tables use a 20-row virtual window", () => {
  const source = read("src/ui/virtual-table.js");
  const render = read("src/ui/render.js");
  const app = read("src/app.js");
  const css = read("styles.css");
  assert.match(source, /VIRTUAL_TABLE_THRESHOLD = 50/);
  assert.match(source, /VIRTUAL_TABLE_VISIBLE_ROWS = 20/);
  assert.match(source, /function render\(tbody\)/);
  assert.match(source, /wrapper\.addEventListener\("scroll"/);
  assert.match(source, /tbody\.replaceChildren\(\.\.\.rows\)/);
  assert.match(source, /export function virtualTableRows/);
  assert.match(app, /data-virtual-scroll="true"/);
  assert.match(render, /history-log-group[\s\S]*?data-virtual-scroll="true"/);
  assert.match(render, /legacyObservationLogContent[\s\S]*?data-virtual-scroll="true"/);
  assert.match(render, /dashboardFleetDialogContent[\s\S]*?data-virtual-scroll="true"/);
  assert.match(render, /dashboardAggregateDialogContent[\s\S]*?data-virtual-scroll="true"/);
  assert.match(render, /macTimelineAppearancesContent[\s\S]*?data-virtual-scroll="true"/);
  assert.match(render, /export function deviceTable[\s\S]*?data-virtual-scroll="true"/);
  assert.match(app, /function historicalSwitchChangeDetails[\s\S]*?data-virtual-scroll="true"/);
  assert.match(app, /data-imported-smartroom-details[\s\S]*?data-virtual-scroll="true"/);
  assert.match(app, /function historicalAddressDetails[\s\S]*?data-virtual-scroll="true"/);
  assert.match(app, /async function renderMac5RuleList[\s\S]*?data-virtual-scroll="true"/);
  assert.match(app, /host\.innerHTML = result\.rows\.length[\s\S]*?data-virtual-scroll="true"/);
  assert.match(render, /const changeTable = changes\.length[\s\S]*?data-virtual-scroll="true"/);
  assert.match(app, /refreshVirtualTable\(deviceTbody\)/);
  assert.match(app, /virtual-table-render/);
  assert.match(css, /\.virtual-table-wrap \{ max-height:/);
  assert.match(css, /tbody tr:not\(\[data-virtual-spacer\]\) \{ height: 44px; \}/);
});

test("virtual table window clamps scroll positions and preserves every row's height", () => {
  assert.deepEqual(virtualTableWindow(250, 0), { start: 0, end: 20, before: 0, after: 10_120 });
  assert.deepEqual(virtualTableWindow(250, 4_400), { start: 100, end: 120, before: 4_400, after: 5_720 });
  assert.deepEqual(virtualTableWindow(250, 99_999), { start: 230, end: 250, before: 10_120, after: 0 });
  assert.deepEqual(virtualTableWindow(-1, -2), { start: 0, end: 0, before: 0, after: 0 });
});

test("virtual rendering retains all row nodes and scrolls by 20-row windows", () => {
  class FakeElement {
    constructor(kind = "element") {
      this.kind = kind;
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.attributes = {};
      this.listeners = new Map();
      this.classList = { add() {}, remove() {} };
      this.scrollTop = 0;
    }
    append(node) {
      const nodes = node.kind === "fragment" ? [...node.children] : [node];
      for (const child of nodes) {
        child.parent?.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...nodes) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      for (const node of nodes) this.append(node);
    }
    get childElementCount() { return this.children.length; }
    setAttribute(name, value) { this.attributes[name] = value; }
    closest(selector) {
      if (selector === "table") return this.table;
      if (selector === ".table-scroll, .table-wrap") return this.wrapper;
      return null;
    }
    getBoundingClientRect() { return { height: 44 }; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name) { this.listeners.delete(name); }
    dispatchEvent(event) { this.listeners.get(event.type)?.(event); }
  }
  const prior = {
    document: globalThis.document,
    CustomEvent: globalThis.CustomEvent,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  let scheduledFrame = null;
  globalThis.document = {
    createElement: (kind) => new FakeElement(kind),
    createDocumentFragment: () => new FakeElement("fragment"),
  };
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  globalThis.requestAnimationFrame = (callback) => { scheduledFrame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const wrapper = new FakeElement();
    const table = new FakeElement();
    table.tHead = { rows: [{ cells: [{}, {}, {}] }] };
    const tbody = new FakeElement();
    tbody.table = table;
    tbody.wrapper = wrapper;
    const originals = Array.from({ length: 250 }, (_, index) => {
      const row = new FakeElement("tr");
      row.dataset.deviceId = String(index);
      return row;
    });
    tbody.replaceChildren(...originals);

    assert.equal(refreshVirtualTable(tbody), true);
    assert.equal(tbody.children.length, 22);
    assert.equal(tbody.children[0].dataset.virtualSpacer, "true");
    assert.deepEqual(tbody.children.slice(1, -1), originals.slice(0, 20));
    assert.equal(virtualTableRows(tbody).length, 250);

    wrapper.scrollTop = 4_400;
    wrapper.listeners.get("scroll")();
    scheduledFrame();
    assert.deepEqual(tbody.children.slice(1, -1), originals.slice(100, 120));
    assert.equal(virtualTableRows(tbody)[249], originals[249]);

    const replacementPage = Array.from({ length: 51 }, (_, index) => {
      const row = new FakeElement("tr");
      row.dataset.deviceId = `replacement-${index}`;
      return row;
    });
    tbody.replaceChildren(...replacementPage);
    assert.equal(refreshVirtualTable(tbody), true);
    assert.equal(wrapper.scrollTop, 0, "replacement pages must begin at the first row");
    assert.deepEqual(tbody.children.slice(1, -1), replacementPage.slice(0, 20));

    const smallerPage = Array.from({ length: 50 }, (_, index) => {
      const row = new FakeElement("tr");
      row.dataset.deviceId = `small-${index}`;
      return row;
    });
    tbody.replaceChildren(...smallerPage);
    assert.equal(refreshVirtualTable(tbody), false);
    assert.deepEqual(tbody.children, smallerPage, "a smaller replacement page must not restore stale virtual rows");

    const nextPage = Array.from({ length: 51 }, (_, index) => {
      const row = new FakeElement("tr");
      row.dataset.deviceId = `next-${index}`;
      return row;
    });
    tbody.replaceChildren(...nextPage);
    assert.equal(refreshVirtualTable(tbody), true);
    assert.deepEqual(tbody.children.slice(1, -1), nextPage.slice(0, 20));
    assert.equal(virtualTableRows(tbody).length, 51);
  } finally {
    globalThis.document = prior.document;
    globalThis.CustomEvent = prior.CustomEvent;
    globalThis.requestAnimationFrame = prior.requestAnimationFrame;
    globalThis.cancelAnimationFrame = prior.cancelAnimationFrame;
  }
});

test("portable bundle includes the view and virtual-table modules", () => {
  const config = read("scripts/build-config.js");
  assert.match(config, /"src\/ui\/lazy-tabs\.js"/);
  assert.match(config, /"src\/ui\/virtual-table\.js"/);
});
