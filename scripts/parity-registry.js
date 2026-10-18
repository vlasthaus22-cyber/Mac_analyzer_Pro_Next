export function inspectParityRegistry(markdown, { exists = () => true } = {}) {
  const issues = [];
  const seen = new Set();
  const rows = [];
  for (const [index, line] of String(markdown || "").split(/\r?\n/).entries()) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const lineNumber = index + 1;
    if (cells.length !== 5) {
      issues.push(`Строка ${lineNumber}: ожидалось 5 колонок, найдено ${cells.length}`);
      continue;
    }
    const [rawId, requirement, implementation, tests, status] = cells;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) issues.push(`Строка ${lineNumber}: некорректный ID эталона`);
    else if (seen.has(id)) issues.push(`Строка ${lineNumber}: повторный ID эталона ${id}`);
    else seen.add(id);
    if (!requirement) issues.push(`Строка ${lineNumber}: пустое описание требования`);
    if (!status) issues.push(`Строка ${lineNumber}: отсутствует статус`);
    if (status && !/^(?:Полностью|Выполнено|Частично|Не закрыто|Не проверено|Не реализовано)(?:\s|:)/.test(status)) {
      issues.push(`Строка ${lineNumber}: статус должен явно обозначать полноту переноса`);
    }
    if (!implementation || implementation === "—") issues.push(`Строка ${lineNumber}: у пункта со статусом «${status}» нет модуля Next`);
    if (!tests || tests === "—") issues.push(`Строка ${lineNumber}: у пункта со статусом «${status}» нет теста Next`);
    for (const file of referencedFiles(implementation)) {
      if (!exists(file)) issues.push(`Строка ${lineNumber}: файл реализации не найден: ${file}`);
    }
    for (const file of referencedFiles(tests)) {
      if (!exists(file)) issues.push(`Строка ${lineNumber}: файл теста не найден: ${file}`);
    }
    rows.push({ id, requirement, implementation, tests, status, lineNumber });
  }
  if (!rows.length) issues.push("В реестре не найдены требования с числовыми ID");
  return { rows, issues };
}

function referencedFiles(value) {
  return [...new Set(String(value || "").match(/(?:\.\.\/|\.\/)?(?:[A-Za-z0-9_.*-]+\/)*[A-Za-z0-9_.*-]+\.(?:json|mjs|js|py|cmd|ps1|html|css|md|ya?ml|csv|txt|xlsx?)(?![A-Za-z0-9_-])/gi) || [])];
}
