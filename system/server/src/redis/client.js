// Redis client (M06). A factory, not a singleton module — like
// db/pool.js — so tests get a fully isolated client instead of sharing
// hidden module-level state.
//
// Per ADR-0003 (docs/productionization/adrs/ADR-0003-redis-ephemeral.md):
// Redis is ephemeral coordination only (rate limits, presence, short-lived
// locks, cache, bounded idempotency windows) — PostgreSQL stays
// authoritative for leases, approvals, tasks, sessions, billing, and audit.
// Nothing durable belongs behind this client.

import Redis from "ioredis";

export class RedisConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "RedisConfigError";
  }
}

// Kept separate from createRedisClient() so callers can validate
// configuration (e.g. at startup) without opening a socket.
export function resolveRedisConfig({
  url = process.env.REDIS_URL,
  connectTimeout = Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5_000,
  commandTimeout = Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 2_000,
  maxRetriesPerRequest = Number(process.env.REDIS_MAX_RETRIES_PER_REQUEST) || 3,
  tls,
} = {}) {
  if (typeof url !== "string" || !url) {
    throw new RedisConfigError("REDIS_URL (or an explicit url) is required");
  }
  // Managed providers (ElastiCache, Upstash, etc.) commonly require TLS with
  // a certificate chain the local trust store doesn't have; require an
  // explicit opt-out rather than silently disabling verification — same
  // convention as db/pool.js's DATABASE_SSL handling.
  const resolvedTls = tls !== undefined ? tls
    : process.env.REDIS_TLS === "false" ? undefined
      : process.env.REDIS_TLS === "no-verify" ? { rejectUnauthorized: false }
        : process.env.REDIS_TLS === "true" ? {}
          : undefined;
  return {
    url,
    options: {
      connectTimeout,
      commandTimeout,
      maxRetriesPerRequest,
      // Deliberately NOT enableOfflineQueue: false. ioredis connects
      // asynchronously in the background from the moment `new Redis()`
      // returns — the very first command issued (e.g. an immediate health
      // check right after construction) races that handshake, and
      // enableOfflineQueue: false makes ioredis reject any command sent
      // before the connection is actually established, not just one sent
      // to a genuinely dead server. This was caught only by running a real
      // health check against a real Redis the instant a client was
      // constructed — a mock has no handshake to race. The offline queue's
      // own risk (unbounded buildup while genuinely disconnected) is
      // already bounded here by commandTimeout/connectTimeout, and by
      // health.js's own timeoutMs wrapper for any caller that needs an
      // upper bound on "is Redis up" specifically.
      ...(resolvedTls !== undefined ? { tls: resolvedTls } : {}),
    },
  };
}

export function createRedisClient(options = {}) {
  const { url, options: redisOptions } = resolveRedisConfig(options);
  const client = new Redis(url, redisOptions);
  // A connection-level error (e.g. the server restarting) must never crash
  // the process — ioredis emits 'error' for any socket-level failure, and
  // Node terminates on an unhandled 'error' event with no listener attached.
  client.on("error", (error) => {
    console.error("Unexpected Redis client error:", error.message);
  });
  return client;
}
