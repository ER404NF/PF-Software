// M04 part 6: Bearer-token authentication for the cloud API. A stateless
// per-request check (fail closed on any deviation) rather than trusting a
// cached identity, per this codebase's existing security lesson (see
// authStore.js's resolveOperator()/CLAUDE.md history for why re-checking on
// every request, not just at login, matters).
//
// Deliberately sets req.identitySession, not req.session: this API was
// designed and tested as its own standalone Express app, but Phase 1
// (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md) mounts it inside
// system/server/src/index.js, which already runs express-session on every
// request and depends on req.session being ITS OWN Session instance (with
// a real .touch() method) for the entire app's lifetime. Reusing the same
// property name here would silently clobber that object with this plain
// database row the moment this middleware ran on a mounted request — found
// only by actually mounting this API inside the real server and hitting it
// with a real HTTP request, not by testing this app in isolation.

export function createAuthenticate({ identitySessionService, userRepository }) {
  if (!identitySessionService) throw new TypeError("authenticate middleware requires identitySessionService");
  if (!userRepository) throw new TypeError("authenticate middleware requires userRepository");

  return async function authenticate(req, res, next) {
    const header = req.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) return res.status(401).json({ error: "authentication required" });

    const session = await identitySessionService.verifySession(token);
    if (!session) return res.status(401).json({ error: "invalid or expired session" });

    const user = await userRepository.getById(session.user_id);
    if (!user || user.status !== "active") return res.status(401).json({ error: "account is not active" });

    req.identitySession = session;
    req.user = user;
    req.userId = user.id;
    // Fire-and-forget: a slow audit write must never add latency to every
    // authenticated request, and its failure must never fail the request.
    void identitySessionService.touchSession(session.id).catch((error) => {
      console.error("Failed to record session activity:", error.message);
    });
    next();
  };
}
