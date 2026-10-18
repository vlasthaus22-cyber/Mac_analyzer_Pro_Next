export async function runCoalescedTask(state, task, { runningKey = "running", pendingKey = "pending" } = {}) {
  if (state[runningKey]) {
    state[pendingKey] = true;
    return false;
  }
  state[runningKey] = true;
  state[pendingKey] = true;
  try {
    while (state[pendingKey]) {
      state[pendingKey] = false;
      await task();
    }
    return true;
  } finally {
    state[runningKey] = false;
  }
}
