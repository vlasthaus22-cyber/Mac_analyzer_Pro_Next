const port = Number(process.argv[2] || 9333);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.url.includes("MAC-Analyzer-Pro-Next"));
if (!target) throw new Error("Страница автономной программы не найдена в Edge");

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
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
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

await evaluate(`(async()=>{
  const assign=async(id,name,content)=>{
    const input=document.querySelector(id);
    const transfer=new DataTransfer();
    transfer.items.add(new File([content],name,{type:'text/csv'}));
    input.files=transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,250));
  };
  await assign('#mainFileInput','main_2026-10-14.csv','CallingStationID;NasIP;NasPortID;B_ReceiptTime\\n00:11:22:33:44:51;10.0.0.1;1;14.10.2026 10:00:00\\n00:11:22:33:44:52;10.0.0.1;2;14.10.2026 10:01:00\\n00:11:22:33:44:53;10.0.0.1;3;14.10.2026 10:02:00\\n00:11:22:33:44:54;10.0.0.2;4;14.10.2026 10:03:00');
  await assign('#smartroomFileInput','smartroom_2026-10-14.csv','MAC;IP адрес;Производитель;Модель;Тип модели;Smartroom ID локации;ТБ;Город;Площадка;Этаж;Название комнаты;Адрес локации\\n00:11:22:33:44:51;;Vendor;Model A;Video Conference;SR-1;ЦА;Москва;Кутузовский;3;Переговорная 1;Кутузовский 1\\n00:11:22:33:44:52;192.168.1.52;Vendor;Model B;Display;SR-1;ЦА;Москва;Кутузовский;3;Переговорная 1;Кутузовский 1\\n00:11:22:33:44:53;192.168.1.53;Vendor;Model C;Display;SR-1;ЦА;Москва;Кутузовский;3;Переговорная 1;Кутузовский 1\\n00:11:22:33:44:54;192.168.1.54;Vendor;Model D;Display;;ЦА;Москва;Кутузовский;3;Переговорная 1;Кутузовский 1');
  await assign('#ddioFileInput','ddio_2026-10-14.csv','Column2;Column3;Column9;Column10\\n192.168.1.51;00-11-22-33-44-51;;');
  document.querySelector('#runEnrichmentButton').click();
  return true;
})()`);

let finished = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await wait(250);
  const state = await evaluate(`({status:document.querySelector('#databaseStatus').textContent,error:!document.querySelector('#errorBanner').hidden,message:document.querySelector('#errorBanner span').textContent})`);
  if (state.error) throw new Error(`UI enrichment error: ${state.message}`);
  if (state.status.includes("1 Final")) { finished = true; break; }
}
if (!finished) throw new Error("Обогащение не завершилось за 15 секунд");

const finalState = await evaluate(`({
  status: document.querySelector('#databaseStatus').textContent,
  searchTable: document.querySelector('#deviceTable').textContent,
  summary: document.querySelector('#enrichmentSummary').textContent
})`);
if (!finalState.status.includes("4 устройств")) throw new Error(`Неверное число Inventory: ${finalState.status}`);
if (!finalState.searchTable.includes("192.168.1.51")) throw new Error(`DDIO IP не появился в финальной таблице: ${JSON.stringify(finalState)}`);

await evaluate(`document.querySelector('[data-view="analytics"]').click()`);
await wait(1000);
const analytics = await evaluate(`({text:document.querySelector('#analyticsKpis').textContent,error:!document.querySelector('#errorBanner').hidden})`);
if (analytics.error || !analytics.text.replace(/\s+/g, " ").includes("Разные IP коммутатора NEW 1")) {
  throw new Error(`Некорректная аналитика: ${JSON.stringify(analytics)}`);
}

console.log(JSON.stringify({ initial, finalState, analytics: analytics.text.replace(/\s+/g, " ").trim(), ok: true }));
await command("Browser.close");
socket.close();

