export function cleanupPageHide(event, {
  abortActive = () => {},
  invalidatePending = () => {},
  intervalTimers = [],
  clearInterval = globalThis.clearInterval.bind(globalThis),
  stopSchedulers = [],
} = {}) {
  if (event?.persisted) return false;
  abortActive();
  invalidatePending();
  for (const timer of intervalTimers) if (timer) clearInterval(timer);
  for (const stop of stopSchedulers) stop();
  return true;
}
