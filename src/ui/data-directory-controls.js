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
