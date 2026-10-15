function createTopologyTransition({ activeMode, stopHost, stopSite, stopClient }) {
  let pending = Promise.resolve();
  const stops = { host: stopHost, site: stopSite, client: stopClient };

  function transitionTo(target, { start, current = start, restore = async () => {} } = {}) {
    if (!stops[target] || typeof start !== "function") throw new TypeError("unknown desktop topology mode");
    const run = async () => {
      const previous = activeMode();
      if (previous === target) return current();
      for (const mode of Object.keys(stops)) {
        if (mode !== target) await stops[mode]();
      }
      try {
        return await start();
      } catch (error) {
        await stops[target]();
        try { await restore(previous); } catch (restoreError) { error.restoreError = restoreError; }
        throw error;
      }
    };
    const result = pending.catch(() => {}).then(run);
    pending = result;
    return result;
  }

  async function stopAll() {
    await pending.catch(() => {});
    for (const stop of Object.values(stops)) await stop();
  }

  return { transitionTo, stopAll };
}

module.exports = { createTopologyTransition };
