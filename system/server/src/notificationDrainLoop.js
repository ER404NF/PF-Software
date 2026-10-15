export function createNotificationDrainLoop({
  targets,
  intervalMs,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onFailure = () => {},
} = {}) {
  if (!Array.isArray(targets) || targets.some(target => !target?.outbox?.drain)) {
    throw new TypeError("notification drain loop requires outbox targets");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError("notification drain interval must be positive");
  let timer = null;
  let operation = null;

  function drain() {
    if (operation) return operation;
    const current = Promise.all(targets.map(async ({ name, outbox }) => {
      try { return await outbox.drain(); }
      catch (error) { onFailure(name, error); return null; }
    }));
    operation = current;
    current.finally(() => { if (operation === current) operation = null; }).catch(() => {});
    return current;
  }

  return {
    start() {
      if (timer) return;
      void drain();
      timer = setIntervalFn(() => { void drain(); }, intervalMs);
      timer?.unref?.();
    },
    async stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
      await operation;
    },
    drain,
    running: () => Boolean(timer),
  };
}
