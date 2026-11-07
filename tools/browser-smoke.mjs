import { get as httpGet, request as httpRequest } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareFinals } from "../src/core/comparison.js";
import { createXlsxWorkbookStream } from "../src/core/xlsx-export.js";
import { createZip } from "../scripts/release-archive.js";
const port = Number(process.argv[2] || 9333);
const requestedSmokeUrl = process.argv[3] ? new URL(process.argv[3]) : null;
const launcherStartupOnly = process.argv.includes("--launcher-startup-only");
function getJson(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}
function putJson(url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "PUT" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end();
  });
}
async function getJsonEventually(url, { attempts = 50, intervalMs = 200 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await getJson(url); }
    catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`DevTools endpoint did not become ready at ${url}: ${lastError?.message || "unknown error"}`);
}
let target = null;
for (let attempt = 0; attempt < 50; attempt += 1) {
  const targets = await getJsonEventually(`http://127.0.0.1:${port}/json/list`);
  target = targets.find((item) => item.type === "page"
    && (item.url.includes("MAC-Analyzer-Pro-Next") || (launcherStartupOnly && requestedSmokeUrl && new URL(item.url).origin === requestedSmokeUrl.origin))
    && (!requestedSmokeUrl || new URL(item.url).searchParams.get("db") === requestedSmokeUrl.searchParams.get("db")));
  if (target) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!target) {
  const smokeUrl = requestedSmokeUrl
    ? new URL(requestedSmokeUrl.href)
    : pathToFileURL(resolve("dist/MAC-Analyzer-Pro-Next.html"));
  if (!smokeUrl.searchParams.has("db")) smokeUrl.searchParams.set("db", `mac-analyzer-pro-next-test-${crypto.randomUUID()}`);
  const endpoint = new URL(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(smokeUrl.href)}`);
  target = await putJson(endpoint);
}
if (!launcherStartupOnly && !/^mac-analyzer-pro-next-test-[a-z0-9-]{8,80}$/i.test(new URL(target.url).searchParams.get("db") || "")) {
  throw new Error("Browser smoke требует уникальную disposable IndexedDB из параметра ?db=mac-analyzer-pro-next-test-<id>");
}

let socket = null;
let sequence = 0;
const pending = new Map();
const networkFailures = [];
const networkRequests = new Map();
const runtimeDiagnostics = [];
let connectedTargetUrl = "";
async function attachToTarget(webSocketDebuggerUrl, { force = false } = {}) {
  if (!force && socket && connectedTargetUrl === webSocketDebuggerUrl) return;
  const nextSocket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    nextSocket.onopen = resolve;
    nextSocket.onerror = reject;
  });
  nextSocket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent") networkRequests.set(message.params.requestId, { url: message.params.request.url, method: message.params.request.method });
    if (message.method === "Network.loadingFailed") networkFailures.push({ ...message.params, ...(networkRequests.get(message.params.requestId) || {}) });
    if (message.method === "Runtime.consoleAPICalled" && ["warning", "error"].includes(message.params.type)) runtimeDiagnostics.push({ level: message.params.type, text: (message.params.args || []).map((argument) => argument.value ?? argument.description ?? "").join(" ") });
    if (message.method === "Runtime.exceptionThrown") runtimeDiagnostics.push({ level: "exception", text: message.params.exceptionDetails?.text || message.params.exceptionDetails?.exception?.description || "Runtime exception" });
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };
  const previousSocket = socket;
  socket = nextSocket;
  connectedTargetUrl = webSocketDebuggerUrl;
  previousSocket?.close();
}
await attachToTarget(target.webSocketDebuggerUrl);

const fallbackExportStress = process.argv.includes("--fallback-export-stress-only");
const analyticsStagesOnly = process.argv.includes("--analytics-stages-only");
if (analyticsStagesOnly) {
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", {
    source: `(()=>{const entries=[];let nextId=0;Object.defineProperty(globalThis,"__smokeAnalyticsIdleState",{configurable:true,value:()=>({entries:entries.map(({id,canceled,ran,options})=>({id,canceled,ran,options})),pending:entries.filter((entry)=>!entry.canceled&&!entry.ran).map((entry)=>entry.id)})});Object.defineProperty(globalThis,"__smokeRunAnalyticsIdle",{configurable:true,value:(id)=>{const entry=entries.find((item)=>item.id===id);if(!entry||entry.canceled||entry.ran)return false;entry.ran=true;entry.callback({didTimeout:false,timeRemaining:()=>50});return true}});Object.defineProperty(globalThis,"requestIdleCallback",{configurable:true,value:(callback,options)=>{const entry={id:++nextId,callback,options,canceled:false,ran:false};entries.push(entry);return entry.id}});Object.defineProperty(globalThis,"cancelIdleCallback",{configurable:true,value:(id)=>{const entry=entries.find((item)=>item.id===id);if(entry)entry.canceled=true}});globalThis.__smokeSnapshotChunkReads=0;const originalGet=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(...args){if(this.name==="snapshotChunks"&&this.transaction.mode==="readonly")globalThis.__smokeSnapshotChunkReads+=1;return originalGet.apply(this,args)}})();`,
  });
}
if (fallbackExportStress) {
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", {
    source: "Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: undefined }); Object.defineProperty(globalThis, 'showOpenFilePicker', { configurable: true, value: undefined });",
  });
  await command("Page.reload", { ignoreCache: true });
  let ready = false;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const state = await command("Runtime.evaluate", {
        expression: "({ title: document.title, status: document.querySelector('#databaseStatus')?.textContent || '', fsa: typeof globalThis.showSaveFilePicker })",
        returnByValue: true,
      });
      const value = state.result?.value;
      if (value?.title === "MAC Analyzer Pro Next" && value.status && value.fsa === "undefined") { ready = true; break; }
    } catch { /* The execution context is replaced during reload. */ }
  }
  if (!ready) throw new Error("Could not reload the application with File System Access disabled");
}

function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DevTools command timed out: ${method}`));
    }, 300_000);
    pending.set(id, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
if (analyticsStagesOnly) await reloadDatabaseAndWait(new URL(target.url).searchParams.get("db"));
async function navigateToHistoryDatabase(offset, expectedDatabase, expectedInventoryCount) {
  const history = await command("Page.getNavigationHistory");
  const entry = history.entries[history.currentIndex + offset];
  if (!entry || new URL(entry.url).searchParams.get("db") !== expectedDatabase) {
    throw new Error(`Browser history entry ${offset} did not target database ${expectedDatabase}: ${JSON.stringify({ currentIndex: history.currentIndex, entry })}`);
  }
  await command("Page.navigateToHistoryEntry", { entryId: entry.id });
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    const nextTarget = targets.find((item) => item.id === target.id && item.type === "page");
    if (!nextTarget || new URL(nextTarget.url).searchParams.get("db") !== expectedDatabase) continue;
    target = nextTarget;
    await attachToTarget(target.webSocketDebuggerUrl, { force: true });
    await command("Runtime.enable");
    const state = await evaluate(`(()=>({db:new URL(location.href).searchParams.get('db'),title:document.title,status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner')?.hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    const inventoryCountReady = expectedInventoryCount === undefined
      || state.status.includes(`${Number(expectedInventoryCount).toLocaleString("ru-RU")} устройств`);
    if (state.db === expectedDatabase && state.title === "MAC Analyzer Pro Next" && state.status && !state.error && inventoryCountReady) return state;
  }
  throw new Error(`Browser did not restore ready database ${expectedDatabase} from history`);
}

async function reloadDatabaseAndWait(expectedDatabase) {
  await command("Page.reload", { ignoreCache: true });
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    const nextTarget = targets.find((item) => item.id === target.id && item.type === "page");
    if (!nextTarget || new URL(nextTarget.url).searchParams.get("db") !== expectedDatabase) continue;
    target = nextTarget;
    await attachToTarget(target.webSocketDebuggerUrl, { force: true });
    await command("Runtime.enable");
    const state = await evaluate(`(()=>({db:new URL(location.href).searchParams.get('db'),title:document.title,status:document.querySelector('#databaseStatus')?.textContent||'',ready:document.documentElement.dataset.appReady==='true',error:!document.querySelector('#errorBanner')?.hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (state.db === expectedDatabase && state.title === "MAC Analyzer Pro Next" && state.status && !state.status.includes("последний сохранённый счётчик") && state.ready && !state.error) return state;
  }
  throw new Error(`Browser did not restore ready database ${expectedDatabase} after reload`);
}

async function importDeviceArchiveAndVerify(expectedDatabase, expectedActiveSnapshotId) {
  await wait(1500);
  const engineerActive = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes('Инженер')`);
  if (!engineerActive) {
    await evaluate(`document.querySelector('#engineeringModeButton')?.click()`);
    await evaluate(`(()=>{const input=document.querySelector('#engineeringPassword');input.value=${JSON.stringify(smokeEngineerPassword)};input.dispatchEvent(new Event('input',{bubbles:true}));const confirmField=document.querySelector('#engineeringPasswordConfirmField');if(!confirmField.hidden){const confirm=document.querySelector('#engineeringPasswordConfirm');confirm.value=${JSON.stringify(smokeEngineerPassword)};confirm.dispatchEvent(new Event('input',{bubbles:true}))}document.querySelector('#engineeringModeForm').requestSubmit();return true})()`);
    let engineerRestored = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(100);
      engineerRestored = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes('Инженер')`);
      if (engineerRestored) break;
    }
    if (!engineerRestored) throw new Error("Could not re-authenticate the disposable engineer session for the protected archive view");
  }
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  let dataImportReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(100);
    dataImportReady = await evaluate(`document.querySelector('#dataView')?.classList.contains('active') && Boolean(document.querySelector('#importDatabaseInput'))`);
    if (dataImportReady) break;
  }
  if (!dataImportReady) throw new Error("Data view did not mount the archive import input after profile reload");
  await evaluate(`(()=>{const archive={format:'mac-analyzer-devices-json',version:2,exportedAt:'2026-10-15T12:00:00.000Z',devices:[{internalDeviceId:'DEVICE-TRANSFER-SMOKE',mac:'00:11:22:33:44:62',vendor:'Device Transfer Vendor',model:'Transfer Model'}]};const input=document.querySelector('#importDatabaseInput');if(!input)throw new Error('Data import input is not mounted');const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(archive)],'device-transfer.macarchive.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return input.files[0]?.name})()`);
  let state = null;
  let lastUiError = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    state = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(expectedDatabase)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').count();const inventoryCount=tx.objectStore('inventory').count();const device=tx.objectStore('inventory').get('DEVICE-TRANSFER-SMOKE');const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,snapshotCount:snapshots.result,inventoryCount:inventoryCount.result,device:device.result||null,historyCount:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (state.device?.manufacturer === "Device Transfer Vendor") break;
    lastUiError = await evaluate(`(()=>{const banner=document.querySelector('#errorBanner');return banner&&!banner.hidden?(banner.querySelector('span')?.textContent||'Import error'):''})()`);
    if (lastUiError) throw new Error(`mac-analyzer-devices-json v2 import failed: ${lastUiError}`);
  }
  if (state?.device?.manufacturer !== "Device Transfer Vendor" || state.device?.model !== "Transfer Model" || state.activeId !== expectedActiveSnapshotId || state.snapshotCount !== 1 || state.inventoryCount !== 2 || state.historyCount !== 1) throw new Error(`mac-analyzer-devices-json v2 did not add Inventory without changing active Final or History: ${JSON.stringify({state,lastUiError})}`);
  return state;
}

await command("Runtime.enable");
let appBootState = null;
for (let attempt = 0; attempt < 200; attempt += 1) {
  await wait(100);
  appBootState = await evaluate(`({title:document.title,readyState:document.readyState,errorBanner:Boolean(document.querySelector('#errorBanner')),databaseStatus:Boolean(document.querySelector('#databaseStatus'))})`);
  if (appBootState.title === "MAC Analyzer Pro Next" && appBootState.errorBanner && appBootState.databaseStatus) break;
}
if (appBootState?.title !== "MAC Analyzer Pro Next" || !appBootState.errorBanner || !appBootState.databaseStatus) {
  throw new Error(`Portable app did not reach its ready DOM state: ${JSON.stringify(appBootState)}`);
}

let initial = null;
for (let attempt = 0; attempt < 80; attempt += 1) {
  initial = await evaluate(`({
  title: document.title,
  views: document.querySelectorAll('.view').length,
  error: !document.querySelector('#errorBanner').hidden,
  databaseStatus: document.querySelector('#databaseStatus').textContent,
  engineerOnlyViewsVisible: [...document.querySelectorAll('.nav-button[data-view]')].filter((button) => ['single','filecompare','multicompare','enrichment','batch','data','rooms','guide'].includes(button.dataset.view) && !button.hidden).map((button) => button.dataset.view),
  userModeLabel: document.querySelector('#engineeringModeButton').textContent
})`);
  if (!initial.engineerOnlyViewsVisible.length && initial.userModeLabel.includes("Пользователь")) break;
  await wait(100);
}
if (initial.title !== "MAC Analyzer Pro Next" || initial.views < 8 || initial.error) throw new Error(`Некорректная инициализация: ${JSON.stringify(initial)}`);
if (initial.engineerOnlyViewsVisible.length || !initial.userModeLabel.includes("Пользователь")) throw new Error(`Initial user mode exposes protected views or has an incorrect role label: ${JSON.stringify(initial)}`);
console.log("browser smoke: portable app initialized");
const errorDismissState = await evaluate(`(()=>{const banner=document.querySelector('#errorBanner');const message=banner.querySelector('span');message.textContent='Browser smoke: проверка закрытия';banner.hidden=false;banner.querySelector('[data-error-dismiss]').click();return{hidden:banner.hidden,message:message.textContent}})()`);
if (!errorDismissState.hidden || errorDismissState.message) throw new Error(`Кнопка ошибки не скрыла баннер и не очистила текст: ${JSON.stringify(errorDismissState)}`);
console.log("browser smoke: error banner dismiss button hides the banner and clears stale text");

const smokeEngineerPassword = `Smoke-${crypto.randomUUID()}!`;
await evaluate(`document.querySelector('#engineeringModeButton').click()`);
await evaluate(`(()=>{
  document.querySelector('#engineeringSessionMinutes').value = '1440';
  document.querySelector('#engineeringPassword').value = ${JSON.stringify(smokeEngineerPassword)};
  document.querySelector('#engineeringPassword').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#engineeringPasswordConfirm').value = ${JSON.stringify(smokeEngineerPassword)};
  document.querySelector('#engineeringPasswordConfirm').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#engineeringModeForm').requestSubmit();
  return true;
})()`);
let engineerReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  engineerReady = await evaluate(`!document.querySelector('#engineeringModeDialog').open && document.querySelector('#engineeringModeButton').textContent.includes('Инженер')`);
  if (engineerReady) break;
}
if (!engineerReady) {
  const state = await evaluate(`({button:document.querySelector('#engineeringModeButton')?.textContent||"",dialogOpen:document.querySelector('#engineeringModeDialog')?.open,error:document.querySelector('#errorBanner span')?.textContent||"",status:document.querySelector('#engineeringModeStatus')?.textContent||"",passwordLength:document.querySelector('#engineeringPassword')?.value.length||0,confirmLength:document.querySelector('#engineeringPasswordConfirm')?.value.length||0,passwordValid:document.querySelector('#engineeringPassword')?.checkValidity(),confirmValid:document.querySelector('#engineeringPasswordConfirm')?.checkValidity(),submitDisabled:document.querySelector('#engineeringModeSubmit')?.disabled})`);
  throw new Error(`Не удалось пройти штатный первый вход в инженерный режим на disposable базе: ${JSON.stringify(state)}`);
}
console.log("browser smoke: disposable engineer session created through UI");

if (process.argv.includes("--optional-host-oui-reference-only")) {
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  let controlState = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    controlState = await evaluate(`(()=>({visible:document.querySelector('#importOptionalHostOuiButton')?.hidden===false,disabled:document.querySelector('#importOptionalHostOuiButton')?.disabled===true,error:!document.querySelector('#errorBanner')?.hidden}))()`);
    if (controlState.visible) break;
  }
  if (!controlState?.visible || controlState.disabled || controlState.error) {
    throw new Error(`Optional-host OUI transfer control is not available: ${JSON.stringify(controlState)}`);
  }
  const databaseName = new URL(target.url).searchParams.get("db");
  await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(databaseName)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('oui','readwrite');const store=tx.objectStore('oui');store.put({prefix:'02EFA0',vendor:'Smoke custom vendor',source:'Пользовательский справочник'});store.put({prefix:'02EFA1',vendor:'Smoke learned vendor',source:'Обучено по локальной истории'});store.put({prefix:'02EFA2',vendor:'Smoke old host vendor',source:'Справочник optional host'});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  await evaluate(`document.querySelector('#importOptionalHostOuiButton').click()`);
  let status = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(50);
    status = await evaluate(`document.querySelector('#optionalHostOuiImportStatus')?.textContent||''`);
    if (status.startsWith('Перенесено ')) break;
    const error = await evaluate(`(()=>{const banner=document.querySelector('#errorBanner');return banner&&!banner.hidden?(banner.querySelector('span')?.textContent||'Import failed'):''})()`);
    if (error) throw new Error(`Optional-host OUI transfer UI failed: ${error}`);
  }
  const records = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(databaseName)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('oui','readonly');const store=tx.objectStore('oui');const records={};for(const prefix of ['02EFA0','02EFA1','02EFA2','02EFA3']){const request=store.get(prefix);request.onsuccess=()=>records[prefix]=request.result||null}tx.oncomplete=()=>{db.close();resolve(records)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const expected = {
    "02EFA0": ["Smoke custom vendor", "Пользовательский справочник"],
    "02EFA1": ["Smoke learned vendor", "Обучено по локальной истории"],
    "02EFA2": ["Smoke host updated", "Справочник optional host"],
    "02EFA3": ["Smoke host added", "Справочник optional host"],
  };
  for (const [prefix, [vendor, source]] of Object.entries(expected)) {
    if (records[prefix]?.vendor !== vendor || records[prefix]?.source !== source) {
      throw new Error(`Optional-host OUI transfer changed the wrong source or missed a record: ${JSON.stringify({prefix,record:records[prefix],status})}`);
    }
  }
  if (!status.startsWith("Перенесено ") || !status.includes(" OUI-префиксов из 4.") || !status.includes("Существующие пользовательские и выученные правила сохранены")) {
    throw new Error(`Optional-host OUI transfer did not report completion: ${status}`);
  }
  console.log(JSON.stringify({ mode: "optional-host-oui-reference-only", status, records, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--legacy-observation-history-only")) {
  const seeded = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('legacyObservations','readwrite');const store=tx.objectStore('legacyObservations');for(let i=0;i<205;i++){const mac='00:11:22:33:44:'+String(i+1).padStart(2,'0');const source=i%2===0?'legacy-history-A.csv':'legacy-history-B.csv';const observedAt='2026-11-'+String(i%5+1).padStart(2,'0')+'T12:00:00.000Z';store.put({id:'smoke-legacy-'+String(i).padStart(3,'0'),kind:'mac_history',observedAt,mac,source,payload:{source_file:source,vendor:i%3===0?'Acme':'Contoso',model:i%2===0?'Codec A':'Codec B',room:i%4<2?'Room A':'Room B'}})}tx.oncomplete=()=>{db.close();resolve({database:name,rows:205})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  await evaluate(`document.querySelector('[data-view="history"]').click()`);
  const search = async (values = {}) => {
    const state = await evaluate(`(()=>{const form=document.querySelector('#legacyObservationFilters');for(const key of ['kind','mac','source','vendor','model','room','from','to'])form.elements.namedItem(key).value='';for(const [key,value] of Object.entries(${JSON.stringify(values)}))form.elements.namedItem(key).value=value;form.requestSubmit();return true})()`);
    if (!state) throw new Error("Legacy observation filter form did not submit");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(50);
      const result = await evaluate(`(()=>({status:document.querySelector('#legacyObservationStatus').textContent,rows:document.querySelectorAll('#legacyObservationResults tbody tr:not([data-virtual-spacer])').length,spacers:document.querySelectorAll('#legacyObservationResults tbody tr[data-virtual-spacer]').length,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
      if (result.error) throw new Error(`Legacy observation search failed: ${result.message}`);
      if (!result.status.includes("Загружаются импортированные")) return result;
    }
    throw new Error("Legacy observation search did not finish");
  };
  const all = await search({});
  if (!all.status.includes("205 записей") || !all.status.includes("показано 100") || !all.status.includes("MAC: 205") || !all.status.includes("производителей: 2") || !all.status.includes("моделей: 2") || !all.status.includes("помещений: 2") || !all.status.includes("источников: 2") || all.rows !== 20 || all.spacers !== 2) throw new Error(`Legacy observation full page totals, exact distinct summary, or virtual scroll are wrong: ${JSON.stringify(all)}`);
  await evaluate(`(()=>{const wrapper=document.querySelector('#legacyObservationResults .table-scroll');wrapper.scrollTop=wrapper.scrollHeight;wrapper.dispatchEvent(new Event('scroll'));return true})()`);
  let tailRows = [];
  for (let attempt = 0; attempt < 40; attempt += 1) { await wait(50); tailRows = await evaluate(`([...document.querySelectorAll('#legacyObservationResults tbody tr:not([data-virtual-spacer])')].map(row=>row.cells[7]?.textContent.trim()))`); if (tailRows.length === 20) break; }
  if (tailRows.length !== 20) throw new Error(`Virtual scroll did not render the next legacy-observation window: ${JSON.stringify(tailRows)}`);
  const second = await evaluate(`(()=>{document.querySelector('#legacyObservationNextButton').click();return true})()`);
  let pageTwo = null;
  for (let attempt = 0; attempt < 100; attempt += 1) { await wait(50); pageTwo = await evaluate(`(()=>({status:document.querySelector('#legacyObservationStatus').textContent,rows:document.querySelectorAll('#legacyObservationResults tbody tr:not([data-virtual-spacer])').length,spacers:document.querySelectorAll('#legacyObservationResults tbody tr[data-virtual-spacer]').length}))()`); if (pageTwo.status.includes("страница 2")) break; }
  if (!second || !pageTwo?.status.includes("205 записей") || !pageTwo.status.includes("страница 2") || !((pageTwo.rows === 100 && pageTwo.spacers === 0) || (pageTwo.rows === 20 && pageTwo.spacers === 2))) throw new Error(`Legacy observation next-page cursor failed: ${JSON.stringify(pageTwo)}`);
  await evaluate(`document.querySelector('#legacyObservationNextButton').click()`);
  let pageThree = null;
  for (let attempt = 0; attempt < 100; attempt += 1) { await wait(50); pageThree = await evaluate(`(()=>({status:document.querySelector('#legacyObservationStatus').textContent,rows:document.querySelectorAll('#legacyObservationResults tbody tr:not([data-virtual-spacer])').length,spacers:document.querySelectorAll('#legacyObservationResults tbody tr[data-virtual-spacer]').length}))()`); if (pageThree.status.includes("страница 3")) break; }
  if (!pageThree?.status.includes("205 записей") || !pageThree.status.includes("страница 3") || !pageThree.status.includes("показано 5") || pageThree.rows !== 5 || pageThree.spacers !== 0) throw new Error(`Legacy observation last-page cursor failed: ${JSON.stringify(pageThree)}`);
  await evaluate(`document.querySelector('#legacyObservationPreviousButton').click()`);
  let pageTwoAgain = null;
  for (let attempt = 0; attempt < 100; attempt += 1) { await wait(50); pageTwoAgain = await evaluate(`(()=>({status:document.querySelector('#legacyObservationStatus').textContent,rows:document.querySelectorAll('#legacyObservationResults tbody tr:not([data-virtual-spacer])').length,spacers:document.querySelectorAll('#legacyObservationResults tbody tr[data-virtual-spacer]').length}))()`); if (pageTwoAgain.status.includes("страница 2")) break; }
  if (!pageTwoAgain?.status.includes("страница 2") || !((pageTwoAgain.rows === 100 && pageTwoAgain.spacers === 0) || (pageTwoAgain.rows === 20 && pageTwoAgain.spacers === 2))) throw new Error(`Legacy observation reverse cursor from final page failed: ${JSON.stringify(pageTwoAgain)}`);
  await evaluate(`document.querySelector('#legacyObservationPreviousButton').click()`);
  let pageOneAgain = null;
  for (let attempt = 0; attempt < 100; attempt += 1) { await wait(50); pageOneAgain = await evaluate(`(()=>({status:document.querySelector('#legacyObservationStatus').textContent,rows:document.querySelectorAll('#legacyObservationResults tbody tr:not([data-virtual-spacer])').length,spacers:document.querySelectorAll('#legacyObservationResults tbody tr[data-virtual-spacer]').length}))()`); if (pageOneAgain.status.includes("страница 1")) break; }
  if (!pageOneAgain?.status.includes("страница 1") || !((pageOneAgain.rows === 100 && pageOneAgain.spacers === 0) || (pageOneAgain.rows === 20 && pageOneAgain.spacers === 2))) throw new Error(`Legacy observation previous-page cursor failed: ${JSON.stringify(pageOneAgain)}`);
  const filtered = await search({kind:"mac_history",mac:"00:11:22:33:44:03",source:"legacy-history-A.csv",vendor:"Contoso",model:"Codec A",room:"Room B",from:"2026-11-03",to:"2026-11-03"});
  if (!filtered.status.includes("1 записей") || filtered.rows !== 1 || !filtered.status.includes("MAC: 1")) throw new Error(`Combined kind/MAC/source/vendor/model/room/date filters failed: ${JSON.stringify(filtered)}`);
  await evaluate(`(()=>{const row=document.querySelector('#legacyObservationResults [data-legacy-observation-select="smoke-legacy-002"]');if(!row)throw new Error('Expected legacy observation checkbox is missing');row.checked=true;row.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const selectedReady = await evaluate(`!document.querySelector('#deleteLegacyObservationsButton').disabled`);
  if (!selectedReady) throw new Error("Selecting a legacy observation did not enable selected deletion");
  await evaluate(`window.confirm=()=>true;document.querySelector('#deleteLegacyObservationsButton').click()`);
  let selectedDeleted = null;
  for (let attempt = 0; attempt < 100; attempt += 1) { await wait(50); selectedDeleted = await evaluate(`(()=>({status:document.querySelector('#legacyObservationStatus').textContent,rows:document.querySelectorAll('#legacyObservationResults tbody tr:not([data-virtual-spacer])').length}))()`); if (selectedDeleted.status.includes("удалено записей: 1")) break; }
  if (!selectedDeleted?.status.includes("удалено записей: 1") || !selectedDeleted.status.includes("0 записей") || selectedDeleted.rows !== 0) throw new Error(`Selected legacy observation deletion failed: ${JSON.stringify(selectedDeleted)}`);
  const beforeFilteredDelete = await search({source:"legacy-history-B.csv"});
  if (!beforeFilteredDelete.status.includes("102 записей") || !beforeFilteredDelete.status.includes("показано 100") || !beforeFilteredDelete.status.includes("источников: 1")) throw new Error(`Filtered legacy observation count/paging before delete is wrong: ${JSON.stringify(beforeFilteredDelete)}`);
  await evaluate(`window.confirm=()=>true;document.querySelector('#deleteFilteredLegacyObservationsButton').click()`);
  let filteredDeleted = null;
  for (let attempt = 0; attempt < 120; attempt += 1) { await wait(50); filteredDeleted = await evaluate(`(()=>({status:document.querySelector('#legacyObservationStatus').textContent,rows:document.querySelectorAll('#legacyObservationResults tbody tr:not([data-virtual-spacer])').length,filteredDisabled:document.querySelector('#deleteFilteredLegacyObservationsButton').disabled}))()`); if (filteredDeleted.status.includes("удалено записей: 102")) break; }
  if (!filteredDeleted?.status.includes("удалено записей: 102") || !filteredDeleted.status.includes("0 записей") || filteredDeleted.rows !== 0 || !filteredDeleted.filteredDisabled) throw new Error(`Filtered legacy observation deletion failed: ${JSON.stringify(filteredDeleted)}`);
  const remaining = await search({});
  if (!remaining.status.includes("102 записей") || !remaining.status.includes("показано 100") || !((remaining.rows === 100 && remaining.spacers === 0) || (remaining.rows === 20 && remaining.spacers === 2)) || !remaining.status.includes("MAC: 102") || !remaining.status.includes("источников: 1")) throw new Error(`Legacy observation rows other than the selected and filtered records were not preserved: ${JSON.stringify(remaining)}`);
  console.log("browser smoke: legacy imported-observation filters, exact distinct summaries, 100-row paging, selected delete, filtered delete, and remaining-record reconciliation passed");
  console.log(JSON.stringify({ seeded, all, pageTwo, pageThree, pageTwoAgain, pageOneAgain, filtered, selectedDeleted, beforeFilteredDelete, filteredDeleted, remaining, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--dashboard-history-signs-only")) {
  await evaluate(`(()=>{const Original=window.Chart;if(typeof Original!=="function")throw new Error("Chart.js is unavailable");window.__smokeChartConfigs=[];window.Chart=new Proxy(Original,{construct(target,args,newTarget){const config=args[1];if(config?.data?.datasets)window.__smokeChartConfigs.push({canvasId:args[0]?.canvas?.id||"",labels:[...config.data.labels],datasets:config.data.datasets.map(dataset=>({label:dataset.label,data:[...dataset.data]}))});return Reflect.construct(target,args,newTarget)}})})()`);
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  const runFinal=async({name,rows,count})=>{
    await assignInput("#mainFileInput",name,`MAC;Device ID;Model\n${rows.join("\n")}`);
    for(const [field,index] of [["mac",0],["deviceId",1],["model",2]]){
      const selected=await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main ${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
      if(selected!==String(index))throw new Error(`Main ${field} mapping failed for ${name}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
    let status="";
    for(let attempt=0;attempt<160;attempt+=1){
      await wait(100);
      const state=await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
      if(state.error)throw new Error(`History trend Final ${count} failed: ${state.message}`);
      status=state.status;
      if(status.includes(`${count} Final`))break;
    }
    if(!status.includes(`${count} Final`))throw new Error(`History trend Final ${count} did not commit: ${status}`);
    const activeCount=await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const deviceCount=chunks.result.filter(chunk=>chunk.snapshotId===active.result?.value).reduce((total,chunk)=>total+(chunk.devices||[]).length,0);db.close();resolve(deviceCount)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if(activeCount!==rows.length)throw new Error(`History trend Final ${count} stored ${activeCount} rows instead of ${rows.length}`);
  };
  const row=(suffix,id,model)=>`02:70:00:00:00:${suffix};${id};${model}`;
  await runFinal({name:"history_first.csv",rows:[row("01","HISTORY-A","Model A"),row("02","HISTORY-B","Model B")],count:1});
  await runFinal({name:"history_second.csv",rows:[row("01","HISTORY-A","Model A"),row("02","HISTORY-B","Model B"),row("03","HISTORY-C","Model C")],count:2});
  await runFinal({name:"history_third.csv",rows:[row("01","HISTORY-A","Model A"),row("03","HISTORY-C","Model C"),row("04","HISTORY-D","Model D")],count:3});
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let state=null;
  for(let attempt=0;attempt<300;attempt+=1){
    await wait(100);
    state=await evaluate(`(()=>({loading:!document.querySelector('#analyticsLoadingStatus').hidden,history:[...document.querySelectorAll('#analyticsHistoryKpis .kpi')].map(item=>({label:item.querySelector('span')?.textContent.trim()||'',value:item.querySelector('strong')?.textContent.trim()||''})),presenceTitle:document.querySelector('#presenceChart')?.title||'',configs:window.__smokeChartConfigs||[],error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if(state.error)throw new Error(`Dashboard history trends failed: ${state.message}`);
    if(!state.loading&&state.history.length===3&&state.configs.some(item=>item.canvasId==='presenceChart')&&state.configs.some(item=>item.canvasId==='totalChart'))break;
  }
  const presence=state.configs.find(item=>item.canvasId==='presenceChart');
  const totals=state.configs.find(item=>item.canvasId==='totalChart');
  const added=presence?.datasets.find(item=>item.label==='Добавлено')?.data;
  const absent=presence?.datasets.find(item=>item.label==='Отсутствовало')?.data;
  if(state.loading||state.history.find(item=>item.label==='Final в истории')?.value!=='3'||state.history.find(item=>item.label==='Устройств во всех Final')?.value!=='8'
    ||presence?.labels.length!==2||presence.labels.some(label=>label.includes('history_first'))
    ||JSON.stringify(added)!==JSON.stringify([1,1])||JSON.stringify(absent)!==JSON.stringify([0,-1])
    ||JSON.stringify(totals?.labels)!==JSON.stringify(['Final history_first.csv','Final history_second.csv','Final history_third.csv'])
    ||JSON.stringify(totals?.datasets?.[0]?.data)!==JSON.stringify([2,3,3])
    ||!state.presenceTitle.includes('Final history_second.csv: добавлено 1, отсутствовало 0')
    ||!state.presenceTitle.includes('Final history_third.csv: добавлено 1, отсутствовало 1'))throw new Error(`Final history trend axes, signs, or full snapshot sequence are incorrect: ${JSON.stringify({state,presence,totals,added,absent})}`);
  console.log(JSON.stringify({dashboardHistorySignsOnly:true,history:state.history,presence,totals,presenceTitle:state.presenceTitle,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--search-doubleclick-only")) {
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  await evaluate(`(()=>{document.querySelector('#mac5ModelPrefix').value='02400000';document.querySelector('#mac5ModelName').value='Context Model B';document.querySelector('#mac5ModelForm').requestSubmit();return true})()`);
  let ruleSaved = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(50);
    const status = await evaluate(`document.querySelector('#progressDetail')?.textContent||''`);
    if (status.includes('сохран')) { ruleSaved = true; break; }
  }
  if (!ruleSaved) throw new Error('The model-prefix UI did not save the disposable rule');
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await assignInput("#mainFileInput", "search-doubleclick-smoke.csv", "MAC;Device ID;Model\n02:40:00:00:00:01;CONTEXT-MAC-1;Context Model A\n;CONTEXT-MODEL-2;Context Model B\n02:40:00:00:00:02;CONTEXT-MAC-2;Context Model B");
  for (const [field,index] of [["mac",0],["deviceId",1],["model",2]]) {
    const selected=await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main ${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    if(selected!==String(index))throw new Error(`Main ${field} mapping did not apply: ${selected}`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let finalStatus="";
  for(let attempt=0;attempt<160;attempt+=1){
    await wait(100);
    const current=await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if(current.error)throw new Error(`Search double-click fixture failed: ${current.message}`);
    finalStatus=current.status;
    if(finalStatus.includes('1 Final')&&finalStatus.includes('2 устройств'))break;
  }
  if(!finalStatus.includes('3 устройств'))throw new Error(`Search double-click fixture did not save three strong-identity devices: ${finalStatus}`);
  const stored=await evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const devices=chunks.result.filter(chunk=>chunk.snapshotId===active.result?.value).flatMap(chunk=>chunk.devices||[]);db.close();resolve(devices.map(({mac,deviceId,model})=>({mac,deviceId,model}))) };tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if(stored.length!==3||!stored.some(item=>item.deviceId==='CONTEXT-MODEL-2'&&!item.mac&&item.model==='Context Model B'))throw new Error(`The model-only row did not retain strong Device ID identity: ${JSON.stringify(stored)}`);
  await evaluate(`document.querySelector('[data-view="search"]').click()`);
  const macRow=await evaluate(`(()=>[...document.querySelectorAll('#deviceTable tbody tr[data-device-id]')].find(row=>row.textContent.includes('Context Model A'))?.dataset.deviceId||'')()`);
  if(!macRow)throw new Error('Search results did not render the MAC-identified fixture row');
  await evaluate(`document.querySelector('#deviceTable tbody tr[data-device-id="${macRow}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  let macChoice=null;
  for(let attempt=0;attempt<80;attempt+=1){await wait(50);macChoice=await evaluate(`(()=>({open:document.querySelector('#detailsDialog')?.open,title:document.querySelector('#detailsDialog [data-dialog-title]')?.textContent||'',history:Boolean(document.querySelector('[data-search-result-action="history"]')),analytics:Boolean(document.querySelector('[data-search-result-action="analytics"]'))}))()`);if(macChoice.open)break;}
  if(!macChoice?.open||!macChoice.title.includes('Выбор действия')||!macChoice.history||!macChoice.analytics)throw new Error(`Double-click on a MAC result did not offer history and device analytics: ${JSON.stringify(macChoice)}`);
  await evaluate(`document.querySelector('[data-search-result-action="history"]').click()`);
  let history=null;
  for(let attempt=0;attempt<100;attempt+=1){await wait(50);history=await evaluate(`({active:document.querySelector('#historyView')?.classList.contains('active'),mac:document.querySelector('#macHistorySearch')?.value||'',error:!document.querySelector('#errorBanner').hidden})`);if(history.active&&history.mac)break;}
  if(!history?.active||history.mac!=='02:40:00:00:00:01'||history.error)throw new Error(`MAC double-click history action did not navigate to the selected device: ${JSON.stringify(history)}`);
  await evaluate(`document.querySelector('[data-view="search"]').click()`);
  const modelRow=await evaluate(`(()=>[...document.querySelectorAll('#deviceTable tbody tr[data-device-id]')].find(row=>row.textContent.includes('Context Model B'))?.dataset.deviceId||'')()`);
  if(!modelRow)throw new Error('Search results did not render the model-only fixture row');
  await evaluate(`document.querySelector('#deviceTable tbody tr[data-device-id="${modelRow}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  let modelDialog=null;
  for(let attempt=0;attempt<120;attempt+=1){await wait(50);modelDialog=await evaluate(`({open:document.querySelector('#detailsDialog')?.open,title:document.querySelector('#detailsDialog [data-dialog-title]')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);if(modelDialog.open)break;}
  if(!modelDialog?.open||!modelDialog.title.includes('Префиксы MAC для модели Context Model B')||modelDialog.error)throw new Error(`Double-click on a model-only result did not open MAC-prefix analytics: ${JSON.stringify(modelDialog)}`);
  let prefixAnalytics = null;
  for(let attempt=0;attempt<80;attempt+=1){await wait(50);prefixAnalytics=await evaluate(`(()=>({headers:[...document.querySelectorAll('#detailsDialog [data-dialog-content] table thead th')].map(cell=>cell.textContent.trim()),rows:[...document.querySelectorAll('#detailsDialog [data-dialog-content] table tbody tr')].map(row=>[...row.cells].map(cell=>cell.textContent.trim()))}))()`);if(prefixAnalytics.rows.length)break;}
  const expectedPrefixRow=['02400000','02:40:00:00','Context Model B','Пользовательское правило','2'];
  if(prefixAnalytics.headers.length!==5||JSON.stringify(prefixAnalytics.rows[0])!==JSON.stringify(expectedPrefixRow))throw new Error(`Model-prefix dialog did not show the complete formatted/source/occurrence row: ${JSON.stringify(prefixAnalytics)}`);
  const searchPrefix = async (query) => {
    await evaluate(`document.querySelector('#detailsDialog').close();document.querySelector('[data-view="data"]').click();document.querySelector('#modelPrefixSearch').value=${JSON.stringify(query)};document.querySelector('#modelPrefixSearchForm').requestSubmit()`);
    let result=null;
    for(let attempt=0;attempt<100;attempt+=1){await wait(50);result=await evaluate(`(()=>({title:document.querySelector('#detailsDialog [data-dialog-title]')?.textContent||'',rows:[...document.querySelectorAll('#detailsDialog [data-dialog-content] table tbody tr')].map(row=>[...row.cells].map(cell=>cell.textContent.trim()))}))()`);if(result.rows.length)break;}
    if(result.title!==`Префиксы MAC для модели ${query}`||JSON.stringify(result.rows[0])!==JSON.stringify(expectedPrefixRow))throw new Error(`Exact/partial model-prefix search ${query} returned a different rule: ${JSON.stringify(result)}`);
    return result;
  };
  const partialSearch = await searchPrefix('Context Model');
  const exactSearch = await searchPrefix('Context Model B');
  console.log(JSON.stringify({searchDoubleClickOnly:true,stored,macChoice,history,modelDialog,prefixAnalytics,partialSearch,exactSearch,ruleSaved,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--dashboard-summary-parity-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await assignInput("#mainFileInput", "dashboard-summary-parity-main.csv", "MAC;Device ID;Производитель;Модель\n02:60:00:00:00:01;SUMMARY-1;Acme;Room Bar\n02:60:00:00:00:02;SUMMARY-2;Acme;Room Bar\n02:60:00:00:00:03;SUMMARY-3;Acme;Touch Panel\n02:60:00:00:00:04;SUMMARY-4;Logitech;Rally Bar\n02:60:00:00:00:05;SUMMARY-5;Logitech;Rally Bar");
  await assignInput("#smartroomFileInput", "dashboard-summary-parity-smartroom.csv", "MAC;Smartroom ID;Название комнаты\n02:60:00:00:00:01;SUMMARY-R1;Room Alpha\n02:60:00:00:00:02;SUMMARY-R2;Room Alpha\n02:60:00:00:00:03;SUMMARY-R3;Room Beta");
  const setMapping = async (role, field, column) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="${role}"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing ${role}.${field} mapping');select.value=${JSON.stringify(String(column))};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  for (const [field, column] of [["mac",0],["deviceId",1],["manufacturer",2],["model",3]]) await setMapping("main",field,column);
  for (const [field, column] of [["mac",0],["smartroomId",1],["room",2]]) await setMapping("smartroom",field,column);
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let finalReady=false;
  for(let attempt=0;attempt<120;attempt+=1){
    await wait(100);
    const state=await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if(state.error)throw new Error(`Dashboard summary fixture failed: ${state.message}`);
    if(state.status.includes('1 Final')&&state.status.includes('5 устройств')){finalReady=true;break}
  }
  if(!finalReady)throw new Error('Dashboard summary fixture did not save all five devices');
   const databaseName = new URL(target.url).searchParams.get("db");
   await evaluate(`history.replaceState(null,"",location.pathname+location.search+"#analytics")`);
   const restored = await reloadDatabaseAndWait(databaseName);
   if (restored.db !== databaseName || !restored.status.includes("1 Final") || await evaluate(`location.hash`) !== "#analytics") throw new Error(`Direct Analytics bootstrap did not restore the saved Final: ${JSON.stringify({ restored, hash: await evaluate(`location.hash`) })}`);
  let dashboard=null;
  for(let attempt=0;attempt<300;attempt+=1){
    await wait(100);
     dashboard=await evaluate(`(()=>{const ids=['pyqtVendorTopChart','pyqtRoomDistributionChart','pyqtVendorShareChart','pyqtFieldCoverageChart'];const charts=ids.map(id=>{const canvas=document.querySelector('#'+id);const chart=window.Chart?.getChart?.(canvas);return{id,type:chart?.config?.type||'',labels:[...(chart?.data?.labels||[])],data:[...(chart?.data?.datasets?.[0]?.data||[])],width:canvas?.width||0,height:canvas?.height||0,state:document.querySelector('[data-chart-state="'+id+'"]')?.textContent||''}});return{loading:!document.querySelector('#analyticsLoadingStatus').hidden,heading:document.querySelector('#changeTable h3')?.textContent||'',occupancy:document.querySelector('#roomOccupancyStatus')?.textContent||'',vendors:document.querySelector('#vendorRanking')?.textContent.replace(/\\s+/g,' ').trim()||'',models:document.querySelector('#modelRanking')?.textContent.replace(/\\s+/g,' ').trim()||'',chartTitles:ids.map(id=>document.querySelector('#'+id)?.closest('article')?.querySelector(id==='pyqtFieldCoverageChart'?'h4':'h3')?.textContent.trim()||''),charts,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
    if(dashboard.error)throw new Error(`Dashboard summary analytics failed: ${dashboard.message}`);
     if(!dashboard.loading&&dashboard.heading==='Все устройства'&&dashboard.charts.every(chart=>chart.type&&chart.labels.length&&chart.data.length))break;
  }
   const vendorTop=dashboard.charts.find(chart=>chart.id==='pyqtVendorTopChart');
   const roomDistribution=dashboard.charts.find(chart=>chart.id==='pyqtRoomDistributionChart');
   const vendorShare=dashboard.charts.find(chart=>chart.id==='pyqtVendorShareChart');
   const fieldCoverage=dashboard.charts.find(chart=>chart.id==='pyqtFieldCoverageChart');
   if(dashboard?.loading||dashboard?.heading!=='Все устройства'||!dashboard.occupancy.includes('без помещения 2')||!dashboard.vendors.includes('Acme')||!dashboard.vendors.includes('Logitech')||!dashboard.models.includes('Room Bar')||!dashboard.models.includes('Touch Panel')||!dashboard.models.includes('Rally Bar')
     ||JSON.stringify(dashboard.chartTitles)!==JSON.stringify(['Топ-10 производителей','Распределение по помещениям','Доля производителей','Заполненность полей устройств'])
     ||vendorTop?.type!=='pie'||!vendorTop.labels.includes('Acme')||!vendorTop.labels.includes('Logitech')
     ||roomDistribution?.type!=='bar'||!roomDistribution.labels.includes('Room Alpha')||!roomDistribution.labels.includes('Room Beta')
     ||vendorShare?.type!=='pie'||!vendorShare.labels.includes('Acme')||!vendorShare.labels.includes('Logitech')
     ||fieldCoverage?.type!=='bar'||JSON.stringify(fieldCoverage.labels)!==JSON.stringify(['Производитель','Модель','Адрес','IP','Помещение','IP коммутатора','Порт'])||JSON.stringify(fieldCoverage.data)!==JSON.stringify([100,100,0,0,60,0,0])
     ||JSON.stringify(vendorTop?.data)!==JSON.stringify([3,2])||JSON.stringify(roomDistribution?.data)!==JSON.stringify([2,1])||JSON.stringify(vendorShare?.data)!==JSON.stringify([3,2])
     ||dashboard.charts.some(chart=>chart.width<=0||chart.height<=0||chart.state))throw new Error(`Direct Analytics bootstrap did not render all four full-data PyQt charts: ${JSON.stringify({restored,dashboard})}`);
   console.log(JSON.stringify({dashboardSummaryParityOnly:true,directAnalyticsReload:true,dashboard,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--column-mapping-review-only")) {
  await evaluate(`document.querySelector('[data-view="single"]').click()`);
  const csv = [
    "Device ID;MAC Address;Host IP;Switch IP;Location;Device Type;Vendor Name",
    "DEVICE-REVIEW-1;00:11:22:33:44:81;192.0.2.10;10.0.0.1;Rack A;Catalyst 9200;Cisco",
    "DEVICE-REVIEW-2;00:11:22:33:44:82;192.0.2.11;10.0.0.1;Rack B;Catalyst 9300;Cisco",
  ].join("\n");
  await assignInput("#singleFileInput", "column-review-workflow.csv", csv);
  let initial = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(50);
    initial = await evaluate(`(()=>({disabled:document.querySelector('#runSingleAnalysisButton')?.disabled??true,status:document.querySelector('#singleFileStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (initial.error || await evaluate(`Boolean(document.querySelector('[data-open-single-mapping-review]'))`)) break;
  }
  if (initial?.error || !await evaluate(`Boolean(document.querySelector('[data-open-single-mapping-review]'))`)) throw new Error(`Single-file mapping review fixture did not load: ${JSON.stringify(initial)}`);
  const openReview = () => evaluate(`document.querySelector('[data-open-single-mapping-review]').click();Boolean(document.querySelector('#mappingReviewDialog').open)`);
  if (!await openReview()) throw new Error("Single-file mapping review dialog did not open");
  const review = await evaluate(`(()=>{
    const row=(field)=>{const select=document.querySelector('[data-review-field="'+field+'"]');return select?{text:select.closest('tr')?.textContent.replace(/\\s+/g,' ').trim()||'',value:select.value,options:[...select.options].map((option)=>option.value)}:null};
    return{summary:document.querySelector('#mappingReviewSummary')?.textContent||'',deviceId:row('deviceId'),mac:row('mac'),model:row('model'),deviceType:row('deviceType'),validation:document.querySelector('#mappingReviewValidation')?.textContent||'',applyDisabled:document.querySelector('#mappingReviewApply')?.disabled??true};
  })()`);
  if (!review.summary.includes("ограниченный образец") || !review.deviceId || !review.mac || !review.model || !review.deviceType
    || !review.model.text.includes("Catalyst 9200") || !review.model.text.includes("Причина:")
    || !review.model.text.includes("кандидат") || !review.model.text.includes("другие варианты")) {
    throw new Error(`Mapping review did not expose its confidence, reason, alternatives and sample evidence: ${JSON.stringify(review)}`);
  }
  const beforeCancel = await evaluate(`([...document.querySelectorAll('#singleMapping [data-single-mapping-field]')].map((select)=>[select.dataset.singleMappingField,select.value]))`);
  await evaluate(`document.querySelector('[data-mapping-review-close]').click()`);
  const afterCancel = await evaluate(`({open:document.querySelector('#mappingReviewDialog').open,mapping:[...document.querySelectorAll('#singleMapping [data-single-mapping-field]')].map((select)=>[select.dataset.singleMappingField,select.value])})`);
  if (afterCancel.open || JSON.stringify(beforeCancel) !== JSON.stringify(afterCancel.mapping)) throw new Error(`Cancelling review applied its draft: ${JSON.stringify({beforeCancel,afterCancel})}`);
  if (!await openReview()) throw new Error("Mapping review did not reopen after a non-mutating cancel");
  await evaluate(`document.querySelector('#mappingReviewClear').click()`);
  const cleared = await evaluate(`({disabled:document.querySelector('#mappingReviewApply').disabled,validation:document.querySelector('#mappingReviewValidation').textContent})`);
  if (!cleared.disabled || !cleared.validation.includes("Device ID") && !cleared.validation.includes("MAC")) throw new Error(`Review accepted a draft without strong identity: ${JSON.stringify(cleared)}`);
  await evaluate(`document.querySelector('#mappingReviewRecommendations').click()`);
  const recommended = await evaluate(`(()=>{const entries=[...document.querySelectorAll('#mappingReviewContent [data-review-field]')].map((select)=>[select.dataset.reviewField,select.value]).filter(([,value])=>value!=='');return{entries,strong:entries.some(([field])=>['id','deviceId','serial','mac','mac2'].includes(field)),unique:new Set(entries.map(([,value])=>value)).size===entries.length,disabled:document.querySelector('#mappingReviewApply').disabled}})()`);
  if (!recommended.strong || !recommended.unique || recommended.disabled || !recommended.entries.some(([field]) => field === "mac")) throw new Error(`Column recommendations violated required MAC, identity or uniqueness validation: ${JSON.stringify(recommended)}`);
  await evaluate(`document.querySelector('#mappingReviewForm').requestSubmit()`);
  const applied = await evaluate(`({open:document.querySelector('#mappingReviewDialog').open,disabled:document.querySelector('#runSingleAnalysisButton').disabled,mapping:Object.fromEntries([...document.querySelectorAll('#singleMapping [data-single-mapping-field]')].map((select)=>[select.dataset.singleMappingField,select.value]))})`);
  if (applied.open || applied.disabled || !Number.isInteger(Number(applied.mapping.deviceId)) || !Number.isInteger(Number(applied.mapping.mac))) throw new Error(`Reviewed MAC/strong-identity mapping did not apply: ${JSON.stringify(applied)}`);
  await evaluate(`document.querySelector('#runSingleAnalysisButton').click()`);
  let result = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(50);
    result = await evaluate(`(()=>{const host=document.querySelector('#singleAnalysisResult');const kpis=Object.fromEntries([...host.querySelectorAll('.kpi')].map((item)=>[item.querySelector('span')?.textContent.trim()||'',item.querySelector('strong')?.textContent.trim()||'']));return{kpis,text:host.textContent.replace(/\\s+/g,' ').trim(),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
    if (result.error || result.kpis["Уникальных устройств"] === "2") break;
  }
  if (result.error || result.kpis["Уникальных устройств"] !== "2" || result.kpis["Уникальных MAC"] !== "2" || result.kpis["Ошибки идентификации"] !== "0") throw new Error(`Reviewed mapping did not produce an exact two-device/two-MAC analysis: ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ columnMappingReviewOnly: true, evidence: { summary: review.summary, model: review.model.text }, cancelWasNonMutating: true, clearedIdentityWasRejected: true, recommendations: recommended, applied, kpis: result.kpis, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--identity-diagnostics-parity-only")) {
  await evaluate(`document.querySelector('[data-view="single"]').click()`);
  await assignInput("#singleFileInput", "identity-diagnostics-smoke.csv", "MAC;Device ID;Производитель;Модель;Название комнаты\nbad mac value;ID-VALID;Acme;Valid Model;Room A\nbad mac without id;;;;\n;;;;");
  let singleInput = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    singleInput = await evaluate(`(()=>({disabled:document.querySelector('#runSingleAnalysisButton')?.disabled||false,status:document.querySelector('#singleFileStatus')?.textContent||'',mapping:document.querySelector('#singleMapping')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (singleInput.error || !singleInput.disabled) break;
  }
  if (singleInput.error) throw new Error(`Single-file identity diagnostic input failed: ${JSON.stringify(singleInput)}`);
  if (singleInput.disabled) {
    await evaluate(`document.querySelector('[data-open-single-mapping-review]')?.click()`);
    const singleReviewReady = await evaluate(`Boolean(document.querySelector('#mappingReviewDialog')?.open)`);
    if (!singleReviewReady) throw new Error(`Ambiguous single-file columns did not open the mapping review: ${JSON.stringify(singleInput)}`);
    for (const [field,index] of [["mac",0],["deviceId",1],["manufacturer",2],["model",3],["room",4]]) {
      await evaluate(`(()=>{const select=document.querySelector('[data-review-field="${field}"]');if(!select)throw new Error('Missing single-file review field ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    }
    await evaluate(`document.querySelector('#mappingReviewForm').requestSubmit()`);
    singleInput = await evaluate(`(()=>({disabled:document.querySelector('#runSingleAnalysisButton')?.disabled||false,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
  }
  if (singleInput.error || singleInput.disabled) throw new Error(`Single-file identity diagnostic mapping was not ready: ${JSON.stringify(singleInput)}`);
  await evaluate(`document.querySelector('#runSingleAnalysisButton').click()`);
  let single = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    single = await evaluate(`(()=>{const host=document.querySelector('#singleAnalysisResult');const kpis=Object.fromEntries([...host.querySelectorAll('.kpi')].map(item=>[item.querySelector('span')?.textContent.trim()||'',item.querySelector('strong')?.textContent.trim()||'']));const headings=[...host.querySelectorAll('h3')];const invalidHeading=headings.find(item=>item.textContent.startsWith('Строки без сильного идентификатора'));const invalidMacHeading=headings.find(item=>item.textContent.startsWith('Некорректные MAC'));const rows=heading=>[...(heading?.nextElementSibling?.querySelectorAll('tbody tr')||[])].map(row=>[...row.cells].map(cell=>cell.textContent.trim()));return{kpis,invalidHeading:invalidHeading?.textContent||'',invalidRows:rows(invalidHeading),invalidMacHeading:invalidMacHeading?.textContent||'',invalidMacRows:rows(invalidMacHeading),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
    if (single.error) throw new Error(`Single-file identity diagnostics failed: ${single.message}`);
    if (single.kpis['Уникальных устройств'] === '1' && single.kpis['Ошибки идентификации'] === '1') break;
  }
  if (single.kpis['Уникальных устройств'] !== '1' || single.kpis['Ошибки идентификации'] !== '1' || single.kpis['Некорректные MAC'] !== '2'
    || !single.invalidHeading.includes('первые 1 из 1') || single.invalidRows.length !== 1 || single.invalidRows[0][0] !== '3' || single.invalidRows[0][1] !== 'bad mac without id'
    || !single.invalidRows[0][2] || !single.invalidRows[0][3] || !single.invalidMacHeading.includes('первые 2 из 2')
    || JSON.stringify(single.invalidMacRows.map(row=>[row[0],row[1]])) !== JSON.stringify([['2','bad mac value'],['3','bad mac without id']])) {
    throw new Error(`Single-file diagnostics did not exclude the blank row or preserve exact source rows: ${JSON.stringify(single)}`);
  }

  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await assignInput("#mainFileInput", "identity-diagnostics-main.csv", "MAC;Device ID;Производитель;Модель\nbad mac value;ID-VALID;Acme;Valid Model\nbad mac without id;;;\n;;;");
  await assignInput("#smartroomFileInput", "identity-diagnostics-smartroom.csv", "Device ID;Название комнаты;Модель\nID-VALID;Room A;Room Model\n;;\n;;");
  const chooseMapping = async (role, field, index) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="${role}"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing ${role}.${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  for (const [field,index] of [["mac",0],["deviceId",1],["manufacturer",2],["model",3]]) await chooseMapping("main",field,index);
  for (const [field,index] of [["deviceId",0],["room",1],["model",2]]) await chooseMapping("smartroom",field,index);
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let merged = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    merged = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const snapshot=snapshots.result.find(item=>item.id===active.result?.value);const devices=chunks.result.filter(item=>item.snapshotId===active.result?.value).flatMap(item=>item.devices||[]);db.close();resolve({status:document.querySelector('#databaseStatus')?.textContent||'',summary:document.querySelector('#enrichmentSummary')?.textContent.replace(/\\s+/g,' ').trim()||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',snapshot:snapshot?{deviceCount:snapshot.deviceCount}:null,devices:devices.map(({deviceId,manufacturer,model,room})=>({deviceId,manufacturer,model,room}))})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (merged.error) throw new Error(`Main/SmartRoom identity diagnostic merge failed: ${merged.message}`);
    if (merged.status.includes('1 Final') && merged.snapshot?.deviceCount === 1) break;
  }
  if (!merged?.status.includes('1 Final') || merged.snapshot?.deviceCount !== 1 || merged.devices.length !== 1 || merged.devices[0].deviceId !== 'ID-VALID'
    || merged.devices[0].manufacturer !== 'Acme' || merged.devices[0].room !== 'Room A' || !merged.summary.includes('некорректных: 1')) {
    throw new Error(`Main/SmartRoom merge counted a blank or identity-less row as a device or lost strong-identity diagnostics: ${JSON.stringify(merged)}`);
  }
  await assignInput("#mainFileInput", "identity-diagnostics-conflict-base.csv", "MAC;Device ID;Производитель;Модель\n00:11:22:33:44:65;ID-A;Acme;Baseline A\n00:11:22:33:44:67;ID-B;Acme;Baseline B");
  for (const [field,index] of [["mac",0],["deviceId",1],["manufacturer",2],["model",3]]) await chooseMapping("main",field,index);
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let baseFinalCount = 0;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    baseFinalCount = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('snapshots','readonly');const rows=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{db.close();resolve(rows.result.filter(item=>item.name?.startsWith('Final ')).length)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (baseFinalCount === 2) break;
  }
  if (baseFinalCount !== 2) throw new Error(`Could not create a valid-MAC baseline Final for strong-identity conflict: ${baseFinalCount}`);
  await assignInput("#mainFileInput", "identity-diagnostics-conflict-current.csv", "MAC;Device ID;Производитель;Модель\n00:11:22:33:44:65;ID-B;Acme;Baseline B");
  for (const [field,index] of [["mac",0],["deviceId",1],["manufacturer",2],["model",3]]) await chooseMapping("main",field,index);
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let finals = [];
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    finals = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('snapshots','readonly');const rows=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{db.close();resolve(rows.result.filter(item=>item.name?.startsWith('Final ')).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).map(({id,name,deviceCount})=>({id,name,deviceCount}))) };tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (finals.length === 3) break;
  }
  if (finals.length !== 3) throw new Error(`Third strong-identity conflict Final was not saved: ${JSON.stringify(finals)}`);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let selectedPair = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    selectedPair = await evaluate(`(()=>{const base=document.querySelector('#baseSnapshotSelect');const current=document.querySelector('#currentSnapshotSelect');const expectedBase=${JSON.stringify(finals[1].id)};const expectedCurrent=${JSON.stringify(finals[2].id)};if(![...base.options].some(option=>option.value===expectedBase)||![...current.options].some(option=>option.value===expectedCurrent))return{ready:false,baseOptions:base.options.length,currentOptions:current.options.length};base.value=expectedBase;current.value=expectedCurrent;base.dispatchEvent(new Event('change',{bubbles:true}));current.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#applyComparisonButton').click();return{ready:true,base:base.value,current:current.value}})()`);
    if (selectedPair.ready) break;
  }
  if (!selectedPair?.ready) throw new Error(`Analytics did not expose both conflict-test Finals: ${JSON.stringify(selectedPair)}`);
  await evaluate(`(()=>{const mode=document.querySelector('#changeReportModeSelect');mode.value='snapshots';mode.dispatchEvent(new Event('change',{bubbles:true}));return mode.value})()`);
  const conflictRows = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['snapshots','snapshotChunks'],'readonly');const snapshots=tx.objectStore('snapshots').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const read=id=>chunks.result.filter(item=>item.snapshotId===id).flatMap(item=>item.devices||[]);db.close();resolve({before:read(${JSON.stringify(selectedPair.base)}),after:read(${JSON.stringify(selectedPair.current)})})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const browserComparison = compareFinals(conflictRows.before, conflictRows.after);
  if (conflictRows.before.length !== 2 || conflictRows.after.length !== 1 || browserComparison.identityConflicts.length !== 1
    || browserComparison.addedCount !== 0 || browserComparison.absentCount !== 0 || browserComparison.modifiedDeviceCount !== 0 || browserComparison.unchangedCount !== 0) {
    throw new Error(`Persisted browser Final rows did not resolve to one identity diagnostic without status events: ${JSON.stringify({conflictRows,browserComparison})}`);
  }
  let conflictComparison = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(100);
    conflictComparison = await evaluate(`(()=>{const kpis=Object.fromEntries([...document.querySelectorAll('#analyticsKpis [data-kpi]')].map(item=>[item.dataset.kpi,item.querySelector('strong')?.textContent.trim()||'']));const text=document.querySelector('#changeTable')?.textContent.replace(/\s+/g,' ').trim()||'';return{kpis,text,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
    if (conflictComparison.error || conflictComparison.kpis.devices === "2 / 1") break;
  }
  if (conflictComparison.error || conflictComparison.kpis.devices !== "2 / 1"
    || conflictComparison.kpis.modified !== "0" || conflictComparison.kpis.absent !== "0" || conflictComparison.kpis.unchanged !== "0") {
    throw new Error(`Final identity conflict was counted as a change instead of diagnostics: ${JSON.stringify({finals,conflictComparison})}`);
  }
  console.log(JSON.stringify({identityDiagnosticsParityOnly:true,single,merged,finals,selectedPair,browserComparison:{identityConflicts:browserComparison.identityConflicts.length,added:browserComparison.addedCount,absent:browserComparison.absentCount,modified:browserComparison.modifiedDeviceCount,unchanged:browserComparison.unchangedCount},conflictComparison,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--identity-overflow-memory-only")) {
  const stressRows = 2_500;
  const sharedHostname = "overflow-shared-hostname";
  const memoryProfile = { samples: 0, peakUsedBytes: 0, peakStage: "" };
  const sampleHeap = async (stage) => {
    const usage = await command("Runtime.getHeapUsage");
    memoryProfile.samples += 1;
    if (usage.usedSize > memoryProfile.peakUsedBytes) {
      memoryProfile.peakUsedBytes = usage.usedSize;
      memoryProfile.peakStage = stage;
    }
    return usage.usedSize;
  };
  const readState = () => evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');let snapshot=null;active.onsuccess=()=>{if(active.result?.value)snapshot=tx.objectStore('snapshots').get(active.result.value)};const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value||'',deviceCount:snapshot?.result?.deviceCount||0,inventory:inventory.result,history:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const setMappings = async () => {
    for (const [field, index] of [["mac", 0], ["deviceId", 1], ["hostname", 2], ["manufacturer", 3], ["model", 4]]) {
      const selected = await evaluate(`(()=>{const control=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!control)throw new Error('Missing overflow ${field} mapping');control.value=${index};control.dispatchEvent(new Event('change',{bubbles:true}));return control.value})()`);
      if (selected !== String(index)) throw new Error(`Overflow ${field} mapping did not apply`);
    }
  };
  const waitMainReady = async (label) => {
    let state = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await wait(50);
      state = await evaluate(`(()=>({disabled:document.querySelector('#runEnrichmentButton')?.disabled!==false,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',status:document.querySelector('#mainFileStatus')?.textContent||''}))()`);
      if (state.error) throw new Error(`${label} preview failed: ${state.message}`);
      if (!state.disabled) return state;
    }
    throw new Error(`${label} did not become ready: ${JSON.stringify(state)}`);
  };
  const waitForFinal = async (predicate, label, attempts = 300) => {
    let value = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await wait(100);
      value = await readState();
      const error = await evaluate(`({visible:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
      if (error.visible) throw new Error(`${label}: ${error.message}`);
      if (predicate(value)) return value;
    }
    const ui = await evaluate(`(()=>({database:document.querySelector('#databaseStatus')?.textContent||'',summary:document.querySelector('#enrichmentSummary')?.innerText||'',mappings:Object.fromEntries([...document.querySelectorAll('[data-mapping-role="main"][data-mapping-field]')].map(control=>[control.dataset.mappingField,control.value])),preview:document.querySelector('#mainMapping')?.innerText||'',error:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    throw new Error(`${label}: ${JSON.stringify({value,ui})}`);
  };
  await sampleHeap("startup");
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  const baselineRows = Array.from({ length: stressRows }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(6, "0");
    const mac = `02:10:${suffix.slice(0, 2)}:${suffix.slice(2, 4)}:${suffix.slice(4, 6)}:01`;
    return `${mac};OVERFLOW-${String(index + 1).padStart(5, "0")};${sharedHostname};Overflow Vendor;Overflow Model`;
  });
  const baselineCsv = `MAC;Device ID;Hostname;Производитель;Модель\n${baselineRows.join("\n")}`;
  await assignInput("#mainFileInput", "identity-overflow-2500.csv", baselineCsv);
  await waitMainReady("The 2,500-row overflow baseline");
  await setMappings();
  if (!await evaluate(`!document.querySelector('#runEnrichmentButton').disabled`)) throw new Error("The 2,500-row baseline button became disabled after mapping");
  await sampleHeap("before 2500-row Main import");
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  const baseline = await waitForFinal((value) => value.deviceCount === stressRows, "The 2,500-row overflow baseline Final did not commit");
  const baselineHeap = await sampleHeap("after 2500-row Main import");
  if (!baseline.activeId || baseline.inventory !== stressRows) throw new Error(`Overflow baseline did not preserve all strong Device IDs: ${JSON.stringify(baseline)}`);

  const runFailedFinal = async (failureName, sourceMac, deviceId) => {
    const before = await readState();
    await assignInput("#mainFileInput", `identity-overflow-${failureName}.csv`, `MAC;Device ID;Hostname;Производитель;Модель\n${sourceMac};${deviceId};failure-${failureName};Failure Vendor;Failure Model`);
    await waitMainReady(`${failureName} failure fixture`);
    await setMappings();
    await evaluate(`(()=>{const original=IDBObjectStore.prototype.put;window.__identityOverflowFailure=${JSON.stringify(failureName)};IDBObjectStore.prototype.put=function(value,...args){if(this.name==='snapshotChunks'&&window.__identityOverflowFailure){const name=window.__identityOverflowFailure;window.__identityOverflowFailure='';IDBObjectStore.prototype.put=original;if(name==='OutOfMemoryError')throw Object.assign(new Error('Synthetic browser heap exhaustion'),{name});throw new DOMException('Synthetic browser DataClone failure',name)}return original.call(this,value,...args)}})()`);
    await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
    let failure = null;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await wait(100);
      failure = await evaluate(`(()=>({visible:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',status:document.querySelector('#databaseStatus')?.textContent||''}))()`);
      if (failure.visible && failure.message.includes(failureName)) break;
    }
    const expectedErrorText = failureName === "OutOfMemoryError" ? "Synthetic browser heap exhaustion" : failureName;
    if (!failure?.visible || !failure.message.includes(expectedErrorText)) throw new Error(`${failureName} was not reported by the Final UI: ${JSON.stringify(failure)}`);
    const after = await readState();
    if (after.activeId !== before.activeId || after.deviceCount !== before.deviceCount || after.inventory !== before.inventory || after.history !== before.history) {
      throw new Error(`${failureName} changed the previous successful Final, Inventory or History: ${JSON.stringify({before,after,failure})}`);
    }
    await evaluate(`document.querySelector('#errorBanner [data-error-dismiss]').click()`);
    const dismissed = await evaluate(`({hidden:document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (!dismissed.hidden || dismissed.message) throw new Error(`${failureName} banner did not close and clear its message: ${JSON.stringify(dismissed)}`);
    return { failure, before, after, dismissed };
  };
  const dataCloneFailure = await runFailedFinal("DataCloneError", "02:65:00:00:00:02", "OVERFLOW-DATACLONE");
  const outOfMemoryFailure = await runFailedFinal("OutOfMemoryError", "02:65:00:00:00:03", "OVERFLOW-OOM");
  const sharedMac = "02:65:00:00:00:01";
  const conflictBaselineCsv = [
    "MAC;Device ID;Hostname;Производитель;Модель",
    `${sharedMac};OVERFLOW-MAC-PRIMARY;overflow-primary;Synthetic Vendor;Synthetic Model`,
    `${sharedMac};OVERFLOW-MAC-ALT-1;overflow-alt-1;Synthetic Vendor;Synthetic Model`,
    `${sharedMac};OVERFLOW-MAC-ALT-2;overflow-alt-2;Synthetic Vendor;Synthetic Model`,
    `${sharedMac};OVERFLOW-MAC-ALT-3;overflow-alt-3;Synthetic Vendor;Synthetic Model`,
  ].join("\n");
  const beforeConflictBaseline = await readState();
  await assignInput("#mainFileInput", "identity-overflow-conflict-baseline.csv", conflictBaselineCsv);
  await waitMainReady("The duplicate-MAC conflict baseline");
  await setMappings();
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  const conflictBaseline = await waitForFinal((value) => value.activeId !== beforeConflictBaseline.activeId && value.deviceCount === 4, "The duplicate-MAC conflict baseline did not commit");
  let conflictSummaryReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    conflictSummaryReady = await evaluate(`(document.querySelector('#enrichmentSummary')?.innerText||'').includes('Main raw: 4')`);
    if (conflictSummaryReady) break;
    await wait(100);
  }
  if (!conflictSummaryReady) throw new Error("The duplicate-MAC conflict summary did not finish rendering after the Final commit");
  const conflictUi = await evaluate(`(()=>{const summary=document.querySelector('#enrichmentSummary');const details=summary?.querySelector('details.notice');if(details)details.open=true;const text=summary?.innerText||'';const diagnostic=[...summary.querySelectorAll('tr')].map(row=>row.innerText).filter(value=>value.includes('OVERFLOW-MAC-'));return{text,diagnosticRows:diagnostic,hasOverflowWarning:text.includes('список альтернатив ограничен'),hasShortenedMarker:text.includes('список сокращён'),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
  if (conflictBaseline.inventory !== stressRows + 4 || conflictBaseline.deviceCount !== 4 || conflictUi.error || !conflictUi.hasOverflowWarning || !conflictUi.hasShortenedMarker || !conflictUi.diagnosticRows.some((value) => value.includes("OVERFLOW-MAC-ALT-3"))) {
    throw new Error(`The real multi-entry Main identity conflict did not preserve and render its bounded overflow marker: ${JSON.stringify({conflictBaseline,conflictUi})}`);
  }
  const finalHeap = await sampleHeap("completed after two atomic write failures");
  console.log(JSON.stringify({identityOverflowMemoryOnly:true,stressRows,baseline:{deviceCount:baseline.deviceCount,inventory:baseline.inventory,activeId:baseline.activeId},failures:{dataCloneError:dataCloneFailure,outOfMemoryError:outOfMemoryFailure},conflict:{deviceCount:conflictBaseline.deviceCount,inventory:conflictBaseline.inventory,diagnostics:conflictUi.diagnosticRows,ui:conflictUi},heapProfile:{...memoryProfile,baselineHeapBytes:baselineHeap,finalHeapBytes:finalHeap,peakUsedMiB:Math.round(memoryProfile.peakUsedBytes/1_048_576)},ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--batch-all-formats-preview-only")) {
  await evaluate(`document.querySelector('[data-view="batch"]').click()`);
  const generated = await evaluate(`(()=>{
    if(!window.XLSX?.utils?.book_new||!window.XLSX?.write)throw new Error('Bundled XLSX runtime is unavailable');
    const formats=['csv','tsv','txt','json','xlsx','xlsm','xls'];
    const columns={
      main:{headers:['MAC','Device ID','Производитель','Модель'],row:['02:90:00:00:00:01','FORMAT-1','Acme','Panel']},
      smartroom:{headers:['MAC','Device ID','Название комнаты','Адрес локации','Smartroom ID локации','Модель'],row:['02:90:00:00:00:01','FORMAT-1','Room Alpha','Test Address','SR-FORMAT-1','Panel']},
      ddio:{headers:['Reservation MAC','Reservation IP','Lease MAC','Lease IP'],row:['02:90:00:00:00:01','192.168.0.1','02:90:00:00:00:01','192.168.0.2']}
    };
    const makeFile=(role,format,index)=>{
      const date='2026-11-'+String(index+1).padStart(2,'0');
      const name=role+'_'+date+'.'+format;
      const {headers,row}=columns[role];
      if(format==='csv'||format==='tsv'||format==='txt'){
        const separator=format==='tsv'?'\\t':';';
        return new File([headers.join(separator)+'\\n'+row.join(separator)],name,{type:'text/plain',lastModified:Date.parse(date+'T12:00:00Z')});
      }
      if(format==='json'){
        const record=Object.fromEntries(headers.map((header,column)=>[header,row[column]]));
        return new File([JSON.stringify({rows:[record]})],name,{type:'application/json',lastModified:Date.parse(date+'T12:00:00Z')});
      }
      const workbook=window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(workbook,window.XLSX.utils.aoa_to_sheet([headers,row]),'Devices');
      const bytes=window.XLSX.write(workbook,{bookType:format==='xls'?'biff8':'xlsx',type:'array'});
      return new File([bytes],name,{type:format==='xls'?'application/vnd.ms-excel':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',lastModified:Date.parse(date+'T12:00:00Z')});
    };
    const counts={};
    for(const role of ['main','smartroom','ddio']){
      const transfer=new DataTransfer();
      for(let index=0;index<formats.length;index+=1)transfer.items.add(makeFile(role,formats[index],index));
      const input=document.querySelector(role==='main'?'#batchMainInput':role==='smartroom'?'#batchSmartroomInput':'#batchDdIoInput');
      input.files=transfer.files;counts[role]=input.files.length;input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    const mode=document.querySelector('#batchPairingMode');mode.value='same-date';mode.dispatchEvent(new Event('change',{bubbles:true}));
    return{counts,formats};
  })()`);
  if (Object.values(generated.counts).some(count=>count!==7)) throw new Error(`The browser could not stage all seven supported formats for each import role: ${JSON.stringify(generated)}`);
  let staged=null;
  for(let attempt=0;attempt<120;attempt+=1){
    await wait(100);
    staged=await evaluate(`(()=>({counts:{main:document.querySelector('#batchMainStatus')?.textContent||'',smartroom:document.querySelector('#batchSmartroomStatus')?.textContent||'',ddio:document.querySelector('#batchDdIoStatus')?.textContent||''},error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if(staged.error)throw new Error(`Browser batch format selection failed: ${staged.message}`);
    if(Object.values(staged.counts).every(value=>value.includes('7 файлов')))break;
  }
  if(Object.values(staged.counts).some(value=>!value.includes('7 файлов')))throw new Error(`The batch UI did not retain all staged files: ${JSON.stringify(staged)}`);
  await evaluate(`document.querySelector('#previewBatchButton').click()`);
  let preview=null;
  for(let attempt=0;attempt<240;attempt+=1){
    await wait(100);
    preview=await evaluate(`(()=>({rows:[...document.querySelectorAll('#batchPreview tbody tr:not(.batch-details-row)')].map(row=>[...row.cells].map(cell=>cell.textContent.replace(/\\s+/g,' ').trim())),fileNames:[...document.querySelectorAll('#batchMainFiles .batch-source-file-name,#batchSmartroomFiles .batch-source-file-name,#batchDdIoFiles .batch-source-file-name')].map(item=>item.textContent.trim()),parsedFiles:[...document.querySelectorAll('#batchPreview .batch-mapping')].map(item=>({name:item.querySelector('h4')?.textContent.trim()||'',details:item.querySelector('p')?.textContent.trim()||''})),errors:[...document.querySelectorAll('#batchPreview .batch-validation.error')].map(item=>item.textContent.trim()),selectErrors:[...document.querySelectorAll('#batchPreview option')].filter(option=>option.textContent.includes('ОШИБКА')).map(option=>option.textContent),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if(preview.error)throw new Error(`Batch preflight parsing failed: ${preview.message}`);
    if(preview.rows.length===7&&preview.fileNames.length===21)break;
  }
  const previewFormats=[...new Set(preview.fileNames.map(name=>name.split('.').at(-1)))].sort();
  if(preview.rows.length!==7||preview.fileNames.length!==21||preview.parsedFiles.length!==21||preview.parsedFiles.some(item=>!item.details.startsWith('1 строка')&&!item.details.startsWith('1 строк ·'))||JSON.stringify(previewFormats)!==JSON.stringify(['csv','json','xls','xlsm','xlsx','tsv','txt'].sort())||preview.errors.length||preview.selectErrors.length)throw new Error(`All-format role files did not create seven error-free one-row preflight pairs: ${JSON.stringify({preview,previewFormats})}`);
  const mappings=await evaluate(`(()=>{
    const expected={main:{mac:0,deviceId:1,manufacturer:2,model:3},smartroom:{mac:0,deviceId:1,room:2,address:3,smartroomId:4,model:5},ddio:{reservationMac:0,reservationIp:1,leaseMac:2,leaseIp:3}};
    const changed={main:0,smartroom:0,ddio:0};
    for(const [role,fields]of Object.entries(expected))for(const select of document.querySelectorAll('[data-batch-entry-role="'+role+'"][data-batch-mapping-field]')){
      const field=select.dataset.batchMappingField;if(!(field in fields))continue;select.value=String(fields[field]);select.dispatchEvent(new Event('change',{bubbles:true}));changed[role]+=1;
    }
    for(const input of document.querySelectorAll('[data-batch-pair-reviewed]')){input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}))}
    return{changed,reviewed:[...document.querySelectorAll('[data-batch-pair-reviewed]')].filter(input=>input.checked).length,runDisabled:document.querySelector('#runBatchButton').disabled};
  })()`);
  if(mappings.changed.main!==28||mappings.changed.smartroom!==42||mappings.changed.ddio!==28||mappings.reviewed!==7||mappings.runDisabled)throw new Error(`Seven format-specific role mappings did not produce a runnable reviewed plan: ${JSON.stringify(mappings)}`);
  const plan=await evaluate(`(()=>({pairs:[...document.querySelectorAll('#batchPreview tbody tr:not(.batch-details-row)')].map(row=>{const cells=[...row.cells];const get=role=>{const select=row.querySelector('[data-batch-pair-source="'+role+'"]');return select?.selectedOptions?.[0]?.textContent.replace(/\\s+/g,' ').trim()||''};return{date:cells[2]?.textContent.trim()||'',main:cells[3]?.textContent.trim()||'',smartroom:get('smartroom'),ddio:get('ddio')}}),reviewed:[...document.querySelectorAll('[data-batch-pair-reviewed]')].filter(input=>input.checked).length,runDisabled:document.querySelector('#runBatchButton').disabled,error:!document.querySelector('#errorBanner').hidden}))()`);
  if(plan.pairs.length!==7||plan.pairs.some(pair=>!pair.main.endsWith('.csv')&&!pair.main.endsWith('.tsv')&&!pair.main.endsWith('.txt')&&!pair.main.endsWith('.json')&&!pair.main.endsWith('.xlsx')&&!pair.main.endsWith('.xlsm')&&!pair.main.endsWith('.xls')||!pair.smartroom.includes(pair.date)||!pair.ddio.includes(pair.date)))throw new Error(`The reviewed preflight did not pair all roles to the same date: ${JSON.stringify(plan)}`);
  console.log(JSON.stringify({batchAllFormatsPreviewOnly:true,generated,staged,plan,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--inventory-field-history-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  const runFinal = async ({ name, manufacturer, model, address, switchIp, expectedCount }) => {
    const row = `00:11:22:33:44:32;FIELD-HISTORY-432;${manufacturer};${model};${address};${switchIp}`;
    await assignInput("#mainFileInput", name, `MAC;Device ID;Производитель;Модель;Адрес;IP коммутатора\n${row}`);
    for (const [field, column] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3], ["address", 4], ["switchIp", 5]]) {
      const value = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${column};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
      if (value !== String(column)) throw new Error(`Main ${field} mapping did not apply for ${name}: ${value}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
    let status = "";
    for (let attempt = 0; attempt < 160; attempt += 1) {
      await wait(100);
      const current = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
      if (current.error) throw new Error(`Inventory field history Final ${expectedCount} failed: ${current.message}`);
      status = current.status;
      if (status.includes(`${expectedCount} Final`)) break;
    }
    if (!status.includes(`${expectedCount} Final`)) throw new Error(`Expected ${expectedCount} Finals after ${name}, got: ${status}`);
  };
  await runFinal({ name: "field-history-first.csv", manufacturer: "Acme", model: "Codec A", address: "Room A", switchIp: "10.0.0.1", expectedCount: 1 });
  await runFinal({ name: "field-history-second.csv", manufacturer: "Northwind", model: "", address: "Room B", switchIp: "10.0.0.2", expectedCount: 2 });
  await runFinal({ name: "field-history-third.csv", manufacturer: "", model: "Codec C", address: "", switchIp: "", expectedCount: 3 });
  const state = await evaluate(`(()=>new Promise((resolve,reject)=>{
    const dbName=new URL(location.href).searchParams.get('db');
    const opening=indexedDB.open(dbName);
    opening.onerror=()=>reject(opening.error);
    opening.onsuccess=()=>{
      const db=opening.result;
      const tx=db.transaction(['settings','snapshots','snapshotChunks','inventory'],'readonly');
      const active=tx.objectStore('settings').get('activeSnapshotId');
      const snapshots=tx.objectStore('snapshots').getAll();
      const chunks=tx.objectStore('snapshotChunks').getAll();
      const inventory=tx.objectStore('inventory').getAll();
      tx.oncomplete=()=>{
        const snapshot=snapshots.result.find(item=>item.id===active.result?.value);
        const devices=chunks.result.filter(chunk=>chunk.snapshotId===active.result?.value).flatMap(chunk=>chunk.devices||[]);
        db.close();
        resolve({activeId:active.result?.value,finalCount:snapshots.result.filter(item=>item.kind!=='single').length,snapshotName:snapshot?.name,finalDevice:devices.find(device=>device.mac==='00:11:22:33:44:32')||null,inventory:inventory.result.find(device=>device.mac==='00:11:22:33:44:32')||null});
      };
      tx.onerror=()=>{db.close();reject(tx.error)};
    };
  }))()`);
  const expected = { manufacturer: "Northwind", model: "Codec C", address: "Room B", switchIp: "10.0.0.2" };
  if (state.finalCount !== 3 || !state.activeId || !state.snapshotName?.includes("field-history-third.csv")
    || Object.entries(expected).some(([field, value]) => state.finalDevice?.[field] !== value || state.inventory?.[field] !== value)
    || state.inventory?.observationCount !== 3 || !state.inventory?.firstSeen || !state.inventory?.lastSeen
    || Date.parse(state.inventory.firstSeen) > Date.parse(state.inventory.lastSeen)) {
    throw new Error(`Three sequential browser Finals did not preserve exact Final and latest-known Inventory fields: ${JSON.stringify(state)}`);
  }
  console.log(JSON.stringify({inventoryFieldHistoryOnly:true,state,expected,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--inventory-column-manager-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  const longManufacturer = "Northwind Enterprise Collaboration Systems Operations Department ".repeat(2).trim();
  await assignInput("#mainFileInput", "inventory-column-manager.csv", [
    "MAC;Device ID;Производитель",
    "00:12:34:56:78:90;COLUMN-MANAGER-1;Acme",
    `00:12:34:56:78:91;COLUMN-MANAGER-2;${longManufacturer}`,
    "00:12:34:56:78:92;COLUMN-MANAGER-3;Example Devices",
  ].join("\n"));
  for (const [field, column] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2]]) {
    const value = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${column};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    if (value !== String(column)) throw new Error(`Main ${field} mapping did not apply for column manager smoke`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let finalStatus = "";
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    const current = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (current.error) throw new Error(`Column manager source Final failed: ${current.message}`);
    finalStatus = current.status;
    if (finalStatus.includes("1 Final") && finalStatus.includes("3 устройств")) break;
  }
  if (!finalStatus.includes("1 Final") || !finalStatus.includes("3 устройств")) throw new Error(`Column manager source Final was not persisted: ${finalStatus}`);
  await evaluate(`document.querySelector('[data-view="search"]').click()`);
  let roster = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    roster = await evaluate(`({rows:document.querySelectorAll('#deviceTable tbody tr[data-device-id]').length,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (roster.error) throw new Error(`Inventory did not render for column manager: ${roster.message}`);
    if (roster.rows === 3) break;
  }
  if (roster.rows !== 3) throw new Error(`Expected three Inventory rows for column manager smoke, got ${JSON.stringify(roster)}`);

  const readStored = async () => evaluate(`(()=>new Promise((resolve,reject)=>{
    const dbName=new URL(location.href).searchParams.get('db');
    const opening=indexedDB.open(dbName);
    opening.onerror=()=>reject(opening.error);
    opening.onsuccess=()=>{
      const db=opening.result;const tx=db.transaction(['settings','inventory'],'readonly');
      const setting=tx.objectStore('settings').get('inventoryColumnConfig');const devices=tx.objectStore('inventory').getAll();
      tx.oncomplete=()=>{db.close();resolve({config:setting.result?.value||null,devices:devices.result})};
      tx.onerror=()=>{db.close();reject(tx.error)};
    };
  }))()`);
  const openManager = async () => {
    await evaluate(`document.querySelector('#toggleInventoryColumnManager').click()`);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const open = await evaluate(`document.querySelector('#inventoryColumnManagerDialog').open`);
      if (open) return;
      await wait(50);
    }
    throw new Error("Inventory column manager did not open");
  };
  const saveManagerChange = async (selector, { value, checked } = {}) => {
    const changed = await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw new Error('Missing column manager control: '+${JSON.stringify(selector)});${typeof value === "string" ? `input.value=${JSON.stringify(value)};` : ""}${typeof checked === "boolean" ? `input.checked=${checked};` : ""}input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    if (!changed) throw new Error(`Could not change ${selector}`);
    await wait(100);
  };
  await openManager();
  await evaluate(`(()=>{const input=document.querySelector('#inventoryCustomColumnLabel');input.value='Audit Note';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#inventoryCustomColumnForm').requestSubmit()})()`);
  let stored = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(50);
    stored = await readStored();
    if (stored.config?.columns?.some(column => column.custom && column.label === 'Audit Note')) break;
  }
  const customColumn = stored.config?.columns?.find(column => column.custom && column.label === "Audit Note");
  if (!customColumn) throw new Error(`Custom Inventory column was not stored: ${JSON.stringify(stored.config)}`);
  const initialOrder = stored.config.columns.findIndex(column => column.key === customColumn.key);
  await saveManagerChange(`[data-column-label="${customColumn.key}"]`, { value: "Operator Notes" });
  await saveManagerChange(`[data-column-width="mac"]`, { value: "280" });
  await saveManagerChange(`[data-column-visible="manufacturer"]`, { checked: false });
  await evaluate(`document.querySelector('[data-column-move="${customColumn.key}"][data-direction="-1"]')?.click()`);
  await wait(100);
  await evaluate(`document.querySelector('[data-inventory-columns-close]').click()`);

  let rendered = await evaluate(`(()=>({headers:[...document.querySelectorAll('#deviceTable thead th')].map(cell=>cell.textContent.replace(/\\s+/g,' ').trim()),customInputs:document.querySelectorAll('#deviceTable [data-inventory-custom-field="${customColumn.key}"]').length,macResize:document.querySelector('[data-inventory-column-resize="mac"]')?.getAttribute('aria-valuenow')||''}))()`);
  if (rendered.headers.includes("Производитель") || !rendered.headers.some(header => header.startsWith("Operator Notes")) || rendered.customInputs !== 3 || rendered.macResize !== "280") {
    throw new Error(`Saved Inventory settings were not reflected in the table: ${JSON.stringify(rendered)}`);
  }
  const resized = await evaluate(`(()=>{const handle=document.querySelector('[data-inventory-column-resize="mac"]');handle.focus();handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return handle.getAttribute('aria-valuenow')})()`);
  await wait(100);
  stored = await readStored();
  const resizedConfig = stored.config?.columns?.find(column => column.key === "mac");
  if (resized !== "290" || resizedConfig?.width !== 290) throw new Error(`Keyboard column resizing was not persisted: ${JSON.stringify({resized,resizedConfig})}`);

  const noteValue = "Complete inventory review notes across the full stored device set ".repeat(2).trim();
  const savedCustomValue = await evaluate(`(()=>{const input=document.querySelector('#deviceTable tr[data-device-id] [data-inventory-custom-field="${customColumn.key}"]');if(!input)throw new Error('Custom field cell is missing');input.value=${JSON.stringify(noteValue)};input.dispatchEvent(new Event('change',{bubbles:true}));return input.value})()`);
  if (savedCustomValue !== noteValue) throw new Error("Custom Inventory cell did not accept its value");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(50);
    stored = await readStored();
    if (stored.devices.some(device => device.customFields?.[customColumn.key] === noteValue)) break;
  }
  if (!stored.devices.some(device => device.customFields?.[customColumn.key] === noteValue)) throw new Error("Custom Inventory value did not persist in its device record");

  await openManager();
  await evaluate(`document.querySelector('#optimizeInventoryColumnsButton').click()`);
  let optimizedStatus = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    optimizedStatus = await evaluate(`document.querySelector('#inventoryColumnStatus').textContent`);
    if (optimizedStatus.includes("Ширина рассчитана")) break;
  }
  stored = await readStored();
  const optimizedManufacturer = stored.config?.columns?.find(column => column.key === "manufacturer");
  const optimizedCustom = stored.config?.columns?.find(column => column.key === customColumn.key);
  const optimizedOrder = stored.config?.columns?.findIndex(column => column.key === customColumn.key);
  if (!optimizedStatus.includes("Ширина рассчитана") || optimizedManufacturer?.width !== 600 || optimizedCustom?.width !== 600 || optimizedOrder >= initialOrder) {
    throw new Error(`Full-catalog auto width or ordering was incorrect: ${JSON.stringify({optimizedStatus,optimizedManufacturer,optimizedCustom,initialOrder,optimizedOrder})}`);
  }

  await reloadDatabaseAndWait(new URL(target.url).searchParams.get("db"));
  stored = await readStored();
  const afterReload = stored.config?.columns?.find(column => column.key === customColumn.key);
  if (afterReload?.label !== "Operator Notes" || afterReload?.width !== 600 || !stored.devices.some(device => device.customFields?.[customColumn.key] === noteValue)) {
    throw new Error(`Column settings or custom values did not survive reload: ${JSON.stringify({afterReload,devices:stored.devices.map(device=>({mac:device.mac,customFields:device.customFields}))})}`);
  }
  await openManager();
  await evaluate(`document.querySelector('#resetInventoryColumnsButton').click()`);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(50);
    stored = await readStored();
    const resetCustom = stored.config?.columns?.find(column => column.key === customColumn.key);
    if (resetCustom && !resetCustom.visible) break;
  }
  const resetCustom = stored.config?.columns?.find(column => column.key === customColumn.key);
  if (!resetCustom || resetCustom.visible || !stored.devices.some(device => device.customFields?.[customColumn.key] === noteValue)) {
    throw new Error(`Reset should hide custom definitions without deleting their saved device values: ${JSON.stringify({resetCustom,devices:stored.devices.map(device=>device.customFields)})}`);
  }
  await evaluate(`document.querySelector('[data-column-remove="${customColumn.key}"]').click()`);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(50);
    stored = await readStored();
    if (!stored.config?.columns?.some(column => column.key === customColumn.key)) break;
  }
  if (stored.config?.columns?.some(column => column.key === customColumn.key) || !stored.devices.some(device => device.customFields?.[customColumn.key] === noteValue)) {
    throw new Error(`Removing a custom column must preserve stored device values: ${JSON.stringify(stored)}`);
  }
  console.log(JSON.stringify({inventoryColumnManagerOnly:true,finalStatus,roster,customColumn,resized,optimizedStatus,optimizedManufacturer,optimizedCustom,initialOrder,optimizedOrder,afterReload,resetCustom,preservedCustomValue:noteValue,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--device-analytics-appearances-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  const runFinal = async ({ name, manufacturer, model, ip, address, room, expectedCount }) => {
    const row = `00:22:33:44:55:76;DEVICE-ANALYTICS-476;${manufacturer};${model};${ip};${address};${room};SR-ANALYTICS-476`;
    await assignInput("#mainFileInput", name, `MAC;Device ID;Производитель;Модель;IP;Адрес;Помещение;Smartroom ID\n${row}`);
    for (const [field, column] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3], ["ip", 4], ["address", 5], ["room", 6], ["smartroomId", 7]]) {
      const value = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${column};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
      if (value !== String(column)) throw new Error(`Main ${field} mapping did not apply for ${name}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
    let status = "";
    for (let attempt = 0; attempt < 160; attempt += 1) {
      await wait(100);
      const current = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
      if (current.error) throw new Error(`Device analytics Final ${expectedCount} failed: ${current.message}`);
      status = current.status;
      if (status.includes(`${expectedCount} Final`)) break;
    }
    if (!status.includes(`${expectedCount} Final`)) throw new Error(`Expected ${expectedCount} Finals after ${name}, got: ${status}`);
  };
  await runFinal({ name: "device-analytics-first.csv", manufacturer: "Acme Devices", model: "Codec One", ip: "10.76.0.1", address: "Building A", room: "Room A", expectedCount: 1 });
  await runFinal({ name: "device-analytics-second.csv", manufacturer: "Contoso AV", model: "Codec Two", ip: "10.76.0.2", address: "Building B", room: "Room B", expectedCount: 2 });
  await runFinal({ name: "device-analytics-third.csv", manufacturer: "Northwind Media", model: "Codec Three", ip: "10.76.0.3", address: "Building C", room: "Room C", expectedCount: 3 });
  await evaluate(`document.querySelector('[data-view="search"]').click()`);
  let rowReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    rowReady = await evaluate(`Boolean(document.querySelector('#deviceTable tr[data-device-id]'))`);
    if (rowReady) break;
  }
  if (!rowReady) throw new Error("Inventory did not expose the device analytics fixture");
  await evaluate(`document.querySelector('#deviceTable tr[data-device-id]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  let actionReady = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(50);
    actionReady = await evaluate(`Boolean(document.querySelector('#detailsDialog [data-search-result-action="analytics"]'))`);
    if (actionReady) break;
  }
  if (!actionReady) throw new Error("Inventory double-click did not offer device analytics");
  await evaluate(`document.querySelector('#detailsDialog [data-search-result-action="analytics"]').click()`);
  let analytics = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    analytics = await evaluate(`(()=>{const dialog=document.querySelector('#detailsDialog');const tables=[...dialog.querySelectorAll('[data-dialog-content] table')];return{title:dialog.querySelector('[data-dialog-title]')?.textContent||'',open:dialog.open,appearanceHeaders:[...tables[0]?.querySelectorAll('thead th')||[]].map(cell=>cell.textContent.trim()),appearances:[...tables[0]?.querySelectorAll('tbody tr')||[]].map(row=>[...row.cells].map(cell=>cell.textContent.trim())),historyHeaders:[...tables[1]?.querySelectorAll('thead th')||[]].map(cell=>cell.textContent.trim()),historyRows:[...tables[1]?.querySelectorAll('tbody tr')||[]].map(row=>[...row.cells].map(cell=>cell.textContent.trim())),stats:[...dialog.querySelectorAll('[data-dialog-content] .kpi')].map(card=>({label:card.querySelector('span')?.textContent.trim()||'',value:card.querySelector('strong')?.textContent.trim()||''})),heading:dialog.querySelector('#deviceHistoryHeading')?.textContent||'',buttons:{html:Boolean(dialog.querySelector('[data-export-device-analytics]')),txt:Boolean(dialog.querySelector('[data-export-device-analytics-txt]')),xlsx:Boolean(dialog.querySelector('[data-export-device-analytics-xlsx]'))},error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
    if (analytics.error) throw new Error(`Device analytics UI failed: ${analytics.message}`);
    if (analytics.appearances?.length === 3 && analytics.historyRows?.length >= 2) break;
  }
  if (!analytics.open || !analytics.title.includes("00:22:33:44:55:76") || analytics.appearanceHeaders.length !== 8 || analytics.appearances.length !== 3
    || !analytics.appearances.some(row => row.includes("Northwind Media") && row.includes("Codec Three") && row.includes("Building C") && row.includes("Room C"))
    || analytics.historyHeaders.length !== 5 || analytics.historyRows.length < 2 || !analytics.historyRows.every(row => row[4].includes("Northwind Media") && row[4].includes("Codec Three") && row[4].includes("Building C") && row[4].includes("Room C")) || Number(analytics.stats.find(item => item.label === "Изменений")?.value) < 1
    || !analytics.heading.includes("Изменения параметров") || !analytics.buttons.html || !analytics.buttons.txt || !analytics.buttons.xlsx) {
    throw new Error(`Device analytics did not render exact appearances/history or reference exports: ${JSON.stringify(analytics)}`);
  }
  await evaluate(`(()=>{globalThis.__smokeAnalyticsDownloads=[];globalThis.showSaveFilePicker=undefined;const create=URL.createObjectURL.bind(URL);URL.createObjectURL=(blob)=>{if(blob instanceof Blob)globalThis.__smokeAnalyticsDownloads.push(blob);return create(blob)}})()`);
  const exports = [];
  for (const [selector, expected] of [["[data-export-device-analytics-txt]", "txt"], ["[data-export-device-analytics]", "html"], ["[data-export-device-analytics-xlsx]", "xlsx"]]) {
    const before = await evaluate(`globalThis.__smokeAnalyticsDownloads.length`);
    await evaluate(`document.querySelector('#detailsDialog ${selector}').click()`);
    let blobState = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(50);
      blobState = await evaluate(`(()=>{const blob=globalThis.__smokeAnalyticsDownloads[${before}];return blob?{type:blob.type,size:blob.size}:null})()`);
      if (blobState) break;
    }
    if (!blobState || blobState.size < 40) throw new Error(`Device analytics ${expected} export did not produce a nonempty file: ${JSON.stringify(blobState)}`);
    const content = expected === "xlsx"
      ? await evaluate(`(async()=>{const blob=globalThis.__smokeAnalyticsDownloads[${before}];const bytes=new Uint8Array(await blob.arrayBuffer());return{signature:[...bytes.slice(0,4)],size:bytes.length}})()`)
      : expected === "txt"
        ? await evaluate(`(async()=>{const blob=globalThis.__smokeAnalyticsDownloads[${before}];const bytes=new Uint8Array(await blob.arrayBuffer());return{prefix:[...bytes.slice(0,3)],text:new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes)}})()`)
      : await evaluate(`globalThis.__smokeAnalyticsDownloads[${before}].text()`);
    if (expected === "txt" && (content.prefix.join(",") !== "239,187,191" || !content.text.includes("Northwind Media") || !content.text.includes("Codec Three"))) throw new Error(`TXT export is missing UTF-8 BOM or latest device fields: ${JSON.stringify(content).slice(0,500)}`);
    if (expected === "html" && (!content.includes("История появлений</h2>") || !content.includes("Изменения параметров (") || !content.includes("Northwind Media"))) throw new Error(`HTML export is missing appearances or history: ${String(content).slice(0,500)}`);
    if (expected === "xlsx" && (content.signature.join(",") !== "80,75,3,4" || content.size !== blobState.size)) throw new Error(`XLSX export is not a ZIP workbook: ${JSON.stringify({content,blobState})}`);
    exports.push({kind:expected,...blobState,...(expected === "xlsx" ? {signature:content.signature} : expected === "txt" ? {prefix:content.prefix,verifiedLatestFields:true} : {verifiedLatestFields:true})});
  }
  await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['history','inventory'],'readwrite');const store=tx.objectStore('history');const inventoryCursor=tx.objectStore('inventory').openCursor();let deviceId='';inventoryCursor.onsuccess=()=>{const cursor=inventoryCursor.result;if(!cursor)return;const device=cursor.value;if(device.mac==='00:22:33:44:55:76')deviceId=String(device.id||device.deviceId||cursor.primaryKey);cursor.continue()};tx.oncomplete=()=>{if(!deviceId){db.close();reject(new Error('Inventory fixture was not found for global History'));return}const write=db.transaction('history','readwrite');const history=write.objectStore('history');for(let index=0;index<3;index+=1)history.add({timestamp:new Date(Date.now()-5000+index*1000).toISOString(),mac:index<2?'00:22:33:44:55:76':'00:22:33:44:55:77',...(index<2?{deviceId}:{}),type:'modified',field:'model',label:'Модель',oldValue:'old-'+index,newValue:'global-history-'+index,source:'History browser smoke.csv'});write.oncomplete=()=>{db.close();resolve(deviceId)};write.onerror=()=>{db.close();reject(write.error)}};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  await evaluate(`document.querySelector('[data-view="history"]').click()`);
  await wait(150);
  await evaluate(`(()=>{const form=document.querySelector('#historyLogFilters');form.elements.namedItem('source').value='History browser smoke';form.requestSubmit();return true})()`);
  let globalHistory = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    globalHistory = await evaluate(`(()=>({status:document.querySelector('#historyLogStatus')?.textContent||'',rows:document.querySelectorAll('#historyLogResults [data-history-event-row]').length,groups:document.querySelectorAll('#historyLogResults .history-log-group').length}))()`);
    if (globalHistory.rows === 3 && globalHistory.groups === 2) break;
  }
  if (globalHistory.rows !== 3 || globalHistory.groups !== 2 || !globalHistory.status.includes("3 событий")) throw new Error(`History did not group the complete source result by MAC: ${JSON.stringify(globalHistory)}`);
  await evaluate(`(()=>{const form=document.querySelector('#historyLogFilters');form.elements.namedItem('mac').value='00:22:33:44:55:76';form.requestSubmit();return true})()`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    globalHistory = await evaluate(`(()=>({status:document.querySelector('#historyLogStatus')?.textContent||'',rows:document.querySelectorAll('#historyLogResults [data-history-event-row]').length,groups:document.querySelectorAll('#historyLogResults .history-log-group').length}))()`);
    if (globalHistory.rows === 2 && globalHistory.groups === 1) break;
  }
  if (globalHistory.rows !== 2 || globalHistory.groups !== 1 || !globalHistory.status.includes("2 событий")) throw new Error(`History MAC/source filters did not return the exact two-event result: ${JSON.stringify(globalHistory)}`);
  await evaluate(`(()=>{const form=document.querySelector('#historyLogFilters');const now=new Date();const today=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');form.elements.namedItem('manufacturer').value='Northwind Media';form.elements.namedItem('model').value='Codec Three';form.elements.namedItem('room').value='Room C';form.elements.namedItem('from').value=today;form.elements.namedItem('fromTime').value='00:00:00';form.elements.namedItem('to').value=today;form.elements.namedItem('toTime').value='23:59:59';form.requestSubmit();return true})()`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    globalHistory = await evaluate(`(()=>({status:document.querySelector('#historyLogStatus')?.textContent||'',rows:document.querySelectorAll('#historyLogResults [data-history-event-row]').length,group:document.querySelector('#historyLogResults .history-log-group')}))()`);
    if (globalHistory.rows === 2 && globalHistory.status.includes('2 событий')) break;
  }
  if (globalHistory.rows !== 2 || !globalHistory.status.includes('2 событий')) throw new Error(`History vendor/model/room/date filters did not preserve exact matching rows: ${JSON.stringify(globalHistory)}`);
  await evaluate(`document.querySelector('#collapseHistoryLogGroupsButton').click()`);
  const collapsed = await evaluate(`!document.querySelector('#historyLogResults .history-log-group').open`);
  await evaluate(`document.querySelector('#expandHistoryLogGroupsButton').click()`);
  const expanded = await evaluate(`document.querySelector('#historyLogResults .history-log-group').open`);
  await evaluate(`(()=>{const checkbox=document.querySelector('#historyLogColumns [data-history-log-column][value="newValue"]');if(!checkbox)throw new Error('History newValue column control is missing');checkbox.checked=false;checkbox.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  let columnState = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    columnState = await evaluate(`({visible:document.querySelector('#historyLogResults thead [data-history-log-column-width="newValue"]')!==null})`);
    if (!columnState.visible) break;
  }
  const savedColumns = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('settings','readonly');const setting=tx.objectStore('settings').get('historyLogColumns');tx.oncomplete=()=>{db.close();resolve(setting.result?.value||null)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (!collapsed || !expanded || columnState.visible || !Array.isArray(savedColumns) || savedColumns.includes('newValue')) throw new Error(`History group collapse or persistent column visibility failed: ${JSON.stringify({collapsed,expanded,columnState,savedColumns})}`);
  await evaluate(`(()=>{window.confirm=()=>true;const checkbox=document.querySelector('#historyLogResults [data-history-event-select]');if(!checkbox)throw new Error('History event selection control is missing');checkbox.click();document.querySelector('#deleteHistoryEventsButton').click();return true})()`);
  let afterSelectedDelete = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    afterSelectedDelete = await evaluate(`({status:document.querySelector('#historyLogStatus')?.textContent||'',rows:document.querySelectorAll('#historyLogResults [data-history-event-row]').length})`);
    if (afterSelectedDelete.rows === 1 && afterSelectedDelete.status.includes('удалено событий: 1')) break;
  }
  if (afterSelectedDelete.rows !== 1 || !afterSelectedDelete.status.includes('удалено событий: 1')) throw new Error(`Selected History deletion did not remove exactly one event: ${JSON.stringify(afterSelectedDelete)}`);
  await evaluate(`document.querySelector('#deleteFilteredHistoryEventsButton').click()`);
  let afterFilteredDelete = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    afterFilteredDelete = await evaluate(`({status:document.querySelector('#historyLogStatus')?.textContent||'',rows:document.querySelectorAll('#historyLogResults [data-history-event-row]').length})`);
    if (afterFilteredDelete.rows === 0 && afterFilteredDelete.status.includes('удалено событий: 1')) break;
  }
  const preservedHistoryScope = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['snapshots','inventory','history'],'readonly');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({snapshots:snapshots.result,inventory:inventory.result,history:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (afterFilteredDelete.rows !== 0 || !afterFilteredDelete.status.includes('удалено событий: 1') || preservedHistoryScope.snapshots !== 3 || preservedHistoryScope.inventory !== 1 || preservedHistoryScope.history !== 12) throw new Error(`Filtered History deletion changed unrelated data or kept matching rows: ${JSON.stringify({afterFilteredDelete,preservedHistoryScope})}`);
  console.log(JSON.stringify({deviceAnalyticsAppearancesOnly:true,analytics,exports,globalHistory:{status:globalHistory.status,filteredRows:globalHistory.rows,macGroups:2,collapsed,expanded,savedColumns,afterSelectedDelete,afterFilteredDelete,preservedHistoryScope},ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--vendor-model-history-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  const runFinal = async ({ name, vendor, model, expectedCount, content }) => {
    const csv = content || `MAC;Device ID;Производитель;Модель\n00:22:33:44:55:8${expectedCount};VMH-484-DEVICE-${expectedCount};${vendor};${model}`;
    await assignInput("#mainFileInput", name, csv);
    for (const [field, index] of [["mac",0],["deviceId",1],["manufacturer",2],["model",3]]) {
      const selected = await evaluate(`(()=>{const input=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!input)throw new Error('Missing Main mapping ${field}');input.value=${index};input.dispatchEvent(new Event('change',{bubbles:true}));return input.value})()`);
      if (selected !== String(index)) throw new Error(`Could not select Main ${field} for ${name}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
    let status = "";
    for (let attempt = 0; attempt < 160; attempt += 1) {
      await wait(100);
      const state = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
      if (state.error) throw new Error(`Vendor/model history Final ${expectedCount} failed: ${state.message}`);
      status = state.status;
      if (status.includes(`${expectedCount} Final`)) break;
    }
    if (!status.includes(`${expectedCount} Final`)) throw new Error(`Expected ${expectedCount} Finals, got: ${status}`);
  };
  await runFinal({name:"vendor-model-history-first.csv",vendor:"Northwind Media",model:"Codec Three",expectedCount:1,content:"MAC;Device ID;Производитель;Модель\n02:FA:DE:B0:C0:01;VMH-484-DEVICE-1;Northwind Media;Codec Three"});
  await evaluate(`document.querySelector('[data-view="data"]').click();document.querySelector('#vendorInferenceEnabled').checked=false;document.querySelector('#saveVendorInferenceSettingsButton').click();document.querySelector('[data-view="enrichment"]').click()`);
  await runFinal({name:"vendor-model-history-second.csv",vendor:"Contoso AV",model:"Codec Four",expectedCount:2,content:"MAC;Device ID;Производитель;Модель\n02:FA:DE:B0:C0:01;VMH-484-DEVICE-1;Northwind Media;Codec Three\n02:BE:EF:00:00:02;VMH-484-DEVICE-2;Contoso AV;Codec Four\n02:FA:DE:B0:C0:99;VMH-484-LEARN-TARGET-99;;"});
  const learningBefore = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const history=tx.objectStore('history').count();let snapshot=null;active.onsuccess=()=>{if(active.result?.value)snapshot=tx.objectStore('snapshots').get(active.result.value)};tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value||'',createdAt:snapshot?.result?.createdAt||'',history:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  await evaluate(`document.querySelector('#vendorModelLearnMinCount').value='2';document.querySelector('#vendorModelLearnSource').value='';document.querySelector('#learnVendorModelButton').click()`);
  let learningStatus = '';
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await wait(100);
    learningStatus = await evaluate(`document.querySelector('#vendorModelLearnStatus')?.textContent||''`);
    if (learningStatus.includes('активный Final дополнен:')) break;
  }
  const learningAfter = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks','inventory','history','oui','mac5Models'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const history=tx.objectStore('history').count();const vendor=tx.objectStore('oui').get('02FADE');const model=tx.objectStore('mac5Models').get('02FADEB0C0');const chunks=tx.objectStore('snapshotChunks').getAll();const inventory=tx.objectStore('inventory').getAll();let metadata=null;active.onsuccess=()=>{if(active.result?.value){const request=tx.objectStore('snapshots').get(active.result.value);request.onsuccess=()=>{metadata=request.result||null};request.onerror=()=>reject(request.error)}};tx.oncomplete=()=>{const devices=chunks.result.filter((chunk)=>chunk.snapshotId===active.result?.value).flatMap((chunk)=>chunk.devices||[]);const target=devices.find((row)=>row.deviceId==='VMH-484-LEARN-TARGET-99');const inventoryTarget=inventory.result.find((row)=>row.id===target?.id);db.close();resolve({activeId:active.result?.value,createdAt:metadata?.createdAt||'',history:history.result,vendor:vendor.result||null,model:model.result||null,target:target||null,inventory:inventoryTarget||null})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (!learningStatus.includes('производителей 3, моделей 3') || !learningStatus.includes('добавлено: производителей 3, моделей 3')
    || !learningStatus.includes('активный Final дополнен: производителей 1, моделей 1')
    || learningAfter.activeId !== learningBefore.activeId || learningAfter.createdAt !== learningBefore.createdAt
    || learningAfter.history !== learningBefore.history || learningAfter.vendor?.vendor !== 'Northwind Media'
    || learningAfter.model?.model !== 'Codec Three' || learningAfter.target?.manufacturer !== 'Northwind Media'
    || learningAfter.target?.model !== 'Codec Three' || learningAfter.target?.fieldSources?.manufacturer !== 'Обучено по локальной истории'
    || learningAfter.target?.fieldSources?.model !== 'MAC rule 02FADEB0C0'
    || learningAfter.inventory?.manufacturer !== 'Northwind Media' || learningAfter.inventory?.model !== 'Codec Three') {
    throw new Error(`Learning did not save and apply bounded source-aware vendor/MAC5 rules atomically: ${JSON.stringify({learningStatus,learningBefore,learningAfter})}`);
  }
  const seededLoads = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('legacyObservations','readwrite');const store=tx.objectStore('legacyObservations');for(let index=1;index<=2;index+=1){const id='sqlite-history-loads-vmh-484-'+index;store.put({id,kind:'history_loads',observedAt:new Date(Date.now()-index*1000).toISOString(),payload:{id:String(index),filename:'history-load-smoke-'+index+'.csv',loadDate:new Date(Date.now()-index*1000).toISOString(),devicesCount:10+index,newVendorsAdded:index,newModelsAdded:index+1,enrichedFromHistory:index+2}})}store.put({id:'sqlite-vendor-history-vmh-484',kind:'mac_history',source:'Imported SQLite',observedAt:new Date(Date.now()-3000).toISOString(),payload:{macFormatted:'00:11:22:33:44:55',source_file:'legacy-vendor-model-smoke.csv',vendor:'Legacy Vendor',model:'Legacy Model'}});store.put({id:'sqlite-resolved-history-vmh-484',kind:'resolved_device_history',source:'Imported SQLite',observedAt:new Date(Date.now()-2000).toISOString(),payload:{decodedPayload:{mac_formatted:'00:11:22:33:44:66',source_file:'legacy-resolved-smoke.csv',manufacturer:'Resolved Vendor',device_model:'Resolved Model'}}});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (!seededLoads) throw new Error("Could not prepare the disposable imported-load and vendor/model observation fixtures");
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  await evaluate(`document.querySelector('#rebuildVendorModelHistoryButton').click()`);
  let status = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(50);
    status = await evaluate(`document.querySelector('#vendorModelHistoryStatus')?.textContent||''`);
    if (status.includes('2 Final · 2 импортированных наблюдений · 2 импортированных загрузок')) break;
  }
  if (!status.includes('2 Final · 2 импортированных наблюдений · 2 импортированных загрузок')) throw new Error(`Vendor/model history did not aggregate both Finals and imported observation/load rows: ${status}`);
  await evaluate(`(()=>{globalThis.__vmhDownloads=[];globalThis.showSaveFilePicker=undefined;const create=URL.createObjectURL.bind(URL);URL.createObjectURL=(blob)=>{if(blob instanceof Blob)globalThis.__vmhDownloads.push(blob);return create(blob)}})()`);
  const verifyExport = async ({kind,query,expected,expectedRows=1}) => {
    await evaluate(`(()=>{const form=document.querySelector('#vendorModelHistoryFilters');form.elements.namedItem('kind').value=${JSON.stringify(kind)};form.elements.namedItem('query').value=${JSON.stringify(query)};form.requestSubmit();return true})()`);
    let table = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(50);
      table = await evaluate(`({text:document.querySelector('#vendorModelHistoryTable')?.textContent||'',rows:document.querySelectorAll('#vendorModelHistoryTable tbody tr').length})`);
      if (table.rows === expectedRows && table.text.includes(expected)) break;
    }
    if (table.rows !== expectedRows || !table.text.includes(expected)) throw new Error(`Vendor/model ${kind} search did not find the expected matching rows: ${JSON.stringify({query,expected,expectedRows,table})}`);
    const before = await evaluate(`globalThis.__vmhDownloads.length`);
    await evaluate(`document.querySelector('#exportVendorModelHistoryButton').click()`);
    let blob = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(50);
      blob = await evaluate(`(()=>{const item=globalThis.__vmhDownloads[${before}];return item?{type:item.type,size:item.size}:null})()`);
      if (blob) break;
    }
    if (!blob || blob.size < 40) throw new Error(`Vendor/model ${kind} CSV export was empty: ${JSON.stringify(blob)}`);
    const content = await evaluate(`(async()=>{const bytes=new Uint8Array(await globalThis.__vmhDownloads[${before}].arrayBuffer());return{prefix:[...bytes.slice(0,3)],text:new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes)}})()`);
    if (content.prefix.join(',') !== '239,187,191' || !content.text.includes(expected)) throw new Error(`Vendor/model ${kind} CSV export missed BOM or matching row: ${content.text.slice(0,300)}`);
    return {kind,query,rows:table.rows,size:blob.size,prefix:content.prefix,verified:expected};
  };
  const vendorExport = await verifyExport({kind:'vendors',query:'Northwind Media',expected:'Northwind Media'});
  const modelExport = await verifyExport({kind:'models',query:'Codec Three',expected:'Codec Three',expectedRows:3});
  const loadExport = await verifyExport({kind:'loads',query:'history-load-smoke-1.csv',expected:'history-load-smoke-1.csv'});
  const verifyImportedObservation = async ({kind,query,expected}) => {
    await evaluate(`(()=>{const form=document.querySelector('#vendorModelHistoryFilters');form.elements.namedItem('kind').value=${JSON.stringify(kind)};form.elements.namedItem('query').value=${JSON.stringify(query)};form.requestSubmit();return true})()`);
    let result = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(50);
      result = await evaluate(`({text:document.querySelector('#vendorModelHistoryTable')?.textContent||'',rows:document.querySelectorAll('#vendorModelHistoryTable tbody tr').length})`);
      if (result.rows === 1 && result.text.includes(expected)) break;
    }
    if (result.rows !== 1 || !result.text.includes(expected)) throw new Error(`Imported ${kind} observation did not appear in the history UI: ${JSON.stringify({query,expected,result})}`);
    return {kind,query,rows:result.rows,verified:expected};
  };
  const importedVendor = await verifyImportedObservation({kind:'vendors',query:'Legacy Vendor',expected:'Legacy Vendor'});
  const importedModel = await verifyImportedObservation({kind:'models',query:'Legacy Model',expected:'Legacy Model'});
  const beforeDeletes = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['snapshots','inventory','history','legacyObservations'],'readonly');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();const observations=tx.objectStore('legacyObservations').index('by_kind_observed').count(IDBKeyRange.bound(['history_loads',''],['history_loads','\uffff']));tx.oncomplete=()=>{db.close();resolve({snapshots:snapshots.result,inventory:inventory.result,history:history.result,loads:observations.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  await evaluate(`(()=>{const form=document.querySelector('#vendorModelHistoryFilters');form.elements.namedItem('kind').value='loads';form.elements.namedItem('query').value='';form.requestSubmit();return true})()`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    const rows = await evaluate(`document.querySelectorAll('#vendorModelHistoryTable tbody tr').length`);
    if (rows === 2) break;
  }
  await evaluate(`(()=>{window.confirm=()=>true;document.querySelector('#vendorModelHistoryTable [data-delete-imported-history-load="sqlite-history-loads-vmh-484-1"]').click();return true})()`);
  let remaining = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    remaining = await evaluate(`({text:document.querySelector('#vendorModelHistoryTable')?.textContent||'',status:document.querySelector('#vendorModelHistoryStatus')?.textContent||''})`);
    if (!remaining.text.includes('history-load-smoke-1.csv') && remaining.status.includes('удалено загрузок: 1')) break;
  }
  if (remaining.text.includes('history-load-smoke-1.csv') || !remaining.status.includes('удалено загрузок: 1')) throw new Error(`Deleting an imported load did not remove the selected record: ${JSON.stringify(remaining)}`);
  await evaluate(`(()=>{const form=document.querySelector('#vendorModelHistoryFilters');form.elements.namedItem('query').value='';form.requestSubmit();return true})()`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    remaining = await evaluate(`({text:document.querySelector('#vendorModelHistoryTable')?.textContent||'',status:document.querySelector('#vendorModelHistoryStatus')?.textContent||''})`);
    if (remaining.text.includes('history-load-smoke-2.csv')) break;
  }
  if (!remaining.text.includes('history-load-smoke-2.csv')) throw new Error(`Deleting one load also hid the other imported record: ${JSON.stringify(remaining)}`);
  await evaluate(`document.querySelector('#deleteImportedHistoryLoadsButton').click()`);
  let cleared = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    remaining = await evaluate(`({text:document.querySelector('#vendorModelHistoryTable')?.textContent||'',status:document.querySelector('#vendorModelHistoryStatus')?.textContent||''})`);
    if (!remaining.text.includes('history-load-smoke-1.csv') && !remaining.text.includes('history-load-smoke-2.csv') && remaining.status.includes('удалено загрузок: 1')) {cleared=true;break}
  }
  const afterDeletes = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['snapshots','inventory','history','legacyObservations'],'readonly');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();const observations=tx.objectStore('legacyObservations').index('by_kind_observed').count(IDBKeyRange.bound(['history_loads',''],['history_loads','\uffff']));tx.oncomplete=()=>{db.close();resolve({snapshots:snapshots.result,inventory:inventory.result,history:history.result,loads:observations.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (!cleared || ["snapshots","inventory","history"].some((key)=>beforeDeletes[key]!==afterDeletes[key]) || beforeDeletes.loads!==2 || afterDeletes.loads!==0) throw new Error(`Deleting imported load history changed unrelated records or left entries: ${JSON.stringify({cleared,beforeDeletes,afterDeletes})}`);
  console.log(JSON.stringify({vendorModelHistoryOnly:true,status,exports:[vendorExport,modelExport,loadExport],imported:[importedVendor,importedModel],selectedDelete:true,clearDelete:true,preservedDatabase:afterDeletes,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--final-history-management-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  const createFinal = async ({ name, mac, deviceId, vendor, model, room, expectedCount }) => {
    await assignInput("#mainFileInput", name, `MAC;Device ID;Производитель;Модель;Помещение\n${mac};${deviceId};${vendor};${model};${room}`);
    for (const [field, index] of [["mac",0],["deviceId",1],["manufacturer",2],["model",3],["room",4]]) {
      const selected = await evaluate(`(()=>{const input=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!input)throw new Error('Missing Main mapping ${field}');input.value=${index};input.dispatchEvent(new Event('change',{bubbles:true}));return input.value})()`);
      if (selected !== String(index)) throw new Error(`Could not select Main ${field} for ${name}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
    let result = null;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      await wait(100);
      result = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
      if (result.error) throw new Error(`Final creation failed for ${name}: ${result.message}`);
      if (result.status.includes(`${expectedCount} Final`)) break;
    }
    if (!result?.status.includes(`${expectedCount} Final`)) throw new Error(`Expected ${expectedCount} Final after ${name}: ${JSON.stringify(result)}`);
  };
  await createFinal({name:"history-delete-room-one.csv",mac:"00:44:55:66:77:81",deviceId:"HISTORY-DELETE-81",vendor:"History Vendor One",model:"History Model One",room:"Delete Room One",expectedCount:1});
  await createFinal({name:"history-delete-room-two.csv",mac:"00:44:55:66:77:82",deviceId:"HISTORY-DELETE-82",vendor:"History Vendor Two",model:"History Model Two",room:"Delete Room Two",expectedCount:2});
  await createFinal({name:"history-delete-room-three.csv",mac:"00:44:55:66:77:83",deviceId:"HISTORY-DELETE-83",vendor:"History Vendor Three",model:"History Model Three",room:"Delete Room Three",expectedCount:3});
  const before = await evaluate(`(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(new URL(location.href).searchParams.get('db'));open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const names=['settings','snapshots','snapshotChunks','inventory','history','analyticsCache','finalAnalytics','finalAnalyticsMetadata','archives','mac5Models','oui','knownModels'];const tx=db.transaction(names,'readonly');const counts={};for(const name of names.filter(name=>name!=='settings'))counts[name]=tx.objectStore(name).count();const active=tx.objectStore('settings').get('activeSnapshotId');const marker=tx.objectStore('settings').get('smoke-final-history-marker');tx.oncomplete=()=>{db.close();resolve({...Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,value.result])),active:active.result?.value||'',marker:marker.result?.value||null})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (before.snapshots !== 3 || before.inventory !== 3 || !before.active) throw new Error(`Three UI Finals did not persist as expected: ${JSON.stringify(before)}`);
  await evaluate(`(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(new URL(location.href).searchParams.get('db'));open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction('mac5Models','readwrite');tx.objectStore('mac5Models').put({prefix:'DEADBEEF01',model:'Smoke Preserved User Rule',source:'Пользователь'});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  const filter = async ({ vendor, model, room, query, filename, from, to, expected }) => {
    await evaluate(`(()=>{const form=document.querySelector('#snapshotHistoryFilters');for(const [name,value] of Object.entries(${JSON.stringify({vendor,model,room,query:query??filename,from:from||"",to:to||""})}))form.elements.namedItem(name).value=value;form.requestSubmit();return true})()`);
    let page = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await wait(50);
      page = await evaluate(`({rows:[...document.querySelectorAll('#snapshotList tbody tr')].map(row=>row.textContent.replace(/\\s+/g,' ')),status:document.querySelector('#snapshotHistoryStatus')?.textContent||''})`);
      if (page.rows.length === 1 && page.rows[0].includes(expected)) break;
    }
    if (page.rows.length !== 1 || !page.rows[0].includes(expected)) throw new Error(`Final filters did not isolate ${expected}: ${JSON.stringify(page)}`);
    await evaluate(`document.querySelector('#snapshotHistoryFilters [type="reset"]')?.click()`);
    await evaluate(`(()=>{const form=document.querySelector('#snapshotHistoryFilters');form.reset();form.requestSubmit();return true})()`);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await wait(50);
      const rows = await evaluate(`document.querySelectorAll('#snapshotList tbody tr').length`);
      if (rows === 3) return;
    }
    throw new Error("Resetting Final filters did not restore all three snapshots");
  };
  const today = new Date().toISOString().slice(0,10);
  await filter({vendor:"History Vendor One",model:"History Model One",room:"Delete Room One",filename:"history-delete-room-one.csv",from:today,to:today,expected:"history-delete-room-one.csv"});
  await filter({vendor:"History Vendor One",model:"History Model One",room:"Delete Room One",query:"00:44:55:66:77:81",from:today,to:today,expected:"history-delete-room-one.csv"});
  await evaluate(`(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(new URL(location.href).searchParams.get('db'));open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction('settings','readwrite');tx.objectStore('settings').put({key:'smoke-final-history-marker',value:'preserved'});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  await evaluate(`(()=>{const row=[...document.querySelectorAll('#snapshotList tbody tr')].find(item=>item.textContent.includes('history-delete-room-one.csv'));if(!row)throw new Error('Missing target Final row');row.querySelector('[data-select-final]').click();return true})()`);
  const deleteState = await evaluate(`({button:document.querySelector('#deleteSelectedFinalsButton')?.textContent||'',disabled:document.querySelector('#deleteSelectedFinalsButton')?.disabled})`);
  if (deleteState.disabled || !deleteState.button.includes("(1)")) throw new Error(`Selecting a filtered Final did not enable single-row deletion: ${JSON.stringify(deleteState)}`);
  await evaluate(`window.confirm=()=>true;document.querySelector('#deleteSelectedFinalsButton').click()`);
  let afterSelected = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(50);
    afterSelected = await evaluate(`(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(new URL(location.href).searchParams.get('db'));open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const names=['settings','snapshots','snapshotChunks','inventory','history','analyticsCache','finalAnalytics','finalAnalyticsMetadata','archives','mac5Models','oui','knownModels'];const tx=db.transaction(names,'readonly');const counts={};for(const name of names.filter(name=>name!=='settings'))counts[name]=tx.objectStore(name).count();const active=tx.objectStore('settings').get('activeSnapshotId');const marker=tx.objectStore('settings').get('smoke-final-history-marker');const rule=tx.objectStore('mac5Models').get('DEADBEEF01');tx.oncomplete=()=>{db.close();resolve({...Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,value.result])),active:active.result?.value||'',marker:marker.result?.value||null,rule:rule.result?.model||''})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (afterSelected.snapshots === 2) break;
  }
  if (afterSelected.snapshots !== 2 || afterSelected.inventory !== 3 || !afterSelected.active || afterSelected.marker !== "preserved" || afterSelected.rule !== "Smoke Preserved User Rule"
    || afterSelected.archives !== before.archives || afterSelected.mac5Models !== before.mac5Models + 1 || afterSelected.knownModels !== before.knownModels) {
    throw new Error(`Selected Final deletion did not preserve unrelated user data: ${JSON.stringify({before,afterSelected})}`);
  }
  const rowsAfterDelete = await evaluate(`document.querySelectorAll('#snapshotList tbody tr').length`);
  if (rowsAfterDelete !== 2) throw new Error(`Deleted Final still appears in the list: ${rowsAfterDelete} rows`);
  await evaluate(`window.confirm=()=>true;document.querySelector('#clearFinalHistoryButton').click()`);
  let afterClear = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(50);
    afterClear = await evaluate(`(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(new URL(location.href).searchParams.get('db'));open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const names=['settings','snapshots','snapshotChunks','inventory','history','analyticsCache','finalAnalytics','finalAnalyticsMetadata','archives','mac5Models','oui','knownModels'];const tx=db.transaction(names,'readonly');const counts={};for(const name of names.filter(name=>name!=='settings'))counts[name]=tx.objectStore(name).count();const active=tx.objectStore('settings').get('activeSnapshotId');const marker=tx.objectStore('settings').get('smoke-final-history-marker');const rule=tx.objectStore('mac5Models').get('DEADBEEF01');tx.oncomplete=()=>{db.close();resolve({...Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,value.result])),active:active.result?.value||'',marker:marker.result?.value||null,rule:rule.result?.model||''})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (afterClear.snapshots === 0) break;
  }
  if (afterClear.snapshots !== 0 || afterClear.snapshotChunks !== 0 || afterClear.history !== 0 || afterClear.analyticsCache !== 0 || afterClear.finalAnalytics !== 0 || afterClear.finalAnalyticsMetadata !== 0
    || afterClear.inventory !== 3 || afterClear.active || afterClear.marker !== "preserved" || afterClear.rule !== "Smoke Preserved User Rule"
    || afterClear.archives !== before.archives || afterClear.mac5Models !== before.mac5Models + 1 || afterClear.knownModels !== before.knownModels) {
    throw new Error(`Clear Final history did not remove the full snapshot scope and preserve Inventory/rules/settings/archives: ${JSON.stringify({before,afterSelected,afterClear})}`);
  }
  console.log(JSON.stringify({finalHistoryManagementOnly:true,filters:["MAC/source filename","vendor","model","room"],selectedDelete:afterSelected,clearFinalHistory:afterClear,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--placeholder-model-recovery-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  const createFinal = async ({ name, model, expectedCount }) => {
    await assignInput("#mainFileInput", name, `MAC;Device ID;Модель\n00:11:22:33:44:95;MODEL-RECOVERY-95;${model}`);
    for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2]]) {
      const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
      if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${selected}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
    let status = "";
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await wait(100);
      const state = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
      if (state.error) throw new Error(`Final ${expectedCount} failed: ${state.message}`);
      status = state.status;
      if (status.includes(`${expectedCount} Final`)) break;
    }
    if (!status.includes(`${expectedCount} Final`)) throw new Error(`Expected ${expectedCount} Finals after ${name}, got: ${status}`);
  };
  await createFinal({ name: "model-recovery-known.csv", model: "Conference Kit", expectedCount: 1 });
  await createFinal({ name: "model-recovery-placeholder.csv", model: "Unknown Model", expectedCount: 2 });
  const recovered = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const snapshot=snapshots.result.find((item)=>item.id===active.result?.value);const devices=chunks.result.filter((chunk)=>chunk.snapshotId===active.result?.value).flatMap((chunk)=>chunk.devices||[]);db.close();resolve({snapshotCount:snapshots.result.filter((item)=>item.kind!=='single').length,snapshotName:snapshot?.name,devices:devices.map(({mac,deviceId,model,fieldSources,modelSource})=>({mac,deviceId,model,modelSource,fieldSource:fieldSources?.model}))})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const device = recovered.devices.find((item) => item.mac === "00:11:22:33:44:95");
  if (recovered.snapshotCount !== 2 || device?.model !== "Conference Kit" || (device.fieldSource || device.modelSource) !== "Previous Final") {
    throw new Error(`A placeholder model blocked Previous Final recovery: ${JSON.stringify(recovered)}`);
  }
  const banner = await evaluate(`({visible:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
  if (banner.visible) throw new Error(`Model recovery left an application error visible: ${banner.message}`);
  console.log(JSON.stringify({placeholderModelRecoveryOnly:true,recovered,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--history-log-pages-only")) {
  const seeded = await evaluate(`(()=>new Promise((resolve,reject)=>{
    const dbName=new URL(location.href).searchParams.get('db');
    const opening=indexedDB.open(dbName);
    opening.onerror=()=>reject(opening.error);
    opening.onsuccess=()=>{
      const db=opening.result;
      const tx=db.transaction('history','readwrite');
      const store=tx.objectStore('history');
      for(let index=0;index<205;index+=1){
        const timestamp=new Date(Date.now()-205000+index*1000).toISOString();
        store.add({timestamp,mac:'00:11:22:33:44:55',type:'modified',field:'model',label:'Модель',oldValue:'old-'+index,newValue:'history-page-'+String(index).padStart(3,'0'),source:index<3?'Filtered history source.csv':'History page smoke.csv'});
      }
      const insertedCount=store.count();insertedCount.onsuccess=()=>{count=insertedCount.result};
      tx.oncomplete=()=>{db.close();resolve({seeded:205,count})};
      tx.onerror=()=>{db.close();reject(tx.error)};
      tx.onabort=()=>{db.close();reject(tx.error||new Error('History-page seed aborted'))};
    };
  }))()`);
  if (seeded.seeded !== 205 || seeded.count !== 205) throw new Error(`Could not seed the disposable History page fixture: ${JSON.stringify(seeded)}`);
  await evaluate(`document.querySelector('[data-view="history"]').click()`);
  await wait(150);
  await evaluate(`(()=>{const form=document.querySelector('#historyLogFilters');form.elements.namedItem('mac').value='00:11:22:33:44:55';form.requestSubmit();return true})()`);
  const inspectHistoryPage = async () => evaluate(`(()=>{const host=document.querySelector('#historyLogResults');const rows=[...(host?.querySelectorAll('tbody tr[data-history-event-row]')||[])];return{status:document.querySelector('#historyLogStatus')?.textContent||'',count:rows.length,first:rows[0]?.querySelector('[data-device-field="newValue"]')?.textContent||'',last:rows.at(-1)?.querySelector('[data-device-field="newValue"]')?.textContent||'',group:host?.querySelector('.history-log-group summary')?.textContent||'',nextDisabled:document.querySelector('#historyLogNextButton')?.disabled,previousDisabled:document.querySelector('#historyLogPreviousButton')?.disabled,macFilter:document.querySelector('#historyLogFilters')?.elements.namedItem('mac')?.value||'',error:!document.querySelector('#errorBanner')?.hidden}})()`);
  const waitForPage = async (pageNumber, shown) => {
    let state=null;
    for(let attempt=0;attempt<120;attempt+=1){
      await wait(50);
      state=await inspectHistoryPage();
      if(state.status.includes(`страница ${pageNumber}`)&&state.status.includes(`показано ${shown}`))return state;
    }
    throw new Error(`Global History did not reach page ${pageNumber}: ${JSON.stringify(state)}`);
  };
  const firstPage=await waitForPage(1,100);
  if(firstPage.error||!firstPage.status.includes('205 событий')||!firstPage.group.includes('100 событий')||firstPage.first!=='history-page-000'||firstPage.nextDisabled||!firstPage.previousDisabled)throw new Error(`Global History page 1 did not show exactly the first 100 of 205 events: ${JSON.stringify(firstPage)}`);
  await evaluate(`document.querySelector('#historyLogNextButton').click()`);
  const secondPage=await waitForPage(2,100);
  if(secondPage.error||!secondPage.status.includes('205 событий')||!secondPage.group.includes('100 событий')||secondPage.first!=='history-page-100'||secondPage.nextDisabled||secondPage.previousDisabled)throw new Error(`Global History page 2 was incorrect: ${JSON.stringify(secondPage)}`);
  await evaluate(`document.querySelector('#historyLogNextButton').click()`);
  const thirdPage=await waitForPage(3,5);
  if(thirdPage.error||!thirdPage.status.includes('205 событий')||!thirdPage.group.includes('5 событий')||thirdPage.first!=='history-page-200'||!thirdPage.nextDisabled||thirdPage.previousDisabled)throw new Error(`Global History last page did not retain its exact five-row remainder: ${JSON.stringify(thirdPage)}`);
  await evaluate(`document.querySelector('#historyLogPreviousButton').click()`);
  const backToSecond=await waitForPage(2,100);
  if(backToSecond.first!=='history-page-100'||backToSecond.nextDisabled||backToSecond.previousDisabled)throw new Error(`Global History previous-page cursor did not restore page 2: ${JSON.stringify(backToSecond)}`);
  await evaluate(`(()=>{const form=document.querySelector('#historyLogFilters');form.elements.namedItem('source').value='Filtered history source';form.requestSubmit();return true})()`);
  const filteredPage=await waitForPage(1,3);
  if(filteredPage.error||!filteredPage.status.includes('3 событий')||!filteredPage.group.includes('3 событий')||!filteredPage.nextDisabled||!filteredPage.previousDisabled)throw new Error(`Filtered Global History lost its exact count or paging bounds: ${JSON.stringify(filteredPage)}`);
  console.log(JSON.stringify({historyLogPagesOnly:true,seeded:seeded.seeded,firstPage,secondPage,thirdPage,backToSecond,filteredPage,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--engineering-mode-only")) {
  const engineerState = await evaluate(`({label:document.querySelector('#engineeringModeButton').textContent,protectedViewsVisible:[...document.querySelectorAll('.nav-button[data-view]')].filter((button)=>['single','filecompare','multicompare','enrichment','batch','data','rooms','guide'].includes(button.dataset.view)&&!button.hidden).length})`);
  if (!engineerState.label.includes("Инженер ·") || engineerState.protectedViewsVisible < 8) throw new Error(`Engineering mode did not expose its protected navigation: ${JSON.stringify(engineerState)}`);
  await command("Page.reload");
  await wait(1_500);
  let reloadUser = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    reloadUser = await evaluate(`({label:document.querySelector('#engineeringModeButton')?.textContent||'',searchActive:document.querySelector('#searchView')?.classList.contains('active'),dataHidden:document.querySelector('[data-view="data"]')?.hidden})`);
    if (reloadUser.label.includes("Пользователь") && reloadUser.searchActive) break;
  }
  if (!reloadUser?.label.includes("Пользователь") || !reloadUser.searchActive || !reloadUser.dataHidden) throw new Error(`Reload persisted the previous tab's engineering session: ${JSON.stringify(reloadUser)}`);
  await evaluate(`document.querySelector('#engineeringModeButton').click()`);
  await evaluate(`(()=>{document.querySelector('#engineeringSessionMinutes').value='30';document.querySelector('#engineeringPassword').value=${JSON.stringify(smokeEngineerPassword)};document.querySelector('#engineeringModeForm').requestSubmit();return true})()`);
  let restoredEngineer = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    restoredEngineer = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent||''`);
    if (restoredEngineer.includes("Инженер ·")) break;
  }
  if (!restoredEngineer.includes("Инженер ·")) throw new Error(`Valid password failed after reload: ${restoredEngineer}`);
  await evaluate(`document.querySelector('#engineeringModeButton').click()`);
  let userState = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(50);
    userState = await evaluate(`({label:document.querySelector('#engineeringModeButton').textContent,searchActive:document.querySelector('#searchView')?.classList.contains('active'),dataHidden:document.querySelector('[data-view="data"]')?.hidden})`);
    if (userState.label.includes("Пользователь") && userState.searchActive) break;
  }
  if (!userState?.label.includes("Пользователь") || !userState.searchActive || !userState.dataHidden) throw new Error(`Logout did not return to the restricted user search view: ${JSON.stringify(userState)}`);
  await evaluate(`document.querySelector('#engineeringModeButton').click()`);
  await evaluate(`(()=>{document.querySelector('#engineeringPassword').value='incorrect smoke password';document.querySelector('#engineeringModeForm').requestSubmit();return true})()`);
  let denied = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    denied = await evaluate(`({status:document.querySelector('#engineeringModeStatus')?.textContent||'',dialogOpen:document.querySelector('#engineeringModeDialog')?.open,label:document.querySelector('#engineeringModeButton')?.textContent||'',dataHidden:document.querySelector('[data-view="data"]')?.hidden,passwordCleared:document.querySelector('#engineeringPassword')?.value===''})`);
    if (denied.status.includes("Неверный пароль")) break;
  }
  if (!denied?.status.includes("Неверный пароль") || !denied.dialogOpen || !denied.label.includes("Пользователь") || !denied.dataHidden || !denied.passwordCleared) throw new Error(`Incorrect password changed role or was not rejected: ${JSON.stringify(denied)}`);
  await evaluate(`document.querySelector('[data-engineering-close]').click();document.querySelector('#engineeringModeButton').click()`);
  await evaluate(`(()=>{document.querySelector('#engineeringSessionMinutes').value='1';document.querySelector('#engineeringPassword').value=${JSON.stringify(smokeEngineerPassword)};document.querySelector('#engineeringModeForm').requestSubmit();return true})()`);
  let timedEngineer = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    timedEngineer = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent||''`);
    if (timedEngineer.includes("Инженер ·")) break;
  }
  if (!timedEngineer?.includes("Инженер ·")) throw new Error(`Correct password did not restore engineering mode: ${timedEngineer}`);
  let expired = null;
  for (let attempt = 0; attempt < 75; attempt += 1) {
    await wait(1_000);
    expired = await evaluate(`({label:document.querySelector('#engineeringModeButton')?.textContent||'',searchActive:document.querySelector('#searchView')?.classList.contains('active'),dataHidden:document.querySelector('[data-view="data"]')?.hidden})`);
    if (expired.label.includes("Пользователь") && expired.searchActive) break;
  }
  if (!expired?.label.includes("Пользователь") || !expired.searchActive || !expired.dataHidden) throw new Error(`One-minute session did not expire back into restricted user mode: ${JSON.stringify(expired)}`);
  console.log(JSON.stringify({ engineeringModeOnly: true, initial, engineerState, reloadUser, restoredEngineer, logout: userState, wrongPassword: denied, timedEngineer, expired, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--archive-attachment-only")) {
  await evaluate(`document.querySelector('[data-view="batch"]').click()`);
  await evaluate(`(()=>{const form=document.querySelector('#legacyTaskCreateForm');form.elements.name.value='Archive attachment smoke';form.elements.intervalMinutes.value='1440';form.requestSubmit();return true})()`);
  await wait(300);
  await evaluate(`document.querySelector('[data-view="history"]').click()`);
  await wait(150);
  await evaluate(`(()=>{const form=document.querySelector('#legacyObservationFilters');form.elements.kind.value='scheduled_tasks';form.requestSubmit();return true})()`);
  let taskButtonReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    taskButtonReady = await evaluate(`Boolean([...document.querySelectorAll('#legacyObservationResults [data-add-legacy-task-files]')].find((button)=>button.closest('tr')?.textContent.includes('Archive attachment smoke')))`);
    if (taskButtonReady) break;
  }
  if (!taskButtonReady) throw new Error('Disposable schedule did not render its Add files action');
  await evaluate(`(()=>{const input=document.querySelector('#legacyTaskQueueFilePicker');input.click=()=>{};document.querySelector('#legacyObservationResults [data-add-legacy-task-files]').click();const transfer=new DataTransfer();transfer.items.add(new File(['original queued attachment bytes'], 'archive-original.csv', {type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  let queuedAttachment = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    queuedAttachment = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['legacyObservations','fileHandles'],'readonly');const rows=tx.objectStore('legacyObservations').getAll();tx.oncomplete=async()=>{try{db.close();const row=rows.result.find((item)=>item.kind==='task_file_queue'&&item.payload?.filename==='archive-original.csv');const local=row?.payload?.localBlobKey?await new Promise((done,fail)=>{const read=indexedDB.open(name);read.onerror=()=>fail(read.error);read.onsuccess=()=>{const handleDb=read.result;const request=handleDb.transaction('fileHandles','readonly').objectStore('fileHandles').get(row.payload.localBlobKey);request.onsuccess=()=>{handleDb.close();done(request.result||null)};request.onerror=()=>{handleDb.close();fail(request.error)}}}):null;resolve({row:row||null,blobKey:row?.payload?.localBlobKey||'',filename:local?.filename||'',bytes:local?.file?await local.file.text():''})}catch(error){reject(error)}};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (queuedAttachment?.row) break;
  }
  if (!queuedAttachment?.row?.id || !queuedAttachment.blobKey || queuedAttachment.filename !== 'archive-original.csv' || queuedAttachment.bytes !== 'original queued attachment bytes') throw new Error(`Schedule did not store the original queue attachment locally: ${JSON.stringify(queuedAttachment)}`);
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  await wait(150);
  let archive = null;
  for (let archiveAttempt = 0; archiveAttempt < 2; archiveAttempt += 1) {
    if (archiveAttempt) {
      await evaluate(`document.querySelector('#errorBanner [data-error-dismiss]')?.click()`);
      await wait(1_500);
    }
    await evaluate(`(()=>{document.querySelector('#localArchiveName').value='Queue attachment snapshot';document.querySelector('#localArchiveForm').requestSubmit();return true})()`);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await wait(50);
      archive = await evaluate(`(()=>{const row=[...document.querySelectorAll('#localArchiveList tbody tr')].find((item)=>item.textContent.includes('Queue attachment snapshot'));return{id:row?.querySelector('[data-restore-local-archive]')?.dataset.restoreLocalArchive||'',status:document.querySelector('#localArchiveStatus')?.textContent||'',error:document.querySelector('#errorBanner:not([hidden]) span')?.textContent||''}})()`);
      if (archive.id || archive.error) break;
    }
    if (archive?.id || !archive?.error.includes('База изменилась во время создания архива') || archiveAttempt > 0) break;
  }
  if (!archive?.id || !archive.status.includes('Сохранён архив')) throw new Error(`Could not create named archive with queued attachment: ${JSON.stringify(archive)}`);
  const removed = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['legacyObservations','fileHandles'],'readwrite');tx.objectStore('legacyObservations').delete(${JSON.stringify(queuedAttachment.row.id)});tx.objectStore('fileHandles').delete(${JSON.stringify(queuedAttachment.blobKey)});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (!removed) throw new Error('Could not remove only the disposable queue row and attachment before restore');
  await evaluate(`document.querySelector('[data-restore-local-archive="${archive.id}"]').click()`);
  let restored = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await wait(50);
    restored = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['legacyObservations','fileHandles'],'readonly');const row=tx.objectStore('legacyObservations').get(${JSON.stringify(queuedAttachment.row.id)});const handle=tx.objectStore('fileHandles').get(${JSON.stringify(queuedAttachment.blobKey)});tx.oncomplete=async()=>{try{db.close();resolve({row:row.result||null,filename:handle.result?.filename||'',bytes:handle.result?.file?await handle.result.file.text():''})}catch(error){reject(error)}};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (restored.row) break;
  }
  if (restored?.row?.payload?.filename !== 'archive-original.csv' || restored.filename !== 'archive-original.csv' || restored.bytes !== 'original queued attachment bytes') throw new Error(`Named archive failed to restore the queue attachment captured at snapshot time: ${JSON.stringify({id:restored?.row?.id,filename:restored?.filename,bytes:restored?.bytes})}`);
  await evaluate(`(()=>{Object.defineProperty(globalThis,'showSaveFilePicker',{configurable:true,value:undefined});const nativeCreate=URL.createObjectURL.bind(URL);const nativeClick=HTMLAnchorElement.prototype.click;window.__smokeQueueArchive={blob:null,name:''};URL.createObjectURL=(blob)=>{window.__smokeQueueArchive.blob=blob;return nativeCreate(blob)};HTMLAnchorElement.prototype.click=function(){if(this.download.endsWith('.madb.json'))window.__smokeQueueArchive.name=this.download;return nativeClick.call(this)}})()`);
  await evaluate(`document.querySelector('[data-export-local-archive="${archive.id}"]').click()`);
  let portable = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    portable = await evaluate(`(async()=>{const item=window.__smokeQueueArchive;if(!item?.blob||!item.name)return null;const archive=JSON.parse(await item.blob.text());const file=archive.legacyTaskQueueFiles?.find((row)=>row.filename==='archive-original.csv');const binary=file?.chunks?.map((chunk)=>atob(chunk)).join('')||'';return{name:item.name,format:archive.format,version:archive.version,file:file?{id:file.id,taskId:file.taskId,size:file.size,chunkCount:file.chunks.length}:null,bytes:binary}})()`);
    if (portable) break;
  }
  if (portable?.format !== 'MAC_ANALYZER_NEXT_ARCHIVE' || portable.version !== 1 || portable.file?.id !== queuedAttachment.row.id || portable.file?.taskId !== queuedAttachment.row.payload.taskId || portable.file?.size !== queuedAttachment.bytes.length || portable.file?.chunkCount !== 1 || portable.bytes !== queuedAttachment.bytes) throw new Error(`Portable .madb archive omitted or changed the captured queue attachment: ${JSON.stringify(portable)}`);
  console.log(JSON.stringify({ archiveAttachmentOnly: true, schedule: 'created through UI', queuedFile: queuedAttachment.filename, originalBytes: queuedAttachment.bytes, restoredFilename: restored.filename, restoredBytes: restored.bytes, portable, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--table-context-actions-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await wait(150);
  await assignInput("#mainFileInput", "table-context-smoke.csv", "MAC;Device ID;Model\n02:40:00:00:00:01;CONTEXT-1;Context Model A\n02:40:00:00:00:02;CONTEXT-2;Context Model B");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2]]) {
    await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main ${field} mapping');select.value=String(${index});select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let inventoryReady = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    inventoryReady = await evaluate(`(()=>({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (inventoryReady.error) throw new Error(`Context-action Final failed: ${inventoryReady.message}`);
    if (inventoryReady.status.includes("1 Final") && inventoryReady.status.includes("2 устройств")) break;
  }
  if (!inventoryReady?.status.includes("2 устройств")) throw new Error(`Context-action Inventory did not load two rows: ${JSON.stringify(inventoryReady)}`);
  await evaluate(`document.querySelector('[data-view="search"]').click()`);
  await wait(200);
  await evaluate(`(()=>{window.__smokeClipboard=[];class SmokeClipboardItem{constructor(values){this.values=values}getType(type){return Promise.resolve(this.values[type])}}Object.defineProperty(globalThis,'ClipboardItem',{configurable:true,value:SmokeClipboardItem});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value)=>{window.__smokeClipboard.push(String(value))},write:async(items)=>{const blob=await items[0].getType('text/plain');window.__smokeClipboard.push(await blob.text())}}});return true})()`);
  const readClipboard = async (action) => {
    await evaluate(`(()=>{window.__smokeClipboard=[];const button=document.querySelector('[data-device-action="${action}"]');if(!button||button.hidden)throw new Error('Context action ${action} is unavailable');button.click();return true})()`);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await wait(50);
      const clipboard = await evaluate(`window.__smokeClipboard?.at(-1)||''`);
      if (clipboard) return clipboard;
    }
    throw new Error(`Clipboard did not receive ${action}`);
  };
  await evaluate(`document.querySelector('#deviceTable tbody tr[data-device-id]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}))`);
  const firstMac = await readClipboard("copy-mac");
  if (firstMac !== "02:40:00:00:00:01") throw new Error(`Context menu copied the wrong MAC: ${firstMac}`);
  await evaluate(`document.querySelector('#deviceTable tbody tr[data-device-id]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}))`);
  const firstRow = await readClipboard("copy-row");
  if (!firstRow.includes("02:40:00:00:00:01") || !firstRow.includes("Context Model A")) throw new Error(`Context row copy omitted visible device fields: ${firstRow}`);
  const selectedIds = await evaluate(`(()=>{const rows=[...document.querySelectorAll('#deviceTable tbody [data-select-device]')];rows.forEach((item)=>{item.checked=true;item.dispatchEvent(new Event('change',{bubbles:true}))});return rows.map((item)=>item.dataset.selectDevice)})()`);
  if (selectedIds.length !== 2) throw new Error(`Could not select both inventory rows: ${JSON.stringify(selectedIds)}`);
  await evaluate(`document.querySelector('#deviceTable tbody tr[data-device-id]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}))`);
  const selectedRows = await readClipboard("copy-selected");
  if (!selectedRows.includes("02:40:00:00:00:01") || !selectedRows.includes("02:40:00:00:00:02") || selectedRows.split("\n").filter(Boolean).length !== 2) throw new Error(`Selected-row copy returned incomplete Inventory: ${selectedRows}`);
  await evaluate(`document.querySelector('#deviceTable tbody tr[data-device-id]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}))`);
  const inventoryPage = await readClipboard("copy-page");
  if (!inventoryPage.includes("02:40:00:00:00:01") || !inventoryPage.includes("02:40:00:00:00:02")) throw new Error(`Inventory page copy omitted a visible device: ${inventoryPage}`);
  await evaluate(`(()=>{const input=document.querySelector('#globalSearch');input.value='Context Model B';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  let filteredRows = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    filteredRows = await evaluate(`document.querySelectorAll('#deviceTable tbody tr[data-device-id]').length`);
    if (filteredRows === 1) break;
  }
  if (filteredRows !== 1) throw new Error(`Inventory query did not reduce the visible result set to one row: ${filteredRows}`);
  await evaluate(`document.querySelector('#deviceTable tbody tr[data-device-id]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}))`);
  const filteredInventory = await readClipboard("copy-filtered");
  if (filteredInventory.includes("02:40:00:00:00:01") || !filteredInventory.includes("02:40:00:00:00:02") || filteredInventory.split(/\r?\n/).filter(Boolean).length !== 2) throw new Error(`Filtered Inventory copy did not return the header and exact one-row search result: ${filteredInventory}`);
  await evaluate(`(()=>{const input=document.querySelector('#globalSearch');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    if (await evaluate(`document.querySelectorAll('#deviceTable tbody tr[data-device-id]').length`) === 2) break;
  }
  await evaluate(`document.querySelector('#deviceTable tbody tr[data-device-id]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));document.querySelector('[data-device-action="history"]').click()`);
  let historyOpened = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    historyOpened = await evaluate(`({active:document.querySelector('#historyView')?.classList.contains('active'),mac:document.querySelector('#macHistorySearch')?.value||'',error:!document.querySelector('#errorBanner').hidden})`);
    if (historyOpened.active && historyOpened.mac) break;
  }
  if (!historyOpened?.active || historyOpened.mac !== "02:40:00:00:00:01" || historyOpened.error) throw new Error(`Inventory context action did not open the selected MAC history: ${JSON.stringify(historyOpened)}`);
  let historyLogReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    historyLogReady = await evaluate(`Boolean(document.querySelector('#historyLogResults tr[data-device-context-row][data-history-event-mac="02:40:00:00:00:01"]'))`);
    if (historyLogReady) break;
  }
  if (!historyLogReady) throw new Error("Opening MAC history did not render context-action rows in the global History log");
  const historyContext = await evaluate(`(()=>{const row=document.querySelector('#historyLogResults tr[data-history-event-mac="02:40:00:00:00:01"]');row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));return{selected:row.getAttribute('aria-selected'),menuOpen:!document.querySelector('#deviceContextMenu').hidden,mac:row.dataset.historyEventMac}})()`);
  if (historyContext.selected !== "true" || !historyContext.menuOpen || historyContext.mac !== "02:40:00:00:00:01") throw new Error(`Global History row did not select/open its MAC context menu: ${JSON.stringify(historyContext)}`);
  const historyCopiedMac = await readClipboard("copy-mac");
  if (historyCopiedMac !== "02:40:00:00:00:01") throw new Error(`Global History context copied the wrong MAC: ${historyCopiedMac}`);
  await evaluate(`document.querySelector('#historyLogResults tr[data-history-event-mac="02:40:00:00:00:01"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}))`);
  const historyPage = await readClipboard("copy-page");
  if (!historyPage.includes("02:40:00:00:00:01") || !historyPage.includes("MAC")) throw new Error(`Global History page copy omitted its visible event: ${historyPage}`);
  await evaluate(`document.querySelector('#historyLogResults tr[data-history-event-mac="02:40:00:00:00:01"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));document.querySelector('[data-device-action="history"]').click()`);
  let historyContextOpened = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    historyContextOpened = await evaluate(`({active:document.querySelector('#historyView')?.classList.contains('active'),mac:document.querySelector('#macHistorySearch')?.value||'',error:!document.querySelector('#errorBanner').hidden})`);
    if (historyContextOpened.active && historyContextOpened.mac) break;
  }
  if (!historyContextOpened?.active || historyContextOpened.mac !== "02:40:00:00:00:01" || historyContextOpened.error) throw new Error(`Global History context did not open the selected MAC chronology: ${JSON.stringify(historyContextOpened)}`);
  await evaluate(`document.querySelector('[data-view="search"]').click();document.querySelector('#deviceTable tbody tr[data-device-id]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:40}));document.querySelector('[data-device-action="analytics"]').click()`);
  let analyticsOpened = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    analyticsOpened = await evaluate(`({open:document.querySelector('#detailsDialog')?.open,title:document.querySelector('#detailsDialog [data-dialog-title]')?.textContent||'',error:!document.querySelector('#errorBanner').hidden})`);
    if (analyticsOpened.open && analyticsOpened.title.includes("Аналитика устройства")) break;
  }
  if (!analyticsOpened?.open || !analyticsOpened.title.includes("Аналитика устройства") || analyticsOpened.error) throw new Error(`Inventory context action did not open device analytics: ${JSON.stringify(analyticsOpened)}`);
  await evaluate(`document.querySelector('#detailsDialog [data-dialog-close]').click();document.querySelector('[data-view="data"]').click()`);
  await wait(150);
  const finalOpenReady = await evaluate(`Boolean(document.querySelector('#snapshotList [data-open-final]'))`);
  if (!finalOpenReady) throw new Error("Final catalog did not expose its opened snapshot action");
  await evaluate(`document.querySelector('#snapshotList [data-open-final]').click()`);
  let finalDetailReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    finalDetailReady = await evaluate(`document.querySelector('#detailsDialog')?.open&&Boolean(document.querySelector('#detailsDialog [data-device-context-row]'))`);
    if (finalDetailReady) break;
  }
  if (!finalDetailReady) throw new Error("Opened Final did not render keyboard-selectable device rows");
  const genericSelection = await evaluate(`(()=>{const rows=[...document.querySelectorAll('#detailsDialog [data-device-context-row]')];if(rows.length!==2)return{count:rows.length};rows[0].click();const first=rows[0].getAttribute('aria-selected');rows[1].focus();rows[1].dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));const second=rows[1].getAttribute('aria-selected');rows[1].dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));return{count:rows.length,firstAfterSecond:rows[0].getAttribute('aria-selected'),first,second,menuOpen:!document.querySelector('#deviceContextMenu').hidden,focused:document.activeElement?.dataset.deviceAction||''}})()`);
  if (genericSelection.count !== 2 || genericSelection.first !== "true" || genericSelection.firstAfterSecond !== "false" || genericSelection.second !== "true" || !genericSelection.menuOpen) throw new Error(`Generic Final table selection/Shift+F10 failed: ${JSON.stringify(genericSelection)}`);
  const finalPage = await readClipboard("copy-page");
  if (!finalPage.includes("02:40:00:00:00:01") || !finalPage.includes("02:40:00:00:00:02")) throw new Error(`Final table page copy omitted a visible row: ${finalPage}`);
  console.log(JSON.stringify({ tableContextActionsOnly: true, inventoryReady, copiedMac: firstMac, copiedRow: firstRow, selectedCount: selectedIds.length, filteredResultCount: filteredRows, filteredInventory, historyOpened, historyContext, historyCopiedMac, historyContextOpened, analyticsOpened, genericSelection, finalPage, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--data-directory-reauthorize-only")) {
  const opfsDirectoryName = `mac-analyzer-smoke-${crypto.randomUUID()}`;
  const installDirectoryShim = `(()=>{const run=async()=>{const root=await navigator.storage.getDirectory();const name=${JSON.stringify(opfsDirectoryName)};const directory=await root.getDirectoryHandle(name,{create:true});const proto=Object.getPrototypeOf(directory);const nativeQuery=proto.queryPermission;const nativeGetFileHandle=proto.getFileHandle;const nativeRequest=proto.requestPermission;if(typeof nativeQuery!=="function"||typeof nativeRequest!=="function")throw new Error("File System Access permission methods are unavailable");Object.defineProperty(proto,"queryPermission",{configurable:true,value:async function(options){const forced=sessionStorage.getItem("mac-analyzer-smoke-fsa-permission");return forced||nativeQuery.call(this,options)}});Object.defineProperty(proto,"getFileHandle",{configurable:true,value:async function(fileName,options){if(this.name===name&&fileName==="mac-analyzer-data.madb"&&options?.create===false)throw new DOMException("Synthetic smoke archive is absent","NotFoundError");return nativeGetFileHandle.call(this,fileName,options)}});Object.defineProperty(proto,"requestPermission",{configurable:true,value:async function(){sessionStorage.setItem("mac-analyzer-smoke-fsa-permission","granted");return"granted"}});Object.defineProperty(globalThis,"showDirectoryPicker",{configurable:true,value:async()=>directory});window.__smokeDirectoryReady=true};run().catch((error)=>{window.__smokeDirectoryError=error.message})})()`;
  await command("Page.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: installDirectoryShim });
  const shimState = await evaluate(`(()=>{sessionStorage.setItem('mac-analyzer-smoke-fsa-permission','granted');return typeof navigator.storage?.getDirectory==='function'&&typeof FileSystemDirectoryHandle!=='undefined'})()`);
  if (!shimState) throw new Error("Edge does not expose OPFS directory handles required for the isolated File System Access smoke");
  await evaluate(installDirectoryShim);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await evaluate(`Boolean(window.__smokeDirectoryReady||window.__smokeDirectoryError)`);
    if (ready) break;
    await wait(50);
  }
  const shimReady = await evaluate(`({ready:Boolean(window.__smokeDirectoryReady),error:window.__smokeDirectoryError||''})`);
  if (!shimReady.ready) throw new Error(`Could not install the disposable OPFS directory handle: ${shimReady.error}`);
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  await evaluate(`document.querySelector('#chooseDataDirectoryButton').click()`);
  let connected = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    connected = await evaluate(`(()=>({status:document.querySelector('#dataDirectoryStatus')?.textContent||'',pickerHidden:document.querySelector('#chooseDataDirectoryButton')?.hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (connected.error) throw new Error(`Selecting the disposable data directory failed: ${connected.message}`);
    if (connected.status.includes("Подключена") || connected.status.includes("Архив в выбранной папке отсутствует")) break;
  }
  if (!connected?.status.includes("Подключена") && !connected?.status.includes("Архив в выбранной папке отсутствует")) throw new Error(`The disposable OPFS directory was not attached: ${JSON.stringify(connected)}`);
  await evaluate(`sessionStorage.setItem('mac-analyzer-smoke-fsa-permission','prompt')`);
  await command("Page.reload", { ignoreCache: true });
  let promptState = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    promptState = await evaluate(`(()=>({ready:document.title==='MAC Analyzer Pro Next'&&Boolean(document.querySelector('#dataDirectoryButton')),permissionButtonHidden:document.querySelector('#dataDirectoryButton')?.hidden,pickerHidden:document.querySelector('#chooseDataDirectoryButton')?.hidden,status:document.querySelector('#dataDirectoryStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden}))()`);
    if (promptState.ready && !promptState.permissionButtonHidden) break;
  }
  if (!promptState?.ready || promptState.permissionButtonHidden || !promptState.pickerHidden || !promptState.status.includes("сбросил разрешение") || promptState.error) {
    throw new Error(`A saved directory with a lost permission did not show the single reauthorization action: ${JSON.stringify(promptState)}`);
  }
  let engineerRestored = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes('Инженер')`);
  if (!engineerRestored) {
    await evaluate(`document.querySelector('#engineeringModeButton')?.click()`);
    await evaluate(`(()=>{const input=document.querySelector('#engineeringPassword');input.value=${JSON.stringify(smokeEngineerPassword)};input.dispatchEvent(new Event('input',{bubbles:true}));const confirmField=document.querySelector('#engineeringPasswordConfirmField');if(!confirmField.hidden){const confirm=document.querySelector('#engineeringPasswordConfirm');confirm.value=${JSON.stringify(smokeEngineerPassword)};confirm.dispatchEvent(new Event('input',{bubbles:true}))}document.querySelector('#engineeringModeForm').requestSubmit();return true})()`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(100);
      engineerRestored = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes('Инженер')`);
      if (engineerRestored) break;
    }
  }
  if (!engineerRestored) throw new Error("Could not re-authenticate the disposable engineer session before verifying the data-directory controls");
  const reauthorizeClick = await evaluate(`(()=>{const button=document.querySelector('#dataDirectoryButton');window.__smokeNativeClickCount=0;button.addEventListener('click',()=>window.__smokeNativeClickCount+=1,{once:true});button.click();return{clicks:window.__smokeNativeClickCount,permission:sessionStorage.getItem('mac-analyzer-smoke-fsa-permission')||'',syntheticPermissionAdapter:true}})()`);
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  let restoredPermission = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    restoredPermission = await evaluate(`(()=>({permissionButtonHidden:document.querySelector('#dataDirectoryButton')?.hidden,pickerHidden:document.querySelector('#chooseDataDirectoryButton')?.hidden,status:document.querySelector('#dataDirectoryStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (restoredPermission.error) throw new Error(`Reauthorizing the saved OPFS directory failed: ${restoredPermission.message}`);
    if (restoredPermission.permissionButtonHidden && restoredPermission.status.includes("Подключена")) break;
  }
  if (!restoredPermission?.permissionButtonHidden || !(restoredPermission.status.includes("Подключена") || restoredPermission.status.includes("Архив в выбранной папке отсутствует")) || restoredPermission.pickerHidden) {
    const diagnostic = await evaluate(`(()=>{const button=document.querySelector('#dataDirectoryButton');const rect=button?.getBoundingClientRect();return{url:location.href,title:document.title,readyState:document.readyState,ids:[...document.querySelectorAll('[id*="dataDirectory"]')].map((element)=>({id:element.id,text:element.textContent,hidden:element.hidden})),body:document.body?.innerText.slice(0,500),clicks:window.__smokeNativeClickCount,activation:navigator.userActivation?.isActive,permission:sessionStorage.getItem('mac-analyzer-smoke-fsa-permission'),button:{hidden:button?.hidden,text:button?.textContent,rect:rect&&{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}}})()`);
    throw new Error(`The Edge reauthorization control did not restore the saved directory handle: ${JSON.stringify({restoredPermission,reauthorizeClick,diagnostic})}`);
  }
  console.log(JSON.stringify({ dataDirectoryReauthorizeOnly: true, connected, promptState, restoredPermission, reauthorizeClick, realPermissionPromptVerified: false, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--workspace-source-handle-restart-only")) {
  const databaseName = new URL(target.url).searchParams.get("db");
  const sourceHandleScript = `(()=>{const prototype=FileSystemFileHandle.prototype;const nativeGetFile=prototype.getFile;Object.defineProperty(prototype,"queryPermission",{configurable:true,value:async()=>"granted"});Object.defineProperty(prototype,"requestPermission",{configurable:true,value:async()=>"granted"});Object.defineProperty(prototype,"getFile",{configurable:true,value:async function(...args){const file=await nativeGetFile.apply(this,args);globalThis.__workspaceSourceGetFileCalls=(globalThis.__workspaceSourceGetFileCalls||0)+1;return file}});for(const method of ["stream","text","arrayBuffer"]){const native=File.prototype[method];if(typeof native==="function")Object.defineProperty(File.prototype,method,{configurable:true,value:function(...args){if(this.name==="workspace-source-recovery.csv")globalThis.__workspaceSourceContentReads=(globalThis.__workspaceSourceContentReads||0)+1;return native.apply(this,args)}})}globalThis.showOpenFilePicker=async()=>{const root=await navigator.storage.getDirectory();return[await root.getFileHandle("workspace-source-recovery.csv",{create:true})]};globalThis.__workspaceSourceHandleReady=false;(async()=>{const root=await navigator.storage.getDirectory();const handle=await root.getFileHandle("workspace-source-recovery.csv",{create:true});if((await handle.getFile()).size===0){const writer=await handle.createWritable();await writer.write("MAC;Device ID;Производитель;Модель\\n02:63:00:00:01:01;WORKSPACE-SOURCE-RECOVERY;Recovery Vendor;Saved Source\\n");await writer.close()}globalThis.__workspaceSourceHandleReady=true})().catch(error=>globalThis.__workspaceSourceHandleError=error.message)})();`;
  await command("Page.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: sourceHandleScript });
  await evaluate(sourceHandleScript);
  let shim = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    shim = await evaluate(`({ready:Boolean(window.__workspaceSourceHandleReady),error:window.__workspaceSourceHandleError||""})`);
    if (shim.ready || shim.error) break;
  }
  if (!shim.ready) throw new Error(`Could not create disposable OPFS source file: ${shim.error}`);

  let engineerActive = await evaluate(`document.querySelector("#engineeringModeButton")?.textContent.includes("Инженер")`);
  if (!engineerActive) {
    await evaluate(`document.querySelector("#engineeringModeButton").click()`);
    await evaluate(`(()=>{const input=document.querySelector("#engineeringPassword");input.value=${JSON.stringify(smokeEngineerPassword)};input.dispatchEvent(new Event("input",{bubbles:true}));const confirmField=document.querySelector("#engineeringPasswordConfirmField");if(!confirmField.hidden){const confirm=document.querySelector("#engineeringPasswordConfirm");confirm.value=${JSON.stringify(smokeEngineerPassword)};confirm.dispatchEvent(new Event("input",{bubbles:true}))}document.querySelector("#engineeringModeForm").requestSubmit()})()`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(100);
      engineerActive = await evaluate(`document.querySelector("#engineeringModeButton")?.textContent.includes("Инженер")`);
      if (engineerActive) break;
    }
  }
  if (!engineerActive) throw new Error("Could not authenticate disposable engineer mode for workspace source recovery smoke");

  await evaluate(`document.querySelector("[data-view=\\"enrichment\\"]").click()`);
  await assignInput("#mainFileInput", "workspace-source-final.csv", "MAC;Device ID;Производитель;Модель\n02:63:00:00:01:02;WORKSPACE-SOURCE-FINAL;Recovery Vendor;Existing Final\n");
  for (const [field, index] of [["mac",0],["deviceId",1],["manufacturer",2],["model",3]]) {
    const selected = await evaluate(`(()=>{const control=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!control)throw new Error('Missing Main mapping ${field}');control.value=${index};control.dispatchEvent(new Event('change',{bubbles:true}));return control.value})()`);
    if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${selected}`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector("#runEnrichmentButton").click()`);
  let baseline = null;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await wait(100);
    baseline = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(databaseName)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(["settings","snapshots","inventory"],"readonly");const active=tx.objectStore("settings").get("activeSnapshotId");const snapshots=tx.objectStore("snapshots").getAll();const inventory=tx.objectStore("inventory").count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value||"",finals:snapshots.result.filter(item=>item.kind!=="single").length,inventoryCount:inventory.result,error:!document.querySelector("#errorBanner").hidden,message:document.querySelector("#errorBanner span")?.textContent||""})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (baseline.error) throw new Error(`Could not create baseline Final: ${baseline.message}`);
    if (baseline.finals === 1) break;
  }
  if (!baseline.activeId || baseline.finals !== 1 || baseline.inventoryCount !== 1) throw new Error(`Baseline Final was not persisted: ${JSON.stringify(baseline)}`);

  await evaluate(`document.querySelector('[data-workspace-source-handle="main"]').click()`);
  let selectedSource = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    selectedSource = await evaluate(`(()=>({status:document.querySelector("#mainWorkspaceSourceStatus")?.textContent||"",fileStatus:document.querySelector("#mainFileStatus")?.textContent||"",error:!document.querySelector("#errorBanner").hidden,message:document.querySelector("#errorBanner span")?.textContent||""}))()`);
    if (selectedSource.fileStatus.includes("workspace-source-recovery.csv")) break;
  }
  if (selectedSource.error || !selectedSource.status.includes("Доступ к") || !selectedSource.fileStatus.includes("workspace-source-recovery.csv")) throw new Error(`Selected source file handle was not persisted and loaded: ${JSON.stringify(selectedSource)}`);

  await reloadDatabaseAndWait(databaseName);
  const afterReload = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(databaseName)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(["fileHandles"],"readonly");const handle=tx.objectStore("fileHandles").get("workspace-source:main");tx.oncomplete=()=>{db.close();resolve({reads:window.__workspaceSourceGetFileCalls||0,contentReads:window.__workspaceSourceContentReads||0,handleName:handle.result?.name||"",error:!document.querySelector("#errorBanner").hidden,message:document.querySelector("#errorBanner span")?.textContent||""})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (afterReload.error || afterReload.contentReads !== 0 || afterReload.handleName !== "workspace-source-recovery.csv") {
    throw new Error(`Saved file handle was not inspected without parsing outside engineer mode: ${JSON.stringify(afterReload)}`);
  }

  await evaluate(`document.querySelector("#engineeringModeButton").click()`);
  await evaluate(`(()=>{const input=document.querySelector("#engineeringPassword");input.value=${JSON.stringify(smokeEngineerPassword)};input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#engineeringModeForm").requestSubmit()})()`);
  let engineerRestored = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    engineerRestored = await evaluate(`document.querySelector("#engineeringModeButton")?.textContent.includes("Инженер")`);
    if (engineerRestored) break;
  }
  if (!engineerRestored) throw new Error("Could not re-authenticate before restoring the workspace source file");
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  let restoredSource = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(100);
    restoredSource = await evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get("db");const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(["settings","snapshots","inventory","fileHandles"],"readonly");const active=tx.objectStore("settings").get("activeSnapshotId");const snapshots=tx.objectStore("snapshots").getAll();const inventory=tx.objectStore("inventory").count();const handles=tx.objectStore("fileHandles").get("workspace-source:main");tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value||"",finals:snapshots.result.filter(item=>item.kind!=="single").length,inventoryCount:inventory.result,handleName:handles.result?.name||"",fileStatus:document.querySelector("#mainFileStatus")?.textContent||"",mappingSelections:Object.fromEntries([...document.querySelectorAll("#mainMapping [data-mapping-field]")].map(control=>[control.dataset.mappingField,control.value])),reads:window.__workspaceSourceGetFileCalls||0,contentReads:window.__workspaceSourceContentReads||0,error:!document.querySelector("#errorBanner").hidden,message:document.querySelector("#errorBanner span")?.textContent||""})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (restoredSource.error) throw new Error(`Workspace file recovery raised an app error: ${restoredSource.message}`);
    if (restoredSource.fileStatus.includes("workspace-source-recovery.csv")) break;
  }
  if (restoredSource.error || restoredSource.activeId !== baseline.activeId || restoredSource.finals !== 1 || restoredSource.inventoryCount !== 1
    || restoredSource.handleName !== "workspace-source-recovery.csv" || !restoredSource.fileStatus.includes("workspace-source-recovery.csv")
    || restoredSource.mappingSelections.mac !== "0" || restoredSource.mappingSelections.deviceId !== "1"
    || restoredSource.mappingSelections.manufacturer !== "2" || restoredSource.mappingSelections.model !== "3"
    || restoredSource.reads <= afterReload.reads || restoredSource.contentReads < 1) {
    throw new Error(`Engineer login did not restore the saved original while preserving Final: ${JSON.stringify({baseline,afterReload,restoredSource})}`);
  }
  console.log(JSON.stringify({workspaceSourceHandleRestartOnly:true,baseline,selectedSource,afterReload,restoredSource,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--historical-address-consensus-only")) {
  const databaseName = new URL(target.url).searchParams.get("db");
  let engineerActive = await evaluate(`document.querySelector("#engineeringModeButton")?.textContent.includes("Инженер")`);
  if (!engineerActive) {
    await evaluate(`document.querySelector("#engineeringModeButton").click()`);
    await evaluate(`(()=>{const input=document.querySelector("#engineeringPassword");input.value=${JSON.stringify(smokeEngineerPassword)};input.dispatchEvent(new Event("input",{bubbles:true}));const confirmField=document.querySelector("#engineeringPasswordConfirmField");if(!confirmField.hidden){const confirm=document.querySelector("#engineeringPasswordConfirm");confirm.value=${JSON.stringify(smokeEngineerPassword)};confirm.dispatchEvent(new Event("input",{bubbles:true}))}document.querySelector("#engineeringModeForm").requestSubmit()})()`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(100);
      engineerActive = await evaluate(`document.querySelector("#engineeringModeButton")?.textContent.includes("Инженер")`);
      if (engineerActive) break;
    }
  }
  if (!engineerActive) throw new Error("Could not authenticate disposable engineer mode for historical-address smoke");
  let nextMac = 1;
  const macFor = (index) => `02:64:${((index >>> 24) & 255).toString(16).padStart(2,"0")}:${((index >>> 16) & 255).toString(16).padStart(2,"0")}:${((index >>> 8) & 255).toString(16).padStart(2,"0")}:${(index & 255).toString(16).padStart(2,"0")}`;
  const makeRows = (snapshot, groups) => groups.flatMap(({switchIp,address,count}) => Array.from({length:count},(_,index)=>({mac:macFor(nextMac),deviceId:`HIST-${snapshot}-${nextMac++}`,switchIp,address})));
  const createFinal = async (fileName, rows, expectedFinals) => {
    await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
    const csv = ["MAC;Device ID;IP коммутатора;Адрес", ...rows.map((row)=>`${row.mac};${row.deviceId};${row.switchIp};${row.address}`)].join("\n");
    await assignInput("#mainFileInput", fileName, csv);
    for (const [field,index] of [["mac",0],["deviceId",1],["switchIp",2],["address",3]]) {
      const selected = await evaluate(`(()=>{const control=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!control)throw new Error('Missing Main mapping ${field}');control.value=${index};control.dispatchEvent(new Event('change',{bubbles:true}));return control.value})()`);
      if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${selected}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector("#runEnrichmentButton").click()`);
    let result = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await wait(100);
      result = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(databaseName)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(["settings","snapshots","snapshotChunks","switchAddressEvidence","inventory"],"readonly");const active=tx.objectStore("settings").get("activeSnapshotId");const snapshots=tx.objectStore("snapshots").getAll();const chunks=tx.objectStore("snapshotChunks").getAll();const evidence=tx.objectStore("switchAddressEvidence").getAll();const inventory=tx.objectStore("inventory").count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value||"",finals:snapshots.result.filter(item=>item.kind!=="single").length,inventoryCount:inventory.result,evidence:evidence.result.map(({switchIp,address,deviceCount,snapshotId})=>({switchIp,address,deviceCount,snapshotId})),devices:chunks.result.filter(chunk=>chunk.snapshotId===active.result?.value).flatMap(chunk=>chunk.devices||[]),error:!document.querySelector("#errorBanner").hidden,message:document.querySelector("#errorBanner span")?.textContent||"",summary:document.querySelector("#enrichmentSummary")?.textContent.replace(/\\s+/g," ")||""})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
      if (result.error) throw new Error(`Historical address Final failed for ${fileName}: ${result.message}`);
      if (result.finals === expectedFinals) break;
    }
    if (result.finals !== expectedFinals || !result.activeId || result.devices.length !== rows.length) throw new Error(`Expected ${expectedFinals} complete historical-evidence Finals after ${fileName}: ${JSON.stringify({...result,devices:result.devices.length})}`);
    return result;
  };
  const switchConfirmed = "10.40.0.80";
  const switchReview = "10.40.0.81";
  const addressA = "Test Address A";
  const addressB = "Test Address B";
  await createFinal("address-evidence-1.csv", makeRows("F1", [
    {switchIp:switchConfirmed,address:addressA,count:45},
    {switchIp:switchReview,address:addressA,count:30},
    {switchIp:switchReview,address:addressB,count:6},
  ]), 1);
  await createFinal("address-evidence-2.csv", makeRows("F2", [
    {switchIp:switchConfirmed,address:addressA,count:45},
    {switchIp:switchReview,address:addressA,count:30},
    {switchIp:switchReview,address:addressB,count:5},
  ]), 2);
  await createFinal("address-evidence-3.csv", makeRows("F3", [
    {switchIp:switchConfirmed,address:addressA,count:10},
    {switchIp:switchReview,address:addressA,count:29},
  ]), 3);
  const targets = [
    {mac:macFor(nextMac++),deviceId:"HIST-TARGET-CONFIRMED",switchIp:switchConfirmed,address:""},
    {mac:macFor(nextMac++),deviceId:"HIST-TARGET-REVIEW",switchIp:switchReview,address:""},
    {mac:macFor(nextMac++),deviceId:"HIST-TARGET-KNOWN",switchIp:switchConfirmed,address:"Current Main Address"},
  ];
  const current = await createFinal("address-evidence-current.csv",targets,4);
  const byId = Object.fromEntries(current.devices.filter((device)=>String(device.deviceId||"").startsWith("HIST-TARGET-")).map((device)=>[device.deviceId,device]));
  const confirmed = byId["HIST-TARGET-CONFIRMED"];
  const review = byId["HIST-TARGET-REVIEW"];
  const known = byId["HIST-TARGET-KNOWN"];
  if (!confirmed || confirmed.address !== addressA || confirmed.fieldSources?.address !== "Historical switch IP mapping"
    || confirmed.addressConfidence < 0.8 || confirmed.addressEvidence?.length !== 3
    || !review || review.address || review.fieldSources?.address === "Historical switch IP mapping"
    || !known || known.address !== "Current Main Address" || known.fieldSources?.address === "Historical switch IP mapping"
    || current.evidence.filter((item)=>item.switchIp===switchConfirmed).reduce((sum,item)=>sum+item.deviceCount,0)!==101
    || current.evidence.some((item)=>item.switchIp===switchConfirmed&&item.snapshotId===current.activeId&&item.address===addressA)
    || current.evidence.filter((item)=>item.switchIp===switchReview).reduce((sum,item)=>sum+item.deviceCount,0)!==100) {
    throw new Error(`Historical inference did not preserve consensus/evidence/current values: ${JSON.stringify({confirmed,review,known,evidence:current.evidence})}`);
  }
  await evaluate(`document.querySelector('#enrichmentSummary [data-historical-address-details] details summary')?.click()`);
  const details = await evaluate(`(()=>({summary:document.querySelector('#enrichmentSummary [data-historical-address-details] summary')?.textContent||"",rows:[...document.querySelectorAll('#enrichmentSummary [data-historical-address-details] tbody tr')].map(row=>row.textContent.replace(/\\s+/g," ")),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||""}))()`);
  if (details.error || !details.summary.includes("применено 1") || !details.summary.includes("кандидатов 2")
    || !details.rows.some((row)=>row.includes(switchConfirmed)&&row.includes("Подтверждено")&&row.includes("Test Address A")&&row.includes("99%"))
    || !details.rows.some((row)=>row.includes(switchReview)&&row.includes("Нужна проверка"))) {
    throw new Error(`Historical address evidence details do not match persisted consensus: ${JSON.stringify(details)}`);
  }
  console.log(JSON.stringify({historicalAddressConsensusOnly:true,finalCount:current.finals,confirmed:{switchIp:switchConfirmed,address:confirmed.address,confidence:confirmed.addressConfidence,evidenceCount:confirmed.addressEvidence.length},review:{switchIp:switchReview,address:review.address||"",evidence:current.evidence.filter((item)=>item.switchIp===switchReview)},preservedCurrent:known.address,details,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--ip-address-mapping-workflow-only")) {
  const databaseName = new URL(target.url).searchParams.get("db");
  const authenticated = await evaluate(`document.querySelector("#engineeringModeButton")?.textContent.includes("Инженер")`);
  if (!authenticated) {
    await evaluate(`document.querySelector("#engineeringModeButton").click()`);
    await evaluate(`(()=>{const password=${JSON.stringify(smokeEngineerPassword)};const input=document.querySelector("#engineeringPassword");input.value=password;input.dispatchEvent(new Event("input",{bubbles:true}));const confirm=document.querySelector("#engineeringPasswordConfirm");if(confirm&&!document.querySelector("#engineeringPasswordConfirmField").hidden){confirm.value=password;confirm.dispatchEvent(new Event("input",{bubbles:true}))}document.querySelector("#engineeringModeForm").requestSubmit()})()`);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(100);
      ready = await evaluate(`document.querySelector("#engineeringModeButton")?.textContent.includes("Инженер")`);
      if (ready) break;
    }
    if (!ready) throw new Error("Could not authenticate disposable engineer mode for IP mapping smoke");
  }
  const createFinal = async (fileName, csv, expectedFinals) => {
    await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
    await assignInput("#mainFileInput", fileName, csv);
    for (const [field, index] of [["mac", 0], ["deviceId", 1], ["switchIp", 2], ["address", 3]]) {
      const value = await evaluate(`(()=>{const control=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!control)throw new Error("Missing Main mapping ${field}");control.value="${index}";control.dispatchEvent(new Event("change",{bubbles:true}));return control.value})()`);
      if (value !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${value}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector("#runEnrichmentButton").click()`);
    let result = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await wait(100);
      result = await evaluate(`(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(${JSON.stringify(databaseName)});open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction(["settings","snapshots","snapshotChunks"],"readonly");const active=tx.objectStore("settings").get("activeSnapshotId");const snapshots=tx.objectStore("snapshots").getAll();const chunks=tx.objectStore("snapshotChunks").getAll();tx.oncomplete=()=>{const activeId=active.result?.value||"";const finals=snapshots.result.filter(item=>item.kind!=="single");const snapshot=finals.find(item=>item.id===activeId);const devices=chunks.result.filter(item=>item.snapshotId===activeId).flatMap(item=>item.devices||[]);db.close();resolve({activeId,finals:finals.length,snapshot:snapshot?{id:snapshot.id,createdAt:snapshot.createdAt}:null,devices,error:!document.querySelector("#errorBanner").hidden,message:document.querySelector("#errorBanner span")?.textContent||""})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
      if (result.error) throw new Error(`Main Final failed for ${fileName}: ${result.message}`);
      if (result.finals === expectedFinals) break;
    }
    if (result?.finals !== expectedFinals || !result.snapshot || result.devices.length === 0) throw new Error(`Expected ${expectedFinals} complete Final after ${fileName}: ${JSON.stringify(result)}`);
    return result;
  };
  const firstFinal = await createFinal("ip-mapping-source.csv", "MAC;Device ID;IP коммутатора;Адрес\n02:65:00:00:00:01;IPMAP-SOURCE-1;10.65.0.1;Auto Address", 1);
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  let controlsReady = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    controlsReady = await evaluate(`Boolean(document.querySelector("#importIpMappingsInput")&&document.querySelector("#detectIpMappingsButton"))`);
    if (controlsReady) break;
  }
  if (!controlsReady) throw new Error("IP mapping controls did not mount in the data view");
  await evaluate(`document.querySelector("#detectIpMappingsButton").click()`);
  let detected = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    detected = await evaluate(`document.querySelector("#ipMappingStatus")?.textContent.includes("Добавлено однозначных правил: 1")`);
    if (detected) break;
  }
  if (!detected) throw new Error("Auto-detection did not add the one exact address supported by the active Final");
  await evaluate(`(()=>{const input=document.querySelector("#importIpMappingsInput");const file=new File(["Switch IP;Physical address\\n10.65.0.2;Imported Address"],"ip-mapping-import.csv",{type:"text/csv"});const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}))})()`);
  let importReady = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    importReady = await evaluate(`(()=>({visible:!document.querySelector("#ipMappingImportPanel").hidden,disabled:document.querySelector("#confirmIpMappingImportButton")?.disabled,switchIndex:document.querySelector("#ipMappingImportSwitchColumn")?.value,addressIndex:document.querySelector("#ipMappingImportAddressColumn")?.value}))()`);
    if (importReady.visible) break;
  }
  if (!importReady?.visible || importReady.disabled || importReady.switchIndex !== "0" || importReady.addressIndex !== "1") throw new Error(`IP import suggestions were not actionable: ${JSON.stringify(importReady)}`);
  await evaluate(`document.querySelector("#confirmIpMappingImportButton").click()`);
  let imported = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    imported = await evaluate(`document.querySelector("#ipMappingList")?.textContent.includes("10.65.0.2")&&document.querySelector("#ipMappingList")?.textContent.includes("Imported Address")`);
    if (imported) break;
  }
  if (!imported) throw new Error("Confirmed CSV import did not add the selected switch-IP rule");
  await evaluate(`(()=>{document.querySelector("#ipMappingSwitchInput").value="10.65.0.3";document.querySelector("#ipMappingAddressInput").value="Manual Address";document.querySelector("#addIpMappingButton").click()})()`);
  let manuallySaved = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    manuallySaved = await evaluate(`document.querySelector("#ipMappingList")?.textContent.includes("10.65.0.3")&&document.querySelector("#ipMappingList")?.textContent.includes("Manual Address")`);
    if (manuallySaved) break;
  }
  if (!manuallySaved) throw new Error("Manual IP mapping was not saved through the UI");
  await evaluate(`document.querySelector("#ipEnrichmentEnabled").checked=false;document.querySelector("#saveIpEnrichmentSettingsButton").click()`);
  let disabledForFinal = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    disabledForFinal = await evaluate(`!document.querySelector("#ipEnrichmentEnabled").checked&&document.querySelector("#ipEnrichmentStatus")?.textContent.includes("Настройки сохранены локально")`);
    if (disabledForFinal) break;
  }
  if (!disabledForFinal) throw new Error("Could not disable automatic mapping during the explicit-apply setup");
  const beforeApply = await createFinal("ip-mapping-target.csv", "MAC;Device ID;IP коммутатора;Адрес\n02:65:00:00:00:02;IPMAP-TARGET-1;10.65.0.1;\n02:65:00:00:00:03;IPMAP-TARGET-2;10.65.0.2;\n02:65:00:00:00:04;IPMAP-TARGET-3;10.65.0.3;\n02:65:00:00:00:05;IPMAP-TARGET-4;10.65.0.4;Existing Address", 2);
  await evaluate(`document.querySelector('[data-view="data"]').click();document.querySelector("#ipEnrichmentEnabled").checked=true;document.querySelector("#saveIpEnrichmentSettingsButton").click()`);
  let enabledForApply = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    enabledForApply = await evaluate(`document.querySelector("#ipEnrichmentEnabled").checked&&document.querySelector("#ipEnrichmentStatus")?.textContent.includes("Настройки сохранены локально")`);
    if (enabledForApply) break;
  }
  if (!enabledForApply) throw new Error("Could not enable local IP rules before explicit apply");
  await evaluate(`document.querySelector("#applyIpMappingsButton").click()`);
  let applied = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    applied = await evaluate(`(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(${JSON.stringify(databaseName)});open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction(["settings","snapshots","snapshotChunks","inventory"],"readonly");const active=tx.objectStore("settings").get("activeSnapshotId");const snapshots=tx.objectStore("snapshots").getAll();const chunks=tx.objectStore("snapshotChunks").getAll();const inventory=tx.objectStore("inventory").getAll();tx.oncomplete=()=>{const activeId=active.result?.value||"";const snapshot=snapshots.result.find(item=>item.id===activeId);const devices=chunks.result.filter(item=>item.snapshotId===activeId).flatMap(item=>item.devices||[]);const inv=new Map(inventory.result.map(item=>[item.deviceId||item.mac,item]));db.close();resolve({activeId,snapshot:snapshot?{id:snapshot.id,createdAt:snapshot.createdAt}:null,devices:devices.map(({deviceId,address,fieldSources})=>({deviceId,address,source:fieldSources?.address})),inventory:devices.map(({deviceId})=>inv.get(deviceId)?.address||"").filter(Boolean),finalCount:snapshots.result.filter(item=>item.kind!=="single").length,error:!document.querySelector("#errorBanner").hidden,message:document.querySelector("#errorBanner span")?.textContent||"",status:document.querySelector("#ipMappingStatus")?.textContent||""})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (!applied.error && applied.status.includes("заполнено адресов 3")) break;
  }
  const byId = Object.fromEntries((applied?.devices||[]).map(item=>[item.deviceId,item]));
  if (!applied || applied.error || applied.finalCount !== 2 || applied.activeId !== beforeApply.activeId
    || applied.snapshot?.id !== beforeApply.snapshot.id || applied.snapshot?.createdAt !== beforeApply.snapshot.createdAt
    || byId["IPMAP-TARGET-1"]?.address !== "Auto Address" || byId["IPMAP-TARGET-1"]?.source !== "Автоопределение из активного Final"
    || byId["IPMAP-TARGET-2"]?.address !== "Imported Address" || byId["IPMAP-TARGET-2"]?.source !== "Файл: ip-mapping-import.csv"
    || byId["IPMAP-TARGET-3"]?.address !== "Manual Address" || byId["IPMAP-TARGET-4"]?.address !== "Existing Address"
    || !applied.inventory.includes("Auto Address") || !applied.inventory.includes("Imported Address") || !applied.inventory.includes("Manual Address")) {
    throw new Error(`Applying local mappings changed Final identity/date, lost provenance, overwrote a known address, or failed Inventory sync: ${JSON.stringify({firstFinal:firstFinal.snapshot,beforeApply:beforeApply.snapshot,applied})}`);
  }
  console.log(JSON.stringify({ipAddressMappingWorkflowOnly:true,firstFinal:firstFinal.snapshot,applied:{snapshot:applied.snapshot,finalCount:applied.finalCount,devices:applied.devices,inventoryAddressCount:applied.inventory.length},importSuggestedColumns:importReady,manualRule:manuallySaved,autoDetected:detected,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--smartroom-mapping-workflow-only")) {
  const databaseName = new URL(target.url).searchParams.get("db");
  let engineerActive = await evaluate(`document.querySelector("#engineeringModeButton")?.textContent.includes("Инженер")`);
  if (!engineerActive) {
    await evaluate(`document.querySelector("#engineeringModeButton").click()`);
    await evaluate(`(()=>{const password=${JSON.stringify(smokeEngineerPassword)};const input=document.querySelector("#engineeringPassword");input.value=password;input.dispatchEvent(new Event("input",{bubbles:true}));const confirm=document.querySelector("#engineeringPasswordConfirm");if(confirm&&!document.querySelector("#engineeringPasswordConfirmField").hidden){confirm.value=password;confirm.dispatchEvent(new Event("input",{bubbles:true}))}document.querySelector("#engineeringModeForm").requestSubmit()})()`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(100);
      engineerActive = await evaluate(`document.querySelector("#engineeringModeButton")?.textContent.includes("Инженер")`);
      if (engineerActive) break;
    }
  }
  if (!engineerActive) throw new Error("Could not authenticate disposable engineer mode for Smartroom mapping smoke");
  const macFor = (value) => `02:66:00:00:00:${Number(value).toString(16).padStart(2, "0")}`;
  const createFinal = async (fileName, rows, expectedFinals) => {
    await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
    await assignInput("#mainFileInput", fileName, `MAC;Device ID;Smartroom ID;Название комнаты\n${rows.map(({mac,deviceId,smartroomId,room}) => `${mac};${deviceId};${smartroomId};${room}`).join("\n")}`);
    for (const [field,index] of [["mac",0],["deviceId",1],["smartroomId",2],["room",3]]) {
      const selected = await evaluate(`(()=>{const input=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!input)throw new Error('Missing Main mapping ${field}');input.value='${index}';input.dispatchEvent(new Event('change',{bubbles:true}));return input.value})()`);
      if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${selected}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector("#runEnrichmentButton").click()`);
    let result = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await wait(100);
      result = await evaluate(`(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(${JSON.stringify(databaseName)});open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction(["settings","snapshots","snapshotChunks","smartroomRoomMappings"],"readonly");const active=tx.objectStore("settings").get("activeSnapshotId");const snapshots=tx.objectStore("snapshots").getAll();const chunks=tx.objectStore("snapshotChunks").getAll();const good=tx.objectStore("smartroomRoomMappings").get("sr-room-10");const conflict=tx.objectStore("smartroomRoomMappings").get("sr-room-conflict");tx.oncomplete=()=>{const activeId=active.result?.value||"";const snapshot=snapshots.result.find(item=>item.id===activeId);const devices=chunks.result.filter(item=>item.snapshotId===activeId).flatMap(item=>item.devices||[]);db.close();resolve({activeId,snapshot:snapshot?{id:snapshot.id,createdAt:snapshot.createdAt,diagnostics:snapshot.diagnostics?.counts||{}}:null,devices:devices.map(({deviceId,smartroomId,room,fieldSources,roomConfidence,roomEvidence})=>({deviceId,smartroomId,room,source:fieldSources?.room,roomConfidence,roomEvidence})),good:good.result||null,conflict:conflict.result||null,finalCount:snapshots.result.filter(item=>item.kind!=="single").length,error:!document.querySelector("#errorBanner").hidden,message:document.querySelector("#errorBanner span")?.textContent||"",summary:document.querySelector("#enrichmentSummary")?.textContent.replace(/\\s+/g," ")||""})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
      if (result.error) throw new Error(`Smartroom Final failed for ${fileName}: ${result.message}`);
      if (result.finalCount === expectedFinals) break;
    }
    if (result?.finalCount !== expectedFinals || !result.snapshot || result.devices.length !== rows.length) throw new Error(`Expected ${expectedFinals} complete Smartroom Finals after ${fileName}: ${JSON.stringify(result)}`);
    return result;
  };
  const sourceRows = [
    ...Array.from({length:7},(_,index)=>({mac:macFor(index+1),deviceId:`SRMAP-SOURCE-${index+1}`,smartroomId:"SR-ROOM-10",room:"Conference Room 10"})),
    {mac:macFor(8),deviceId:"SRMAP-CONFLICT-1",smartroomId:"SR-ROOM-CONFLICT",room:"Conflict West"},
    {mac:macFor(9),deviceId:"SRMAP-CONFLICT-2",smartroomId:"SR-ROOM-CONFLICT",room:"Conflict East"},
  ];
  const source = await createFinal("smartroom-mapping-source.csv",sourceRows,1);
  if (source.good?.status !== "confirmed" || source.good?.room !== "Conference Room 10" || source.good?.deviceCount !== 7
    || source.good?.sourceFinalId !== source.activeId || source.good?.sampleMacs?.length !== 5
    || source.conflict?.status !== "review" || source.conflict?.room || source.conflict?.alternatives?.length !== 2) {
    throw new Error(`Final did not atomically learn exact Smartroom room evidence or preserve the conflict: ${JSON.stringify({good:source.good,conflict:source.conflict})}`);
  }
  const nextRows = [
    ...Array.from({length:7},(_,index)=>({mac:macFor(index+20),deviceId:`SRMAP-CURRENT-${index+1}`,smartroomId:"SR-ROOM-10",room:""})),
    {mac:macFor(29),deviceId:"SRMAP-CURRENT-CONFLICT",smartroomId:"SR-ROOM-CONFLICT",room:""},
  ];
  const current = await createFinal("smartroom-mapping-current.csv",nextRows,2);
  const knownRows = current.devices.filter((item)=>item.smartroomId==="SR-ROOM-10");
  const unresolved = current.devices.find((item)=>item.deviceId==="SRMAP-CURRENT-CONFLICT");
  if (current.snapshot.diagnostics.historicalSmartroomRoomFilled !== 7 || knownRows.length !== 7
    || knownRows.some((item)=>item.room!=="Conference Room 10"||item.source!=="Historical Smartroom ID mapping"||item.roomConfidence!==0.9
      || item.roomEvidence?.smartroomId!=="SR-ROOM-10")
    || !unresolved || unresolved.room || unresolved.source
    || current.good?.status!=="confirmed"||current.good?.deviceCount!==7||current.good?.sourceFinalId!==current.activeId
    || current.activeId===source.activeId || current.finalCount!==2 || current.error) {
    throw new Error(`Later enrichment did not apply only the confirmed stable Smartroom mapping: ${JSON.stringify({sourceId:source.activeId,current})}`);
  }
  console.log(JSON.stringify({smartroomMappingWorkflowOnly:true,sourceMapping:{status:source.good.status,room:source.good.room,deviceCount:source.good.deviceCount,samples:source.good.sampleMacs.length},conflict:{status:source.conflict.status,alternatives:source.conflict.alternatives.length},current:{filled:current.snapshot.diagnostics.historicalSmartroomRoomFilled,room:knownRows[0]?.room,source:knownRows[0]?.source,unresolved:unresolved?.room||"",finalCount:current.finalCount},ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--data-directory-write-failure-only")) {
  const databaseName = new URL(target.url).searchParams.get("db");
  const createFinal = async (fileName, mac, deviceId, model, expectedFinals) => {
    await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
    await assignInput("#mainFileInput", fileName, `MAC;Device ID;Производитель;Модель\n${mac};${deviceId};Write Failure Smoke;${model}`);
    for (const [field, index] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3]]) {
      const selected = await evaluate(`(()=>{const control=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!control)throw new Error('Missing Main mapping ${field}');control.value=${index};control.dispatchEvent(new Event('change',{bubbles:true}));return control.value})()`);
      if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${selected}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
    let result = null;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await wait(100);
      result = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(databaseName)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();const inventory=tx.objectStore('inventory').count();tx.oncomplete=()=>{db.close();const finals=snapshots.result.filter(item=>item.kind!=='single');resolve({activeId:active.result?.value||'',finals:finals.map(item=>({id:item.id,deviceCount:item.deviceCount})),inventoryCount:inventory.result,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
      if (result.error) throw new Error(`Enrichment failed while creating ${fileName}: ${result.message}`);
      if (result.finals.length === expectedFinals) break;
    }
    if (result.finals.length !== expectedFinals || !result.finals.some((item) => item.id === result.activeId && item.deviceCount === 1) || result.inventoryCount !== expectedFinals) {
      throw new Error(`Enrichment did not persist exactly ${expectedFinals} disposable Final records: ${JSON.stringify(result)}`);
    }
    return result;
  };
  let engineerActive = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes('Инженер')`);
  if (!engineerActive) {
    await evaluate(`document.querySelector('#engineeringModeButton').click()`);
    await evaluate(`(()=>{const input=document.querySelector('#engineeringPassword');input.value=${JSON.stringify(smokeEngineerPassword)};input.dispatchEvent(new Event('input',{bubbles:true}));const confirmField=document.querySelector('#engineeringPasswordConfirmField');if(!confirmField.hidden){const confirm=document.querySelector('#engineeringPasswordConfirm');confirm.value=${JSON.stringify(smokeEngineerPassword)};confirm.dispatchEvent(new Event('input',{bubbles:true}))}document.querySelector('#engineeringModeForm').requestSubmit();return true})()`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(100);
      engineerActive = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes('Инженер')`);
      if (engineerActive) break;
    }
  }
  if (!engineerActive) throw new Error("Could not authenticate disposable engineer mode for archive write failure smoke");
  const beforeFailure = await createFinal("archive-write-failure-before.csv", "02:62:00:00:01:71", "WRITE-FAILURE-BEFORE", "Existing Final", 1);
  const opfsDirectoryName = `mac-analyzer-write-failure-${crypto.randomUUID()}`;
  const installDirectoryShim = `(()=>{const run=async()=>{const root=await navigator.storage.getDirectory();const directory=await root.getDirectoryHandle(${JSON.stringify(opfsDirectoryName)},{create:true});const proto=Object.getPrototypeOf(directory);if(typeof proto.queryPermission!=="function"||typeof proto.requestPermission!=="function")throw new Error("File System Access permission methods are unavailable");Object.defineProperty(proto,"queryPermission",{configurable:true,value:async()=>"granted"});Object.defineProperty(proto,"requestPermission",{configurable:true,value:async()=>"granted"});Object.defineProperty(globalThis,"showDirectoryPicker",{configurable:true,value:async()=>directory});window.__writeFailureDirectory=directory;window.__writeFailureReady=true};run().catch(error=>{window.__writeFailureError=error.message})})()`;
  await command("Page.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: installDirectoryShim });
  await evaluate(installDirectoryShim);
  let shimState = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(50);
    shimState = await evaluate(`({ready:Boolean(window.__writeFailureReady),error:window.__writeFailureError||''})`);
    if (shimState.ready || shimState.error) break;
  }
  if (!shimState.ready) throw new Error(`Could not create disposable OPFS folder: ${shimState.error}`);
  await evaluate(`(()=>{const proto=FileSystemFileHandle.prototype;const native=proto.createWritable;let attempts=0;Object.defineProperty(proto,"createWritable",{configurable:true,value:async function(...args){if(this.name==="mac-analyzer-data.madb"){attempts+=1;if(attempts===1)throw new DOMException("Synthetic write permission denied","NotAllowedError")}return native.apply(this,args)}});window.__archiveWriteFailureAttempts=()=>attempts})()`);
  await evaluate(`document.querySelector('[data-view="data"]').click();document.querySelector('#chooseDataDirectoryButton').click()`);
  let failedWrite = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    failedWrite = await evaluate(`(()=>({status:document.querySelector('#dataDirectoryStatus')?.textContent||'',permissionButtonHidden:document.querySelector('#dataDirectoryButton')?.hidden,otherFolderButtonText:document.querySelector('#dataDirectoryButton')?.textContent.trim()||'',writeAttempts:window.__archiveWriteFailureAttempts(),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (failedWrite.error) throw new Error(`Data-directory archive failure surfaced as an application error: ${failedWrite.message}`);
    if (failedWrite.writeAttempts === 1 && failedWrite.status.includes('Запись архива не выполнена')) break;
  }
  if (failedWrite.writeAttempts !== 1 || !failedWrite.status.includes('Synthetic write permission denied') || !failedWrite.status.includes('Final сохранён в IndexedDB; выберите папку с правом записи')
      || failedWrite.permissionButtonHidden || !failedWrite.otherFolderButtonText.includes('Выбрать другую папку')) {
    throw new Error(`Failed MADB write did not disable the handle and show exact recovery instructions: ${JSON.stringify(failedWrite)}`);
  }
  const afterFailure = await createFinal("archive-write-failure-after.csv", "02:62:00:00:01:72", "WRITE-FAILURE-AFTER", "New Final After Write Error", 2);
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  const finalState = await evaluate(`(()=>({directoryStatus:document.querySelector('#dataDirectoryStatus')?.textContent||'',otherFolderButton:{hidden:document.querySelector('#dataDirectoryButton')?.hidden,text:document.querySelector('#dataDirectoryButton')?.textContent.trim()||''},chooseFolderButton:{hidden:document.querySelector('#chooseDataDirectoryButton')?.hidden,text:document.querySelector('#chooseDataDirectoryButton')?.textContent.trim()||''},error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',writeAttempts:window.__archiveWriteFailureAttempts()}))()`);
  if (finalState.error || finalState.writeAttempts !== 1 || afterFailure.finals.length !== 2 || afterFailure.activeId === beforeFailure.activeId
      || !afterFailure.finals.some((item) => item.id === beforeFailure.activeId) || afterFailure.inventoryCount !== 2
      || !finalState.directoryStatus.includes('Final сохранён в IndexedDB; выберите папку с правом записи')
      || finalState.otherFolderButton.hidden || !finalState.otherFolderButton.text.includes('Выбрать другую папку')) {
    throw new Error(`Enrichment did not continue with both Final records intact after MADB write failure: ${JSON.stringify({beforeFailure,failedWrite,afterFailure,finalState})}`);
  }
  console.log(JSON.stringify({ dataDirectoryWriteFailureOnly: true, beforeFailure, failedWrite, afterFailure, finalState, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
if (process.argv.includes("--data-directory-populated-startup-restore-only")) {
  const mainUrl = target.url;
  const mainDatabase = new URL(mainUrl).searchParams.get("db");
  const sourceDatabase = `mac-analyzer-pro-next-test-source-${crypto.randomUUID()}`;
  const sourceUrl = new URL(mainUrl);
  sourceUrl.searchParams.set("db", sourceDatabase);
  const ensureEngineer = async () => {
    let active = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes('Инженер')`);
    if (!active) {
      await evaluate(`document.querySelector('#engineeringModeButton')?.click()`);
      await evaluate(`(()=>{const input=document.querySelector('#engineeringPassword');input.value=${JSON.stringify(smokeEngineerPassword)};input.dispatchEvent(new Event('input',{bubbles:true}));const confirmField=document.querySelector('#engineeringPasswordConfirmField');if(!confirmField.hidden){const confirm=document.querySelector('#engineeringPasswordConfirm');confirm.value=${JSON.stringify(smokeEngineerPassword)};confirm.dispatchEvent(new Event('input',{bubbles:true}))}document.querySelector('#engineeringModeForm').requestSubmit();return true})()`);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await wait(100);
        active = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes('Инженер')`);
        if (active) break;
      }
    }
    if (!active) throw new Error('Could not authenticate disposable engineer mode for the data-directory restore smoke');
  };
  const createFinal = async (fileName, mac, deviceId, model) => {
    await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
    await assignInput("#mainFileInput", fileName, `MAC;Device ID;Производитель;Модель\n${mac};${deviceId};Restore Smoke;${model}`);
    for (const [field, index] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3]]) {
      const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
      if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${selected}`);
    }
    await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
    let status = "";
    for (let attempt = 0; attempt < 140; attempt += 1) {
      await wait(100);
      const current = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
      if (current.error) throw new Error(`Could not create ${fileName}: ${current.message}`);
      status = current.status;
      if (status.includes('1 Final') && status.includes('1 устройств')) break;
    }
    if (!status.includes('1 Final') || !status.includes('1 устройств')) throw new Error(`${fileName} did not save one Final device: ${status}`);
    return await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const rows=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value||'',finals:rows.result.filter(item=>item.kind!=='single').map(item=>({id:item.id,deviceCount:item.deviceCount}))})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  };

  await command("Page.navigate", { url: sourceUrl.href });
  await wait(1_000);
  await ensureEngineer();
  const sourceFinal = await createFinal("startup-archive-source.csv", "02:62:00:00:00:01", "RESTORE-ARCHIVE", "Archive Device");
  const captureExport = await evaluate(`(()=>{const nativeCreate=URL.createObjectURL.bind(URL);window.__dataRestoreArchiveBlob=null;URL.createObjectURL=(blob)=>{const url=nativeCreate(blob);if(blob.type.includes('json'))window.__dataRestoreArchiveBlob=blob;return url};const nativeClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download.endsWith('.madb.json'))window.__dataRestoreArchiveName=this.download;else nativeClick.call(this)}})()`);
  void captureExport;
  await evaluate(`Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:undefined});document.querySelector('[data-view="data"]').click();document.querySelector('#exportDatabaseButton').click()`);
  let archiveCapture = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    archiveCapture = await evaluate(`(()=>({name:window.__dataRestoreArchiveName||'',text:window.__dataRestoreArchiveBlob?.text?null:null,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (archiveCapture.error) throw new Error(`Exporting the source database archive failed: ${archiveCapture.message}`);
    const captured = await evaluate(`Boolean(window.__dataRestoreArchiveBlob&&window.__dataRestoreArchiveName)`);
    if (captured) break;
  }
  if (!await evaluate(`Boolean(window.__dataRestoreArchiveBlob&&window.__dataRestoreArchiveName)`)) throw new Error(`The source database export did not produce a .madb.json download: ${JSON.stringify(archiveCapture)}`);
  const portableArchiveText = await evaluate(`window.__dataRestoreArchiveBlob.text()`);
  if (!portableArchiveText.startsWith('{') || portableArchiveText.length < 100) throw new Error('The captured source database archive is empty or not JSON');

  await command("Page.navigate", { url: mainUrl });
  await wait(1_000);
  await ensureEngineer();
  const mainFinal = await createFinal("startup-restore-newer-final.csv", "02:62:00:00:00:02", "RESTORE-NEWER", "Newer Device");
  const opfsDirectoryName = `mac-analyzer-startup-restore-${crypto.randomUUID()}`;
  const installDirectoryShim = `(()=>{const run=async()=>{const root=await navigator.storage.getDirectory();const name=${JSON.stringify(opfsDirectoryName)};const directory=await root.getDirectoryHandle(name,{create:true});const proto=Object.getPrototypeOf(directory);const nativeQuery=proto.queryPermission;const nativeRequest=proto.requestPermission;if(typeof nativeQuery!=="function"||typeof nativeRequest!=="function")throw new Error("File System Access permission methods are unavailable");Object.defineProperty(proto,"queryPermission",{configurable:true,value:async function(){return sessionStorage.getItem("mac-analyzer-startup-restore-permission")||"granted"}});Object.defineProperty(proto,"requestPermission",{configurable:true,value:async function(){sessionStorage.setItem("mac-analyzer-startup-restore-permission","granted");return"granted"}});Object.defineProperty(globalThis,"showDirectoryPicker",{configurable:true,value:async()=>directory});window.__startupRestoreDirectory=directory;window.__startupRestoreReady=true};run().catch(error=>{window.__startupRestoreError=error.message})})()`;
  await command("Page.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: installDirectoryShim });
  await evaluate(installDirectoryShim);
  let directoryShim = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(50);
    directoryShim = await evaluate(`({ready:Boolean(window.__startupRestoreReady),error:window.__startupRestoreError||''})`);
    if (directoryShim.ready || directoryShim.error) break;
  }
  if (!directoryShim.ready) throw new Error(`Could not create disposable OPFS directory: ${directoryShim.error}`);
  await evaluate(`document.querySelector('[data-view="data"]').click();document.querySelector('#chooseDataDirectoryButton').click()`);
  let directoryState = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    directoryState = await evaluate(`(()=>({status:document.querySelector('#dataDirectoryStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (directoryState.error) throw new Error(`Selecting the disposable OPFS directory failed: ${directoryState.message}`);
    if (directoryState.status.includes('Архив в выбранной папке отсутствует')) break;
  }
  if (!directoryState.status.includes('Архив в выбранной папке отсутствует')) throw new Error(`Empty disposable directory did not attach before restore test: ${JSON.stringify(directoryState)}`);
  const archiveFileState = await evaluate(`(()=>new Promise(async(resolve,reject)=>{try{const handle=await window.__startupRestoreDirectory.getFileHandle('mac-analyzer-data.madb',{create:true});const writable=await handle.createWritable();await writable.write(${JSON.stringify(portableArchiveText)});await writable.close();const file=await handle.getFile();resolve({name:file.name,size:file.size,textLength:(await file.text()).length})}catch(error){reject(error)}}))()`);
  if (archiveFileState.name !== 'mac-analyzer-data.madb' || !archiveFileState.size || archiveFileState.textLength !== portableArchiveText.length) throw new Error(`Could not seed a valid OPFS startup archive: ${JSON.stringify(archiveFileState)}`);
  const beforeReload = await evaluate(`(()=>({status:document.querySelector('#databaseStatus')?.textContent||'',db:new URL(location.href).searchParams.get('db')}))()`);
  if (!beforeReload.status.includes('1 Final') || beforeReload.db !== mainDatabase) throw new Error(`The populated main IndexedDB was not preserved before restart: ${JSON.stringify(beforeReload)}`);
  await command("Page.reload", { ignoreCache: true });
  let restored = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    restored = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(mainDatabase)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();const inventory=tx.objectStore('inventory').count();tx.oncomplete=()=>{db.close();resolve({status:document.querySelector('#databaseStatus')?.textContent||'',directoryStatus:document.querySelector('#dataDirectoryStatus')?.textContent||'',activeId:active.result?.value||'',finals:snapshots.result.filter(item=>item.kind!=='single').map(item=>({id:item.id,deviceCount:item.deviceCount})),inventoryCount:inventory.result,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (restored.error) throw new Error(`Startup directory restore raised an error: ${restored.message}`);
    if (restored.finals?.length === 2 && restored.inventoryCount >= 2 && restored.directoryStatus.includes('объединён')) break;
  }
  const sourceRestored = restored.finals?.some(item => item.id === sourceFinal.activeId);
  const newerPreserved = restored.finals?.some(item => item.id === mainFinal.activeId);
  if (!sourceRestored || !newerPreserved || restored.activeId !== mainFinal.activeId || restored.finals.length !== 2 || restored.inventoryCount < 2 || restored.error) {
    throw new Error(`Startup did not add the older folder Final while preserving populated IndexedDB and its newer active Final: ${JSON.stringify({sourceFinal,mainFinal,restored})}`);
  }
  await command("Page.reload", { ignoreCache: true });
  let repeated = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    repeated = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(mainDatabase)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value||'',finalIds:snapshots.result.filter(item=>item.kind!=='single').map(item=>item.id),error:!document.querySelector('#errorBanner').hidden})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (repeated.finalIds?.length === 2) break;
  }
  if (repeated.activeId !== mainFinal.activeId || repeated.finalIds.length !== 2 || repeated.error) throw new Error(`Repeated startup restore was not additive/idempotent: ${JSON.stringify(repeated)}`);
  console.log(JSON.stringify({dataDirectoryPopulatedStartupRestoreOnly:true,sourceDatabase,sourceFinal,mainDatabase,mainFinal,directoryState,archiveFileState,beforeReload,restored,repeated,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--period-mode-persistence-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await assignInput("#mainFileInput", "period-mode_2026-10-14.csv", "MAC;Device ID;Модель\n00:11:22:33:44:91;PERIOD-91;Period Model");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2]]) {
    const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${selected}`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let finalStatus = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    const state = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (state.error) throw new Error(`Could not create a current Final for the period-settings smoke: ${state.message}`);
    finalStatus = state.status;
    if (finalStatus.includes('1 Final')) break;
  }
  if (!finalStatus.includes('1 Final')) throw new Error(`Period-settings smoke did not create one current Final: ${finalStatus}`);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let controlsReady = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    controlsReady = await evaluate(`Boolean(document.querySelector('#dashboardComparisonMode')&&document.querySelector('#dashboardComparisonDateFrom')&&document.querySelector('#dashboardComparisonDateTo'))`);
    if (controlsReady) break;
    await wait(100);
  }
  if (!controlsReady) throw new Error('Dashboard period controls did not mount');
  const savedSelection = await evaluate(`(()=>{const mode=document.querySelector('#dashboardComparisonMode');mode.value='period';mode.dispatchEvent(new Event('change',{bubbles:true}));const from=document.querySelector('#dashboardComparisonDateFrom');const to=document.querySelector('#dashboardComparisonDateTo');from.value='2026-10-14';to.value='2026-10-14';document.querySelector('#applyDashboardPeriodButton').click();return{mode:mode.value,from:from.value,to:to.value}})()`);
  let persisted = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(100);
    persisted = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readonly');const setting=tx.objectStore('settings').get('analyticsDashboardSettings');const snapshots=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{const finals=snapshots.result.filter(item=>item.kind!=='single');db.close();resolve({settings:setting.result?.value||null,finalCount:finals.length,activeId:finals.at(-1)?.id||''})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (persisted.settings?.comparisonMode === 'period' && persisted.settings?.comparisonDateFrom === savedSelection.from && persisted.settings?.comparisonDateTo === savedSelection.to) break;
  }
  if (persisted.finalCount !== 1 || persisted.settings?.comparisonMode !== 'period' || persisted.settings.comparisonDateFrom !== savedSelection.from || persisted.settings.comparisonDateTo !== savedSelection.to) {
    throw new Error(`Period mode/range did not persist while a current Final existed: ${JSON.stringify({savedSelection,persisted})}`);
  }
  const databaseName = new URL(target.url).searchParams.get('db');
  const reloaded = await reloadDatabaseAndWait(databaseName);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let restored = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    restored = await evaluate(`(()=>({mode:document.querySelector('#dashboardComparisonMode')?.value||'',from:document.querySelector('#dashboardComparisonDateFrom')?.value||'',to:document.querySelector('#dashboardComparisonDateTo')?.value||'',current:document.querySelector('#currentSnapshotSelect')?.value||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (restored.error) throw new Error(`Restoring period mode raised an error: ${restored.message}`);
    if (restored.mode === 'period' && restored.from === savedSelection.from && restored.to === savedSelection.to && restored.current) break;
  }
  if (restored?.mode !== 'period' || restored.from !== savedSelection.from || restored.to !== savedSelection.to || !restored.current || !reloaded.status.includes('1 Final')) {
    throw new Error(`Reload replaced or lost the chosen period while a current Final remained: ${JSON.stringify({savedSelection,reloaded,restored})}`);
  }
  console.log(JSON.stringify({periodModePersistenceOnly:true,savedSelection,persisted,reloaded,restored,ok:true}));
  await command('Browser.close');
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--dashboard-settings-ui-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await assignInput("#mainFileInput", "dashboard-settings-ui.csv", "MAC;Device ID;Производитель;Модель\n02:61:00:00:00:01;SETTINGS-1;Acme;Room Bar\n02:61:00:00:00:02;SETTINGS-2;Logitech;Rally Bar");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3]]) {
    const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${selected}`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let finalReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    const state = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (state.error) throw new Error(`Dashboard settings fixture failed: ${state.message}`);
    if (state.status.includes('1 Final') && state.status.includes('2 устройств')) { finalReady = true; break; }
  }
  if (!finalReady) throw new Error('Dashboard settings fixture did not save its two-device Final');
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let analyticsReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    analyticsReady = await evaluate(`document.querySelector('#analyticsLoadingStatus').hidden&&document.querySelector('#analyticsSettingsButton')?.hidden===false`);
    if (analyticsReady) break;
  }
  if (!analyticsReady) throw new Error('Analytics and Dashboard settings control did not become ready');
  const initial = await evaluate(`(()=>{const button=document.querySelector('#analyticsSettingsButton');button.click();const dialog=document.querySelector('#analyticsDashboardSettingsDialog');return{engineerVisible:!button.hidden,dialogOpen:dialog.open,tabs:[...dialog.querySelectorAll('[role="tab"]')].map(tab=>({label:tab.textContent.trim(),selected:tab.getAttribute('aria-selected')})),kpis:dialog.querySelectorAll('[data-dashboard-widget-setting^="kpi:"]').length,charts:dialog.querySelectorAll('[data-dashboard-widget-setting^="chart:"]').length}})()`);
  if (!initial.engineerVisible || !initial.dialogOpen || initial.kpis !== 6 || initial.charts !== 5 || initial.tabs.length !== 3 || initial.tabs[0].selected !== 'true') {
    throw new Error(`Dashboard settings dialog did not expose the complete initial control set: ${JSON.stringify(initial)}`);
  }
  const keyboard = await evaluate(`(()=>{const dialog=document.querySelector('#analyticsDashboardSettingsDialog');const dispatch=(key)=>dialog.querySelector('[role="tab"][aria-selected="true"]').dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));document.querySelector('#dashboardSettingsGeneralTab').focus();dispatch('ArrowRight');const cards=document.querySelector('#dashboardSettingsCardsTab');const right=cards.getAttribute('aria-selected')==='true'&&document.activeElement===cards;dispatch('ArrowRight');const charts=document.querySelector('#dashboardSettingsChartsTab');const next=charts.getAttribute('aria-selected')==='true'&&!document.querySelector('#dashboardSettingsChartsPanel').hidden;dispatch('Home');const home=document.querySelector('#dashboardSettingsGeneralTab').getAttribute('aria-selected')==='true';dispatch('End');const end=charts.getAttribute('aria-selected')==='true'&&document.activeElement===charts;return{right,next,home,end,active:document.activeElement.id}})()`);
  if (!keyboard.right || !keyboard.next || !keyboard.home || !keyboard.end) throw new Error(`Dashboard settings tabs did not follow ArrowRight/Home/End keyboard navigation: ${JSON.stringify(keyboard)}`);
  await evaluate(`(()=>{document.querySelector('#analyticsAutoRefreshEnabled').checked=true;document.querySelector('#analyticsRefreshIntervalSeconds').value='45';document.querySelector('#dashboardSettingsCardsTab').click();for(const key of ['kpi:devices','kpi:rooms']){const input=document.querySelector('[data-dashboard-widget-setting="'+key+'"]');if(!input)throw new Error('Missing KPI setting '+key);input.checked=false}document.querySelector('#dashboardSettingsChartsTab').click();for(const key of ['chart:vendors','chart:presence-churn']){const input=document.querySelector('[data-dashboard-widget-setting="'+key+'"]');if(!input)throw new Error('Missing chart setting '+key);input.checked=false}document.querySelector('#analyticsDashboardSettingsForm').requestSubmit();return true})()`);
  let applied = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    applied = await evaluate(`(()=>({open:document.querySelector('#analyticsDashboardSettingsDialog').open,devicesHidden:document.querySelector('#analyticsKpis [data-dashboard-widget-kpi="kpi:devices"]')?.classList.contains('dashboard-widget-hidden')||false,roomsHidden:document.querySelector('#analyticsKpis [data-dashboard-widget-kpi="kpi:rooms"]')?.classList.contains('dashboard-widget-hidden')||false,vendorHidden:document.querySelector('[data-dashboard-widget="chart:vendors"]')?.classList.contains('dashboard-widget-hidden')||false,churnHidden:document.querySelector('[data-dashboard-widget="chart:presence-churn"]')?.classList.contains('dashboard-widget-hidden')||false,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (applied.error) throw new Error(`Applying Dashboard settings raised an error: ${applied.message}`);
    if (!applied.open && applied.devicesHidden && applied.roomsHidden && applied.vendorHidden && applied.churnHidden) break;
  }
  if (applied.open || !applied.devicesHidden || !applied.roomsHidden || !applied.vendorHidden || !applied.churnHidden) throw new Error(`Saved widget settings were not applied to the live Dashboard: ${JSON.stringify(applied)}`);
  const databaseName = new URL(target.url).searchParams.get('db');
  const saved = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(databaseName)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings'],'readonly');const request=tx.objectStore('settings').get('analyticsDashboardSettings');tx.oncomplete=()=>{db.close();resolve(request.result?.value||null)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (saved?.autoRefresh !== true || saved?.refreshIntervalSeconds !== 45 || saved?.widgets?.['kpi:devices'] !== false || saved?.widgets?.['kpi:rooms'] !== false || saved?.widgets?.['chart:vendors'] !== false || saved?.widgets?.['chart:presence-churn'] !== false) {
    throw new Error(`Dashboard settings did not persist exact auto-refresh and widget choices: ${JSON.stringify(saved)}`);
  }
  const reloaded = await reloadDatabaseAndWait(databaseName);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let restored = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    restored = await evaluate(`(()=>{const devices=document.querySelector('#analyticsKpis [data-dashboard-widget-kpi="kpi:devices"]');const rooms=document.querySelector('#analyticsKpis [data-dashboard-widget-kpi="kpi:rooms"]');return{buttonHidden:document.querySelector('#analyticsSettingsButton')?.hidden!==false,kpiCount:document.querySelectorAll('#analyticsKpis [data-dashboard-widget-kpi]').length,devicesHidden:!devices||devices.classList.contains('dashboard-widget-hidden'),roomsHidden:!rooms||rooms.classList.contains('dashboard-widget-hidden'),vendorHidden:document.querySelector('[data-dashboard-widget="chart:vendors"]')?.classList.contains('dashboard-widget-hidden')||false,churnHidden:document.querySelector('[data-dashboard-widget="chart:presence-churn"]')?.classList.contains('dashboard-widget-hidden')||false,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
    if (restored.error) throw new Error(`Restoring Dashboard settings raised an error: ${restored.message}`);
    if (restored.devicesHidden && restored.roomsHidden && restored.vendorHidden && restored.churnHidden) break;
  }
  if (!reloaded.status.includes('1 Final') || !restored.devicesHidden || !restored.roomsHidden || !restored.vendorHidden || !restored.churnHidden || restored.kpiCount < 4) {
    throw new Error(`Dashboard settings were not restored after reopening the app: ${JSON.stringify({reloaded,restored,saved})}`);
  }
  await evaluate(`document.querySelector('#engineeringModeButton').click();document.querySelector('#engineeringPassword').value=${JSON.stringify(smokeEngineerPassword)};document.querySelector('#engineeringPassword').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#engineeringModeForm').requestSubmit()`);
  let engineerRestored = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    engineerRestored = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes('Инженер')`);
    if (engineerRestored) break;
  }
  if (!engineerRestored) throw new Error('Could not re-authenticate the disposable engineer session to verify Dashboard reset');
  await evaluate(`document.querySelector('#analyticsSettingsButton').click();document.querySelector('#resetAnalyticsDashboardSettingsButton').click()`);
  let reset = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    reset = await evaluate(`(()=>({devicesHidden:document.querySelector('#analyticsKpis [data-dashboard-widget-kpi="kpi:devices"]')?.classList.contains('dashboard-widget-hidden')||false,roomsHidden:document.querySelector('#analyticsKpis [data-dashboard-widget-kpi="kpi:rooms"]')?.classList.contains('dashboard-widget-hidden')||false,vendorHidden:document.querySelector('[data-dashboard-widget="chart:vendors"]')?.classList.contains('dashboard-widget-hidden')||false,churnHidden:document.querySelector('[data-dashboard-widget="chart:presence-churn"]')?.classList.contains('dashboard-widget-hidden')||false,open:document.querySelector('#analyticsDashboardSettingsDialog').open,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (reset.error) throw new Error(`Resetting Dashboard settings raised an error: ${reset.message}`);
    if (!reset.devicesHidden && !reset.roomsHidden && !reset.vendorHidden && !reset.churnHidden) break;
  }
  if (reset.devicesHidden || reset.roomsHidden || reset.vendorHidden || reset.churnHidden || !reset.open) throw new Error(`Reset did not restore the default visible Dashboard state in the open settings dialog: ${JSON.stringify(reset)}`);
  await evaluate(`document.querySelector('[data-dashboard-settings-close]').click()`);
  if (await evaluate(`document.querySelector('#analyticsDashboardSettingsDialog').open`)) throw new Error('Dashboard settings dialog did not close after reset review');
  await evaluate(`(()=>{const nativeCreate=URL.createObjectURL.bind(URL);window.__dashboardPngDownload=null;URL.createObjectURL=(blob)=>{const url=nativeCreate(blob);window.__dashboardPngBlob=blob;return url};const nativeClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download.startsWith('analytics-dashboard-')&&this.download.endsWith('.png'))window.__dashboardPngDownload=this.download;else nativeClick.call(this)};const nativeToBlob=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(callback,type,quality){if(!this.id)window.__dashboardPngCanvas={width:this.width,height:this.height,type};return nativeToBlob.call(this,(blob)=>callback(blob),type,quality)};const context=CanvasRenderingContext2D.prototype;const nativeFillText=context.fillText;window.__dashboardPngLabels=[];context.fillText=function(value,...args){if(!this.canvas?.id)window.__dashboardPngLabels.push(String(value));return nativeFillText.call(this,value,...args)};return true})()`);
  await evaluate(`document.querySelector('#exportAnalyticsPngButton').click()`);
  let pngExport = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await wait(100);
    pngExport = await evaluate(`(()=>({download:window.__dashboardPngDownload||'',canvas:window.__dashboardPngCanvas||null,labels:window.__dashboardPngLabels||[],blobType:window.__dashboardPngBlob?.type||'',blobSize:window.__dashboardPngBlob?.size||0,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (pngExport.error) throw new Error(`Dashboard PNG export raised an error: ${pngExport.message}`);
    if (pngExport.download && pngExport.canvas && pngExport.blobSize) break;
  }
  const requiredPngLabels = ['Устройства','Изменённые','Отсутствуют','Без изменений','Производители','Помещения','Динамика общего числа устройств','Топ производителей выбранного статуса','Изменения по полям','Отсутствующие устройства по производителям'];
  const deviceKpiIndex = pngExport.labels.indexOf('Устройства');
  if (!pngExport?.download || pngExport.canvas?.width !== 2000 || pngExport.canvas?.height !== 1200 || pngExport.canvas?.type !== 'image/png' || pngExport.blobType !== 'image/png' || !pngExport.blobSize || requiredPngLabels.some(label => !pngExport.labels.includes(label)) || pngExport.labels[deviceKpiIndex + 1] !== '2 / 2' || pngExport.labels.some(label => /^не\s*число$/iu.test(label))) {
    throw new Error(`Dashboard PNG export did not render the exact six KPIs and four source charts at 2000×1200: ${JSON.stringify(pngExport)}`);
  }
  const pngImage = await evaluate(`(()=>new Promise((resolve,reject)=>{createImageBitmap(window.__dashboardPngBlob).then(bitmap=>{const result={width:bitmap.width,height:bitmap.height};bitmap.close();resolve(result)},reject)}))()`);
  if (pngImage.width !== 2000 || pngImage.height !== 1200) throw new Error(`Dashboard PNG blob dimensions are not 2000×1200: ${JSON.stringify(pngImage)}`);
  console.log(JSON.stringify({dashboardSettingsUiOnly:true,initial,keyboard,applied,saved,reloaded,restored,reset,pngExport:{...pngExport,decoded:pngImage},ok:true}));
  await command('Browser.close');
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--external-vendor-ui-only")) {
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  await wait(200);
  const initialProviders = await evaluate(`(()=>({provider:document.querySelector('#externalVendorApiProvider')?.value||'',options:[...document.querySelectorAll('#externalVendorApiProvider option')].map((option)=>option.value),enabled:document.querySelector('#externalVendorApiEnabled')?.checked===true}))()`);
  if (!initialProviders.options.includes("macadress") || initialProviders.enabled) throw new Error(`Vendor provider UI did not show the additional provider with opt-in off: ${JSON.stringify(initialProviders)}`);

  const configureProvider = async (provider) => evaluate(`(()=>{const enabled=document.querySelector('#externalVendorApiEnabled');enabled.checked=true;enabled.dispatchEvent(new Event('change',{bubbles:true}));const select=document.querySelector('#externalVendorApiProvider');select.value=${JSON.stringify(provider)};select.dispatchEvent(new Event('change',{bubbles:true}));const mac=document.querySelector('#externalVendorApiTestMac');mac.value='00:00:02:00:00:00';mac.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#saveExternalVendorApiSettings').click();return true})()`);
  const waitForStatus = async (predicate, label, attempts = 100) => {
    let current = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await wait(100);
      current = await evaluate(`(()=>({status:document.querySelector('#externalVendorApiStatus')?.textContent||'',cache:document.querySelector('#externalVendorCacheStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
      if (current.error) throw new Error(`${label} raised a browser error: ${current.message}`);
      if (predicate(current)) return current;
    }
    throw new Error(`${label} did not reach its expected state: ${JSON.stringify(current)}`);
  };
  await configureProvider("macadress");
  await waitForStatus(({ status }) => status.startsWith("Сохранено: macadress"), "Saving macadress opt-in");
  const persisted = await evaluate(`fetch('/api/external-vendor/settings').then(async(response)=>{if(!response.ok)throw new Error('settings HTTP '+response.status);return response.json()})`);
  if (persisted.settings?.enabled !== true || persisted.settings?.provider !== "macadress" || !persisted.providers?.some((provider)=>provider.key==="macadress")) {
    throw new Error(`Host did not persist the selected macadress opt-in: ${JSON.stringify(persisted)}`);
  }
  await evaluate(`document.querySelector('#testExternalVendorApi').click()`);
  const success = await waitForStatus(({ status, cache }) => status.includes("XEROX CORPORATION") && status.includes("macadress") && cache.includes("1 MAC"), "Testing macadress through the application UI");

  await configureProvider("mac2vendor");
  await waitForStatus(({ status }) => status.startsWith("Сохранено: mac2vendor"), "Saving legacy mac2vendor selection");
  await evaluate(`document.querySelector('#testExternalVendorApi').click()`);
  const legacyFailure = await waitForStatus(({ status }) => status.includes("HTTP 404") && status.includes("API endpoint недоступен"), "Displaying retired mac2vendor endpoint failure");
  const diagnostics = runtimeDiagnostics.filter(({ level }) => level === "exception" || level === "error");
  if (diagnostics.length) throw new Error(`Vendor UI flow produced browser errors: ${JSON.stringify(diagnostics)}`);
  console.log(JSON.stringify({ externalVendorUiOnly: true, initialProviders, persistedProvider: persisted.settings.provider, liveResult: success.status, cache: success.cache, legacyProvider: "mac2vendor", legacyResult: legacyFailure.status, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--sqlite-smartroom-room-only")) {
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  await wait(150);
  const fixture = readFileSync(resolve("tests/fixtures/smartroom-room-mappings.sqlite"));
  await assignBinaryInput("#importSqliteDatabaseInput", "smartroom-room-mappings.sqlite", fixture, "application/vnd.sqlite3");
  let imported = "";
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    const state = await evaluate(`({status:document.querySelector('#sqliteImportStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (state.error) throw new Error(`Smartroom SQLite mapping import failed: ${state.message}`);
    imported = state.status;
    if (imported.startsWith("SQLite проверена (ok) и объединена:")) break;
  }
  if (!imported.includes("legacySmartroomRoomMappings: 4")) throw new Error(`SQLite import did not report all four fixture mapping rows: ${imported}`);
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await wait(150);
  await assignInput("#mainFileInput", "main_smartroom_room_mapping.csv", "MAC;Device ID;Smartroom ID;Room\n02:30:00:00:00:01;ROOM-EXACT;SR-EXACT;\n02:30:00:00:00:02;ROOM-CONFLICT;SR-CONFLICT;\n02:30:00:00:00:03;ROOM-PRESERVE;SR-PRESERVE;Known room remains");
  const mapping = await evaluate(`(()=>{const fields={mac:0,deviceId:1,smartroomId:2,room:3};for(const [field,index] of Object.entries(fields)){const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="'+field+'"]');if(!select)throw new Error('Missing main.'+field+' mapping');select.value=String(index);select.dispatchEvent(new Event('change',{bubbles:true}))}return Object.fromEntries(Object.entries(fields).map(([field])=>[field,document.querySelector('[data-mapping-role="main"][data-mapping-field="'+field+'"]')?.value]))})()`);
  if (Object.values(mapping).join(",") !== "0,1,2,3") throw new Error(`Main Smartroom IDs and rooms were not mapped: ${JSON.stringify(mapping)}`);
  await evaluate("window.confirm=()=>true");
  await evaluate("document.querySelector('#runEnrichmentButton').click()");
  let result = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    result = await evaluate(`(()=>({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (result.error) throw new Error(`Imported room mapping enrichment failed: ${result.message}`);
    if (result.status.includes("1 Final") && result.status.includes("3 устройств")) break;
  }
  const persisted = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks','legacySmartroomRoomMappings'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const mappings=tx.objectStore('legacySmartroomRoomMappings').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const activeId=active.result?.value;const devices=chunks.result.filter((chunk)=>chunk.snapshotId===activeId).flatMap((chunk)=>chunk.devices||[]);db.close();resolve({activeId,importedMappings:mappings.result.map((item)=>({smartroomId:item.smartroomId,room:item.room,source:item.source,updatedAt:item.updatedAt})),devices:devices.map(({deviceId,smartroomId,room,fieldSources,roomConfidence})=>({deviceId,smartroomId,room,fieldSource:fieldSources?.room||'',roomConfidence}))})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const exact = persisted.devices.find((device) => device.deviceId === "ROOM-EXACT");
  const conflict = persisted.devices.find((device) => device.deviceId === "ROOM-CONFLICT");
  const preserve = persisted.devices.find((device) => device.deviceId === "ROOM-PRESERVE");
  if (persisted.importedMappings.length !== 4 || !persisted.importedMappings.every((item) => item.source === "fixture source")
    || exact?.room !== "Imported Legacy Room" || exact.fieldSource !== "Imported SQLite Smartroom room mapping" || exact.roomConfidence !== 1
    || conflict?.room || conflict?.fieldSource || preserve?.room !== "Known room remains" || preserve.fieldSource === "Imported SQLite Smartroom room mapping") {
    throw new Error(`Imported Smartroom room mapping did not preserve exact match/provenance/conflict safety: ${JSON.stringify({imported,persisted})}`);
  }
  console.log(JSON.stringify({ sqliteSmartroomRoomOnly: true, imported, result, mappings: persisted.importedMappings, devices: persisted.devices, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--legacy-autosave-recovery-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await wait(150);
  await assignInput("#mainFileInput", "legacy-autosave-local-final.csv", "MAC;Device ID;Model\n00:11:22:33:44:85;AUTOSAVE-LOCAL-85;Local Model");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2]]) {
    await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main ${field} mapping');select.value=String(${index});select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let localFinalStatus = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await wait(100);
    localFinalStatus = await evaluate(`(()=>({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (localFinalStatus.error) throw new Error(`Could not create a local Final before the legacy autosave import: ${localFinalStatus.message}`);
    if (localFinalStatus.status.includes("1 Final") && localFinalStatus.status.includes("1 устройств")) break;
  }
  if (!localFinalStatus?.status.includes("1 Final") || !localFinalStatus.status.includes("1 устройств")) throw new Error(`The local Final was not ready before legacy autosave import: ${JSON.stringify(localFinalStatus)}`);
  const beforeImport = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{const activeId=active.result?.value||'';const current=snapshots.result.find((snapshot)=>snapshot.id===activeId);db.close();resolve({activeId,snapshotCount:snapshots.result.length,snapshot:current||null})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (!beforeImport.activeId || beforeImport.snapshot?.deviceCount !== 1 || beforeImport.snapshotCount !== 1) throw new Error(`The disposable local Final is not a single complete snapshot: ${JSON.stringify(beforeImport)}`);
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  await wait(150);
  const fixture = readFileSync(resolve("tests/fixtures/legacy-browser-id-collision.sqlite"));
  await assignBinaryInput("#importSqliteDatabaseInput", "legacy-browser-id-collision.sqlite", fixture, "application/vnd.sqlite3");
  let importStatus = "";
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    const current = await evaluate(`({status:document.querySelector('#sqliteImportStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (current.error) throw new Error(`Broken legacy autosave SQLite UI import failed: ${current.message}`);
    importStatus = current.status;
    if (importStatus.startsWith("SQLite проверена (ok) и объединена:")) break;
  }
  if (!importStatus.startsWith("SQLite проверена (ok) и объединена:") || !importStatus.includes("snapshots: 1") || !importStatus.includes("settings: 2")) throw new Error(`Legacy browser-ID collision fixture did not import one Final and two autosaves: ${importStatus}`);
  let afterImport = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    afterImport = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const autosave=tx.objectStore('settings').get('legacyAutosave:current');const collision=tx.objectStore('settings').get('legacyAutosave:browser-collision');const snapshots=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{const activeId=active.result?.value||'';const current=snapshots.result.find((snapshot)=>snapshot.id===activeId);db.close();resolve({activeId,snapshotCount:snapshots.result.length,snapshot:current||null,autosave:autosave.result?.value||null,collision:collision.result?.value||null})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (afterImport.autosave) break;
    await wait(100);
  }
  const legacyAutosaveUi = await evaluate(`(()=>({text:document.querySelector('#legacyAutosaveRestoreList')?.textContent.replace(/\s+/g,' ').trim()||'',activateButtons:document.querySelectorAll('#legacyAutosaveRestoreList [data-activate-legacy-autosave]').length,settingsButtons:document.querySelectorAll('#legacyAutosaveRestoreList [data-restore-legacy-autosave-settings]').length}))()`);
  if (afterImport.activeId !== beforeImport.activeId || afterImport.snapshotCount !== beforeImport.snapshotCount + 1 || afterImport.snapshot?.deviceCount !== 1
    || afterImport.autosave?.state !== '{"activeSnapshotId":"missing-legacy-final","finalSnapshotId":"missing-legacy-final"}'
    || afterImport.autosave?.reason !== "interrupted" || afterImport.autosave?.updatedAt !== "2026-10-17T10:00:00Z" || Object.hasOwn(afterImport.autosave, "snapshotId")
    || afterImport.collision?.state !== '{"resultBrowserSnapshotId":"browser-collision-final","activeSnapshotId":"browser-collision-final"}'
    || afterImport.collision?.reason !== "browser-id-collision" || afterImport.collision?.updatedAt !== "2026-10-18T10:00:00Z" || Object.hasOwn(afterImport.collision, "snapshotId")
    || !legacyAutosaveUi.text.includes("Связанный импортированный Final не найден") || legacyAutosaveUi.activateButtons !== 0 || legacyAutosaveUi.settingsButtons !== 2) {
    throw new Error(`SQLite UI import classified a browser snapshot ID as a SQLite Final or changed the active Final: ${JSON.stringify({beforeImport,importStatus,afterImport,legacyAutosaveUi})}`);
  }
  await command("Page.reload", { ignoreCache: true });
  let afterReload = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    afterReload = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const autosave=tx.objectStore('settings').get('legacyAutosave:current');const collision=tx.objectStore('settings').get('legacyAutosave:browser-collision');const snapshots=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{const activeId=active.result?.value||'';const current=snapshots.result.find((snapshot)=>snapshot.id===activeId);db.close();resolve({title:document.title,status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner')?.hidden,activeId,snapshotCount:snapshots.result.length,snapshot:current||null,autosave:autosave.result?.value||null,collision:collision.result?.value||null})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (afterReload.title === "MAC Analyzer Pro Next" && afterReload.status.includes("2 Final")) break;
  }
  if (afterReload.error || afterReload.activeId !== beforeImport.activeId || afterReload.snapshotCount !== beforeImport.snapshotCount + 1
    || afterReload.snapshot?.deviceCount !== 1 || afterReload.autosave?.state !== afterImport.autosave.state || afterReload.autosave?.snapshotId
    || afterReload.collision?.state !== afterImport.collision.state || afterReload.collision?.snapshotId) {
    throw new Error(`Application startup activated or replaced a Final from the broken legacy autosave: ${JSON.stringify({beforeImport,afterReload})}`);
  }
  await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readwrite');tx.objectStore('settings').put({key:'activeSnapshotId',value:'smoke-incomplete-newest'});tx.objectStore('snapshots').put({id:'smoke-incomplete-newest',name:'Incomplete newer Final',snapshotType:'final',createdAt:'2099-12-31T23:59:59.000Z',deviceCount:1,chunkCount:1});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  await command("Page.reload", { ignoreCache: true });
  let startupRecovery = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await wait(250);
    try {
      startupRecovery = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const valid=tx.objectStore('snapshots').get(${JSON.stringify(beforeImport.activeId)});const incomplete=tx.objectStore('snapshots').get('smoke-incomplete-newest');const chunks=tx.objectStore('snapshotChunks').count(IDBKeyRange.bound(['smoke-incomplete-newest',0],['smoke-incomplete-newest',Number.MAX_SAFE_INTEGER]));tx.oncomplete=()=>{db.close();resolve({status:document.querySelector('#databaseStatus')?.textContent||'',ready:Boolean(document.querySelector('#progressPanel')?.hidden),error:!document.querySelector('#errorBanner')?.hidden,activeId:active.result?.value||'',valid:Boolean(valid.result),incomplete:Boolean(incomplete.result),incompleteChunks:chunks.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    } catch { continue; }
    if (startupRecovery.ready && startupRecovery.status.includes("активный Final восстановлен")) break;
  }
  if (!startupRecovery?.ready || startupRecovery.error || !startupRecovery.status.includes("активный Final восстановлен")
    || startupRecovery.activeId !== beforeImport.activeId || !startupRecovery.valid || !startupRecovery.incomplete || startupRecovery.incompleteChunks !== 0) {
    throw new Error(`Startup recovery did not finish visibly or selected an incomplete Final: ${JSON.stringify(startupRecovery)}`);
  }
  console.log(JSON.stringify({ legacyAutosaveRecoveryOnly: true, localFinalStatus, importStatus, beforeImport, afterImport, legacyAutosaveUi, afterReload, startupRecovery, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--batch-queue-failure-only")) {
  await evaluate(`document.querySelector('[data-view="batch"]').click()`);
  await wait(150);
  const files = [14, 15, 16].map((day, index) => ({
    name: `main_2026-10-${day}.csv`,
    content: `MAC;Device ID;Model\n02:20:00:00:00:0${index + 1};QUEUE-${index + 1};Queue model ${index + 1}`,
    lastModified: Date.UTC(2026, 9, day),
  }));
  const assigned = await evaluate(`(()=>{const input=document.querySelector('#batchMainInput');if(!input)throw new Error('Batch Main file input missing');const transfer=new DataTransfer();for(const file of ${JSON.stringify(files)})transfer.items.add(new File([file.content],file.name,{type:'text/csv',lastModified:file.lastModified}));input.files=transfer.files;const count=input.files.length;input.dispatchEvent(new Event('change',{bubbles:true}));return count})()`);
  if (assigned !== 3) throw new Error(`Expected three independent queue inputs, got ${assigned}`);
  let filesReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(50);
    const status = await evaluate(`document.querySelector('#batchMainStatus')?.textContent||''`);
    if (status.startsWith("3 ")) { filesReady = true; break; }
  }
  if (!filesReady) throw new Error("Three Main files were not parsed into the queue");
  await evaluate(`document.querySelector('#previewBatchButton').click()`);
  let preview = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(50);
    preview = await evaluate(`({rows:document.querySelectorAll('#batchPreview tr.batch-details-row').length,runDisabled:document.querySelector('#runBatchButton').disabled})`);
    if (preview.rows === 3) break;
  }
  if (preview?.rows !== 3) throw new Error(`Expected three reviewed queue pairs: ${JSON.stringify(preview)}`);
  const mappings = await evaluate(`(()=>{const selects=[...document.querySelectorAll('#batchPreview select[data-batch-entry-role="main"]')];for(const select of selects){const field=select.dataset.batchMappingField;const index={mac:'0',deviceId:'1',model:'2'}[field];if(index!==undefined){select.value=index;select.dispatchEvent(new Event('change',{bubbles:true}))}}for(const checkbox of document.querySelectorAll('#batchPreview [data-batch-pair-reviewed]')){checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}))}const enabled=[...document.querySelectorAll('#batchPreview [data-batch-pair-enabled]')].filter((item)=>item.checked).length;return{selectCount:selects.length,enabled,runDisabled:document.querySelector('#runBatchButton').disabled,ids:[...document.querySelectorAll('#batchPreview select[data-batch-mapping-field="deviceId"]')].map((item)=>item.value)}})()`);
  if (mappings.enabled !== 3 || mappings.runDisabled || mappings.ids.join(",") !== "1,1,1") throw new Error(`Queue mapping/review gate did not permit all three valid cycles: ${JSON.stringify(mappings)}`);
  await evaluate(`(()=>{const policy=document.querySelector('#batchFailurePolicy');policy.value='continue';policy.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await evaluate(`(()=>{const originalPut=IDBObjectStore.prototype.put;const originalAdd=IDBObjectStore.prototype.add;window.__queueFailureInjected=false;const maybeFail=function(value){if(window.__queueFailureArmed&&this.name==='snapshotChunks'&&!window.__queueFailureInjected&&(value?.devices||[]).some((device)=>device.deviceId==='QUEUE-2')){window.__queueFailureInjected=true;this.transaction.abort();throw new DOMException('Injected queue-cycle quota failure','QuotaExceededError')}};IDBObjectStore.prototype.put=function(value,...args){maybeFail.call(this,value);return originalPut.call(this,value,...args)};IDBObjectStore.prototype.add=function(value,...args){maybeFail.call(this,value);return originalAdd.call(this,value,...args)}})()`);
  await evaluate(`window.__queueFailureArmed=true;document.querySelector('#runBatchButton').click()`);
  let result = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    result = await evaluate(`(()=>({status:document.querySelector('#databaseStatus').textContent,summary:document.querySelector('#progressPanel')?.textContent||'',error:document.querySelector('#errorBanner span')?.textContent||'',injected:window.__queueFailureInjected,pairs:[...document.querySelectorAll('#batchPreview [data-batch-problems]')].map((item)=>item.textContent.trim())}))()`);
    if (result.status.includes("2 Final") && result.summary.includes("Очередь завершена")) break;
  }
  if (!result?.injected || !result.status.includes("2 Final") || !result.summary.includes("2 Final сохранено") || !result.summary.includes("ошибок: 1")
    || !result.error.includes("main_2026-10-15.csv") || !result.error.includes("QuotaExceededError")
    || !result.pairs[0].includes("Final сохранён") || !result.pairs[1].includes("QuotaExceededError") || !result.pairs[2].includes("Final сохранён")) {
    throw new Error(`Browser queue did not continue around one failed atomic cycle: ${JSON.stringify(result)}`);
  }
  const persisted = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();const inventory=tx.objectStore('inventory').getAll();const history=tx.objectStore('history').getAll();tx.oncomplete=()=>{const activeId=active.result?.value;const activeDevices=chunks.result.filter((item)=>item.snapshotId===activeId).flatMap((item)=>item.devices||[]);const finals=snapshots.result.filter((item)=>item.kind!=='single');const allDevices=finals.flatMap((snapshot)=>chunks.result.filter((item)=>item.snapshotId===snapshot.id).flatMap((item)=>item.devices||[]));const historyRows=history.result.map(({snapshotId,deviceId,type})=>({snapshotId,deviceId,type}));db.close();resolve({activeId,snapshotCount:finals.length,finalIds:finals.map((item)=>item.id),activeDeviceIds:activeDevices.map((item)=>item.deviceId),inventoryIds:inventory.result.map((item)=>item.deviceId),failedDevicePersisted:allDevices.some((item)=>item.deviceId==='QUEUE-2')||inventory.result.some((item)=>item.deviceId==='QUEUE-2')||historyRows.some((item)=>item.deviceId==='QUEUE-2'),historyRows})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (persisted.snapshotCount !== 2 || persisted.activeDeviceIds.join(",") !== "QUEUE-3" || persisted.inventoryIds.length !== 2 || persisted.failedDevicePersisted
    || persisted.historyRows.length !== 3 || persisted.historyRows.some((item) => !persisted.finalIds.includes(item.snapshotId))) {
    throw new Error(`Failed cycle altered prior/later Final, Inventory, or History state: ${JSON.stringify({result,persisted})}`);
  }
  await evaluate(`(()=>{const policy=document.querySelector('#batchFailurePolicy');policy.value='stop';policy.dispatchEvent(new Event('change',{bubbles:true}));window.__queueFailureInjected=false;window.__queueFailureArmed=true;document.querySelector('#runBatchButton').click();return true})()`);
  let stoppedResult = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    stoppedResult = await evaluate(`(()=>({status:document.querySelector('#databaseStatus').textContent,summary:document.querySelector('#progressPanel')?.textContent||'',error:document.querySelector('#errorBanner span')?.textContent||'',injected:window.__queueFailureInjected,pairs:[...document.querySelectorAll('#batchPreview [data-batch-problems]')].map((item)=>item.textContent.trim())}))()`);
    if (stoppedResult.summary.includes("остановлена после ошибки пары №2")) break;
  }
  if (!stoppedResult?.injected || !stoppedResult.status.includes("2 Final") || !stoppedResult.summary.includes("1 Final сохранено")
    || !stoppedResult.summary.includes("остановлена после ошибки пары №2") || !stoppedResult.pairs[0].includes("повторно")
    || !stoppedResult.pairs[1].includes("QuotaExceededError") || !stoppedResult.pairs[2].includes("Не запускался: очередь остановлена после ошибки пары №2")) {
    throw new Error(`Repeated browser queue run did not reset stale statuses or stop visibly at the selected failure: ${JSON.stringify(stoppedResult)}`);
  }
  const afterStop = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,snapshotCount:snapshots.result,inventoryCount:inventory.result,historyCount:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (afterStop.activeId !== persisted.activeId || afterStop.snapshotCount !== persisted.snapshotCount || afterStop.inventoryCount !== persisted.inventoryIds.length || afterStop.historyCount !== persisted.historyRows.length) {
    throw new Error(`Stopped retry changed prior successful records: ${JSON.stringify({persisted,afterStop,stoppedResult})}`);
  }
  console.log(JSON.stringify({ batchQueueFailureOnly: true, continuedRun: { result, persisted }, stoppedRetry: { result: stoppedResult, afterStop }, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--switch-ip-pages-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await wait(150);
  const rowCount = 101;
  const csv = (switchPrefix) => {
    const rows = ["MAC;Device ID;NasIP;IP address"];
    for (let index = 0; index < rowCount; index += 1) {
      const suffix = index.toString(16).padStart(2, "0");
      const mac = `02:10:00:00:${suffix}:01`;
      rows.push(`${mac};PAGER-${index};${switchPrefix}.${index + 1};192.0.2.${index + 1}`);
    }
    return rows.join("\n");
  };
  await assignInput("#mainFileInput", "switch_ip_2026-10-14.csv", csv("10.0.0"));
  const setMapping = async (field, column) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${JSON.stringify(String(column))};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  for (const [field, column] of [["mac", 0], ["deviceId", 1], ["switchIp", 2], ["ip", 3]]) await setMapping(field, column);
  await evaluate("window.confirm=()=>true");
  const runFinal = async (date, prefix, expectedFinals) => {
    if (expectedFinals > 1) await assignInput("#mainFileInput", `switch_ip_${date}.csv`, csv(prefix));
    await evaluate("document.querySelector('#runEnrichmentButton').click()");
    let state = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await wait(100);
      state = await evaluate(`(()=>({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
      if (state.error) throw new Error(`Switch-IP paging Final ${expectedFinals} failed: ${state.message}`);
      if (state.status.includes(`${expectedFinals} Final`) && state.status.includes(`${rowCount} устройств`)) return state;
    }
    throw new Error(`Switch-IP paging Final ${expectedFinals} timed out: ${JSON.stringify(state)}`);
  };
  await runFinal("2026-10-14", "10.0.0", 1);
  await runFinal("2026-10-15", "10.1.0", 2);
  const inspectPage = () => evaluate(`(()=>{const host=document.querySelector('#enrichmentSummary [data-switch-ip-change-container]');const rows=[...(host?.querySelectorAll('tbody tr')||[])].filter((row)=>row.cells.length&&row.textContent.trim()).map((row)=>[...row.cells].map((cell)=>cell.textContent.trim()));const next=[...(host?.querySelectorAll('[data-switch-ip-change-offset]')||[])].find((button)=>button.dataset.switchIpChangeOffset!=='0');return{present:Boolean(host),summary:host?.querySelector('details summary')?.textContent.trim()||'',range:host?.querySelector('.action-row .muted')?.textContent.trim()||'',rows,back:host?.querySelector('[data-switch-ip-change-offset="0"]')?.disabled,next:next?.disabled,totalText:host?.textContent.includes('101')}})()`);
  let firstPage = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(50);
    firstPage = await inspectPage();
    if (firstPage.rows.length && firstPage.range.includes("1–100")) break;
  }
  if (!firstPage?.present || !firstPage.rows.length || firstPage.rows[0][0] !== "02:10:00:00:00:01" || !firstPage.summary.endsWith(": 101") || !firstPage.range.replace(/\s/g, "").includes("1–100из101") || firstPage.back !== true || firstPage.next !== false) {
    throw new Error(`Switch-IP report first page is incorrect: ${JSON.stringify(firstPage)}`);
  }
  await evaluate(`(()=>{const host=document.querySelector('#enrichmentSummary [data-switch-ip-change-container]');const scroll=host.querySelector('.table-scroll');scroll.scrollTop=scroll.scrollHeight;return true})()`);
  await wait(100);
  const firstPageEnd = await inspectPage();
  if (!firstPageEnd.rows.length || firstPageEnd.rows.at(-1)[0] !== "02:10:00:00:63:01") throw new Error(`Switch-IP report virtualized first page lost its last record: ${JSON.stringify(firstPageEnd)}`);
  await evaluate(`document.querySelector('#enrichmentSummary [data-switch-ip-change-offset="100"]').click()`);
  let secondPage = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(50);
    secondPage = await inspectPage();
    if (secondPage.rows.length === 1 && secondPage.range.replace(/\s/g, "").includes("101–101из101")) break;
  }
  if (secondPage?.rows.length !== 1 || !secondPage.range.replace(/\s/g, "").includes("101–101из101") || secondPage.back !== false || secondPage.next !== true
    || secondPage.rows[0][1] !== "10.0.0.101" || secondPage.rows[0][2] !== "10.1.0.101") {
    throw new Error(`Switch-IP report second page is incorrect: ${JSON.stringify(secondPage)}`);
  }
  await evaluate(`document.querySelector('#enrichmentSummary [data-switch-ip-change-offset="0"]').click()`);
  let returnedToFirstPage = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(50);
    returnedToFirstPage = await inspectPage();
    if (returnedToFirstPage.rows.length && returnedToFirstPage.range.replace(/\s/g, "").includes("1–100из101")) break;
  }
  if (!returnedToFirstPage?.rows.length || returnedToFirstPage.rows[0][0] !== "02:10:00:00:00:01" || !returnedToFirstPage.range.replace(/\s/g, "").includes("1–100из101")) {
    throw new Error(`Switch-IP report did not return to first page: ${JSON.stringify(returnedToFirstPage)}`);
  }
  console.log(JSON.stringify({ switchIpPagesOnly: true, total: 101, firstPageRange: firstPage.range, firstPageStart: firstPage.rows[0], firstPageEnd: firstPageEnd.rows.at(-1), secondPageRange: secondPage.range, secondPageRows: secondPage.rows.length, secondPageRecord: secondPage.rows[0], backNavigationStart: returnedToFirstPage.rows[0], ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--custom-fields-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  const addCustomField = async (role, label, sourceColumn) => {
    await evaluate(`(()=>{const container=document.querySelector('#${role}Mapping');const name=container?.querySelector('[data-source-custom-label]');const column=container?.querySelector('[data-source-custom-column]');const button=container?.querySelector('[data-add-source-custom-field]');if(!name||!column||!button)throw new Error('Custom-field controls missing for ${role}');name.value=${JSON.stringify(label)};column.value=${JSON.stringify(String(sourceColumn))};button.click();return true})()`);
    let mapped = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(50);
      mapped = await evaluate(`(()=>{const container=document.querySelector('#${role}Mapping');const candidates=[...container.querySelectorAll('select[data-mapping-role][data-mapping-field^="custom_"]')];const select=candidates.find((item)=>item.value===${JSON.stringify(String(sourceColumn))});return select?{field:select.dataset.mappingField,value:select.value,label:select.closest('label')?.innerText||'',customFields:candidates.map((item)=>({field:item.dataset.mappingField,value:item.value,label:item.closest('label')?.innerText||''}))}:null})()`);
      if (mapped?.value === String(sourceColumn)) break;
    }
    if (!mapped || !/^custom_[0-9a-f-]{36}$/i.test(mapped.field) || mapped.value !== String(sourceColumn) || !mapped.label.includes(label)) {
      const diagnostics = await evaluate(`(()=>({error:document.querySelector('#errorBanner span')?.textContent||'',mapped:[...document.querySelectorAll('#${role}Mapping select[data-mapping-role]')].filter((item)=>item.value!=='').map((item)=>({field:item.dataset.mappingField,value:item.value})),fields:[...document.querySelectorAll('#${role}Mapping select[data-mapping-field^="custom_"]')].map((item)=>({field:item.dataset.mappingField,value:item.value,label:item.closest('label')?.innerText||''}))}))()`);
      throw new Error(`Custom field ${label} was not created and mapped to source column ${sourceColumn}: ${JSON.stringify({mapped,diagnostics})}`);
    }
    return mapped.field;
  };
  const selectMapping = async (role, field, index) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="${role}"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing ${role}.${field} mapping');select.value=${JSON.stringify(String(index))};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  await assignInput("#mainFileInput", "custom-main.csv", "MAC;Device ID;Serial;IP адрес;Smartroom ID;Spare\n00:11:22:33:44:51;CUSTOM-51;SERIAL-51;192.0.2.51;SR-51;ASSET-MAIN-51");
  await assignInput("#smartroomFileInput", "custom-smartroom.csv", "MAC;Device ID;Room;Smartroom ID;Spare\n00:11:22:33:44:51;CUSTOM-51;Room 51;SR-51;ASSET-SMART-51");
  await assignInput("#ddioFileInput", "custom-ddio.csv", "MAC;IP;DDIO Lease Reference;Spare\n00:11:22:33:44:51;198.51.100.51;LEASE-DDIO-51;LEASE-DDIO-51");
  const smartroomAutoMappings = await evaluate(`(()=>Object.fromEntries(['main','smartroom'].map((role)=>{const select=document.querySelector('[data-mapping-role="'+role+'"][data-mapping-field="smartroomId"]');return[role,select?.value??null]})))()`);
  if (smartroomAutoMappings.main !== "4" || smartroomAutoMappings.smartroom !== "3") throw new Error(`Smartroom ID header autodetection did not select the correct source columns: ${JSON.stringify(smartroomAutoMappings)}`);
  console.log("browser smoke: Smartroom ID auto-detected for Main and SmartRoom");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["serial", 2], ["ip", 3], ["smartroomId", 4]]) await selectMapping("main", field, index);
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["room", 2], ["smartroomId", 3]]) await selectMapping("smartroom", field, index);
  for (const [field, index] of [["reservationMac", 0], ["reservationIp", 1]]) await selectMapping("ddio", field, index);
  console.log("browser smoke: source identity mappings selected");
  await selectMapping("main", "hostname", "");
  console.log("browser smoke: Main spare column released");
  await selectMapping("smartroom", "hostname", "");
  await selectMapping("smartroom", "serial", "");
  console.log("browser smoke: SmartRoom spare column released");
  const mainCustomKey = await addCustomField("main", "Main Asset Tag", 5);
  console.log("browser smoke: Main custom field created");
  const smartroomCustomKey = await addCustomField("smartroom", "SmartRoom Asset Tag", 4);
  console.log("browser smoke: SmartRoom custom field created");
  const ddioCustomKey = await addCustomField("ddio", "DDIO Lease Reference", 3);
  console.log("browser smoke: DDIO custom field created");
  if (!(await evaluate("!document.querySelector('#runEnrichmentButton').disabled"))) throw new Error("Custom-field test enrichment did not become runnable after strong identity mappings");
  await evaluate("window.confirm=()=>true");
  await evaluate("document.querySelector('#runEnrichmentButton').click()");
  let committed = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    const state = await evaluate("({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})");
    if (state.error) throw new Error(`Custom-field enrichment failed: ${state.message}`);
    if (state.status.includes("1 Final")) { committed = true; break; }
  }
  if (!committed) throw new Error("Custom-field enrichment did not commit one Final");
  const persisted = await evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const config=tx.objectStore('settings').get('inventoryColumnConfig');const snapshots=tx.objectStore('snapshots').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const activeId=active.result?.value;const final=snapshots.result.find((item)=>item.id===activeId);const devices=chunks.result.filter((chunk)=>chunk.snapshotId===activeId).flatMap((chunk)=>chunk.devices||[]);db.close();resolve({activeId,finalCount:snapshots.result.filter((item)=>item.kind!=='single').length,deviceCount:devices.length,device:devices[0]||null,customColumnLabels:(config.result?.value?.columns||[]).filter((column)=>column.custom).map((column)=>column.label),diagnostics:final?.diagnosticCounts||null})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const expectedFields = [
    [mainCustomKey, "ASSET-MAIN-51", "Main", "Main Asset Tag"],
    [smartroomCustomKey, "ASSET-SMART-51", "SmartRoom", "SmartRoom Asset Tag"],
    [ddioCustomKey, "LEASE-DDIO-51", "DDIO", "DDIO Lease Reference"],
  ];
  const fieldResults = expectedFields.map(([key, value, source, label]) => ({ key, expected: value, actual: persisted.device?.customFields?.[key] || "", source: persisted.device?.customFieldSources?.[key] || "", label: label || "" }));
  if (persisted.finalCount !== 1 || persisted.deviceCount !== 1 || persisted.device?.deviceId !== "CUSTOM-51"
    || persisted.device?.serial !== "SERIAL-51" || persisted.device?.smartroomId !== "SR-51"
    || persisted.device?.ip !== "192.0.2.51" || !persisted.device?.possibleIps?.includes("198.51.100.51")
    || fieldResults.some((item, index) => item.actual !== expectedFields[index][1] || item.source !== expectedFields[index][2])
    || expectedFields.some(([, , , label]) => !persisted.customColumnLabels.includes(label))) {
    throw new Error(`Custom fields were not preserved by Main/SmartRoom/DDIO mapping, merge, or provenance: ${JSON.stringify({persisted,fieldResults})}`);
  }
  console.log(JSON.stringify({customFieldsOnly:true,sourceMappings:{main:mainCustomKey,smartroom:smartroomCustomKey,ddio:ddioCustomKey},fieldResults,finalCount:persisted.finalCount,deviceCount:persisted.deviceCount,mainDeviceIp:persisted.device.ip,ddioPossibleIps:persisted.device.possibleIps,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--dashboard-xlsx-parity-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await assignInput("#mainFileInput", "dashboard-summary-main.csv", "MAC;Device ID;NasIP;NasPortID\n00:11:22:33:44:81;DASH-81;10.0.0.1;1\n00:11:22:33:44:82;DASH-82;N/A;2\n00:11:22:33:44:83;DASH-83;Unknown;3\n00:11:22:33:44:84;DASH-84;10.0.0.2;1");
  await assignInput("#smartroomFileInput", "dashboard-summary-smartroom.csv", "MAC;Smartroom ID;Название комнаты\n00:11:22:33:44:81;SR-A;Room Alpha\n00:11:22:33:44:82;SR-B;Room Alpha\n00:11:22:33:44:83;SR-C;Room Beta\n00:11:22:33:44:84;SR-C;Room Beta");
  const setMapping = async (role, field, column) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="${role}"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing ${role}.${field} mapping');select.value=${JSON.stringify(String(column))};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  for (const [field, column] of [["mac", 0], ["deviceId", 1], ["switchIp", 2], ["switchPort", 3]]) await setMapping("main", field, column);
  for (const [field, column] of [["mac", 0], ["smartroomId", 1], ["room", 2]]) await setMapping("smartroom", field, column);
  await evaluate("window.confirm=()=>true");
  await evaluate("document.querySelector('#runEnrichmentButton').click()");
  let finalReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    const state = await evaluate("({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})");
    if (state.error) throw new Error(`Dashboard XLSX parity enrichment failed: ${state.message}`);
    if (state.status.includes("1 Final") && state.status.includes("4 устройств")) { finalReady = true; break; }
  }
  if (!finalReady) throw new Error("Dashboard XLSX parity source Final was not committed");
  await evaluate("document.querySelector('[data-view=\"analytics\"]').click()");
  let analyticsReady = false;
  let analyticsState = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    analyticsState = await evaluate("({loading:!document.querySelector('#analyticsLoadingStatus').hidden,heading:document.querySelector('#changeTable h3')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})");
    if (analyticsState.error) throw new Error(`Dashboard XLSX parity analytics failed: ${analyticsState.message}`);
    if (!analyticsState.loading && analyticsState.heading === "Все устройства") { analyticsReady = true; break; }
  }
  if (!analyticsReady) throw new Error(`Dashboard XLSX parity analytics did not finish: ${JSON.stringify(analyticsState)}`);
  await evaluate(`(()=>{const create=URL.createObjectURL.bind(URL);window.__smokeDownloadBlobs=new Map();window.__smokeXlsx=null;URL.createObjectURL=(blob)=>{const url=create(blob);window.__smokeDownloadBlobs.set(url,blob);return url};HTMLAnchorElement.prototype.click=function(){const blob=window.__smokeDownloadBlobs.get(this.href);if(blob&&this.download.endsWith('.xlsx'))window.__smokeXlsx={name:this.download,blob}};Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:undefined});return true})()`);
  await evaluate("document.querySelector('#exportAnalyticsXlsxButton').click()");
  let exportEvidence = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(50);
    exportEvidence = await evaluate(`(()=>{const value=window.__smokeXlsx;if(!value?.blob)return null;return(async()=>{const bytes=new Uint8Array(await value.blob.arrayBuffer());const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=bytes.length-22;while(end>=0&&view.getUint32(end,true)!==0x06054b50)end--;if(end<0)throw new Error('XLSX end-of-central-directory is missing');const count=view.getUint16(end+10,true);let offset=view.getUint32(end+16,true);const decoder=new TextDecoder();const entries=new Map();const crc32=(data)=>{let crc=0xffffffff;for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1}return(crc^0xffffffff)>>>0};for(let index=0;index<count;index++){if(view.getUint32(offset,true)!==0x02014b50)throw new Error('Invalid XLSX central-directory record');const crc=view.getUint32(offset+16,true);const method=view.getUint16(offset+10,true);const compressed=view.getUint32(offset+20,true);const size=view.getUint32(offset+24,true);const nameLength=view.getUint16(offset+28,true);const extraLength=view.getUint16(offset+30,true);const commentLength=view.getUint16(offset+32,true);const localOffset=view.getUint32(offset+42,true);const name=decoder.decode(bytes.subarray(offset+46,offset+46+nameLength));if(view.getUint32(localOffset,true)!==0x04034b50)throw new Error('Invalid XLSX local record');const localNameLength=view.getUint16(localOffset+26,true);const localExtraLength=view.getUint16(localOffset+28,true);const start=localOffset+30+localNameLength+localExtraLength;const data=bytes.subarray(start,start+size);if(method!==0||compressed!==size||data.length!==size||crc32(data)!==crc)throw new Error('XLSX stored-entry size or CRC does not match');entries.set(name,decoder.decode(data));offset+=46+nameLength+extraLength+commentLength}const parseRows=(path)=>{const xml=entries.get(path);if(!xml)throw new Error('Missing XLSX worksheet '+path);const document=new DOMParser().parseFromString(xml,'application/xml');return[...document.getElementsByTagNameNS('*','row')].map((row)=>[...row.getElementsByTagNameNS('*','c')].map((cell)=>{const string=cell.getElementsByTagNameNS('*','t')[0];const number=cell.getElementsByTagNameNS('*','v')[0];return string?string.textContent:number?Number(number.textContent):''}))};const workbookDoc=new DOMParser().parseFromString(entries.get('xl/workbook.xml'),'application/xml');const sheetNames=[...workbookDoc.getElementsByTagNameNS('*','sheet')].map((sheet)=>sheet.getAttribute('name'));return{name:value.name,size:value.blob.size,sheets:sheetNames,summary:parseRows('xl/worksheets/sheet1.xml'),rooms:parseRows('xl/worksheets/sheet4.xml'),switches:parseRows('xl/worksheets/sheet5.xml'),entryCount:entries.size}})()})()`);
    if (exportEvidence) break;
  }
  if (!exportEvidence) {
    const exportState = await evaluate("(()=>({error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',buttonDisabled:document.querySelector('#exportAnalyticsXlsxButton')?.disabled,buttonText:document.querySelector('#exportAnalyticsXlsxButton')?.textContent,xlsx:window.__smokeXlsx?{name:window.__smokeXlsx.name,chunks:window.__smokeXlsx.chunks.length,closed:window.__smokeXlsx.closed}:null,xlsxLibrary:typeof window.XLSX}))()");
    throw new Error(`Dashboard XLSX export did not finish or could not be read: ${JSON.stringify({exportState,analyticsState})}`);
  }
  const roomCount = exportEvidence.summary.find(([label]) => label === "Уникальных помещений")?.[1];
  const roomRows = exportEvidence.rooms.slice(1).map(([label, count]) => [String(label || ""), Number(count) || 0]);
  const switchRows = exportEvidence.switches.slice(1).map(([label, count]) => [String(label || ""), Number(count) || 0]);
  const knownSwitches = [["10.0.0.1", 1], ["10.0.0.2", 1]];
  if (!exportEvidence.name.endsWith(".xlsx") || exportEvidence.size < 100
    || roomCount !== 2 || roomRows.length !== 2 || roomRows.some(([label]) => !["Room Alpha", "Room Beta"].includes(label))
    || JSON.stringify(switchRows) !== JSON.stringify(knownSwitches)) {
    throw new Error(`Dashboard XLSX unique-room or known-switch-IP parity failed: ${JSON.stringify({exportEvidence,roomCount,roomRows,switchRows})}`);
  }
  console.log(JSON.stringify({dashboardXlsxParityOnly:true,roomCount,roomRows,switchRows,sheets:exportEvidence.sheets,bytes:exportEvidence.size,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--database-unavailable-cache-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]')?.click()`);
  await wait(250);
  await assignInput("#mainFileInput", "cache_2026-10-14.csv", "MAC;Device ID;Model\n00:11:22:33:44:71;CACHE-71;Cache Model");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2]]) {
    await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  }
  await evaluate(`window.confirm=(message)=>{window.__smokeConfirmMessages=[...(window.__smokeConfirmMessages||[]),String(message)];return true}`);
  await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
  let savedStatus = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    savedStatus = await evaluate(`(()=>({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (savedStatus.error) throw new Error(`Cache smoke could not create its disposable Final: ${savedStatus.message}`);
    if (savedStatus.status.includes("1 Final") && savedStatus.status.includes("1 устройств")) break;
  }
  if (!savedStatus?.status.includes("1 Final") || !savedStatus.status.includes("1 устройств")) throw new Error(`The cache smoke Final did not finish: ${JSON.stringify(savedStatus)}`);
  const cachedCounts = await evaluate(`(()=>{const value=JSON.parse(localStorage.getItem('mac-analyzer-database-status-v1')||'null');return value&&{snapshotCount:value.snapshotCount,inventoryCount:value.inventoryCount}})()`);
  if (cachedCounts?.snapshotCount !== 1 || cachedCounts?.inventoryCount !== 1) throw new Error(`Successful database status was not cached before the failure: ${JSON.stringify(cachedCounts)}`);
  await command("Page.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: "window.__smokeIDBFailureInstalled = true; Object.defineProperty(window.indexedDB, 'open', { configurable: true, value() { throw new DOMException('Injected disposable IndexedDB open failure', 'InvalidStateError'); } });" });
  await command("Page.reload", { ignoreCache: true });
  let unavailableState = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    unavailableState = await evaluate(`(()=>({injected:Boolean(window.__smokeIDBFailureInstalled),status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (unavailableState.error && unavailableState.status.includes("1 Final") && unavailableState.status.includes("1 устройств")) break;
  }
  if (!unavailableState?.error || !unavailableState.status.includes("1 Final") || !unavailableState.status.includes("1 устройств") || !unavailableState.message.includes("IndexedDB open failure")) {
    throw new Error(`The exact saved Final and Inventory counts were not retained when IndexedDB became unavailable: ${JSON.stringify({ cachedCounts, unavailableState })}`);
  }
  console.log(JSON.stringify({ cachedCounts, unavailableState, ok: true }));
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--theme-smoke-only")) {
  const measureThemeContrast = () => evaluate(`(()=>{
    const root=getComputedStyle(document.body);
    const channels=(value)=>{if(/^#[\\da-f]{6}$/i.test(value)){const hex=value.slice(1);return[0,2,4].map(index=>parseInt(hex.slice(index,index+2),16))}const result=value.match(/[\\d.]+/g)?.map(Number)||[];if(result.length<3)throw new Error('Unparseable computed theme color: '+value);return result.slice(0,3)};
    const luminance=(value)=>{const linear=channels(value).map(channel=>channel/255<=0.04045?channel/255/12.92:((channel/255+0.055)/1.055)**2.4);const [r,g,b]=linear;return 0.2126*r+0.7152*g+0.0722*b};
    const contrast=(foreground,background)=>{const a=luminance(foreground),b=luminance(background);return Number(((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)).toFixed(2))};
    const fixture=document.createElement('div');fixture.style.cssText='position:fixed;left:-10000px;top:0';fixture.innerHTML='<span class="muted">Muted contrast</span><button class="button primary">Primary contrast</button><button class="button danger">Danger contrast</button>';document.body.append(fixture);
    const muted=getComputedStyle(fixture.querySelector('.muted'));
    const primary=getComputedStyle(fixture.querySelector('.primary'));
    const danger=getComputedStyle(fixture.querySelector('.danger'));
    const banner=document.querySelector('#errorBanner');const wasHidden=banner.hidden;banner.hidden=false;banner.querySelector('span').textContent='Theme contrast smoke';const alert=getComputedStyle(banner);
    const pairs={text:contrast(getComputedStyle(document.body).color,root.getPropertyValue('--surface')),muted:contrast(muted.color,root.getPropertyValue('--surface')),primary:contrast(primary.color,primary.backgroundColor),primaryHover:contrast(root.getPropertyValue('--on-primary'),root.getPropertyValue('--primary-dark')),danger:contrast(danger.color,danger.backgroundColor),dangerSoft:contrast(root.getPropertyValue('--danger'),root.getPropertyValue('--danger-soft')),errorBanner:contrast(alert.color,alert.backgroundColor)};
    banner.hidden=wasHidden;banner.querySelector('span').textContent='';fixture.remove();return{theme:document.body.classList.contains('dark')?'dark':'light',pairs};
  })()`);
  const lightContrast = await measureThemeContrast();
  if (Object.values(lightContrast.pairs).some((ratio) => ratio < 4.5)) throw new Error(`Light theme has a computed WCAG AA contrast failure: ${JSON.stringify(lightContrast)}`);
  await evaluate(`document.querySelector('#themeButton').click()`);
  const initialDialog = await evaluate(`(()=>({open:document.querySelector('#themeDialog').open,choices:[...document.querySelectorAll('[data-theme-choice]')].map(button=>({choice:button.dataset.themeChoice,pressed:button.getAttribute('aria-pressed')}))}))()`);
  if (!initialDialog.open || !initialDialog.choices.some((item) => item.choice === "light") || !initialDialog.choices.some((item) => item.choice === "dark")) {
    throw new Error(`ThemeSelectionDialog did not expose both supported choices: ${JSON.stringify(initialDialog)}`);
  }
  await evaluate(`document.querySelector('[data-theme-choice="dark"]').click()`);
  let appliedTheme = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    appliedTheme = await evaluate(`(()=>({dark:document.body.classList.contains('dark'),pressed:document.querySelector('[data-theme-choice="dark"]')?.getAttribute('aria-pressed'),status:document.querySelector('#themeDialogStatus')?.textContent||''}))()`);
    if (appliedTheme.dark && appliedTheme.pressed === "true") break;
  }
  const storedTheme = await evaluate(`(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(new URL(location.href).searchParams.get('db'));open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction('settings','readonly');const request=tx.objectStore('settings').get('theme');request.onsuccess=()=>resolve(request.result?.value||'');request.onerror=()=>reject(request.error);tx.oncomplete=()=>db.close()}}))()`);
  if (!appliedTheme?.dark || appliedTheme.pressed !== "true" || !appliedTheme.status.includes("Применена тёмная") || storedTheme !== "dark") {
    throw new Error(`Selecting dark theme did not immediately apply and persist the exact choice: ${JSON.stringify({ appliedTheme, storedTheme })}`);
  }
  const darkContrast = await measureThemeContrast();
  if (darkContrast.theme !== "dark" || Object.values(darkContrast.pairs).some((ratio) => ratio < 4.5)) throw new Error(`Dark theme has a computed WCAG AA contrast failure: ${JSON.stringify(darkContrast)}`);
  await evaluate(`document.querySelector('[data-theme-close]').click();localStorage.setItem('mac-analyzer-theme','light')`);
  await command("Page.reload");
  let restoredTheme = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    restoredTheme = await evaluate(`(()=>({ready:document.title==='MAC Analyzer Pro Next'&&Boolean(document.querySelector('#themeButton')),dark:document.body.classList.contains('dark'),local:localStorage.getItem('mac-analyzer-theme')}))()`);
    if (restoredTheme.ready && restoredTheme.dark) break;
  }
  const databaseThemeAfterReload = await evaluate(`(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(new URL(location.href).searchParams.get('db'));open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction('settings','readonly');const request=tx.objectStore('settings').get('theme');request.onsuccess=()=>resolve(request.result?.value||'');request.onerror=()=>reject(request.error);tx.oncomplete=()=>db.close()}}))()`);
  if (!restoredTheme?.ready || !restoredTheme.dark || restoredTheme.local !== "light" || databaseThemeAfterReload !== "dark") {
    throw new Error(`Theme did not restore from IndexedDB ahead of a conflicting localStorage value: ${JSON.stringify({ restoredTheme, databaseThemeAfterReload })}`);
  }
  const restoredContrast = await measureThemeContrast();
  if (restoredContrast.theme !== "dark" || Object.values(restoredContrast.pairs).some((ratio) => ratio < 4.5)) throw new Error(`Restored dark theme has a computed WCAG AA contrast failure: ${JSON.stringify(restoredContrast)}`);
  console.log(JSON.stringify({ themeSmokeOnly: true, choices: initialDialog.choices.map((item) => item.choice), appliedTheme, storedTheme, lightContrast, darkContrast, restoredTheme, restoredContrast, databaseThemeAfterReload, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--batch-folder-metadata-only")) {
  const mainPath = process.env.MAC_ANALYZER_BATCH_MAIN_TEST_PATH || "";
  const mainFilePath = process.env.MAC_ANALYZER_BATCH_MAIN_TEST_FILE || "";
  if (!mainPath || !mainFilePath) throw new Error("Set MAC_ANALYZER_BATCH_MAIN_TEST_PATH and MAC_ANALYZER_BATCH_MAIN_TEST_FILE to isolated Windows test data");
  const csv = "CallingStationID;Device ID\n02:10:00:00:00:01;DEV-BATCH-FS-DATE\n";
  await evaluate(`document.querySelector('[data-view="batch"]')?.click()`);
  let batchMounted = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    batchMounted = await evaluate(`Boolean(document.querySelector('#batchWindowsMainPath')&&document.querySelector('#scanBatchWindowsDatesButton'))`);
    if (batchMounted) break;
  }
  if (!batchMounted) throw new Error("Mass-merge Windows metadata controls did not mount");
  const expectedFile = await evaluate(`(()=>{const file=new File([${JSON.stringify(csv)}],${JSON.stringify(basename(mainFilePath))},{type:'text/csv',lastModified:Date.UTC(2026,0,1)});const transfer=new DataTransfer();transfer.items.add(file);const card=document.querySelector('[data-batch-file-drop="main"]');card.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));return{name:file.name,size:file.size}})()`);
  let selectedReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    selectedReady = await evaluate(`document.querySelector('#batchMainStatus')?.textContent.includes('1 файлов') && document.querySelectorAll('#batchMainFiles .batch-source-file-name').length===1`);
    if (selectedReady) break;
  }
  if (!selectedReady) {
    const state = await evaluate(`(()=>({fileCount:document.querySelector('#batchMainInput').files.length,status:document.querySelector('#batchMainStatus')?.textContent||'',names:[...document.querySelectorAll('#batchMainFiles .batch-source-file-name')].map(item=>item.textContent),preview:document.querySelector('#batchPreview')?.textContent.slice(0,500)||'',error:!document.querySelector('#errorBanner').hidden,errorMessage:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    throw new Error(`Disposable Main file did not finish preview before Windows date scan: ${JSON.stringify(state)}`);
  }
  await evaluate(`document.querySelector('#previewBatchButton').click()`);
  let pairsReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    pairsReady = await evaluate(`!document.querySelector('#batchPreview').classList.contains('empty') && Boolean(document.querySelector('#batchPreview tbody tr:not(.batch-details-row)'))`);
    if (pairsReady) break;
  }
  if (!pairsReady) throw new Error("Batch pair preview did not finish before Windows date scan");
  const mainPathLiteral = JSON.stringify(mainPath);
  const hostMetadata = await evaluate(`fetch('/api/batch/folders/scan',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({paths:{main:${mainPathLiteral},smartroom:'',ddio:''}})}).then(async response=>({status:response.status,body:await response.json()}))`);
  const metadata = hostMetadata.body?.files?.[0];
  if (hostMetadata.status !== 200 || hostMetadata.body?.files?.length !== 1 || metadata?.name !== expectedFile.name || metadata?.size !== expectedFile.size || metadata?.dateSource !== "filesystem.created" || !/^20\d{2}-\d{2}-\d{2}T/.test(metadata.date)) {
    throw new Error(`Windows host did not return the expected isolated creation-date metadata: ${JSON.stringify({ hostMetadata, expectedFile })}`);
  }
  await evaluate(`(()=>{const nativeFetch=window.fetch.bind(window);window.__smokeBatchScanRequest='';window.fetch=(input,init={})=>{if(String(input).includes('/api/batch/folders/scan'))window.__smokeBatchScanRequest=String(init.body||'');return nativeFetch(input,init)};document.querySelector('#batchWindowsMainPath').value=${mainPathLiteral};document.querySelector('#scanBatchWindowsDatesButton').click();return true})()`);
  let scanStatus = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    scanStatus = await evaluate(`document.querySelector('#batchWindowsDatesStatus')?.textContent||''`);
    if (scanStatus.startsWith("Просканировано ")) break;
  }
  const applied = await evaluate(`(()=>({status:document.querySelector('#batchWindowsDatesStatus')?.textContent||'',pairDate:document.querySelector('#batchPreview tbody tr:not(.batch-details-row) td:nth-child(3)')?.textContent.trim()||'',requestBody:window.__smokeBatchScanRequest,error:!document.querySelector('#errorBanner').hidden,errorMessage:document.querySelector('#errorBanner span')?.textContent||''}))()`);
  const expectedDate = metadata.date.slice(0, 10);
  const requestPaths = JSON.parse(applied.requestBody || "{}").paths;
  if (applied.error || !applied.status.includes("сопоставлено с выбранными: 1") || !applied.status.includes("применено дат файловой системы: 1") || applied.pairDate !== expectedDate || requestPaths?.main !== mainPath || applied.requestBody.includes("DEV-BATCH-FS-DATE")) {
    throw new Error(`Windows filesystem creation date did not flow through the app without sending file content: ${JSON.stringify({ applied, expectedDate, expectedFile })}`);
  }
  console.log(JSON.stringify({ batchFolderMetadataOnly: true, expectedFile, dateSource: metadata.dateSource, date: metadata.date, appliedStatus: applied.status, pairDate: applied.pairDate, requestContainsPath: requestPaths.main === mainPath, requestContainsFileContents: applied.requestBody.includes("DEV-BATCH-FS-DATE"), ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (launcherStartupOnly) {
  await command("Runtime.enable");
  const state = await evaluate(`fetch('/api/health',{cache:'no-store'}).then(async(response)=>({httpStatus:response.status,health:await response.json()})).then(({httpStatus,health})=>({title:document.title,path:location.pathname,database:new URL(location.href).searchParams.get('db'),databaseStatus:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,httpStatus,health}))`);
  if (state.title !== "MAC Analyzer Pro Next" || !(state.path === "/" || state.path.endsWith("MAC-Analyzer-Pro-Next.html"))
    || (state.database && !/^mac-analyzer-pro-next-test-[a-z0-9-]{8,80}$/i.test(state.database))
    || !state.databaseStatus || state.error || state.httpStatus !== 200
    || state.health?.status !== "ok" || state.health?.application !== "MAC Analyzer Pro Next") {
    throw new Error(`Launcher did not open a healthy autonomous app in its disposable browser profile: ${JSON.stringify(state)}`);
  }
  console.log(JSON.stringify({ launcherStartupOnly: true, title: state.title, path: state.path, databaseStatus: state.databaseStatus, hostHealth: state.health.status, error: state.error, databaseParameterPresent: Boolean(state.database), ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--pagehide-cleanup-only")) {
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", {
    source: `(()=>{const created=new Set(),cleared=new Set();const nativeSet=globalThis.setInterval.bind(globalThis),nativeClear=globalThis.clearInterval.bind(globalThis);globalThis.setInterval=(callback,delay,...args)=>{const id=nativeSet(callback,delay,...args);created.add(id);return id};globalThis.clearInterval=(id)=>{if(created.has(id))cleared.add(id);return nativeClear(id)};Object.defineProperty(globalThis,"__smokePagehideIntervals",{configurable:true,value:()=>({created:created.size,cleared:cleared.size})})})();`,
  });
  await reloadDatabaseAndWait(new URL(target.url).searchParams.get("db"));
  const cleanup = await evaluate(`(()=>{const before=window.__smokePagehideIntervals();window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:false}));return{before,after:window.__smokePagehideIntervals()}})()`);
  if (cleanup.before.created < 1 || cleanup.after.cleared !== cleanup.before.created) {
    throw new Error(`Browser pagehide did not stop every app-owned interval: ${JSON.stringify(cleanup)}`);
  }
  console.log(JSON.stringify({ pagehideCleanupOnly: true, cleanup, browserLifecycleSignalHandled: true, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--optional-host-workflows-only")) {
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  await wait(300);
  const hostControls = await evaluate(`(()=>{const search=document.querySelector('#optionalHostDatabaseSearchPanel'),maintenance=document.querySelector('#optionalHostDatabaseMaintenancePanel'),backup=document.querySelector('#optionalHostWorkspaceBackupButton'),exportLink=document.querySelector('#optionalHostDatabaseExportLink');return{mounted:Boolean(search&&maintenance&&backup&&exportLink),search:search&&!search.hidden,maintenance:maintenance&&!maintenance.hidden,workspaceBackup:backup&&!backup.hidden,databaseExport:exportLink&&!exportLink.hidden,exportHref:exportLink?.href||''}})()`);
  if (!hostControls.mounted || !hostControls.search || !hostControls.maintenance || !hostControls.workspaceBackup || !hostControls.databaseExport || new URL(hostControls.exportHref).pathname !== "/api/database/export") {
    throw new Error(`Loopback UI did not expose the documented host workflows: ${JSON.stringify(hostControls)}`);
  }
  await evaluate(`document.querySelector('#optionalHostWorkspaceBackupButton').click()`);
  let backupStatus = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    backupStatus = await evaluate(`document.querySelector('#optionalHostWorkspaceBackupStatus')?.textContent||''`);
    if (backupStatus.includes("сохранена в backups optional host")) break;
  }
  if (!backupStatus.includes("сохранена в backups optional host")) throw new Error(`Workspace backup UI did not complete successfully: ${backupStatus}`);
  await evaluate(`(()=>{const form=document.querySelector('#optionalHostDatabaseSearchForm');form.querySelector('[name="query"]').value='';form.requestSubmit();return true})()`);
  let searchStatus = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    searchStatus = await evaluate(`document.querySelector('#optionalHostDatabaseSearchStatus')?.textContent||''`);
    if (searchStatus && !searchStatus.includes("Поиск")) break;
  }
  if (!searchStatus || /ошиб|недоступ|failed/i.test(searchStatus)) throw new Error(`Optional-host database search failed from its UI: ${searchStatus}`);
  await evaluate(`document.querySelector('#optionalHostDatabaseMaintenanceButton').click()`);
  let maintenanceStatus = "";
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await wait(100);
    maintenanceStatus = await evaluate(`document.querySelector('#optionalHostDatabaseMaintenanceStatus')?.textContent||''`);
    if (maintenanceStatus && !maintenanceStatus.includes("Выполняется")) break;
  }
  if (!maintenanceStatus || /ошиб|не выполнен/i.test(maintenanceStatus)) throw new Error(`Optional-host maintenance failed from its UI: ${maintenanceStatus}`);
  const exportProbe = await evaluate(`fetch('/api/database/export',{method:'HEAD',credentials:'same-origin',cache:'no-store'}).then(async r=>({status:r.status,contentType:r.headers.get('content-type'),contentLength:r.headers.get('content-length')}))`);
  if (exportProbe.status !== 200 || !exportProbe.contentType?.includes('sqlite')) throw new Error(`SQLite export control did not resolve to a verified database API: ${JSON.stringify(exportProbe)}`);
  console.log(`browser smoke: optional-host UI saved a workspace backup, searched SQLite, ran maintenance, exposed restore/export controls, and verified export HEAD ${exportProbe.status}`);
  process.exit(0);
}

if (process.argv.includes("--optional-diagnostics-only")) {
  await evaluate(`document.querySelector('[data-view="guide"]')?.click()`);
  let diagnosticsReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(100);
    diagnosticsReady = await evaluate(`Boolean(document.querySelector('#runDiagnosticsButton')) && document.querySelector('#guideView')?.classList.contains('active')`);
    if (diagnosticsReady) break;
  }
  if (!diagnosticsReady) throw new Error("Guide diagnostics controls did not mount after engineer sign-in");
  await evaluate(`document.querySelector('#runDiagnosticsButton').click()`);
  let diagnostics = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    diagnostics = await evaluate(`(()=>({status:document.querySelector('#diagnosticsStatus')?.textContent||'',checks:[...document.querySelectorAll('#diagnosticsResults li')].map((item)=>({title:item.querySelector('strong')?.textContent||'',status:item.className,detail:item.querySelector('span')?.textContent||''}))}))()`);
    if (diagnostics.status.includes("Проверка завершена")) break;
  }
  if (!diagnostics?.status.includes("Проверка завершена")) throw new Error(`Guide diagnostics did not finish: ${JSON.stringify(diagnostics)}`);
  const hostChecks = ["Автономный HTML", "Файлы optional host", "Parity с источником PyQt", "GET /api/health", "GET /api/storage/structure", "GET /api/database/summary", "GET /api/database/search?limit=1", "GET /api/external-vendor/settings", "GET /api/notifications/settings", "GET /api/devices?limit=1", "GET /api/history?limit=1", "GET /api/snapshots?limit=1", "Каталоги optional host", "SQLite optional host"];
  const missingChecks = hostChecks.filter((title) => !diagnostics.checks.some((item) => item.title === title));
  const failedChecks = diagnostics.checks.filter((item) => item.status.includes("diagnostic-error"));
  if (missingChecks.length || failedChecks.length) throw new Error(`Guide diagnostics did not confirm all browser/host checks: ${JSON.stringify({missingChecks,failedChecks,diagnostics})}`);
  console.log(`browser smoke: Guide diagnostics completed with ${diagnostics.checks.length} browser and host checks; required host API, storage, parity, and SQLite checks passed`);
  process.exit(0);
}

await evaluate(`document.querySelector('[data-view="enrichment"]')?.click()`);
await wait(150);
const sourceInputState = await evaluate(`({
  ready: ["#mainFileInput", "#smartroomFileInput", "#ddioFileInput"].every((selector) => document.querySelector(selector)),
  navFound: Boolean(document.querySelector('[data-view="enrichment"]')),
  navActive: document.querySelector('[data-view="enrichment"]')?.classList.contains("active"),
  panelActive: document.querySelector("#enrichmentView")?.classList.contains("active"),
  lazyDetached: document.querySelector("#enrichmentView")?.dataset.lazyDetached,
  panelChildren: document.querySelector("#enrichmentView")?.childElementCount,
})`);
if (!sourceInputState.ready) throw new Error(`Вкладка «Объединение данных» не смонтировала три source input: ${JSON.stringify(sourceInputState)}`);
console.log("browser smoke: enrichment inputs mounted");
await evaluate(`window.confirm=(message)=>{window.__smokeConfirmMessages=[...(window.__smokeConfirmMessages||[]),String(message)];return true}`);
console.log("browser smoke: browser confirmation dialogs auto-accepted for the disposable run");

if (process.argv.includes("--analytics-cache-reopen-only")) {
  await assignInput("#mainFileInput", "analytics-cache-reopen.csv", "MAC;Device ID;Производитель;Модель;IP адрес;Помещение;NasIP;NasPortID;Smartroom ID\n00:11:22:33:44:AC;ANALYTICS-CACHE-REOPEN;CIMSYS Inc;Cache Smoke Model;10.2.0.1;Analytics Smoke Room;10.2.0.254;42;ROOM-AC\n00:11:22:33:44:AD;ANALYTICS-CACHE-OTHER;Other Vendor;Other Cache Model;10.2.0.2;Second Smoke Room;10.2.0.255;43;ROOM-AD\n00:11:22:33:44:AE;ANALYTICS-CACHE-THIRD;CIMSYS Inc;Third Cache Model;10.2.0.3;Analytics Smoke Room;10.2.0.254;42;ROOM-AE");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3], ["ip", 4], ["room", 5], ["switchIp", 6], ["switchPort", 7], ["smartroomId", 8]]) {
    const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main ${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    if (selected !== String(index)) throw new Error(`Analytics-cache Main ${field} mapping did not apply`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let finalState = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    finalState = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (finalState.error) throw new Error(`Analytics-cache fixture failed: ${finalState.message}`);
    if (finalState.status.includes('1 Final') && finalState.status.includes('3 устройств')) break;
  }
  if (!finalState?.status.includes('1 Final') || !finalState.status.includes('3 устройств')) throw new Error(`Analytics-cache fixture did not produce one three-device Final: ${JSON.stringify(finalState)}`);
  await evaluate(`(()=>{window.__smokeSnapshotChunkTransactions=0;const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(stores,...args){const names=typeof stores==='string'?[stores]:Array.from(stores||[]);if(names.includes('snapshotChunks'))window.__smokeSnapshotChunkTransactions+=1;return original.call(this,stores,...args)}})()`);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let firstRender = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    firstRender = await evaluate(`(()=>({active:document.querySelector('#analyticsView')?.classList.contains('active'),loading:!document.querySelector('#analyticsLoadingStatus')?.hidden,overview:document.querySelector('#datasetOverview')?.innerText||'',occupancy:document.querySelector('#roomOccupancyStatus')?.textContent||'',transactions:window.__smokeSnapshotChunkTransactions||0,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (firstRender.error) throw new Error(`Initial analytics render failed: ${firstRender.message}`);
    if (firstRender.active && !firstRender.loading && firstRender.overview.includes('Устройств') && firstRender.occupancy.includes('помещений 2')) break;
  }
  if (!firstRender?.overview.includes('Устройств') || !firstRender.overview.includes('3') || firstRender.transactions < 1) throw new Error(`Initial analytics did not read the expected Final chunks: ${JSON.stringify(firstRender)}`);
  const analyticsDetails = await evaluate(`(()=>({report:document.querySelector('#analyticsReportPreview')?.textContent||'',occupancy:document.querySelector('#roomOccupancyStatus')?.textContent||'',ranking:document.querySelector('#roomOccupancyRanking')?.innerText||'',topology:document.querySelector('#topologySummary')?.innerText||'',exportDisabled:document.querySelector('#exportAnalyticsReportButton')?.disabled,charts:[...document.querySelectorAll('#analyticsView canvas')].map(canvas=>({label:canvas.getAttribute('aria-label')||'',width:canvas.getBoundingClientRect().width,height:canvas.height}))}))()`);
  if (!analyticsDetails.report.includes('CIMSYS Inc') || !analyticsDetails.report.includes('Cache Smoke Model') || !analyticsDetails.report.includes('Other Vendor')
    || !analyticsDetails.report.includes('Third Cache Model') || !analyticsDetails.report.includes('Second Smoke Room')
    || !analyticsDetails.occupancy.includes('3 из 3') || !analyticsDetails.occupancy.includes('100.0%') || !analyticsDetails.occupancy.includes('среднее 1.5')
    || !analyticsDetails.ranking.includes('Analytics Smoke Room') || !analyticsDetails.ranking.includes('Second Smoke Room')
    || !analyticsDetails.topology.includes('10.2.0.254') || !analyticsDetails.topology.includes('10.2.0.255') || (analyticsDetails.topology.match(/1 портов/g)||[]).length !== 2
    || analyticsDetails.exportDisabled || !analyticsDetails.charts.some(({width,height})=>width>0&&height>0)) {
    throw new Error(`Full Analytics report, room occupancy or charts did not show the three-device Final data: ${JSON.stringify({ report:analyticsDetails.report.slice(0,1800),occupancy:analyticsDetails.occupancy,ranking:analyticsDetails.ranking,topology:analyticsDetails.topology,exportDisabled:analyticsDetails.exportDisabled,charts:analyticsDetails.charts.length,topologyPortCounts:(analyticsDetails.topology.match(/1 портов/g)||[]).length })}`);
  }
  await evaluate(`(()=>{Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true});Object.defineProperty(window,'showOpenFilePicker',{value:undefined,configurable:true});const create=URL.createObjectURL.bind(URL);const nativeClick=HTMLAnchorElement.prototype.click;window.__smokeAnalyticsDownloads=[];const blobs=new Map();URL.createObjectURL=blob=>{const url=create(blob);blobs.set(url,blob);return url};HTMLAnchorElement.prototype.click=function(){const blob=blobs.get(this.href);if(blob)window.__smokeAnalyticsDownloads.push({name:this.download,blob});return blob?undefined:nativeClick.call(this)};document.querySelector('#exportAnalyticsReportButton').click();return true})()`);
  const reportExport = await evaluate(`(async()=>{const item=window.__smokeAnalyticsDownloads?.[0];return item?{name:item.name,text:await item.blob.text(),type:item.blob.type}:null})()`);
  if (!reportExport?.name.endsWith('.txt') || !reportExport.text.includes('Cache Smoke Model') || !reportExport.text.includes('Analytics Smoke Room') || !reportExport.text.includes('Other Vendor')) {
    throw new Error(`Analytics TXT export did not contain the full selected Final: ${JSON.stringify(reportExport)}`);
  }
  const captureAnalyticsExport = async (buttonSelector, filename, predicate) => {
    const before = await evaluate(`window.__smokeAnalyticsDownloads.length`);
    await evaluate(`document.querySelector(${JSON.stringify(buttonSelector)}).click()`);
    let result = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(50);
      result = await evaluate(`(async()=>{const item=window.__smokeAnalyticsDownloads[${before}];return item?{name:item.name,text:await item.blob.text(),type:item.blob.type,size:item.blob.size}:null})()`);
      if (result) break;
    }
    if (!result || !filename.test(result.name) || !predicate(result.text) || result.size <= 0) {
      throw new Error(`Portable analytics export ${buttonSelector} was missing or incomplete: ${JSON.stringify(result)}`);
    }
    return result;
  };
  const svgExport = await captureAnalyticsExport('#exportAnalyticsSvgButton', /\.svg$/, (text) => text.includes('<svg') && text.includes('</svg>'));
  const clusterCsvExport = await captureAnalyticsExport('#exportClustersButton', /^clusters\.csv$/, (text) => text.includes('Производитель') && text.includes('Помещение') && text.includes('IP коммутатора') && text.includes('Other Vendor'));
  const topologyHtmlExport = await captureAnalyticsExport('#exportTopologyButton', /^topology\.html$/, (text) => text.includes('<!doctype html>') && text.includes('0011223344AC') && text.includes('10.2.0.255'));
  const topologyLoad = await evaluate(`(()=>{const node=document.querySelector('#topologySummary .local-topology-node');if(!node)throw new Error('Missing switch topology node');node.open=true;const port=node.querySelector('.local-topology-port');if(port){port.open=true;const devices=port.querySelector('[data-topology-load-device-page]');if(devices)devices.click();return{switch:node.dataset.topologyNode||'',port:port.dataset.topologyPortDetail||'',action:devices?'load-devices':'already-loaded'}}const button=node.querySelector('[data-topology-load-ports]');if(button){button.click();return{switch:node.dataset.topologyNode||'',action:'load-ports'}}return{switch:node.dataset.topologyNode||'',text:node.innerText,html:node.innerHTML.slice(0,500),action:'no-load-control'}})()`);
  let topologyPort = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    topologyPort = await evaluate(`(()=>{const node=document.querySelector('#topologySummary .local-topology-node');const port=node?.querySelector('.local-topology-port');if(port)port.open=true;return{switch:node?.dataset.topologyNode||'',port:port?.dataset.topologyPortDetail||'',button:Boolean(port?.querySelector('[data-topology-load-device-page]')),row:Boolean(port?.querySelector('tbody tr'))}})()`);
    if (topologyPort.button||topologyPort.row) break;
  }
  if (!topologyPort?.button&&!topologyPort?.row) throw new Error(`Topology did not load the indexed port roster: ${JSON.stringify({topologyLoad,topologyPort})}`);
  if(topologyPort.button)await evaluate(`document.querySelector('#topologySummary .local-topology-port [data-topology-load-device-page]').click()`);
  let topologyRoster = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    topologyRoster = await evaluate(`(()=>({text:document.querySelector('#topologySummary')?.innerText||'',rows:[...document.querySelectorAll('#topologySummary tbody tr')].map(row=>row.innerText.replaceAll('\u00a0',' ')),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (topologyRoster.error) throw new Error(`Topology device roster failed: ${topologyRoster.message}`);
    if (topologyRoster.rows.some(row=>row.includes('00:11:22:33:44:AC'))) break;
  }
  if (!topologyRoster?.rows.some(row=>row.includes('00:11:22:33:44:AC')&&row.includes('Cache Smoke Model')&&row.includes('Analytics Smoke Room'))) {
    throw new Error(`Topology switch/port did not load the full device row: ${JSON.stringify({topologyLoad,topologyPort,topologyRoster})}`);
  }
  const settledAnalytics = await evaluate(`(()=>({transactions:window.__smokeSnapshotChunkTransactions||0,overview:document.querySelector('#datasetOverview')?.innerText||''}))()`);
  await evaluate(`document.querySelector('[data-view="search"]').click()`);
  await wait(150);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  await wait(300);
  const reopened = await evaluate(`(()=>({active:document.querySelector('#analyticsView')?.classList.contains('active'),loading:!document.querySelector('#analyticsLoadingStatus')?.hidden,overview:document.querySelector('#datasetOverview')?.innerText||'',transactions:window.__smokeSnapshotChunkTransactions||0,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
  if (!reopened.active || reopened.loading || reopened.error || reopened.transactions !== settledAnalytics.transactions || reopened.overview !== settledAnalytics.overview) {
    throw new Error(`Unchanged Analytics tab did not reuse its completed chunk-derived presentation: ${JSON.stringify({firstRender,settledAnalytics,reopened})}`);
  }
  const filterResult = await evaluate(`(()=>{const manufacturer=document.querySelector('#analyticsDashboardManufacturer');const room=document.querySelector('#analyticsDashboardRoom');const choose=(select,value)=>{const option=[...select.options].find((item)=>item.textContent.trim()===value||item.value===value);if(!option)throw new Error('Missing Dashboard filter '+value);select.value=option.value};choose(manufacturer,'Other Vendor');choose(room,'Second Smoke Room');document.querySelector('#applyAnalyticsDashboardFiltersButton').click();return{manufacturer:manufacturer.value,room:room.value}})()`);
  let filteredAnalytics = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    filteredAnalytics = await evaluate(`(()=>({loading:!document.querySelector('#analyticsLoadingStatus').hidden,kpis:document.querySelector('#analyticsKpis').textContent.replace(/\\s+/g,' '),overview:document.querySelector('#datasetOverview').textContent.replace(/\\s+/g,' '),report:document.querySelector('#analyticsReportPreview').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (filteredAnalytics.error) throw new Error(`Portable analytics filters failed: ${filteredAnalytics.message}`);
    if (!filteredAnalytics.loading && filteredAnalytics.kpis.includes('Устройства 1 / 1') && filteredAnalytics.report.includes('Other Vendor')) break;
  }
  if (filteredAnalytics?.loading || !filteredAnalytics.kpis.includes('Устройства 1 / 1') || !filteredAnalytics.report.includes('Other Vendor') || !filteredAnalytics.report.includes('Second Smoke Room')) {
    throw new Error(`Portable vendor/room filters did not isolate the expected one-device result: ${JSON.stringify({filterResult,filteredAnalytics})}`);
  }
  console.log(JSON.stringify({ analyticsCacheReopenOnly: true, initialChunkTransactions: settledAnalytics.transactions, reopenedChunkTransactions: reopened.transactions, reusedOverview: true, analyticsDetails, exports: {report: reportExport.name, svg: {name: svgExport.name, bytes: svgExport.size}, clusters: {name: clusterCsvExport.name, bytes: clusterCsvExport.size}, topology: {name: topologyHtmlExport.name, bytes: topologyHtmlExport.size}}, topologyLoad, topologyPort, topologyRosterRows: topologyRoster.rows.length, filterResult, filteredAnalytics, occupancyAndCharts: true, finalState, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--room-history-parity-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await wait(150);
  const choose = async (field, index) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing main.${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  const runFinal = async (date, csv, expectedFinals) => {
    await assignInput("#mainFileInput", `room-history-${date}.csv`, csv);
    for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2], ["businessUnit", 3], ["city", 4], ["site", 5], ["floor", 6], ["room", 7], ["switchIp", 8], ["switchPort", 9], ["mac2", 10], ["ip", 11]]) await choose(field, index);
    await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
    let state = null;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await wait(100);
      state = await evaluate(`({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
      if (state.error) throw new Error(`Room-history Final ${expectedFinals} failed: ${state.message}`);
      if (state.status.includes(`${expectedFinals} Final`)) return state.status;
    }
    throw new Error(`Room-history Final ${expectedFinals} did not finish: ${JSON.stringify(state)}`);
  };
  const header = "MAC;Device ID;Модель;ТБ;Город;Площадка;Этаж;Помещение;NasIP;NasPortID;MAC 2;IP-адрес\n";
  const present = "00:11:22:33:44:71;ROOM-HISTORY-71;Восстановленная модель;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.1;1;;10.0.0.71\n00:11:22:33:44:72;ROOM-HISTORY-72;Соседнее устройство;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.1;2;00:11:22:33:44:A2;10.0.0.72\n;ROOM-HISTORY-NOMAC;Устройство без MAC;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.2;3;;\n;ROOM-HISTORY-NOMAC;Устройство без MAC;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.2;3;;\n00:11:22:33:44:73;ROOM-HISTORY-73;Пустой IP;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.2;4;;";
  const absent = "00:11:22:33:44:72;ROOM-HISTORY-72;Соседнее устройство;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.1;2;00:11:22:33:44:A2;10.0.0.72\n;ROOM-HISTORY-NOMAC;Устройство без MAC;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.8;4;;\n00:11:22:33:44:73;ROOM-HISTORY-73;Пустой IP;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.2;4;;10.0.0.73";
  const returned = "00:11:22:33:44:71;ROOM-HISTORY-71;;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.3;6;;10.0.0.71\n00:11:22:33:44:72;ROOM-HISTORY-72;Соседнее устройство;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.4;7;00:11:22:33:44:A2;10.0.0.72\n;ROOM-HISTORY-NOMAC;Устройство без MAC;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.9;5;;\n00:11:22:33:44:73;ROOM-HISTORY-73;Пустой IP;ЦА;Москва;Тестовая площадка;3;Проверочная комната;10.0.0.2;4;;10.0.0.73";
  await runFinal("2026-10-14", header + present, 1);
  await runFinal("2026-10-15", header + absent, 2);
  await runFinal("2026-10-16", header + returned, 3);
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  await wait(200);
  const transferControl = await evaluate(`(()=>{const button=document.querySelector('#optionalHostSnapshotUploadButton');return{exists:Boolean(button),disabled:button?.disabled,hidden:button?.hidden}})()`);
  if (!transferControl.exists || transferControl.disabled || transferControl.hidden) throw new Error(`MAC-history fixture cannot explicitly copy the active Final and linked History to the optional host: ${JSON.stringify(transferControl)}`);
  await evaluate(`document.querySelector('#optionalHostSnapshotUploadButton').click()`);
  let snapshotTransferStatus = '';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    snapshotTransferStatus = await evaluate(`document.querySelector('#optionalHostSnapshotUploadStatus')?.textContent||''`);
    if (snapshotTransferStatus.includes('SHA-256')) break;
  }
  if (!snapshotTransferStatus.includes('SHA-256') || !snapshotTransferStatus.includes('History:')) throw new Error(`Active Final/History did not reach the isolated SQLite host: ${snapshotTransferStatus}`);
  const transferredHistory = await evaluate(`fetch('/api/history?mac=00%3A11%3A22%3A33%3A44%3A72&limit=100',{credentials:'same-origin',cache:'no-store'}).then(response=>response.json())`);
  if (!(transferredHistory.items?.length || transferredHistory.rows?.length || transferredHistory.events?.length)) throw new Error(`SQLite host did not retain MAC72 History after UI transfer: ${JSON.stringify(transferredHistory)}`);
  await evaluate(`document.querySelector('[data-view="rooms"]').click()`);
  await wait(300);
  for (const [id, value] of [["businessUnitFilter", "ЦА"], ["cityFilter", "Москва"], ["siteFilter", "Тестовая площадка"], ["floorFilter", "3"], ["roomFilter", "Проверочная комната"]]) {
    const selected = await evaluate(`(()=>{const select=document.querySelector('#${id}');const option=[...select.options].find((item)=>item.value===${JSON.stringify(value)});if(!option)return{ok:false,values:[...select.options].map((item)=>item.value)};select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));return{ok:select.value===${JSON.stringify(value)}}})()`);
    if (!selected.ok) throw new Error(`Room-history filter ${id} did not expose ${value}: ${JSON.stringify(selected)}`);
  }
  await evaluate(`document.querySelector('#showRoomButton').click()`);
  let timeline = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    timeline = await evaluate(`(()=>{const cards=[...document.querySelectorAll('#roomTimeline [data-room-timeline-id]')];return{count:cards.length,first:cards[0]?.textContent||'',last:cards.at(-1)?.textContent.replaceAll('\\u00a0',' ')||'',absence:cards[1]?.textContent||''}})()`);
    if (timeline.count === 3 && timeline.last.includes("Восстановленная модель")) break;
  }
  if (timeline?.count !== 3 || !timeline.last.includes("Восстановленная модель") || !timeline.absence.includes("Отсутствуют (1)")
    || !timeline.absence.includes("00:11:22:33:44:71") || !timeline.absence.includes("Восстановленная модель")) {
    throw new Error(`Room timeline did not retain the known model across the room absence: ${JSON.stringify(timeline)}`);
  }
  await evaluate(`document.querySelector('#compareRoomFinalsButton').click()`);
  let pair = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    pair = await evaluate(`(()=>{const host=document.querySelector('#roomFinalComparison');return{text:host?.textContent.replaceAll('\\u00a0',' ')||'',rows:[...host.querySelectorAll('tbody tr')].map((row)=>row.textContent.replaceAll('\\u00a0',' ').replace(/\\s+/g,' ').trim())}})()`);
    if (pair.rows.length) break;
  }
  if (!pair?.rows.some((row) => row.includes("Добавлено") && row.includes("00:11:22:33:44:71"))) {
    throw new Error(`Latest-Final room comparison lost the returning device: ${JSON.stringify(pair)}`);
  }
  const movement = pair.rows.find((row) => row.includes("Изменено") && row.includes("ROOM-HISTORY-NOMAC")) || "";
  const noMacRosterOccurrences = (timeline.first.match(/ROOM-HISTORY-NOMAC/g) || []).length;
  if (!movement.includes("10.0.0.8") || !movement.includes("10.0.0.9") || !movement.includes("4") || !movement.includes("5")
    || !movement.includes("IP коммутатора") || !movement.includes("Порт:") || noMacRosterOccurrences !== 1
    || !pair.rows.some((row) => row.includes("Изменено") && row.includes("ROOM-HISTORY-NOMAC"))) {
    throw new Error(`Room timeline lost the no-MAC identity, deduplicated row or switch IP/port movement: ${JSON.stringify({ pair, movement, noMacRosterOccurrences })}`);
  }
  await evaluate(`document.querySelector('[data-view="history"]').click()`);
  await wait(200);
  await evaluate(`(()=>{const input=document.querySelector('#macHistorySearch');input.value='00:11:22:33:44:72';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#openMacHistoryButton').click();return true})()`);
  let macTimeline = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    macTimeline = await evaluate(`(()=>{const summary=document.querySelector('#macTimelineSummary');const cards=[...document.querySelectorAll('#macTimeline .mac-timeline-item')];cards.forEach(card=>card.open=true);const comparisons=cards.flatMap(card=>[...card.querySelectorAll('.timeline-final-comparison')]);comparisons.forEach(item=>item.open=true);return{summary:summary?.innerText||'',count:cards.length,text:cards.map(card=>card.innerText.replaceAll('\u00a0',' ')),comparisons:comparisons.map(item=>item.innerText.replaceAll('\u00a0',' ')),errors:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
    if (macTimeline.errors) throw new Error(`MAC timeline UI failed: ${macTimeline.message}`);
    if (macTimeline.count >= 3) break;
  }
  if (macTimeline?.count !== 3 || !macTimeline.summary.includes("3")
    || !macTimeline.text.some((text) => text.includes("Изменение"))
    || !macTimeline.comparisons.some((text) => text.includes("Было в предыдущем Final") && text.includes("Стало в новом Final"))) {
    throw new Error(`MAC timeline did not show three deduplicated Finals and the previous/new Final comparison: ${JSON.stringify(macTimeline)}`);
  }
  await evaluate(`document.querySelector('#loadOptionalHostMacHistoryButton').click()`);
  let mergedHostTimeline = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    mergedHostTimeline = await evaluate(`(()=>{const summary=document.querySelector('#macTimelineSummary');const cards=[...document.querySelectorAll('#macTimeline .mac-timeline-item')];cards.forEach(card=>card.open=true);const status=document.querySelector('#optionalHostMacHistoryStatus')?.textContent||'';return{summary:summary?.innerText||'',count:cards.length,status,errors:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
    if (mergedHostTimeline.errors) throw new Error(`SQLite History merge failed: ${mergedHostTimeline.message}`);
    if (mergedHostTimeline.status.startsWith('History optional host:')) break;
  }
  if (mergedHostTimeline?.count !== 3 || !mergedHostTimeline.status.startsWith('History optional host:') || !mergedHostTimeline.summary.includes('3')) {
    throw new Error(`SQLite History merge duplicated or removed MAC timeline events: ${JSON.stringify({mergedHostTimeline,macTimeline})}`);
  }
  const alternateMac = '00:11:22:33:44:A2';
  await evaluate(`(()=>{const input=document.querySelector('#macHistorySearch');input.value=${JSON.stringify(alternateMac)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#openMacHistoryButton').click();return true})()`);
  let alternateMacTimeline = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    alternateMacTimeline = await evaluate(`(()=>{const summary=document.querySelector('#macTimelineSummary');const cards=[...document.querySelectorAll('#macTimeline .mac-timeline-item')];cards.forEach(card=>card.open=true);return{summary:summary?.innerText||'',count:cards.length,text:cards.map(card=>card.innerText.replaceAll('\u00a0',' ')),errors:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
    if (alternateMacTimeline.errors) throw new Error(`Alternate-MAC browser timeline failed: ${alternateMacTimeline.message}`);
    if (alternateMacTimeline.count >= 3) break;
  }
  if (alternateMacTimeline?.count !== 3 || !alternateMacTimeline.text.some(text=>text.includes(alternateMac)) || !alternateMacTimeline.summary.includes('Изменений\n2')
    || await evaluate(`document.querySelector('#macHistorySearch')?.value||''`) !== alternateMac) {
    throw new Error(`Alternate-MAC query did not find the full device History: ${JSON.stringify(alternateMacTimeline)}`);
  }
  await evaluate(`(()=>{const input=document.querySelector('#macHistorySearch');input.value='00:11:22:33:44:73';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#openMacHistoryButton').click();return true})()`);
  let emptyToKnownTimeline = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    emptyToKnownTimeline = await evaluate(`(()=>{const summary=document.querySelector('#macTimelineSummary');const cards=[...document.querySelectorAll('#macTimeline .mac-timeline-item')];return{summary:summary?.innerText||'',count:cards.length,text:cards.map(card=>card.innerText.replaceAll('\u00a0',' ')),status:document.querySelector('#optionalHostMacHistoryStatus')?.textContent||'',errors:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}})()`);
    if (emptyToKnownTimeline.errors) throw new Error(`Empty-to-known MAC history UI failed: ${emptyToKnownTimeline.message}`);
    if (emptyToKnownTimeline.count >= 3) break;
  }
  if (emptyToKnownTimeline?.count !== 3 || !emptyToKnownTimeline.summary.includes('Изменений\n0')
    || emptyToKnownTimeline.text.some((text) => text.includes('Изменение'))) {
    throw new Error(`Empty-to-known device IP created a synthetic change: ${JSON.stringify(emptyToKnownTimeline)}`);
  }
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let temporalDay = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    temporalDay = await evaluate(`(()=>({summary:[...document.querySelectorAll('#temporalSummary .kpi')].map(item=>[item.querySelector('span')?.textContent||'',item.querySelector('strong')?.textContent||'']),rows:[...document.querySelectorAll('#temporalTable tbody tr')].map(row=>[...row.cells].map(cell=>cell.innerText.replaceAll('\u00a0',' ').trim())),loading:!document.querySelector('#analyticsLoadingStatus')?.hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',exportDisabled:document.querySelector('#exportTemporalCsvButton')?.disabled}))()`);
    if (temporalDay.error) throw new Error(`Temporal statistics browser UI failed: ${temporalDay.message}`);
    if (temporalDay.rows.length === 3 && !temporalDay.loading) break;
  }
  if (temporalDay?.rows.length !== 3 || temporalDay.rows.map(row=>row[0]).join(',') !== '2026-10-14,2026-10-15,2026-10-16'
    || !temporalDay.summary.some(([label,value])=>label==='Уникальных MAC'&&value==='3')
    || !temporalDay.summary.some(([label,value])=>label==='Снимков'&&value==='3')
    || temporalDay.exportDisabled) throw new Error(`Daily temporal statistics did not preserve exact UTC periods, counts and export state: ${JSON.stringify(temporalDay)}`);
  const temporalView = async (period) => {
    await evaluate(`(()=>{const select=document.querySelector('#temporalPeriodSelect');select.value=${JSON.stringify(period)};select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    let result = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await wait(100);
      result = await evaluate(`(()=>({rows:[...document.querySelectorAll('#temporalTable tbody tr')].map(row=>[...row.cells].map(cell=>cell.innerText.replaceAll('\u00a0',' ').trim())),loading:!document.querySelector('#analyticsLoadingStatus')?.hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
      if (result.error) throw new Error(`Temporal ${period} grouping failed: ${result.message}`);
      if (result.rows.length && !result.loading) break;
    }
    return result;
  };
  const temporalWeek = await temporalView('week');
  const temporalMonth = await temporalView('month');
  if (temporalWeek.rows.length !== 1 || temporalWeek.rows[0][0] !== '2026-W42' || temporalMonth.rows.length !== 1 || temporalMonth.rows[0][0] !== '2026-10') {
    throw new Error(`Temporal ISO-week/month grouping was not exact: ${JSON.stringify({temporalWeek,temporalMonth})}`);
  }
  await evaluate(`(()=>{Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:undefined});const create=URL.createObjectURL.bind(URL);const click=HTMLAnchorElement.prototype.click;window.__smokeTemporalCsv=null;const blobs=new Map();URL.createObjectURL=blob=>{const url=create(blob);blobs.set(url,blob);return url};HTMLAnchorElement.prototype.click=function(){const blob=blobs.get(this.href);if(this.download==='temporal-statistics.csv')window.__smokeTemporalCsv={name:this.download,blob};return click.call(this)};document.querySelector('#exportTemporalCsvButton').click();return true})()`);
  let temporalCsv = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    temporalCsv = await evaluate(`(async()=>{const item=window.__smokeTemporalCsv;return item?{name:item.name,text:await item.blob.text()}:null})()`);
    if (temporalCsv) break;
  }
  if (temporalCsv?.name !== 'temporal-statistics.csv' || !temporalCsv.text.includes('2026-10') || !temporalCsv.text.includes('room-history-2026-10-16.csv')) throw new Error(`Temporal CSV export did not contain the full selected grouping: ${JSON.stringify(temporalCsv)}`);
  console.log(JSON.stringify({ roomHistoryParityOnly: true, finals: 3, temporaryDeviceRoomAbsence: timeline.absence.includes("Отсутствуют (1)") && timeline.absence.includes("00:11:22:33:44:71"), restoredModelVisible: timeline.last.includes("Восстановленная модель"), latestPairAddedReturningDevice: true, switchIpAndPortMovement: true, deviceIdMatchedWithoutMac: pair.rows.some((row) => row.includes("Изменено") && row.includes("ROOM-HISTORY-NOMAC")), duplicateSourceRowDeduplicated: noMacRosterOccurrences === 1, macTimeline, transferredHistoryRows: transferredHistory.items?.length ?? transferredHistory.rows?.length ?? transferredHistory.events?.length ?? 0, mergedHostTimeline, alternateMacTimeline, emptyToKnownTimeline, temporalDay, temporalWeek, temporalMonth, temporalCsvName: temporalCsv.name, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--final-export-all-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await wait(150);
  await assignInput("#mainFileInput", "final-export-2026-10-14.csv", "MAC;Device ID;Модель;IP адрес;Помещение\n00:11:22:33:44:81;EXPORT-81;Export Model;192.0.2.81;Export Room");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2], ["ip", 3], ["room", 4]]) {
    await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  }
  await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
  let finalReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    const state = await evaluate(`({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (state.error) throw new Error(`Final export fixture failed: ${state.message}`);
    if (state.status.includes("1 Final") && state.status.includes("1 устройств")) { finalReady = true; break; }
  }
  if (!finalReady) throw new Error("Final export fixture did not produce exactly one device");
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  await wait(150);
  await evaluate(`(()=>{Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:undefined});window.__smokeFinalExports=[];const create=URL.createObjectURL.bind(URL);URL.createObjectURL=(blob)=>{window.__smokeFinalExports.push({blob,name:''});return create(blob)};HTMLAnchorElement.prototype.click=function(){const item=window.__smokeFinalExports.at(-1);if(item)item.name=this.download};return true})()`);
  const formats = ["Csv", "Xlsx", "Txt", "Json", "Yaml", "Html", "Pdf"];
  const exports = {};
  for (const format of formats) {
    const before = await evaluate(`window.__smokeFinalExports.length`);
    await evaluate(`document.querySelector('#exportFinal${format}Button').click()`);
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await wait(100);
      const count = await evaluate(`window.__smokeFinalExports.length`);
      if (count > before) {
        const result = await evaluate(`(async()=>{const item=window.__smokeFinalExports.at(-1);if(!item?.name)return null;const bytes=new Uint8Array(await item.blob.arrayBuffer());return{name:item.name,type:item.blob.type,size:bytes.length,signature:[...bytes.slice(0,8)],text:['csv','txt','json','yaml','html'].includes(${JSON.stringify(format.toLowerCase())})?new TextDecoder().decode(bytes):''}})()`);
        if (result) { exports[format.toLowerCase()] = result; break; }
      }
    }
    if (!exports[format.toLowerCase()]) throw new Error(`Final ${format} export did not produce a download`);
  }
  const textFormats = ["csv", "txt", "json", "yaml", "html"];
  const expectedNames = { csv: "final.csv", xlsx: "final.xlsx", txt: "final.txt", json: "final.json", yaml: "final.yaml", html: "final.html", pdf: "final.pdf" };
  for (const format of textFormats) {
    if (exports[format].name !== expectedNames[format] || !exports[format].text.includes("00:11:22:33:44:81")) throw new Error(`Final ${format} export omitted the device or had the wrong filename: ${JSON.stringify(exports[format])}`);
  }
  if (exports.xlsx.name !== expectedNames.xlsx || exports.xlsx.signature[0] !== 80 || exports.xlsx.signature[1] !== 75
    || !/^mac-analyzer-final-\d{4}-\d{2}-\d{2}\.pdf$/.test(exports.pdf.name) || exports.pdf.signature[0] !== 37 || exports.pdf.signature[1] !== 80 || exports.pdf.size < 1000) {
    throw new Error(`Final XLSX/PDF artifact signature or filename is invalid: ${JSON.stringify({ xlsx: exports.xlsx, pdf: exports.pdf })}`);
  }
  console.log(JSON.stringify({ finalExportAllOnly: true, formats: Object.keys(exports), deviceIncludedInEveryTextExport: true, xlsxZip: exports.xlsx.signature.slice(0, 4), pdf: { bytes: exports.pdf.size, signature: exports.pdf.signature.slice(0, 5) }, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--final-write-failure-only")) {
  const choose = async (field, index) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing main.${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  const runFinal = async (date, model, expectedFinals) => {
    await assignInput("#mainFileInput", `failure_${date}.csv`, `MAC;Device ID;Model\n00:11:22:33:44:71;FAIL-71;${model}`);
    for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2]]) await choose(field, index);
    await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
    let state = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await wait(100);
      state = await evaluate(`(()=>({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
      if (expectedFinals === 1 && state.error) throw new Error(`Initial control Final failed: ${state.message}`);
      if (expectedFinals === 2 && state.error) return state;
      if (state.status.includes(`${expectedFinals} Final`)) return state;
    }
    throw new Error(`Final write-failure smoke ${expectedFinals} did not finish: ${JSON.stringify(state)}`);
  };
  await runFinal("2026-10-14", "Stable Model", 1);
  const activeBeforeFailure = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,snapshotCount:snapshots.result,inventoryCount:inventory.result,historyCount:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  await evaluate(`(()=>{const originalPut=IDBObjectStore.prototype.put;const originalAdd=IDBObjectStore.prototype.add;window.__smokeInjectedWriteFailure=false;const fail=function(){if(window.__smokeInjectFinalFailure&&this.name==='snapshotChunks'&&!window.__smokeInjectedWriteFailure){window.__smokeInjectedWriteFailure=true;this.transaction.abort();throw new DOMException('Injected disposable smoke write failure','QuotaExceededError')}};IDBObjectStore.prototype.put=function(...args){fail.call(this);return originalPut.apply(this,args)};IDBObjectStore.prototype.add=function(...args){fail.call(this);return originalAdd.apply(this,args)}})()`);
  await assignInput("#mainFileInput", "failure_2026-10-15.csv", "MAC;Device ID;Model\n00:11:22:33:44:71;FAIL-71;Changed Model");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2]]) await choose(field, index);
  await evaluate(`window.__smokeInjectFinalFailure=true;document.querySelector('#runEnrichmentButton').click()`);
  let failureUi = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    failureUi = await evaluate(`(()=>({visible:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',status:document.querySelector('#databaseStatus').textContent,injected:window.__smokeInjectedWriteFailure}))()`);
    if (failureUi.visible) break;
  }
  if (!failureUi?.visible || !failureUi.injected) throw new Error(`Injected Final write failure did not surface in UI: ${JSON.stringify(failureUi)}`);
  const afterFailure = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const activeId=active.result?.value;const devices=chunks.result.filter((chunk)=>chunk.snapshotId===activeId).flatMap((chunk)=>chunk.devices||[]);db.close();resolve({activeId,snapshotCount:snapshots.result,inventoryCount:inventory.result,historyCount:history.result,model:devices[0]?.model,status:document.querySelector('#databaseStatus').textContent})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (afterFailure.activeId !== activeBeforeFailure.activeId || afterFailure.snapshotCount !== activeBeforeFailure.snapshotCount || afterFailure.inventoryCount !== activeBeforeFailure.inventoryCount || afterFailure.historyCount !== activeBeforeFailure.historyCount || afterFailure.model !== "Stable Model" || !afterFailure.status.includes("1 Final")) throw new Error(`Failed Final write replaced active data: ${JSON.stringify({activeBeforeFailure,failureUi,afterFailure})}`);
  await evaluate(`document.querySelector('[data-error-dismiss]').click()`);
  const dismissed = await evaluate(`({hidden:document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
  if (!dismissed.hidden || dismissed.message) throw new Error(`Write-error banner did not dismiss cleanly after failed Final: ${JSON.stringify(dismissed)}`);
  console.log(JSON.stringify({ failureUi, previousFinalPreserved: afterFailure.activeId === activeBeforeFailure.activeId, snapshotCount: afterFailure.snapshotCount, model: afterFailure.model, errorDismissed: dismissed.hidden, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--ieee-registry-parity-only")) {
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  const settingsReady = await evaluate(`Boolean(document.querySelector('#historyEnrichmentPrecedenceProfile') && document.querySelector('#saveHistoryEnrichmentSettingsButton'))`);
  if (!settingsReady) throw new Error("History profile controls are not mounted in the data view");
  await evaluate(`(()=>{const profile=document.querySelector('#historyEnrichmentPrecedenceProfile');profile.value='web';profile.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#saveHistoryEnrichmentSettingsButton').click();return profile.value})()`);
  let profileSaved = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(100);
    profileSaved = await evaluate(`document.querySelector('#historyEnrichmentStatus')?.textContent.includes('сохран')`);
    if (profileSaved) break;
  }
  if (!profileSaved) throw new Error(`Could not save the explicit Web prefix-match profile: ${await evaluate(`document.querySelector('#historyEnrichmentStatus')?.textContent||''`)}`);
  const state = await evaluate(`({ouiEnabled:document.querySelector('#vendorOuiEnabled')?.checked,detectorEnabled:document.querySelector('#vendorDetectorEnabled')?.checked})`);
  if (!state.ouiEnabled || !state.detectorEnabled) throw new Error(`IEEE vendor detection must be enabled for this smoke: ${JSON.stringify(state)}`);
  await evaluate(`document.querySelector('[data-view="enrichment"]')?.click()`);
  await assignInput("#mainFileInput", "ieee-registry-smoke.csv", "MAC;Device ID\n00:00:01:00:00:01;IEEE-MA-L\n00:55:DA:00:00:01;IEEE-MA-M\n00:1B:C5:00:00:01;IEEE-MA-S\n0A:2A:33:00:00:01;IEEE-CID-ONLY");
  for (const [field, index] of [["mac", 0], ["deviceId", 1]]) {
    const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${selected}`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton')?.click()`);
  let stored = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(100);
    stored = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const devices=chunks.result.filter((chunk)=>chunk.snapshotId===active.result?.value).flatMap((chunk)=>chunk.devices||[]);db.close();resolve({activeId:active.result?.value||'',devices:devices.map(({deviceId,mac,manufacturer,manufacturerSource,vendorSource,vendorConfidence})=>({deviceId,mac,manufacturer:manufacturer||'',manufacturerSource:manufacturerSource||'',vendorSource:vendorSource||'',vendorConfidence:vendorConfidence??null}))})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (stored.activeId && stored.devices.length === 4) break;
  }
  const expectedVendors = new Map([["IEEE-MA-L", "XEROX CORPORATION"], ["IEEE-MA-M", "Shinko Technos co.,ltd."], ["IEEE-MA-S", "Converging Systems Inc."]]);
  for (const [deviceId, vendor] of expectedVendors) {
    const device = stored?.devices.find((item) => item.deviceId === deviceId);
    if (device?.manufacturer !== vendor || device.vendorSource !== "Встроенный IEEE OUI" || device.vendorConfidence !== 0.9) throw new Error(`Web-profile IEEE prefix lookup/provenance mismatch for ${deviceId}: ${JSON.stringify({ expected: vendor, device, stored })}`);
  }
  const cidDevice = stored?.devices.find((item) => item.deviceId === "IEEE-CID-ONLY");
  if (!cidDevice || cidDevice.manufacturer === "DIGISTOR") throw new Error(`CID-only assignment incorrectly became an automatic device manufacturer: ${JSON.stringify({ cidDevice, stored })}`);
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  let cidMounted = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    cidMounted = Boolean(await evaluate(`document.querySelector('#ieeeCidCatalogDetails')`));
    if (cidMounted) break;
  }
  if (!cidMounted) throw new Error("IEEE CID catalog is not mounted in the data view");
  await evaluate(`(()=>{const details=document.querySelector('#ieeeCidCatalogDetails');details.open=true;const query=document.querySelector('#ieeeCidQuery');query.value='0A2A33';document.querySelector('#ieeeCidSearchForm').requestSubmit();return true})()`);
  let cidCatalog = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    cidCatalog = await evaluate(`({status:document.querySelector('#ieeeCidCatalogStatus')?.textContent||'',table:document.querySelector('#ieeeCidCatalogTable')?.innerText||''})`);
    if (cidCatalog.table.includes("0A2A33") && cidCatalog.table.includes("DIGISTOR")) break;
  }
  if (!cidCatalog?.table.includes("0A2A33") || !cidCatalog.table.includes("DIGISTOR")) throw new Error(`IEEE CID catalog search failed: ${JSON.stringify(cidCatalog)}`);
  await evaluate(`(()=>{document.querySelector('#vendorOuiEnabled').checked=false;document.querySelector('#vendorOuiEnabled').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#vendorTextEnabled').checked=true;document.querySelector('#vendorTextEnabled').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#vendorInferenceEnabled').checked=true;document.querySelector('#vendorInferenceEnabled').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#saveVendorInferenceSettingsButton').click()})()`);
  let detectorSettingsSaved = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(100);
    detectorSettingsSaved = await evaluate(`document.querySelector('#vendorInferenceStatus')?.textContent.includes('сохранены')`);
    if (detectorSettingsSaved) break;
  }
  if (!detectorSettingsSaved) throw new Error("Vendor text/inference settings were not saved through the UI");
  await evaluate(`document.querySelector('[data-view="enrichment"]')?.click()`);
  await assignInput("#mainFileInput", "vendor-detector-text-inference.csv", "MAC;Device ID;Производитель;Модель\nAA:BB:CC:DD:EE:01;VENDOR-PEER-1;Acme;Codec A\nAA:BB:CC:DD:EE:02;VENDOR-PEER-2;Acme;Codec A\nAA:BB:CC:DD:EE:FF;VENDOR-INFERENCE;;\n00:11:22:33:66:01;VENDOR-TEXT;;Cisco Catalyst Nexus Router");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3]]) {
    const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main ${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply for vendor text/inference smoke: ${selected}`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton')?.click()`);
  let enriched = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(100);
    enriched = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const devices=chunks.result.filter((chunk)=>chunk.snapshotId===active.result?.value).flatMap((chunk)=>chunk.devices||[]);db.close();resolve({activeId:active.result?.value||'',devices:devices.map(({deviceId,manufacturer,model,vendorSource,vendorConfidence,modelSource,modelConfidence})=>({deviceId,manufacturer:manufacturer||'',model:model||'',vendorSource:vendorSource||'',vendorConfidence:vendorConfidence??null,modelSource:modelSource||'',modelConfidence:modelConfidence??null}))})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (enriched.activeId && enriched.devices.length === 4) break;
  }
  const inferred = enriched?.devices.find((device) => device.deviceId === "VENDOR-INFERENCE");
  const textDetected = enriched?.devices.find((device) => device.deviceId === "VENDOR-TEXT");
  if (inferred?.manufacturer !== "Acme" || inferred.model !== "Codec A" || inferred.vendorSource !== "Similar device inference"
    || inferred.modelSource !== "Similar device inference" || inferred.vendorConfidence !== 0.78 || Math.abs(inferred.modelConfidence - 0.702) > 1e-12
    || textDetected?.manufacturer !== "Cisco" || !textDetected.vendorSource.startsWith("Text:") || textDetected.vendorConfidence !== 0.8) {
    throw new Error(`Local vendor text/similarity detection did not retain reference values and provenance: ${JSON.stringify({ inferred, textDetected, enriched })}`);
  }
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  await evaluate(`(()=>{const profile=document.querySelector('#historyEnrichmentPrecedenceProfile');profile.value='pyqt';profile.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#saveHistoryEnrichmentSettingsButton').click();document.querySelector('#vendorOuiEnabled').checked=true;document.querySelector('#vendorOuiEnabled').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#vendorTextEnabled').checked=false;document.querySelector('#vendorTextEnabled').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#vendorInferenceEnabled').checked=false;document.querySelector('#vendorInferenceEnabled').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#saveVendorInferenceSettingsButton').click()})()`);
  let pyqtSettingsSaved = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(100);
    pyqtSettingsSaved = await evaluate(`document.querySelector('#historyEnrichmentStatus')?.textContent.includes('сохранены')&&document.querySelector('#vendorInferenceStatus')?.textContent.includes('сохранены')`);
    if (pyqtSettingsSaved) break;
  }
  if (!pyqtSettingsSaved) throw new Error("PyQt profile and OUI detector settings were not saved through the UI");
  await evaluate(`document.querySelector('[data-view="enrichment"]')?.click()`);
  await assignInput("#mainFileInput", "pyqt-vendor-profile.csv", "MAC;Device ID\n00:00:01:00:00:11;VENDOR-PYQT-OUI");
  for (const [field, index] of [["mac", 0], ["deviceId", 1]]) {
    const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main ${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply for PyQt-profile vendor smoke: ${selected}`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton')?.click()`);
  let pyqtProfile = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(100);
    pyqtProfile = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const devices=chunks.result.filter((chunk)=>chunk.snapshotId===active.result?.value).flatMap((chunk)=>chunk.devices||[]);db.close();resolve({activeId:active.result?.value||'',device:devices.find((row)=>row.deviceId==='VENDOR-PYQT-OUI')||null})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (pyqtProfile.activeId && pyqtProfile.device) break;
  }
  if (pyqtProfile.device?.manufacturer !== "XEROX CORPORATION" || pyqtProfile.device.vendorSource !== "Встроенный IEEE OUI" || pyqtProfile.device.vendorConfidence !== 0.95) {
    throw new Error(`PyQt-profile OUI confidence/source did not match the reference: ${JSON.stringify(pyqtProfile)}`);
  }
  console.log(JSON.stringify({ ieeeOuiEnabled: state.ouiEnabled, manufacturers: [...expectedVendors], ouiProvenance: stored.devices.filter((device) => expectedVendors.has(device.deviceId)), cidWasCatalogued: cidCatalog.table.includes("0A2A33"), cidDidNotBecomeVendor: !cidDevice.manufacturer.includes("DIGISTOR"), detectorSettingsSaved, inferred, textDetected, pyqtProfile, activeSnapshotId: pyqtProfile.activeId, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--data-quality-report-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]')?.click()`);
  await assignInput("#mainFileInput", "quality-smoke.csv", "MAC;Device ID;Производитель;Модель;Название комнаты;IP адрес\n00:11:22:33:44:A1;QUALITY-A1;Acme;Edge Switch;;192.0.2.11\n00:11:22:33:44:A2;QUALITY-A2;;;Room 2;");
  const chooseMapping = async (field, index) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3], ["room", 4], ["ip", 5]]) {
    if (await chooseMapping(field, index) !== String(index)) throw new Error(`Main ${field} mapping did not apply`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton')?.click()`);
  const databaseName = new URL(target.url).searchParams.get("db");
  let finalState = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    finalState = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(databaseName)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const metadata=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{const snapshot=metadata.result.find((item)=>item.id===active.result?.value);db.close();resolve({activeId:active.result?.value||'',name:snapshot?.name||'',snapshotType:snapshot?.snapshotType||'',deviceCount:snapshot?.deviceCount||0})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (finalState.snapshotType === "final" && finalState.deviceCount === 2) break;
  }
  if (finalState?.snapshotType !== "final" || finalState.deviceCount !== 2 || !finalState.activeId) throw new Error(`Quality smoke did not create its disposable two-device Final: ${JSON.stringify(finalState)}`);
  await evaluate(`document.querySelector('[data-view="analytics"]')?.click()`);
  let qualityPanelReady = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    qualityPanelReady = await evaluate(`Boolean(document.querySelector('#dataQualityPanel') && !document.querySelector('#dataQualityPanel').hidden && !document.querySelector('#runDataQualityButton').disabled)`);
    if (qualityPanelReady) break;
  }
  if (!qualityPanelReady) throw new Error("Engineer-only quality report panel did not become available in Analytics");
  await evaluate(`(()=>{const select=document.querySelector('#currentSnapshotSelect');if(select&&select.value!==${JSON.stringify(finalState.activeId)}){select.value=${JSON.stringify(finalState.activeId)};select.dispatchEvent(new Event('change',{bubbles:true}))}document.querySelector('#runDataQualityButton').click();return true})()`);
  let reportUi = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    reportUi = await evaluate(`(()=>({status:document.querySelector('#dataQualityStatus')?.textContent||'',report:document.querySelector('#dataQualityReport')?.innerText||'',historyStatus:document.querySelector('#dataQualityHistoryStatus')?.textContent||'',history:document.querySelector('#dataQualityHistory')?.innerText||''}))()`);
    if (reportUi.status.includes("завершена и сохранена") && reportUi.historyStatus.includes("из 1")) break;
  }
  if (!reportUi?.status.includes("завершена и сохранена") || !reportUi.report.includes("Оценка качества") || !reportUi.report.includes("Заполненность полей полного Final") || !reportUi.history.includes(finalState.name) || !reportUi.historyStatus.includes("из 1")) throw new Error(`Quality report did not render and enter the one-row saved history: ${JSON.stringify({finalState,reportUi})}`);
  const savedReport = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(databaseName)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('dataQualityReports','readonly');const request=tx.objectStore('dataQualityReports').getAll();tx.oncomplete=()=>{const records=request.result;db.close();resolve(records.map(({id,snapshotId,snapshotName,score,grade,report})=>({id,snapshotId,snapshotName,score,grade,devices:report?.devices,issues:report?.issues?.length||0,fieldCoverage:Object.keys(report?.fieldCoverage||{}).length}))) };tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (savedReport.length !== 1 || savedReport[0].snapshotId !== finalState.activeId || savedReport[0].snapshotName !== finalState.name || savedReport[0].devices !== 2 || !["A", "B", "C", "D"].includes(savedReport[0].grade) || savedReport[0].fieldCoverage < 7) throw new Error(`Saved quality report metadata or full-field coverage did not persist: ${JSON.stringify(savedReport)}`);
  const reportClip = await evaluate(`(()=>{const rect=document.querySelector('#dataQualityPanel').getBoundingClientRect();return{x:0,y:rect.top+scrollY,width:document.documentElement.clientWidth,height:Math.min(rect.height,2600)}})()`);
  const screenshot = await command("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true, clip: { ...reportClip, scale: 1 } });
  const screenshotPath = resolve("dist/.data-quality-browser-smoke.png");
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  await reloadDatabaseAndWait(databaseName);
  await evaluate(`document.querySelector('#engineeringModeButton')?.click()`);
  await evaluate(`(()=>{const field=document.querySelector('#engineeringPassword');field.value=${JSON.stringify(smokeEngineerPassword)};field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#engineeringModeForm').requestSubmit();return true})()`);
  let engineerRestored = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    engineerRestored = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes('Инженер')`);
    if (engineerRestored) break;
  }
  if (!engineerRestored) throw new Error("Could not restore the disposable engineer session to verify saved quality history after reload");
  await evaluate(`document.querySelector('[data-view="analytics"]')?.click()`);
  let historyAfterReload = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    historyAfterReload = await evaluate(`({status:document.querySelector('#dataQualityHistoryStatus')?.textContent||'',rows:document.querySelector('#dataQualityHistory')?.innerText||'',panelHidden:document.querySelector('#dataQualityPanel')?.hidden})`);
    if (historyAfterReload.status.includes("из 1") && historyAfterReload.rows.includes(finalState.name)) break;
  }
  if (historyAfterReload?.panelHidden || !historyAfterReload?.status.includes("из 1") || !historyAfterReload.rows.includes(finalState.name)) throw new Error(`Saved quality history did not persist across application restart: ${JSON.stringify(historyAfterReload)}`);
  console.log(JSON.stringify({ final: finalState, report: savedReport[0], reportUi: { status: reportUi.status, historyStatus: reportUi.historyStatus }, persistedAfterReload: historyAfterReload.status, screenshotPath, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--change-criticality-browser-only")) {
  const databaseName = new URL(target.url).searchParams.get("db");
  await evaluate(`document.querySelector('[data-view="enrichment"]')?.click()`);
  await assignInput("#mainFileInput", "criticality-fixture.csv", "MAC;Device ID;Модель;IP адрес;NasIP\n00:11:22:33:44:D1;CRITICALITY-FIXTURE;Smoke Model;10.1.1.1;192.0.2.254");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2], ["ip", 3], ["switchIp", 4]]) {
    const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main ${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply in the criticality fixture`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton')?.click()`);
  let fixtureStatus = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    fixtureStatus = await evaluate(`document.querySelector('#databaseStatus')?.textContent||''`);
    if (fixtureStatus.includes("1 Final") && fixtureStatus.includes("1 устройств")) break;
  }
  if (!fixtureStatus.includes("1 Final") || !fixtureStatus.includes("1 устройств")) throw new Error(`Could not establish a real local Final for criticality UI checks: ${fixtureStatus}`);
  const seeded = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(databaseName)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('history','readwrite');const store=tx.objectStore('history');const base=Date.now();const events=[
    {id:'criticality-russian-ip',type:'Изменено',field:'IP-адрес',oldValue:'10.0.0.1',newValue:'10.0.0.2',mac:'00:11:22:33:44:C1'},
    {id:'criticality-technical-switch-ip',type:'modified',field:'switch_ip',oldValue:'10.0.0.254',newValue:'10.0.0.253',mac:'00:11:22:33:44:C2'},
    {id:'criticality-russian-model',type:'Изменено',field:'Модель',oldValue:'Model A',newValue:'Model B',mac:'00:11:22:33:44:C3'},
    {id:'criticality-empty-ip',type:'Изменено',field:'ip',oldValue:'',newValue:'10.0.0.4',mac:'00:11:22:33:44:C4'},
    {id:'criticality-removed-alias',type:'removed',field:'device',oldValue:'present',newValue:'',mac:'00:11:22:33:44:C5'}
  ];events.forEach((event,index)=>store.put({...event,timestamp:new Date(base+index).toISOString(),source:'Disposable browser smoke'}));tx.oncomplete=()=>{db.close();resolve({count:events.length,date:new Date(base).toISOString().slice(0,10)})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (seeded.count !== 5) throw new Error(`Could not seed exact disposable criticality events: ${JSON.stringify(seeded)}`);
  await evaluate(`document.querySelector('[data-view="analytics"]')?.click()`);
  await evaluate(`(()=>{const mode=document.querySelector('#changeReportModeSelect');mode.value='period';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#changeReportFrom').value=${JSON.stringify(seeded.date)};document.querySelector('#changeReportTo').value=${JSON.stringify(seeded.date)};document.querySelector('#applyChangeReportButton').click();return true})()`);
  let periodState = null;
  let modified = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    periodState = await evaluate(`(()=>({view:document.querySelector('.view.active')?.id||'',mode:document.querySelector('#changeReportModeSelect')?.value||'',from:document.querySelector('#changeReportFrom')?.value||'',to:document.querySelector('#changeReportTo')?.value||'',table:document.querySelector('#changeTable')?.innerText.slice(0,500)||'',error:!document.querySelector('#errorBanner')?.hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (periodState.error) throw new Error(`Change history period report failed: ${JSON.stringify(periodState)}`);
    const ready = await evaluate(`Boolean(document.querySelector('[data-change-category="modified"]'))`);
    if (!ready) continue;
    await evaluate(`document.querySelector('[data-change-category="modified"]').click()`);
    await wait(100);
    modified = await evaluate(`(()=>{const tab=document.querySelector('[data-change-category="modified"]');const panel=document.querySelector('#analyticsChangeEventsPanel');return{count:Number(tab?.querySelector('strong')?.textContent?.replace(/[^0-9]/g,'')),selected:tab?.getAttribute('aria-selected')||'',label:panel?.getAttribute('aria-label')||'',rows:[...(panel?.querySelectorAll('tbody tr')||[])].map(row=>({type:row.cells[1]?.textContent.trim()||'',critical:Boolean(row.querySelector('.severity-critical')),other:Boolean(row.querySelector('.severity-other')),text:row.textContent.trim()}))}})()`);
    if (modified?.label === "Изменены" && modified.rows.length === 4) break;
  }
  const criticalModified = modified?.rows.filter((row) => row.critical).length || 0;
  const otherModified = modified?.rows.filter((row) => row.other).length || 0;
  if (modified?.count !== 4 || modified.label !== "Изменены" || modified.rows.length !== 4 || criticalModified !== 2 || otherModified !== 2
    || modified.rows.filter((row) => row.critical).some((row) => !row.text.includes("Изменено"))
    || !modified.rows.some((row) => row.other && row.text.includes("Модель"))
    || !modified.rows.some((row) => row.other && row.text.includes("— → 10.0.0.4"))) {
    throw new Error(`Russian/technical change aliases or empty-to-known criticality were misclassified: ${JSON.stringify({modified,periodState})}`);
  }
  const periodCategories = await evaluate(`(()=>Object.fromEntries([...document.querySelectorAll('[data-change-category]')].map(tab=>[tab.dataset.changeCategory,Number(tab.querySelector('strong')?.textContent?.replace(/[^0-9]/g,''))])))()`);
  if (periodCategories.all !== 6 || periodCategories.critical !== 3 || periodCategories.added !== 1 || periodCategories.absent !== 1 || periodCategories.modified !== 4) {
    throw new Error(`Period category counts did not match all six History events: ${JSON.stringify(periodCategories)}`);
  }
  await evaluate(`document.querySelector('[data-change-category="critical"]').click()`);
  let critical = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    critical = await evaluate(`(()=>{const tab=document.querySelector('[data-change-category="critical"]');const panel=document.querySelector('#analyticsChangeEventsPanel');return{count:Number(tab?.querySelector('strong')?.textContent?.replace(/[^0-9]/g,'')),label:panel?.getAttribute('aria-label')||'',rows:[...(panel?.querySelectorAll('tbody tr')||[])].map(row=>({type:row.cells[1]?.textContent.trim()||'',critical:Boolean(row.querySelector('.severity-critical')),text:row.textContent.trim()}))}})()`);
    if (critical?.label === "Критические" && critical.rows.length === 3) break;
  }
  const absent = critical?.rows.filter((row) => row.type === "Отсутствует");
  if (critical?.count !== 3 || critical.label !== "Критические" || critical.rows.length !== 3 || critical.rows.some((row) => !row.critical)
    || critical.rows.filter((row) => row.type === "Изменено").length !== 2 || absent?.length !== 1) {
    throw new Error(`Critical change category did not normalize aliases or retain removal events: ${JSON.stringify({modified,critical})}`);
  }
  const reportClip = await evaluate(`(()=>{const rect=document.querySelector('#analyticsChangeEventsPanel').getBoundingClientRect();return{x:0,y:rect.top+scrollY,width:document.documentElement.clientWidth,height:Math.min(rect.height,900)}})()`);
  const screenshot = await command("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true, clip: { ...reportClip, scale: 1 } });
  const screenshotPath = resolve("dist/.change-criticality-browser-smoke.png");
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ seeded, periodCategories, modified, critical, screenshotPath, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--reference-dashboard-146-only")) {
  await evaluate(`(()=>{const issues=[];Object.defineProperty(window,'__smokeConsoleIssues',{value:issues,configurable:true});for(const level of ['warn','error']){const original=console[level].bind(console);console[level]=(...args)=>{issues.push({level,message:args.map((value)=>String(value)).join(' ')});original(...args)}}window.addEventListener('error',(event)=>issues.push({level:'exception',message:event.message||event.type}));window.addEventListener('unhandledrejection',(event)=>issues.push({level:'rejection',message:String(event.reason?.stack||event.reason||'unhandled rejection')}));return true})()`);
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await wait(300);
  const mainFields = [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3], ["address", 4], ["room", 5], ["ip", 6], ["switchIp", 7], ["switchPort", 8], ["businessUnit", 9], ["city", 10], ["site", 11], ["floor", 12]];
  const chooseMapping = async (field, index) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  const runFinal = async (date, rows, expectedCount, expectedFinals) => {
    await assignInput("#mainFileInput", `main_${date}.csv`, rows);
    let mappingReady = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(100);
      mappingReady = await evaluate(`Boolean(document.querySelector('[data-mapping-role="main"][data-mapping-field="mac"]'))`);
      if (mappingReady) break;
    }
    if (!mappingReady) throw new Error(`Main mapping dialog did not load for ${date}: ${await evaluate(`document.querySelector('#mainMapping')?.textContent||document.querySelector('#enrichmentView')?.textContent.slice(0,500)||''`)}`);
    for (const [field, index] of mainFields) await chooseMapping(field, index);
    await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
    let state = null;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await wait(100);
      state = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{const activeSnapshot=snapshots.result.find((snapshot)=>snapshot.id===active.result?.value);db.close();resolve({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner')?.hidden,message:document.querySelector('#errorBanner span')?.textContent||'',finalCount:snapshots.result.filter((snapshot)=>snapshot.kind!=='single').length,activeDeviceCount:activeSnapshot?.deviceCount||0})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
      if (state.error) throw new Error(`Dashboard parity Final ${date} failed: ${state.message}`);
      if (state.finalCount === expectedFinals && state.activeDeviceCount === expectedCount) return state.status;
    }
    throw new Error(`Dashboard parity Final ${date} did not finish: ${JSON.stringify(state)}`);
  };
  const header = "MAC;Device ID;Производитель;Модель;Адрес локации;Название комнаты;IP адрес;NasIP;NasPortID;ТБ;Город;Площадка;Этаж\n";
  const baseRows = [
    "00:11:22:33:44:51;DEV-51;Acme;Model A;Test Address;Test Room;192.168.1.51;10.0.0.1;1;Корпорация;Москва;Главный офис;3",
    "00:11:22:33:44:52;DEV-52;Acme;Model B;Test Address;Test Room;192.168.1.52;10.0.0.1;2;Корпорация;Москва;Главный офис;3",
    "00:11:22:33:44:53;DEV-53;Acme;Model C;Test Address;Test Room;192.168.1.53;10.0.0.1;3;Корпорация;Москва;Главный офис;3",
    "00:11:22:33:44:54;DEV-54;Acme;Model D;Test Address;Test Room;192.168.1.54;10.0.0.1;4;Корпорация;Москва;Главный офис;3",
  ];
  const currentRows = [
    "00:11:22:33:44:51;DEV-51;Acme;Model A2;Test Address;Test Room;192.168.1.51;10.0.0.1;1;Корпорация;Москва;Главный офис;3",
    "00:11:22:33:44:52;DEV-52;Acme;Model B2;Test Address;Test Room;192.168.1.52;10.0.0.1;2;Корпорация;Москва;Главный офис;3",
    "00:11:22:33:44:53;DEV-53;Acme;Model C;Test Address;Test Room;192.168.1.53;10.0.0.1;3;Корпорация;Москва;Главный офис;3",
    "00:11:22:33:44:55;DEV-55;Acme;Model E;Test Address;Test Room;192.168.1.55;10.0.0.1;5;Корпорация;Москва;Главный офис;3",
    "00:11:22:33:44:56;DEV-56;Acme;Model F;Test Address;Test Room;192.168.1.56;10.0.0.1;6;Корпорация;Москва;Главный офис;3",
    "00:11:22:33:44:57;DEV-57;Acme;Model G with extended chassis;Test Address;Test Room;192.168.1.57;10.0.0.1;7;Корпорация;Москва;Главный офис;3",
  ];
  await runFinal("2026-10-14", header + baseRows.join("\n"), 4, 1);
  await runFinal("2026-10-15", header + currentRows.join("\n"), 6, 2);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  const pair = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('snapshots','readonly');const request=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{const finals=request.result.filter((item)=>item.kind!=='single').sort((left,right)=>String(left.createdAt).localeCompare(String(right.createdAt)));db.close();resolve(finals.map(({id,name,deviceCount})=>({id,name,deviceCount}))) };tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (pair.length !== 2 || pair[0].deviceCount !== 4 || pair[1].deviceCount !== 6) throw new Error(`Dashboard source-parity fixture did not create the expected two Finals: ${JSON.stringify(pair)}`);
  const selectedPair = await evaluate(`(()=>{const base=document.querySelector('#baseSnapshotSelect');const current=document.querySelector('#currentSnapshotSelect');if(![...base.options].some((option)=>option.value===${JSON.stringify(pair[0].id)})||![...current.options].some((option)=>option.value===${JSON.stringify(pair[1].id)}))throw new Error('Expected Final pair is absent from Dashboard selectors');base.value=${JSON.stringify(pair[0].id)};current.value=${JSON.stringify(pair[1].id)};base.dispatchEvent(new Event('change',{bubbles:true}));current.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#applyComparisonButton').click();return{base:base.value,current:current.value}})()`);
  let dashboard = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    dashboard = await evaluate(`(()=>({devices:document.querySelector('#analyticsKpis [data-kpi="devices"] strong')?.textContent||'',modified:document.querySelector('#analyticsKpis [data-kpi="modified"] strong')?.textContent||'',absent:document.querySelector('#analyticsKpis [data-kpi="absent"] strong')?.textContent||'',chart:document.querySelector('#presenceChart')?.title||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (dashboard.error) throw new Error(`Dashboard parity report failed: ${dashboard.message}`);
    if (dashboard.devices.split("/").at(-1).trim() === "6" && dashboard.modified === "2" && dashboard.absent === "1" && dashboard.chart.includes("добавлено 3, отсутствовало 1")) break;
  }
  if (dashboard.devices.split("/").at(-1).trim() !== "6" || dashboard.modified !== "2" || dashboard.absent !== "1" || !dashboard.chart.includes("добавлено 3, отсутствовало 1")) throw new Error(`Dashboard cards/chart differ from the exact 6/3/1/2 source scenario: ${JSON.stringify({selectedPair,dashboard})}`);
  await evaluate(`(()=>{const mode=document.querySelector('#changeReportModeSelect');mode.value='period';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#changeReportFrom').value='2026-10-14';document.querySelector('#changeReportTo').value='2026-10-15';document.querySelector('#applyChangeReportButton').click();return true})()`);
  const changeCategories = [];
  for (const [key, label, expectedCount] of [["all", "Все", 10], ["critical", "Критические", 1], ["added", "Добавлены", 7], ["absent", "Отсутствуют", 1], ["modified", "Изменены", 2]]) {
    let tabReady = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      tabReady = await evaluate(`Boolean(document.querySelector('[data-change-category="${key}"]'))`);
      if (tabReady) break;
      await wait(100);
    }
    if (!tabReady) throw new Error(`Dashboard change category tab ${key} is missing: ${await evaluate(`document.querySelector('#changeTable')?.textContent||''`)}`);
    await evaluate(`document.querySelector('[data-change-category="${key}"]').click()`);
    let category = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      category = await evaluate(`(()=>{const tab=document.querySelector('[data-change-category="${key}"]');const panel=document.querySelector('#analyticsChangeEventsPanel');if(!tab||panel?.getAttribute('aria-label')!==${JSON.stringify(label)}||tab.getAttribute('aria-selected')!=='true')return null;const rows=[...panel.querySelectorAll('tbody tr')].map((row)=>{const cells=[...row.querySelectorAll('td')];const badge=cells[0]?.querySelector('.severity-badge');return{type:cells[1]?.textContent.trim()||'',critical:Boolean(badge?.classList.contains('severity-critical')),low:Boolean(badge?.classList.contains('severity-low')),other:Boolean(badge?.classList.contains('severity-other')),text:row.textContent.trim()}});return{label:panel.getAttribute('aria-label'),count:Number(tab.querySelector('strong')?.textContent?.replace(/[^0-9]/g,'')),rows}})()`);
      if (category) break;
      await wait(100);
    }
    const expectedType = key === "added" ? "Добавлено" : key === "absent" ? "Отсутствует" : key === "modified" ? "Изменено" : "";
    if (!category || category.count !== expectedCount || category.rows.length !== expectedCount
      || (expectedType && category.rows.some((row) => row.type !== expectedType))
      || (key === "critical" && category.rows.some((row) => !row.critical))
      || (key === "added" && category.rows.some((row) => !row.low))
      || (key === "modified" && category.rows.some((row) => !row.other))) {
      const currentPanel = await evaluate(`(()=>{const tab=document.querySelector('[data-change-category="${key}"]');const panel=document.querySelector('#analyticsChangeEventsPanel');return{tabLabel:tab?.textContent||'',selected:tab?.getAttribute('aria-selected')||'',panelLabel:panel?.getAttribute('aria-label')||'',panelText:panel?.textContent.slice(0,600)||'',otherTabs:[...document.querySelectorAll('[data-change-category]')].map((item)=>({key:item.dataset.changeCategory,selected:item.getAttribute('aria-selected'),label:item.textContent.trim()}))}})()`);
      throw new Error(`Dashboard change category ${key} mixed event types/severity or lost exact counts: ${JSON.stringify({ expectedCount, category, currentPanel })}`);
    }
    changeCategories.push({ key, ...category });
  }
  let totalChartTitle = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    totalChartTitle = await evaluate(`window.Chart?.getChart?.(document.querySelector('#totalChart'))?.options?.plugins?.title?.text||''`);
    if (totalChartTitle.includes("Было 4, стало 6 (+50.0%)")) break;
    await wait(100);
  }
  if (!totalChartTitle.includes("Было 4, стало 6 (+50.0%)")) throw new Error(`Total-device trend must display Final device counts 4→6 rather than modified/absent totals: ${JSON.stringify({ totalChartTitle, dashboard })}`);
  const weeklyTrend = await evaluate(`(()=>{const chart=window.Chart?.getChart?.(document.querySelector('#weeklyChart'));const callback=chart?.options?.plugins?.tooltip?.callbacks?.afterLabel;const labels=chart?.data?.labels||[];return{labels,texts:typeof callback==='function'?labels.map((_,dataIndex)=>callback({dataIndex})):[]}})()`);
  if (!weeklyTrend.labels.length || weeklyTrend.texts.length !== weeklyTrend.labels.length
    || weeklyTrend.texts.some((text) => !/Переговорн/i.test(text) || !/MAC-адресов/i.test(text))) {
    throw new Error(`Weekly trend points must expose exact changes, unique rooms and MAC counts in their real Chart.js tooltip: ${JSON.stringify(weeklyTrend)}`);
  }
  const clusteringReady = await evaluate(`(()=>({disabled:document.querySelector('#runPyqtClusteringButton')?.disabled??true,deviceCount:document.querySelector('#currentSnapshotSelect')?.selectedOptions?.[0]?.textContent||''}))()`);
  if (clusteringReady.disabled) throw new Error(`PyQt-style clustering should be available for the six-device current Final: ${JSON.stringify(clusteringReady)}`);
  await evaluate(`document.querySelector('#runPyqtClusteringButton').click()`);
  let clusteringSummary = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    clusteringSummary = await evaluate(`(()=>({hidden:document.querySelector('#pyqtClusteringSummary')?.hidden??true,text:document.querySelector('#pyqtClusteringSummary')?.textContent||''}))()`);
    if (clusteringSummary.text.includes('K-means по 8 признакам')) break;
  }
  const clusterCounts = [...(clusteringSummary?.text||'').matchAll(/Кластер \d+:\s*(\d+) устройств/g)].map((match) => Number(match[1]));
  if (clusteringSummary?.hidden || !clusteringSummary.text.includes('10 запусков · seed 42') || clusterCounts.length !== 3
    || clusterCounts.some((count) => !Number.isSafeInteger(count) || count < 0) || clusterCounts.reduce((sum, count) => sum + count, 0) !== 6) {
    throw new Error(`PyQt-style K-means UI must return three clusters covering all six current devices: ${JSON.stringify({ clusteringReady, clusteringSummary, clusterCounts })}`);
  }
  await evaluate(`document.querySelector('[data-view="rooms"]').click()`);
  await wait(300);
  const roomCascade = await evaluate(`(()=>{const choices={businessUnit:'Корпорация',city:'Москва',site:'Главный офис',floor:'3',room:'Test Room'};const ids={businessUnit:'businessUnitFilter',city:'cityFilter',site:'siteFilter',floor:'floorFilter',room:'roomFilter'};const evidence=[];for(const field of ['businessUnit','city','site','floor','room']){const select=document.querySelector('#'+ids[field]);const candidates=[...select.options].filter((option)=>option.value);const selected=candidates.find((option)=>option.textContent.includes(choices[field]));if(candidates.length!==1||!selected)return{ok:false,evidence,field,options:candidates.map((option)=>option.textContent)};select.value=selected.value;select.dispatchEvent(new Event('change',{bubbles:true}));evidence.push({field,value:selected.textContent,options:candidates.length})}const search=document.querySelector('#roomSearch');search.value='Test Address';search.dispatchEvent(new Event('input',{bubbles:true}));return{ok:true,evidence,search:search.value}})()`);
  if (!roomCascade.ok || roomCascade.evidence.length !== 5 || roomCascade.search !== "Test Address") throw new Error(`Room hierarchy cascade/search did not select the exact source path: ${JSON.stringify(roomCascade)}`);
  const roomSearchGuard = await evaluate(`(()=>{const search=document.querySelector('#roomSearch');search.value='No matching location';search.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#showRoomButton').click();return true})()`);
  let roomSearchError = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    roomSearchError = await evaluate(`document.querySelector('#errorBanner span')?.textContent||''`);
    if (roomSearchError.includes('Выберите помещение')) break;
    await wait(50);
  }
  if (!roomSearchGuard || !roomSearchError.includes("Выберите помещение")) throw new Error(`Room search must reject an unmatched location instead of opening an arbitrary room: ${JSON.stringify({ roomCascade, roomSearchError })}`);
  await evaluate(`(()=>{const issues=window.__smokeConsoleIssues||[];const index=issues.findIndex((entry)=>entry.level==='error'&&entry.message==='[MAC Analyzer] Error');if(index>=0)issues.splice(index,1)})()`);
  const expectedErrorIndex = runtimeDiagnostics.findIndex((entry) => entry.level === "error" && entry.text === "[MAC Analyzer] Error");
  if (expectedErrorIndex >= 0) runtimeDiagnostics.splice(expectedErrorIndex, 1);
  await evaluate(`document.querySelector('[data-error-dismiss]').click();const search=document.querySelector('#roomSearch');search.value='Test Address';search.dispatchEvent(new Event('input',{bubbles:true}))`);
  await evaluate(`document.querySelector('#showRoomButton').click()`);
  let timelineCount = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(100);
    timelineCount = await evaluate(`document.querySelectorAll('#roomTimeline [data-room-timeline-id]').length`);
    if (timelineCount === 2) break;
  }
  if (timelineCount !== 2) throw new Error(`Dashboard parity room timeline should show both Finals for the full hierarchy/search filter, got ${timelineCount}`);
  await evaluate(`document.querySelector('#compareRoomFinalsButton').click()`);
  let roomComparison = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    roomComparison = await evaluate(`({statuses:[...document.querySelectorAll('#roomFinalComparison tbody tr td:first-child')].map((cell)=>cell.textContent.trim()),text:document.querySelector('#roomFinalComparison')?.textContent||''})`);
    if (["Добавлено", "Отсутствует", "Изменено"].every((status)=>roomComparison.statuses.includes(status))) break;
  }
  if (!["Добавлено", "Отсутствует", "Изменено"].every((status)=>roomComparison.statuses.includes(status))) throw new Error(`Room Final comparison omitted an expected change category: ${JSON.stringify(roomComparison)}`);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let periodControlsMounted = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    periodControlsMounted = await evaluate(`Boolean(document.querySelector('#dashboardComparisonMode')&&document.querySelector('#dashboardComparisonDateFrom')&&document.querySelector('#dashboardComparisonDateTo'))`);
    if (periodControlsMounted) break;
    await wait(100);
  }
  if (!periodControlsMounted) throw new Error('Dashboard period controls did not remount after returning from the room view');
  const periodPersistence = await evaluate(`(()=>{const mode=document.querySelector('#dashboardComparisonMode');const from=document.querySelector('#dashboardComparisonDateFrom');const to=document.querySelector('#dashboardComparisonDateTo');if(!mode||!from||!to)throw new Error('Dashboard period controls are not mounted');mode.value='period';mode.dispatchEvent(new Event('change',{bubbles:true}));from.value='2026-10-14';to.value='2026-10-15';document.querySelector('#applyDashboardPeriodButton').click();return{mode:mode.value,from:from.value,to:to.value}})()`);
  if (periodPersistence.mode !== 'period') throw new Error(`Could not select the Dashboard date-range mode: ${JSON.stringify(periodPersistence)}`);
  let savedPeriod = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(100);
    savedPeriod = await evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('settings','readonly');const request=tx.objectStore('settings').get('analyticsDashboardSettings');tx.oncomplete=()=>{db.close();resolve(request.result?.value||null)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (savedPeriod?.comparisonMode === 'period' && savedPeriod.comparisonDateFrom === periodPersistence.from && savedPeriod.comparisonDateTo === periodPersistence.to) break;
  }
  if (savedPeriod?.comparisonMode !== 'period' || savedPeriod.comparisonDateFrom !== periodPersistence.from || savedPeriod.comparisonDateTo !== periodPersistence.to || pair.length !== 2) {
    throw new Error(`Dashboard date-range mode was not persisted with two current Finals: ${JSON.stringify({periodPersistence,savedPeriod,finalCount:pair.length})}`);
  }
  const databaseName = new URL(target.url).searchParams.get('db');
  const reloadedPeriodState = await reloadDatabaseAndWait(databaseName);
  const periodReloadDiagnostic = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('settings','readonly');const request=tx.objectStore('settings').get('analyticsDashboardSettings');tx.oncomplete=()=>{db.close();resolve({control:document.querySelector('#dashboardComparisonMode')?.value||'',setting:request.result?.value||null})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  await evaluate(`document.querySelector('[data-view="analytics"]')?.click()`);
  let restoredPeriod = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    restoredPeriod = await evaluate(`(()=>({mode:document.querySelector('#dashboardComparisonMode')?.value||'',from:document.querySelector('#dashboardComparisonDateFrom')?.value||'',to:document.querySelector('#dashboardComparisonDateTo')?.value||'',current:document.querySelector('#currentSnapshotSelect')?.value||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (restoredPeriod.error) throw new Error(`Reloading the saved period mode raised a browser error: ${restoredPeriod.message}`);
    if (restoredPeriod.mode === 'period' && restoredPeriod.from === periodPersistence.from && restoredPeriod.to === periodPersistence.to && restoredPeriod.current) break;
  }
  if (!restoredPeriod || restoredPeriod.mode !== 'period' || restoredPeriod.from !== periodPersistence.from || restoredPeriod.to !== periodPersistence.to || restoredPeriod.current !== selectedPair.current || reloadedPeriodState.db !== databaseName) {
    throw new Error(`Dashboard did not restore the selected period and range while Final data existed: ${JSON.stringify({reloadedPeriodState,periodPersistence,periodReloadDiagnostic,restoredPeriod})}`);
  }
  const consoleIssues = await evaluate(`window.__smokeConsoleIssues||[]`);
  if (consoleIssues.length || runtimeDiagnostics.length) throw new Error(`Browser console errors/warnings were observed: ${JSON.stringify({consoleIssues,runtimeDiagnostics})}`);
  console.log(JSON.stringify({ expectedKpis: { devices: 6, added: 3, absent: 1, modified: 2 }, actualKpis: { devices: dashboard.devices, modified: dashboard.modified, absent: dashboard.absent }, macChangeChart: dashboard.chart, changeCategories, totalChartTitle, weeklyTrend, clusteringSummary, clusterCounts, roomCascade, selectedPair, roomTimelineCount: timelineCount, roomComparisonStatuses: roomComparison.statuses, periodPersistence, savedPeriod, reloadedPeriodState, restoredPeriod, consoleIssues, runtimeDiagnostics, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--comparison-history-backfill-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  const chooseMapping = async (field, index) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  const runFinal = async (filename, model, expectedCount) => {
    await assignInput("#mainFileInput", filename, `MAC;Device ID;Производитель;Модель\n00:11:22:33:44:71;BACKFILL-71;Acme;${model}`);
    for (const [field, index] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3]]) await chooseMapping(field, index);
    await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
    let state = null;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await wait(100);
      state = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('snapshots','readonly');const request=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{db.close();resolve({count:request.result.filter(item=>item.kind!=='single').length,status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
      if (state.error) throw new Error(`Comparison backfill Final import failed: ${state.message}`);
      if (state.count === expectedCount) return state;
    }
    throw new Error(`Comparison backfill Final ${expectedCount} did not finish: ${JSON.stringify(state)}`);
  };
  await runFinal("backfill_2026-10-14.csv", "Historical Model", 1);
  await runFinal("backfill_2026-10-15.csv", "", 2);
  const finals = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['snapshots','snapshotChunks'],'readwrite');let rows=[];const request=tx.objectStore('snapshots').getAll();request.onsuccess=()=>{rows=request.result.filter(item=>item.kind!=='single').sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));const baseline=rows[1];if(rows.length!==2||!baseline){tx.abort();return}const chunks=tx.objectStore('snapshotChunks');const get=chunks.getAll();get.onsuccess=()=>{const matching=get.result.filter(chunk=>chunk.snapshotId===baseline.id);if(!matching.length){tx.abort();return}for(const chunk of matching){for(const device of chunk.devices||[]){device.model='';if(device.fieldSources)delete device.fieldSources.model}chunks.put(chunk)}}};tx.oncomplete=()=>{db.close();resolve(rows.map(({id,name,createdAt})=>({id,name,createdAt})))};tx.onerror=()=>{db.close();reject(tx.error)};tx.onabort=()=>{db.close();reject(tx.error||new Error('Baseline Final preparation was aborted'))}}}))()`);
  if (finals.length !== 2) throw new Error(`Could not prepare the historical comparison baseline: ${JSON.stringify(finals)}`);
  await runFinal("backfill_2026-10-16.csv", "Current Model", 3);
  const orderedFinals = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('snapshots','readonly');const request=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{db.close();resolve(request.result.filter(item=>item.kind!=='single').sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).map(({id,name,createdAt})=>({id,name,createdAt}))) };tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (orderedFinals.length !== 3) throw new Error(`Expected three Finals for comparison backfill: ${JSON.stringify(orderedFinals)}`);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let selected = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    selected = await evaluate(`(()=>{const base=document.querySelector('#baseSnapshotSelect');const current=document.querySelector('#currentSnapshotSelect');const baseId=${JSON.stringify(orderedFinals[1].id)};const currentId=${JSON.stringify(orderedFinals[2].id)};if(![...base.options].some(option=>option.value===baseId)||![...current.options].some(option=>option.value===currentId))return{ready:false};base.value=baseId;current.value=currentId;base.dispatchEvent(new Event('change',{bubbles:true}));current.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#applyComparisonButton').click();return{ready:true,base:base.value,current:current.value}})()`);
    if (selected.ready) break;
  }
  if (!selected?.ready) throw new Error(`Dashboard did not expose the two backfill Finals: ${JSON.stringify(selected)}`);
  let comparison = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(100);
    comparison = await evaluate(`(()=>({modified:document.querySelector('#analyticsKpis [data-kpi="modified"] strong')?.textContent.trim()||'',table:document.querySelector('#changeTable')?.textContent.replace(/\\s+/g,' ').trim()||'',loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (comparison.error || (!comparison.loading && comparison.modified === "1")) break;
  }
  if (comparison.error || comparison.loading || comparison.modified !== "1") {
    throw new Error(`Dashboard comparison did not restore the historical baseline field: ${JSON.stringify({finals:orderedFinals,selected,comparison})}`);
  }
  const persisted = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['snapshotChunks','finalAnalyticsMetadata','finalAnalytics'],'readonly');const chunks=tx.objectStore('snapshotChunks').getAll();const metadata=tx.objectStore('finalAnalyticsMetadata').get(${JSON.stringify(`__mac_analyzer_comparison_backfill__:${orderedFinals[1].id}`)});const indexes=tx.objectStore('finalAnalytics').getAll();tx.oncomplete=()=>{const row=chunks.result.find(chunk=>chunk.snapshotId===${JSON.stringify(orderedFinals[1].id)})?.devices?.[0];const derived=indexes.result.find(chunk=>chunk.snapshotId===${JSON.stringify(`__mac_analyzer_comparison_backfill__:${orderedFinals[1].id}`)})?.devices?.[0];db.close();resolve({baselineModel:row?.model||'',restoredFieldCount:metadata.result?.restoredFieldCount??0,derivedModel:derived?.model||''})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (persisted.baselineModel !== "" || persisted.restoredFieldCount < 1 || persisted.derivedModel !== "Historical Model") throw new Error(`Comparison backfill did not preserve source and persist the restored derived baseline: ${JSON.stringify(persisted)}`);
  console.log(JSON.stringify({comparisonHistoryBackfillOnly:true,selected,comparison:{modified:comparison.modified,showsHistoricalAndCurrentValues:true},persisted,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--no-new-final-rows-only")) {
  const chooseMapping = async (role, field, index) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="${role}"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing ${role}.${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  const mainFields = [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3], ["address", 4], ["room", 5], ["ip", 6], ["switchIp", 7], ["switchPort", 8]];
  const runFinal = async (date, main, expectedFinals, withDdio = false) => {
    await assignInput("#mainFileInput", `main_${date}.csv`, main);
    for (const [field, index] of mainFields) await chooseMapping("main", field, index);
    if (withDdio) {
      await assignInput("#smartroomFileInput", "smartroom_stale.csv", "MAC;Device ID;Производитель;Модель;Адрес локации;Название комнаты;IP адрес;NasIP;NasPortID\n00:11:22:33:44:61;DEV-61;Stale Smart Vendor;Stale Smart Model;Stale Smart Address;Stale Smart Room;192.168.9.61;10.0.0.99;99");
      for (const [field, index] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3], ["address", 4], ["room", 5], ["ip", 6], ["switchIp", 7], ["switchPort", 8]]) await chooseMapping("smartroom", field, index);
      await assignInput("#ddioFileInput", "ddio_unmatched.csv", "Reservation IP;Reservation MAC;Lease IP;Lease MAC\n;;192.168.9.99;AA:BB:CC:DD:EE:99");
      for (const [field, index] of [["reservationIp", 0], ["reservationMac", 1], ["leaseIp", 2], ["leaseMac", 3]]) await chooseMapping("ddio", field, index);
    }
    await evaluate(`document.querySelector('input[name="strategy"][value="NO_EXPANSION"]').click()`);
    await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
    let state = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await wait(100);
      state = await evaluate(`(()=>({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
      if (state.error) throw new Error(`No-new-Final-row smoke failed: ${state.message}`);
      if (state.status.includes(`${expectedFinals} Final`)) return state.status;
    }
    throw new Error(`No-new-Final-row run ${expectedFinals} did not finish: ${JSON.stringify(state)}`);
  };
  await runFinal("2026-10-14", "MAC;Device ID;Производитель;Модель;Адрес локации;Название комнаты;IP адрес;NasIP;NasPortID\n00:11:22:33:44:61;DEV-61;Previous Vendor;Previous Model;Previous Address;Previous Room;192.168.1.10;10.0.0.1;1\n00:11:22:33:44:62;DEV-62;Previous Vendor 2;Previous Model 2;Previous Address 2;Previous Room 2;192.168.1.62;10.0.0.1;2", 1);
  await runFinal("2026-10-15", "MAC;Device ID;Производитель;Модель;Адрес локации;Название комнаты;IP адрес;NasIP;NasPortID\n00:11:22:33:44:61;DEV-61;Current Vendor;Current Model;Current Address;Current Room;192.168.1.61;10.0.0.2;2", 2, true);
  const state = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').getAll();tx.oncomplete=()=>{const activeId=active.result?.value;const finals=snapshots.result.filter((item)=>item.kind!=='single');const activeDevices=chunks.result.filter((chunk)=>chunk.snapshotId===activeId).flatMap((chunk)=>chunk.devices||[]);const device=activeDevices.find((item)=>item.deviceId==='DEV-61');const absenceEvents=history.result.filter((item)=>item.type==='absent'||item.eventType==='absent');db.close();resolve({activeId,finalCount:finals.length,deviceCount:activeDevices.length,deviceIds:activeDevices.map((item)=>item.deviceId).sort(),inventoryCount:inventory.result,historyCount:history.result.length,absenceEvents:absenceEvents.length,currentValues:device&&{manufacturer:device.manufacturer,model:device.model,address:device.address,room:device.room,ip:device.ip,switchIp:device.switchIp,switchPort:device.switchPort},diagnostics:finals.find((item)=>item.id===activeId)?.diagnosticCounts||null})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const expectedCurrentValues = { manufacturer: "Current Vendor", model: "Current Model", address: "Current Address", room: "Current Room", ip: "192.168.1.61", switchIp: "10.0.0.2", switchPort: "2" };
  if (state.finalCount !== 2 || state.deviceCount !== 1 || state.deviceIds.join(",") !== "DEV-61" || state.inventoryCount !== 2 || state.absenceEvents < 1 || JSON.stringify(state.currentValues) !== JSON.stringify(expectedCurrentValues)) throw new Error(`Previous Final/SmartRoom stale values or unmatched DDIO altered the current Main Final: ${JSON.stringify({state,expectedCurrentValues})}`);
  const readSourceFiles = async () => evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('originalFiles','readonly');const store=tx.objectStore('originalFiles');const roles=['main','smartroom','ddio'];const requests=Object.fromEntries(roles.map(role=>[role,store.get([${JSON.stringify(state.activeId)},role])]));tx.oncomplete=async()=>{try{const files={};for(const role of roles){const item=requests[role].result;if(!item?.blob)throw new Error('Missing original '+role);files[role]={name:item.name,content:await item.blob.text()}}db.close();resolve(files)}catch(error){db.close();reject(error)}};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const sourceFiles = await readSourceFiles();
  const expectedSources = {
    main: { name: "main_2026-10-15.csv", content: "MAC;Device ID;Производитель;Модель;Адрес локации;Название комнаты;IP адрес;NasIP;NasPortID\n00:11:22:33:44:61;DEV-61;Current Vendor;Current Model;Current Address;Current Room;192.168.1.61;10.0.0.2;2" },
    smartroom: { name: "smartroom_stale.csv", content: "MAC;Device ID;Производитель;Модель;Адрес локации;Название комнаты;IP адрес;NasIP;NasPortID\n00:11:22:33:44:61;DEV-61;Stale Smart Vendor;Stale Smart Model;Stale Smart Address;Stale Smart Room;192.168.9.61;10.0.0.99;99" },
    ddio: { name: "ddio_unmatched.csv", content: "Reservation IP;Reservation MAC;Lease IP;Lease MAC\n;;192.168.9.99;AA:BB:CC:DD:EE:99" },
  };
  if (JSON.stringify(sourceFiles) !== JSON.stringify(expectedSources)) throw new Error(`Final did not retain exact Main/SmartRoom/DDIO source bytes: ${JSON.stringify(sourceFiles)}`);
  await reloadDatabaseAndWait(new URL(target.url).searchParams.get("db"));
  const restoredSourceFiles = await readSourceFiles();
  if (JSON.stringify(restoredSourceFiles) !== JSON.stringify(expectedSources)) throw new Error(`Original source files changed or disappeared after application reload: ${JSON.stringify(restoredSourceFiles)}`);
  console.log(JSON.stringify({ previousFinalAbsentDeviceNotRestored: true, unmatchedDdioDidNotCreateDevice: true, currentMainFieldsPreserved: state.currentValues, activeFinalDeviceIds: state.deviceIds, inventoryCount: state.inventoryCount, absenceEventsStoredSeparately: state.absenceEvents, sourceFilesPersisted: Object.keys(sourceFiles), sourceBytesRestoredAfterReload: true, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--all-changed-room-only")) {
  const mainRows = "MAC;Device ID\n00:11:22:33:44:61;ROOM-61\n00:11:22:33:44:62;ROOM-62";
  const smartroomRows = "MAC;Device ID;Название комнаты;Адрес локации;Smartroom ID локации;Модель\n00:11:22:33:44:61;ROOM-61;Проверочная переговорная;Тестовый адрес;SR-ALL-CHANGED;Display A\n00:11:22:33:44:62;ROOM-62;Проверочная переговорная;Тестовый адрес;SR-ALL-CHANGED;Display B";
  const chooseMapping = async (role, field, index) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="${role}"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing ${role}.${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  const runFinal = async (date, models, expectedFinals) => {
    const smartroom = smartroomRows.replace("Display A", models[0]).replace("Display B", models[1]);
    await assignInput("#mainFileInput", `main_${date}.csv`, mainRows);
    await assignInput("#smartroomFileInput", `smartroom_${date}.csv`, smartroom);
    for (const [field, index] of [["mac", 0], ["deviceId", 1]]) await chooseMapping("main", field, index);
    for (const [field, index] of [["mac", 0], ["deviceId", 1], ["room", 2], ["address", 3], ["smartroomId", 4], ["model", 5]]) await chooseMapping("smartroom", field, index);
    await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
    let state = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await wait(100);
      state = await evaluate(`(()=>({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
      if (state.error) throw new Error(`All-changed room Final failed: ${state.message}`);
      if (state.status.includes(`${expectedFinals} Final`)) return state.status;
    }
    throw new Error(`All-changed room Final ${expectedFinals} did not finish: ${JSON.stringify(state)}`);
  };
  await runFinal("2026-10-14", ["Display A", "Display B"], 1);
  await runFinal("2026-10-15", ["Display A v2", "Display B v2"], 2);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  await wait(300);
  const selectedPair = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('snapshots','readonly');const request=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{const finals=request.result.filter((item)=>item.kind!=='single').sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));const base=document.querySelector('#baseSnapshotSelect');const current=document.querySelector('#currentSnapshotSelect');if(finals.length!==2||![...base.options].some((option)=>option.value===finals[0].id)||![...current.options].some((option)=>option.value===finals[1].id)){db.close();resolve({error:'snapshot selectors do not contain the two expected Finals',finals:finals.map(({id,name,kind,createdAt})=>({id,name,kind,createdAt})),base:[...base.options].map(({value,text})=>({value,text})),current:[...current.options].map(({value,text})=>({value,text}))});return}base.value=finals[0].id;current.value=finals[1].id;base.dispatchEvent(new Event('change',{bubbles:true}));current.dispatchEvent(new Event('change',{bubbles:true}));db.close();resolve({base:base.value,current:current.value})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (selectedPair.error) throw new Error(`Could not select both all-changed room Finals: ${JSON.stringify(selectedPair)}`);
  await evaluate(`document.querySelector('#applyComparisonButton').click()`);
  let kpi = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    kpi = await evaluate(`(()=>({value:document.querySelector('#analyticsKpis [data-kpi="allChangedRooms"] strong')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (kpi.error) throw new Error(`All-changed room analytics failed: ${kpi.message}`);
    if (kpi.value === "1") break;
  }
  if (kpi.value !== "1") {
    const detail = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const activeId=active.result?.value;const baseId=document.querySelector('#baseSnapshotSelect').value;const snapshot=snapshots.result.find((item)=>item.id===activeId);const devices=chunks.result.filter((chunk)=>chunk.snapshotId===activeId).flatMap((chunk)=>chunk.devices||[]);const previousDevices=chunks.result.filter((chunk)=>chunk.snapshotId===baseId).flatMap((chunk)=>chunk.devices||[]);db.close();resolve({status:document.querySelector('#databaseStatus').textContent,base:baseId,current:document.querySelector('#currentSnapshotSelect').value,activeId,deviceCount:devices.length,devices:devices.map(({mac,deviceId,room,smartroomId,model})=>({mac,deviceId,room,smartroomId,model})),previousDevices:previousDevices.map(({mac,deviceId,room,smartroomId,model})=>({mac,deviceId,room,smartroomId,model})),diagnostics:snapshot?.diagnosticCounts||null,modifiedKpi:document.querySelector('#analyticsKpis [data-kpi="modified"] strong')?.textContent||''})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    throw new Error(`Dashboard all-changed room KPI should be 1 for the two-of-two changed room: ${JSON.stringify({ kpi, detail })}`);
  }
  await evaluate(`document.querySelector('#analyticsKpis [data-kpi="allChangedRooms"]').click()`);
  const roomSummary = await evaluate(`document.querySelector('#detailsDialog [data-dialog-content] .room-card')?.textContent.replace(/\\s+/g,' ').trim()||''`);
  if (!roomSummary.includes("2/2 изменено") || !roomSummary.includes("Тестовый адрес")) throw new Error(`All-changed room dialog did not show the exact room/address and 2/2 summary: ${roomSummary}`);
  await evaluate(`document.querySelector('#detailsDialog [data-room-coverage-page]').click()`);
  let roster = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    roster = await evaluate(`document.querySelector('#detailsDialog [data-dialog-content]')?.textContent.replace(/\\s+/g,' ').trim()||''`);
    if (roster.includes("00:11:22:33:44:61") && roster.includes("00:11:22:33:44:62")) break;
  }
  if (!roster.includes("00:11:22:33:44:61") || !roster.includes("00:11:22:33:44:62")) throw new Error(`All-changed room roster did not load both current Final devices: ${roster}`);
  console.log(JSON.stringify({ allChangedRoomsKpi: kpi.value, roomSummary, rosterContainsBothDevices: true, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--expansion-no-only") || process.argv.includes("--expansion-allow-only")) {
  const strategy = process.argv.includes("--expansion-allow-only") ? "ALLOW_EXPANSION" : "NO_EXPANSION";
  const rows = {
    main: "MAC;Device ID;IP address\n00:11:22:33:44:51;DEV-51;192.168.1.51",
    smartroom: "MAC;Device ID;IP address;Room;Model;Hostname\n00:11:22:33:44:51;DEV-51;192.168.1.51;Room A;Model A;main-device\n00:11:22:33:44:55;DEV-55;192.168.1.55;Room B;Model B;strong-new-device\n;;192.168.1.56;Room C;Model C;weak-host-only",
  };
  const choose = async (role, field, index) => evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="${role}"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing ${role}.${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
  await assignInput("#mainFileInput", "expansion_main.csv", rows.main);
  await assignInput("#smartroomFileInput", "expansion_smartroom.csv", rows.smartroom);
  for (const [role, fields] of Object.entries({ main: { mac: 0, deviceId: 1, ip: 2 }, smartroom: { mac: 0, deviceId: 1, ip: 2, room: 3, model: 4, hostname: 5 } })) {
    for (const [field, index] of Object.entries(fields)) await choose(role, field, index);
  }
  await evaluate(`document.querySelector('input[name="strategy"][value="${strategy}"]').click()`);
  await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
  let state = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    state = await evaluate(`(()=>({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner')?.hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (state.error) throw new Error(`Expansion strategy ${strategy} failed: ${state.message}`);
    if (state.status.includes("Final") && !state.status.includes("0 устройств")) break;
  }
  const finalState = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const activeId=active.result?.value||'';const snapshot=snapshots.result.find(item=>item.id===activeId);const devices=chunks.result.filter(chunk=>chunk.snapshotId===activeId).sort((a,b)=>a.index-b.index).flatMap(chunk=>chunk.devices||[]);db.close();resolve({activeId,deviceCount:devices.length,deviceIds:devices.map(device=>device.deviceId).sort(),macs:devices.map(device=>device.mac).sort(),unmatchedTotal:snapshot?.diagnosticCounts?.unmatchedTotal??snapshot?.unmatchedCount??null,status:document.querySelector('#databaseStatus')?.textContent||''})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const expectedCount = strategy === "ALLOW_EXPANSION" ? 2 : 1;
  if (finalState.deviceCount !== expectedCount || !finalState.deviceIds.includes("DEV-51") || finalState.deviceIds.includes("DEV-55") !== (strategy === "ALLOW_EXPANSION") || finalState.macs.includes("")) {
    throw new Error(`Expansion strategy persisted an unexpected Final: ${JSON.stringify({ strategy, state, finalState })}`);
  }
  console.log(`browser smoke: ${strategy} persisted ${finalState.deviceCount} Main/SmartRoom device(s); the strong-ID row followed the strategy and the hostname-only row was not added`);
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (requestedSmokeUrl?.searchParams.get("smoke") === "hotkeys") {
  await evaluate(`(()=>{window.__smokeHotkeyClicks=[];const original=HTMLElement.prototype.click;HTMLElement.prototype.click=function(){const id=this.id||this.getAttribute('data-view')||this.tagName.toLowerCase();window.__smokeHotkeyClicks.push(id);if(['mainFileInput','exportDatabaseButton','runEnrichmentButton'].includes(this.id))return;return original.call(this)}})()`);
  const dispatchShortcut = async (key, modifiers = {}) => evaluate(`(()=>{const event=new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:${Boolean(modifiers.ctrlKey)},shiftKey:${Boolean(modifiers.shiftKey)},bubbles:true,cancelable:true});document.dispatchEvent(event);return event.defaultPrevented})()`);
  const assertView = async (view) => {
    const active = await evaluate(`document.querySelector('[data-view="${view}"]')?.classList.contains('active')`);
    if (!active) throw new Error(`Горячая клавиша не открыла вкладку ${view}`);
  };
  await dispatchShortcut("F1"); await assertView("guide");
  await dispatchShortcut("a", { ctrlKey: true }); await assertView("analytics");
  await dispatchShortcut("h", { ctrlKey: true }); await assertView("history");
  await evaluate(`(()=>{const input=document.querySelector('#globalSearch');input.value='replacement query';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await dispatchShortcut("f", { ctrlKey: true }); await assertView("search");
  const selectedSearch = await evaluate(`document.activeElement?.id==='globalSearch'&&document.activeElement.selectionStart===0&&document.activeElement.selectionEnd==='replacement query'.length`);
  if (!selectedSearch) throw new Error("Ctrl+F did not focus and select the current global search query");
  await dispatchShortcut("o", { ctrlKey: true }); await assertView("enrichment");
  await dispatchShortcut("s", { ctrlKey: true }); await assertView("data");
  await dispatchShortcut("e", { ctrlKey: true });
  const exportMenuOpen = await evaluate(`document.querySelector('details.export-menu')?.open===true`);
  if (!exportMenuOpen) throw new Error("Ctrl+E did not open the Final export menu");
  for (const [key, view] of [["F6", "filecompare"], ["F7", "analytics"], ["F8", "analytics"], ["F9", "multicompare"], ["F5", "enrichment"]]) {
    await dispatchShortcut(key); await assertView(view);
  }
  for (const [key, view] of [["a", "analytics"], ["h", "history"], ["f", "search"]]) {
    await dispatchShortcut(key, { ctrlKey: true }); await assertView(view);
  }
  await dispatchShortcut("f", { ctrlKey: true, shiftKey: true });
  let savedSearchStatus = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    savedSearchStatus = await evaluate(`document.querySelector('#savedFinalSearchStatus')?.textContent||''`);
    if (savedSearchStatus.includes("Найдено уникальных MAC:")) break;
  }
  if (!savedSearchStatus.includes("Найдено уникальных MAC:")) throw new Error(`Ctrl+Shift+F did not complete saved-Final search: ${savedSearchStatus}`);
  for (const [key, expected] of [["o", "Ширина рассчитана по всему Inventory"], ["r", "Настройки сброшены"], ["s", "Настройки ширины столбцов сохранены"], ["l", "Сохранённые настройки ширины столбцов загружены"]]) {
    await dispatchShortcut(key, { ctrlKey: true, shiftKey: true });
    let status = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(50);
      status = await evaluate(`document.querySelector('#inventoryColumnStatus')?.textContent||''`);
      if (status.includes(expected)) break;
    }
    if (!status.includes(expected)) throw new Error(`Ctrl+Shift+${key.toUpperCase()} did not complete its action: ${status}`);
  }
  await dispatchShortcut("c", { ctrlKey: true, shiftKey: true });
  const columnDialogOpened = await evaluate(`document.querySelector('#inventoryColumnManagerDialog')?.open===true`);
  if (!columnDialogOpened) throw new Error("Ctrl+Shift+C did not open the Inventory column manager");
  await evaluate(`document.querySelector('#inventoryColumnManagerDialog').close()`);
  const actions = await evaluate(`window.__smokeHotkeyClicks`);
  for (const id of ["mainFileInput", "exportDatabaseButton", "runEnrichmentButton"]) if (!actions.includes(id)) throw new Error(`Shortcut did not dispatch its expected action ${id}: ${JSON.stringify(actions)}`);
  await evaluate(`(()=>{const banner=document.querySelector('#errorBanner');banner.querySelector('span').textContent='Smoke hotkey error';banner.hidden=false;return true})()`);
  const escapePrevented = await dispatchShortcut("Escape");
  const dismissed = await evaluate(`document.querySelector('#errorBanner').hidden&&document.querySelector('#errorBanner span').textContent===''`);
  if (!escapePrevented || !dismissed) throw new Error("Escape did not dismiss and clear the active error banner");
  console.log("browser smoke: PyQt global shortcuts dispatched expected actions across all user/engineer views, saved-Final search, column manager/settings, and export; Escape dismissed the error banner");
  await command("Browser.close"); socket.close(); process.exit(0);
}

if (requestedSmokeUrl?.searchParams.get("smoke") === "escape-cancel") {
  const csvReady = await evaluate(`(()=>{const rows=['MAC;Производитель;Модель;IP адрес;Название комнаты'];for(let i=1;i<=160000;i++){const mac=i.toString(16).padStart(12,'0').match(/.{2}/g).join(':');rows.push(mac+';Smoke Vendor;Smoke Model;192.0.2.1;Smoke Room')}window.__smokeEscapeCsv=rows.join('\\n');return{rows:rows.length,bytes:new Blob([window.__smokeEscapeCsv]).size}})()`);
  if (csvReady.rows !== 160001 || csvReady.bytes < 4_000_000) throw new Error(`Synthetic cancellation CSV did not reach the expected size: ${JSON.stringify(csvReady)}`);
  const assignFile = async (selector, name) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});const transfer=new DataTransfer();transfer.items.add(new File([window.__smokeEscapeCsv],${JSON.stringify(name)},{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const waitForText = async (selector, phrase, { attempts = 500 } = {}) => {
    let lastValue = "";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await wait(20);
      lastValue = await evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent||''`);
      if (lastValue.includes(phrase)) return lastValue;
    }
    const debug = await evaluate(`(()=>({title:document.querySelector('#progressTitle')?.textContent,detail:document.querySelector('#progressDetail')?.textContent,error:document.querySelector('#errorBanner span')?.textContent,hidden:document.querySelector('#errorBanner')?.hidden,compare:document.querySelector('#fileCompareResult')?.textContent}))()`);
    throw new Error(`Timed out waiting for ${selector} to include ${phrase}; last=${lastValue}; state=${JSON.stringify(debug)}`);
  };
  const waitForActiveProgress = async (title, detail) => {
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const state = await evaluate(`(()=>({hidden:document.querySelector('#progressPanel').hidden,title:document.querySelector('#progressTitle').textContent,detail:document.querySelector('#progressDetail').textContent,percent:document.querySelector('#progressPercent').textContent}))()`);
      if (!state.hidden && state.title.includes(title) && state.detail.includes(detail) && state.percent !== "100%") return state;
      await wait(20);
    }
    throw new Error(`Operation never exposed active progress for ${title}/${detail}: ${JSON.stringify(await evaluate(`({title:document.querySelector('#progressTitle').textContent,detail:document.querySelector('#progressDetail').textContent,hidden:document.querySelector('#progressPanel').hidden})`))}`);
  };
  const pressEscape = () => evaluate(`(()=>{const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});document.dispatchEvent(event);return event.defaultPrevented})()`);

  await evaluate(`document.querySelector('[data-view="single"]').click()`);
  await assignFile("#singleFileInput", "escape_single.csv");
  let singleReady = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    singleReady = await evaluate(`!document.querySelector('#runSingleAnalysisButton').disabled`);
    if (singleReady) break;
    await wait(20);
  }
  if (!singleReady && await evaluate(`Boolean(document.querySelector('#singleMapping [data-open-single-mapping-review]') && document.querySelector('#singleMapping .mapping-review')?.textContent.includes('Перед анализом откройте'))`)) {
    await evaluate(`document.querySelector('#singleMapping [data-open-single-mapping-review]').click()`);
    await evaluate(`(()=>{const assignments={mac:'0',manufacturer:'1',model:'2',ip:'3',room:'4'};for(const select of document.querySelectorAll('#mappingReviewContent [data-review-field]')){select.value=assignments[select.dataset.reviewField]||'';select.dispatchEvent(new Event('change',{bubbles:true}))}document.querySelector('#mappingReviewForm').requestSubmit();return true})()`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      singleReady = await evaluate(`!document.querySelector('#mappingReviewDialog').open && !document.querySelector('#runSingleAnalysisButton').disabled`);
      if (singleReady) break;
      await wait(20);
    }
  }
  if (!singleReady) {
    const debug = await evaluate(`(()=>({status:document.querySelector('#singleFileStatus')?.textContent,warning:document.querySelector('#singleMapping .mapping-review')?.textContent,mapping:[...document.querySelectorAll('#singleMapping [data-single-mapping-field]')].map((item)=>[item.dataset.singleMappingField,item.value]),error:document.querySelector('#errorBanner span')?.textContent,bytes:document.querySelector('#singleFileInput')?.files?.[0]?.size}))()`);
    throw new Error(`Single-file synthetic CSV did not produce a runnable mapping: ${JSON.stringify(debug)}`);
  }
  await evaluate(`document.querySelector('#runSingleAnalysisButton').click()`);
  await waitForActiveProgress("Анализ одного файла", "Обработано");
  const singleEscapePrevented = await pressEscape();
  if (!singleEscapePrevented) throw new Error("Escape was not consumed while single-file analysis was active");
  await waitForText("#progressDetail", "Анализ отменён");
  const singleCancelled = await evaluate(`(()=>({error:!document.querySelector('#errorBanner').hidden,result:document.querySelector('#singleAnalysisResult').textContent}))()`);
  if (singleCancelled.error || singleCancelled.result.includes("Уникальных устройств160000")) throw new Error(`Single-file analysis was not cleanly cancelled: ${JSON.stringify(singleCancelled)}`);
  const savedSingleCount = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('singleAnalyses','readonly');const request=tx.objectStore('singleAnalyses').count();tx.oncomplete=()=>{db.close();resolve(request.result)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (savedSingleCount !== 0) throw new Error(`Cancelled single-file analysis unexpectedly persisted ${savedSingleCount} result(s)`);

  await evaluate(`document.querySelector('[data-view="filecompare"]').click()`);
  await assignFile("#compareFile0Input", "escape_compare_before.csv");
  let beforeCompareReady = false;
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    beforeCompareReady = await evaluate(`Boolean(document.querySelector('#compareFile0Mapping [data-compare-field]'))`);
    if (beforeCompareReady) break;
    await wait(20);
  }
  if (!beforeCompareReady) throw new Error(`First two-file comparison preview did not finish: ${JSON.stringify(await evaluate(`({status:document.querySelector('#compareFile0Status')?.textContent,error:document.querySelector('#errorBanner span')?.textContent})`))}`);
  await assignFile("#compareFile1Input", "escape_compare_after.csv");
  let compareReady = false;
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    compareReady = await evaluate(`!document.querySelector('#runFileCompareButton').disabled`);
    if (compareReady) break;
    await wait(20);
  }
  if (!compareReady) throw new Error(`Two-file synthetic CSVs did not produce runnable comparison mappings: ${JSON.stringify(await evaluate(`({first:document.querySelector('#compareFile0Status')?.textContent,second:document.querySelector('#compareFile1Status')?.textContent,error:document.querySelector('#errorBanner span')?.textContent})`))}`);
  await evaluate(`document.querySelector('#runFileCompareButton').click()`);
  await waitForActiveProgress("Сравнение двух файлов", "обработано");
  const compareEscapePrevented = await pressEscape();
  if (!compareEscapePrevented) throw new Error(`Escape was not consumed while comparison was active: ${JSON.stringify(await evaluate(`({detail:document.querySelector('#progressDetail').textContent,panel:!document.querySelector('#progressPanel').hidden,exportDisabled:document.querySelector('#exportFileCompareCsvButton').disabled})`))}`);
  await waitForText("#progressDetail", "Сравнение отменено", { attempts: 2_500 });
  const compareCancelled = await evaluate(`(()=>({error:!document.querySelector('#errorBanner').hidden,exports:['#exportFileCompareCsvButton','#exportFileCompareJsonButton'].some((selector)=>!document.querySelector(selector).disabled)}))()`);
  if (compareCancelled.error || compareCancelled.exports) throw new Error(`Two-file comparison was not cleanly cancelled or left exports enabled: ${JSON.stringify(compareCancelled)}`);

  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await assignFile("#mainFileInput", "escape_enrichment.csv");
  let mappingReady = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    mappingReady = await evaluate(`Boolean(document.querySelector('#mainMapping [data-mapping-field="mac"]'))`);
    if (mappingReady) break;
    await wait(20);
  }
  if (!mappingReady) throw new Error("Main synthetic CSV did not produce a MAC mapping control");
  const mainMapping = await evaluate(`(()=>{const choices={mac:0,manufacturer:1,model:2,ip:3,room:4};for(const [field,index] of Object.entries(choices)){const select=document.querySelector('#mainMapping [data-mapping-field="'+field+'"]');if(select&&select.value!==String(index)){select.value=String(index);select.dispatchEvent(new Event('change',{bubbles:true}))}}return [...document.querySelectorAll('#mainMapping [data-mapping-field]')].map((select)=>[select.dataset.mappingField,select.value])})()`);
  if (!mainMapping.some(([field, value]) => field === "mac" && value === "0")) throw new Error(`Main source did not retain a strong MAC identity mapping: ${JSON.stringify(mainMapping)}`);
  await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
  await waitForActiveProgress("Обогащение", "Чтение MAIN:");
  const enrichmentEscapePrevented = await pressEscape();
  if (!enrichmentEscapePrevented) throw new Error("Escape was not consumed while enrichment was active");
  let enrichmentState = null;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    await wait(20);
    enrichmentState = await evaluate(`(()=>({error:!document.querySelector('#errorBanner').hidden,errorText:document.querySelector('#errorBanner span').textContent}))()`);
    if (enrichmentState.error) break;
  }
  if (!enrichmentState?.error || !/abort|cancel|отмен/i.test(enrichmentState.errorText)) throw new Error(`Live enrichment did not report its abort after Escape: ${JSON.stringify(enrichmentState)}`);
  const persistedFinals = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['snapshots','inventory'],'readonly');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();tx.oncomplete=()=>{db.close();resolve({snapshots:snapshots.result,inventory:inventory.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (persistedFinals.snapshots || persistedFinals.inventory) throw new Error(`Cancelled enrichment wrote partial user data: ${JSON.stringify(persistedFinals)}`);
  const cancellationErrorDismissed = await pressEscape();
  if (!cancellationErrorDismissed || !(await evaluate(`document.querySelector('#errorBanner').hidden`))) throw new Error("Escape did not dismiss the cancellation error banner before the context-menu/dialog checks");

  const menuEscape = await evaluate(`(()=>{const menu=document.querySelector('#deviceContextMenu');menu.hidden=false;const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});document.dispatchEvent(event);return{hidden:menu.hidden,prevented:event.defaultPrevented}})()`);
  if (!menuEscape.hidden || !menuEscape.prevented) throw new Error(`Escape did not dismiss the context menu first: ${JSON.stringify(menuEscape)}`);
  await evaluate(`(()=>{window.__smokeNativeEscape=[];document.addEventListener('keydown',(event)=>{if(event.key==='Escape')window.__smokeNativeEscape.push({defaultPrevented:event.defaultPrevented,active:document.activeElement?.tagName})});const dialog=document.querySelector('#detailsDialog');dialog.showModal();dialog.focus()})()`);
  await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await wait(100);
  let nativeDialogState = await evaluate(`(()=>({open:document.querySelector('#detailsDialog').open,events:window.__smokeNativeEscape}))()`);
  if (nativeDialogState.open) {
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await wait(100);
    nativeDialogState = await evaluate(`(()=>({open:document.querySelector('#detailsDialog').open,events:window.__smokeNativeEscape}))()`);
  }
  const nativeEscapeWasNotIntercepted = nativeDialogState.events.length > 0 && nativeDialogState.events.every((event) => !event.defaultPrevented);
  if (!nativeEscapeWasNotIntercepted) throw new Error(`Application intercepted native-dialog Escape: ${JSON.stringify(nativeDialogState)}`);
  if (nativeDialogState.open) await evaluate(`document.querySelector('#detailsDialog').close()`);
  console.log(`browser smoke: Escape cancelled live single-file analysis, two-file comparison, and enrichment without partial writes; context menu closed; native-dialog Escape was not intercepted${nativeDialogState.open ? " (CDP did not invoke browser default close)" : " and closed the dialog"}`);
  await command("Browser.close"); socket.close(); process.exit(0);
}

if (requestedSmokeUrl?.searchParams.get("smoke") === "pyqt-settings") {
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  let importReady = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    importReady = await evaluate(`Boolean(document.querySelector('#importPyQtSettingsInput') && document.querySelector('#pyqtSettingsImportStatus'))`);
    if (importReady) break;
    await wait(50);
  }
  if (!importReady) throw new Error("Экран данных не смонтировал импорт настроек PyQt");
  await evaluate(`(()=>{const value={version:'9.5',theme:'dark',last_strategy:'keep_primary_only',enrich_fields:{model:false,address:true,ip:false,vendor:true,room:false,switch_ip:true,switch_port:false},oui_formats:{3:false,4:true,5:false,6:true},vendor_detector_settings:{enabled:false,use_oui_3byte:false,use_oui_5byte:true,use_text_analysis:false,use_inference:true,confidence_threshold:0.83},history_enricher_settings:{enabled:true,priority_history:false,use_oui_match:true,use_mac5_match:false},files:{Main:{path:'C:\\\\private\\\\main.xlsx',is_primary:true,mapping:{mac:0}}},api_settings:{api_key:'smoke-secret-token',service:'macvendors'},ip_address_mapping_file:'C:\\\\private\\\\mapping.xlsx',auto_detect_address_by_ip:false,ip_enrichment_settings:{overwrite:true,partial_match:true},comparison_fields:{mac:true},threshold:90,engineering_mode:false,window_geometry:'private-geometry',visible_columns:['MAC','Модель','IP-адрес','MAC (форматированный)'],custom_columns:['Customer field']};const input=document.querySelector('#importPyQtSettingsInput');const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(value)],'mac_analyzer_settings.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  let importStatus = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    importStatus = await evaluate(`document.querySelector('#pyqtSettingsImportStatus')?.textContent||''`);
    if (importStatus.includes('Перенесены совместимые локальные настройки')) break;
  }
  if (!importStatus.includes('Перенесены совместимые локальные настройки') || !importStatus.includes('engineering_mode') || !importStatus.includes('api_settings.api_key')) throw new Error(`PyQt settings UI did not report imported preferences and ignored unsafe fields: ${importStatus}`);
  const importedSettings = await evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const keys=['theme','enrichmentStrategy','enrichmentFieldSettings','ouiFormats','vendorDetectorSettings','externalVendorApiSettings','historyEnrichmentSettings','ipEnrichmentSettings','comparisonSettings','inventoryColumnConfig','legacyAppSetting:sourceFiles'];const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('settings','readonly');const store=tx.objectStore('settings');const requests=keys.map((key)=>store.get(key));tx.oncomplete=()=>{const records=Object.fromEntries(keys.map((key,index)=>[key,requests[index].result?.value]));db.close();resolve({records,strategy:document.querySelector('input[name="strategy"]:checked')?.value,theme:document.body.dataset.theme||document.documentElement.dataset.theme||''})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const values = importedSettings?.records;
  const columns = values?.inventoryColumnConfig?.columns||[];
  const sources = values?.['legacyAppSetting:sourceFiles']||[];
  const settingsAudit = { theme: values?.theme === 'dark', strategy: values?.enrichmentStrategy === 'NO_EXPANSION', enrichFields: values?.enrichmentFieldSettings?.model === false, ouiFormats: values?.ouiFormats?.[4] === true, vendor: values?.vendorDetectorSettings?.enabled === false, vendorApiDefaultOff: values?.externalVendorApiSettings?.enabled === false, history: values?.historyEnrichmentSettings?.enabled === true, ip: values?.ipEnrichmentSettings?.overwrite === true, comparison: values?.comparisonSettings?.threshold === 90, formattedMac: columns.some((column)=>column.key==='macFormatted'&&column.visible), customColumnHidden: columns.some((column)=>column.custom&&!column.visible), absolutePathExcluded: sources.every((source)=>!JSON.stringify(source).includes('private\\')) };
  if (Object.values(settingsAudit).some((passed)=>!passed)) {
    throw new Error(`PyQt settings did not restore supported preferences or retained a private path/credential: ${JSON.stringify({settingsAudit,importStatus})}`);
  }
  console.log("browser smoke: PyQt settings UI restored theme, strategy, enrichment, comparison, OUI, and columns; secrets and absolute paths were excluded");
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (requestedSmokeUrl?.searchParams.get("smoke") === "column-manager") {
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`);
  let managerState = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(50);
    managerState = await evaluate(`(()=>({open:document.querySelector('#inventoryColumnManagerDialog')?.open,expanded:document.querySelector('#toggleInventoryColumnManager')?.getAttribute('aria-expanded'),keys:[...document.querySelectorAll('#inventoryColumnSettings .inventory-column-setting')].map((row)=>row.dataset.columnSetting),mac:document.querySelector('#inventoryColumnSettings [data-column-visible="mac"]')?.checked}))()`);
    if (managerState.open) break;
  }
  if (!managerState?.open || managerState.expanded !== "true" || managerState.keys.length < 2 || typeof managerState.mac !== "boolean") throw new Error(`Ctrl+Shift+C did not open the engineer Inventory column manager: ${JSON.stringify(managerState)}`);
  const firstKey = managerState.keys[0];
  await evaluate(`document.querySelector('#inventoryColumnSettings [data-column-move="${firstKey}"][data-direction="1"]').click()`);
  let afterMove = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(50);
    afterMove = await evaluate(`([...document.querySelectorAll('#inventoryColumnSettings .inventory-column-setting')].map((row)=>row.dataset.columnSetting))`);
    if (afterMove[1] === firstKey) break;
  }
  if (afterMove?.[1] !== firstKey) throw new Error(`Column manager did not move ${firstKey} down one position: ${JSON.stringify(afterMove)}`);
  await evaluate(`(()=>{const input=document.querySelector('#inventoryColumnSettings [data-column-visible="mac"]');input.checked=!input.checked;input.dispatchEvent(new Event('change',{bubbles:true}));return input.checked})()`);
  let persistedConfig = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(50);
    persistedConfig = await evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('settings','readonly');const request=tx.objectStore('settings').get('inventoryColumnConfig');tx.oncomplete=()=>{db.close();resolve(request.result?.value||null)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (persistedConfig?.columns?.findIndex((column)=>column.key===firstKey) === 1 && persistedConfig.columns.find((column)=>column.key==='mac')?.visible !== managerState.mac) break;
  }
  if (persistedConfig?.columns?.findIndex((column)=>column.key===firstKey) !== 1 || persistedConfig.columns.find((column)=>column.key==='mac')?.visible === managerState.mac) throw new Error(`Column order/visibility changes did not persist: ${JSON.stringify({before:managerState,persistedConfig})}`);
  console.log("browser smoke: Ctrl+Shift+C opened the column manager; order and visibility changes persisted in disposable IndexedDB");
  await evaluate(`document.querySelector('#inventoryColumnManagerDialog').close()`);
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (requestedSmokeUrl?.searchParams.get("smoke") === "batch-drop") {
  await evaluate(`document.querySelector('[data-view="batch"]').click()`);
  let batchDropReady = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    batchDropReady = await evaluate(`Boolean(document.querySelector('[data-batch-file-drop="main"]') && document.querySelector('#batchMainFiles'))`);
    if (batchDropReady) break;
    await wait(100);
  }
  if (!batchDropReady) throw new Error("Массовый экран не смонтировал Main drop area");
  const dropFeedback = await evaluate(`(()=>{const target=document.querySelector('[data-batch-file-drop="main"]');const transfer=new DataTransfer();transfer.items.add(new File(['MAC;Производитель\\n00:11:22:33:44:71;Drop Vendor A'],'drop-a.csv',{type:'text/csv'}));transfer.items.add(new File(['test xls'],'drop-b.xls',{type:'application/vnd.ms-excel'}));transfer.items.add(new File(['test xlsx'],'drop-c.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));transfer.items.add(new File(['ignored'],'skip.pdf',{type:'application/pdf'}));const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:transfer});target.dispatchEvent(event);return document.querySelector('#batchMainStatus').textContent.trim()})()`);
  let droppedFiles = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    droppedFiles = await evaluate(`(()=>({names:[...document.querySelectorAll('#batchMainFiles .batch-source-file-name')].map((node)=>node.textContent.trim()),status:document.querySelector('#batchMainStatus').textContent.trim()}))()`);
    if (droppedFiles.names.length === 3) break;
  }
  if (droppedFiles?.names.join("|") !== "drop-a.csv|drop-b.xls|drop-c.xlsx" || !dropFeedback.includes("Добавлено файлов: 3") || !dropFeedback.includes("Пропущено неподдерживаемых: 1")) throw new Error(`Batch drop did not append each supported path and report the rejected format: ${JSON.stringify({ droppedFiles, dropFeedback })}`);
  await evaluate(`document.querySelector('#batchMainFiles [data-batch-file-remove-index="1"]').click()`);
  const afterRemove = await evaluate(`(()=>({names:[...document.querySelectorAll('#batchMainFiles .batch-source-file-name')].map((node)=>node.textContent.trim()),status:document.querySelector('#batchMainStatus').textContent.trim()}))()`);
  if (afterRemove.names.join("|") !== "drop-a.csv|drop-c.xlsx" || !afterRemove.status.includes("2 файлов")) throw new Error(`Batch drop list did not remove exactly one selected file: ${JSON.stringify(afterRemove)}`);
  await evaluate(`document.querySelector('#batchMainFiles [data-batch-file-remove-index="1"]').click()`);
  const afterSecondRemove = await evaluate(`(()=>({names:[...document.querySelectorAll('#batchMainFiles .batch-source-file-name')].map((node)=>node.textContent.trim()),status:document.querySelector('#batchMainStatus').textContent.trim()}))()`);
  if (afterSecondRemove.names.join("|") !== "drop-a.csv" || !afterSecondRemove.status.includes("1 файлов")) throw new Error(`Batch drop list did not preserve the other supported files after another removal: ${JSON.stringify(afterSecondRemove)}`);
  await evaluate(`document.querySelector('#batchMainFiles [data-batch-file-remove-index="0"]').click()`);
  const afterClear = await evaluate(`({rows:document.querySelectorAll('#batchMainFiles .batch-source-file-name').length,status:document.querySelector('#batchMainStatus').textContent.trim()})`);
  if (afterClear.rows !== 0 || !afterClear.status.includes("0 файлов")) throw new Error(`Batch drop cleanup left files in the disposable queue: ${JSON.stringify(afterClear)}`);
  console.log("browser smoke: batch drag-and-drop appended CSV/XLS/XLSX separately, skipped PDF, and removed only the requested files");
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--reference-archive-only")) {
  const sourceDatabase = new URL(target.url).searchParams.get("db");
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  let archiveInputReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(100);
    archiveInputReady = await evaluate(`Boolean(document.querySelector('#importDatabaseInput'))`);
    if (archiveInputReady) break;
  }
  if (!archiveInputReady) throw new Error("Reference archive smoke could not mount its file input");
  await evaluate(`(()=>{const archive={format:'mac-analyzer-full-json',version:2,exportedAt:'2026-10-15T00:00:00.000Z',analytics:{},workspace:{theme:'dark'},currentDevices:[],allDevices:[{internalDeviceId:'DEV-REFERENCE-SMOKE',mac:'00:11:22:33:44:61',vendor:'Reference Vendor',model:'Reference Model'}],invalidRows:[],movementHistory:[{mac:'00:11:22:33:44:61',type:'Изменено',field:'vendor',before:'Old Vendor',after:'Reference Vendor',changedAt:'2026-10-15T11:00:00.000Z'}],snapshots:[{metadata:{id:'reference-smoke-final',name:'Reference imported Final',source:'reference.csv',kind:'Final',fileCreatedAt:'2026-10-15T10:00:00.000Z',savedAt:'2026-10-15T10:01:00.000Z',deviceCount:1,invalidCount:0},devices:[{internalDeviceId:'DEV-REFERENCE-SMOKE',mac:'00:11:22:33:44:61',vendor:'Reference Vendor',model:'Reference Model'}]}]};const input=document.querySelector('#importDatabaseInput');const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(archive)],'reference-smoke.macarchive.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return input.files[0]?.name})()`);
  let importedProfile = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(250);
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    target = targets.find((item) => item.id === target.id && item.type === "page") || target;
    const profile = new URL(target.url).searchParams.get("db") || "";
    if (/^mac-analyzer-pro-next-profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile)) {
      importedProfile = await evaluate(`(()=>({db:new URL(location.href).searchParams.get('db'),status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
      if (importedProfile.status.includes("1 Final") && importedProfile.status.includes("1 устройств")) break;
    }
  }
  const profileRecords = await evaluate(`(()=>{const name=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshot=tx.objectStore('snapshots').get('reference-smoke-final');const device=tx.objectStore('inventory').get('DEV-REFERENCE-SMOKE');const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({active:active.result?.value,snapshot:Boolean(snapshot.result),vendor:device.result?.manufacturer||'',history:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
  const sourceRecords = await evaluate(`(()=>new Promise((resolve,reject)=>{const request=indexedDB.open(${JSON.stringify(sourceDatabase)});request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({active:active.result?.value||'',snapshots:snapshots.result,inventory:inventory.result,history:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (importedProfile?.error || !importedProfile?.db || profileRecords.active !== "reference-smoke-final" || !profileRecords.snapshot || profileRecords.vendor !== "Reference Vendor" || profileRecords.history !== 1 || sourceRecords.active || sourceRecords.snapshots || sourceRecords.inventory || sourceRecords.history) throw new Error(`Reference archive profile import failed or changed the original database: ${JSON.stringify({importedProfile,profileRecords,sourceRecords})}`);
  const deviceTransferState = await importDeviceArchiveAndVerify(importedProfile.db, profileRecords.active);
  await evaluate(`(()=>{const archive={format:'MAC_ANALYZER_NEXT_ARCHIVE',version:1,snapshots:[{id:'next-v1-smoke-final',name:'Next v1 imported Final',snapshotType:'final',createdAt:'2026-10-15T13:00:00.000Z',deviceCount:1,chunkCount:1,devices:[{id:'NEXT-V1-DEVICE',mac:'00:11:22:33:44:63',model:'Next v1 Model'}]}],inventory:[{id:'NEXT-V1-DEVICE',mac:'00:11:22:33:44:63',manufacturer:'Next v1 Vendor',model:'Next v1 Model',lastSeen:'2026-10-15T13:00:00.000Z'}],history:[{id:'next-v1-smoke-history',snapshotId:'next-v1-smoke-final',deviceId:'NEXT-V1-DEVICE',mac:'00:11:22:33:44:63',type:'added',timestamp:'2026-10-15T13:00:00.000Z',source:'Next v1 smoke'}]};const input=document.querySelector('#importDatabaseInput');if(!input)throw new Error('Data import input is not mounted');const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(archive)],'next-v1-smoke.madb.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return input.files[0]?.name})()`);
  let nextArchiveState = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    nextArchiveState = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(importedProfile.db)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshot=tx.objectStore('snapshots').get('next-v1-smoke-final');const device=tx.objectStore('inventory').get('NEXT-V1-DEVICE');const history=tx.objectStore('history').get('next-v1-smoke-history');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const historyCount=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({active:active.result?.value||'',snapshot:snapshot.result||null,device:device.result||null,history:history.result||null,snapshotCount:snapshots.result,inventoryCount:inventory.result,historyCount:historyCount.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (nextArchiveState?.device?.model === 'Next v1 Model') break;
    const archiveImportError = await evaluate(`(()=>{const banner=document.querySelector('#errorBanner');return banner&&!banner.hidden?(banner.querySelector('span')?.textContent||'Import error'):''})()`);
    if (archiveImportError) throw new Error(`MAC_ANALYZER_NEXT_ARCHIVE v1 import failed: ${archiveImportError}`);
  }
  if (nextArchiveState?.active !== 'next-v1-smoke-final' || nextArchiveState.snapshot?.snapshotType !== 'final' || nextArchiveState.device?.manufacturer !== 'Next v1 Vendor' || nextArchiveState.history?.snapshotId !== 'next-v1-smoke-final' || nextArchiveState.snapshotCount !== 2 || nextArchiveState.inventoryCount !== 3 || nextArchiveState.historyCount !== 2) throw new Error(`MAC_ANALYZER_NEXT_ARCHIVE v1 did not restore its archived active Final additively: ${JSON.stringify(nextArchiveState)}`);
  const backState = await navigateToHistoryDatabase(-1, sourceDatabase, sourceRecords.inventory);
  const sourceAfterBack = await evaluate(`(()=>new Promise((resolve,reject)=>{const request=indexedDB.open(${JSON.stringify(sourceDatabase)});request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({active:active.result?.value||'',snapshots:snapshots.result,inventory:inventory.result,history:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (backState.db !== sourceDatabase || sourceAfterBack.active !== sourceRecords.active || sourceAfterBack.snapshots !== sourceRecords.snapshots || sourceAfterBack.inventory !== sourceRecords.inventory || sourceAfterBack.history !== sourceRecords.history) throw new Error(`Browser Back did not restore the unchanged source profile: ${JSON.stringify({backState,sourceRecords,sourceAfterBack})}`);
  const forwardState = await navigateToHistoryDatabase(1, importedProfile.db, 3);
  const reloadState = await reloadDatabaseAndWait(importedProfile.db);
  const profileAfterReload = await evaluate(`(()=>{const name=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshot=tx.objectStore('snapshots').get('reference-smoke-final');const nextSnapshot=tx.objectStore('snapshots').get('next-v1-smoke-final');const device=tx.objectStore('inventory').get('DEV-REFERENCE-SMOKE');const transferDevice=tx.objectStore('inventory').get('DEVICE-TRANSFER-SMOKE');const nextDevice=tx.objectStore('inventory').get('NEXT-V1-DEVICE');const inventoryCount=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({active:active.result?.value,snapshot:Boolean(snapshot.result),nextSnapshot:Boolean(nextSnapshot.result),vendor:device.result?.manufacturer||'',transferVendor:transferDevice.result?.manufacturer||'',nextVendor:nextDevice.result?.manufacturer||'',inventoryCount:inventoryCount.result,history:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
  if (forwardState.db !== importedProfile.db || reloadState.db !== importedProfile.db || profileAfterReload.active !== nextArchiveState.active || !profileAfterReload.snapshot || !profileAfterReload.nextSnapshot || profileAfterReload.vendor !== profileRecords.vendor || profileAfterReload.transferVendor !== "Device Transfer Vendor" || profileAfterReload.nextVendor !== "Next v1 Vendor" || profileAfterReload.inventoryCount !== 3 || profileAfterReload.history !== nextArchiveState.historyCount) throw new Error(`Imported profile did not survive browser Forward and restart: ${JSON.stringify({forwardState,reloadState,profileRecords,profileAfterReload})}`);
  const recoverySeed = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readwrite');tx.objectStore('settings').put({key:'activeSnapshotId',value:'smoke-incomplete-newest'});tx.objectStore('snapshots').put({id:'smoke-incomplete-newest',name:'Incomplete newer Final',snapshotType:'final',createdAt:'2099-12-31T23:59:59.000Z',deviceCount:1,chunkCount:1});tx.oncomplete=()=>{const verify=db.transaction(['settings','snapshots'],'readonly');const active=verify.objectStore('settings').get('activeSnapshotId');const incomplete=verify.objectStore('snapshots').get('smoke-incomplete-newest');verify.oncomplete=()=>{db.close();resolve({db:name,activeId:active.result?.value,incomplete:Boolean(incomplete.result)})};verify.onerror=()=>{db.close();reject(verify.error)}};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (recoverySeed.db !== importedProfile.db || recoverySeed.activeId !== "smoke-incomplete-newest" || !recoverySeed.incomplete) throw new Error(`Could not seed startup recovery in the imported profile: ${JSON.stringify(recoverySeed)}`);
  await command("Page.reload", { ignoreCache: true });
  let recoveryAfterReload = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await wait(250);
    try {
      recoveryAfterReload = await evaluate(`(()=>({db:new URL(location.href).searchParams.get('db'),status:document.querySelector('#databaseStatus')?.textContent||'',ready:Boolean(document.querySelector('#progressPanel')?.hidden),error:!document.querySelector('#errorBanner')?.hidden}))()`);
    } catch { continue; }
    if (recoveryAfterReload.ready && recoveryAfterReload.status.includes("активный Final восстановлен")) break;
  }
  const recoveryPointer = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const incomplete=tx.objectStore('snapshots').get('smoke-incomplete-newest');const recovered=tx.objectStore('snapshots').get(${JSON.stringify(nextArchiveState.active)});const chunks=tx.objectStore('snapshotChunks').count(IDBKeyRange.bound(['smoke-incomplete-newest',0],['smoke-incomplete-newest',Number.MAX_SAFE_INTEGER]));tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,incomplete:Boolean(incomplete.result),recovered:Boolean(recovered.result),incompleteChunkCount:chunks.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (recoveryAfterReload?.error || !recoveryAfterReload?.ready || recoveryAfterReload.db !== importedProfile.db || !recoveryAfterReload.status.includes("активный Final восстановлен") || recoveryPointer.activeId !== nextArchiveState.active || !recoveryPointer.incomplete || !recoveryPointer.recovered || recoveryPointer.incompleteChunkCount !== 0) throw new Error(`Startup recovery failed after an imported profile reload: ${JSON.stringify({recoverySeed,recoveryAfterReload,recoveryPointer})}`);
  await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('snapshots','readwrite');tx.objectStore('snapshots').delete('smoke-incomplete-newest');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  console.log("browser smoke: reference .macarchive.json v2, devices-json v2, and Next archive v1 imports; Back restores source, Forward/reload preserve imported records and the archived active Final");
  console.log(JSON.stringify({ importedProfile, profileRecords, sourceRecords, backState, sourceAfterBack, forwardState, reloadState, profileAfterReload, deviceTransferState, nextArchiveState, recoverySeed, recoveryAfterReload, recoveryPointer, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

console.log("browser smoke: assigning three source CSVs");
async function assignInput(id, name, content) {
  const selector = JSON.stringify(id);
  const filename = JSON.stringify(name);
  const payload = JSON.stringify(content);
  await evaluate(`(()=>{ const input=document.querySelector(${selector}); const transfer=new DataTransfer(); transfer.items.add(new File([${payload}],${filename},{type:'text/csv'})); input.files=transfer.files; return input.files[0]?.name; })()`);
  console.log(`browser smoke: ${name} assigned`);
  await evaluate(`document.querySelector(${selector}).dispatchEvent(new Event('change',{bubbles:true}))`);
  console.log(`browser smoke: ${name} change dispatched`);
  await wait(250);
}
if (process.argv.includes("--oui-import-workflow-only")) {
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  const source = "Prefix;Organization\n02:11:A0;Smoke OUI Three Byte\n0211A0B1;Smoke OUI Four Byte\n0211A0B1C2;Smoke OUI Five Byte\n";
  await assignInput("#ouiFileInput", "smoke-oui-reference.csv", source);
  let panel = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    panel = await evaluate(`(()=>({hidden:document.querySelector('#ouiImportPanel')?.hidden!==false,prefix:Boolean(document.querySelector('#ouiPrefixColumn')),vendor:Boolean(document.querySelector('#ouiVendorColumn')),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (panel.error) throw new Error(`OUI preview failed: ${panel.message}`);
    if (!panel.hidden && panel.prefix && panel.vendor) break;
  }
  if (panel?.hidden || !panel?.prefix || !panel?.vendor) throw new Error(`OUI column mapping did not open: ${JSON.stringify(panel)}`);
  const columns = await evaluate(`(()=>({prefix:document.querySelector('#ouiPrefixColumn').value,vendor:document.querySelector('#ouiVendorColumn').value,disabled:document.querySelector('#confirmOuiImportButton').disabled}))()`);
  if (columns.prefix !== "0" || columns.vendor !== "1" || columns.disabled) throw new Error(`OUI columns were not mapped from the header: ${JSON.stringify(columns)}`);
  await evaluate(`document.querySelector('#confirmOuiImportButton').click()`);
  let imported = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    imported = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['oui','settings'],'readonly');const three=tx.objectStore('oui').get('0211A0');const four=tx.objectStore('oui').get('0211A0B1');const five=tx.objectStore('oui').get('0211A0B1C2');const source=tx.objectStore('settings').get('ouiSource');tx.oncomplete=()=>{db.close();resolve({three:three.result||null,four:four.result||null,five:five.result||null,source:source.result?.value||'',status:document.querySelector('#ouiStatus')?.textContent||'',panelHidden:document.querySelector('#ouiImportPanel')?.hidden===true})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (imported.panelHidden && imported.three?.vendor === "Smoke OUI Three Byte" && imported.four?.vendor === "Smoke OUI Four Byte" && imported.five?.vendor === "Smoke OUI Five Byte") break;
  }
  const error = await evaluate(`({visible:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
  if (error.visible || imported.source !== "smoke-oui-reference.csv" || !imported.status.includes("Импортировано 3")
    || !imported.panelHidden || imported.three?.vendor !== "Smoke OUI Three Byte" || imported.four?.vendor !== "Smoke OUI Four Byte" || imported.five?.vendor !== "Smoke OUI Five Byte") {
    throw new Error(`OUI import did not persist the complete 3/4/5-byte reference: ${JSON.stringify({imported,error})}`);
  }
  await evaluate(`document.querySelector('#vendorDetectorEnabled').checked=true;document.querySelector('#vendorOuiEnabled').checked=true;document.querySelector('#saveVendorInferenceSettingsButton').click()`);
  await evaluate(`document.querySelector('#historyEnrichmentPrecedenceProfile').value='web';document.querySelector('#saveHistoryEnrichmentSettingsButton').click()`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    if ((await evaluate(`document.querySelector('#historyEnrichmentStatus')?.textContent||''`)).includes("сохранены")) break;
  }
  await evaluate(`document.querySelector('[data-view="enrichment"]')?.click()`);
  await assignInput("#mainFileInput", "smoke-oui-final.csv", "MAC;Device ID;Производитель\n02:11:A0:B1:C2:01;SMOKE-OUI-AUTO;");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2]]) {
    const selected = await evaluate(`(()=>{const control=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!control)throw new Error('Missing Main ${field} mapping in OUI auto-application smoke');control.value=${index};control.dispatchEvent(new Event('change',{bubbles:true}));return control.value})()`);
    if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply for OUI auto-application: ${selected}`);
  }
  let mainReady = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(50);
    mainReady = await evaluate(`!document.querySelector('#runEnrichmentButton')?.disabled`);
    if (mainReady) break;
  }
  if (!mainReady) throw new Error("OUI auto-application Final did not become ready");
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let finalDevice = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    finalDevice = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const device=chunks.result.filter(chunk=>chunk.snapshotId===active.result?.value).flatMap(chunk=>chunk.devices||[]).find(row=>row.deviceId==='SMOKE-OUI-AUTO');db.close();resolve(device||null)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (finalDevice?.manufacturer === "Smoke OUI Five Byte") break;
  }
  const finalError = await evaluate(`({visible:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
  if (finalError.visible || finalDevice?.manufacturer !== "Smoke OUI Five Byte"
    || finalDevice?.fieldSources?.manufacturer !== "Пользовательский справочник") {
    throw new Error(`The longest matching custom OUI prefix was not applied to Final with provenance: ${JSON.stringify({finalDevice,finalError})}`);
  }
  console.log(JSON.stringify({ouiImportWorkflow:true,columns,imported,finalDevice:{id:finalDevice.id,mac:finalDevice.mac,manufacturer:finalDevice.manufacturer,manufacturerSource:finalDevice.fieldSources?.manufacturer},ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
if (process.argv.includes("--older-archive-preserves-new-final-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]')?.click()`);
  await assignInput("#mainFileInput", "newer-final_2026-11-06.csv", "MAC;Device ID;Модель\n00:11:22:33:44:86;NEWER-FINAL-86;Newer browser Final");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2]]) {
    const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
    if (selected !== String(index)) throw new Error(`Main ${field} mapping did not apply: ${selected}`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let newerFinal = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    newerFinal = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const metadata=snapshots.result.find(item=>item.id===active.result?.value);const devices=chunks.result.filter(item=>item.snapshotId===active.result?.value).flatMap(item=>item.devices||[]);db.close();resolve({activeId:active.result?.value||'',name:metadata?.name||'',createdAt:metadata?.createdAt||'',device:devices[0]||null,count:snapshots.result.filter(item=>item.kind!=='single').length})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (newerFinal.count === 1 && newerFinal.device?.deviceId === "NEWER-FINAL-86") break;
  }
  if (newerFinal?.count !== 1 || newerFinal.device?.deviceId !== "NEWER-FINAL-86" || !newerFinal.activeId) throw new Error(`Could not establish the newer browser Final before archive import: ${JSON.stringify(newerFinal)}`);
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  const archiveAssigned = await evaluate(`(()=>{const archive={format:'MAC_ANALYZER_NEXT_ARCHIVE',version:1,snapshots:[{id:'older-imported-final',name:'Older imported Final',snapshotType:'final',createdAt:'2020-01-02T03:04:05.000Z',deviceCount:1,chunkCount:1,devices:[{id:'OLDER-ARCHIVE-86',mac:'00:11:22:33:44:87',model:'Older archive model'}]}],inventory:[{id:'OLDER-ARCHIVE-86',mac:'00:11:22:33:44:87',model:'Older archive model',lastSeen:'2020-01-02T03:04:05.000Z'}],history:[]};const input=document.querySelector('#importDatabaseInput');if(!input)throw new Error('Database archive input is not mounted');const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(archive)],'older-preservation-smoke.madb.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return input.files[0]?.name||''})()`);
  if (archiveAssigned !== "older-preservation-smoke.madb.json") throw new Error(`Could not assign the older archive: ${archiveAssigned}`);
  let afterImport = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    afterImport = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();const chunks=tx.objectStore('snapshotChunks').getAll();const oldDevice=tx.objectStore('inventory').get('OLDER-ARCHIVE-86');const newDevice=tx.objectStore('inventory').get(${JSON.stringify(newerFinal.device.id)});const history=tx.objectStore('history').count();tx.oncomplete=()=>{const activeId=active.result?.value||'';const activeSnapshot=snapshots.result.find(item=>item.id===activeId);const devices=chunks.result.filter(item=>item.snapshotId===activeId).flatMap(item=>item.devices||[]);db.close();resolve({activeId,activeName:activeSnapshot?.name||'',activeDeviceIds:devices.map(item=>item.deviceId),snapshotIds:snapshots.result.map(item=>item.id),olderInventory:oldDevice.result?.model||'',newerInventory:Boolean(newDevice.result),history:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
    if (afterImport.snapshotIds.includes("older-imported-final")) break;
  }
  const banner = await evaluate(`(()=>({visible:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
  if (banner.visible) throw new Error(`Older archive import failed: ${banner.message}`);
  if (afterImport.activeId !== newerFinal.activeId || !afterImport.activeName || !afterImport.activeDeviceIds.includes("NEWER-FINAL-86") || !afterImport.snapshotIds.includes("older-imported-final") || !afterImport.olderInventory || !afterImport.newerInventory) {
    throw new Error(`Older archive replaced newer browser state or failed additive import: ${JSON.stringify({newerFinal,afterImport})}`);
  }
  console.log(JSON.stringify({olderArchivePreservesNewFinalOnly:true,newerFinal,afterImport,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
async function assignBinaryInput(id, name, bytes, type) {
  const selector = JSON.stringify(id);
  const filename = JSON.stringify(name);
  const payload = Buffer.from(bytes).toString("base64");
  const mime = JSON.stringify(type);
  await evaluate(`(()=>{const binary=atob(${JSON.stringify(payload)});const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));const input=document.querySelector(${selector});const transfer=new DataTransfer();transfer.items.add(new File([bytes],${filename},{type:${mime}}));input.files=transfer.files;return input.files[0]?.name})()`);
  console.log(`browser smoke: ${name} assigned (${bytes.length} bytes)`);
  await evaluate(`document.querySelector(${selector}).dispatchEvent(new Event('change',{bubbles:true}))`);
  await wait(250);
}
if (process.argv.includes("--single-file-all-formats-only")) {
  async function* generatedRows() {
    yield ["02:00:00:00:48:01", "SINGLE-XLSX-01", "Smoke Vendor", "XLSX Model", "192.0.2.81", "Smoke Room"];
  }
  const sheets = [{
    name: "Devices",
    headings: ["MAC", "Device ID", "Производитель", "Модель", "IP", "Название комнаты"],
    rows: generatedRows(),
  }];
  const reader = createXlsxWorkbookStream(sheets).getReader();
  const xlsxParts = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    xlsxParts.push(Buffer.from(value));
  }
  const xlsxBytes = Buffer.concat(xlsxParts);
  const legacyXls = readFileSync(resolve("tests/fixtures/legacy-devices.xls"));
  const cases = [
    { name: "single-formats.csv", type: "text/csv", bytes: Buffer.from("MAC;Device ID;Производитель;Модель;IP;Название комнаты\n02:00:00:00:48:02;SINGLE-CSV-02;Smoke Vendor;CSV Model;192.0.2.82;Smoke Room", "utf8"), expected: 1 },
    { name: "single-formats.tsv", type: "text/tab-separated-values", bytes: Buffer.from("MAC\tDevice ID\tПроизводитель\tМодель\tIP\tНазвание комнаты\n02:00:00:00:48:03\tSINGLE-TSV-03\tSmoke Vendor\tTSV Model\t192.0.2.83\tSmoke Room", "utf8"), expected: 1 },
    { name: "single-formats.txt", type: "text/plain", bytes: Buffer.from("MAC;Device ID;Производитель;Модель;IP;Название комнаты\n02:00:00:00:48:04;SINGLE-TXT-04;Smoke Vendor;TXT Model;192.0.2.84;Smoke Room", "utf8"), expected: 1 },
    { name: "single-formats.json", type: "application/json", bytes: Buffer.from(JSON.stringify([{ MAC: "02:00:00:00:48:05", "Device ID": "SINGLE-JSON-05", Производитель: "Smoke Vendor", Модель: "JSON Model", IP: "192.0.2.85", "Название комнаты": "Smoke Room" }]), "utf8"), expected: 1 },
    { name: "single-formats.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: xlsxBytes, expected: 1 },
    { name: "single-formats.xlsm", type: "application/vnd.ms-excel.sheet.macroEnabled.12", bytes: xlsxBytes, expected: 1 },
    { name: "single-formats.xls", type: "application/vnd.ms-excel", bytes: legacyXls, expected: 2 },
  ];
  await evaluate(`document.querySelector('[data-view="single"]').click()`);
  const fieldAliases = {
    mac: ["mac"], deviceId: ["device id"], manufacturer: ["производител", "manufacturer"],
    model: ["модель", "model"], ip: ["ip"], room: ["название комнаты", "room"],
  };
  const outcomes = [];
  for (const item of cases) {
    await assignBinaryInput("#singleFileInput", item.name, item.bytes, item.type);
    let preview = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await wait(50);
      preview = await evaluate(`(()=>({status:document.querySelector('#singleFileStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',mapping:Boolean(document.querySelector('#singleMapping [data-single-mapping-field]'))}))()`);
      if (preview.error || preview.mapping) break;
    }
    if (preview.error || !preview.mapping) throw new Error(`Single-file ${item.name} preview failed: ${JSON.stringify(preview)}`);
    await evaluate(`(()=>{const open=document.querySelector('#singleMapping [data-open-single-mapping-review]');if(!open)throw new Error('Single-file mapping review is missing');open.click();const dialog=document.querySelector('#mappingReviewDialog');if(!dialog.open)throw new Error('Single-file mapping review did not open');const aliases=${JSON.stringify(fieldAliases)};for(const select of dialog.querySelectorAll('[data-review-field]')){const needles=aliases[select.dataset.reviewField]||[];const match=[...select.options].find(option=>option.value!==''&&needles.some(needle=>option.textContent.toLocaleLowerCase().includes(needle)));select.value=match?.value||'';select.dispatchEvent(new Event('change',{bubbles:true}))}dialog.querySelector('#mappingReviewForm').requestSubmit();return true})()`);
    const ready = await evaluate(`!document.querySelector('#mappingReviewDialog').open&&!document.querySelector('#runSingleAnalysisButton').disabled`);
    if (!ready) throw new Error(`Single-file ${item.name} mapping was not applied`);
    await evaluate(`document.querySelector('#runSingleAnalysisButton').click()`);
    let result = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await wait(100);
      result = await evaluate(`(()=>({status:document.querySelector('#singleAnalysisPersistenceStatus')?.textContent||'',text:document.querySelector('#singleAnalysisResult')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
      if (result.error || result.status.includes('Снимок одиночного анализа сохранён')) break;
    }
    if (result.error || !result.status.includes("Снимок одиночного анализа сохранён") || !result.text.includes(`Уникальных устройств${item.expected}`)) {
      throw new Error(`Single-file ${item.name} analysis did not persist the expected ${item.expected} devices: ${JSON.stringify(result)}`);
    }
    outcomes.push({ name: item.name, expectedDevices: item.expected, saved: true });
  }
  const saved = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('singleAnalyses','readonly');const request=tx.objectStore('singleAnalyses').getAll();tx.oncomplete=()=>{db.close();resolve(request.result.map(({filename,deviceCount})=>({filename,deviceCount})).filter(({filename})=>filename.startsWith('single-formats.')))};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  if (saved.length !== cases.length || cases.some((item) => !saved.some((record) => record.filename === item.name && record.deviceCount === item.expected))) {
    throw new Error(`Single-file formats were not all stored with exact counts: ${JSON.stringify({ outcomes, saved })}`);
  }
  console.log(JSON.stringify({ singleFileAllFormatsOnly: true, outcomes, saved, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
if (process.argv.includes("--single-file-safety-only")) {
  const readState = () => evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history','singleAnalyses','singleAnalysisChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();const analyses=tx.objectStore('singleAnalyses').count();const chunks=tx.objectStore('singleAnalysisChunks').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value||'',snapshots:snapshots.result,inventory:inventory.result,history:history.result,analyses:analyses.result,chunks:chunks.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
  const waitFor = async (read, predicate, description, attempts = 300) => {
    let value = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await wait(100);
      value = await read();
      if (predicate(value)) return value;
    }
    throw new Error(`${description}: ${JSON.stringify(value)}`);
  };
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await assignInput("#mainFileInput", "single-safety-baseline.csv", "MAC;Device ID;Model\n02:48:00:00:00:01;SAFETY-BASELINE;Known Model");
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["model", 2]]) {
    await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing Main ${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  await waitFor(() => evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`), (value) => value.error || value.status.includes("1 Final"), "Could not create the baseline Final");
  let baseline = await readState();
  if (!baseline.activeId || baseline.snapshots !== 1 || baseline.inventory !== 1) throw new Error(`Baseline Final was not saved exactly: ${JSON.stringify(baseline)}`);

  await evaluate(`document.querySelector('[data-view="single"]').click()`);
  const conflictCsv = "Internal ID;MAC;Hostname;Manufacturer\nstable-a;00:11:22:33:44:55;;Vendor A\nstable-b;AA:BB:CC:DD:EE:FF;;Vendor B\nstable-a;AA:BB:CC:DD:EE:FF;;Incoming Vendor\nstable-a;00:11:22:33:44:55;shared-host;Vendor A\nstable-b;AA:BB:CC:DD:EE:FF;shared-host;Vendor B\n;22:33:44:55:66:77;shared-host;Ambiguous Vendor";
  await assignBinaryInput("#singleFileInput", "single-safety-conflicts.csv", Buffer.from(conflictCsv), "text/csv");
  await waitFor(() => evaluate(`({ready:Boolean(document.querySelector('[data-single-mapping-field="id"]')),status:document.querySelector('#singleMapping')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`), (value) => value.ready || value.error, "Identity-conflict file preview did not finish");
  if (!await evaluate(`Boolean(document.querySelector('[data-single-mapping-field="id"]'))`)) throw new Error("Identity-conflict file preview failed");
  for (const [field, index] of [["id", 0], ["mac", 1], ["hostname", 2], ["manufacturer", 3]]) {
    await evaluate(`(()=>{const select=document.querySelector('#singleMapping [data-single-mapping-field="${field}"]');if(!select)throw new Error('Missing single-file ${field} mapping');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  }
  await evaluate(`(()=>{document.querySelector('#singleMapping [data-open-single-mapping-review]').click();const dialog=document.querySelector('#mappingReviewDialog');if(!dialog.open)throw new Error('Identity mapping review did not open');dialog.querySelector('#mappingReviewForm').requestSubmit();return true})()`);
  if (!await evaluate(`!document.querySelector('#mappingReviewDialog').open&& !document.querySelector('#runSingleAnalysisButton').disabled`)) throw new Error("Identity mapping review did not apply its explicit choices");
  await evaluate(`document.querySelector('#runSingleAnalysisButton').click()`);
  const conflictResult = await waitFor(() => evaluate(`({text:document.querySelector('#singleAnalysisResult')?.textContent||'',status:document.querySelector('#singleAnalysisPersistenceStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`), (value) => value.error || value.status.includes("Снимок одиночного анализа сохранён"), "Identity-conflict single-file analysis did not finish");
  if (conflictResult.error || !conflictResult.text.includes("Конфликты сильных идентификаторов") || !conflictResult.text.includes("Неоднозначные строки")) throw new Error(`Strong conflict and weak ambiguity were not presented in the UI: ${JSON.stringify(conflictResult)}`);
  const afterConflict = await readState();
  if (afterConflict.activeId !== baseline.activeId || afterConflict.snapshots !== baseline.snapshots + 1 || afterConflict.inventory !== baseline.inventory + 2 || afterConflict.history !== baseline.history + 2 || afterConflict.analyses !== baseline.analyses + 1) throw new Error(`Single-file analysis changed the active Final or did not persist the conflict report exactly once: ${JSON.stringify({baseline,afterConflict})}`);

  const slowUpload = await evaluate(`(()=>{const lines=['MAC;Device ID;Model'];for(let index=0;index<65000;index++){const suffix=index.toString(16).padStart(6,'0');lines.push('02:49:'+suffix.slice(0,2)+':'+suffix.slice(2,4)+':'+suffix.slice(4,6)+':01;CANCEL-'+index+';Cancellation Model')}const file=new File([lines.join('\\n')+'\\n'],'single-safety-cancel.csv',{type:'text/csv'});let offset=0;Object.defineProperty(file,'stream',{configurable:true,value:()=>new ReadableStream({async pull(controller){if(offset>=file.size){controller.close();return}await new Promise(resolve=>setTimeout(resolve,20));const end=Math.min(file.size,offset+16384);controller.enqueue(new Uint8Array(await file.slice(offset,end).arrayBuffer()));offset=end}})});const input=document.querySelector('#singleFileInput');const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));window.__smokeCancelFileSize=file.size;return file.size})()`);
  if (slowUpload < 2_000_000) throw new Error(`Cancellation fixture is unexpectedly small: ${slowUpload}`);
  await waitFor(() => evaluate(`({ready:Boolean(document.querySelector('[data-single-mapping-field="deviceId"]')),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`), (value) => value.ready || value.error, "Cancellation fixture preview did not finish");
  await evaluate(`(()=>{const open=document.querySelector('#singleMapping [data-open-single-mapping-review]');if(!open)throw new Error('Cancellation mapping review is missing');open.click();const dialog=document.querySelector('#mappingReviewDialog');if(!dialog.open)throw new Error('Cancellation mapping review did not open');dialog.querySelector('#mappingReviewForm').requestSubmit();return true})()`);
  await evaluate(`document.querySelector('#runSingleAnalysisButton').click()`);
  const cancelState = await waitFor(() => evaluate(`({visible:!document.querySelector('#progressPanel').hidden,detail:document.querySelector('#progressDetail')?.textContent||'',cancel:Boolean(document.querySelector('#cancelProcessButton'))})`), (value) => value.visible && value.cancel && value.detail.includes("Проверка исходного файла"), "Analysis did not enter cancellable source hashing", 100);
  if (!cancelState.visible) throw new Error(`Cancellation progress did not appear: ${JSON.stringify(cancelState)}`);
  await evaluate(`document.querySelector('#cancelProcessButton').click()`);
  const cancelled = await waitFor(() => evaluate(`({visible:!document.querySelector('#progressPanel').hidden,buttonDisabled:document.querySelector('#runSingleAnalysisButton')?.disabled,status:document.querySelector('#singleAnalysisPersistenceStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden})`), (value) => !value.visible && !value.buttonDisabled, "Cancellation did not stop and restore the single-file UI");
  const afterCancel = await readState();
  if (cancelled.error || afterCancel.activeId !== afterConflict.activeId || afterCancel.snapshots !== afterConflict.snapshots || afterCancel.inventory !== afterConflict.inventory || afterCancel.history !== afterConflict.history || afterCancel.analyses !== afterConflict.analyses || afterCancel.chunks !== afterConflict.chunks) throw new Error(`Cancellation changed persisted data or showed an error: ${JSON.stringify({cancelled,afterConflict,afterCancel})}`);

  await assignBinaryInput("#singleFileInput", "single-safety-save-failure.csv", Buffer.from("MAC;Device ID;Model\n02:4A:00:00:00:01;SAVE-FAILURE;Failure Model", "utf8"), "text/csv");
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-single-mapping-field="deviceId"]'))`), Boolean, "Persistence-failure fixture preview did not finish");
  await evaluate(`(()=>{const open=document.querySelector('#singleMapping [data-open-single-mapping-review]');if(!open)throw new Error('Failure mapping review is missing');open.click();const dialog=document.querySelector('#mappingReviewDialog');if(!dialog.open)throw new Error('Failure mapping review did not open');dialog.querySelector('#mappingReviewForm').requestSubmit();return true})()`);
  await evaluate(`(()=>{const originalAdd=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(...args){if(this.name==='singleAnalyses'){IDBObjectStore.prototype.add=originalAdd;throw new DOMException('Synthetic disposable quota failure','QuotaExceededError')}return originalAdd.apply(this,args)};document.querySelector('#runSingleAnalysisButton').click();return true})()`);
  const failedSave = await waitFor(() => evaluate(`({status:document.querySelector('#singleAnalysisPersistenceStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',buttonDisabled:document.querySelector('#runSingleAnalysisButton')?.disabled})`), (value) => value.status.includes("Результат показан, но не сохранён в истории"), "Injected single-analysis save failure was not surfaced");
  const afterSaveFailure = await readState();
  if (afterSaveFailure.activeId !== afterCancel.activeId || afterSaveFailure.snapshots !== afterCancel.snapshots || afterSaveFailure.inventory !== afterCancel.inventory || afterSaveFailure.history !== afterCancel.history || afterSaveFailure.analyses !== afterCancel.analyses || afterSaveFailure.chunks !== afterCancel.chunks) throw new Error(`Failed single-analysis save altered the previous successful database state: ${JSON.stringify({afterCancel,afterSaveFailure,failedSave})}`);
  if (!failedSave.status.includes("Результат показан, но не сохранён в истории") || !failedSave.status.includes("Synthetic disposable quota failure")) throw new Error(`Single-analysis save failure was not explained to the user: ${JSON.stringify(failedSave)}`);
  console.log(JSON.stringify({singleFileSafetyOnly:true,baseline,conflictResult:{saved:true,identityConflict:true,weakAmbiguity:true},cancelled,saveFailure:failedSave,finalState:afterSaveFailure,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
async function assignGeneratedBlobInput(id, name, rowCount, firstIndex) {
  const selector = JSON.stringify(id);
  const filename = JSON.stringify(name);
  return evaluate(`(()=>{const chunks=[];let rows=[];const padding='x'.repeat(2048);for(let offset=0;offset<${rowCount};offset++){const index=${firstIndex}+offset;const hex=index.toString(16).padStart(6,'0');const mac='02:10:'+hex.slice(0,2)+':'+hex.slice(2,4)+':'+hex.slice(4,6)+':01';rows.push(mac+';DEV-STRESS-'+index+';'+padding);if(rows.length===500){chunks.push(rows.join('\\n')+'\\n');rows=[]}}if(rows.length)chunks.push(rows.join('\\n')+'\\n');const blob=new Blob(['CallingStationID;Device ID;Archive Note\\n',...chunks],{type:'text/csv'});const file=new File([blob],${filename},{type:'text/csv'});const input=document.querySelector(${selector});const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return{name:file.name,size:file.size}})()`);
}
if (process.argv.includes("--stress-only") || process.argv.includes("--xlsx-stress-only") || process.argv.includes("--blob-stress-only") || fallbackExportStress) {
  const xlsxStress = process.argv.includes("--xlsx-stress-only");
  const blobStress = process.argv.includes("--blob-stress-only");
  const requestedStressRows = Number(process.argv.find((argument) => argument.startsWith("--stress-rows="))?.slice("--stress-rows=".length) || 5_000);
  const stressRows = Number.isInteger(requestedStressRows) ? Math.min(25_000, Math.max(1_000, requestedStressRows)) : 5_000;
  const formattedStressRows = (value) => value.toLocaleString("ru-RU").replace(/\s+/g, " ");
  const heapProfile = { samples: 0, peakUsedBytes: 0, finalUsedBytes: 0, peakStage: "" };
  const sampleBrowserHeap = async (stage) => {
    const usage = await command("Runtime.getHeapUsage");
    heapProfile.samples += 1;
    heapProfile.finalUsedBytes = usage.usedSize;
    if (usage.usedSize > heapProfile.peakUsedBytes) {
      heapProfile.peakUsedBytes = usage.usedSize;
      heapProfile.peakStage = stage;
    }
  };
  await sampleBrowserHeap("startup");
  const stressCsv = (firstIndex, filename) => {
    const rows = Array.from({ length: stressRows }, (_, offset) => {
      const index = firstIndex + offset;
      const hex = index.toString(16).padStart(6, "0");
      return `02:10:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:01;DEV-STRESS-${index}`;
    });
    return { filename, content: ["CallingStationID;Device ID", ...rows].join("\n") };
  };
  const stressXlsx = (firstIndex, filename) => {
    const rows = [`<row r="1"><c r="A1" t="inlineStr"><is><t>CallingStationID</t></is></c><c r="B1" t="inlineStr"><is><t>Device ID</t></is></c></row>`];
    for (let offset = 0; offset < stressRows; offset += 1) {
      const index = firstIndex + offset;
      const hex = index.toString(16).padStart(6, "0");
      const mac = `02:10:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:01`;
      rows.push(`<row r="${offset + 2}"><c r="A${offset + 2}" t="inlineStr"><is><t>${mac}</t></is></c><c r="B${offset + 2}" t="inlineStr"><is><t>DEV-STRESS-${index}</t></is></c></row>`);
    }
    const worksheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
    const entries = [
      { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
      { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Main" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: "xl/worksheets/sheet1.xml", data: worksheet },
    ];
    return { filename, bytes: createZip(entries) };
  };
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  for (const [firstIndex, filename] of [[0, `main_${stressRows}_stress_a.csv`], [stressRows, `main_${stressRows}_stress_b.csv`]]) {
    await evaluate(`document.querySelector('#resetFilesButton').click()`);
    const sourceName = xlsxStress ? filename.replace(/\.csv$/i, ".xlsx") : blobStress ? filename.replace(/\.csv$/i, "_blob.csv") : filename;
    if (xlsxStress) {
      const source = stressXlsx(firstIndex, sourceName);
      await assignBinaryInput("#mainFileInput", source.filename, source.bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } else if (blobStress) {
      const assigned = await assignGeneratedBlobInput("#mainFileInput", sourceName, stressRows, firstIndex);
      console.log(`browser smoke: ${assigned.name} assigned (${assigned.size} bytes)`);
    } else {
      const source = stressCsv(firstIndex, sourceName);
      await assignInput("#mainFileInput", source.filename, source.content);
    }
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(100);
      if (attempt % 10 === 0) await sampleBrowserHeap(`${filename} readiness`);
      ready = await evaluate(`!document.querySelector('#runEnrichmentButton').disabled`);
      if (ready) break;
    }
    if (!ready) throw new Error(`Stress-only source ${filename} did not become ready`);
    for (const [field, index] of [["mac", 0], ["deviceId", 1]]) {
      const selected = await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!select)throw new Error('Missing stress Main mapping ${field}');select.value=${index};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`);
      if (selected !== String(index)) throw new Error(`Stress-only mapping ${field} did not select source column ${index}`);
    }
    await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
    const expectedFinalCount = firstIndex ? 2 : 1;
    let committed = false;
    const commitAttempts = Math.max(600, Math.min(3_600, Math.ceil(stressRows / 5_000) * 600));
    let lastProgress = "";
    for (let attempt = 0; attempt < commitAttempts; attempt += 1) {
      await wait(100);
      if (attempt % 100 === 0) {
        await sampleBrowserHeap(`${filename} Final commit`);
        const progress = await evaluate(`document.querySelector('#progressDetail')?.textContent||''`);
        if (progress && progress !== lastProgress) {
          lastProgress = progress;
          console.log(`browser smoke: stress-only import progress: ${progress}`);
        }
      }
      const status = await evaluate(`document.querySelector('#databaseStatus').textContent`);
      const error = await evaluate(`!document.querySelector('#errorBanner').hidden`);
      if (error) throw new Error(`Stress-only Final failed: ${await evaluate(`document.querySelector('#errorBanner span').textContent`)}`);
      if (new RegExp(`(?:^|\\D)${expectedFinalCount} Final`).test(status)) { committed = true; break; }
    }
    if (!committed) throw new Error(`Stress-only ${expectedFinalCount}th Final did not commit within ${commitAttempts / 10} seconds; last progress: ${lastProgress}`);
  }
  const activeSnapshotId = await evaluate(`new URL(location.href).searchParams.get('db')`);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let pair = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await wait(100);
    pair = await evaluate(`(()=>{const current=document.querySelector('#currentSnapshotSelect');const base=document.querySelector('#baseSnapshotSelect');const target=current.options[current.options.length-1];if(target){current.value=target.value;base.value=current.options[current.options.length-2]?.value||'';document.querySelector('#applyComparisonButton').click()}return{current:current.value,base:base.value,ready:Boolean(target)}})()`);
    if (pair.ready) break;
  }
  if (!pair?.ready || !pair.current || !pair.base) throw new Error(`Stress-only Dashboard pair unavailable: ${JSON.stringify(pair)}`);
  let dashboard = null;
  let previous = "";
  let changedAt = Date.now();
  for (let attempt = 0; attempt < 7_200; attempt += 1) {
    await wait(100);
    if (attempt % 10 === 0) await sampleBrowserHeap("Dashboard and temporal analytics");
    dashboard = await evaluate(`(()=>({loading:!document.querySelector('#analyticsLoadingStatus').hidden,stage:document.querySelector('#analyticsLoadingStatus').textContent,kpis:document.querySelector('#analyticsKpis').textContent.replace(/\\s+/g,' '),overview:document.querySelector('#datasetOverview').textContent.replace(/\\s+/g,''),temporal:document.querySelector('#temporalSummary').textContent.replace(/\\s+/g,' '),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (dashboard.stage !== previous) { previous = dashboard.stage; changedAt = Date.now(); console.log(`browser smoke: stress-only progress: ${previous}`); }
    if (dashboard.error) throw new Error(`Stress-only Dashboard error: ${dashboard.message}`);
    if (!dashboard.loading && dashboard.overview.includes(`Устройств${stressRows}`) && dashboard.temporal.includes(`Уникальных MAC${formattedStressRows(stressRows * 2)}`)) break;
    if (Date.now() - changedAt > 90_000) throw new Error(`Stress-only Dashboard made no progress for 90 seconds: ${JSON.stringify(dashboard)}`);
  }
  if (dashboard?.loading || !dashboard?.overview.includes(`Устройств${stressRows}`) || !dashboard.kpis.includes(`Отсутствуют ${formattedStressRows(stressRows)}`) || !dashboard.kpis.includes("Без изменений 0") || !dashboard.temporal.includes(`Уникальных MAC${formattedStressRows(stressRows * 2)}`)) {
    throw new Error(`Stress-only pair Dashboard/temporal results are incomplete: ${JSON.stringify({ pair, activeSnapshotId, dashboard })}`);
  }
  let originalBlobEvidence = null;
  if (blobStress) {
    originalBlobEvidence = await evaluate(`(()=>new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('originalFiles','readonly');const current=tx.objectStore('originalFiles').get([${JSON.stringify(pair.current)},'main']);const base=tx.objectStore('originalFiles').get([${JSON.stringify(pair.base)},'main']);Promise.all([current,base].map(request=>new Promise((res,rej)=>{request.onsuccess=()=>res(request.result||null);request.onerror=()=>rej(request.error)}))).then(async files=>{const values=[];for(const file of files){values.push(file&&{name:file.name,size:file.size,blobSize:file.blob?.size,first:file.blob?await file.blob.slice(0,64).text():'',last:file.blob?await file.blob.slice(-4096).text():''})}db.close();resolve(values)}).catch(error=>{db.close();reject(error)})}}))()`);
    if (!originalBlobEvidence?.length || originalBlobEvidence.some((file, index) => !file || file.size < stressRows * 2_000 || file.blobSize !== file.size || !file.first.startsWith("CallingStationID;Device ID;Archive Note") || !file.last.includes(`DEV-STRESS-${index === 0 ? stressRows * 2 - 1 : stressRows - 1}`))) {
      throw new Error(`Large original-file Blobs were not persisted byte-completely with both Final snapshots: ${JSON.stringify(originalBlobEvidence)}`);
    }
  }
  let fallbackExportEvidence = null;
  if (fallbackExportStress) {
    if (await evaluate("typeof globalThis.showSaveFilePicker") !== "undefined") throw new Error("File System Access unexpectedly remained available in the fallback stress run");
    await evaluate("document.querySelector('[data-view=\"multicompare\"]').click()");
    const first = stressCsv(0, `fallback-before-${stressRows}.csv`);
    const second = stressCsv(stressRows * 2, `fallback-after-${stressRows}.csv`);
    await evaluate(`(()=>{const input=document.querySelector('#multiCompareFilesInput');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(first.content)}],${JSON.stringify(first.filename)},{type:'text/csv'}));transfer.items.add(new File([${JSON.stringify(second.content)}],${JSON.stringify(second.filename)},{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return input.files.length})()`);
    let compareReady = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await wait(100);
      const state = await evaluate("({ status: document.querySelector('#multiCompareStatus').textContent, pairs: document.querySelector('#multiComparePairSelect').options.length, enabled: !document.querySelector('#exportAllMultiCompareCsvButton').disabled, error: !document.querySelector('#errorBanner').hidden, message: document.querySelector('#errorBanner span')?.textContent || '' })");
      if (state.error) throw new Error(`Fallback comparison preview failed: ${state.message}`);
      if (state.pairs === 2 && state.enabled) { compareReady = true; break; }
    }
    if (!compareReady) throw new Error("Fallback multi-file comparison did not prepare both directed pairs");
    await evaluate("(()=>{const nativeCreate=URL.createObjectURL.bind(URL);window.__fallbackExport={blob:null,name:''};URL.createObjectURL=(blob)=>{if(blob.type==='text/csv;charset=utf-8')window.__fallbackExport.blob=blob;return nativeCreate(blob)};HTMLAnchorElement.prototype.click=function(){if(this.download==='multi-file-comparison.csv')window.__fallbackExport.name=this.download}})()");
    await sampleBrowserHeap("fallback CSV export before start");
    await evaluate("document.querySelector('#exportAllMultiCompareCsvButton').click()");
    let exportReady = false;
    let exportPeakUsedBytes = 0;
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      await wait(50);
      const usage = await command("Runtime.getHeapUsage");
      exportPeakUsedBytes = Math.max(exportPeakUsedBytes, usage.usedSize);
      const state = await evaluate("({ blob: Boolean(window.__fallbackExport?.blob), name: window.__fallbackExport?.name || '', error: !document.querySelector('#errorBanner').hidden, message: document.querySelector('#errorBanner span')?.textContent || '', progress: document.querySelector('#progressDetail')?.textContent || '' })");
      if (state.error) throw new Error(`Fallback CSV export failed: ${state.message}`);
      if (state.blob && state.name) { exportReady = true; break; }
    }
    if (!exportReady) throw new Error("Fallback CSV export did not produce a downloadable Blob");
    fallbackExportEvidence = await evaluate(`(async()=>{const blob=window.__fallbackExport.blob;const reader=blob.stream().getReader();const decoder=new TextDecoder();let lines=0;let tail='';let head='';let first=true;for(;;){const {value,done}=await reader.read();if(done)break;const text=decoder.decode(value,{stream:true});if(first){head=text.slice(0,512);first=false}lines+=(text.match(/\\n/g)||[]).length;tail=(tail+text).slice(-1024)}const final=decoder.decode();lines+=(final.match(/\\n/g)||[]).length;tail=(tail+final).slice(-1024);return{name:window.__fallbackExport.name,size:blob.size,type:blob.type,lines,head,tail}})()`);
    const finalHex = (stressRows * 3 - 1).toString(16).padStart(6, "0");
    const uppercaseHex = finalHex.toUpperCase();
    const expectedLastMac = `02:10:${uppercaseHex.slice(0, 2)}:${uppercaseHex.slice(2, 4)}:${uppercaseHex.slice(4, 6)}:01`;
    if (fallbackExportEvidence.name !== "multi-file-comparison.csv" || fallbackExportEvidence.type !== "text/csv;charset=utf-8"
      || fallbackExportEvidence.lines !== stressRows * 4 + 1 || !fallbackExportEvidence.head.includes("Первый файл")
      || !fallbackExportEvidence.tail.includes(expectedLastMac) || !fallbackExportEvidence.tail.includes("Только в первом файле")) {
      throw new Error(`Fallback CSV export was incomplete or miscounted: ${JSON.stringify(fallbackExportEvidence)}`);
    }
    fallbackExportEvidence = { ...fallbackExportEvidence, head: undefined, tail: undefined, expectedLastMac, exportPeakUsedBytes, exportPeakUsedMiB: Math.round(exportPeakUsedBytes / 1_048_576) };
  }
  await sampleBrowserHeap("completed");
  console.log(JSON.stringify({ stressOnly: true, format: fallbackExportStress ? "CSV fallback without File System Access" : xlsxStress ? "XLSX" : blobStress ? "large Blob CSV" : "CSV", stressRowsPerFinal: stressRows, pair, dashboard, originalBlobEvidence: originalBlobEvidence?.map(({ name, size, blobSize }) => ({ name, size, blobSize })), fallbackExportEvidence, heapProfile: { ...heapProfile, peakUsedMiB: Math.round(heapProfile.peakUsedBytes / 1_048_576), finalUsedMiB: Math.round(heapProfile.finalUsedBytes / 1_048_576) }, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
if (process.argv.includes("--roster-only")) {
  const requestedRosterSize = Number(process.argv.find((argument) => argument.startsWith("--roster-size="))?.slice("--roster-size=".length) || 125);
  const rosterSize = Number.isInteger(requestedRosterSize) ? Math.min(12_249, Math.max(101, requestedRosterSize)) : 125;
  const secondPageSize = Math.min(100, rosterSize - 100);
  const secondPageEnd = 100 + secondPageSize;
  const rosterMac = (rowNumber) => {
    const suffix = rowNumber.toString(16).padStart(10, "0");
    return `02:${suffix.slice(0, 2)}:${suffix.slice(2, 4)}:${suffix.slice(4, 6)}:${suffix.slice(6, 8)}:${suffix.slice(8, 10)}`;
  };
  const rosterCsv = ["CallingStationID;Device ID", ...Array.from({ length: rosterSize }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(10, "0");
    const mac = `02:${suffix.slice(0, 2)}:${suffix.slice(2, 4)}:${suffix.slice(4, 6)}:${suffix.slice(6, 8)}:${suffix.slice(8, 10)}`;
    return `${mac};DEV-ROSTER-${String(index + 1).padStart(3, "0")}`;
  })].join("\n");
  await assignInput("#mainFileInput", `main_roster_${rosterSize}.csv`, rosterCsv);
  await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
  let finalReady = false;
  let finalState = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await wait(100);
    finalState = await evaluate(`({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (finalState.error) throw new Error(`Roster-only enrichment failed: ${finalState.message}`);
    if (finalState.status.includes(`${rosterSize.toLocaleString("ru-RU")} устройств`)) { finalReady = true; break; }
    if (attempt && attempt % 50 === 0) console.log(`browser smoke: waiting for ${rosterSize.toLocaleString("ru-RU")} device Final: ${finalState.status}`);
  }
  if (!finalReady) throw new Error(`Roster-only ${rosterSize}-device Final was not committed: ${JSON.stringify(finalState)}`);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let firstPage = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    firstPage = await evaluate(`(()=>{const rows=[...document.querySelectorAll('#changeTable tbody tr:not([data-virtual-spacer="true"])')];return{loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',heading:document.querySelector('#changeTable h3')?.textContent||'',rows:rows.length,firstRow:rows[0]?.textContent||'',range:document.querySelector('#changeTable .action-row span')?.textContent.replace(/\s+/g,' ')||'',next:Boolean(document.querySelector('#changeTable [data-status-roster-page="all"][data-page-offset="100"]'))}})()`);
    if (firstPage.error) throw new Error(`Roster-only Dashboard failed: ${firstPage.message}`);
    if (!firstPage.loading && firstPage.heading === "Все устройства") break;
  }
  if (firstPage?.loading || firstPage?.heading !== "Все устройства" || firstPage.rows < 1 || !firstPage.firstRow.includes(rosterMac(1)) || !firstPage.range.replace(/\s/g, "").includes(`1–100из${rosterSize}`) || !firstPage.next) {
    throw new Error(`Dashboard roster first page is incorrect: ${JSON.stringify(firstPage)}`);
  }
  await evaluate(`(()=>{const scroll=document.querySelector('#changeTable .table-scroll');if(!scroll)throw new Error('Dashboard roster scroll container is missing');scroll.scrollTop=scroll.scrollHeight;return true})()`);
  await wait(150);
  const firstPageEnd = await evaluate(`(()=>{const rows=[...document.querySelectorAll('#changeTable tbody tr:not([data-virtual-spacer="true"])')];return{rows:rows.length,lastRow:rows.at(-1)?.textContent||''}})()`);
  if (!firstPageEnd.rows || !firstPageEnd.lastRow.includes(rosterMac(100))) throw new Error(`Dashboard virtual roster did not reach row 100 on its first page: ${JSON.stringify(firstPageEnd)}`);
  await evaluate(`document.querySelector('#changeTable [data-status-roster-page="all"][data-page-offset="100"]').click()`);
  let secondPage = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    secondPage = await evaluate(`(()=>{const rows=[...document.querySelectorAll('#changeTable tbody tr:not([data-virtual-spacer="true"])')];return{error:!document.querySelector('#errorBanner').hidden,rows:rows.length,firstRow:rows[0]?.textContent||'',range:document.querySelector('#changeTable .action-row span')?.textContent.replace(/\s+/g,' ')||''}})()`);
    if (secondPage.range.replace(/\s/g, "").includes(`101–${secondPageEnd}из${rosterSize}`)) break;
  }
  if (secondPage?.error || secondPage?.rows < 1 || !secondPage.firstRow.includes(rosterMac(101)) || !secondPage.range.replace(/\s/g, "").includes(`101–${secondPageEnd}из${rosterSize}`)) {
    throw new Error(`Dashboard roster second page is incorrect: ${JSON.stringify(secondPage)}`);
  }
  await evaluate(`(()=>{const nativeCreate=URL.createObjectURL.bind(URL);window.__smokeDownloadBlobs=new Map();window.__smokeDashboardDownloads=[];URL.createObjectURL=(blob)=>{const url=nativeCreate(blob);window.__smokeDownloadBlobs.set(url,blob);return url};HTMLAnchorElement.prototype.click=function(){const blob=window.__smokeDownloadBlobs.get(this.href);if(this.download.startsWith('analytics-dashboard-'))window.__smokeDashboardDownloads.push({name:this.download,blob});};Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:undefined});return true})()`);
  await evaluate(`document.querySelector('#exportAnalyticsHtmlButton').click()`);
  await evaluate(`document.querySelector('#exportAnalyticsPngButton').click()`);
  await evaluate(`(()=>{window.__smokeXlsx={name:'',chunks:[],closed:false};Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async({suggestedName})=>{window.__smokeXlsx.name=suggestedName;return{createWritable:async()=>new WritableStream({write:async(chunk)=>window.__smokeXlsx.chunks.push(chunk),close:async()=>{window.__smokeXlsx.closed=true},abort:async()=>{}})}}});return true})()`);
  await evaluate(`document.querySelector('#exportAnalyticsXlsxButton').click()`);
  let dashboardExports = null;
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    await wait(50);
    dashboardExports = await evaluate(`(async()=>{const downloads=window.__smokeDashboardDownloads||[];const html=downloads.find(({name})=>name.endsWith('.html'))?.blob;const png=downloads.find(({name})=>name.endsWith('.png'))?.blob;const xlsx=window.__smokeXlsx||{};const xlsxBlob=new Blob(xlsx.chunks||[]);const htmlText=html?await html.text():'';const compactHtml=htmlText.replace(/\\s/g,'');const pngBytes=png?Array.from(new Uint8Array(await png.slice(0,8).arrayBuffer())):[];const xlsxBytes=Array.from(new Uint8Array(await xlsxBlob.slice(0,4).arrayBuffer()));return{htmlName:downloads.find(({name})=>name.endsWith('.html'))?.name||'',htmlType:html?.type||'',htmlSize:html?.size||0,htmlTitle:htmlText.includes('<title>MAC Analyzer Pro · Dashboard</title>'),htmlRows:compactHtml.includes('Устройства:</strong>${rosterSize}')&&htmlText.includes('Без изменений'),pngName:downloads.find(({name})=>name.endsWith('.png'))?.name||'',pngType:png?.type||'',pngSize:png?.size||0,pngSignature:pngBytes,xlsxName:xlsx.name||'',xlsxSize:xlsxBlob.size,xlsxSignature:xlsxBytes,xlsxClosed:Boolean(xlsx.closed)}})()`);
    if (dashboardExports.htmlName && dashboardExports.pngName && dashboardExports.xlsxClosed) break;
    if (attempt && attempt % 100 === 0) console.log(`browser smoke: waiting for Dashboard exports: HTML ${dashboardExports.htmlSize} bytes, XLSX ${dashboardExports.xlsxSize} bytes, closed=${dashboardExports.xlsxClosed}`);
  }
  if (!dashboardExports?.htmlName.endsWith('.html') || dashboardExports.htmlType !== 'text/html;charset=utf-8' || !dashboardExports.htmlSize || !dashboardExports.htmlTitle || !dashboardExports.htmlRows
    || !dashboardExports.pngName.endsWith('.png') || dashboardExports.pngType !== 'image/png' || !dashboardExports.pngSize || dashboardExports.pngSignature.join(',') !== '137,80,78,71,13,10,26,10'
    || !dashboardExports.xlsxName.endsWith('.xlsx') || !dashboardExports.xlsxClosed || dashboardExports.xlsxSize < 100 || dashboardExports.xlsxSignature.join(',') !== '80,75,3,4') {
    throw new Error(`Dashboard UI export artifact is invalid: ${JSON.stringify(dashboardExports)}`);
  }
  console.log(JSON.stringify({ rosterOnly: true, rosterSize, firstPage, secondPage, dashboardExports, ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
await assignInput("#mainFileInput", "main_2026-10-14.csv", "CallingStationID;NasIP;NasPortID;B_ReceiptTime;Device ID;IP address\n00:11:22:33:44:51;10.0.0.1;1;14.10.2026 10:00:00;DEV-51;N/A\n00:11:22:33:44:52;10.0.0.1;2;14.10.2026 10:01:00;DEV-52;192.168.1.52\n00:11:22:33:44:53;10.0.0.1;3;14.10.2026 10:02:00;DEV-53;192.168.1.53\n00:11:22:33:44:54;10.0.0.2;4;14.10.2026 10:03:00;DEV-54;");
await assignInput("#smartroomFileInput", "smartroom_2026-10-14.csv", "MAC;MAC-адрес 2;IP адрес;Производитель;Модель;Тип модели;Smartroom ID локации;ТБ;Город;Площадка;Этаж;Название комнаты;Адрес локации\n00:11:22:33:44:51;;;Vendor;Model A;Video Conference;SR-1;;;;;ЦА, Москва, Кутузовский, 3, Переговорная 1;Кутузовский 1\n00:11:22:33:44:52;;192.168.1.52;Vendor;Model B;Display;SR-1;ЦА;Москва;Кутузовский;3;Переговорная 1;Кутузовский 1\n00:11:22:33:44:53;;192.168.1.53;Vendor;Model C;Display;SR-1;ЦА;Москва;Кутузовский;3;Переговорная 1;Кутузовский 1\n00:11:22:33:44:99;00:11:22:33:44:54;;Vendor;Model D;Display;;ЦА;Москва;Кутузовский;3;Переговорная 1;Кутузовский 1");
await assignInput("#ddioFileInput", "ddio_2026-10-14.csv", "Reservation IP;Reservation MAC;Lease IP;Lease MAC\n192.168.1.51;00-11-22-33-44-51;;\n;;192.168.9.52;0011.2233.4452\n192.168.1.99;00:11:22:33:44:99;;\n10.9.9.66;AA:BB:CC:DD:EE:66;;");
const ddioMappingReview = await evaluate(`(()=>{const allowed=['reservationMac','reservationIp','leaseMac','leaseIp'];const actual=[...document.querySelectorAll('#ddioMapping [data-mapping-field]')].map((select)=>select.dataset.mappingField);const assign=(role,field,index)=>{const select=document.querySelector('[data-mapping-role="'+role+'"][data-mapping-field="'+field+'"]');if(!select)throw new Error('Missing '+role+' mapping field '+field);select.value=String(index);select.dispatchEvent(new Event('change',{bubbles:true}))};assign('main','ip',5);for(const [field,index] of [['reservationIp',0],['reservationMac',1],['leaseIp',2],['leaseMac',3]])assign('ddio',field,index);return{actual,allowed,mainIp:document.querySelector('[data-mapping-role="main"][data-mapping-field="ip"]')?.value,ddio:Object.fromEntries(allowed.map((field)=>[field,document.querySelector('[data-mapping-role="ddio"][data-mapping-field="'+field+'"]')?.value]))}})()`);
if (ddioMappingReview.actual.join("|") !== ddioMappingReview.allowed.join("|") || ddioMappingReview.mainIp !== "5" || Object.values(ddioMappingReview.ddio).join("|") !== "1|0|3|2") throw new Error(`DDIO UI exposed unexpected fields or did not retain the four reviewed mappings: ${JSON.stringify(ddioMappingReview)}`);
await evaluate(`(()=>{const select=document.querySelector('[data-mapping-role="smartroom"][data-mapping-field="room"]');select.value="11";select.dispatchEvent(new Event('change',{bubbles:true}));return select.value;})()`);
console.log("browser smoke: SmartRoom room mapping reviewed");
await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
console.log("browser smoke: import inputs dispatched and enrichment requested");
const enrichmentConfirmation = await evaluate(`window.__smokeConfirmMessages?.[0]||""`);
const smartroomMappingConfirmation = enrichmentConfirmation.split("\n").find((line) => line.startsWith("SmartRoom (")) || "";
if (!smartroomMappingConfirmation.includes("Помещение → L · Название комнаты")) throw new Error(`Проверенное SmartRoom сопоставление не попало в запуск: ${enrichmentConfirmation}`);

let finished = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await wait(250);
  const state = await evaluate(`({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||""})`);
  if (state.error) throw new Error(`UI enrichment error: ${state.message}`);
  if (state.status.includes("1 Final")) { finished = true; break; }
  if (attempt % 10 === 9) console.log(`browser smoke: waiting for first Final (${attempt + 1}/60)`);
}
if (!finished) throw new Error("Обогащение не завершилось за 15 секунд");

const sourceDateMetadata = await evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');let snapshot=null;active.onsuccess=()=>{const request=tx.objectStore('snapshots').get(active.result?.value);request.onsuccess=()=>{snapshot=request.result||null}};tx.oncomplete=()=>{db.close();resolve(snapshot&&{name:snapshot.name,createdAt:snapshot.createdAt,fileCreatedAt:snapshot.fileCreatedAt})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
if (sourceDateMetadata?.name !== "Final main_2026-10-14.csv" || !String(sourceDateMetadata.createdAt || "").startsWith("2026-10-14")) throw new Error(`Дата выгрузки не взята из даты в имени файла: ${JSON.stringify(sourceDateMetadata)}`);
console.log("browser smoke: Final observation date follows the source filename date, not the file-picker copy time");

const finalState = await evaluate(`({
  status: document.querySelector('#databaseStatus').textContent,
  summary: document.querySelector('#enrichmentSummary').textContent
})`);
if (!finalState.status.includes("4 устройств")) throw new Error(`Неверное число Inventory: ${finalState.status}`);
if (!finalState.summary.includes("конфликтов: 0")) throw new Error(`Secondary MAC создал конфликт идентичности: ${finalState.summary}`);
await evaluate(`document.querySelector('[data-view="search"]').click()`);
await wait(250);
const readDeviceRows = () => evaluate(`(()=>{const keys=[...document.querySelectorAll('#deviceTable thead [data-inventory-column-resize]')].map((header)=>header.dataset.inventoryColumnResize);return [...document.querySelectorAll('#deviceTable tbody tr')].map((row)=>Object.fromEntries(keys.map((key,index)=>[key,row.cells[index+1]?.textContent.trim()||''])))})()`);
finalState.searchRows = await readDeviceRows();
const ddioRow = finalState.searchRows.find((row) => row.mac?.includes("00:11:22:33:44:51"));
if (ddioRow?.ip !== "192.168.1.51") throw new Error(`DDIO IP не появился в финальной таблице: ${JSON.stringify(finalState)}`);
const authenticationTimeRow = finalState.searchRows.find((row) => row.mac?.includes("00:11:22:33:44:51"));
if (authenticationTimeRow?.authenticationTime !== "2026-10-14T10:00:00.000Z") throw new Error(`Время аутентификации не прошло из Main через Final в стандартную таблицу Inventory: ${JSON.stringify(authenticationTimeRow)}`);
const knownIpRow = finalState.searchRows.find((row) => row.mac?.includes("00:11:22:33:44:52"));
if (knownIpRow?.ip !== "192.168.1.52" || knownIpRow?.switchIp !== "10.0.0.1") throw new Error(`DDIO заменил известный IP устройства или смешал его с IP коммутатора: ${JSON.stringify(knownIpRow)}`);
const missingSmartroomIdRow = finalState.searchRows.find((row) => row.mac?.includes("00:11:22:33:44:54"));
if (missingSmartroomIdRow?.ip !== "192.168.1.99" || missingSmartroomIdRow?.switchIp !== "10.0.0.2" || missingSmartroomIdRow?.room !== "Переговорная 1" || missingSmartroomIdRow?.address !== "Кутузовский 1") throw new Error(`SmartRoom secondary MAC did not preserve Main identity and let DDIO fill the blank IP for a device without Smartroom ID: ${JSON.stringify(missingSmartroomIdRow)}`);
const ddioDeviceState = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const chunks=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const devices=chunks.result.filter((chunk)=>chunk.snapshotId===active.result?.value).flatMap((chunk)=>chunk.devices);const known=devices.find((item)=>item.mac==='00:11:22:33:44:52');db.close();resolve({count:devices.length,known:known&&{ip:known.ip,switchIp:known.switchIp,possibleIps:known.possibleIps}})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
if (ddioDeviceState.count !== 4 || ddioDeviceState.known?.ip !== "192.168.1.52" || ddioDeviceState.known?.switchIp !== "10.0.0.1" || !ddioDeviceState.known.possibleIps.includes("192.168.9.52")) throw new Error(`DDIO lease overlay changed a known IP, mixed switch IP, or created an unmatched device: ${JSON.stringify(ddioDeviceState)}`);
console.log("browser smoke: DDIO exposes exactly four reservation/lease mappings, fills blank/N/A IP by exact MAC, keeps known and switch IPs, and ignores unmatched DDIO rows");
if (process.argv.includes("--ddio-only")) {
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await wait(150);
  const initialSwitchIpReport = await evaluate(`(()=>{const host=document.querySelector('#enrichmentSummary [data-switch-ip-change-container]');return{present:Boolean(host),rows:host?.querySelectorAll('tbody tr').length||0,text:host?.textContent.trim()||''}})()`);
  if (!initialSwitchIpReport.present || initialSwitchIpReport.rows !== 0 || initialSwitchIpReport.text) throw new Error(`A DDIO/secondary-file value fabricated a switch-IP history change before a prior Final existed: ${JSON.stringify(initialSwitchIpReport)}`);
  await wait(50);
  await assignInput("#mainFileInput", "main_2026-10-15.csv", "CallingStationID;NasIP;NasPortID;B_ReceiptTime;Device ID;IP address\n00:11:22:33:44:51;10.0.0.1;1;15.10.2026 10:00:00;DEV-51;192.168.1.51\n00:11:22:33:44:52;10.0.0.9;2;15.10.2026 10:01:00;DEV-52;192.168.1.52\n00:11:22:33:44:53;10.0.0.1;3;15.10.2026 10:02:00;DEV-53;192.168.1.53\n00:11:22:33:44:54;10.0.0.2;4;15.10.2026 10:03:00;DEV-54;192.168.1.99");
  await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
  let secondFinalReady = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(250);
    const status = await evaluate(`document.querySelector('#databaseStatus').textContent`);
    if (status.includes("2 Final")) { secondFinalReady = true; break; }
    const error = await evaluate(`({visible:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (error.visible) throw new Error(`Second DDIO history Final failed: ${error.message}`);
  }
  if (!secondFinalReady) throw new Error("Второй DDIO Final с изменённым switch IP не завершился за 15 секунд");
  const switchIpReport = await evaluate(`(()=>{const host=document.querySelector('#enrichmentSummary [data-switch-ip-change-container]');const rows=[...(host?.querySelectorAll('tbody tr')||[])].map((row)=>[...row.cells].map((cell)=>cell.textContent.trim()));const headers=[...(host?.querySelectorAll('thead th')||[])].map((cell)=>cell.textContent.trim());return{present:Boolean(host),summary:host?.querySelector('details summary')?.textContent.trim()||'',notice:host?.querySelector('.notice')?.textContent.trim()||'',headers,rows,noDedicatedIpChangesView:!document.querySelector('[data-view="ipchanges"]')}})()`);
  if (!switchIpReport.present || switchIpReport.rows.length !== 1 || switchIpReport.rows[0][1] !== "10.0.0.1" || switchIpReport.rows[0][2] !== "10.0.0.9" || switchIpReport.rows[0][3] !== "192.168.1.52" || switchIpReport.rows[0][4] !== "192.168.9.52" || !switchIpReport.notice.includes("до записи этого Final") || !switchIpReport.noDedicatedIpChangesView) throw new Error(`Historical switch-IP report did not show exactly the confirmed change, device IP and separate DDIO possibility: ${JSON.stringify(switchIpReport)}`);
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  await wait(200);
  await evaluate(`(()=>{Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:undefined});const nativeCreate=URL.createObjectURL.bind(URL);window.__smokeDdioFinalCsv=null;URL.createObjectURL=(blob)=>{window.__smokeDdioFinalCsv=blob;return nativeCreate(blob)};HTMLAnchorElement.prototype.click=function(){}})()`);
  await evaluate(`document.querySelector('#exportFinalCsvButton').click()`);
  let ddioFinalCsv = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(100);
    ddioFinalCsv = await evaluate(`(async()=>{const blob=window.__smokeDdioFinalCsv;return blob?{type:blob.type,text:await blob.text()}:null})()`);
    if (ddioFinalCsv) break;
  }
  if (!ddioFinalCsv?.type.startsWith("text/csv") || !ddioFinalCsv.text.includes("192.168.1.52") || ddioFinalCsv.text.includes("192.168.9.52")) throw new Error(`DDIO auxiliary IP leaked into Final CSV or changed the confirmed device IP: ${JSON.stringify(ddioFinalCsv)}`);
  await evaluate(`document.querySelector('[data-view="history"]').click()`);
  await wait(300);
  await evaluate(`(()=>{const form=document.querySelector('#historyLogFilters');form.elements.namedItem('mac').value='00:11:22:33:44:52';form.requestSubmit()})()`);
  let historyMarker = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(100);
    historyMarker = await evaluate(`(()=>{const marker=document.querySelector('#historyLogResults .ddio-ip-marker');return marker&&{text:marker.textContent.trim(),label:marker.getAttribute('aria-label'),title:marker.getAttribute('title'),row:marker.closest('tr')?.textContent.replace(/\\s+/g,' ').trim()}})()`);
    if (historyMarker) break;
  }
  if (!historyMarker || !historyMarker.label?.includes("возможные IP") || !historyMarker.label?.includes("не изменяет подтверждённый IP устройства") || !historyMarker.row?.includes("10.0.0.1") || !historyMarker.row?.includes("10.0.0.9")) throw new Error(`DDIO possible-IP hint was not attached to the actual switch-IP history change: ${JSON.stringify(historyMarker)}`);
  console.log(JSON.stringify({ initialSwitchIpReport, switchIpReport, ddioHistoryHint: historyMarker, confirmedIpExported: ddioFinalCsv.text.includes("192.168.1.52"), possibleIpExcludedFromExport: !ddioFinalCsv.text.includes("192.168.9.52"), ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
await evaluate(`document.querySelector('#globalSearch').value='001122334499';document.querySelector('#globalSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
await wait(350);
let alternateMacSearch = await readDeviceRows();
if (!alternateMacSearch.some((row) => row.mac?.includes("00:11:22:33:44:54"))) throw new Error(`Глобальный поиск не нормализовал alternate MAC без разделителей: ${JSON.stringify(alternateMacSearch)}`);
await evaluate(`document.querySelector('#globalSearch').value='00-11-22-33-44-99';document.querySelector('#globalSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
await wait(350);
alternateMacSearch = await readDeviceRows();
if (!alternateMacSearch.some((row) => row.mac?.includes("00:11:22:33:44:54"))) throw new Error(`Глобальный поиск не нормализовал alternate MAC с разделителями: ${JSON.stringify(alternateMacSearch)}`);
await evaluate(`document.querySelector('#globalSearch').value='';document.querySelector('#globalSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
const parsedRoomHierarchy = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshotChunks'],'readonly');const activeRequest=tx.objectStore('settings').get('activeSnapshotId');let activeId='';activeRequest.onsuccess=()=>{activeId=activeRequest.result?.value||''};const chunksRequest=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const device=chunksRequest.result.find((chunk)=>chunk.snapshotId===activeId)?.devices.find((item)=>item.mac==='00:11:22:33:44:51');db.close();resolve(device&&{businessUnit:device.businessUnit,city:device.city,site:device.site,floor:device.floor,room:device.room})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
if (parsedRoomHierarchy?.businessUnit !== "ЦА" || parsedRoomHierarchy.city !== "Москва" || parsedRoomHierarchy.site !== "Кутузовский" || parsedRoomHierarchy.floor !== "3" || parsedRoomHierarchy.room !== "Переговорная 1") throw new Error(`Иерархия из полного значения колонки помещения разобралась неверно: ${JSON.stringify(parsedRoomHierarchy)}`);
console.log("browser smoke: compact/separated alternate-MAC search and location hierarchy parsed from the room field");

await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
await wait(1000);
const analytics = await evaluate(`({text:document.querySelector('#analyticsKpis').textContent,overview:document.querySelector('#datasetOverview').textContent,clusters:document.querySelector('#clusterSummary').textContent,topology:document.querySelector('#topologySummary').textContent,rosterHeading:document.querySelector('#changeTable h3')?.textContent||'',rosterRows:document.querySelectorAll('#changeTable tbody tr').length,rosterText:document.querySelector('#changeTable').textContent.replace(/\s+/g,' '),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',loading:!document.querySelector('#analyticsLoadingStatus').hidden})`);
const analyticsText = analytics.text.replace(/\s+/g, " ");
if (analyticsStagesOnly) {
  const initialStage = await evaluate(`(()=>({kpis:document.querySelector('#analyticsKpis').textContent.replace(/\s+/g,' '),loading:!document.querySelector('#analyticsLoadingStatus').hidden,idle:window.__smokeAnalyticsIdleState(),trendCanvas:Boolean(document.querySelector('#totalChart'))}))()`);
  if (analytics.error || !/Устройства\s+4/.test(initialStage.kpis) || !initialStage.loading || !initialStage.trendCanvas || initialStage.idle.pending.length !== 1) throw new Error(`Dashboard pair summary and metadata trend did not render before deferred analytics detail work: ${JSON.stringify({analytics,initialStage})}`);
  const firstPending = initialStage.idle.pending[0];
  await evaluate("document.querySelector('#refreshAnalyticsButton').click()");
  let afterFirstRefresh = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(50);
    afterFirstRefresh = await evaluate("window.__smokeAnalyticsIdleState()");
    if (afterFirstRefresh.pending.length === 1 && afterFirstRefresh.entries.length >= 2) break;
  }
  const secondPending = afterFirstRefresh?.pending?.[0];
  if (!secondPending || secondPending === firstPending || !afterFirstRefresh.entries.find((entry) => entry.id === firstPending)?.canceled) throw new Error(`Refreshing Dashboard did not cancel its superseded idle task: ${JSON.stringify({firstPending,afterFirstRefresh})}`);
  await evaluate("document.querySelector('#refreshAnalyticsButton').click()");
  let afterSecondRefresh = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(50);
    afterSecondRefresh = await evaluate("window.__smokeAnalyticsIdleState()");
    if (afterSecondRefresh.pending.length === 1 && afterSecondRefresh.entries.length >= 3) break;
  }
  const latestPending = afterSecondRefresh?.pending?.[0];
  if (!latestPending || latestPending === secondPending || !afterSecondRefresh.entries.find((entry) => entry.id === secondPending)?.canceled || !afterSecondRefresh.entries.find((entry) => entry.id === latestPending)?.options?.timeout) throw new Error(`Repeated Dashboard refresh did not retain exactly the newest timed idle task: ${JSON.stringify({secondPending,afterSecondRefresh})}`);
  await evaluate(`window.__smokeRunAnalyticsIdle(${latestPending})`);
  let completedStage = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    completedStage = await evaluate(`(()=>({loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',overview:document.querySelector('#datasetOverview').textContent,clusters:document.querySelector('#clusterSummary').textContent,idle:window.__smokeAnalyticsIdleState()}))()`);
    if (!completedStage.loading && completedStage.overview.includes("Устройств") && completedStage.clusters.includes("устройств")) break;
  }
  if (completedStage?.loading || completedStage?.error || !completedStage?.overview.includes("Устройств") || !completedStage?.clusters.includes("устройств") || completedStage.idle.entries.filter((entry) => entry.ran).map((entry) => entry.id).join(",") !== String(latestPending)) throw new Error(`Latest idle analytics details did not finish exclusively after the pair summary: ${JSON.stringify({initialStage,afterFirstRefresh,afterSecondRefresh,completedStage})}`);
  await evaluate(`window.__smokeSnapshotChunkReads=0;const button=document.querySelector('#refreshTemporalButton');button.click();button.click()`);
  let temporalDuplicateResult = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    temporalDuplicateResult = await evaluate(`(()=>({reads:window.__smokeSnapshotChunkReads,summary:document.querySelector('#temporalSummary').textContent.replace(/\s+/g,' '),table:document.querySelector('#temporalTable').textContent.replace(/\s+/g,' '),loading:document.querySelector('#temporalTable').textContent.includes('Пересчёт статистики')}))()`);
    if (!temporalDuplicateResult.loading && temporalDuplicateResult.summary) break;
  }
  if (temporalDuplicateResult?.loading || !temporalDuplicateResult?.summary || temporalDuplicateResult.reads !== 1) throw new Error(`Two identical temporal refresh clicks did not share one in-flight Final scan: ${JSON.stringify(temporalDuplicateResult)}`);
  console.log(JSON.stringify({analyticsStagesOnly:true,initialStage,firstPending,secondPending,latestPending,completedStage,temporalDuplicateResult,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
if (analytics.error || !/Устройства\s+4/.test(analyticsText) || !/Разные IP коммутатора NEW\s+1/.test(analyticsText)) {
  throw new Error(`Некорректная аналитика: ${JSON.stringify(analytics)}`);
}
if (!analytics.overview.includes("Устройств") || !analytics.clusters.includes("устройств") || !analytics.topology.includes("устройств")) {
  throw new Error(`Полные сводки аналитики не отображаются: ${JSON.stringify(analytics)}`);
}
if (analytics.rosterHeading !== "Все устройства" || analytics.rosterRows !== 4 || !analytics.rosterText.includes("Устройств: 4")) throw new Error(`Общий Dashboard roster не показывает весь текущий Final: ${JSON.stringify(analytics)}`);
console.log("browser smoke: all-device Dashboard roster shows every row and the exact total");
if (process.argv.includes("--inventory-export-only")) {
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  await wait(200);
  await evaluate(`(()=>{Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:undefined});const create=URL.createObjectURL.bind(URL);window.__smokeInventoryExport={blob:null,name:'',created:[],clicked:[]};URL.createObjectURL=(blob)=>{window.__smokeInventoryExport.created.push({type:blob.type,size:blob.size});window.__smokeInventoryExport.blob=blob;return create(blob)};const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.__smokeInventoryExport.clicked.push(this.download);if(this.download.startsWith('mac-analyzer-inventory-'))window.__smokeInventoryExport.name=this.download;return click.call(this)};return{savePicker:typeof globalThis.showSaveFilePicker,configured:true}})()`);
  await evaluate(`document.querySelector('#exportInventoryXlsxButton')?.click()`);
  let inventoryExport = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    inventoryExport = await evaluate(`(async()=>{const status=document.querySelector('#inventoryExportStatus')?.textContent||'';const item=window.__smokeInventoryExport;const error=document.querySelector('#errorBanner span')?.textContent||'';if(!item?.blob||!item.name)return{status,error,savePicker:typeof globalThis.showSaveFilePicker,created:item?.created||[],clicked:item?.clicked||[]};const bytes=new Uint8Array(await item.blob.slice(0,4).arrayBuffer());return{status,error,name:item.name,size:item.blob.size,signature:[...bytes],created:item.created,clicked:item.clicked}})()`);
    if (inventoryExport.name && inventoryExport.status.includes('Экспортировано устройств:')) break;
  }
  const inventoryCount = await evaluate(`new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('inventory','readonly');const count=tx.objectStore('inventory').count();tx.oncomplete=()=>{db.close();resolve(count.result)};tx.onerror=()=>{db.close();reject(tx.error)}}})`);
  const exportedCount = Number(inventoryExport?.status.match(/Экспортировано устройств:\s*([\d\s\u00a0]+)/)?.[1].replace(/\D/g,''));
  if (!inventoryExport?.name || !inventoryExport.name.endsWith('.xlsx') || inventoryExport.size < 4
    || inventoryExport.signature[0] !== 80 || inventoryExport.signature[1] !== 75
    || !Number.isFinite(exportedCount) || exportedCount !== inventoryCount || exportedCount !== 4) {
    throw new Error(`Inventory XLSX UI export did not include the exact full browser catalog: ${JSON.stringify({ inventoryExport, inventoryCount, exportedCount, runtimeDiagnostics })}`);
  }
  console.log(JSON.stringify({ inventoryExportOnly: true, filename: inventoryExport.name, bytes: inventoryExport.size, exportedCount, indexedDbInventoryCount: inventoryCount, xlsxZip: inventoryExport.signature.slice(0, 4), ok: true }));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
if (process.argv.includes("--workspace-state-persistence-only")) {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const serial = String(index + 1).padStart(3, "0");
    const mac = `02:00:00:00:10:${(index + 1).toString(16).padStart(2, "0")}`;
    return `${mac};WS-DEVICE-${serial};Workspace Smoke Vendor;Workspace Smoke Model`;
  });
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await assignInput("#mainFileInput", "workspace-state-60.csv", `MAC;Device ID;Производитель;Модель\n${rows.join("\n")}`);
  for (const [field, index] of [["mac", 0], ["deviceId", 1], ["manufacturer", 2], ["model", 3]]) {
    const selected = await evaluate(`(()=>{const input=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!input)throw new Error('Missing workspace-state mapping ${field}');input.value=${index};input.dispatchEvent(new Event('change',{bubbles:true}));return input.value})()`);
    if (selected !== String(index)) throw new Error(`Workspace-state ${field} mapping did not apply`);
  }
  await evaluate(`window.confirm=()=>true;document.querySelector('#runEnrichmentButton').click()`);
  let imported = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(100);
    imported = await evaluate(`(()=>({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (imported.error) throw new Error(`Workspace-state Final import failed: ${imported.message}`);
    if (imported.status.includes("64 устройств")) break;
  }
  if (!imported?.status.includes("64 устройств")) throw new Error(`Workspace-state fixture did not create the expected 64-device active Final: ${JSON.stringify(imported)}`);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let dashboardReady = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(100);
    dashboardReady = await evaluate(`(()=>({loading:!document.querySelector('#analyticsLoadingStatus')?.hidden,report:document.querySelector('#analyticsReportPreview')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (dashboardReady.error) throw new Error(`Workspace-state Dashboard cache could not be prepared: ${dashboardReady.message}`);
    if (!dashboardReady.loading && dashboardReady.report.includes("Всего устройств")) break;
  }
  if (dashboardReady?.loading || !dashboardReady?.report.includes("Всего устройств")) throw new Error(`Workspace-state Dashboard was not ready: ${JSON.stringify(dashboardReady)}`);
  await evaluate(`document.querySelector('[data-view="search"]').click()`);
  await evaluate(`(()=>{const input=document.querySelector('#globalSearch');input.value='WS-DEVICE-';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  let searchReady = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    searchReady = await evaluate(`(()=>({count:document.querySelector('#searchCount')?.textContent||'',page:document.querySelector('#pageLabel')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (searchReady.error) throw new Error(`Workspace-state inventory search failed: ${searchReady.message}`);
    if (searchReady.count.includes("60 устройств")) break;
  }
  if (!searchReady?.count.includes("60 устройств")) throw new Error(`Workspace-state inventory search did not find 60 synthetic records: ${JSON.stringify(searchReady)}`);
  await evaluate(`(()=>{const select=document.querySelector('#pageSizeSelect');select.value='50';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await wait(100);
  await evaluate(`document.querySelector('#deviceTable [data-sort="mac"]')?.click()`);
  await wait(100);
  await evaluate(`document.querySelector('#nextPageButton').click()`);
  let savedView = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    savedView = await evaluate(`(()=>({view:location.hash,searchView:Boolean(document.querySelector('#searchView')),active:document.querySelector('#searchView')?.classList.contains('active'),count:document.querySelector('#searchCount')?.textContent||'',page:document.querySelector('#pageLabel')?.textContent||'',size:document.querySelector('#pageSizeSelect')?.value||'',search:document.querySelector('#globalSearch')?.value||'',sort:document.querySelector('#deviceTable [data-sort="mac"]')?.textContent||'',error:!document.querySelector('#errorBanner')?.hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (savedView.error) throw new Error(`Workspace-state UI setup failed: ${savedView.message}`);
    if (savedView.page.includes("Страница 2 из 2") && savedView.sort.includes("↓")) break;
  }
  if (!savedView?.page.includes("Страница 2 из 2") || savedView.size !== "50" || savedView.search !== "WS-DEVICE-" || !savedView.sort.includes("↓")) {
    throw new Error(`Workspace-state UI did not reach the expected second sorted page: ${JSON.stringify(savedView)}`);
  }
  await wait(500);
  const checkpoint = await evaluate(`new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','analyticsCache'],'readonly');const setting=tx.objectStore('settings').get('workspaceState');const cache=tx.objectStore('analyticsCache').count();tx.oncomplete=()=>{db.close();resolve({state:setting.result?.value||null,analyticsCacheCount:cache.result})};tx.onerror=()=>{db.close();reject(tx.error)}}})`);
  const expectedKeys = ["page", "pageSize", "search", "sort", "version", "view"];
  const actualKeys = Object.keys(checkpoint.state || {}).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) || checkpoint.state?.view !== "search" || checkpoint.state?.search !== "WS-DEVICE-"
    || checkpoint.state?.page !== 2 || checkpoint.state?.pageSize !== 50 || checkpoint.state?.sort?.field !== "mac" || checkpoint.state?.sort?.direction !== -1
    || !checkpoint.analyticsCacheCount || JSON.stringify(checkpoint.state).length > 1_000) {
    throw new Error(`Workspace checkpoint duplicated domain/cache data or lost bounded UI state: ${JSON.stringify({checkpoint,actualKeys})}`);
  }
  const restored = await reloadDatabaseAndWait(new URL(target.url).searchParams.get("db"));
  let reopened = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    reopened = await evaluate(`(()=>({active:document.querySelector('#searchView')?.classList.contains('active'),view:location.hash.slice(1),search:document.querySelector('#globalSearch')?.value||'',size:document.querySelector('#pageSizeSelect')?.value||'',page:document.querySelector('#pageLabel')?.textContent||'',sort:document.querySelector('#deviceTable [data-sort="mac"]')?.textContent||'',rows:document.querySelector('#deviceTable')?.innerText||'',status:document.querySelector('#workspaceStateStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (reopened.error) throw new Error(`Workspace state did not survive reload: ${reopened.message}`);
    if (reopened.active && reopened.page.includes("Страница 2 из 2") && reopened.search === "WS-DEVICE-") break;
  }
  if (restored.error || !reopened?.active || reopened.view !== "search" || reopened.search !== "WS-DEVICE-" || reopened.size !== "50"
    || !reopened.page.includes("Страница 2 из 2") || !reopened.sort.includes("↓") || !reopened.rows.includes("02:00:00:00:10:01")) {
    throw new Error(`Workspace state did not restore the view, query, page, page size and sort after reload: ${JSON.stringify({restored,reopened})}`);
  }
  await evaluate(`document.querySelector("#engineeringModeButton").click()`);
  await evaluate(`(()=>{const input=document.querySelector("#engineeringPassword");input.value=${JSON.stringify(smokeEngineerPassword)};input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#engineeringModeForm").requestSubmit()})()`);
  let engineerRestored = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    engineerRestored = await evaluate(`document.querySelector("#engineeringModeButton")?.textContent.includes("Инженер")`);
    if (engineerRestored) break;
  }
  if (!engineerRestored) throw new Error("Workspace-state cleanup could not reauthenticate the disposable engineer session after reload");
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  let dataReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(50);
    dataReady = await evaluate(`document.querySelector("#dataView")?.classList.contains("active") && Boolean(document.querySelector("#deleteWorkspaceStateButton"))`);
    if (dataReady) break;
  }
  if (!dataReady) throw new Error("Workspace-state cleanup could not open the Data view after engineer reauthentication");
  await evaluate(`document.querySelector('#deleteWorkspaceStateButton').click()`);
  let deleted = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait(50);
    deleted = await evaluate(`new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('settings','readonly');const request=tx.objectStore('settings').get('workspaceState');tx.oncomplete=()=>{db.close();resolve(request.result||null)};tx.onerror=()=>{db.close();reject(tx.error)}}})`);
    if (!deleted) break;
  }
  if (deleted) throw new Error(`Workspace checkpoint delete left a saved record: ${JSON.stringify(deleted)}`);
  console.log(JSON.stringify({workspaceStatePersistenceOnly:true,devices:60,checkpoint:checkpoint.state,analyticsCacheCount:checkpoint.analyticsCacheCount,reopened:{view:reopened.view,search:reopened.search,page:reopened.page,pageSize:reopened.size,sort:reopened.sort},deleteCheckpoint:true,ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--workspace-batch-directory-restart-only")) {
  await command("Page.enable");
  const directoryShim = `(()=>{const nativeDirectory=FileSystemDirectoryHandle.prototype.getDirectoryHandle;const nativeFile=FileSystemDirectoryHandle.prototype.getFileHandle;const createFile=async(directory,name,content)=>{const handle=await directory.getFileHandle(name,{create:true});if((await handle.getFile()).size===0){const writer=await handle.createWritable();await writer.write(content);await writer.close()}return handle};globalThis.__batchDirectoryReady=false;(async()=>{const root=await navigator.storage.getDirectory();const directory=await rootDirectory(root);const nested=await nativeDirectory.call(directory,"nested",{create:true});await createFile(directory,"main_2026-11-07.csv","MAC;Device ID\\n02:64:00:00:01:01;BATCH-HANDLE-ROOT\\n");await createFile(nested,"main_2026-11-07-nested.csv","MAC;Device ID\\n02:64:00:00:01:02;BATCH-HANDLE-NESTED\\n");await createFile(directory,"ignored.pdf","not a table");globalThis.showDirectoryPicker=async()=>directory;Object.defineProperty(FileSystemDirectoryHandle.prototype,"queryPermission",{configurable:true,value:async()=>"granted"});Object.defineProperty(FileSystemDirectoryHandle.prototype,"requestPermission",{configurable:true,value:async()=>"granted"});globalThis.__batchDirectoryReady=true;function rootDirectory(storage){return nativeDirectory.call(storage,"batch-main-recovery",{create:true})}})().catch(error=>globalThis.__batchDirectoryError=error.message)})();`;
  await command("Page.addScriptToEvaluateOnNewDocument", { source: directoryShim });
  await evaluate(directoryShim);
  let shim = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    shim = await evaluate(`({ready:Boolean(window.__batchDirectoryReady),error:window.__batchDirectoryError||""})`);
    if (shim.ready || shim.error) break;
  }
  if (!shim.ready) throw new Error(`Could not seed the disposable OPFS batch directory: ${shim.error}`);
  await evaluate(`document.querySelector('[data-view="batch"]').click()`);
  let batchMounted = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(50);
    batchMounted = await evaluate(`document.querySelector('#batchView')?.classList.contains('active') && !document.querySelector('[data-batch-directory-handle="main"]')?.hidden`);
    if (batchMounted) break;
  }
  if (!batchMounted) throw new Error("Batch directory persistence control did not mount in the secure localhost browser context");
  await evaluate(`document.querySelector('[data-batch-directory-handle="main"]').click()`);
  let selected = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(50);
    selected = await evaluate(`(()=>({status:document.querySelector('#batchMainDirectoryStatus')?.textContent||'',files:document.querySelector('#batchMainFiles')?.innerText||'',count:document.querySelector('#batchMainStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (selected.error) throw new Error(`Selecting a batch directory failed: ${selected.message}`);
    if (selected.files.includes("main_2026-11-07-nested.csv")) break;
  }
  if (!selected?.status.includes("Доступ к папке") || !selected.status.includes("2 файлов") || !selected.files.includes("batch-main-recovery/main_2026-11-07.csv") || !selected.files.includes("batch-main-recovery/nested/main_2026-11-07-nested.csv") || selected.files.includes("ignored.pdf")) {
    throw new Error(`The selected batch directory did not expose the exact supported relative file roster: ${JSON.stringify(selected)}`);
  }
  const saved = await evaluate(`new Promise((resolve,reject)=>{const name=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('fileHandles','readonly');const request=tx.objectStore('fileHandles').get('workspace-batch-directory:main');tx.oncomplete=()=>{db.close();resolve(request.result||null)};tx.onerror=()=>{db.close();reject(tx.error)}}})`);
  if (saved?.role !== "main" || saved?.name !== "batch-main-recovery" || saved?.key !== "workspace-batch-directory:main" || Object.hasOwn(saved, "path")) {
    throw new Error(`The saved batch directory record did not retain only its local handle metadata: ${JSON.stringify(saved)}`);
  }
  const databaseName = new URL(target.url).searchParams.get("db");
  const reload = await reloadDatabaseAndWait(databaseName);
  let beforeLogin = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(50);
    beforeLogin = await evaluate(`(()=>({status:document.querySelector('#batchMainDirectoryStatus')?.textContent||'',fileCount:document.querySelector('#batchMainStatus')?.textContent||'',files:document.querySelector('#batchMainFiles')?.innerText||'',error:!document.querySelector('#errorBanner').hidden}))()`);
    if (beforeLogin.files || beforeLogin.error) break;
  }
  if (reload.error || beforeLogin.error || beforeLogin.files || beforeLogin.fileCount.includes("2 файлов")) {
    throw new Error(`The saved folder should be recognized after reload but not enumerated before engineer authentication: ${JSON.stringify({reload,beforeLogin})}`);
  }
  await evaluate(`document.querySelector('#engineeringModeButton').click()`);
  await evaluate(`(()=>{const input=document.querySelector('#engineeringPassword');input.value=${JSON.stringify(smokeEngineerPassword)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#engineeringModeForm').requestSubmit()})()`);
  let engineerRestored = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    engineerRestored = await evaluate(`document.querySelector('#engineeringModeButton')?.textContent.includes("Инженер")`);
    if (engineerRestored) break;
  }
  if (!engineerRestored) throw new Error("Could not re-authenticate before restoring the batch directory");
  await evaluate(`document.querySelector('[data-view="batch"]').click()`);
  await evaluate(`document.querySelector('[data-batch-directory-handle="main"]').click()`);
  let restored = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(50);
    restored = await evaluate(`(()=>({status:document.querySelector('#batchMainDirectoryStatus')?.textContent||'',files:document.querySelector('#batchMainFiles')?.innerText||'',count:document.querySelector('#batchMainStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (restored.error) throw new Error(`Restoring the saved batch directory failed: ${restored.message}`);
    if (restored.status.includes("Восстановлена папка") && restored.files.includes("main_2026-11-07-nested.csv")) break;
  }
  if (!restored?.status.includes("Восстановлена папка batch-main-recovery: 2 файлов") || !restored.count.includes("2 файлов") || !restored.files.includes("batch-main-recovery/main_2026-11-07.csv") || !restored.files.includes("batch-main-recovery/nested/main_2026-11-07-nested.csv") || restored.files.includes("ignored.pdf")) {
    throw new Error(`The batch directory did not restore the exact nested file list after reload and authentication: ${JSON.stringify(restored)}`);
  }
  console.log(JSON.stringify({workspaceBatchDirectoryRestartOnly:true,selected:{status:selected.status,count:selected.count},savedMetadata:{role:saved.role,name:saved.name,key:saved.key},beforeLogin,restored:{status:restored.status,count:restored.count,files:restored.files},ok:true}));
  await command("Browser.close");
  socket.close();
  process.exit(0);
}

if (process.argv.includes("--optional-host-transfer-only")) {
  await evaluate(`document.querySelector('[data-view="data"]')?.click()`);
  await wait(300);
  const controls = await evaluate(`(()=>({inventory:document.querySelector('#optionalHostInventoryUploadButton'),snapshot:document.querySelector('#optionalHostSnapshotUploadButton')}))()`);
  if (!controls.inventory || !controls.snapshot || controls.inventory.disabled || controls.snapshot.disabled) throw new Error(`Final/Inventory transfer controls are not enabled after the imported run: ${JSON.stringify({inventory:controls.inventory?.disabled,snapshot:controls.snapshot?.disabled})}`);
  await evaluate(`document.querySelector('#optionalHostInventoryUploadButton').click()`);
  let inventoryStatus = "";
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await wait(100);
    inventoryStatus = await evaluate(`document.querySelector('#optionalHostInventoryUploadStatus')?.textContent||''`);
    if (inventoryStatus.includes("Inventory скопирован:")) break;
  }
  if (!inventoryStatus.includes("Inventory скопирован:") || !inventoryStatus.includes("конфликтов идентичности 0")) throw new Error(`Inventory transfer UI did not finish cleanly: ${inventoryStatus}`);
  await evaluate(`(()=>{const original=window.fetch.bind(window);window.__smokeSnapshotFetchError='';window.fetch=(input,init)=>{const url=typeof input==='string'?input:input?.url||'';const result=original(input,init);if(url.includes('/api/snapshots/'))result.catch(error=>{window.__smokeSnapshotFetchError=String(error?.stack||error)});return result};return true})()`);
  await command("Network.enable");
  await evaluate(`document.querySelector('#optionalHostSnapshotUploadButton').click()`);
  let snapshotStatus = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    snapshotStatus = await evaluate(`document.querySelector('#optionalHostSnapshotUploadStatus')?.textContent||''`);
    if (snapshotStatus.includes("SHA-256")) break;
  }
  if (!snapshotStatus.includes("SHA-256") || !snapshotStatus.includes("History:")) {
    const fetchError = await evaluate("window.__smokeSnapshotFetchError||''");
    throw new Error(`Final/History transfer UI did not finish cleanly: ${snapshotStatus}; fetch=${fetchError}; network=${JSON.stringify(networkFailures)}`);
  }
  await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
  await assignInput("#mainFileInput", "optional-host-second-final.csv", "MAC;Device ID;Производитель;Модель;Помещение;Hostname;Серийный номер;Название устройства\n00:33:44:55:66:99;HOST-DELETE-99;Loopback Host Vendor;Host Delete Model;Host Delete Room;host-parity-99;HOST-SERIAL-99;Host Device Name 99");
  for (const [field,index] of [["mac",0],["deviceId",1],["manufacturer",2],["model",3],["room",4],["hostname",5],["serial",6],["deviceName",7]]) {
    const selected = await evaluate(`(()=>{const input=document.querySelector('[data-mapping-role="main"][data-mapping-field="${field}"]');if(!input)throw new Error('Missing optional-host Main mapping ${field}');input.value=${index};input.dispatchEvent(new Event('change',{bubbles:true}));return input.value})()`);
    if (selected !== String(index)) throw new Error(`Optional-host second Final mapping ${field} did not apply`);
  }
  await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
  let secondFinalStatus = "";
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await wait(100);
    const current = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (current.error) throw new Error(`Second optional-host Final failed: ${current.message}`);
    secondFinalStatus = current.status;
    if (secondFinalStatus.includes("2 Final")) break;
  }
  if (!secondFinalStatus.includes("2 Final")) throw new Error(`Second optional-host Final did not persist: ${secondFinalStatus}`);
  await evaluate(`document.querySelector('[data-view="data"]').click()`);
  await wait(150);
  if (await evaluate(`document.querySelector('#optionalHostSnapshotUploadButton').disabled`)) throw new Error("Second active Final transfer button is disabled");
  await evaluate(`document.querySelector('#optionalHostSnapshotUploadButton').click()`);
  let secondSnapshotStatus = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await wait(100);
    secondSnapshotStatus = await evaluate(`document.querySelector('#optionalHostSnapshotUploadStatus')?.textContent||''`);
    if (secondSnapshotStatus.includes("SHA-256")) break;
  }
  if (!secondSnapshotStatus.includes("SHA-256") || !secondSnapshotStatus.includes("History:")) throw new Error(`Second host Final transfer did not finish: ${secondSnapshotStatus}`);
  await evaluate(`document.querySelector('#optionalHostInventoryUploadButton').click()`);
  let enrichedInventoryStatus = "";
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await wait(100);
    enrichedInventoryStatus = await evaluate(`document.querySelector('#optionalHostInventoryUploadStatus')?.textContent||''`);
    if (enrichedInventoryStatus.includes("Inventory скопирован:")) break;
  }
  if (!enrichedInventoryStatus.includes("Inventory скопирован:") || !enrichedInventoryStatus.includes("конфликтов идентичности 0")) throw new Error(`Enriched Inventory transfer failed: ${enrichedInventoryStatus}`);
  await evaluate(`(()=>{const form=document.querySelector('#optionalHostDatabaseSearchForm');form.querySelector('[name="query"]').value='HOST-SERIAL-99';form.requestSubmit();return true})()`);
  let enrichedSearch = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    enrichedSearch = await evaluate(`(()=>({status:document.querySelector('#optionalHostDatabaseSearchStatus')?.textContent||'',rows:document.querySelector('#optionalHostDatabaseSearchResults')?.innerText||''}))()`);
    if (enrichedSearch.status.includes("Показано строк:") && enrichedSearch.rows.includes("HOST-SERIAL-99")) break;
  }
  if (!enrichedSearch?.rows.includes("HOST-SERIAL-99") || !enrichedSearch.rows.includes("host-parity-99") || !enrichedSearch.rows.includes("Host Device Name 99") || !enrichedSearch.rows.includes("Main")
    || !enrichedSearch.rows.includes("Loopback Host Vendor") || !enrichedSearch.rows.includes("Host Delete Model") || !enrichedSearch.rows.includes("HOST-DELETE-99")) {
    throw new Error(`Optional-host full Inventory search omitted source fields: ${JSON.stringify({enrichedInventoryStatus,enrichedSearch})}`);
  }
  const beforeRepeatInventory = await evaluate(`fetch('/api/database/summary',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json())`);
  await evaluate(`document.querySelector('#optionalHostInventoryUploadButton').click()`);
  let repeatedInventoryStatus = "";
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await wait(100);
    repeatedInventoryStatus = await evaluate(`document.querySelector('#optionalHostInventoryUploadStatus')?.textContent||''`);
    if (repeatedInventoryStatus.includes("Inventory скопирован:")) break;
  }
  const afterRepeatInventory = await evaluate(`fetch('/api/database/summary',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json())`);
  const inventoryCountBeforeRepeat = Number(beforeRepeatInventory.counts?.resolved_device_inventory ?? beforeRepeatInventory.counts?.device_inventory);
  const inventoryCountAfterRepeat = Number(afterRepeatInventory.counts?.resolved_device_inventory ?? afterRepeatInventory.counts?.device_inventory);
  if (!repeatedInventoryStatus.includes("конфликтов идентичности 0") || inventoryCountBeforeRepeat < 5 || inventoryCountAfterRepeat !== inventoryCountBeforeRepeat) {
    throw new Error(`Repeated Inventory transfer changed host identities or introduced conflicts: ${JSON.stringify({repeatedInventoryStatus,inventoryCountBeforeRepeat,inventoryCountAfterRepeat})}`);
  }
  const hostCounts = await evaluate(`fetch('/api/database/summary',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json())`);
  if (Number(hostCounts.counts?.resolved_device_inventory ?? hostCounts.counts?.device_inventory) < 4 || Number(hostCounts.counts?.snapshots) < 2) throw new Error(`Optional host summary does not include the UI transfer: ${JSON.stringify(hostCounts)}`);
  const restoreFixture = await evaluate(`(async()=>{const response=await fetch('/api/database/export',{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new Error('SQLite export fixture failed: HTTP '+response.status);const blob=await response.blob();const transfer=new DataTransfer();transfer.items.add(new File([blob],'optional-host-roundtrip.db',{type:'application/vnd.sqlite3'}));const input=document.querySelector('#optionalHostDatabaseRestoreInput');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return{bytes:blob.size,type:blob.type}})()`);
  let restoreStatus = "";
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await wait(100);
    restoreStatus = await evaluate(`document.querySelector('#optionalHostDatabaseRestoreStatus')?.textContent||''`);
    if (restoreStatus.includes("Целостная SQLite-копия сохранена отдельно")) break;
  }
  if (!restoreFixture.bytes || !restoreFixture.type.includes("sqlite") || !restoreStatus.includes("Целостная SQLite-копия сохранена отдельно")) throw new Error(`SQLite restore UI did not complete: ${JSON.stringify({restoreFixture,restoreStatus})}`);
  await evaluate(`document.querySelector('#loadOptionalHostSnapshotsButton').click()`);
  let hostSnapshotRows = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    hostSnapshotRows = await evaluate(`({status:document.querySelector('#optionalHostSnapshotsStatus')?.textContent||'',rows:document.querySelectorAll('#optionalHostSnapshotsList tbody tr [data-optional-host-snapshot-select]').length})`);
    if (hostSnapshotRows.rows >= 1) break;
  }
  if (hostSnapshotRows.rows !== 2 || !hostSnapshotRows.status.includes('Всего 2 копий')) throw new Error(`Optional-host snapshot UI did not list both transferred Finals: ${JSON.stringify(hostSnapshotRows)}`);
  await evaluate(`(()=>{const checkbox=document.querySelector('#optionalHostSnapshotsList [data-optional-host-snapshot-select-page]');checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const hostDeleteControl = await evaluate(`({disabled:document.querySelector('#optionalHostSnapshotsList [data-optional-host-snapshot-delete-selected]')?.disabled,text:document.querySelector('#optionalHostSnapshotsList [data-optional-host-snapshot-delete-selected]')?.textContent||''})`);
  if (hostDeleteControl.disabled || !hostDeleteControl.text.includes('(2)')) throw new Error(`Selecting both transferred host Finals did not enable multi-delete: ${JSON.stringify(hostDeleteControl)}`);
  await evaluate(`window.confirm=()=>true;document.querySelector('#optionalHostSnapshotsList [data-optional-host-snapshot-delete-selected]').click()`);
  let hostDeleteStatus = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    hostDeleteStatus = await evaluate(`document.querySelector('#optionalHostSnapshotsStatus')?.textContent||''`);
    if (hostDeleteStatus.includes('Удалены 2 отмеченных Final')) break;
  }
  const hostAfterDelete = await evaluate(`fetch('/api/database/summary',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json())`);
  if (!hostDeleteStatus.includes('Удалены 2 отмеченных Final')
    || Number(hostAfterDelete.counts?.resolved_device_inventory ?? hostAfterDelete.counts?.device_inventory) < 4
    || Number(hostAfterDelete.counts?.snapshots) !== 0) {
    throw new Error(`Optional-host selected Final delete did not preserve Inventory and clear the transferred copy: ${JSON.stringify({hostDeleteStatus,hostAfterDelete})}`);
  }
  console.log("browser smoke: UI copied two Finals with linked History, searched SQLite Inventory by serial and verified hostname/device name/vendor/model, repeated transfer without duplicate identities, restored a SQLite backup, then multi-deleted both host Finals and preserved Inventory");
  process.exit(0);
}
if (process.argv.includes("--dashboard-cache-reload-only")) {
  let cachedReport = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    cachedReport = await evaluate(`new Promise((resolve,reject)=>{const opening=indexedDB.open(new URL(location.href).searchParams.get('db'));opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('analyticsCache','readonly');const request=tx.objectStore('analyticsCache').openCursor();let found=null;request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;const value=cursor.value.value;if(cursor.value.key.startsWith('selected-final-dataset-v7:')&&value?.dataset?.reportText){found={key:cursor.value.key,reportText:value.dataset.reportText,devices:value.dataset.summary?.devices};return}cursor.continue()};tx.oncomplete=()=>{db.close();resolve(found)};tx.onerror=()=>{db.close();reject(tx.error)}}})`);
    if (cachedReport) break;
    await wait(100);
  }
  if (!cachedReport || cachedReport.devices !== 4 || !cachedReport.reportText.includes("Всего устройств: 4")) throw new Error(`A complete signed dashboard cache with its report was not persisted: ${JSON.stringify(cachedReport)}`);
  await command("Page.reload", { ignoreCache: true });
  const restored = await reloadDatabaseAndWait(new URL(target.url).searchParams.get("db"));
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let restoredDashboard = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    restoredDashboard = await evaluate(`(()=>({loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',kpis:document.querySelector('#analyticsKpis').textContent.replace(/\\s+/g,' '),overview:document.querySelector('#datasetOverview').textContent.replace(/\\s+/g,' '),report:document.querySelector('#analyticsReportPreview').textContent}))()`);
    if (!restoredDashboard.loading && restoredDashboard.report.includes("Всего устройств: 4")) break;
  }
  if (restored.error || restoredDashboard?.error || restoredDashboard?.loading || !/Устройства\s+4/.test(restoredDashboard?.kpis || "") || !restoredDashboard?.overview.includes("Устройств") || !restoredDashboard?.report.includes("Всего устройств: 4")) {
    throw new Error(`The complete cached dashboard/report did not recover after reopening the same IndexedDB: ${JSON.stringify({restored,restoredDashboard,cachedReport:cachedReport.key})}`);
  }
  console.log("browser smoke: complete dashboard aggregates and text report are restored from the signed IndexedDB cache after browser restart");
  await command("Browser.close");
  socket.close();
  process.exit(0);
}
await evaluate(`(()=>{document.querySelector('#analyticsDashboardSearch').value='DEV-51';document.querySelector('#applyAnalyticsDashboardFiltersButton').click();return true})()`);
let filteredAnalytics = null;
for (let attempt = 0; attempt < 300; attempt += 1) {
  await wait(100);
  filteredAnalytics = await evaluate(`(()=>({kpis:[...document.querySelectorAll('#analyticsKpis .kpi')].map((node)=>node.textContent.replace(/\\s+/g,' ')),loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
  if (!filteredAnalytics.loading && !filteredAnalytics.error && filteredAnalytics.kpis.some((row)=>row.replaceAll(" ", "").includes("Устройства1"))) break;
}
if (filteredAnalytics?.error || filteredAnalytics?.loading || !filteredAnalytics?.kpis.some((row)=>row.replaceAll(" ", "").includes("Устройства1"))) throw new Error(`Поиск DEV-51 не пересчитал KPI Dashboard по одной записи: ${JSON.stringify(filteredAnalytics)}`);
const selectedManufacturer = await evaluate(`document.querySelector('#analyticsDashboardManufacturer').options[1]?.value||''`);
if (!selectedManufacturer) throw new Error("Dashboard не создал варианты производителя из выбранного Final");
await evaluate(`(()=>{document.querySelector('#analyticsDashboardSearch').value='';document.querySelector('#analyticsDashboardManufacturer').value=${JSON.stringify(selectedManufacturer)};document.querySelector('#applyAnalyticsDashboardFiltersButton').click();return true})()`);
let manufacturerAnalytics = null;
for (let attempt = 0; attempt < 300; attempt += 1) {
  await wait(100);
  manufacturerAnalytics = await evaluate(`(()=>({kpis:[...document.querySelectorAll('#analyticsKpis .kpi')].map((node)=>node.textContent.replace(/\\s+/g,' ')),loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
  if (!manufacturerAnalytics.loading && !manufacturerAnalytics.error) break;
}
if (manufacturerAnalytics?.error || manufacturerAnalytics?.loading || !manufacturerAnalytics?.kpis.some((row)=>[1,2,3,4].some((count)=>row.replaceAll(" ","").includes(`Устройства${count}`)))) throw new Error(`Фильтр производителя не оставил совпадающие строки: ${JSON.stringify(manufacturerAnalytics)}`);
const selectedRoom = await evaluate(`document.querySelector('#analyticsDashboardRoom').options[1]?.value||''`);
if (!selectedRoom) throw new Error("Dashboard не создал варианты помещения из выбранного Final");
await evaluate(`(()=>{document.querySelector('#analyticsDashboardManufacturer').value='';document.querySelector('#analyticsDashboardRoom').value=${JSON.stringify(selectedRoom)};document.querySelector('#applyAnalyticsDashboardFiltersButton').click();return true})()`);
let roomAnalytics = null;
for (let attempt = 0; attempt < 300; attempt += 1) {
  await wait(100);
  roomAnalytics = await evaluate(`(()=>({kpis:[...document.querySelectorAll('#analyticsKpis .kpi')].map((node)=>node.textContent.replace(/\\s+/g,' ')),loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
  if (!roomAnalytics.loading && !roomAnalytics.error) break;
}
if (roomAnalytics?.error || roomAnalytics?.loading || !roomAnalytics?.kpis.some((row)=>[1,2,3,4].some((count)=>row.replaceAll(" ","").includes(`Устройства${count}`)))) throw new Error(`Фильтр помещения не оставил совпадающие строки: ${JSON.stringify(roomAnalytics)}`);
await evaluate(`document.querySelector('#resetAnalyticsDashboardFiltersButton').click()`);
let resetAnalytics = null;
for (let attempt = 0; attempt < 300; attempt += 1) {
  await wait(100);
  resetAnalytics = await evaluate(`(()=>({kpis:[...document.querySelectorAll('#analyticsKpis .kpi')].map((node)=>node.textContent.replace(/\\s+/g,' ')),loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
  if (!resetAnalytics.loading && !resetAnalytics.error && resetAnalytics.kpis.some((row)=>row.replaceAll(" ", "").includes("Устройства4"))) break;
}
if (resetAnalytics?.error || resetAnalytics?.loading || !resetAnalytics?.kpis.some((row)=>row.replaceAll(" ", "").includes("Устройства4"))) throw new Error(`Сброс фильтров не восстановил полный Dashboard: ${JSON.stringify(resetAnalytics)}`);
console.log("browser smoke: Dashboard search reduced the exact filtered device KPI to one and reset restored all four devices");
const kpiStatusTransitions = [
  ["modified", "changed"], ["absent", "missing"], ["unchanged", "unchanged"],
  ["devices", "all"], ["manufacturers", "all"], ["rooms", "all"],
];
for (const [key, expectedStatus] of kpiStatusTransitions) {
  await evaluate(`document.querySelector('#analyticsKpis [data-kpi="${key}"]').click()`);
  let savedStatus = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    savedStatus = await evaluate(`(()=>{const name=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('settings','readonly');const get=tx.objectStore('settings').get('analyticsDashboardSettings');tx.oncomplete=()=>{db.close();resolve(get.result?.value?.filters?.status||null)};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
    if (savedStatus === expectedStatus) break;
    await wait(50);
  }
  const controlStatus = await evaluate(`document.querySelector('#analyticsDashboardStatus').value`);
  if (controlStatus !== expectedStatus || savedStatus !== expectedStatus) {
    throw new Error(`Dashboard KPI ${key} did not select and persist status ${expectedStatus}: ${JSON.stringify({ controlStatus, savedStatus })}`);
  }
  const expectedDetailTitle = { modified: "Изменённые устройства", absent: "Отсутствующие устройства", unchanged: "Без изменений" }[key];
  if (expectedDetailTitle) {
    let detail = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await wait(50);
      detail = await evaluate(`({open:document.querySelector('#detailsDialog').open,title:document.querySelector('#detailsDialog [data-dialog-title]')?.textContent||'',body:document.querySelector('#detailsDialog [data-dialog-content]')?.textContent||'',rows:document.querySelectorAll('#detailsDialog [data-dialog-content] tbody tr').length})`);
      if (detail.open && !detail.body.includes("Сравнение выбранных Final…")) break;
    }
    if (!detail?.open || detail.title !== expectedDetailTitle || detail.body.includes("Сравнение выбранных Final…")) {
      throw new Error(`KPI ${key} не открыл подробный список «${expectedDetailTitle}»: ${JSON.stringify(detail)}`);
    }
    if (key === "unchanged" && detail.rows !== 4) throw new Error(`Диалог «Без изменений» показал неверное число устройств: ${JSON.stringify(detail)}`);
    await evaluate(`document.querySelector('#detailsDialog [data-dialog-close]')?.click()`);
  }
  if (key === "devices") {
    let fleetDialog = "";
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await wait(100);
      fleetDialog = await evaluate(`document.querySelector('#detailsDialog [data-dialog-content]')?.textContent||''`);
      if (fleetDialog.includes("Уникальных MAC во всех Final") || fleetDialog.includes("не удалось рассчитать")) break;
    }
    if (!fleetDialog.includes("Уникальных MAC во всех Final") || !fleetDialog.includes("Устройств в последнем Final") || !fleetDialog.includes("Изменение к предыдущему")) {
      throw new Error(`KPI Устройства не открыл динамику Final: ${fleetDialog}`);
    }
    await evaluate(`document.querySelector('#detailsDialog [data-dialog-close]')?.click()`);
  }
}
console.log("browser smoke: Dashboard KPI statuses persist and Устройства opens the paged unique-MAC/Final dynamics drilldown");
await evaluate(`(()=>{document.querySelector('#analyticsDashboardSearch').value='DEV-51';document.querySelector('#applyAnalyticsDashboardFiltersButton').click();return true})()`);
let filteredTrends = null;
for (let attempt = 0; attempt < 300; attempt += 1) {
  await wait(100);
  filteredTrends = await evaluate(`(()=>({loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,kpis:[...document.querySelectorAll('#analyticsKpis .kpi')].map((node)=>node.textContent.replace(/\\s+/g,' ')),temporal:[...document.querySelectorAll('#temporalSummary .kpi')].map((node)=>node.textContent.replace(/\\s+/g,' ')),temporalRows:document.querySelectorAll('#temporalTable tbody tr').length}))()`);
  if (!filteredTrends.loading && filteredTrends.temporal.some((row)=>row.replaceAll(' ','').includes('УникальныхMAC1'))) break;
}
if (filteredTrends?.error || filteredTrends?.loading || !filteredTrends.kpis.some((row)=>row.replaceAll(' ','').includes('Устройства1')) || !filteredTrends.temporal.some((row)=>row.replaceAll(' ','').includes('УникальныхMAC1'))) {
  throw new Error(`Поиск Dashboard не применился к KPI и временной статистике одинаково: ${JSON.stringify(filteredTrends)}`);
}
console.log("browser smoke: a one-device search filters selected-pair KPIs and temporal trend aggregates to the same MAC");
await evaluate(`document.querySelector('#resetAnalyticsDashboardFiltersButton').click()`);
let resetTrendFilters = null;
for (let attempt = 0; attempt < 300; attempt += 1) {
  await wait(100);
  resetTrendFilters = await evaluate(`(()=>({loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,kpis:[...document.querySelectorAll('#analyticsKpis .kpi')].map((node)=>node.textContent.replace(/\\s+/g,' ')),temporal:[...document.querySelectorAll('#temporalSummary .kpi')].map((node)=>node.textContent.replace(/\\s+/g,' '))}))()`);
  if (!resetTrendFilters.loading && resetTrendFilters.kpis.some((row)=>row.replaceAll(' ','').includes('Устройства4')) && resetTrendFilters.temporal.some((row)=>row.replaceAll(' ','').includes('УникальныхMAC4'))) break;
}
if (resetTrendFilters?.error || resetTrendFilters?.loading || !resetTrendFilters.kpis.some((row)=>row.replaceAll(' ','').includes('Устройства4')) || !resetTrendFilters.temporal.some((row)=>row.replaceAll(' ','').includes('УникальныхMAC4'))) {
  throw new Error(`Сброс Dashboard filter не восстановил общий scope временных KPI: ${JSON.stringify(resetTrendFilters)}`);
}
console.log("browser smoke: clearing the search restores the full four-device and four-MAC analytics scope");
if (process.env.BROWSER_SMOKE_FILTER_ONLY === "1") {
  socket.close();
  console.log("browser smoke: focused Dashboard filter verification complete");
  process.exit(0);
}
if (process.env.BROWSER_SMOKE_SAVED_FINAL_SEARCH_ONLY === "1" || process.argv.includes("--saved-final-search-only")) {
  const clonedFinals = await evaluate(`(()=>new Promise((resolve,reject)=>{
    const dbName=new URL(location.href).searchParams.get('db');
    const opening=indexedDB.open(dbName);
    opening.onerror=()=>reject(opening.error);
    opening.onsuccess=()=>{
      const db=opening.result;
      const tx=db.transaction(['settings','snapshots','snapshotChunks'],'readwrite');
      const setting=tx.objectStore('settings').get('activeSnapshotId');
      let baseId='';let metadata=null;const chunks=[];let clonedIds=[];
      setting.onsuccess=()=>{baseId=setting.result?.value||'';if(!baseId){tx.abort();reject(new Error('No active Final to clone'));return}const request=tx.objectStore('snapshots').get(baseId);request.onsuccess=()=>{metadata=request.result;if(!metadata){tx.abort();reject(new Error('Active Final metadata is missing'));return}const cursorRequest=tx.objectStore('snapshotChunks').openCursor();cursorRequest.onsuccess=()=>{const cursor=cursorRequest.result;if(cursor){if(cursor.value.snapshotId===baseId)chunks.push(cursor.value);cursor.continue();return}if(chunks.length!==metadata.chunkCount){tx.abort();reject(new Error('Active Final chunks are incomplete'));return}for(let copy=1;copy<=2;copy+=1){const id='saved-final-search-copy-'+copy;clonedIds.push(id);tx.objectStore('snapshots').put({...metadata,id,name:'Saved search copy '+copy,createdAt:new Date(Date.parse(metadata.createdAt)+copy*1000).toISOString(),sourceKey:'saved-final-search-copy:'+copy});for(const chunk of chunks)tx.objectStore('snapshotChunks').put({...chunk,snapshotId:id})}}}};
      tx.oncomplete=()=>{db.close();resolve({baseId,clonedIds,chunkCount:chunks.length})};
      tx.onerror=()=>{db.close();reject(tx.error)};tx.onabort=()=>{db.close();reject(tx.error||new Error('Could not seed duplicate Final records'))};
    };
  }))()`);
  if (clonedFinals.clonedIds.length !== 2 || !clonedFinals.chunkCount) throw new Error(`Could not seed duplicate saved Finals: ${JSON.stringify(clonedFinals)}`);
  await command("Page.reload", { ignoreCache: true });
  let restoredSearchState = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(100);
    try { restoredSearchState = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||'',error:!document.querySelector('#errorBanner')?.hidden})`); } catch { continue; }
    if (restoredSearchState.status.includes('3 Final')) break;
  }
  if (!restoredSearchState?.status.includes('3 Final') || restoredSearchState.error) throw new Error(`Three saved Finals were not restored before search: ${JSON.stringify(restoredSearchState)}`);
  await evaluate(`document.querySelector('[data-view="search"]').click()`);
  await evaluate(`(()=>{const input=document.querySelector('#globalSearch');input.value='00:11:22:33:44:51';input.dispatchEvent(new Event('input',{bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,shiftKey:true,bubbles:true}));return true})()`);
  let savedFinalSearch = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    savedFinalSearch = await evaluate(`(()=>({status:document.querySelector('#savedFinalSearchStatus').textContent.replace(/\\s+/g,' ').trim(),rows:document.querySelectorAll('#savedFinalSearchResults tbody tr').length,macs:[...document.querySelectorAll('#savedFinalSearchResults tbody tr td:first-child')].map((node)=>node.textContent.trim()),cancelDisabled:document.querySelector('#cancelSavedFinalSearchButton').disabled,error:!document.querySelector('#errorBanner').hidden}))()`);
    if (savedFinalSearch.status.includes('Найдено уникальных MAC:')) break;
  }
  if (savedFinalSearch?.error || savedFinalSearch?.rows !== 1 || savedFinalSearch?.macs?.length !== 1 || !savedFinalSearch.macs[0].includes('00:11:22:33:44:51') || !savedFinalSearch.status.includes('уникальных MAC: 1') || !savedFinalSearch.status.includes('устройств: 12') || !savedFinalSearch.status.includes('Final: 3') || !savedFinalSearch.cancelDisabled) {
    throw new Error(`Saved Final search did not return one latest deduplicated MAC after scanning every snapshot: ${JSON.stringify({clonedFinals,savedFinalSearch})}`);
  }
  await evaluate(`document.querySelector('#savedFinalSearchResults [data-saved-final-snapshot]').click()`);
  let openedFinal = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    openedFinal = await evaluate(`(()=>({open:document.querySelector('#detailsDialog').open,title:document.querySelector('#detailsDialog [data-dialog-title]').textContent,content:document.querySelector('#detailsDialog [data-dialog-content]').textContent.replace(/\\s+/g,' ')}))()`);
    if (openedFinal.open) break;
  }
  if (!openedFinal?.open || !openedFinal.title.includes('Saved search copy 2') || !openedFinal.content.includes('00:11:22:33:44:51')) throw new Error(`Saved Final search result did not open the latest matching snapshot: ${JSON.stringify(openedFinal)}`);
  await evaluate(`document.querySelector('#detailsDialog [data-dialog-close]').click()`);
  socket.close();
  console.log('browser smoke: Ctrl+Shift+F scans all three persisted Finals, deduplicates the same MAC, reports exact progress and opens the latest match');
  process.exit(0);
}
const staleIndexSeeded = await evaluate(`(()=>{const snapshotId=document.querySelector('#baseSnapshotSelect').value;const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('finalAnalyticsMetadata','readwrite');const store=tx.objectStore('finalAnalyticsMetadata');const request=store.get(snapshotId);request.onerror=()=>reject(request.error);request.onsuccess=()=>{if(!request.result){reject(new Error('Expected compact analytics index was not created'));return}store.put({...request.result,schemaVersion:3})};tx.oncomplete=()=>{db.close();resolve(snapshotId)};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
if (!staleIndexSeeded) throw new Error("Не удалось подготовить устаревший compact analytics index для regression smoke");
await evaluate(`document.querySelector('[data-view="search"]').click()`);
await wait(150);
await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
await evaluate(`document.querySelector('#refreshAnalyticsButton').click()`);
let rebuiltIndex = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await wait(150);
  rebuiltIndex = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['finalAnalyticsMetadata','snapshots'],'readonly');const metadataRequest=tx.objectStore('finalAnalyticsMetadata').get('${staleIndexSeeded}');const snapshotRequest=tx.objectStore('snapshots').get('${staleIndexSeeded}');tx.oncomplete=()=>{const metadata=metadataRequest.result;const snapshot=snapshotRequest.result;db.close();resolve({schemaVersion:metadata?.schemaVersion,deviceCount:metadata?.deviceCount,snapshotCount:snapshot?.deviceCount})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
  if (rebuiltIndex.schemaVersion === 5) break;
}
if (rebuiltIndex?.schemaVersion !== 5 || rebuiltIndex.deviceCount !== 4 || rebuiltIndex.snapshotCount !== 4) throw new Error(`Устаревший индекс не перестроился до схемы v5 без потери Final: ${JSON.stringify(rebuiltIndex)}`);
console.log("browser smoke: stale compact analytics index rebuilt to v5 while preserving the full Final");
await evaluate(`document.querySelector('[data-kpi="switchAnomalyRooms"]').click()`);
let anomalySummary = await evaluate(`document.querySelector('#detailsDialog [data-dialog-content]')?.textContent||""`);
if (!anomalySummary.includes("Переговорная 1") || !anomalySummary.includes("4 устройств") || !anomalySummary.includes("1 отклонений") || !anomalySummary.includes("10.0.0.2")) {
  throw new Error(`Сводка аномалии IP коммутатора неполная: ${anomalySummary}`);
}
const anomalyClickAudit = await evaluate(`(()=>{const content=document.querySelector('#detailsDialog [data-dialog-content]');const card=content.querySelector('details.room-card');const summary=card?.querySelector('summary');if(summary&&!card.open)summary.click();if(card)card.open=true;let bubbled=false;content.addEventListener('click',(event)=>{if(event.target.closest('[data-room-anomaly-page]'))bubbled=true},{once:true});const button=content.querySelector('[data-room-anomaly-page]');button?.click();return {cardOpen:card?.open,buttonDisabled:button?.disabled,bubbled}})()`);
let anomalyRoster = "";
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  anomalyRoster = await evaluate(`document.querySelector('#detailsDialog [data-dialog-content]')?.textContent||""`);
  if (anomalyRoster.includes("Отклонение") && anomalyRoster.includes("00:11:22:33:44:54")) break;
}
if (!anomalyRoster.includes("Отклонение") || !anomalyRoster.includes("00:11:22:33:44:54")) {
  const anomalyDebug = await evaluate(`({error:document.querySelector('#errorBanner span')?.textContent||"",roomKey:document.querySelector('#detailsDialog [data-room-anomaly-page]')?.dataset.roomAnomalyPage||"",button:document.querySelector('#detailsDialog [data-room-anomaly-page]')?.textContent||"",buttonDisabled:document.querySelector('#detailsDialog [data-room-anomaly-page]')?.disabled,cardOpen:document.querySelector('#detailsDialog details.room-card')?.open,dialogOpen:document.querySelector('#detailsDialog')?.open,tableRows:document.querySelectorAll('#detailsDialog [data-dialog-content] tbody tr').length})`);
  throw new Error(`Состав аномальной комнаты не показывает отклоняющееся устройство: ${JSON.stringify({ anomalyRoster, anomalyClickAudit, anomalyDebug })}`);
}
console.log("browser smoke: analytics summaries, majority switch-IP anomaly and full room roster verified");

await evaluate(`(async()=>{
  const setFiles=(id,entries)=>{
    const input=document.querySelector(id);
    const transfer=new DataTransfer();
    for(const [name,content] of entries) transfer.items.add(new File([content],name,{type:'text/csv',lastModified:Date.UTC(2026,9,Number(name.match(/2026-10-(\\d{2})/)[1]))}));
    input.files=transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  };
  document.querySelector('[data-view="batch"]').click();
  setFiles('#batchMainInput',[
    ['main_2026-10-15.csv','CallingStationID;NasIP;NasPortID;B_ReceiptTime;Device ID\\n00:11:22:33:44:51;10.0.0.1;1;15.10.2026 10:00:00;DEV-51\\n00:11:22:33:44:52;10.0.0.1;2;15.10.2026 10:01:00;DEV-52'],
    ['main_2026-10-16.csv','CallingStationID;NasIP;NasPortID;B_ReceiptTime;Device ID\\n00:11:22:33:44:51;10.0.0.1;99;16.10.2026 10:00:00;DEV-51\\n00:11:22:33:44:53;10.0.0.1;3;16.10.2026 10:01:00;DEV-53']
  ]);
  setFiles('#batchSmartroomInput',[
    ['smartroom_2026-10-15.csv','MAC;Производитель;Модель\\n00:11:22:33:44:51;Vendor;Model A'],
    ['smartroom_2026-10-17.csv','MAC;Производитель;Модель;ТБ;Город;Площадка;Этаж;Помещение\\n00:11:22:33:44:53;Vendor;Model B;ЦА;Москва;Кутузовский;3;Переговорная 1']
  ]);
  setFiles('#batchDdIoInput',[
    ['ddio_2026-10-15.csv','Column2;Column3;Column9;Column10\\n192.168.5.51;00-11-22-33-44-51;;'],
    ['ddio_2026-10-17.csv','Column2;Column3;Column9;Column10\\n192.168.5.53;00-11-22-33-44-53;;']
  ]);
  return true;
})()`);

let batchFilesReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(50);
  const state = await evaluate(`({main:document.querySelector('#batchMainStatus').textContent,smartroom:document.querySelector('#batchSmartroomStatus').textContent,ddio:document.querySelector('#batchDdIoStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span').textContent})`);
  if (state.error) throw new Error(`Batch file selection failed: ${state.message}`);
  if ([state.main, state.smartroom, state.ddio].every((status) => status.startsWith("2 "))) { batchFilesReady = true; break; }
}
if (!batchFilesReady) throw new Error("Массовый выбор файлов не завершился до формирования пар");
await evaluate(`document.querySelector('#previewBatchButton').click()`);

let batchReady = false;
for (let attempt = 0; attempt < 80; attempt += 1) {
  await wait(250);
  const state = await evaluate(`({rows:document.querySelectorAll('#batchPreview tbody tr.batch-details-row').length,disabled:document.querySelector('#runBatchButton').disabled,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span').textContent})`);
  if (state.error) throw new Error(`Batch pairing error: ${state.message}`);
  if (state.rows === 2 && state.disabled) { batchReady = true; break; }
}
if (!batchReady) throw new Error("Массовый preview не сформировал две пары или не заблокировал непроверенные пары");
const batchPresetAudit = await evaluate(`({sources:[...document.querySelectorAll('#batchView .source-card h3')].map((node)=>node.textContent.trim()),mappingGrids:document.querySelectorAll('#batchPreview .batch-mapping-grid').length,reviewChecks:document.querySelectorAll('#batchPreview [data-batch-pair-reviewed]').length,fieldEditors:document.querySelectorAll('#batchPreview [data-batch-mapping-field]').length})`);
if (batchPresetAudit.sources.join('|') !== 'Main|SmartRoom|DDIO' || batchPresetAudit.mappingGrids !== 2 || batchPresetAudit.reviewChecks !== 2 || batchPresetAudit.fieldEditors < 6) throw new Error(`Массовое объединение не показывает именованные источники и проверяемые mapping для каждой пары: ${JSON.stringify(batchPresetAudit)}`);
const nearestAssignments = await evaluate(`({smartroom:[...document.querySelectorAll('[data-batch-pair-source="smartroom"]')].map((select)=>select.value),ddio:[...document.querySelectorAll('[data-batch-pair-source="ddio"]')].map((select)=>select.value)})`);
if (nearestAssignments.smartroom.length !== 2 || nearestAssignments.smartroom.some((id) => !id) || nearestAssignments.ddio.length !== 2 || nearestAssignments.ddio.some((id) => !id)) throw new Error(`Ближайшая дата не назначила SmartRoom/DDIO для обеих пар: ${JSON.stringify(nearestAssignments)}`);

await evaluate(`(()=>{const mode=document.querySelector('#batchPairingMode');mode.value='same-date';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#previewBatchButton').click();return true})()`);
let sameDateAssignments = [];
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  sameDateAssignments = await evaluate(`({smartroom:[...document.querySelectorAll('[data-batch-pair-source="smartroom"]')].map((select)=>select.value),ddio:[...document.querySelectorAll('[data-batch-pair-source="ddio"]')].map((select)=>select.value)})`);
  if (sameDateAssignments.smartroom.length === 2 && sameDateAssignments.smartroom[1] === "" && sameDateAssignments.ddio.length === 2 && sameDateAssignments.ddio[1] === "") break;
}
if (sameDateAssignments.smartroom.length !== 2 || !sameDateAssignments.smartroom[0] || sameDateAssignments.smartroom[1] !== "" || sameDateAssignments.ddio.length !== 2 || !sameDateAssignments.ddio[0] || sameDateAssignments.ddio[1] !== "") throw new Error(`Режим одинаковой календарной даты выбрал неверные источники: ${JSON.stringify(sameDateAssignments)}`);
const sameDatePreviewText = await evaluate(`document.querySelector('#batchPreview').textContent`);
if (!sameDatePreviewText.includes("smartroom_2026-10-17.csv") || !sameDatePreviewText.includes("ddio_2026-10-17.csv")) throw new Error("Файлы без пары отсутствуют в batch preview");

await evaluate(`(()=>{const mode=document.querySelector('#batchPairingMode');mode.value='nearest';mode.dispatchEvent(new Event('change',{bubbles:true}));const tolerance=document.querySelector('#batchPairTolerance');tolerance.value='0';tolerance.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#previewBatchButton').click();return true})()`);
let zeroToleranceAssignments = null;
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  zeroToleranceAssignments = await evaluate(`({smartroom:[...document.querySelectorAll('[data-batch-pair-source="smartroom"]')].map((select)=>select.value),ddio:[...document.querySelectorAll('[data-batch-pair-source="ddio"]')].map((select)=>select.value)})`);
  if (zeroToleranceAssignments.smartroom.length === 2 && zeroToleranceAssignments.smartroom[1] === "" && zeroToleranceAssignments.ddio.length === 2 && zeroToleranceAssignments.ddio[1] === "") break;
}
if (zeroToleranceAssignments.smartroom.length !== 2 || !zeroToleranceAssignments.smartroom[0] || zeroToleranceAssignments.smartroom[1] !== "" || zeroToleranceAssignments.ddio.length !== 2 || !zeroToleranceAssignments.ddio[0] || zeroToleranceAssignments.ddio[1] !== "") throw new Error(`Нулевой допуск назначил файл с разницей в сутки: ${JSON.stringify(zeroToleranceAssignments)}`);

await evaluate(`(()=>{const tolerance=document.querySelector('#batchPairTolerance');tolerance.value='24';tolerance.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#previewBatchButton').click();return true})()`);
let restoredNearestAssignments = null;
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  restoredNearestAssignments = await evaluate(`({smartroom:[...document.querySelectorAll('[data-batch-pair-source="smartroom"]')].map((select)=>select.value),ddio:[...document.querySelectorAll('[data-batch-pair-source="ddio"]')].map((select)=>select.value)})`);
  if (restoredNearestAssignments.smartroom.length === 2 && restoredNearestAssignments.smartroom.every(Boolean) && restoredNearestAssignments.ddio.length === 2 && restoredNearestAssignments.ddio.every(Boolean)) break;
}
if (restoredNearestAssignments.smartroom.length !== 2 || restoredNearestAssignments.smartroom.some((id) => !id) || restoredNearestAssignments.ddio.length !== 2 || restoredNearestAssignments.ddio.some((id) => !id)) throw new Error(`Режим ближайшей даты не восстановил две пары: ${JSON.stringify(restoredNearestAssignments)}`);

const reassignResult = await evaluate(`(()=>{const selects=[...document.querySelectorAll('[data-batch-pair-source="smartroom"]')];const original=selects[0].value;selects[0].value=selects[1].value;selects[0].dispatchEvent(new Event('change',{bubbles:true}));const moved=[...document.querySelectorAll('[data-batch-pair-source="smartroom"]')].map((select)=>select.value);let current=[...document.querySelectorAll('[data-batch-pair-source="smartroom"]')];current[0].value=original;current[0].dispatchEvent(new Event('change',{bubbles:true}));current=[...document.querySelectorAll('[data-batch-pair-source="smartroom"]')];current[1].value=moved[0];current[1].dispatchEvent(new Event('change',{bubbles:true}));return {moved,restored:[...document.querySelectorAll('[data-batch-pair-source="smartroom"]')].map((select)=>select.value)}})()`);
if (!reassignResult.moved[0] || reassignResult.moved[1] !== "" || reassignResult.restored.some((id) => !id)) throw new Error(`Переназначение SmartRoom создало дубли или не восстановило пару: ${JSON.stringify(reassignResult)}`);
const reassignDdIoResult = await evaluate(`(()=>{const selects=[...document.querySelectorAll('[data-batch-pair-source="ddio"]')];const original=selects[0].value;selects[0].value=selects[1].value;selects[0].dispatchEvent(new Event('change',{bubbles:true}));const moved=[...document.querySelectorAll('[data-batch-pair-source="ddio"]')].map((select)=>select.value);let current=[...document.querySelectorAll('[data-batch-pair-source="ddio"]')];current[0].value=original;current[0].dispatchEvent(new Event('change',{bubbles:true}));current=[...document.querySelectorAll('[data-batch-pair-source="ddio"]')];current[1].value=moved[0];current[1].dispatchEvent(new Event('change',{bubbles:true}));return {moved,restored:[...document.querySelectorAll('[data-batch-pair-source="ddio"]')].map((select)=>select.value)}})()`);
if (!reassignDdIoResult.moved[0] || reassignDdIoResult.moved[1] !== "" || reassignDdIoResult.restored.some((id) => !id)) throw new Error(`Переназначение DDIO создало дубли или не восстановило пару: ${JSON.stringify(reassignDdIoResult)}`);

await evaluate(`(()=>{document.querySelectorAll('[data-batch-pair-reviewed]').forEach(input=>{input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));});const disabled=document.querySelector('[data-batch-pair-enabled="1"]');disabled.checked=false;disabled.dispatchEvent(new Event('change',{bubbles:true}));const state={enabled:document.querySelectorAll('[data-batch-pair-enabled]:checked').length,runDisabled:document.querySelector('#runBatchButton').disabled};disabled.checked=true;disabled.dispatchEvent(new Event('change',{bubbles:true}));if(state.enabled!==1||state.runDisabled)throw new Error('Отключение цикла неверно блокирует проверенную очередь');return true})()`);
console.log("browser smoke: nearest/same-date modes, configurable tolerance, unassigned file visibility, source reassignment, disabled cycle and review gate verified");

await evaluate(`(()=>{
  if(document.querySelector('#runBatchButton').disabled) throw new Error('Проверенные пары остались заблокированы');
  document.querySelector('#runBatchButton').click();
  return true;
})()`);

let firstBatch = null;
for (let attempt = 0; attempt < 80; attempt += 1) {
  await wait(250);
  const state = await evaluate(`({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span').textContent})`);
  if (state.error) throw new Error(`Batch processing error: ${state.message}`);
  if (state.status.includes("3 Final")) { firstBatch = state; break; }
}
if (!firstBatch) throw new Error("Последовательная batch очередь не сохранила оба Final");
console.log("browser smoke: serial batch committed both Finals");

await evaluate(`document.querySelector('#runBatchButton').click()`);
let repeatedBatch = null;
for (let attempt = 0; attempt < 80; attempt += 1) {
  await wait(250);
  const state = await evaluate(`({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span').textContent})`);
  if (state.error) throw new Error(`Repeated batch error: ${state.message}`);
  if (state.status.includes("3 Final")) { repeatedBatch = state; break; }
}
if (!repeatedBatch) throw new Error("Повторная batch очередь не завершилась");
await evaluate(`document.querySelector('[data-view="data"]').click()`);
await wait(500);
const finalBatchState = await evaluate(`({snapshotCount:document.querySelectorAll('#snapshotList tbody tr').length,databaseStatus:document.querySelector('#databaseStatus').textContent})`);
if (finalBatchState.snapshotCount !== 3 || !finalBatchState.databaseStatus.includes("4 устройств")) throw new Error(`Повтор batch изменил количество Final или Inventory: ${JSON.stringify(finalBatchState)}`);
await evaluate(`(()=>{Object.defineProperty(globalThis,'showSaveFilePicker',{configurable:true,value:undefined});const nativeCreate=URL.createObjectURL.bind(URL);const nativeClick=HTMLAnchorElement.prototype.click;window.__smokeFinalXlsx={blob:null,name:'',textBlob:null,textName:''};URL.createObjectURL=(blob)=>{if(blob.type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')window.__smokeFinalXlsx.blob=blob;if(blob.type==='text/plain;charset=utf-8')window.__smokeFinalXlsx.textBlob=blob;return nativeCreate(blob)};HTMLAnchorElement.prototype.click=function(){if(this.download==='final.xlsx')window.__smokeFinalXlsx.name=this.download;if(this.download==='final.txt')window.__smokeFinalXlsx.textName=this.download;return nativeClick.call(this)}})()`);
await evaluate(`document.querySelector('#exportFinalXlsxButton').click()`);
let finalXlsxExport = null;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
finalXlsxExport = await evaluate(`(async()=>{const item=window.__smokeFinalXlsx;if(!item?.blob||!item.name)return null;const bytes=new Uint8Array(await item.blob.arrayBuffer());const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const files=[];for(let i=0;i+46<=bytes.length;){if(view.getUint32(i,true)!==0x02014b50){i++;continue}const method=view.getUint16(i+10,true),size=view.getUint32(i+20,true),nameLength=view.getUint16(i+28,true),extraLength=view.getUint16(i+30,true),commentLength=view.getUint16(i+32,true),localOffset=view.getUint32(i+42,true),name=new TextDecoder().decode(bytes.slice(i+46,i+46+nameLength));if(name.startsWith('xl/')){const localNameLength=view.getUint16(localOffset+26,true),localExtraLength=view.getUint16(localOffset+28,true),start=localOffset+30+localNameLength+localExtraLength,compressed=bytes.slice(start,start+size);const data=method===8?await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text():new TextDecoder().decode(compressed);files.push({name,data})}i+=46+nameLength+extraLength+commentLength}const all=files.map(file=>file.data).join(' ');return{name:item.name,type:item.blob.type,bytes:bytes.length,zip:bytes[0]===0x50&&bytes[1]===0x4b,metadataSheet:all.includes('Сведения о Final'),deviceSheet:all.includes('Устройства'),deviceCount:all.includes('00:11:22:33:44:51')&&all.includes('00:11:22:33:44:53'),authenticationHeader:all.includes('Время аутентификации'),authenticationValue:all.includes('2026-10-16T10:00:00.000Z')}})()`);
  if (finalXlsxExport) break;
}
if (!finalXlsxExport?.zip || finalXlsxExport.name !== 'final.xlsx' || finalXlsxExport.type !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || !finalXlsxExport.metadataSheet || !finalXlsxExport.deviceSheet || !finalXlsxExport.deviceCount || !finalXlsxExport.authenticationHeader || !finalXlsxExport.authenticationValue) {
  const exportUiState = await evaluate(`({buttonDisabled:document.querySelector('#exportFinalXlsxButton')?.disabled,error:document.querySelector('#errorBanner span')?.textContent||'',activeFinal:document.querySelector('#databaseStatus')?.textContent||''})`);
  throw new Error(`XLSX-экспорт активного Final не содержит валидную книгу с метаданными и устройствами: ${JSON.stringify({ export: finalXlsxExport, ui: exportUiState })}`);
}
console.log("browser smoke: Final XLSX includes metadata, every device row, and the imported authentication timestamp");
await evaluate(`document.querySelector('#exportFinalTxtButton').click()`);
let finalTxtExport = null;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  finalTxtExport = await evaluate(`(async()=>{const item=window.__smokeFinalXlsx;if(!item?.textBlob||!item.textName)return null;const text=new TextDecoder().decode(await item.textBlob.arrayBuffer());return{name:item.textName,type:item.textBlob.type,bytes:text.length,metadata:text.includes('ID Final:'),rows:text.includes('00:11:22:33:44:51')&&text.includes('00:11:22:33:44:53'),sample:text.slice(0,400)}})()`);
  if (finalTxtExport) break;
}
if (!finalTxtExport || finalTxtExport.name !== 'final.txt' || finalTxtExport.type !== 'text/plain;charset=utf-8' || !finalTxtExport.metadata || !finalTxtExport.rows) throw new Error(`TXT-экспорт активного Final не содержит метаданные или полный состав устройств: ${JSON.stringify(finalTxtExport)}`);
console.log("browser smoke: Final TXT includes metadata and every device row");
const finalCatalogBefore = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{const selected=snapshots.result.filter((item)=>item.snapshotType==='final').sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))[0];db.close();resolve({activeId:active.result?.value,selectedId:selected?.id})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
if (!finalCatalogBefore.activeId || !finalCatalogBefore.selectedId || !await evaluate(`Boolean(document.querySelector('[data-open-final="${finalCatalogBefore.selectedId}"]'))`)) throw new Error(`Каталог не содержит открываемую раннюю запись Final: ${JSON.stringify(finalCatalogBefore)}`);
await evaluate(`document.querySelector('[data-open-final="${finalCatalogBefore.selectedId}"]').click()`);
let finalCatalogDetail = '';
for (let attempt = 0; attempt < 30; attempt += 1) {
  await wait(100);
  finalCatalogDetail = await evaluate(`document.querySelector('#detailsDialog [data-dialog-content]')?.textContent||''`);
  if (finalCatalogDetail.includes('00:11:22:33:44:52')) break;
}
const finalCatalogAfter = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const request=db.transaction('settings','readonly').objectStore('settings').get('activeSnapshotId');request.onsuccess=()=>{db.close();resolve(request.result?.value||'')};request.onerror=()=>{db.close();reject(request.error)}}})})()`);
if (!finalCatalogDetail.includes('00:11:22:33:44:52') || finalCatalogBefore.activeId !== finalCatalogAfter) throw new Error(`Просмотр раннего Final потерял строки или переключил активный снимок: ${JSON.stringify({detail: finalCatalogDetail, before: finalCatalogBefore.activeId, after: finalCatalogAfter})}`);
await evaluate(`document.querySelector('#detailsDialog').close()`);
await wait(1000);
let localArchiveRow = null;
for (let archiveAttempt = 0; archiveAttempt < 2; archiveAttempt += 1) {
  if (archiveAttempt > 0) await evaluate(`document.querySelector('#errorBanner [data-error-dismiss]')?.click()`);
  await evaluate(`(()=>{document.querySelector('#localArchiveName').value='Smoke archive lifecycle';document.querySelector('#localArchiveForm').requestSubmit();return true})()`);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await wait(100);
    localArchiveRow = await evaluate(`(()=>{const row=[...document.querySelectorAll('#localArchiveList tbody tr')].find((item)=>item.textContent.includes('Smoke archive lifecycle'));return {status:document.querySelector('#localArchiveStatus').textContent,error:document.querySelector('#errorBanner span')?.textContent||'',finalCount:Number(row?.children[2]?.textContent.replace(/\\D/g,'')),recordCount:Number(row?.children[3]?.textContent.replace(/\\D/g,'')),id:row?.querySelector('[data-restore-local-archive]')?.dataset.restoreLocalArchive||''}})()`);
    if (localArchiveRow.id || localArchiveRow.error) break;
  }
  if (localArchiveRow?.id || !localArchiveRow?.error.includes('База изменилась во время создания архива') || archiveAttempt > 0) break;
  console.log('browser smoke: archive snapshot changed during the preceding export activity; retrying after the failed draft was removed');
  await wait(1500);
}
if (!localArchiveRow?.id || !localArchiveRow.status.includes('Сохранён архив') || localArchiveRow.finalCount !== 3 || localArchiveRow.recordCount < 1) throw new Error(`Менеджер не сохранил и не перечислил именованный архив: ${JSON.stringify(localArchiveRow)}`);
await evaluate(`(()=>{const nativeCreate=URL.createObjectURL.bind(URL);const nativeClick=HTMLAnchorElement.prototype.click;window.__smokeArchiveDownload={blob:null,name:''};URL.createObjectURL=(blob)=>{window.__smokeArchiveDownload.blob=blob;return nativeCreate(blob)};HTMLAnchorElement.prototype.click=function(){if(this.download.endsWith('.madb.json'))window.__smokeArchiveDownload.name=this.download;return nativeClick.call(this)}})()`);
await evaluate(`document.querySelector('[data-export-local-archive="${localArchiveRow.id}"]').click()`);
let localArchiveExport = null;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  localArchiveExport = await evaluate(`(async()=>{const captured=window.__smokeArchiveDownload;if(!captured?.blob||!captured.name)return null;const archive=JSON.parse(await captured.blob.text());return {name:captured.name,type:captured.blob.type,format:archive.format,version:archive.version,snapshots:archive.snapshots?.length,inventory:archive.inventory?.length,hasHistory:Array.isArray(archive.history)}})()`);
  if (localArchiveExport) break;
}
if (!localArchiveExport || localArchiveExport.name !== 'Smoke-archive-lifecycle.madb.json' || localArchiveExport.format !== 'MAC_ANALYZER_NEXT_ARCHIVE' || localArchiveExport.version !== 1 || localArchiveExport.snapshots !== 3 || localArchiveExport.inventory !== 4 || !localArchiveExport.hasHistory) throw new Error(`Экспорт менеджера не создал корректный переносимый архив: ${JSON.stringify(localArchiveExport)}`);
await evaluate(`document.querySelector('[data-restore-local-archive="${localArchiveRow.id}"]').click()`);
let localArchiveRestored = '';
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  localArchiveRestored = await evaluate(`document.querySelector('#localArchiveStatus').textContent`);
  if (localArchiveRestored.includes('Архив объединён')) break;
}
const archiveRestoreState = await evaluate(`({rows:document.querySelectorAll('#snapshotList tbody tr').length,status:document.querySelector('#databaseStatus').textContent})`);
if (!localArchiveRestored.includes('Архив объединён') || archiveRestoreState.rows !== 3 || !archiveRestoreState.status.includes('4 устройств')) throw new Error(`Восстановление именованного архива нарушило текущие Final/Inventory: ${JSON.stringify({message:localArchiveRestored,state:archiveRestoreState})}`);
await evaluate(`document.querySelector('[data-delete-local-archive="${localArchiveRow.id}"]').click()`);
let localArchiveDeleted = null;
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  localArchiveDeleted = await evaluate(`({status:document.querySelector('#localArchiveStatus').textContent,empty:Boolean(document.querySelector('#localArchiveList .empty'))})`);
  if (localArchiveDeleted.status.includes('архив удалён') && localArchiveDeleted.empty) break;
}
if (!localArchiveDeleted?.status.includes('архив удалён') || !localArchiveDeleted.empty) throw new Error(`Менеджер не удалил выбранный архив: ${JSON.stringify(localArchiveDeleted)}`);
console.log("browser smoke: named local archive created, exported as portable v1 JSON, additively restored without duplicates, and deleted");
console.log("browser smoke: repeated batch stayed idempotent");
await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
await wait(200);
await evaluate(`(()=>{const control=document.querySelector('#analyticsDashboardStatus');control.value='missing';document.querySelector('#applyAnalyticsDashboardFiltersButton').click()})()`);
let missingScopedKpis = null;
for (let attempt = 0; attempt < 300; attempt += 1) {
  await wait(100);
  missingScopedKpis = await evaluate(`(()=>{const value=(key)=>document.querySelector('#analyticsKpis [data-kpi="'+key+'"] strong')?.textContent.trim()||'';const vendors=[...document.querySelectorAll('#vendorRanking .rank-row')].filter((row)=>row.querySelector('span')?.textContent.trim()!=='Unknown').length;return {loading:!document.querySelector('#analyticsLoadingStatus').hidden,status:document.querySelector('#analyticsDashboardStatus').value,devices:value('devices'),absent:value('absent'),manufacturers:value('manufacturers'),manufacturerRows:vendors,rooms:value('rooms'),roomRows:document.querySelectorAll('#roomOccupancyRanking .rank-row').length,error:!document.querySelector('#errorBanner').hidden}})()`);
  if (!missingScopedKpis.loading && !missingScopedKpis.error && missingScopedKpis.status === 'missing') break;
}
const scopedDeviceCount = missingScopedKpis?.devices.split('/').at(-1)?.replaceAll(/\s/g, '');
if (missingScopedKpis?.error || missingScopedKpis?.loading || missingScopedKpis?.status !== 'missing' || scopedDeviceCount !== missingScopedKpis.absent.replaceAll(/\s/g, '') || missingScopedKpis.manufacturers.replaceAll(/\s/g, '') !== String(missingScopedKpis.manufacturerRows) || missingScopedKpis.rooms.replaceAll(/\s/g, '') !== String(missingScopedKpis.roomRows)) {
  throw new Error(`KPI, производители и помещения не используют один missing-status набор: ${JSON.stringify(missingScopedKpis)}`);
}
await evaluate(`document.querySelector('#resetAnalyticsDashboardFiltersButton').click()`);
console.log("browser smoke: missing-status device, manufacturer and room KPIs match the full selected-status roster");

async function openDashboardAggregateKpi(key, title) {
  await evaluate(`document.querySelector('#analyticsKpis [data-kpi="${key}"]')?.click()`);
  let detail = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    detail = await evaluate(`(()=>({title:document.querySelector('#detailsDialog [data-dialog-title]')?.textContent||'',open:document.querySelector('#detailsDialog')?.open,rows:document.querySelectorAll('#detailsDialog [data-dashboard-aggregate-filter]').length,first:document.querySelector('#detailsDialog [data-dashboard-aggregate-filter]')?.dataset.dashboardAggregateValue||'',loading:document.querySelector('#detailsDialog [role="status"]')?.textContent||''}))()`);
    if (detail.open && detail.title === title && detail.rows) break;
  }
  if (!detail?.open || detail.title !== title || !detail.rows || !detail.first) throw new Error(`KPI ${key} не открыл полный агрегированный список: ${JSON.stringify(detail)}`);
  await evaluate(`document.querySelector('#detailsDialog [data-dashboard-aggregate-filter]')?.click()`);
  let selected = "";
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    selected = await evaluate(`document.querySelector('#analyticsDashboard${key === "manufacturers" ? "Manufacturer" : "Room"}')?.value||""`);
    if (selected === detail.first) break;
  }
  if (selected !== detail.first) throw new Error(`Выбор из KPI ${key} не применил фильтр: ${JSON.stringify({ detail, selected })}`);
  return { rows: detail.rows, selected };
}

const manufacturerKpiDrilldown = await openDashboardAggregateKpi("manufacturers", "Производители выбранного Final");
await evaluate(`document.querySelector('#resetAnalyticsDashboardFiltersButton').click()`);
const roomKpiDrilldown = await openDashboardAggregateKpi("rooms", "Помещения выбранного Final");
await evaluate(`document.querySelector('#resetAnalyticsDashboardFiltersButton').click()`);
console.log(JSON.stringify({ browserSmokeDashboardAggregateKpis: { manufacturers: manufacturerKpiDrilldown, rooms: roomKpiDrilldown } }));

const changedRoomKpi = await evaluate("document.querySelector(\"#analyticsKpis [data-kpi='allChangedRooms'] strong\")?.textContent.trim()||''");
if (!/^\d+$/.test(changedRoomKpi)) throw new Error("Dashboard did not render the all-equipment-changed room KPI: " + changedRoomKpi);
await evaluate("document.querySelector(\"#analyticsKpis [data-kpi='allChangedRooms']\").click()");
let changedRoomDialog = null;
for (let attempt = 0; attempt < 300; attempt += 1) {
  await wait(50);
  changedRoomDialog = await evaluate("(()=>({open:document.querySelector('#detailsDialog').open,title:document.querySelector('#detailsDialog [data-dialog-title]').textContent,rooms:[...document.querySelectorAll('#detailsDialog [data-dialog-content] details.room-card')].map((card)=>{const spans=[...card.querySelector('summary').querySelectorAll('span')];const counts=(spans[0]?.textContent||'').match(/^(\\d+)\\/(\\d+) изменено$/);return{name:card.querySelector('summary strong')?.textContent.trim()||'',changed:counts?Number(counts[1]):-1,total:counts?Number(counts[2]):-1,address:spans.at(-1)?.textContent.trim()||'',open:card.open,loadButton:Boolean(card.querySelector(\"[data-room-coverage-page][data-page='1']\"))}})}))()");
  if (changedRoomDialog.open && changedRoomDialog.title === "Изменилось всё оборудование") break;
}
if (!changedRoomDialog?.open || changedRoomDialog.title !== "Изменилось всё оборудование" || Number(changedRoomKpi) !== changedRoomDialog.rooms.length || changedRoomDialog.rooms.some((room) => !room.name || room.changed !== room.total || !room.address)) {
  throw new Error("All-changed-room KPI and expandable details disagree: " + JSON.stringify({ kpi: changedRoomKpi, dialog: changedRoomDialog }));
}
if (changedRoomDialog.rooms[0]?.loadButton) {
  await evaluate("document.querySelector(\"#detailsDialog [data-dialog-content] [data-room-coverage-page][data-page='1']\").click()");
  let rosterReady = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await wait(50);
    rosterReady = await evaluate("Boolean(document.querySelector('#detailsDialog [data-dialog-content] table.data-table'))");
    if (rosterReady) break;
  }
  const rosterState = await evaluate("document.querySelector('#detailsDialog [data-dialog-content]')?.textContent||''");
  if (!rosterReady || !rosterState.includes("Состав Final")) throw new Error("Expanded all-changed room did not load its Final roster: " + rosterState);
}
const chartGroupState = await evaluate("(()=>{const groups=[...document.querySelectorAll('#analyticsView .analytics-groups > details.analytics-group')];return{labels:groups.map((group)=>group.querySelector('summary span')?.textContent.trim()||''),canCollapse:groups[0]?.querySelector('summary')?.tagName==='SUMMARY'}})()");
if (chartGroupState.labels.join("|") !== "Ключевые графики|Состав и качество данных|Расширенная аналитика" || !chartGroupState.canCollapse) throw new Error("Dashboard chart groups are not compact/collapsible: " + JSON.stringify(chartGroupState));
await evaluate("document.querySelector('#analyticsView .analytics-groups > details.analytics-group > summary').click()");
const groupCollapsed = await evaluate("!document.querySelector('#analyticsView .analytics-groups > details.analytics-group').open");
if (!groupCollapsed) throw new Error("Dashboard's first analytics group did not collapse from its summary");
await evaluate("document.querySelector('#analyticsView .analytics-groups > details.analytics-group > summary').click();document.querySelector('#detailsDialog').close()");
console.log("browser smoke: all-changed-room KPI " + changedRoomKpi + " matches " + changedRoomDialog.rooms.length + " address-bearing expandable room card(s), and the three analytics chart groups collapse");

await evaluate(`document.querySelector('[data-view="rooms"]').click()`);
await wait(500);
const roomFilterSelection = await evaluate(`(()=>{const pairs=[['businessUnitFilter','ЦА'],['cityFilter','Москва'],['siteFilter','Кутузовский'],['floorFilter','3'],['roomFilter','Переговорная 1']];for(const [id,value] of pairs){const select=document.querySelector('#'+id);if(![...select.options].some((option)=>option.value===value))return {error:id,options:[...select.options].map((option)=>option.value)};select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}))}return Object.fromEntries(pairs.map(([id])=>[id,document.querySelector('#'+id).value]))})()`);
if (roomFilterSelection.error || Object.values(roomFilterSelection).join('|') !== 'ЦА|Москва|Кутузовский|3|Переговорная 1') throw new Error(`Каскад фильтров не выбрал иерархию комнаты: ${JSON.stringify(roomFilterSelection)}`);
await evaluate(`document.querySelector('#showRoomButton').click()`);
let roomTimelineCount = 0;
for (let attempt = 0; attempt < 50; attempt += 1) {
  await wait(100);
  roomTimelineCount = await evaluate(`document.querySelectorAll('#roomTimeline [data-room-timeline-id]').length`);
  if (roomTimelineCount === 3) break;
}
if (roomTimelineCount !== 3) throw new Error(`Хронология комнаты не показала карточку для каждого из трёх Final: ${roomTimelineCount}`);
await evaluate(`document.querySelector('#compareRoomFinalsButton').click()`);
let roomPairUi = null;
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  roomPairUi = await evaluate(`({text:document.querySelector('#roomFinalComparison').textContent.replaceAll('\\u00a0',' '),cards:[...document.querySelectorAll('#roomFinalComparison .kpi')].map((card)=>[card.querySelector('span')?.textContent.trim(),card.querySelector('strong')?.textContent.trim()]),statuses:[...document.querySelectorAll('#roomFinalComparison tbody tr td:first-child')].map((cell)=>cell.textContent.trim())})`);
  if (roomPairUi.cards.length >= 6) break;
}
if (!roomPairUi?.text.includes('Изменилось всё оборудование') || !roomPairUi.cards.some(([label])=>label==='Добавлено') || !roomPairUi.cards.some(([label])=>label==='Отсутствует') || !roomPairUi.cards.some(([label])=>label==='Изменено') || !roomPairUi.statuses.includes('Добавлено') || !roomPairUi.statuses.includes('Отсутствует') || !roomPairUi.statuses.includes('Изменено')) {
  throw new Error(`Сравнение двух последних Final комнаты не показало добавления, отсутствия и изменения: ${JSON.stringify(roomPairUi)}`);
}
console.log("browser smoke: room cascade, all three Final timeline cards, and latest room additions/absences/changes verified");

await evaluate(`document.querySelector('[data-view="single"]').click()`);
await wait(500);
const singleFileNotice = await evaluate(`document.querySelector('#singleView .notice')?.textContent||""`);
if (!singleFileNotice.includes("активный Final не переключается") || !singleFileNotice.includes("обновляют Inventory")) throw new Error(`Single-file notice does not match the persisted behavior: ${singleFileNotice}`);
await evaluate(`(()=>{const input=document.querySelector('#singleFileInput');const transfer=new DataTransfer();transfer.items.add(new File(['MAC;Производитель;Модель;IP адрес;Название комнаты\\n00:11:22:33:44:51;Vendor;Model A;192.168.1.51;Переговорная 1\\n00:11:22:33:44:54;Vendor;Model D;192.168.1.54;Переговорная 1'],'single_2026-09-05.csv',{type:'text/csv',lastModified:Date.UTC(2026,8,5)}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
let singleMappingReady = false;
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  singleMappingReady = await evaluate(`document.querySelector('#singleMapping [data-open-single-mapping-review]') && document.querySelector('#singleMapping [data-single-mapping-field]')`);
  if (singleMappingReady) break;
}
if (!singleMappingReady) {
  const singleFileDebug = await evaluate(`({status:document.querySelector('#singleFileStatus')?.textContent||'',mapping:document.querySelector('#singleMapping')?.textContent||'',fileCount:document.querySelector('#singleFileInput')?.files?.length||0,error:document.querySelector('#errorBanner span')?.textContent||'',result:document.querySelector('#singleAnalysisResult')?.textContent||''})`);
  throw new Error(`Анализ одного файла не сформировал preview и mapping: ${JSON.stringify(singleFileDebug)}`);
}
await evaluate(`document.querySelector('#singleMapping [data-open-single-mapping-review]').click()`);
await evaluate(`(()=>{const assignments={mac:'0',manufacturer:'1',model:'2',ip:'3',room:'4'};for(const select of document.querySelectorAll('#mappingReviewContent [data-review-field]')){select.value=assignments[select.dataset.reviewField]||'';select.dispatchEvent(new Event('change',{bubbles:true}))}document.querySelector('#mappingReviewForm').requestSubmit();return true})()`);
let singleFileReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  singleFileReady = await evaluate(`!document.querySelector('#mappingReviewDialog').open && !document.querySelector('#runSingleAnalysisButton').disabled && document.querySelector('#singleMapping .mapping-review')?.textContent.includes('Варианты проверены')`);
  if (singleFileReady) break;
}
if (!singleFileReady) throw new Error("Проверка mapping одного файла не применена из диалога вариантов колонок");
await evaluate(`document.querySelector('#runSingleAnalysisButton').click()`);
let singleFileSaved = false;
let singleFileState = null;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  singleFileState = await evaluate(`({status:document.querySelector('#singleAnalysisPersistenceStatus').textContent,result:document.querySelector('#singleAnalysisResult').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span').textContent})`);
  if (singleFileState.error) throw new Error(`Single-file analysis error: ${singleFileState.message}`);
  if (singleFileState.status.includes("Снимок одиночного анализа сохранён") && singleFileState.result.includes("Уникальных устройств2")) { singleFileSaved = true; break; }
}
if (!singleFileSaved) throw new Error(`Анализ одного файла не создал ожидаемый сохраняемый результат: ${JSON.stringify(singleFileState)}`);
await evaluate(`document.querySelector('#toggleSingleAnalysisHistoryButton').click()`);
let singleHistoryRestored = false;
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  const history = await evaluate(`document.querySelector('#singleAnalysisHistoryRows')?.textContent||""`);
  if (history.includes("single_2026-09-05.csv") && history.includes("2")) { singleHistoryRestored = true; break; }
}
if (!singleHistoryRestored) throw new Error("Сохранённый одиночный анализ не появился в истории UI");
const postAnalysisStatus = await evaluate(`document.querySelector('#databaseStatus').textContent`);
if (!postAnalysisStatus.includes("3 Final") || !postAnalysisStatus.includes("4 устройств")) throw new Error(`Одиночный анализ изменил каталог Final или Inventory: ${postAnalysisStatus}`);
await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
await wait(200);
const finalSelectorOptions = await evaluate(`([...document.querySelectorAll('#baseSnapshotSelect option,#currentSnapshotSelect option')].map(option=>option.textContent).join(' '))`);
if (finalSelectorOptions.includes("single_2026-09-05.csv")) throw new Error(`Single-file analysis entered Final selectors: ${finalSelectorOptions}`);
await evaluate(`document.querySelector('[data-view="data"]').click()`);
await wait(150);
const finalHistoryRows = await evaluate(`document.querySelector('#snapshotList')?.textContent||""`);
if (finalHistoryRows.includes("single_2026-09-05.csv")) throw new Error(`Single-file analysis entered Final history: ${finalHistoryRows}`);
console.log("browser smoke: single-file history stays separate from Final status, selectors, and history");

await evaluate(`document.querySelector('[data-view="filecompare"]').click()`);
await wait(150);
async function assignCompareFile(position, name, content) {
  await evaluate(`(()=>{const input=document.querySelector('#compareFile${position}Input');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(content)}],${JSON.stringify(name)},{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(100);
    ready = await evaluate(`document.querySelector('#compareFile${position}Mapping [data-compare-field]')`);
    if (ready) break;
  }
  if (!ready) throw new Error(`Сравнение двух файлов не сформировало mapping для ${name}`);
}
await assignCompareFile(0, "compare_before.csv", "MAC;Производитель;Модель;IP адрес\n00:11:22:33:44:61;Vendor;Model A;192.168.2.61\n00:11:22:33:44:62;Vendor;Model B;192.168.2.62");
await assignCompareFile(1, "compare_after.csv", "MAC;Производитель;Модель;IP адрес\n00:11:22:33:44:61;Vendor;Model A2;192.168.2.161\n00:11:22:33:44:63;Vendor;Model C;192.168.2.63");
if (!(await evaluate(`!document.querySelector('#runFileCompareButton').disabled`))) throw new Error("Сравнение двух файлов не активировалось после загрузки обоих файлов");
await evaluate(`(()=>{const nativeCreate=URL.createObjectURL.bind(URL);const nativeClick=HTMLAnchorElement.prototype.click;window.__smokeCompareDownloads=[];URL.createObjectURL=(blob)=>{window.__smokeCompareDownloads.push({blob,name:''});return nativeCreate(blob)};HTMLAnchorElement.prototype.click=function(){const item=window.__smokeCompareDownloads.at(-1);if(item)item.name=this.download;return nativeClick.call(this)}})()`);
await evaluate(`document.querySelector('#runFileCompareButton').click()`);
let fileCompareState = null;
for (let attempt = 0; attempt < 120; attempt += 1) {
  await wait(100);
  fileCompareState = await evaluate(`({text:document.querySelector('#fileCompareResult').textContent,ready:!document.querySelector('#exportFileCompareCsvButton').disabled,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span').textContent})`);
  if (fileCompareState.error) throw new Error(`File comparison error: ${fileCompareState.message}`);
  if (fileCompareState.ready) break;
}
if (!fileCompareState?.ready || !["Добавлено1", "Отсутствует1", "Изменено1", "Без изменений0"].every((value) => fileCompareState.text.includes(value))) {
  throw new Error(`Сравнение двух файлов не показало точные статусы added/absent/modified: ${JSON.stringify(fileCompareState)}`);
}
for (const [id, filename] of [["exportFileCompareCsvButton", "file-comparison.csv"], ["exportFileCompareJsonButton", "file-comparison.json"], ["exportFileCompareXlsxButton", "file-comparison.xlsx"], ["exportFileCompareTxtButton", "file-comparison.txt"]]) {
  await evaluate(`document.querySelector('#${id}').click()`);
  let download = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(50);
    download = await evaluate(`(async()=>{const item=window.__smokeCompareDownloads.find((entry)=>entry.name===${JSON.stringify(filename)});if(!item)return null;return {name:item.name,type:item.blob.type,size:item.blob.size,text:item.blob.type.includes('spreadsheet')?'':await item.blob.text(),signature:item.blob.size>=4?Array.from(new Uint8Array(await item.blob.slice(0,4).arrayBuffer())):[]}})()`);
    if (download) break;
  }
  if (!download || !download.size) throw new Error(`Сравнение двух файлов не создало ${filename}`);
  if (filename.endsWith(".csv") && !download.text.includes("Изменено")) throw new Error("CSV сравнения не содержит изменённую запись");
  if (filename.endsWith(".json") && (!download.text.includes('"modified"') || !download.text.includes("00:11:22:33:44:63"))) throw new Error("JSON сравнения не содержит статусы и добавленное устройство");
  if (filename.endsWith(".xlsx") && (download.signature[0] !== 80 || download.signature[1] !== 75)) throw new Error("Excel экспорта сравнения не является ZIP/XLSX файлом");
  if (filename.endsWith(".txt") && !download.text.includes("Изменено")) throw new Error("TXT сравнения не содержит изменённую запись");
}
console.log("browser smoke: two-file comparison shows exact added/absent/modified counts and all four CSV/JSON/XLSX/TXT exports contain data");

await evaluate(`document.querySelector('[data-view="multicompare"]').click()`);
await wait(150);
await evaluate(`(()=>{const input=document.querySelector('#multiCompareFilesInput');const transfer=new DataTransfer();transfer.items.add(new File(['MAC;Производитель;Модель\\n00:11:22:33:44:71;Vendor;Model A'], 'multi_one.csv',{type:'text/csv'}));transfer.items.add(new File(['MAC;Производитель;Модель\\n00:11:22:33:44:71;Vendor;Model B'], 'multi_two.csv',{type:'text/csv'}));transfer.items.add(new File(['MAC;Производитель;Модель\\n00:11:22:33:44:71;Vendor;Model C'], 'multi_three.csv',{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
let multiCompareReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  multiCompareReady = await evaluate(`document.querySelector('#multiCompareStatus').textContent.includes('3 файлов')&&document.querySelector('#multiComparePairSelect').options.length===6&&!document.querySelector('#exportAllMultiCompareButton').disabled`);
  if (multiCompareReady) break;
}
if (!multiCompareReady) throw new Error("Сравнение нескольких файлов не подготовило шесть направленных пар для трёх файлов");
const multiMappings = await evaluate(`(()=>{const rows=[...document.querySelectorAll('#multiCompareMappings details')];return {count:rows.length,fields:rows.map((row)=>row.querySelectorAll('[data-multi-field]').length),titles:rows.map((row)=>row.textContent.slice(0,100))}})()`);
if (multiMappings.count !== 3 || multiMappings.fields.some((count) => count === 0)) throw new Error(`Не создан отдельный mapping для каждого файла: ${JSON.stringify(multiMappings)}`);
await evaluate(`(()=>{const select=document.querySelector('#multiCompareMappings [data-multi-position="2"][data-multi-field="manufacturer"]');if(!select||select.options.length<3)throw new Error('Mapping производителя третьего файла недоступен');select.value='2';select.dispatchEvent(new Event('change',{bubbles:true}));const vendor=document.querySelector('#multiFieldVendor');vendor.checked=true;vendor.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
await evaluate(`(()=>{const select=document.querySelector('#multiComparePairSelect');select.selectedIndex=1;select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#runMultiCompareButton').click();return true})()`);
let multiPairResult = "";
for (let attempt = 0; attempt < 120; attempt += 1) {
  await wait(100);
  multiPairResult = await evaluate(`document.querySelector('#multiCompareResult').textContent`);
  if (multiPairResult.includes("multi_two.csv → multi_one.csv")) break;
}
if (!multiPairResult.includes("multi_one.csv → multi_three.csv") || !multiPairResult.includes("Изменено1")) throw new Error(`Попарный UI не применил отдельный mapping третьего файла к выбранной направленной паре: ${multiPairResult}`);
await evaluate(`(()=>{const nativeCreate=URL.createObjectURL.bind(URL);const nativeClick=HTMLAnchorElement.prototype.click;window.__smokeMultiDownload={blob:null,name:''};URL.createObjectURL=(blob)=>{if(blob.type==='text/csv;charset=utf-8')window.__smokeMultiDownload.blob=blob;return nativeCreate(blob)};HTMLAnchorElement.prototype.click=function(){if(this.download==='multi-file-comparison.csv')window.__smokeMultiDownload.name=this.download;return nativeClick.call(this)}})()`);
await evaluate(`document.querySelector('#exportAllMultiCompareCsvButton').click()`);
let multiExport = null;
for (let attempt = 0; attempt < 240; attempt += 1) {
  await wait(100);
  multiExport = await evaluate(`(async()=>{const item=window.__smokeMultiDownload;if(!item.blob||!item.name)return null;return {name:item.name,size:item.blob.size,text:await item.blob.text()}})()`);
  if (multiExport) break;
}
const exportedPairRows = [...(multiExport?.text?.matchAll(/^"(multi_(?:one|two|three)\.csv)";"(multi_(?:one|two|three)\.csv)";/gm) || [])];
const exportedPairKeys = new Set(exportedPairRows.map((row) => `${row[1]}\u0000${row[2]}`));
if (!multiExport || multiExport.size < 100 || exportedPairKeys.size !== 6) throw new Error(`Экспорт нескольких файлов не содержит все шесть направленных пар: ${JSON.stringify({name:multiExport?.name,size:multiExport?.size,pairs:exportedPairKeys.size,rows:exportedPairRows.length})}`);
await evaluate(`document.querySelector('#clearMultiCompareButton').click()`);
console.log("browser smoke: three files create per-file mappings and all six directed comparisons; selected pair and complete CSV export verified");

await evaluate(`document.querySelector('[data-view="batch"]').click()`);
await wait(150);
await evaluate(`(()=>{const form=document.querySelector('#legacyTaskCreateForm');form.elements.name.value='Disposable browser smoke queue';form.elements.intervalMinutes.value='1440';form.requestSubmit();return true;})()`);
await wait(300);
await evaluate(`document.querySelector('[data-view="history"]').click()`);
await wait(150);
let scheduledQueueCreated = false;
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  const status = await evaluate(`document.querySelector('#legacyObservationStatus')?.textContent||""`);
  if (status.includes("Создано расписание") && status.includes("Disposable browser smoke queue")) { scheduledQueueCreated = true; break; }
}
if (!scheduledQueueCreated) throw new Error("UI не создал disposable расписание очереди файлов");
await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
await wait(150);
await evaluate(`document.querySelector('#queueCurrentSourceFilesButton').click()`);
await wait(300);
await evaluate(`document.querySelector('[data-view="history"]').click()`);
await wait(150);
let queuedCurrentFiles = false;
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  const rows = await evaluate(`document.querySelector('#legacyObservationResults')?.textContent||""`);
  if (rows.includes("очередь: 3 ждёт / 0 готово / 0 ошибок") && ["main_2026-10-14.csv", "smartroom_2026-10-14.csv", "ddio_2026-10-14.csv"].every((name) => rows.includes(name))) {
    queuedCurrentFiles = true;
    break;
  }
}
if (!queuedCurrentFiles) throw new Error("Текущие Main/SmartRoom/DDIO файлы не попали в очередь расписания");
const queuedScheduleSummary = await evaluate(`document.querySelector('#legacyObservationResults')?.textContent||""`);
if (!queuedScheduleSummary.includes("очередь: 3 ждёт / 0 готово / 0 ошибок")) throw new Error(`Сводка очереди не совпадает с тремя новыми файлами: ${queuedScheduleSummary}`);
console.log("browser smoke: schedule created and three selected source files queued locally");

await evaluate(`(()=>{const button=document.querySelector('[data-run-legacy-task]');if(!button)throw new Error('Кнопка запуска сохранённой очереди не найдена');button.click();return true})()`);
let completedScheduledQueue = false;
for (let attempt = 0; attempt < 240; attempt += 1) {
  await wait(250);
  const state = await evaluate(`({rows:document.querySelector('#legacyObservationResults')?.textContent||"",status:document.querySelector('#legacyObservationStatus')?.textContent||"",error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span').textContent})`);
  if (state.error) throw new Error(`Scheduled queue processing error: ${state.message}`);
  if (state.rows.includes("очередь: 0 ждёт / 3 готово / 0 ошибок") && state.status.includes("задача выполнена: 3 файлов, успешно 3, ошибок 0")) {
    completedScheduledQueue = true;
    break;
  }
}
if (!completedScheduledQueue) {
  const state = await evaluate(`({rows:document.querySelector('#legacyObservationResults')?.textContent||"",status:document.querySelector('#legacyObservationStatus')?.textContent||""})`);
  throw new Error(`Сохранённая очередь не завершила три файла: ${JSON.stringify(state)}`);
}
console.log("browser smoke: scheduled queue processed all three local files and persisted successful results");

await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
await wait(150);
await evaluate(`document.querySelector('#queueCurrentSourceFilesButton').click()`);
await wait(300);
await evaluate(`document.querySelector('[data-view="history"]').click()`);
await wait(150);
let requeuedFiles = false;
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  const rows = await evaluate(`document.querySelector('#legacyObservationResults')?.textContent||""`);
  if (rows.includes("очередь: 3 ждёт / 3 готово / 0 ошибок")) { requeuedFiles = true; break; }
}
if (!requeuedFiles) throw new Error("Не удалось поставить три файла для проверки timer run");
await evaluate(`(()=>{const button=document.querySelector('[data-toggle-legacy-task]');if(!button)throw new Error('Переключатель расписания не найден');const recordId=button.dataset.toggleLegacyTask;const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('legacyObservations','readwrite');const store=tx.objectStore('legacyObservations');const get=store.get(recordId);get.onerror=()=>reject(get.error);get.onsuccess=()=>{const record=get.result;if(!record||record.kind!=='scheduled_tasks'){reject(new Error('Disposable schedule record not found'));return}record.payload.intervalMinutes=1;record.payload.nextRunAt=new Date(Date.now()+2000).toISOString();store.put(record)};tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
await evaluate(`document.querySelector('[data-toggle-legacy-task]').click()`);
let scheduleDisabled = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await wait(100);
  scheduleDisabled = await evaluate(`document.querySelector('[data-toggle-legacy-task]')?.textContent.trim()==='Включить'`);
  if (scheduleDisabled) break;
}
if (!scheduleDisabled) throw new Error("Не удалось остановить прежний таймер перед due-run проверкой");
await evaluate(`document.querySelector('[data-toggle-legacy-task]').click()`);
let timedQueueCompleted = false;
for (let attempt = 0; attempt < 240; attempt += 1) {
  await wait(250);
  const state = await evaluate(`({rows:document.querySelector('#legacyObservationResults')?.textContent||"",status:document.querySelector('#legacyObservationStatus')?.textContent||"",error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span').textContent})`);
  if (state.error) throw new Error(`Scheduled timer queue error: ${state.message}`);
  if (state.rows.includes("очередь: 0 ждёт / 6 готово / 0 ошибок") && state.rows.includes("последний запуск: 2026-") && state.rows.includes("следующий запуск: 2026-")) {
    timedQueueCompleted = true;
    break;
  }
}
if (!timedQueueCompleted) {
  const state = await evaluate(`({rows:document.querySelector('#legacyObservationResults')?.textContent||"",status:document.querySelector('#legacyObservationStatus')?.textContent||""})`);
  throw new Error(`Таймерное расписание не запустило ожидающую очередь: ${JSON.stringify(state)}`);
}
const scheduledSnapshotStatus = await evaluate(`document.querySelector('#databaseStatus').textContent`);
const scheduledState = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['inventory','settings','snapshotChunks','snapshots'],'readonly');const inventory=tx.objectStore('inventory').getAll();const active=tx.objectStore('settings').get('activeSnapshotId');const chunks=tx.objectStore('snapshotChunks').getAll();const snapshots=tx.objectStore('snapshots').getAll();tx.oncomplete=()=>{const activeId=active.result?.value||'';const devices=chunks.result.filter((chunk)=>chunk.snapshotId===activeId).flatMap((chunk)=>chunk.devices);db.close();resolve({inventory:inventory.result.map(({id,mac,alternateMacs,ip,snapshotId})=>({id,mac,alternateMacs,ip,snapshotId})),activeId,activeMacs:devices.map((device)=>device.mac),singleAnalyses:snapshots.result.filter((snapshot)=>snapshot.snapshotType==='single-analysis').length})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
const scheduledInventoryRows = scheduledState.inventory;
const secondaryIdentityRows = scheduledInventoryRows.filter((device) => device.mac === "00:11:22:33:44:54" || device.mac === "00:11:22:33:44:99" || device.alternateMacs?.includes("00:11:22:33:44:54"));
const uniqueInventoryMacs = new Set(scheduledInventoryRows.map(({ mac }) => mac).filter(Boolean));
if (!scheduledSnapshotStatus.includes("3 Final") || !scheduledSnapshotStatus.includes("5 устройств") || scheduledInventoryRows.length !== 5 || uniqueInventoryMacs.size !== 5
  || !scheduledState.activeId || scheduledState.activeMacs.includes("AA:BB:CC:DD:EE:66") || scheduledState.singleAnalyses < 3
  || secondaryIdentityRows.length !== 1 || secondaryIdentityRows[0].mac !== "00:11:22:33:44:54" || !secondaryIdentityRows[0].alternateMacs.includes("00:11:22:33:44:99")) {
  throw new Error(`Отдельные анализы изменили активный Final, потеряли уникальные Inventory или создали дубликат: ${scheduledSnapshotStatus}; ${JSON.stringify(scheduledState)}`);
}
console.log("browser smoke: a due timer processed all requeued files; each single-analysis stayed out of active Final and added only its unique Inventory MAC");

await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
await wait(150);
await evaluate(`document.querySelector('#resetFilesButton').click()`);
await wait(500);
await assignInput("#mainFileInput", "main_stale_secondary_identity.csv", "CallingStationID;Device ID\n00:11:22:33:44:52;DEV-51");
let staleAliasSourceReady = false;
for (let attempt = 0; attempt < 50; attempt += 1) {
  await wait(100);
  const staleAliasInput = await evaluate(`({main:document.querySelector('#mainFileStatus').textContent,smartroom:document.querySelector('#smartroomFileStatus').textContent,ddio:document.querySelector('#ddioFileStatus').textContent,error:!document.querySelector('#errorBanner').hidden})`);
  if (staleAliasInput.error) throw new Error(`Stale-alias source parsing failed: ${await evaluate(`document.querySelector('#errorBanner span').textContent`)}`);
  if (staleAliasInput.main.includes("main_stale_secondary_identity.csv") && staleAliasInput.smartroom.includes("Не выбран") && staleAliasInput.ddio.includes("Не выбран")) {
    staleAliasSourceReady = true;
    break;
  }
}
if (!staleAliasSourceReady) throw new Error("Stale-alias smoke did not finish parsing the reset Main-only source");
await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
let staleAliasFinal = false;
let staleAliasStatus = "";
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  staleAliasStatus = await evaluate(`document.querySelector('#databaseStatus').textContent`);
  const error = await evaluate(`!document.querySelector('#errorBanner').hidden`);
  if (error) throw new Error(`Stale-alias browser run failed: ${await evaluate(`document.querySelector('#errorBanner span').textContent`)}`);
  if (staleAliasStatus.includes("4 Final")) { staleAliasFinal = true; break; }
}
if (!staleAliasFinal) throw new Error(`Импорт с сильным Device ID не сохранил ожидаемый четвёртый Final: ${staleAliasStatus}`);
const staleAliasState = await evaluate(`(()=>{
  const dbName=new URL(location.href).searchParams.get('db');
  return new Promise((resolve,reject)=>{
    const opening=indexedDB.open(dbName);
    opening.onerror=()=>reject(opening.error);
    opening.onsuccess=()=>{
      const db=opening.result;
      const tx=db.transaction(['snapshots','snapshotChunks','inventory','history'],'readonly');
      const snapshotsRequest=tx.objectStore('snapshots').getAll();
      const chunksRequest=tx.objectStore('snapshotChunks').getAll();
      const inventoryRequest=tx.objectStore('inventory').getAll();
      const historyRequest=tx.objectStore('history').getAll();
      tx.oncomplete=()=>{
        const snapshots=snapshotsRequest.result.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
        const current=snapshots.at(-1);
        const currentChunk=chunksRequest.result.find((chunk)=>chunk.snapshotId===current?.id);
        const currentDevices=currentChunk?.devices||[];
        const target=currentDevices.find((device)=>device.deviceId==='DEV-51');
        const identityRows=inventoryRequest.result.filter((device)=>device.deviceId==='DEV-51'||device.deviceId==='DEV-52');
        const events=historyRequest.result.filter((event)=>event.snapshotId===current?.id);
        db.close();
        const targetEvents=events.filter((event)=>event.deviceId===target?.id).map(({type,mac})=>({type,mac}));
        resolve({snapshotCount:snapshots.length,deviceCount:current?.deviceCount,activeSnapshotId:current?.id,target:target&&{id:target.id,mac:target.mac,deviceId:target.deviceId},targetEvents,identityRows:identityRows.map(({id,deviceId,mac,alternateMacs})=>({id,deviceId,mac,alternateMacs})),added:events.filter((event)=>event.type==='added').length,absent:events.filter((event)=>event.type==='absent').length,modified:events.filter((event)=>event.type==='modified').length});
      };
      tx.onerror=()=>{db.close();reject(tx.error)};
    };
  });
})()`);
const targetHasFalseIdentityEvent = staleAliasState.targetEvents.some((event) => event.type === "added" || event.type === "absent");
const targetHasModification = staleAliasState.targetEvents.some((event) => event.type === "modified");
if (staleAliasState.snapshotCount < 4 || staleAliasState.deviceCount !== 1 || staleAliasState.target?.deviceId !== "DEV-51" || staleAliasState.target.mac !== "00:11:22:33:44:52" || staleAliasState.identityRows.filter((device) => device.deviceId === "DEV-51").length !== 1 || targetHasFalseIdentityEvent || !targetHasModification || staleAliasState.added !== 0 || staleAliasState.absent < 1 || staleAliasState.modified < 1) {
  throw new Error(`Сильная Device ID идентичность уступила устаревшему MAC или создала ложные изменения: ${JSON.stringify(staleAliasState)}`);
}
console.log("browser smoke: stale MAC retained the Device ID identity with no false additions or duplicate Inventory record");

await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
await wait(150);
await evaluate(`document.querySelector('#resetFilesButton').click()`);
const stressCsv = ["CallingStationID;Device ID", ...Array.from({ length: 5_000 }, (_, index) => {
  const hex = index.toString(16).padStart(6, "0");
  const mac = `02:10:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:01`;
  return `${mac};DEV-STRESS-${index}`;
})].join("\n");
const stressPayload = JSON.stringify(stressCsv);
await evaluate(`(()=>{const input=document.querySelector('#mainFileInput');const transfer=new DataTransfer();transfer.items.add(new File([${stressPayload}],'main_5000_devices.csv',{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
let stressFileReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  stressFileReady = await evaluate(`!document.querySelector('#runEnrichmentButton').disabled`);
  if (stressFileReady) break;
}
if (!stressFileReady) throw new Error("Импорт 5 000 устройств не подготовил браузерное обогащение");
await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
let stressFinalReady = false;
let stressStatus = "";
for (let attempt = 0; attempt < 300; attempt += 1) {
  await wait(250);
  stressStatus = await evaluate(`document.querySelector('#databaseStatus').textContent`);
  const error = await evaluate(`!document.querySelector('#errorBanner').hidden`);
  if (error) throw new Error(`Большой браузерный Final завершился ошибкой: ${await evaluate(`document.querySelector('#errorBanner span').textContent`)}`);
  if (stressStatus.includes("5 Final")) { stressFinalReady = true; break; }
}
if (!stressFinalReady) throw new Error(`Браузер не завершил первый 5 000-device Final: ${stressStatus}`);
console.log("browser smoke: first 5,000-device Final persisted for large-pair comparison");

const secondStressCsv = ["CallingStationID;Device ID", ...Array.from({ length: 5_000 }, (_, offset) => {
  const index = offset + 5_000;
  const hex = index.toString(16).padStart(6, "0");
  const mac = `02:10:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:01`;
  return `${mac};DEV-STRESS-${index}`;
})].join("\n");
const secondStressPayload = JSON.stringify(secondStressCsv);
await evaluate(`document.querySelector('#resetFilesButton').click()`);
await wait(150);
await evaluate(`(()=>{const input=document.querySelector('#mainFileInput');const transfer=new DataTransfer();transfer.items.add(new File([${secondStressPayload}],'main_5000_devices_second.csv',{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
let secondStressFileReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  secondStressFileReady = await evaluate(`!document.querySelector('#runEnrichmentButton').disabled`);
  if (secondStressFileReady) break;
}
if (!secondStressFileReady) throw new Error("Импорт второго набора из 5 000 устройств не подготовил браузерное обогащение");
await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
let secondStressFinalReady = false;
for (let attempt = 0; attempt < 300; attempt += 1) {
  await wait(250);
  const status = await evaluate(`document.querySelector('#databaseStatus').textContent`);
  const error = await evaluate(`!document.querySelector('#errorBanner').hidden`);
  if (error) throw new Error(`Второй большой браузерный Final завершился ошибкой: ${await evaluate(`document.querySelector('#errorBanner span').textContent`)}`);
  if (status.includes("6 Final")) { secondStressFinalReady = true; break; }
}
if (!secondStressFinalReady) throw new Error("Браузер не завершил второй 5 000-device Final");
const stressChunkState = await evaluate(`(()=>{
  const dbName=new URL(location.href).searchParams.get('db');
  return new Promise((resolve,reject)=>{
    const opening=indexedDB.open(dbName);
    opening.onerror=()=>reject(opening.error);
    opening.onsuccess=()=>{
      const db=opening.result;
      const tx=db.transaction(['settings','snapshots','snapshotChunks','inventory'],'readonly');
      const activeRequest=tx.objectStore('settings').get('activeSnapshotId');
      const sizes=[];
      let activeId='';
      let snapshot=null;
      let inventoryStressCount=0;
      const closeOnError=()=>{db.close();reject(tx.error)};
      activeRequest.onsuccess=()=>{
        activeId=activeRequest.result?.value||'';
        const snapshotRequest=tx.objectStore('snapshots').get(activeId);
        snapshotRequest.onsuccess=()=>{snapshot=snapshotRequest.result};
        const chunkRange=IDBKeyRange.bound([activeId,0],[activeId,Number.MAX_SAFE_INTEGER]);
        const chunkCursor=tx.objectStore('snapshotChunks').openCursor(chunkRange);
        chunkCursor.onsuccess=(event)=>{const cursor=event.target.result;if(!cursor)return;sizes.push(cursor.value.devices.length);cursor.continue()};
        const inventory=tx.objectStore('inventory').index('by_device_id');
        const inventoryRange=IDBKeyRange.bound('DEV-STRESS-','DEV-STRESS-\\uffff');
        const inventoryCursor=inventory.openCursor(inventoryRange);
        inventoryCursor.onsuccess=(event)=>{const cursor=event.target.result;if(!cursor)return;inventoryStressCount+=1;cursor.continue()};
      };
      tx.oncomplete=()=>{db.close();resolve({activeSnapshotId:activeId,snapshotCount:snapshot?.deviceCount,chunkCount:snapshot?.chunkCount,chunkSizes:sizes,inventoryStressCount})};
      tx.onerror=closeOnError;
      tx.onabort=closeOnError;
    };
  });
})()`);
if (stressChunkState.snapshotCount !== 5000 || stressChunkState.chunkCount !== 10 || stressChunkState.chunkSizes.length !== 10 || stressChunkState.chunkSizes.some((size) => size !== 500) || stressChunkState.inventoryStressCount !== 10000) {
  throw new Error(`Большой браузерный Final не сохранился порциями по 500 с полным Inventory: ${JSON.stringify(stressChunkState)}`);
}
console.log("browser smoke: two 5,000-device Finals persisted as 10 IndexedDB chunks of at most 500 rows each");
await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
let largeAnalyticsSelectorsReady = false;
for (let attempt = 0; attempt < 600; attempt += 1) {
  await wait(100);
  largeAnalyticsSelectorsReady = await evaluate(`Boolean([...document.querySelector('#currentSnapshotSelect').options].some((option)=>option.value===${JSON.stringify(stressChunkState.activeSnapshotId)}))`);
  if (largeAnalyticsSelectorsReady) break;
}
if (!largeAnalyticsSelectorsReady) throw new Error(`Аналитика не предложила активный 5 000-device Final после завершения обновления: ${stressChunkState.activeSnapshotId}`);
const largeAnalyticsPair = await evaluate(`(()=>{const current=document.querySelector('#currentSnapshotSelect');const base=document.querySelector('#baseSnapshotSelect');const index=[...current.options].findIndex((option)=>option.value===${JSON.stringify(stressChunkState.activeSnapshotId)});if(index<2)return {current:current.value,index,options:current.options.length};const expectedBase=current.options[index-1].value;const needsApply=current.value!==${JSON.stringify(stressChunkState.activeSnapshotId)}||base.value!==expectedBase||document.querySelector('#dashboardComparisonMode').value!=='snapshots';current.value=${JSON.stringify(stressChunkState.activeSnapshotId)};base.value=expectedBase;if(needsApply)document.querySelector('#applyComparisonButton').click();return {current:current.value,base:base.value,index,applied:needsApply}})()`);
if (!largeAnalyticsPair.current || !largeAnalyticsPair.base || largeAnalyticsPair.current !== stressChunkState.activeSnapshotId) throw new Error(`Не удалось выбрать активный 5 000-device Final и предыдущий снимок: ${JSON.stringify(largeAnalyticsPair)}`);
let fullFinalAnalytics = null;
let previousAnalyticsProgress = "";
let analyticsProgressChangedAt = Date.now();
let selectedPairKpisVisibleBeforeDetails = false;
let analyticsInterruptedAndRestarted = false;
for (let attempt = 0; attempt < 7200; attempt += 1) {
  await wait(100);
  fullFinalAnalytics = await evaluate(`(()=>{const historyStatus=document.querySelector('#analyticsHistoryFallback').textContent;return {overview:document.querySelector('#datasetOverview').textContent.replace(/\\s+/g,''),kpis:document.querySelector('#analyticsKpis').textContent.replace(/\\s+/g,' '),current:document.querySelector('#currentSnapshotSelect').value,loading:!document.querySelector('#analyticsLoadingStatus').hidden,loadingText:document.querySelector('#analyticsLoadingStatus').textContent,historyStatus,historyError:/обновление не удалось|Dashboard пока недоступен/i.test(historyStatus),error:!document.querySelector('#errorBanner').hidden,errorMessage:document.querySelector('#errorBanner span')?.textContent||''}})()`);
  if (fullFinalAnalytics.loadingText && fullFinalAnalytics.loadingText !== previousAnalyticsProgress) {
    previousAnalyticsProgress = fullFinalAnalytics.loadingText;
    analyticsProgressChangedAt = Date.now();
    console.log(`browser smoke: large Dashboard progress: ${previousAnalyticsProgress}`);
  }
  if (fullFinalAnalytics.loading
      && fullFinalAnalytics.overview.includes("Подробнаясводкавыбранногостатусарассчитывается")
      && fullFinalAnalytics.kpis.includes("Отсутствуют 5 000")
      && fullFinalAnalytics.kpis.includes("Без изменений 0")) {
    selectedPairKpisVisibleBeforeDetails = true;
    if (!analyticsInterruptedAndRestarted) {
      await evaluate(`document.querySelector('[data-view="search"]').click()`);
      const leftAnalytics = await evaluate(`(()=>({view:document.querySelector('.nav-button.active')?.dataset.view||'',analyticsHidden:document.querySelector('#analyticsView')?.hidden}))()`);
      if (leftAnalytics.view !== "search" || !leftAnalytics.analyticsHidden) throw new Error(`Выход из Dashboard не переключил активный экран: ${JSON.stringify(leftAnalytics)}`);
      await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
      let restartedAnalytics = null;
      for (let restartAttempt = 0; restartAttempt < 100; restartAttempt += 1) {
        restartedAnalytics = await evaluate(`(()=>({view:document.querySelector('.nav-button.active')?.dataset.view||'',current:document.querySelector('#currentSnapshotSelect').value,loading:!document.querySelector('#analyticsLoadingStatus').hidden,overview:document.querySelector('#datasetOverview').textContent.replace(/\\s+/g,''),error:!document.querySelector('#errorBanner').hidden}))()`);
        if (restartedAnalytics.loading && restartedAnalytics.overview.includes("Подробнаясводкавыбранногостатусарассчитывается")) break;
        await wait(50);
      }
      if (restartedAnalytics?.view !== "analytics" || restartedAnalytics.current !== largeAnalyticsPair.current || !restartedAnalytics.loading || !restartedAnalytics.overview.includes("Подробнаясводкавыбранногостатусарассчитывается") || restartedAnalytics.error) {
        throw new Error(`Повторный вход не начал полную загрузку актуальной пары Final: ${JSON.stringify({largeAnalyticsPair,restartedAnalytics})}`);
      }
      analyticsInterruptedAndRestarted = true;
      analyticsProgressChangedAt = Date.now();
      console.log("browser smoke: leaving Dashboard invalidates the pending run; re-entry starts a fresh full-source calculation");
    }
  }
  if (fullFinalAnalytics.loading && Date.now() - analyticsProgressChangedAt > 240_000) {
    throw new Error(`Dashboard не сообщил о новом этапе аналитики более 240 секунд: ${JSON.stringify(fullFinalAnalytics)}`);
  }
if ((fullFinalAnalytics.overview.includes('Устройств5000') && !fullFinalAnalytics.loading)
    || fullFinalAnalytics.loadingText.includes('остановлены') || (fullFinalAnalytics.error && !fullFinalAnalytics.loading)) break;
}
if (fullFinalAnalytics?.error || fullFinalAnalytics?.historyError || fullFinalAnalytics?.loading || !fullFinalAnalytics?.overview.includes('Устройств5000') || !fullFinalAnalytics?.kpis.includes('Отсутствуют 5 000') || !fullFinalAnalytics?.kpis.includes('Без изменений 0') || fullFinalAnalytics.current !== largeAnalyticsPair.current) throw new Error(`Dashboard удержал неверные KPI или не сравнил два Final по 5 000 устройств: ${JSON.stringify({largeAnalyticsPair,fullFinalAnalytics})}`);
if (!selectedPairKpisVisibleBeforeDetails) throw new Error(`KPI выбранной пары Final не появились до завершения фоновых подробных сводок: ${JSON.stringify({largeAnalyticsPair,fullFinalAnalytics})}`);
if (!analyticsInterruptedAndRestarted) throw new Error("Dashboard loading was not interrupted and restarted after navigation");
await evaluate(`document.querySelector('[data-view="search"]').click()`);
await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
const periodSmokeDay = await evaluate(`(()=>{const date=new Date();date.setUTCDate(date.getUTCDate()+1);const day=date.toISOString().slice(0,10);const mode=document.querySelector('#dashboardComparisonMode');mode.value='period';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#dashboardComparisonDateFrom').value=day;document.querySelector('#dashboardComparisonDateTo').value=day;document.querySelector('#applyDashboardPeriodButton').click();return day})()`);
let periodAnalytics = null;
for (let attempt = 0; attempt < 3000; attempt += 1) {
  await wait(100);
  periodAnalytics = await evaluate(`(()=>({mode:document.querySelector('#dashboardComparisonMode').value,day:document.querySelector('#dashboardComparisonDateFrom').value,base:document.querySelector('#baseSnapshotSelect').value,current:document.querySelector('#currentSnapshotSelect').value,kpis:document.querySelector('#analyticsKpis').textContent.replace(/\\s+/g,' '),loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden}))()`);
  if (!periodAnalytics.loading && periodAnalytics.mode === 'period' && periodAnalytics.current === stressChunkState.activeSnapshotId) break;
}
if (periodAnalytics?.error || periodAnalytics?.loading || periodAnalytics?.mode !== 'period' || periodAnalytics.day !== periodSmokeDay || periodAnalytics.current !== stressChunkState.activeSnapshotId || periodAnalytics.base !== largeAnalyticsPair.base || !periodAnalytics.kpis.includes('Отсутствуют 5 000') || !periodAnalytics.kpis.includes('Без изменений 0')) throw new Error(`Переключение Dashboard на период не пересчитало полные KPI для выбранной пары: ${JSON.stringify({periodSmokeDay,largeAnalyticsPair,periodAnalytics})}`);
await evaluate(`document.querySelector('[data-view="search"]').click()`);
console.log("browser smoke: period mode recalculates the selected 5,000-device pair with exact full-Final KPIs");
console.log("browser smoke: exact selected-pair KPIs appear while large detail analytics still load; two full 5,000-device Finals verified");
await evaluate(`document.querySelector('#globalSearch').value='';document.querySelector('#globalSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
await wait(500);
await evaluate(`document.querySelector('#pageSizeSelect').value='50';document.querySelector('#pageSizeSelect').dispatchEvent(new Event('change',{bubbles:true}))`);
await command("Page.reload", { ignoreCache: true });
let largeInventoryReload = null;
let largeInventoryPage = null;
for (let attempt = 0; attempt < 120; attempt += 1) {
  await wait(250);
  try {
    largeInventoryReload = await evaluate(`({status:document.querySelector('#databaseStatus')?.textContent||"",error:!document.querySelector('#errorBanner')?.hidden})`);
    largeInventoryPage = await evaluate(`({total:document.querySelector('#searchCount').textContent.replace(/\s+/g,' ').trim(),page:document.querySelector('#pageLabel').textContent.replace(/\s+/g,' ').trim(),rows:document.querySelectorAll('#deviceTable tbody tr').length})`);
  } catch { continue; }
  if (largeInventoryReload.status.includes("6 Final") && largeInventoryPage.total.includes("10 005") && largeInventoryPage.rows === 50) break;
}
if (!largeInventoryReload?.status.includes("6 Final") || largeInventoryReload.error) throw new Error(`Large Final was not restored before pagination check: ${JSON.stringify(largeInventoryReload)}`);
const largeInventoryTotal = Number(largeInventoryPage.total.replace(/\D/g, "")); const largeInventoryPageText = largeInventoryPage.page.replaceAll("\u00a0", " ");
if (largeInventoryTotal !== 10005 || !largeInventoryPageText.includes("Страница 1 из 201") || !largeInventoryPageText.includes("на странице 50") || !largeInventoryPageText.includes("всего найдено 10 005") || largeInventoryPage.rows !== 50) {
  throw new Error(`Большая Inventory не разделяет полный итог и страницу из 50 строк: ${JSON.stringify(largeInventoryPage)}`);
}
console.log("browser smoke: large Inventory shows 10,005 matches and exactly 50 rows on page 1");
await evaluate(`(()=>{const input=document.querySelector('#globalSearch');input.value='00:11:22:33:44:51';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
let accumulatedMacSearch = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await wait(100);
  accumulatedMacSearch = await evaluate(`({count:document.querySelector('#searchCount').textContent.replace(/\\s+/g,' ').trim(),rows:document.querySelectorAll('#deviceTable tbody tr').length,row:document.querySelector('#deviceTable tbody tr')?.textContent.replace(/\\s+/g,' ').trim()||''})`);
  if (accumulatedMacSearch.count.includes('1 устройств') && accumulatedMacSearch.rows === 1) break;
}
if (!accumulatedMacSearch?.count.includes('1 устройств') || accumulatedMacSearch.rows !== 1) throw new Error(`Поиск по накопительному alternate MAC не разрешился в одну Inventory запись: ${JSON.stringify(accumulatedMacSearch)}`);
await evaluate(`(()=>{const input=document.querySelector('#globalSearch');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
let restoredInventoryPage = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await wait(100);
  restoredInventoryPage = await evaluate(`({count:document.querySelector('#searchCount').textContent.replace(/\\s+/g,' ').trim(),rows:document.querySelectorAll('#deviceTable tbody tr').length})`);
  if (restoredInventoryPage.count.includes('10 005') && restoredInventoryPage.rows === 50) break;
}
if (!restoredInventoryPage?.count.includes('10 005') || restoredInventoryPage.rows !== 50) throw new Error(`Очистка поиска не восстановила полную страницу Inventory: ${JSON.stringify(restoredInventoryPage)}`);
console.log("browser smoke: cumulative Inventory search resolves an alternate MAC to one row and restores the full page after clearing");


await command("Page.reload", { ignoreCache: true });
let restartedState = null;
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(250);
  try {
    restartedState = await evaluate(`({title:document.title,status:document.querySelector('#databaseStatus')?.textContent||"",error:!document.querySelector('#errorBanner')?.hidden})`);
  } catch {
    continue;
  }
  if (restartedState.status.includes("6 Final")) break;
}
if (!restartedState?.status.includes("6 Final") || !restartedState.status.includes("устройств") || restartedState.error) throw new Error(`Данные не восстановились после перезапуска страницы: ${JSON.stringify(restartedState)}`);
console.log("browser smoke: IndexedDB state restored after page restart");

await evaluate(`document.querySelector('#engineeringModeButton').click()`);
await evaluate(`(()=>{document.querySelector('#engineeringPassword').value=${JSON.stringify(smokeEngineerPassword)};document.querySelector('#engineeringModeForm').requestSubmit();return true})()`);
let engineerRestored = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  engineerRestored = await evaluate(`document.querySelector('#engineeringModeButton').textContent.includes('Инженер')`);
  if (engineerRestored) break;
}
if (!engineerRestored) throw new Error("Не удалось повторно войти в disposable инженерную сессию после reload");
await evaluate(`document.querySelector('[data-view="data"]').click()`);
let archiveImportInputMounted = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await wait(100);
  archiveImportInputMounted = await evaluate(`document.querySelector('#dataView')?.classList.contains('active') && Boolean(document.querySelector('#importDatabaseInput'))`);
  if (archiveImportInputMounted) break;
}
if (!archiveImportInputMounted) throw new Error("Вкладка «База и экспорт» не смонтировала поле загрузки архива");
await evaluate(`(()=>{Object.defineProperty(globalThis,'showSaveFilePicker',{configurable:true,value:undefined});const nativeCreate=URL.createObjectURL.bind(URL);const nativeClick=HTMLAnchorElement.prototype.click;window.__smokeReferenceArchiveDownload={blob:null,name:''};URL.createObjectURL=(blob)=>{window.__smokeReferenceArchiveDownload.blob=blob;return nativeCreate(blob)};HTMLAnchorElement.prototype.click=function(){if(this.download.endsWith('.macarchive.json'))window.__smokeReferenceArchiveDownload.name=this.download;return nativeClick.call(this)}})()`);
await evaluate(`document.querySelector('#exportReferenceArchiveButton').click()`);
let referenceArchiveExport = null;
let referenceArchiveStatus = null;
for (let attempt = 0; attempt < 1200; attempt += 1) {
  await wait(100);
  referenceArchiveExport = await evaluate(`(async()=>{const captured=window.__smokeReferenceArchiveDownload;if(!captured?.blob||!captured.name)return null;const archive=JSON.parse(await captured.blob.text());const snapshotCounts=(archive.snapshots||[]).map(({metadata,devices})=>({metadata:Number(metadata?.deviceCount)||0,rows:Array.isArray(devices)?devices.length:0}));return {name:captured.name,format:archive.format,version:archive.version,snapshotCount:snapshotCounts.length,snapshotCounts,currentCount:archive.currentDevices?.length,inventoryCount:archive.allDevices?.length,historyCount:archive.movementHistory?.length,latestSnapshotId:archive.snapshots?.at(-1)?.metadata?.id,currentDevice:archive.currentDevices?.[0]&&{id:archive.currentDevices[0].internalDeviceId,vendor:archive.currentDevices[0].vendor}}})()`);
  if (referenceArchiveExport) break;
  if (attempt % 20 === 0) referenceArchiveStatus = await evaluate(`({view:document.querySelector('.view.active')?.id,title:document.querySelector('#progressTitle')?.textContent,detail:document.querySelector('#progressDetail')?.textContent,error:document.querySelector('#errorBanner span')?.textContent||''})`);
}
if (!referenceArchiveExport || referenceArchiveExport.format !== 'mac-analyzer-full-json' || referenceArchiveExport.version !== 2 || referenceArchiveExport.snapshotCount !== 6 || !referenceArchiveExport.snapshotCounts.some(({metadata,rows})=>metadata===5000&&rows===5000) || referenceArchiveExport.snapshotCounts.some(({metadata,rows})=>metadata!==rows) || referenceArchiveExport.currentCount < 1 || referenceArchiveExport.inventoryCount !== 10005 || referenceArchiveExport.historyCount < 1 || !referenceArchiveExport.currentDevice?.id || referenceArchiveExport.name !== 'mac-analyzer-' + new Date().toISOString().slice(0,10) + '.macarchive.json') throw new Error(`Совместимый экспорт не сформировал полный отчёт MAC Analyzer Pro: ${JSON.stringify({export:referenceArchiveExport,status:referenceArchiveStatus})}`);
console.log("browser smoke: compatible MAC Analyzer Pro v2 export contains all six complete Finals, the separate current analysis, full Inventory, and movement rows");
const referenceArchiveSourceDatabase = new URL(target.url).searchParams.get("db");
const referenceSourceBeforeImport = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(referenceArchiveSourceDatabase)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,snapshotCount:snapshots.result,inventoryCount:inventory.result,historyCount:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
await evaluate(`window.confirm=(message)=>{window.__smokeConfirmMessages=[...(window.__smokeConfirmMessages||[]),String(message)];return true}`);
await evaluate(`(()=>{const archive={format:'mac-analyzer-full-json',version:2,exportedAt:'2026-10-15T00:00:00.000Z',analytics:{},workspace:{theme:'dark',dashboardSettings:{status:'all'}},currentDevices:[],allDevices:[{internalDeviceId:'DEV-REFERENCE-SMOKE',mac:'00:11:22:33:44:61',vendor:'Reference Vendor',model:'Reference Model'}],invalidRows:[],movementHistory:[{mac:'00:11:22:33:44:61',type:'Изменено',field:'vendor',before:'Old Vendor',after:'Reference Vendor',changedAt:'2026-10-15T11:00:00.000Z'}],snapshots:[{metadata:{id:'reference-smoke-final',name:'Reference imported Final',source:'reference.csv',kind:'Final',fileCreatedAt:'2026-10-15T10:00:00.000Z',savedAt:'2026-10-15T10:01:00.000Z',deviceCount:1,invalidCount:0},devices:[{internalDeviceId:'DEV-REFERENCE-SMOKE',mac:'00:11:22:33:44:61',vendor:'Reference Vendor',model:'Reference Model'}]}]};const input=document.querySelector('#importDatabaseInput');const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(archive)],'reference-smoke.macarchive.json',{type:'application/json'}));input.files=transfer.files;setTimeout(()=>input.dispatchEvent(new Event('change',{bubbles:true})),0);return input.files[0]?.name})()`);
let referenceArchiveImport = null;
for (let attempt = 0; attempt < 240; attempt += 1) {
  await wait(250);
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  target = targets.find((item) => item.id === target.id && item.type === "page") || target;
  const profileDatabase = new URL(target.url).searchParams.get("db") || "";
  if (/^mac-analyzer-pro-next-profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileDatabase)) {
    await attachToTarget(target.webSocketDebuggerUrl, { force: true });
    await command("Runtime.enable");
    referenceArchiveImport = await evaluate(`(()=>({db:new URL(location.href).searchParams.get('db'),status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
    if (referenceArchiveImport.status.includes("1 Final") && referenceArchiveImport.status.includes("1 устройств")) break;
  }
}
const referenceArchiveImportState = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const imported=tx.objectStore('snapshots').get('reference-smoke-final');const device=tx.objectStore('inventory').get('DEV-REFERENCE-SMOKE');const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,snapshot:Boolean(imported.result),device:device.result?.manufacturer||'',historyCount:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
const referenceSourcePreserved = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(referenceArchiveSourceDatabase)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,snapshotCount:snapshots.result,inventoryCount:inventory.result,historyCount:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
if (referenceArchiveImport?.error || !referenceArchiveImport?.db || !referenceArchiveImport.status.includes("1 Final") || !referenceArchiveImport.status.includes("1 устройств") || referenceArchiveImportState.activeId !== "reference-smoke-final" || !referenceArchiveImportState.snapshot || referenceArchiveImportState.device !== "Reference Vendor" || referenceArchiveImportState.historyCount !== 1 || referenceSourcePreserved.activeId !== referenceSourceBeforeImport.activeId || referenceSourcePreserved.snapshotCount !== referenceSourceBeforeImport.snapshotCount || referenceSourcePreserved.inventoryCount !== referenceSourceBeforeImport.inventoryCount || referenceSourcePreserved.historyCount !== referenceSourceBeforeImport.historyCount) throw new Error(`Эталонный .macarchive.json не открыл отдельный профиль или изменил исходную базу: ${JSON.stringify({referenceArchiveImport,referenceArchiveImportState,referenceSourceBeforeImport,referenceSourcePreserved,expectedActiveId:stressChunkState.activeSnapshotId})}`);
const referenceDeviceTransferState = await importDeviceArchiveAndVerify(referenceArchiveImport.db, referenceArchiveImportState.activeId);
const referenceSourceBackState = await navigateToHistoryDatabase(-1, referenceArchiveSourceDatabase, referenceSourceBeforeImport.inventoryCount);
const referenceSourceAfterBack = await evaluate(`(()=>new Promise((resolve,reject)=>{const opening=indexedDB.open(${JSON.stringify(referenceArchiveSourceDatabase)});opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const snapshots=tx.objectStore('snapshots').count();const inventory=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,snapshotCount:snapshots.result,inventoryCount:inventory.result,historyCount:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
if (referenceSourceBackState.db !== referenceArchiveSourceDatabase || referenceSourceAfterBack.activeId !== referenceSourceBeforeImport.activeId || referenceSourceAfterBack.snapshotCount !== referenceSourceBeforeImport.snapshotCount || referenceSourceAfterBack.inventoryCount !== referenceSourceBeforeImport.inventoryCount || referenceSourceAfterBack.historyCount !== referenceSourceBeforeImport.historyCount) throw new Error(`Browser Back did not restore the exact unchanged source database: ${JSON.stringify({referenceSourceBeforeImport,referenceSourceBackState,referenceSourceAfterBack})}`);
const referenceProfileForwardState = await navigateToHistoryDatabase(1, referenceArchiveImport.db, 2);
const referenceProfileReloadState = await reloadDatabaseAndWait(referenceArchiveImport.db);
const referenceProfileAfterReload = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const imported=tx.objectStore('snapshots').get('reference-smoke-final');const device=tx.objectStore('inventory').get('DEV-REFERENCE-SMOKE');const transferDevice=tx.objectStore('inventory').get('DEVICE-TRANSFER-SMOKE');const inventoryCount=tx.objectStore('inventory').count();const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,snapshot:Boolean(imported.result),vendor:device.result?.manufacturer||'',transferVendor:transferDevice.result?.manufacturer||'',inventoryCount:inventoryCount.result,historyCount:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
if (referenceProfileForwardState.db !== referenceArchiveImport.db || referenceProfileReloadState.db !== referenceArchiveImport.db || referenceProfileAfterReload.activeId !== "reference-smoke-final" || !referenceProfileAfterReload.snapshot || referenceProfileAfterReload.vendor !== "Reference Vendor" || referenceProfileAfterReload.transferVendor !== "Device Transfer Vendor" || referenceProfileAfterReload.inventoryCount !== 2 || referenceProfileAfterReload.historyCount !== 1) throw new Error(`Imported reference profile did not survive browser Forward and reload: ${JSON.stringify({referenceProfileForwardState,referenceProfileReloadState,referenceProfileAfterReload})}`);
console.log("browser smoke: reference .macarchive.json v2 opened a UUID profile; Back restored the unchanged source and Forward/reload restored its data; devices-json v2 added Inventory without changing Final");

const startupRecoverySeed = await evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots'],'readwrite');tx.objectStore('settings').put({key:'activeSnapshotId',value:'smoke-incomplete-newest'});tx.objectStore('snapshots').put({id:'smoke-incomplete-newest',name:'Incomplete newer Final',snapshotType:'final',createdAt:'2099-12-31T23:59:59.000Z',deviceCount:1,chunkCount:1});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
if (!startupRecoverySeed) throw new Error("Не удалось подготовить disposable повреждённый Final для startup recovery");
await command("Page.reload", { ignoreCache: true });
let startupRecoveryState = null;
for (let attempt = 0; attempt < 600; attempt += 1) {
  await wait(250);
  try {
    startupRecoveryState = await evaluate(`({db:new URL(location.href).searchParams.get('db'),status:document.querySelector('#databaseStatus')?.textContent||'',ready:Boolean(document.querySelector('#progressPanel')?.hidden),error:!document.querySelector('#errorBanner')?.hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
  } catch { continue; }
  if (startupRecoveryState.ready && startupRecoveryState.status.includes('1 Final') && startupRecoveryState.status.includes('активный Final восстановлен')) break;
}
const startupRecoveryPointer = await evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','snapshotChunks'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const corrupt=tx.objectStore('snapshots').get('smoke-incomplete-newest');const valid=tx.objectStore('snapshots').get('reference-smoke-final');const corruptChunks=tx.objectStore('snapshotChunks').count(IDBKeyRange.bound(['smoke-incomplete-newest',0],['smoke-incomplete-newest',Number.MAX_SAFE_INTEGER]));tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,corrupt:Boolean(corrupt.result),valid:Boolean(valid.result),corruptChunkCount:corruptChunks.result})};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
if (startupRecoveryState?.error || !startupRecoveryState?.ready || startupRecoveryState?.db !== referenceArchiveImport.db || !startupRecoveryState?.status.includes('1 Final') || !startupRecoveryState.status.includes('активный Final восстановлен') || startupRecoveryPointer.activeId !== 'reference-smoke-final' || !startupRecoveryPointer.valid || !startupRecoveryPointer.corrupt || startupRecoveryPointer.corruptChunkCount !== 0) throw new Error(`Startup recovery kept a stale pointer or selected a newer incomplete Final: ${JSON.stringify({startupRecoveryState,startupRecoveryPointer})}`);
await evaluate(`(()=>new Promise((resolve,reject)=>{const dbName=new URL(location.href).searchParams.get('db');const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('snapshots','readwrite');tx.objectStore('snapshots').delete('smoke-incomplete-newest');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>{db.close();reject(tx.error)}}}))()`);
console.log("browser smoke: startup recovery ignored a stale active pointer and a newer incomplete Final, restored the newest complete snapshot, and preserved its data");

console.log(JSON.stringify({ initial, finalState, smartroomMappingConfirmation, analytics: analyticsText.trim(), firstBatch, repeatedBatch, finalBatchState, queuedScheduleSummary, completedScheduledQueue, timedQueueCompleted, restartedState, staleAliasState, referenceArchiveImport, referenceArchiveImportState, referenceSourcePreserved, referenceSourceBackState, referenceSourceAfterBack, referenceProfileForwardState, referenceProfileReloadState, referenceProfileAfterReload, referenceDeviceTransferState, startupRecoveryState, startupRecoveryPointer, ok: true }));
await command("Browser.close");
socket.close();

