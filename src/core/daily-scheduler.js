const MAX_TIMEOUT_DELAY = 0x7fffffff;

export function createSerialQueue() {
  let tail = Promise.resolve();
  return Object.freeze({
    enqueue(run) {
      if (typeof run !== "function") throw new TypeError("В очередь можно добавлять только функцию запуска");
      const result = tail.then(run, run);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  });
}

export function normalizeScheduleName(value, existingNames = []) {
  const name = String(value ?? "").trim();
  if (!name) throw new Error("Укажите название расписания");
  if (name.length > 80) throw new RangeError("Название расписания не может быть длиннее 80 символов");
  const key = name.toLocaleLowerCase("ru-RU");
  if (existingNames.some((existing) => String(existing ?? "").trim().toLocaleLowerCase("ru-RU") === key)) {
    throw new Error("Расписание с таким названием уже существует");
  }
  return name;
}

export function nextLocalExecution(hour, minute, now = new Date()) {
  const selectedHour = Number(hour);
  const selectedMinute = Number(minute);
  if (!Number.isInteger(selectedHour) || selectedHour < 0 || selectedHour > 23) {
    throw new RangeError("Час запуска должен быть от 0 до 23");
  }
  if (!Number.isInteger(selectedMinute) || selectedMinute < 0 || selectedMinute > 59) {
    throw new RangeError("Минута запуска должна быть от 0 до 59");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Для планировщика нужна корректная локальная дата");
  }
  const target = new Date(now.getTime());
  target.setHours(selectedHour, selectedMinute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
}

export function nextIntervalExecution(intervalMinutes, now = new Date()) {
  const interval = Number(intervalMinutes);
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError("Интервал запуска должен быть целым числом не меньше минуты");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("Для планировщика нужна корректная локальная дата");
  const targetTime = now.getTime() + interval * 60_000;
  const target = new Date(targetTime);
  if (!Number.isFinite(target.getTime())) throw new RangeError("Интервал запуска выходит за поддерживаемый диапазон дат");
  return target;
}

export function createDailyScheduler({
  run,
  now = () => new Date(),
  setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimer = globalThis.clearTimeout.bind(globalThis),
  onStatus = () => {},
} = {}) {
  if (typeof run !== "function") throw new TypeError("Планировщику нужна функция запуска очереди");
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") throw new TypeError("Планировщику нужны таймеры");
  if (typeof now !== "function" || typeof onStatus !== "function") throw new TypeError("Планировщику нужны часы и обработчик состояния");

  let timer = 0;
  let generation = 0;
  let active = false;
  let schedule = null;
  let runs = 0;
  let lastResult = null;
  let lastError = null;

  const status = (phase) => onStatus({ phase, active, nextAt: schedule?.nextAt || null, runs, lastResult, lastError });
  const plan = (token, initial = false) => {
    if (!active || token !== generation || !schedule) return null;
    if (initial && schedule.firstRunAt) {
      schedule.nextAt = schedule.firstRunAt;
      schedule.firstRunAt = null;
    } else {
      schedule.nextAt = schedule.intervalMinutes !== null
        ? nextIntervalExecution(schedule.intervalMinutes, now())
        : nextLocalExecution(schedule.hour, schedule.minute, now());
    }
    timer = setTimer(() => { void execute(token); }, Math.min(MAX_TIMEOUT_DELAY, Math.max(0, schedule.nextAt.getTime() - now().getTime())));
    status("scheduled");
    return schedule.nextAt;
  };
  const execute = async (token) => {
    if (!active || token !== generation || !schedule) return;
    timer = 0;
    const scheduledAt = schedule.nextAt;
    const remaining = scheduledAt.getTime() - now().getTime();
    if (remaining > 0) {
      timer = setTimer(() => { void execute(token); }, Math.min(MAX_TIMEOUT_DELAY, remaining));
      return;
    }
    schedule.nextAt = null;
    status("running");
    try {
      lastResult = await run({ scheduledAt, runs: runs + 1 });
      lastError = null;
      if (!active || token !== generation) return;
      runs += 1;
    } catch (error) {
      if (!active || token !== generation) return;
      lastError = error;
      runs += 1;
    }
    if (schedule.repeatDaily) plan(token);
    else {
      active = false;
      schedule = null;
      status("complete");
    }
  };

  return Object.freeze({
    start({ hour, minute, repeatDaily = true, intervalMinutes = null, firstRunAt = null } = {}) {
      const parsedFirstRunAt = firstRunAt === null || firstRunAt === undefined || firstRunAt === "" ? null : new Date(firstRunAt);
      if (parsedFirstRunAt && !Number.isFinite(parsedFirstRunAt.getTime())) throw new TypeError("Первый запуск расписания должен иметь корректную дату");
      const selected = {
        hour: Number(hour),
        minute: Number(minute),
        repeatDaily: Boolean(repeatDaily),
        intervalMinutes: intervalMinutes === null || intervalMinutes === undefined || intervalMinutes === "" ? null : Number(intervalMinutes),
        firstRunAt: parsedFirstRunAt,
        nextAt: null,
      };
      if (selected.intervalMinutes !== null) nextIntervalExecution(selected.intervalMinutes, now());
      else if (!selected.firstRunAt) nextLocalExecution(selected.hour, selected.minute, now());
      if (timer) clearTimer(timer);
      generation += 1;
      timer = 0;
      schedule = selected;
      runs = 0;
      lastResult = null;
      lastError = null;
      active = true;
      return plan(generation, true);
    },
    stop({ notify = true } = {}) {
      if (timer) clearTimer(timer);
      timer = 0;
      generation += 1;
      active = false;
      schedule = null;
      if (notify) status("stopped");
    },
    get state() {
      return { active, nextAt: schedule?.nextAt || null, runs, lastResult, lastError };
    },
  });
}
