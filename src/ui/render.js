export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function download(name, content, type = "application/octet-stream") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csv(rows, columns) {
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [columns.map((column) => quote(column.label)).join(";"), ...rows.map((row) => columns.map((column) => quote(row[column.key])).join(";"))].join("\r\n");
}

export function renderSelect(select, items, selected = "", emptyLabel = "Выберите") {
  select.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>${items.map((item) => {
    const value = typeof item === "string" ? item : item.value;
    const label = typeof item === "string" ? item : item.label;
    return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("")}`;
}

export function renderKpis(container, kpis, actions = {}) {
  const definitions = [
    ["devices", "Устройства"],
    ["modified", "Изменённые"],
    ["absent", "Отсутствуют"],
    ["unchanged", "Без изменений"],
    ["manufacturers", "Производители"],
    ["rooms", "Помещения"],
    ["withoutRoom", "Без помещения"],
    ["changedRooms", "Помещения с изменениями"],
    ["allChangedRooms", "Изменилось всё оборудование"],
    ["switchAnomalyRooms", "Разные IP коммутатора", "NEW"],
    ["codecChanges", "Изменения кодеков"],
  ];
  container.innerHTML = definitions.map(([key, label, badge]) => `
    <button class="kpi" type="button" data-kpi="${key}">
      <span>${escapeHtml(label)} ${badge ? `<b class="new-badge">${badge}</b>` : ""}</span>
      <strong>${Number(kpis[key] || 0).toLocaleString("ru-RU")}</strong>
    </button>`).join("");
  container.onclick = (event) => {
    const key = event.target.closest("[data-kpi]")?.dataset.kpi;
    if (key && actions[key]) actions[key]();
  };
}

export function renderRanked(container, items, empty = "Нет данных") {
  container.innerHTML = items.length
    ? items.map((item) => `<div class="rank-row"><span>${escapeHtml(item.label)}</span><strong>${Number(item.value).toLocaleString("ru-RU")}</strong></div>`).join("")
    : `<p class="empty">${escapeHtml(empty)}</p>`;
}

export function drawBars(canvas, items, { positive = "#087f5b", negative = "#c92a2a", label = "value" } = {}) {
  const context = canvas.getContext("2d");
  const ratio = devicePixelRatio || 1;
  const width = Math.max(320, canvas.clientWidth || 640);
  const height = Math.max(220, canvas.clientHeight || 260);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  if (!items.length) {
    context.fillStyle = getComputedStyle(document.body).color;
    context.textAlign = "center";
    context.fillText("Нет данных", width / 2, height / 2);
    return;
  }
  const values = items.flatMap((item) => Object.values(item).filter((value) => typeof value === "number"));
  const max = Math.max(1, ...values.map(Math.abs));
  const baseline = height / 2;
  const slot = (width - 56) / items.length;
  items.forEach((item, index) => {
    const value = Number(item[label] ?? item.value ?? 0);
    const barHeight = Math.abs(value) / max * (baseline - 40);
    context.fillStyle = value >= 0 ? positive : negative;
    context.fillRect(32 + index * slot + slot * 0.15, value >= 0 ? baseline - barHeight : baseline, slot * 0.7, barHeight);
    context.save();
    context.translate(32 + index * slot + slot / 2, height - 8);
    context.rotate(-0.45);
    context.fillStyle = getComputedStyle(document.body).color;
    context.font = "11px system-ui";
    context.textAlign = "right";
    context.fillText(String(item.label || "").slice(0, 18), 0, 0);
    context.restore();
  });
  context.strokeStyle = "#868e96";
  context.beginPath();
  context.moveTo(24, baseline);
  context.lineTo(width - 8, baseline);
  context.stroke();
}

export function drawWeekly(canvas, items) {
  drawBars(canvas, items.map((item) => ({ label: item.label, value: item.modified })));
  canvas.title = items.map((item) => `${item.label}: ${item.modified} изменений, ${item.rooms} помещений, ${item.macs} MAC`).join("\n");
}

export function showDialog(dialog, title, content) {
  dialog.querySelector("[data-dialog-title]").textContent = title;
  dialog.querySelector("[data-dialog-content]").innerHTML = content;
  dialog.showModal();
}

const DEVICE_COLUMNS = [
  ["mac", "MAC"],
  ["ip", "IP устройства"],
  ["switchIp", "IP коммутатора"],
  ["switchPort", "Порт"],
  ["manufacturer", "Производитель"],
  ["model", "Модель"],
  ["deviceType", "Тип"],
  ["hostname", "Hostname"],
  ["serial", "Serial"],
  ["deviceId", "Device ID"],
  ["smartroomId", "Smartroom ID"],
  ["room", "Помещение"],
  ["address", "Адрес"],
  ["authenticationTime", "Время аутентификации"],
  ["source", "Источник"],
];

export function deviceTable(devices, { anomaly = false } = {}) {
  return `<div class="table-scroll"><table class="data-table"><thead><tr>${anomaly ? "<th>Статус</th>" : ""}${DEVICE_COLUMNS.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${devices.map((device) => `<tr class="${device.anomaly ? "danger-row" : ""}">${anomaly ? `<td>${device.anomaly ? "Отклонение" : "Основной"}</td>` : ""}${DEVICE_COLUMNS.map(([key]) => `<td>${escapeHtml(device[key] || "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function roomAnomalyContent(anomalies) {
  if (!anomalies.length) return '<p class="empty">Отклонений IP коммутатора не найдено.</p>';
  return anomalies.map((room) => `
    <details class="room-card">
      <summary>
        <strong>${escapeHtml(room.room)}</strong>
        <span>${escapeHtml(room.smartroomId || "Нет Smartroom ID")}</span>
        <span>${room.deviceCount} устройств · ${room.switchCount} IP · ${room.deviationCount} отклонений</span>
      </summary>
      <p>${escapeHtml([room.businessUnit, room.city, room.site, room.floor, room.address].filter(Boolean).join(", "))}</p>
      <p>Основной IP коммутатора: <strong>${escapeHtml(room.dominantIp)}</strong></p>
      ${deviceTable(room.devices, { anomaly: true })}
    </details>`).join("");
}

export function comparisonContent(comparison) {
  const rows = comparison.modified.flatMap((row) => row.changes.map((change) => ({ ...change, mac: row.after.mac, room: row.after.room })));
  if (!rows.length) return '<p class="empty">Подтверждённых изменений нет.</p>';
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>MAC</th><th>Помещение</th><th>Поле</th><th>Было</th><th>Стало</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.mac)}</td><td>${escapeHtml(row.room)}</td><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.oldValue)}</td><td>${escapeHtml(row.newValue)}</td></tr>`).join("")}</tbody></table></div>`;
}

