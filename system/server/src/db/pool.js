// PostgreSQL connection pool (M03). A factory, not a singleton module — like
// taskQueue.js's createTaskQueue — so tests get a fully isolated pool
// instead of sharing hidden module-level state.
//
// Nothing in the application imports/constructs this yet (M04+ work). This
// exists so the connection/pooling/health-check boundary is in place before
// any domain becomes database-authoritative, per
// docs/productionization/DATABASE_GAP_ANALYSIS.md.

import pg from "pg";

const { Pool } = pg;

export class DatabaseConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

// Kept separate from createPool() so callers can validate configuration
// (e.g. at startup) without opening a socket.
export function resolvePoolConfig({
  connectionString = process.env.DATABASE_URL,
  max = Number(process.env.DATABASE_POOL_MAX) || 10,
  idleTimeoutMillis = Number(process.env.DATABASE_IDLE_TIMEOUT_MS) || 30_000,
  connectionTimeoutMillis = Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 5_000,
  statementTimeoutMillis = Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS) || 30_000,
  ssl,
} = {}) {
  if (typeof connectionString !== "string" || !connectionString) {
    throw new DatabaseConfigError("DATABASE_URL (or an explicit connectionString) is required");
  }
  if (!Number.isFinite(max) || max < 1) throw new DatabaseConfigError("database pool max must be a positive number");
  // Managed providers (RDS, Cloud SQL, etc.) commonly require TLS with a
  // certificate chain the local trust store doesn't have; require an
  // explicit opt-out rather than silently disabling verification.
  const resolvedSsl = ssl !== undefined ? ssl
    : process.env.DATABASE_SSL === "false" ? false
      : process.env.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false }
        : process.env.DATABASE_SSL === "true" ? true
          : undefined;
  return {
    connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    statement_timeout: statementTimeoutMillis,
    ...(resolvedSsl !== undefined ? { ssl: resolvedSsl } : {}),
  };
}

export function createPool(options = {}) {
  const config = resolvePoolConfig(options);
  const pool = new Pool(config);
  // A pool-level error (e.g. an idle client's connection dropped) must never
  // crash the process — it would otherwise surface as an unhandled 'error'
  // event, per the pg library's own documented requirement.
  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error on an idle client:", error.message);
  });
  return pool;
}
