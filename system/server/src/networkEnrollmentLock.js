// The "one phone is being set up for networking at a time" lock. Enrolling a phone compares the Mac's
// network connections before and after the operator turns on Internet Sharing for it, so two phones can
// never be enrolled at once. The lock lives in memory (a restart simply means starting over), expires after
// a fixed time, and every change is announced so open pages update without asking.

export function createEnrollmentLock({
  ttlMs = 5 * 60_000,
  now = () => Date.now(),
  setTimeoutFn = (...args) => setTimeout(...args),
  clearTimeoutFn = (...args) => clearTimeout(...args),
  onExpire = () => {},
} = {}) {
  const entries = new Map(); // deviceId -> { ...data, createdAt, timer }
  const expired = new Set(); // phones whose enrollment just ran out (so Confirm can say so)
  const generations = new Map(); // also fences discover/start/stop work that has no pending entry

  function dropTimer(entry) {
    if (entry?.timer) clearTimeoutFn(entry.timer);
  }

  function expireIfDue(deviceId) {
    const entry = entries.get(deviceId);
    if (!entry || now() - entry.createdAt < ttlMs) return false;
    dropTimer(entry);
    entries.delete(deviceId);
    expired.add(deviceId);
    return true;
  }

  const lock = {
    ttlMs,

    advance(deviceId) {
      const generation = (generations.get(deviceId) ?? 0) + 1;
      generations.set(deviceId, generation);
      return generation;
    },

    generation(deviceId) {
      return generations.get(deviceId) ?? 0;
    },

    isCurrent(deviceId, generation, reservation = null) {
      if (lock.generation(deviceId) !== generation) return false;
      return !reservation || lock.get(deviceId) === reservation;
    },

    start(deviceId, data) {
      lock.clear(deviceId);
      expired.delete(deviceId);
      const entry = { ...data, createdAt: now() };
      // When the time is up every open page learns it without having to ask.
      entry.timer = setTimeoutFn(() => {
        if (expireIfDue(deviceId)) onExpire(deviceId);
      }, ttlMs + 250);
      entry.timer?.unref?.();
      entries.set(deviceId, entry);
      return entry;
    },

    // Claim the only enrollment slot before asynchronous snapshot work starts.
    // The returned object is also an opaque reservation token.
    tryStart(deviceId, data) {
      if (lock.active()) return null;
      return lock.start(deviceId, data);
    },

    update(deviceId, reservation, data) {
      const entry = lock.get(deviceId);
      if (!entry || entry !== reservation) return null;
      Object.assign(entry, data);
      return entry;
    },

    get(deviceId) {
      expireIfDue(deviceId);
      return entries.get(deviceId) ?? null;
    },

    // True once, right after this phone's enrollment ran out of time.
    consumeExpired(deviceId) {
      lock.get(deviceId);
      return expired.delete(deviceId);
    },

    has(deviceId) {
      return lock.get(deviceId) !== null;
    },

    clear(deviceId, reservation = null) {
      if (reservation && entries.get(deviceId) !== reservation) return false;
      dropTimer(entries.get(deviceId));
      return entries.delete(deviceId);
    },

    remainingMs(deviceId) {
      const entry = lock.get(deviceId);
      return entry ? ttlMs - (now() - entry.createdAt) : 0;
    },

    // The enrollment that is still waiting, if any.
    active() {
      for (const deviceId of [...entries.keys()]) {
        const entry = lock.get(deviceId);
        if (entry) return { deviceId, entry, remainingMs: ttlMs - (now() - entry.createdAt) };
      }
      return null;
    },

    // Another session of the same operator that has a pending enrollment for a different phone.
    pendingFor(predicate) {
      for (const deviceId of [...entries.keys()]) {
        const entry = lock.get(deviceId);
        if (entry && predicate(entry, deviceId)) return { deviceId, entry };
      }
      return null;
    },
  };
  return lock;
}
