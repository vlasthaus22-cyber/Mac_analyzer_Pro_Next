export function drawDashboardExportChart(context, chart, x, y, width, height, colors) {
  context.save();
  context.fillStyle = colors.text;
  context.font = "600 19px Segoe UI, sans-serif";
  context.fillText(chart.title, x + 16, y + 27);
  const plotX = x + 54;
  const plotWidth = width - 74;
  const isLine = chart.type === "line";
  const labels = isLine ? chart.labels || [] : null;
  const items = isLine ? [] : chart.items || [];
  const datasets = isLine ? chart.datasets || [] : [];
  const labelAt = (index) => isLine ? String(labels[index] ?? "") : String(chart.itemLabel ? chart.itemLabel(items[index]) : items[index]?.label ?? "");
  const valueAt = (item, index) => Number(isLine ? item.values?.[index] : chart.itemValue ? chart.itemValue(item) : item?.value) || 0;
  const labelCount = isLine ? labels.length : items.length;
  let plotY = y + 56;
  if (isLine) {
    let legendX = x + 16;
    const legendY = y + 49;
    for (const dataset of datasets) {
      const color = dataset.tone === "negative" ? colors.negative : dataset.tone === "primary" ? colors.blue : colors.positive;
      context.strokeStyle = color;
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(legendX, legendY - 4);
      context.lineTo(legendX + 19, legendY - 4);
      context.stroke();
      context.fillStyle = colors.muted;
      context.font = "12px Segoe UI, sans-serif";
      context.fillText(dataset.label, legendX + 25, legendY, 170);
      legendX += 25 + context.measureText(dataset.label).width + 26;
    }
    if (chart.summary) {
      context.fillStyle = colors.muted;
      context.font = "13px Segoe UI, sans-serif";
      context.fillText(chart.summary, x + 16, y + 70, width - 32);
    }
    plotY = y + (chart.summary ? 86 : 66);
  }
  const plotHeight = height - (plotY - y) - 56;
  if (!labelCount || isLine && !datasets.some((dataset) => Array.isArray(dataset.values) && dataset.values.length)) {
    context.fillStyle = colors.muted;
    context.font = "16px Segoe UI, sans-serif";
    context.fillText("Нет данных", plotX + 8, plotY + plotHeight / 2);
    context.restore();
    return;
  }
  let minimum = 0;
  let maximum = 0;
  if (isLine) {
    for (const dataset of datasets) for (let index = 0; index < dataset.values.length; index += 1) {
      const value = valueAt(dataset, index);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  } else {
    for (const item of items) {
      const value = valueAt(item, 0);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  if (minimum === maximum) maximum = minimum + 1;
  const range = maximum - minimum;
  const zeroY = plotY + (maximum / range) * plotHeight;
  context.strokeStyle = colors.grid;
  context.lineWidth = 1;
  for (let line = 0; line <= 4; line += 1) {
    const gridY = plotY + plotHeight * line / 4;
    context.beginPath();
    context.moveTo(plotX, gridY);
    context.lineTo(plotX + plotWidth, gridY);
    context.stroke();
  }
  const slotWidth = plotWidth / labelCount;
  if (isLine) {
    const pointX = (index) => labelCount === 1 ? plotX + plotWidth / 2 : plotX + index * slotWidth + slotWidth / 2;
    datasets.forEach((dataset) => {
      const color = dataset.tone === "negative" ? colors.negative : dataset.tone === "primary" ? colors.blue : colors.positive;
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 3;
      context.beginPath();
      for (let index = 0; index < dataset.values.length; index += 1) {
        const value = valueAt(dataset, index);
        const pointY = plotY + (maximum - value) / range * plotHeight;
        if (index === 0) context.moveTo(pointX(index), pointY);
        else context.lineTo(pointX(index), pointY);
      }
      context.stroke();
      for (let index = 0; index < dataset.values.length; index += 1) {
        const value = valueAt(dataset, index);
        const pointY = plotY + (maximum - value) / range * plotHeight;
        context.beginPath();
        context.arc(pointX(index), pointY, 4, 0, Math.PI * 2);
        context.fill();
      }
    });
  } else {
    const barWidth = Math.max(1, Math.min(28, slotWidth * 0.72));
    items.forEach((item, index) => {
      const value = valueAt(item, index);
      const valueY = plotY + (maximum - value) / range * plotHeight;
      context.fillStyle = value < 0 ? colors.negative : colors.positive;
      context.fillRect(plotX + index * slotWidth + (slotWidth - barWidth) / 2, Math.min(valueY, zeroY), barWidth, Math.max(1, Math.abs(zeroY - valueY)));
    });
  }
  context.strokeStyle = colors.axis;
  context.beginPath();
  context.moveTo(plotX, zeroY);
  context.lineTo(plotX + plotWidth, zeroY);
  context.stroke();
  context.fillStyle = colors.muted;
  context.font = "11px Segoe UI, sans-serif";
  context.textAlign = "center";
  const labelStep = Math.max(1, Math.ceil(labelCount / 15));
  for (let index = 0; index < labelCount; index += 1) {
    if (index % labelStep !== 0 && index !== labelCount - 1) continue;
    const itemLabel = labelAt(index);
    const maxCharacters = Math.max(3, Math.floor((slotWidth + 8) / 7));
    const label = itemLabel.length > maxCharacters ? `${itemLabel.slice(0, maxCharacters - 1)}…` : itemLabel;
    context.fillText(label, plotX + index * slotWidth + slotWidth / 2, y + height - 22, Math.max(30, slotWidth + 8));
  }
  context.textAlign = "start";
  context.restore();
}
