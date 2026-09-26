// M04 part 5: email verification and password reset, sharing
// identity.email_action_tokens (see that migration's own header for why one
// table backs both). Neither sends email itself — mailSender.js already
// handles delivery for the current file-backed system and is the
// reasonable thing to wire this to, not reinvent. Not wired into any route
// yet.

import crypto from "node:crypto";

const TOKEN_PREFIX = "pfa_"; // "Phone Farm action" token — distinct from session/site/invitation prefixes.
const VERIFY_EMAIL_TTL_MS = 24 * 3_600_000; // 24 hours.
const PASSWORD_RESET_TTL_MS = 30 * 60_000; // 30 minutes — a reset link is more sensitive, shorter-lived.

function newToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createEmailActionService({
  pool, withTransaction, emailActionTokenRepository, userRepository, sessionRepository = null,
  hashPassword, now = () => new Date(),
}) {
  for (const [name, dep] of Object.entries({ pool, withTransaction, emailActionTokenRepository, userRepository, hashPassword })) {
    if (!dep) throw new TypeError(`email action service requires ${name}`);
  }

  async function issueToken({ userId, purpose, ttlMs }) {
    return withTransaction(pool, async (client) => {
      await emailActionTokenRepository.invalidateActiveForUser({ userId, purpose }, client);
      const token = newToken();
      const record = await emailActionTokenRepository.create({
        userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(now().getTime() + ttlMs),
      }, client);
      return { token, record };
    });
  }

  // Returns the token row when valid, unconsumed, and unexpired for the
  // given purpose; null otherwise. purpose is checked here (not just relied
  // on at issue time) so a password-reset token can never be replayed as an
  // email-verification token or vice versa.
  async function resolveToken(token, purpose) {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
    const record = await emailActionTokenRepository.getByTokenHash(hashToken(token));
    if (!record || record.purpose !== purpose || record.consumed_at
      || new Date(record.expires_at).getTime() <= now().getTime()) return null;
    return record;
  }

  return {
    async issueEmailVerificationToken(userId) {
      return issueToken({ userId, purpose: "verify_email", ttlMs: VERIFY_EMAIL_TTL_MS });
    },

    async confirmEmailVerification(token) {
      const record = await resolveToken(token, "verify_email");
      if (!record) return null;
      return withTransaction(pool, async (client) => {
        const consumed = await emailActionTokenRepository.consume(record.id, client);
        if (!consumed) return null; // consumed concurrently between resolveToken() and here
        return userRepository.markPrimaryEmailVerified(record.user_id, client);
      });
    },

    async issuePasswordResetToken(userId) {
      return issueToken({ userId, purpose: "password_reset", ttlMs: PASSWORD_RESET_TTL_MS });
    },

    // Resets the password and, when a session repository was provided,
    // revokes every existing session for that user — a password reset is a
    // strong security event that should end every other logged-in session,
    // not just add a new password alongside old, possibly-compromised ones.
    async resetPassword({ token, newPassword }) {
      const record = await resolveToken(token, "password_reset");
      if (!record) return null;
      return withTransaction(pool, async (client) => {
        const consumed = await emailActionTokenRepository.consume(record.id, client);
        if (!consumed) return null;
        const user = await userRepository.updatePasswordHash(record.user_id, hashPassword(newPassword), client);
        if (sessionRepository) await sessionRepository.revokeAllForUser(record.user_id, client);
        return user;
      });
    },
  };
}
