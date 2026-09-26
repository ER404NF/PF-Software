// Database health check (M03). Used by a future /healthz-style route and by
// startup checks; not wired into any route yet (M04+).

export async function checkDatabaseHealth(pool, { timeoutMs = 2_000 } = {}) {
  const startedAt = Date.now();
  try {
    const client = await pool.connect();
    try {
      await Promise.race([
        client.query("SELECT 1"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("database health check timed out")), timeoutMs)),
      ]);
      return { healthy: true, latencyMs: Date.now() - startedAt };
    } finally {
      client.release();
    }
  } catch (error) {
    return { healthy: false, latencyMs: Date.now() - startedAt, error: error.message };
  }
}
