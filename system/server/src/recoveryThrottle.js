const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_ACCOUNT_LIMIT = 3;
const DEFAULT_IP_LIMIT = 10;

function normalizedKey(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return key || "<missing>";
}

export function createRecoveryThrottle({
  windowMs = DEFAULT_WINDOW_MS,
  accountLimit = DEFAULT_ACCOUNT_LIMIT,
  ipLimit = DEFAULT_IP_LIMIT,
  now = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error("recovery throttle window must be positive");
  if (!Number.isSafeInteger(accountLimit) || accountLimit <= 0) throw new Error("recovery account limit must be positive");
  if (!Number.isSafeInteger(ipLimit) || ipLimit <= 0) throw new Error("recovery IP limit must be positive");

  const accounts = new Map();
  const ips = new Map();

  function consume(entries, key, limit, timestamp) {
    const existing = entries.get(key);
    const entry = !existing || timestamp - existing.startedAt >= windowMs
      ? { startedAt: timestamp, count: 0 }
      : existing;
    entry.count += 1;
    entries.set(key, entry);
    return entry.count <= limit;
  }

  function allow({ identifier, ip }) {
    const timestamp = now();
    const accountAllowed = consume(accounts, normalizedKey(identifier), accountLimit, timestamp);
    const ipAllowed = consume(ips, normalizedKey(ip), ipLimit, timestamp);
    return accountAllowed && ipAllowed;
  }

  return { allow };
}

// Authentication throttles keep their counters outside the browser session.
// A client therefore cannot reset its password or 2FA budget by discarding the
// cookie and starting a new login challenge.
export function createAuthenticationThrottle({
  windowMs = DEFAULT_WINDOW_MS,
  accountLimit = 5,
  ipLimit = 20,
  globalLimit = 100,
  now = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error("authentication throttle window must be positive");
  if (!Number.isSafeInteger(accountLimit) || accountLimit <= 0) throw new Error("authentication account limit must be positive");
  if (!Number.isSafeInteger(ipLimit) || ipLimit <= 0) throw new Error("authentication IP limit must be positive");
  if (!Number.isSafeInteger(globalLimit) || globalLimit <= 0) throw new Error("authentication global limit must be positive");
  const accounts = new Map();
  const ips = new Map();
  const global = new Map();

  function current(entries, key, timestamp) {
    const existing = entries.get(key);
    if (!existing || timestamp - existing.startedAt >= windowMs) {
      entries.delete(key);
      return null;
    }
    return existing;
  }

  function blocked({ identifier, ip }) {
    const timestamp = now();
    return (current(accounts, normalizedKey(identifier), timestamp)?.count ?? 0) >= accountLimit
      || (current(ips, normalizedKey(ip), timestamp)?.count ?? 0) >= ipLimit
      || (current(global, "all", timestamp)?.count ?? 0) >= globalLimit;
  }

  function fail({ identifier, ip }) {
    const timestamp = now();
    for (const [entries, key] of [
      [accounts, normalizedKey(identifier)],
      [ips, normalizedKey(ip)],
      [global, "all"],
    ]) {
      const entry = current(entries, key, timestamp) ?? { startedAt: timestamp, count: 0 };
      entry.count += 1;
      entries.set(key, entry);
    }
    return blocked({ identifier, ip });
  }

  function succeed({ identifier }) {
    accounts.delete(normalizedKey(identifier));
  }

  return { blocked, fail, succeed };
}
