import { timingSafeEqual } from "node:crypto";

const METRICS_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{32,512}$/;

function matchesToken(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string" || !expected || candidate.length > 4096) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function registerMetricsRoutes({ app, httpMetrics, bearerToken = null }) {
  if (!app?.get || !httpMetrics?.render) throw new TypeError("metrics routes require an app and HTTP metrics owner");
  if (bearerToken !== null && !METRICS_TOKEN_RE.test(bearerToken)) {
    throw new TypeError("METRICS_BEARER_TOKEN must contain 32-512 token-safe characters");
  }
  app.get("/metrics", (req, res) => {
    if (!bearerToken) return res.status(404).end();
    const authorization = req.get?.("Authorization") ?? req.headers?.authorization;
    const candidate = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length) : null;
    if (!matchesToken(candidate, bearerToken)) {
      res.set?.("WWW-Authenticate", "Bearer");
      return res.status(401).end();
    }
    res.type("text/plain; version=0.0.4; charset=utf-8").send(httpMetrics.render());
  });
}
