// M04 part 2: session issuance/verification/revocation against
// identity.sessions. Not wired into any route yet.

import crypto from "node:crypto";

const TOKEN_PREFIX = "pfu_"; // "Phone Farm user session" — distinct from siteStore.js's "pfs_" site tokens.
const DEFAULT_TTL_MS = 30 * 24 * 3_600_000; // 30 days, matching a typical "remember me" web session.

function newToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createIdentitySessionService({ repository, now = () => new Date() }) {
  if (!repository) throw new TypeError("identity session service requires a repository");

  return {
    // Returns { token, session }. The token is returned exactly once here —
    // only its hash is ever persisted or retrievable again.
    async issueSession({ userId, ttlMs = DEFAULT_TTL_MS, ip, userAgent, deviceLabel }) {
      const token = newToken();
      const expiresAt = new Date(now().getTime() + ttlMs);
      const session = await repository.create({ userId, tokenHash: hashToken(token), expiresAt, ip, userAgent, deviceLabel });
      return { token, session };
    },

    // Returns the session row when the presented token is valid, active,
    // and unexpired; null otherwise. Does not touch last_seen_at itself —
    // callers that want that call touchSession() explicitly, so a mere
    // validity probe doesn't masquerade as real activity.
    async verifySession(token) {
      if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
      const session = await repository.getByTokenHash(hashToken(token));
      if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= now().getTime()) return null;
      return session;
    },

    async touchSession(sessionId) {
      await repository.touch(sessionId, now());
    },

    async revokeSession(sessionId) {
      return repository.revoke(sessionId);
    },

    async revokeAllSessionsForUser(userId) {
      return repository.revokeAllForUser(userId);
    },

    async listActiveSessions(userId) {
      return repository.listActiveForUser(userId);
    },
  };
}
