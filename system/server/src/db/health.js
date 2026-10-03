import { operationalErrorKind } from "../safeOperationalLog.js";

function timeoutError() {
  return Object.assign(new Error("database health check timed out"), { code: "HEALTH_CHECK_TIMEOUT" });
}

export async function checkDatabaseHealth(pool, { timeoutMs = 2_000 } = {}) {
  const startedAt = Date.now();
  try {
    const client = await pool.connect();
    try {
      await Promise.race([
        client.query("SELECT 1"),
        new Promise((_, reject) => setTimeout(() => reject(timeoutError()), timeoutMs)),
      ]);
      return { healthy: true, latencyMs: Date.now() - startedAt };
    } finally {
      client.release();
    }
  } catch (error) {
    return { healthy: false, latencyMs: Date.now() - startedAt, errorKind: operationalErrorKind(error) };
  }
}
