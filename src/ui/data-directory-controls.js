export function dataDirectoryControlState({ supported, permission, handle, writeFailed = false, issue = "" }) {
  const picker = {
    hidden: !supported || permission !== "unavailable",
    disabled: !supported,
    text: "Выбрать папку",
  };
  const reauthorize = {
    hidden: !handle || (permission === "granted" && !writeFailed) || permission === "unavailable",
    text: writeFailed ? "Выбрать другую папку" : "Повторно разрешить папку",
  };
  let status;

  if (!supported) {
    status = "Доступ к папкам браузером не поддерживается; используйте portable archive.";
  } else if (!handle) {
    picker.hidden = false;
    status = "Папка не подключена.";
  } else {
    picker.hidden = permission !== "granted" || writeFailed;
    picker.text = "Сменить папку";
    if (permission === "granted") {
      status = issue || `Подключена «${handle.name || "папка данных"}» · синхронизация включена.`;
      reauthorize.hidden = !writeFailed;
    } else {
      status = "Браузер сбросил разрешение. Разрешите доступ кнопкой в шапке, чтобы восстановить синхронизацию.";
      reauthorize.hidden = false;
    }
  }

  return { picker, reauthorize, status };
}
