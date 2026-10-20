const DEFAULT_EXTENSIONS = Object.freeze([".csv", ".tsv", ".txt", ".json", ".xlsx", ".xlsm", ".xls"]);

function isFileTransfer(event) {
  return Array.from(event?.dataTransfer?.types || []).includes("Files");
}

function fileExtension(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot < 0 ? "" : String(name).slice(dot).toLowerCase();
}

function bindFileDrop(target, status, onFiles, { extensions = DEFAULT_EXTENSIONS, multiple = false } = {}) {
  if (!target || typeof target.addEventListener !== "function" || typeof onFiles !== "function") return false;
  if (target.dataset?.sourceFileDropBound === "true") return false;
  if (target.dataset) target.dataset.sourceFileDropBound = "true";
  const allowed = new Set(extensions.map((extension) => String(extension).toLowerCase()));
  let depth = 0;

  const clear = () => {
    depth = 0;
    target.classList?.remove("file-drop-active");
  };
  target.addEventListener("dragenter", (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    depth += 1;
    target.classList?.add("file-drop-active");
  });
  target.addEventListener("dragover", (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  target.addEventListener("dragleave", (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) target.classList?.remove("file-drop-active");
  });
  target.addEventListener("drop", (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    clear();
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) {
      if (status) status.textContent = "В перетаскивании нет файла.";
      return;
    }
    if (!multiple && files.length !== 1) {
      if (status) status.textContent = "Перетащите сюда один файл за раз.";
      return;
    }
    const accepted = files.filter((file) => allowed.has(fileExtension(file.name)));
    const rejected = files.filter((file) => !allowed.has(fileExtension(file.name)));
    if (!accepted.length) {
      if (status) status.textContent = `Формат ${fileExtension(files[0]?.name) || "без расширения"} не поддерживается. Выберите CSV, TSV, TXT, JSON, XLS, XLSX или XLSM.`;
      return;
    }
    onFiles(accepted);
    if (status && rejected.length) status.textContent = `Добавлено файлов: ${accepted.length}. Пропущено неподдерживаемых: ${rejected.length}.`;
  });
  return true;
}

export function bindSourceFileDrop(target, status, onFile, options = {}) {
  if (typeof onFile !== "function") return false;
  return bindFileDrop(target, status, (files) => onFile(files[0]), options);
}

export function bindSourceFilesDrop(target, status, onFiles, options = {}) {
  return bindFileDrop(target, status, onFiles, { ...options, multiple: true });
}
