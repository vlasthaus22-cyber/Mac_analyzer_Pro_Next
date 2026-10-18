export function drawDashboardExportChart(context, chart, x, y, width, height, colors) {
  context.save();
  context.fillStyle = colors.text;
  context.font = "600 19px Segoe UI, sans-serif";
  context.fillText(chart.title, x + 16, y + 27);
  const plotX = x + 54;
  const plotWidth = width - 74;
  const isLine = chart.type === "line";
  const labels = isLine ? chart.labels || [] : (chart.items || []).map((item) => item.label);
  const datasets = isLine ? chart.datasets || [] : [];
  const values = isLine ? datasets.flatMap((dataset) => dataset.values || []) : (chart.items || []).map((item) => item.value);
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
  if (!labels.length || !values.length) {
    context.fillStyle = colors.muted;
    context.font = "16px Segoe UI, sans-serif";
    context.fillText("Нет данных", plotX + 8, plotY + plotHeight / 2);
    context.restore();
    return;
  }
  let minimum = Math.min(0, ...values);
  let maximum = Math.max(0, ...values);
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
  const slotWidth = plotWidth / labels.length;
  if (isLine) {
    const pointX = (index) => labels.length === 1 ? plotX + plotWidth / 2 : plotX + index * slotWidth + slotWidth / 2;
    datasets.forEach((dataset) => {
      const color = dataset.tone === "negative" ? colors.negative : dataset.tone === "primary" ? colors.blue : colors.positive;
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 3;
      context.beginPath();
      dataset.values.forEach((value, index) => {
        const pointY = plotY + (maximum - value) / range * plotHeight;
        if (index === 0) context.moveTo(pointX(index), pointY);
        else context.lineTo(pointX(index), pointY);
      });
      context.stroke();
      dataset.values.forEach((value, index) => {
        const pointY = plotY + (maximum - value) / range * plotHeight;
        context.beginPath();
        context.arc(pointX(index), pointY, 4, 0, Math.PI * 2);
        context.fill();
      });
    });
  } else {
    const barWidth = Math.max(1, Math.min(28, slotWidth * 0.72));
    chart.items.forEach((item, index) => {
      const valueY = plotY + (maximum - item.value) / range * plotHeight;
      context.fillStyle = item.value < 0 ? colors.negative : colors.positive;
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
  const labelStep = Math.max(1, Math.ceil(labels.length / 15));
  labels.forEach((itemLabel, index) => {
    if (index % labelStep !== 0 && index !== labels.length - 1) return;
    const maxCharacters = Math.max(3, Math.floor((slotWidth + 8) / 7));
    const label = itemLabel.length > maxCharacters ? `${itemLabel.slice(0, maxCharacters - 1)}…` : itemLabel;
    context.fillText(label, plotX + index * slotWidth + slotWidth / 2, y + height - 22, Math.max(30, slotWidth + 8));
  });
  context.textAlign = "start";
  context.restore();
}
