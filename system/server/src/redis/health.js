// Redis health check (M06). Used by a future /healthz-style route and by
// startup checks; not wired into any route yet.

export async function checkRedisHealth(client, { timeoutMs = 2_000 } = {}) {
  const startedAt = Date.now();
  try {
    await Promise.race([
      client.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("redis health check timed out")), timeoutMs)),
    ]);
    return { healthy: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { healthy: false, latencyMs: Date.now() - startedAt, error: error.message };
  }
}
