// Synchronously-readable, durably-backed cache. Exists because several
// domains need a database/Redis-backed source of truth but are read from a
// hot path that cannot await I/O per call — the same constraint
// persistence/backgroundAuthorizationRepository.js's own header comment
// already documents: "a future database-backed identity source must publish
// a synchronously readable, refreshed snapshot behind this same boundary...
// rather than making the [caller's] dispatch loop itself async."
// docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md identifies three
// such domains — background authorization, platform accounts/policies, and
// presence — so this is built once, generically, rather than three times.
// Deliberately not under redis/ — its first real backend is PostgreSQL
// (postgresPolicyRepository.js), and the pattern applies equally to any
// durable backend, not specifically Redis.
//
// Shape: an in-memory Map is the only thing ever read synchronously. It is
// populated in full at construction (awaited once) and kept current by
// applying every local write to the map immediately, before the durable
// write is even sent — a reader in this same process never observes a
// write "go missing" while the durable side is in flight. An optional
// periodic refresh (`refreshIntervalMs`) re-loads the full snapshot from
// the backend so this process eventually sees writes made by ANOTHER
// process/instance — this is deliberately poll-based eventual consistency,
// not push-based invalidation (Redis keyspace notifications, LISTEN/NOTIFY,
// or similar), because a real multi-instance deployment to test push-based
// invalidation against does not exist in this environment; a short poll
// interval is a correct, honest, and testable stand-in.
//
// This module owns none of the actual domain semantics (what a "policy" or
// a "session" is) — callers provide `load`/`persist` for their own backend
// and get back a plain synchronous key-value surface.

export class SyncCacheError extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncCacheError";
  }
}

// load() -> Promise<Map|Array<[key, value]>|Record<string, value>> — the
//   full current snapshot, called once at construction and again on every
//   periodic refresh.
// persist(key, value) -> Promise<void> — called for every set(); value is
//   `undefined` for delete(). Rejections are reported via `onPersistError`
//   (never thrown back into the synchronous set()/delete() call) since a
//   durable-write failure must not un-do the synchronous in-memory update a
//   reader may already have observed — the cache optimistically leads, the
//   backend catches up, and a caller that needs write confirmation should
//   await the Promise `set()` returns itself.
export async function createSyncCache({
  load, persist,
  refreshIntervalMs = 0,
  onPersistError = (error) => console.error("SyncCache: durable write failed:", error.message),
  onRefreshError = (error) => console.error("SyncCache: periodic refresh failed:", error.message),
} = {}) {
  if (typeof load !== "function") throw new SyncCacheError("load() is required");
  if (typeof persist !== "function") throw new SyncCacheError("persist() is required");

  function toMap(snapshot) {
    if (snapshot instanceof Map) return new Map(snapshot);
    if (Array.isArray(snapshot)) return new Map(snapshot);
    if (snapshot && typeof snapshot === "object") return new Map(Object.entries(snapshot));
    throw new SyncCacheError("load() must resolve to a Map, an entries array, or a plain object");
  }

  let map = toMap(await load());
  let refreshTimer = null;

  async function refresh() {
    try {
      map = toMap(await load());
    } catch (error) {
      onRefreshError(error);
    }
  }

  if (refreshIntervalMs > 0) {
    refreshTimer = setInterval(refresh, refreshIntervalMs);
    refreshTimer.unref?.();
  }

  return {
    get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    has(key) {
      return map.has(key);
    },
    entries() {
      return [...map.entries()];
    },
    // Updates the synchronous read surface immediately, then fires the
    // durable write. Returns the persist Promise so a caller in an already-
    // async context (a route handler) can await confirmation; a caller in a
    // synchronous hot path can ignore the return value entirely and still
    // get a correct synchronous read on the very next line.
    set(key, value) {
      map.set(key, value);
      return persist(key, value).catch(onPersistError);
    },
    delete(key) {
      map.delete(key);
      return persist(key, undefined).catch(onPersistError);
    },
    refresh,
    stop() {
      if (refreshTimer) clearInterval(refreshTimer);
    },
  };
}
