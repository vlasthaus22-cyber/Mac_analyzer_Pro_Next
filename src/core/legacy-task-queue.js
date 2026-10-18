export async function runLegacyTaskQueue(taskId, {
  loadPage,
  updateItem,
  processItem,
  pageSize = 10,
  onProgress = () => {},
} = {}) {
  if (typeof taskId !== "string" || !taskId.trim()) throw new TypeError("Для запуска очереди нужен ID расписания");
  if ([loadPage, updateItem, processItem].some((callback) => typeof callback !== "function")) {
    throw new TypeError("Очереди нужны функции постраничного чтения, обновления и обработки файла");
  }
  const limit = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 10)));
  const summary = { processed: 0, done: 0, errors: 0 };
  let after = null;
  while (true) {
    const page = await loadPage(taskId, { after, limit });
    if (!page || !Array.isArray(page.rows)) throw new TypeError("Хранилище вернуло некорректную страницу очереди");
    for (const item of page.rows) {
      if (typeof item?.id !== "string" || !item.id) continue;
      summary.processed += 1;
      const startedAt = new Date().toISOString();
      await updateItem(item.id, { status: "running", startedAt, error: "" });
      try {
        const outcome = await processItem(item);
        const finishedAt = typeof outcome?.processedAt === "string" ? outcome.processedAt : new Date().toISOString();
        await updateItem(item.id, {
          status: "done", finishedAt, error: "",
          result: outcome?.result && typeof outcome.result === "object" ? outcome.result : {},
        });
        summary.done += 1;
      } catch (error) {
        const message = String(error?.message || error || "Ошибка обработки файла").slice(0, 2000);
        await updateItem(item.id, { status: "error", finishedAt: new Date().toISOString(), error: message });
        summary.errors += 1;
      }
      onProgress({ ...summary, filename: String(item.payload?.filename || item.id) });
    }
    if (!page.hasMore) break;
    if (!page.nextCursor) throw new Error("Постраничная очередь не вернула курсор продолжения");
    after = page.nextCursor;
  }
  return summary;
}
