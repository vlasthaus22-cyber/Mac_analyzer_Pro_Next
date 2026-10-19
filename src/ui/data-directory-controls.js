export function dataDirectoryControlState({ supported, permission, handle, writeFailed = false, issue = "" }) {
  if (!supported) {
    return {
      picker: { hidden: true, disabled: true, text: "Выбрать папку" },
      reauthorize: { hidden: true, text: "Повторно разрешить папку" },
      status: "Доступ к папкам браузером не поддерживается; используйте portable archive.",
    };
  }

  const picker = {
    hidden: permission !== "unavailable",
    disabled: false,
    text: "Выбрать папку",
  };
  const reauthorize = {
    hidden: !handle || (permission === "granted" && !writeFailed) || permission === "unavailable",
    text: writeFailed ? "Выбрать другую папку" : "Повторно разрешить папку",
  };
  let status;

  if (!handle) {
    picker.hidden = false;
    status = "Папка не подключена.";
  } else {
    if (permission === "granted") {
      picker.hidden = Boolean(writeFailed);
      picker.text = "Сменить папку";
      status = issue || `Подключена «${handle.name || "папка данных"}» · синхронизация включена.`;
      reauthorize.hidden = !writeFailed;
    } else if (permission === "unavailable") {
      // A stale handle can outlive the browser permission API that created it.
      // Re-requesting access would be a dead action, so let the user pick a fresh handle.
      picker.hidden = false;
      picker.text = "Выбрать папку заново";
      reauthorize.hidden = true;
      status = "Не удалось проверить доступ к сохранённой папке. Выберите папку заново для продолжения.";
    } else {
      picker.hidden = true;
      picker.text = "Сменить папку";
      status = "Браузер сбросил разрешение. Разрешите доступ кнопкой в шапке, чтобы восстановить синхронизацию.";
      reauthorize.hidden = false;
    }
  }

  return { picker, reauthorize, status };
}
