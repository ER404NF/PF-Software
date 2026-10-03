export function registerHealthRoutes({ app, databasePool = null, checkDatabaseHealth }) {
  if (!app?.get) throw new TypeError("health routes require an Express app");
  if (databasePool && typeof checkDatabaseHealth !== "function") {
    throw new TypeError("database-backed readiness requires checkDatabaseHealth");
  }

  // Liveness deliberately proves only that the process can answer HTTP.
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Readiness is intentionally separate: a deployment can keep the process
  // alive for diagnosis while removing it from service when its authoritative
  // database cannot be reached. Never return database exception text, DSNs,
  // hostnames, or credentials from this unauthenticated endpoint.
  app.get("/readyz", async (_req, res) => {
    if (!databasePool) {
      return res.json({ ok: true, checks: { database: { status: "not_required" } } });
    }
    try {
      const result = await checkDatabaseHealth(databasePool);
      const database = {
        status: result.healthy ? "ready" : "unavailable",
        latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
      };
      return res.status(result.healthy ? 200 : 503).json({ ok: result.healthy, checks: { database } });
    } catch {
      return res.status(503).json({ ok: false, checks: { database: { status: "unavailable", latencyMs: null } } });
    }
  });
}
