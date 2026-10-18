import test from "node:test";
import assert from "node:assert/strict";
import { createDailyScheduler, createSerialQueue, nextIntervalExecution, nextLocalExecution, normalizeScheduleName } from "../src/core/daily-scheduler.js";

function fakeClock(initialTime) {
  let time = initialTime.getTime();
  let nextId = 0;
  const timers = new Map();
  return {
    timers,
    now: () => new Date(time),
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, due: time + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    async runNext() {
      const next = [...timers.entries()].sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) throw new Error("No scheduled timer");
      timers.delete(next[0]);
      time = next[1].due;
      next[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("independent named schedules share a serial runner and recover after a failed task", async () => {
  const queue = createSerialQueue();
  const events = [];
  let active = 0;
  const task = (name, { fail = false } = {}) => queue.enqueue(async () => {
    active += 1;
    assert.equal(active, 1, "scheduled queues must never overlap their Final transactions");
    events.push(`${name}:start`);
    await Promise.resolve();
    active -= 1;
    events.push(`${name}:end`);
    if (fail) throw new Error(`${name} failed`);
    return name;
  });

  const first = task("daily");
  const second = task("nightly", { fail: true });
  const third = task("weekly");
  assert.equal(await first, "daily");
  await assert.rejects(second, /nightly failed/);
  assert.equal(await third, "weekly");
  assert.deepEqual(events, ["daily:start", "daily:end", "nightly:start", "nightly:end", "weekly:start", "weekly:end"]);
});

test("schedule names trim whitespace, enforce the UI limit, and reject duplicates case-insensitively", () => {
  assert.equal(normalizeScheduleName("  Nightly  ", ["Daily"]), "Nightly");
  assert.throws(() => normalizeScheduleName("  "), /Укажите название/);
  assert.throws(() => normalizeScheduleName("nightly", ["Nightly"]), /уже существует/);
  assert.throws(() => normalizeScheduleName("x".repeat(81)), /80 символов/);
});

test("daily scheduler chooses the selected local time later today", () => {
  const now = new Date(2026, 0, 10, 8, 30, 45, 300);
  const next = nextLocalExecution(9, 15, now);
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 0);
  assert.equal(next.getDate(), 10);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 15);
  assert.equal(next.getSeconds(), 0);
  assert.equal(next.getMilliseconds(), 0);
});

test("daily scheduler rolls an elapsed time to the next local calendar day", () => {
  const now = new Date(2026, 0, 10, 9, 15, 0, 0);
  const next = nextLocalExecution(9, 15, now);
  const expected = new Date(now.getTime());
  expected.setDate(expected.getDate() + 1);
  assert.equal(next.getTime(), expected.getTime());
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 15);
});

test("daily scheduler validates the local hour and minute", () => {
  const now = new Date(2026, 0, 10, 8, 30);
  assert.throws(() => nextLocalExecution(-1, 0, now), /Час запуска/);
  assert.throws(() => nextLocalExecution(24, 0, now), /Час запуска/);
  assert.throws(() => nextLocalExecution(9, -1, now), /Минута запуска/);
  assert.throws(() => nextLocalExecution(9, 60, now), /Минута запуска/);
});

test("daily scheduler rejects an invalid current date", () => {
  assert.throws(() => nextLocalExecution(9, 0, new Date(Number.NaN)), /корректная локальная дата/);
});

test("interval scheduler validates minutes and computes an exact next date", () => {
  const now = new Date(2026, 0, 10, 8, 30, 15, 250);
  assert.equal(nextIntervalExecution(15, now).getTime(), now.getTime() + 15 * 60_000);
  assert.throws(() => nextIntervalExecution(0, now), /целым числом не меньше минуты/);
  assert.throws(() => nextIntervalExecution(1.5, now), /целым числом не меньше минуты/);
  assert.throws(() => nextIntervalExecution(1, new Date(Number.NaN)), /корректная локальная дата/);
});

test("interval scheduler resumes from the persisted first run time, including a task already due", async () => {
  const clock = fakeClock(new Date(2026, 0, 10, 8, 30));
  const runs = [];
  const scheduler = createDailyScheduler({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    run: async ({ scheduledAt }) => { runs.push(scheduledAt); },
  });
  scheduler.start({ intervalMinutes: 60, firstRunAt: new Date(2026, 0, 10, 8, 0) });
  assert.equal(clock.timers.size, 1);
  await clock.runNext();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].getTime(), new Date(2026, 0, 10, 8, 0).getTime());
  assert.equal(scheduler.state.nextAt.getTime(), clock.now().getTime() + 60 * 60_000);
  assert.throws(() => scheduler.start({ intervalMinutes: 5, firstRunAt: "not-a-date" }), /корректную дату/);
});

test("one-time schedule runs once and then becomes inactive", async () => {
  const clock = fakeClock(new Date(2026, 0, 10, 8, 30));
  const runs = [];
  const phases = [];
  const scheduler = createDailyScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    run: async (context) => { runs.push(context); return "saved"; },
    onStatus: ({ phase }) => phases.push(phase),
  });

  scheduler.start({ hour: 9, minute: 0, repeatDaily: false });
  assert.equal(clock.timers.size, 1);
  await clock.runNext();

  assert.equal(runs.length, 1);
  assert.equal(runs[0].runs, 1);
  assert.equal(scheduler.state.active, false);
  assert.equal(scheduler.state.lastResult, "saved");
  assert.deepEqual(phases, ["scheduled", "running", "complete"]);
  assert.equal(clock.timers.size, 0);
});

test("daily schedule waits for each serial run before planning the next local day", async () => {
  const clock = fakeClock(new Date(2026, 0, 10, 8, 30));
  let active = 0;
  let peak = 0;
  const runs = [];
  const scheduler = createDailyScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    run: async (context) => {
      active += 1;
      peak = Math.max(peak, active);
      runs.push(context);
      await Promise.resolve();
      active -= 1;
      return context.runs;
    },
  });

  scheduler.start({ hour: 9, minute: 0, repeatDaily: true });
  await clock.runNext();
  assert.equal(runs.length, 1);
  assert.equal(peak, 1);
  assert.equal(scheduler.state.active, true);
  assert.equal(scheduler.state.lastResult, 1);
  assert.equal(clock.timers.size, 1);
  const tomorrow = new Date(2026, 0, 11, 9, 0);
  assert.equal([...clock.timers.values()][0].due, tomorrow.getTime());
});

test("interval schedule repeats serially after each completed run", async () => {
  const clock = fakeClock(new Date(2026, 0, 10, 8, 30));
  let active = 0;
  let peak = 0;
  const runs = [];
  const scheduler = createDailyScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    run: async ({ runs: count }) => {
      active += 1;
      peak = Math.max(peak, active);
      runs.push(count);
      await Promise.resolve();
      active -= 1;
    },
  });
  scheduler.start({ intervalMinutes: 15, repeatDaily: true });
  assert.equal([...clock.timers.values()][0].due, new Date(2026, 0, 10, 8, 45).getTime());
  await clock.runNext();
  assert.deepEqual(runs, [1]);
  assert.equal(peak, 1);
  assert.equal(scheduler.state.active, true);
  assert.equal([...clock.timers.values()][0].due, new Date(2026, 0, 10, 9, 0).getTime());
  await clock.runNext();
  assert.deepEqual(runs, [1, 2]);
  scheduler.stop();
});

test("long intervals use bounded timers and one-time intervals finish after one run", async () => {
  const clock = fakeClock(new Date(2026, 0, 10, 8, 30));
  let runs = 0;
  const scheduler = createDailyScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    run: async () => { runs += 1; },
  });
  scheduler.start({ intervalMinutes: 100_000, repeatDaily: true });
  assert.ok([...clock.timers.values()][0].due - clock.now().getTime() <= 0x7fffffff);
  await clock.runNext();
  assert.equal(runs, 0);
  assert.equal(scheduler.state.active, true);
  scheduler.stop();

  scheduler.start({ intervalMinutes: 2, repeatDaily: false });
  await clock.runNext();
  assert.equal(runs, 1);
  assert.equal(scheduler.state.active, false);
});

test("stopped daily schedule clears its timer and ignores a stale callback", async () => {
  const clock = fakeClock(new Date(2026, 0, 10, 8, 30));
  let runs = 0;
  const scheduler = createDailyScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    run: async () => { runs += 1; },
  });
  scheduler.start({ hour: 9, minute: 0 });
  const staleCallback = [...clock.timers.values()][0].callback;
  scheduler.stop();
  staleCallback();
  await Promise.resolve();
  assert.equal(clock.timers.size, 0);
  assert.equal(runs, 0);
  assert.equal(scheduler.state.active, false);
});

test("failed daily run records the error and still plans the next day", async () => {
  const clock = fakeClock(new Date(2026, 0, 10, 8, 30));
  const scheduler = createDailyScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    run: async () => { throw new Error("cycle failed"); },
  });
  scheduler.start({ hour: 9, minute: 0, repeatDaily: true });
  await clock.runNext();
  assert.equal(scheduler.state.active, true);
  assert.match(scheduler.state.lastError.message, /cycle failed/);
  assert.equal(clock.timers.size, 1);
});
