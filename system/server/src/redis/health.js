import { operationalErrorKind } from "../safeOperationalLog.js";

function timeoutError() {
  return Object.assign(new Error("redis health check timed out"), { code: "HEALTH_CHECK_TIMEOUT" });
}

export async function checkRedisHealth(client, { timeoutMs = 2_000 } = {}) {
  const startedAt = Date.now();
  try {
    await Promise.race([
      client.ping(),
      new Promise((_, reject) => setTimeout(() => reject(timeoutError()), timeoutMs)),
    ]);
    return { healthy: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { healthy: false, latencyMs: Date.now() - startedAt, errorKind: operationalErrorKind(error) };
  }
}
