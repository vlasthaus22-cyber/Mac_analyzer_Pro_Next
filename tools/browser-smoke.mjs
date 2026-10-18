import { get as httpGet, request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const port = Number(process.argv[2] || 9333);
const requestedSmokeUrl = process.argv[3] ? new URL(process.argv[3]) : null;
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
  target = targets.find((item) => item.type === "page" && item.url.includes("MAC-Analyzer-Pro-Next")
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
if (!/^mac-analyzer-pro-next-test-[a-z0-9-]{8,80}$/i.test(new URL(target.url).searchParams.get("db") || "")) {
  throw new Error("Browser smoke требует уникальную disposable IndexedDB из параметра ?db=mac-analyzer-pro-next-test-<id>");
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
};
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DevTools command timed out: ${method}`));
    }, 60_000);
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
await command("Runtime.enable");
await wait(2500);

const initial = await evaluate(`({
  title: document.title,
  views: document.querySelectorAll('.view').length,
  error: !document.querySelector('#errorBanner').hidden,
  databaseStatus: document.querySelector('#databaseStatus').textContent
})`);
if (initial.title !== "MAC Analyzer Pro Next" || initial.views < 8 || initial.error) throw new Error(`Некорректная инициализация: ${JSON.stringify(initial)}`);
console.log("browser smoke: portable app initialized");

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
if (process.argv.includes("--roster-only")) {
  const requestedRosterSize = Number(process.argv.find((argument) => argument.startsWith("--roster-size="))?.slice("--roster-size=".length) || 125);
  const rosterSize = Number.isInteger(requestedRosterSize) ? Math.min(5_000, Math.max(101, requestedRosterSize)) : 125;
  const secondPageSize = Math.min(100, rosterSize - 100);
  const secondPageEnd = 100 + secondPageSize;
  const rosterCsv = ["CallingStationID;Device ID", ...Array.from({ length: rosterSize }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(10, "0");
    const mac = `02:${suffix.slice(0, 2)}:${suffix.slice(2, 4)}:${suffix.slice(4, 6)}:${suffix.slice(6, 8)}:${suffix.slice(8, 10)}`;
    return `${mac};DEV-ROSTER-${String(index + 1).padStart(3, "0")}`;
  })].join("\n");
  await assignInput("#mainFileInput", `main_roster_${rosterSize}.csv`, rosterCsv);
  await evaluate(`document.querySelector('#runEnrichmentButton').click()`);
  let finalReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    const state = await evaluate(`({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''})`);
    if (state.error) throw new Error(`Roster-only enrichment failed: ${state.message}`);
    if (state.status.includes(`${rosterSize.toLocaleString("ru-RU")} устройств`)) { finalReady = true; break; }
  }
  if (!finalReady) throw new Error(`Roster-only ${rosterSize}-device Final was not committed`);
  await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
  let firstPage = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await wait(100);
    firstPage = await evaluate(`(()=>({loading:!document.querySelector('#analyticsLoadingStatus').hidden,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',heading:document.querySelector('#changeTable h3')?.textContent||'',rows:document.querySelectorAll('#changeTable tbody tr').length,range:document.querySelector('#changeTable .action-row span')?.textContent.replace(/\s+/g,' ')||'',next:Boolean(document.querySelector('#changeTable [data-status-roster-page="all"][data-page-offset="100"]'))}))()`);
    if (firstPage.error) throw new Error(`Roster-only Dashboard failed: ${firstPage.message}`);
    if (!firstPage.loading && firstPage.heading === "Все устройства") break;
  }
  if (firstPage?.loading || firstPage?.heading !== "Все устройства" || firstPage.rows !== 100 || !firstPage.range.replace(/\s/g, "").includes(`1–100из${rosterSize}`) || !firstPage.next) {
    throw new Error(`Dashboard roster first page is incorrect: ${JSON.stringify(firstPage)}`);
  }
  await evaluate(`document.querySelector('#changeTable [data-status-roster-page="all"][data-page-offset="100"]').click()`);
  let secondPage = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    secondPage = await evaluate(`(()=>({error:!document.querySelector('#errorBanner').hidden,rows:document.querySelectorAll('#changeTable tbody tr').length,range:document.querySelector('#changeTable .action-row span')?.textContent.replace(/\s+/g,' ')||''}))()`);
    if (secondPage.range.replace(/\s/g, "").includes(`101–${secondPageEnd}из${rosterSize}`)) break;
  }
  if (secondPage?.error || secondPage?.rows !== secondPageSize || !secondPage.range.replace(/\s/g, "").includes(`101–${secondPageEnd}из${rosterSize}`)) {
    throw new Error(`Dashboard roster second page is incorrect: ${JSON.stringify(secondPage)}`);
  }
  await evaluate(`(()=>{const nativeCreate=URL.createObjectURL.bind(URL);window.__smokeDownloadBlobs=new Map();window.__smokeDashboardDownloads=[];URL.createObjectURL=(blob)=>{const url=nativeCreate(blob);window.__smokeDownloadBlobs.set(url,blob);return url};HTMLAnchorElement.prototype.click=function(){const blob=window.__smokeDownloadBlobs.get(this.href);if(this.download.startsWith('analytics-dashboard-'))window.__smokeDashboardDownloads.push({name:this.download,blob});};window.__smokeXlsx={name:'',chunks:[],closed:false};Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async({suggestedName})=>{window.__smokeXlsx.name=suggestedName;return{createWritable:async()=>({write:async(chunk)=>window.__smokeXlsx.chunks.push(chunk),close:async()=>{window.__smokeXlsx.closed=true},abort:async()=>{}})}}});return true})()`);
  await evaluate(`document.querySelector('#exportAnalyticsHtmlButton').click()`);
  await evaluate(`document.querySelector('#exportAnalyticsPngButton').click()`);
  await evaluate(`document.querySelector('#exportAnalyticsXlsxButton').click()`);
  let dashboardExports = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(50);
    dashboardExports = await evaluate(`(async()=>{const downloads=window.__smokeDashboardDownloads||[];const html=downloads.find(({name})=>name.endsWith('.html'))?.blob;const png=downloads.find(({name})=>name.endsWith('.png'))?.blob;const xlsx=window.__smokeXlsx||{};const xlsxBlob=new Blob(xlsx.chunks||[]);const htmlText=html?await html.text():'';const compactHtml=htmlText.replace(/\\s/g,'');const pngBytes=png?Array.from(new Uint8Array(await png.slice(0,8).arrayBuffer())):[];const xlsxBytes=Array.from(new Uint8Array(await xlsxBlob.slice(0,4).arrayBuffer()));return{htmlName:downloads.find(({name})=>name.endsWith('.html'))?.name||'',htmlType:html?.type||'',htmlSize:html?.size||0,htmlTitle:htmlText.includes('<title>MAC Analyzer Pro · Dashboard</title>'),htmlRows:compactHtml.includes('Устройства:</strong>${rosterSize}')&&htmlText.includes('Без изменений'),pngName:downloads.find(({name})=>name.endsWith('.png'))?.name||'',pngType:png?.type||'',pngSize:png?.size||0,pngSignature:pngBytes,xlsxName:xlsx.name||'',xlsxSize:xlsxBlob.size,xlsxSignature:xlsxBytes,xlsxClosed:Boolean(xlsx.closed)}})()`);
    if (dashboardExports.htmlName && dashboardExports.pngName && dashboardExports.xlsxClosed) break;
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
await assignInput("#mainFileInput", "main_2026-10-14.csv", "CallingStationID;NasIP;NasPortID;B_ReceiptTime;Device ID\n00:11:22:33:44:51;10.0.0.1;1;14.10.2026 10:00:00;DEV-51\n00:11:22:33:44:52;10.0.0.1;2;14.10.2026 10:01:00;DEV-52\n00:11:22:33:44:53;10.0.0.1;3;14.10.2026 10:02:00;DEV-53\n00:11:22:33:44:54;10.0.0.2;4;14.10.2026 10:03:00;DEV-54");
await assignInput("#smartroomFileInput", "smartroom_2026-10-14.csv", "MAC;MAC-адрес 2;IP адрес;Производитель;Модель;Тип модели;Smartroom ID локации;ТБ;Город;Площадка;Этаж;Название комнаты;Адрес локации\n00:11:22:33:44:51;;;Vendor;Model A;Video Conference;SR-1;;;;;ЦА, Москва, Кутузовский, 3, Переговорная 1;Кутузовский 1\n00:11:22:33:44:52;;192.168.1.52;Vendor;Model B;Display;SR-1;ЦА;Москва;Кутузовский;3;Переговорная 1;Кутузовский 1\n00:11:22:33:44:53;;192.168.1.53;Vendor;Model C;Display;SR-1;ЦА;Москва;Кутузовский;3;Переговорная 1;Кутузовский 1\n00:11:22:33:44:99;00:11:22:33:44:54;;Vendor;Model D;Display;;ЦА;Москва;Кутузовский;3;Переговорная 1;Кутузовский 1");
await assignInput("#ddioFileInput", "ddio_2026-10-14.csv", "Column2;Column3;Column9;Column10\n192.168.1.51;00-11-22-33-44-51;;\n192.168.9.52;00-11-22-33-44-52;;\n192.168.1.99;00-11-22-33-44-99;;");
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

const finalState = await evaluate(`({
  status: document.querySelector('#databaseStatus').textContent,
  summary: document.querySelector('#enrichmentSummary').textContent
})`);
if (!finalState.status.includes("4 устройств")) throw new Error(`Неверное число Inventory: ${finalState.status}`);
if (!finalState.summary.includes("конфликтов: 0")) throw new Error(`Secondary MAC создал конфликт идентичности: ${finalState.summary}`);
await evaluate(`document.querySelector('[data-view="search"]').click()`);
await wait(250);
finalState.searchRows = await evaluate(`([...document.querySelectorAll('#deviceTable tbody tr')].map((row)=>[...row.cells].map((cell)=>cell.textContent.trim())))`);
const ddioRow = finalState.searchRows.find((cells) => cells[1]?.includes("00:11:22:33:44:51"));
if (ddioRow?.[2] !== "192.168.1.51") throw new Error(`DDIO IP не появился в финальной таблице: ${JSON.stringify(finalState)}`);
const knownIpRow = finalState.searchRows.find((cells) => cells[1]?.includes("00:11:22:33:44:52"));
if (knownIpRow?.[2] !== "192.168.1.52" || knownIpRow?.[3] !== "10.0.0.1") throw new Error(`DDIO заменил известный IP устройства или смешал его с IP коммутатора: ${JSON.stringify(knownIpRow)}`);
const missingSmartroomIdRow = finalState.searchRows.find((cells) => cells[1]?.includes("00:11:22:33:44:54"));
if (missingSmartroomIdRow?.[2] !== "192.168.1.99" || missingSmartroomIdRow?.[3] !== "10.0.0.2" || missingSmartroomIdRow?.[10] !== "—" || missingSmartroomIdRow?.[11] !== "Переговорная 1" || missingSmartroomIdRow?.[12] !== "Кутузовский 1") throw new Error(`SmartRoom secondary MAC did not preserve Main identity and let DDIO fill the blank IP for a device without Smartroom ID: ${JSON.stringify(missingSmartroomIdRow)}`);
console.log("browser smoke: Main/SmartRoom/DDIO committed, DDIO filled a blank IP, and preserved a known device IP separately from switch IP");
await evaluate(`document.querySelector('#globalSearch').value='001122334499';document.querySelector('#globalSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
await wait(350);
let alternateMacSearch = await evaluate(`([...document.querySelectorAll('#deviceTable tbody tr')].map((row)=>[...row.cells].map((cell)=>cell.textContent.trim())))`);
if (!alternateMacSearch.some((cells) => cells[1]?.includes("00:11:22:33:44:54"))) throw new Error(`Глобальный поиск не нормализовал alternate MAC без разделителей: ${JSON.stringify(alternateMacSearch)}`);
await evaluate(`document.querySelector('#globalSearch').value='00-11-22-33-44-99';document.querySelector('#globalSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
await wait(350);
alternateMacSearch = await evaluate(`([...document.querySelectorAll('#deviceTable tbody tr')].map((row)=>[...row.cells].map((cell)=>cell.textContent.trim())))`);
if (!alternateMacSearch.some((cells) => cells[1]?.includes("00:11:22:33:44:54"))) throw new Error(`Глобальный поиск не нормализовал alternate MAC с разделителями: ${JSON.stringify(alternateMacSearch)}`);
await evaluate(`document.querySelector('#globalSearch').value='';document.querySelector('#globalSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
const parsedRoomHierarchy = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshotChunks'],'readonly');const activeRequest=tx.objectStore('settings').get('activeSnapshotId');let activeId='';activeRequest.onsuccess=()=>{activeId=activeRequest.result?.value||''};const chunksRequest=tx.objectStore('snapshotChunks').getAll();tx.oncomplete=()=>{const device=chunksRequest.result.find((chunk)=>chunk.snapshotId===activeId)?.devices.find((item)=>item.mac==='00:11:22:33:44:51');db.close();resolve(device&&{businessUnit:device.businessUnit,city:device.city,site:device.site,floor:device.floor,room:device.room})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
if (parsedRoomHierarchy?.businessUnit !== "ЦА" || parsedRoomHierarchy.city !== "Москва" || parsedRoomHierarchy.site !== "Кутузовский" || parsedRoomHierarchy.floor !== "3" || parsedRoomHierarchy.room !== "Переговорная 1") throw new Error(`Иерархия из полного значения колонки помещения разобралась неверно: ${JSON.stringify(parsedRoomHierarchy)}`);
console.log("browser smoke: compact/separated alternate-MAC search and location hierarchy parsed from the room field");

await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
await wait(1000);
const analytics = await evaluate(`({text:document.querySelector('#analyticsKpis').textContent,overview:document.querySelector('#datasetOverview').textContent,clusters:document.querySelector('#clusterSummary').textContent,topology:document.querySelector('#topologySummary').textContent,rosterHeading:document.querySelector('#changeTable h3')?.textContent||'',rosterRows:document.querySelectorAll('#changeTable tbody tr').length,rosterText:document.querySelector('#changeTable').textContent.replace(/\s+/g,' '),error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||'',loading:!document.querySelector('#analyticsLoadingStatus').hidden})`);
const analyticsText = analytics.text.replace(/\s+/g, " ");
if (analytics.error || !/Устройства\s+4/.test(analyticsText) || !/Разные IP коммутатора NEW\s+1/.test(analyticsText)) {
  throw new Error(`Некорректная аналитика: ${JSON.stringify(analytics)}`);
}
if (!analytics.overview.includes("Устройств") || !analytics.clusters.includes("устройств") || !analytics.topology.includes("устройств")) {
  throw new Error(`Полные сводки аналитики не отображаются: ${JSON.stringify(analytics)}`);
}
if (analytics.rosterHeading !== "Все устройства" || analytics.rosterRows !== 4 || !analytics.rosterText.includes("Устройств: 4")) throw new Error(`Общий Dashboard roster не показывает весь текущий Final: ${JSON.stringify(analytics)}`);
console.log("browser smoke: all-device Dashboard roster shows every row and the exact total");
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
const staleIndexSeeded = await evaluate(`(()=>{const snapshotId=document.querySelector('#currentSnapshotSelect').value;const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('finalAnalyticsMetadata','readwrite');const store=tx.objectStore('finalAnalyticsMetadata');const request=store.get(snapshotId);request.onerror=()=>reject(request.error);request.onsuccess=()=>{if(!request.result){reject(new Error('Expected compact analytics index was not created'));return}store.put({...request.result,schemaVersion:3})};tx.oncomplete=()=>{db.close();resolve(snapshotId)};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
if (!staleIndexSeeded) throw new Error("Не удалось подготовить устаревший compact analytics index для regression smoke");
await evaluate(`document.querySelector('[data-view="search"]').click()`);
await wait(150);
await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
let rebuiltIndex = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await wait(150);
  rebuiltIndex = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['finalAnalyticsMetadata','snapshots'],'readonly');const metadataRequest=tx.objectStore('finalAnalyticsMetadata').get('${staleIndexSeeded}');const snapshotRequest=tx.objectStore('snapshots').get('${staleIndexSeeded}');tx.oncomplete=()=>{const metadata=metadataRequest.result;const snapshot=snapshotRequest.result;db.close();resolve({schemaVersion:metadata?.schemaVersion,deviceCount:metadata?.deviceCount,snapshotCount:snapshot?.deviceCount})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
  if (rebuiltIndex.schemaVersion === 4) break;
}
if (rebuiltIndex?.schemaVersion !== 4 || rebuiltIndex.deviceCount !== 4 || rebuiltIndex.snapshotCount !== 4) throw new Error(`Устаревший индекс не перестроился до схемы v4 без потери Final: ${JSON.stringify(rebuiltIndex)}`);
console.log("browser smoke: stale compact analytics index rebuilt to v4 while preserving the full Final");
await evaluate(`document.querySelector('[data-kpi="switchAnomalyRooms"]').click()`);
let anomalySummary = await evaluate(`document.querySelector('#detailsDialog [data-dialog-content]')?.textContent||""`);
if (!anomalySummary.includes("Переговорная 1") || !anomalySummary.includes("4 устройств") || !anomalySummary.includes("1 отклонений") || !anomalySummary.includes("10.0.0.2")) {
  throw new Error(`Сводка аномалии IP коммутатора неполная: ${anomalySummary}`);
}
await evaluate(`document.querySelector('#detailsDialog [data-room-anomaly-page]').click()`);
let anomalyRoster = "";
for (let attempt = 0; attempt < 150; attempt += 1) {
  await wait(100);
  anomalyRoster = await evaluate(`document.querySelector('#detailsDialog [data-dialog-content]')?.textContent||""`);
  if (anomalyRoster.includes("Отклонение") && anomalyRoster.includes("00:11:22:33:44:54")) break;
}
if (!anomalyRoster.includes("Отклонение") || !anomalyRoster.includes("00:11:22:33:44:54")) {
  const anomalyDebug = await evaluate(`({error:document.querySelector('#errorBanner span')?.textContent||"",roomKey:document.querySelector('#detailsDialog [data-room-anomaly-page]')?.dataset.roomAnomalyPage||"",button:document.querySelector('#detailsDialog [data-room-anomaly-page]')?.textContent||""})`);
  throw new Error(`Состав аномальной комнаты не показывает отклоняющееся устройство: ${JSON.stringify({ anomalyRoster, anomalyDebug })}`);
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
  document.querySelector('#previewBatchButton').click();
  return true;
})()`);

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
  finalXlsxExport = await evaluate(`(async()=>{const item=window.__smokeFinalXlsx;if(!item?.blob||!item.name)return null;const bytes=new Uint8Array(await item.blob.arrayBuffer());const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const files=[];for(let i=0;i+46<=bytes.length;){if(view.getUint32(i,true)!==0x02014b50){i++;continue}const method=view.getUint16(i+10,true),size=view.getUint32(i+20,true),nameLength=view.getUint16(i+28,true),extraLength=view.getUint16(i+30,true),commentLength=view.getUint16(i+32,true),localOffset=view.getUint32(i+42,true),name=new TextDecoder().decode(bytes.slice(i+46,i+46+nameLength));if(name.startsWith('xl/')){const localNameLength=view.getUint16(localOffset+26,true),localExtraLength=view.getUint16(localOffset+28,true),start=localOffset+30+localNameLength+localExtraLength,compressed=bytes.slice(start,start+size);const data=method===8?await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text():new TextDecoder().decode(compressed);files.push({name,data})}i+=46+nameLength+extraLength+commentLength}const all=files.map(file=>file.data).join(' ');return{name:item.name,type:item.blob.type,bytes:bytes.length,zip:bytes[0]===0x50&&bytes[1]===0x4b,metadataSheet:all.includes('Сведения о Final'),deviceSheet:all.includes('Устройства'),deviceCount:all.includes('00:11:22:33:44:51')&&all.includes('00:11:22:33:44:53')}})()`);
  if (finalXlsxExport) break;
}
if (!finalXlsxExport?.zip || finalXlsxExport.name !== 'final.xlsx' || finalXlsxExport.type !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || !finalXlsxExport.metadataSheet || !finalXlsxExport.deviceSheet || !finalXlsxExport.deviceCount) {
  const exportUiState = await evaluate(`({buttonDisabled:document.querySelector('#exportFinalXlsxButton')?.disabled,error:document.querySelector('#errorBanner span')?.textContent||'',activeFinal:document.querySelector('#databaseStatus')?.textContent||''})`);
  throw new Error(`XLSX-экспорт активного Final не содержит валидную книгу с метаданными и устройствами: ${JSON.stringify({ export: finalXlsxExport, ui: exportUiState })}`);
}
console.log("browser smoke: Final XLSX downloads a workbook with metadata and every device row");
await evaluate(`document.querySelector('#exportFinalTxtButton').click()`);
let finalTxtExport = null;
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(100);
  finalTxtExport = await evaluate(`(async()=>{const item=window.__smokeFinalXlsx;if(!item?.textBlob||!item.textName)return null;const text=await item.textBlob.text();return{name:item.textName,type:item.textBlob.type,metadata:text.includes('ID Final:'),rows:text.includes('00:11:22:33:44:51')&&text.includes('00:11:22:33:44:53')}})()`);
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
await evaluate(`(()=>{document.querySelector('#localArchiveName').value='Smoke archive lifecycle';document.querySelector('#localArchiveForm').requestSubmit();return true})()`);
let localArchiveRow = null;
for (let attempt = 0; attempt < 400; attempt += 1) {
  await wait(100);
  localArchiveRow = await evaluate(`(()=>{const row=[...document.querySelectorAll('#localArchiveList tbody tr')].find((item)=>item.textContent.includes('Smoke archive lifecycle'));return {status:document.querySelector('#localArchiveStatus').textContent,error:document.querySelector('#errorBanner span')?.textContent||'',finalCount:Number(row?.children[2]?.textContent.replace(/\\D/g,'')),recordCount:Number(row?.children[3]?.textContent.replace(/\\D/g,'')),id:row?.querySelector('[data-restore-local-archive]')?.dataset.restoreLocalArchive||''}})()`);
  if (localArchiveRow.id) break;
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
await wait(150);
const singleFileNotice = await evaluate(`document.querySelector('#singleView .notice')?.textContent||""`);
if (!singleFileNotice.includes("активный Final не переключается") || !singleFileNotice.includes("обновляют Inventory")) throw new Error(`Single-file notice does not match the persisted behavior: ${singleFileNotice}`);
await evaluate(`(()=>{const input=document.querySelector('#singleFileInput');const transfer=new DataTransfer();transfer.items.add(new File(['MAC;Производитель;Модель;IP адрес;Название комнаты\\n00:11:22:33:44:51;Vendor;Model A;192.168.1.51;Переговорная 1\\n00:11:22:33:44:54;Vendor;Model D;192.168.1.54;Переговорная 1'],'single_2026-09-05.csv',{type:'text/csv',lastModified:Date.UTC(2026,8,5)}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
let singleFileReady = false;
for (let attempt = 0; attempt < 80; attempt += 1) {
  await wait(100);
  singleFileReady = await evaluate(`!document.querySelector('#runSingleAnalysisButton').disabled && document.querySelector('#singleMapping [data-single-mapping-field]')`);
  if (singleFileReady) break;
}
if (!singleFileReady) throw new Error("Анализ одного файла не сформировал preview и mapping");
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
await evaluate(`(()=>{const input=document.querySelector('#multiCompareFilesInput');const transfer=new DataTransfer();transfer.items.add(new File(['MAC;Производитель;Модель\\n00:11:22:33:44:71;Vendor;Model A'], 'multi_one.csv',{type:'text/csv'}));transfer.items.add(new File(['MAC;Производитель;Модель\\n00:11:22:33:44:71;Vendor;Model B'], 'multi_two.csv',{type:'text/csv'}));transfer.items.add(new File(['MAC;Производитель;Модель\\n00:11:22:33:44:72;Vendor;Model C'], 'multi_three.csv',{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
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
await evaluate(`document.querySelector('#exportAllMultiCompareButton').click()`);
let multiExport = null;
for (let attempt = 0; attempt < 240; attempt += 1) {
  await wait(100);
  multiExport = await evaluate(`(async()=>{const item=window.__smokeMultiDownload;if(!item.blob||!item.name)return null;return {name:item.name,size:item.blob.size,text:await item.blob.text()}})()`);
  if (multiExport) break;
}
const exportedPairRows = multiExport?.text?.match(/multi_(?:one|two|three)\.csv → multi_(?:one|two|three)\.csv/g) || [];
const exportedPairKeys = new Set(exportedPairRows);
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
const scheduledInventoryRows = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction('inventory','readonly');const request=tx.objectStore('inventory').getAll();request.onsuccess=()=>resolve(request.result.map(({id,mac,alternateMacs,ip,snapshotId})=>({id,mac,alternateMacs,ip,snapshotId})));request.onerror=()=>reject(request.error);tx.oncomplete=()=>db.close()}})})()`);
const secondaryIdentityRows = scheduledInventoryRows.filter((device) => device.mac === "00:11:22:33:44:54" || device.mac === "00:11:22:33:44:99" || device.alternateMacs?.includes("00:11:22:33:44:54"));
if (!scheduledSnapshotStatus.includes("3 Final") || !scheduledSnapshotStatus.includes("4 устройств") || scheduledInventoryRows.length !== 4 || secondaryIdentityRows.length !== 1 || secondaryIdentityRows[0].mac !== "00:11:22:33:44:54" || !secondaryIdentityRows[0].alternateMacs.includes("00:11:22:33:44:99")) {
  throw new Error(`Отдельные анализы создали дубликат Inventory или изменили Final: ${scheduledSnapshotStatus}; inventory=${JSON.stringify(scheduledInventoryRows)}`);
}
console.log("browser smoke: a due timer automatically processed the requeued files and updated schedule results");

await evaluate(`document.querySelector('[data-view="enrichment"]').click()`);
await wait(150);
await evaluate(`document.querySelector('#resetFilesButton').click()`);
await assignInput("#mainFileInput", "main_stale_secondary_identity.csv", "CallingStationID;Device ID\n00:11:22:33:44:52;DEV-51");
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
        resolve({snapshotCount:snapshots.length,deviceCount:current?.deviceCount,activeSnapshotId:current?.id,target:target&&{id:target.id,mac:target.mac,deviceId:target.deviceId},identityRows:identityRows.map(({id,deviceId,mac,alternateMacs})=>({id,deviceId,mac,alternateMacs})),added:events.filter((event)=>event.type==='added').length,absent:events.filter((event)=>event.type==='absent').length,modified:events.filter((event)=>event.type==='modified').length});
      };
      tx.onerror=()=>{db.close();reject(tx.error)};
    };
  });
})()`);
if (staleAliasState.snapshotCount < 4 || staleAliasState.deviceCount !== 1 || staleAliasState.target?.deviceId !== "DEV-51" || staleAliasState.target.mac !== "00:11:22:33:44:52" || staleAliasState.identityRows.filter((device) => device.deviceId === "DEV-51").length !== 1 || staleAliasState.added !== 0 || staleAliasState.absent < 1 || staleAliasState.modified < 1) {
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
for (let attempt = 0; attempt < 3000; attempt += 1) {
  await wait(100);
  fullFinalAnalytics = await evaluate(`(()=>{const historyStatus=document.querySelector('#analyticsHistoryFallback').textContent;return {overview:document.querySelector('#datasetOverview').textContent.replace(/\\s+/g,''),kpis:document.querySelector('#analyticsKpis').textContent.replace(/\\s+/g,' '),current:document.querySelector('#currentSnapshotSelect').value,loading:!document.querySelector('#analyticsLoadingStatus').hidden,loadingText:document.querySelector('#analyticsLoadingStatus').textContent,historyStatus,historyError:/обновление не удалось|Dashboard пока недоступен/i.test(historyStatus),error:!document.querySelector('#errorBanner').hidden}})()`);
  if (fullFinalAnalytics.loadingText && fullFinalAnalytics.loadingText !== previousAnalyticsProgress) {
    previousAnalyticsProgress = fullFinalAnalytics.loadingText;
    analyticsProgressChangedAt = Date.now();
    console.log(`browser smoke: large Dashboard progress: ${previousAnalyticsProgress}`);
  }
  if (fullFinalAnalytics.loading && Date.now() - analyticsProgressChangedAt > 75_000) {
    throw new Error(`Dashboard перестал сообщать о продвижении более 75 секунд: ${JSON.stringify(fullFinalAnalytics)}`);
  }
if ((fullFinalAnalytics.overview.includes('Устройств5000') && !fullFinalAnalytics.loading)
    || fullFinalAnalytics.loadingText.includes('остановлены') || fullFinalAnalytics.error) break;
}
if (fullFinalAnalytics?.error || fullFinalAnalytics?.historyError || fullFinalAnalytics?.loading || !fullFinalAnalytics?.overview.includes('Устройств5000') || !fullFinalAnalytics?.kpis.includes('Отсутствуют 5 000') || !fullFinalAnalytics?.kpis.includes('Без изменений 0') || fullFinalAnalytics.current !== largeAnalyticsPair.current) throw new Error(`Dashboard удержал неверные KPI или не сравнил два Final по 5 000 устройств: ${JSON.stringify({largeAnalyticsPair,fullFinalAnalytics})}`);
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
console.log("browser smoke: large analytics compares two complete 5,000-device Finals, independently of paged Inventory");
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
  if (largeInventoryReload.status.includes("6 Final") && largeInventoryPage.total.includes("10 004") && largeInventoryPage.rows === 50) break;
}
if (!largeInventoryReload?.status.includes("6 Final") || largeInventoryReload.error) throw new Error(`Large Final was not restored before pagination check: ${JSON.stringify(largeInventoryReload)}`);
const largeInventoryTotal = Number(largeInventoryPage.total.replace(/\D/g, "")); const largeInventoryPageText = largeInventoryPage.page.replaceAll("\u00a0", " ");
if (largeInventoryTotal !== 10004 || !largeInventoryPageText.includes("Страница 1 из 201") || !largeInventoryPageText.includes("на странице 50") || !largeInventoryPageText.includes("всего найдено 10 004") || largeInventoryPage.rows !== 50) {
  throw new Error(`Большая Inventory не разделяет полный итог и страницу из 50 строк: ${JSON.stringify(largeInventoryPage)}`);
}
console.log("browser smoke: large Inventory shows 10,004 matches and exactly 50 rows on page 1");
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
  if (restoredInventoryPage.count.includes('10 004') && restoredInventoryPage.rows === 50) break;
}
if (!restoredInventoryPage?.count.includes('10 004') || restoredInventoryPage.rows !== 50) throw new Error(`Очистка поиска не восстановила полную страницу Inventory: ${JSON.stringify(restoredInventoryPage)}`);
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
await evaluate(`(()=>{const nativeCreate=URL.createObjectURL.bind(URL);const nativeClick=HTMLAnchorElement.prototype.click;window.__smokeReferenceArchiveDownload={blob:null,name:''};URL.createObjectURL=(blob)=>{window.__smokeReferenceArchiveDownload.blob=blob;return nativeCreate(blob)};HTMLAnchorElement.prototype.click=function(){if(this.download.endsWith('.macarchive.json'))window.__smokeReferenceArchiveDownload.name=this.download;return nativeClick.call(this)}})()`);
await evaluate(`document.querySelector('#exportReferenceArchiveButton').click()`);
let referenceArchiveExport = null;
let referenceArchiveStatus = null;
for (let attempt = 0; attempt < 1200; attempt += 1) {
  await wait(100);
  referenceArchiveExport = await evaluate(`(async()=>{const captured=window.__smokeReferenceArchiveDownload;if(!captured?.blob||!captured.name)return null;const archive=JSON.parse(await captured.blob.text());return {name:captured.name,format:archive.format,version:archive.version,snapshotCount:archive.snapshots?.length,currentCount:archive.currentDevices?.length,inventoryCount:archive.allDevices?.length,historyCount:archive.movementHistory?.length,latestSnapshotId:archive.snapshots?.at(-1)?.metadata?.id,currentDevice:archive.currentDevices?.[0]&&{id:archive.currentDevices[0].internalDeviceId,vendor:archive.currentDevices[0].vendor}}})()`);
  if (referenceArchiveExport) break;
  if (attempt % 20 === 0) referenceArchiveStatus = await evaluate(`({view:document.querySelector('.view.active')?.id,title:document.querySelector('#progressTitle')?.textContent,detail:document.querySelector('#progressDetail')?.textContent,error:document.querySelector('#errorBanner span')?.textContent||''})`);
}
if (!referenceArchiveExport || referenceArchiveExport.format !== 'mac-analyzer-full-json' || referenceArchiveExport.version !== 2 || referenceArchiveExport.snapshotCount !== 6 || referenceArchiveExport.currentCount !== 5000 || referenceArchiveExport.inventoryCount !== 10004 || referenceArchiveExport.historyCount < 1 || !referenceArchiveExport.currentDevice?.id || referenceArchiveExport.name !== 'mac-analyzer-' + new Date().toISOString().slice(0,10) + '.macarchive.json') throw new Error(`Совместимый экспорт не сформировал полный отчёт MAC Analyzer Pro: ${JSON.stringify({export:referenceArchiveExport,status:referenceArchiveStatus})}`);
console.log("browser smoke: compatible MAC Analyzer Pro v2 export contains all selected Final, Inventory, and movement rows");
await evaluate(`(()=>{const archive={format:'mac-analyzer-full-json',version:2,exportedAt:'2026-10-15T00:00:00.000Z',analytics:{},workspace:{theme:'dark',dashboardSettings:{status:'all'}},currentDevices:[],allDevices:[{internalDeviceId:'DEV-REFERENCE-SMOKE',mac:'00:11:22:33:44:61',vendor:'Reference Vendor',model:'Reference Model'}],invalidRows:[],movementHistory:[{mac:'00:11:22:33:44:61',type:'Изменено',field:'vendor',before:'Old Vendor',after:'Reference Vendor',changedAt:'2026-10-15T11:00:00.000Z'}],snapshots:[{metadata:{id:'reference-smoke-final',name:'Reference imported Final',source:'reference.csv',kind:'Final',fileCreatedAt:'2026-10-15T10:00:00.000Z',savedAt:'2026-10-15T10:01:00.000Z',deviceCount:1,invalidCount:0},devices:[{internalDeviceId:'DEV-REFERENCE-SMOKE',mac:'00:11:22:33:44:61',vendor:'Reference Vendor',model:'Reference Model'}]}]};const input=document.querySelector('#importDatabaseInput');const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(archive)],'reference-smoke.macarchive.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return input.files[0]?.name})()`);
let referenceArchiveImport = null;
for (let attempt = 0; attempt < 120; attempt += 1) {
  await wait(250);
  referenceArchiveImport = await evaluate(`(()=>({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span')?.textContent||''}))()`);
  if (referenceArchiveImport.status.includes('7 Final') && referenceArchiveImport.status.includes('10 005')) break;
}
const referenceArchiveImportState = await evaluate(`(()=>{const dbName=new URL(location.href).searchParams.get('db');return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result;const tx=db.transaction(['settings','snapshots','inventory','history'],'readonly');const active=tx.objectStore('settings').get('activeSnapshotId');const imported=tx.objectStore('snapshots').get('reference-smoke-final');const device=tx.objectStore('inventory').get('DEV-REFERENCE-SMOKE');const history=tx.objectStore('history').count();tx.oncomplete=()=>{db.close();resolve({activeId:active.result?.value,snapshot:Boolean(imported.result),device:device.result?.manufacturer||'',historyCount:history.result})};tx.onerror=()=>{db.close();reject(tx.error)}}})})()`);
if (referenceArchiveImport?.error || !referenceArchiveImport.status.includes('7 Final') || !/10\s*005/.test(referenceArchiveImport.status) || referenceArchiveImportState.activeId !== stressChunkState.activeSnapshotId || !referenceArchiveImportState.snapshot || referenceArchiveImportState.device !== 'Reference Vendor' || referenceArchiveImportState.historyCount < 1) throw new Error(`Эталонный .macarchive.json не импортировался добавочно или вытеснил более новый Final: ${JSON.stringify({referenceArchiveImport,referenceArchiveImportState,expectedActiveId:stressChunkState.activeSnapshotId})}`);
console.log("browser smoke: reference .macarchive.json v2 imports additively without replacing the newer active Final");

console.log(JSON.stringify({ initial, finalState, smartroomMappingConfirmation, analytics: analyticsText.trim(), firstBatch, repeatedBatch, finalBatchState, queuedScheduleSummary, completedScheduledQueue, timedQueueCompleted, restartedState, staleAliasState, referenceArchiveImport, referenceArchiveImportState, ok: true }));
await command("Browser.close");
socket.close();

