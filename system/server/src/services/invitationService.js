// M04 part 3: organization invitation issuance/acceptance. Not wired into
// any route yet, and does not send email itself — mailSender.js already
// implements delivery for the existing file-backed account system and is
// the reasonable thing to wire this to later, not reinvent.
//
// Scope note: acceptInvitation() adds an EXISTING user (by id) to the
// inviting organization. It deliberately does not create a new user account
// from an invitation — that is a signup flow (choosing a password, etc.)
// this milestone did not build. A person with no account yet must sign up
// first (once that flow exists), then accept the invitation while
// authenticated.

import crypto from "node:crypto";

const TOKEN_PREFIX = "pfi_"; // "Phone Farm invitation" — distinct from session (pfu_) and site (pfs_) tokens.
const DEFAULT_TTL_MS = 7 * 24 * 3_600_000; // 7 days.

function newToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createInvitationService({
  pool, withTransaction, invitationRepository, membershipRepository, roleRepository, now = () => new Date(),
}) {
  for (const [name, dep] of Object.entries({ pool, withTransaction, invitationRepository, membershipRepository, roleRepository })) {
    if (!dep) throw new TypeError(`invitation service requires ${name}`);
  }

  return {
    async invite({ organizationId, email, invitedByUserId = null, roleKey = "va_operator", ttlMs = DEFAULT_TTL_MS }) {
      const role = await roleRepository.getByKey({ organizationId, key: roleKey });
      if (!role) throw new Error(`unknown role key: ${roleKey}`);
      const token = newToken();
      const invitation = await invitationRepository.create({
        organizationId,
        emailNormalized: email.trim().toLowerCase(),
        tokenHash: hashToken(token),
        invitedByUserId,
        expiresAt: new Date(now().getTime() + ttlMs),
        roleKey,
      });
      return { token, invitation };
    },

    // Returns the invitation row when the token is valid and unexpired,
    // regardless of accepted/revoked state, so a caller can show a
    // meaningful "already accepted" / "revoked" message rather than a bare
    // "invalid token".
    async resolveToken(token) {
      if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
      const invitation = await invitationRepository.getByTokenHash(hashToken(token));
      if (!invitation || new Date(invitation.expires_at).getTime() <= now().getTime()) return null;
      return invitation;
    },

    async acceptInvitation({ token, userId }) {
      const invitation = await this.resolveToken(token);
      if (!invitation) throw new Error("invitation is invalid or expired");
      if (invitation.accepted_at) throw new Error("invitation was already accepted");
      if (invitation.revoked_at) throw new Error("invitation was revoked");

      return withTransaction(pool, async (client) => {
        // Re-check inside the transaction: another request may have
        // accepted or revoked this same invitation between resolveToken()
        // above and here.
        const accepted = await invitationRepository.markAccepted(invitation.id, client);
        if (!accepted) throw new Error("invitation was accepted or revoked by someone else concurrently");

        const role = await roleRepository.getByKey({ organizationId: invitation.organization_id, key: invitation.role_key }, client);
        if (!role) throw new Error(`invitation references an unknown role key: ${invitation.role_key}`);

        const membership = await membershipRepository.add({ organizationId: invitation.organization_id, userId, status: "active" }, client);
        await roleRepository.assignToMembership({ membershipId: membership.id, roleId: role.id }, client);
        return membership;
      }, { organizationId: invitation.organization_id });
    },

    async revoke(invitationId) {
      return invitationRepository.markRevoked(invitationId);
    },

    async listForOrganization(organizationId) {
      return invitationRepository.listForOrganization(organizationId);
    },
  };
}
