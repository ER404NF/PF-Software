// M04 part 6: the cloud control-plane HTTP API — a self-contained Express
// app, not mounted into system/server/src/index.js (the existing single-
// tenant Human VA Mode server). This is new, additive infrastructure for
// the master productionization prompt's future multi-tenant commercial
// layer; it does not replace, and is not yet reachable through, the
// existing file-backed operator system. See
// docs/productionization/M04_ORGANIZATION_IDENTITY.md.
//
// Every route here is a thin translation from HTTP to the already-tested
// service layer (organizationIdentityService, identitySessionService,
// invitationService, identityMfaService, emailActionService) — no business
// logic lives in this file.

import express from "express";
import { createAuthenticate } from "./middleware/authenticate.js";
import { createRequireMembership } from "./middleware/requireMembership.js";
import { createRequirePermission } from "./middleware/requirePermission.js";

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, displayName: user.display_name, status: user.status };
}

function asyncRoute(fn) {
  return (req, res, next) => { fn(req, res, next).catch(next); };
}

export function createCloudApi({
  pool, withTransaction, organizationRepository, userRepository, membershipRepository, roleRepository,
  organizationIdentityService, identitySessionService, invitationService, identityMfaService, emailActionService,
  verifyPassword, hashPassword, validatePassword,
  // Optional: without these, every token-issuing flow still works exactly
  // as before (a real token is created), it just isn't emailed anywhere —
  // matching accountNotificationStore.js's own "unconfigured ⇒ no-op with
  // a logged reason" convention rather than a hard failure.
  mailSender = null, companyEmail = null,
  // Phase 1 (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md §3): this
  // internal rollout has exactly one organization, created once at startup
  // (db/defaultOrganization.js), and "no public 'create an account' route
  // should exist." POST /signup creates a brand-new organization — the
  // Phase 2 multi-tenant self-serve flow this handout explicitly defers.
  // Default true so every existing test/caller of createCloudApi() (which
  // predates Phase 1 and exercises the full multi-tenant M04 design) keeps
  // working unchanged; Phase 1's own mount point in index.js passes false.
  allowOrganizationSignup = true,
}) {
  for (const [name, dep] of Object.entries({
    pool, withTransaction, organizationRepository, userRepository, membershipRepository, roleRepository,
    organizationIdentityService, identitySessionService, invitationService, identityMfaService, emailActionService,
    verifyPassword, hashPassword, validatePassword,
  })) {
    if (!dep) throw new TypeError(`createCloudApi requires ${name}`);
  }

  // No web portal exists yet to link to (M12), so the email body carries
  // the raw token with instructions rather than a clickable link — a
  // documented interim shape, not a finished user experience.
  async function sendMail(to, subject, body) {
    if (!mailSender?.isConfigured?.()) {
      console.log(`Cloud API: SMTP is not configured — not sending "${subject}" to ${to}`);
      return;
    }
    try {
      await mailSender.send({ to, from: companyEmail, subject, body });
    } catch (error) {
      console.error(`Cloud API: failed to send "${subject}" to ${to}:`, error.message);
    }
  }

  const authenticate = createAuthenticate({ identitySessionService, userRepository });
  const requireMembership = createRequireMembership({ pool, withTransaction, organizationRepository, membershipRepository });
  const requirePermission = createRequirePermission({ roleRepository });

  const app = express();
  app.use(express.json());

  app.post("/signup", asyncRoute(async (req, res) => {
    if (!allowOrganizationSignup) {
      return res.status(404).json({ error: "not found" });
    }
    const { slug, displayName, ownerEmail, ownerPassword, ownerDisplayName } = req.body ?? {};
    if (!slug || !displayName || !ownerEmail || !ownerPassword) {
      return res.status(400).json({ error: "slug, displayName, ownerEmail, and ownerPassword are required" });
    }
    validatePassword(ownerPassword);
    const { organization, user, membership } = await organizationIdentityService.createOrganizationWithOwner({
      slug, displayName, ownerEmail, ownerPassword, ownerDisplayName,
    });
    const { token: verifyToken } = await emailActionService.issueEmailVerificationToken(user.id);
    void sendMail(ownerEmail, "Verify your Phone Farm account",
      `Welcome to ${displayName}. Verify your email with this code: ${verifyToken}`);
    res.status(201).json({ organization, user: publicUser(user), membershipId: membership.id });
  }));

  // Completes an invitation for someone with no existing account —
  // acceptInvitation() (used by /invitations/accept) only ever adds an
  // *existing* user; this route creates the user first, using the
  // invitation's own email (never a client-supplied one, so the new
  // account can't be created under a different address than what was
  // actually invited).
  app.post("/signup-from-invitation", asyncRoute(async (req, res) => {
    const { token, password, displayName } = req.body ?? {};
    if (!token || !password) return res.status(400).json({ error: "token and password are required" });
    validatePassword(password);

    const invitation = await invitationService.resolveToken(token);
    if (!invitation) return res.status(400).json({ error: "invalid or expired invitation" });
    if (invitation.accepted_at) return res.status(400).json({ error: "invitation was already accepted" });
    if (invitation.revoked_at) return res.status(400).json({ error: "invitation was revoked" });

    const user = await userRepository.createWithPrimaryEmail({
      email: invitation.email_normalized, passwordHash: hashPassword(password), displayName: displayName ?? null,
    });
    // Completing an emailed invitation link already proves control of this
    // address (once mailSender actually delivers the invitation below), so
    // this skips the separate email-verification round trip rather than
    // making a just-invited person prove the same thing twice.
    await userRepository.markPrimaryEmailVerified(user.id);
    const membership = await invitationService.acceptInvitation({ token, userId: user.id });
    const { token: sessionToken } = await identitySessionService.issueSession({
      userId: user.id, ip: req.ip, userAgent: req.headers["user-agent"] ?? null,
    });
    res.status(201).json({ token: sessionToken, user: publicUser(user), membershipId: membership.id });
  }));

  app.post("/login", asyncRoute(async (req, res) => {
    const { email, password, mfaCode } = req.body ?? {};
    if (typeof email !== "string" || !email || typeof password !== "string" || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    // Constant response shape whether the email is unknown or the password
    // is wrong — matches this codebase's existing non-enumerating login
    // response convention (see authStore.js).
    const user = await userRepository.getByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash) || user.status !== "active") {
      return res.status(401).json({ error: "invalid email or password" });
    }

    const mfaMethods = await identityMfaService.listActiveMethods(user.id);
    const verifiedMfa = mfaMethods.filter((m) => m.verified_at);
    if (verifiedMfa.length > 0) {
      if (!mfaCode) return res.status(401).json({ error: "mfa code required" });
      const matchedMethodId = await identityMfaService.verifyLogin({ userId: user.id, code: mfaCode });
      if (!matchedMethodId) return res.status(401).json({ error: "invalid mfa code" });
    }

    const { token } = await identitySessionService.issueSession({
      userId: user.id, ip: req.ip, userAgent: req.headers["user-agent"] ?? null,
    });
    res.json({ token, user: publicUser(user) });
  }));

  app.post("/logout", authenticate, asyncRoute(async (req, res) => {
    await identitySessionService.revokeSession(req.identitySession.id);
    res.status(204).end();
  }));

  app.get("/me", authenticate, asyncRoute(async (req, res) => {
    const memberships = await withTransaction(
      pool,
      (client) => membershipRepository.listForUser(req.userId, client),
      { userId: req.userId },
    );
    res.json({ user: publicUser(req.user), memberships });
  }));

  app.post("/organizations/:organizationId/invitations", authenticate, requireMembership(), requirePermission("member:invite"),
    asyncRoute(async (req, res) => {
      const { email, roleKey } = req.body ?? {};
      if (!email || !roleKey) return res.status(400).json({ error: "email and roleKey are required" });
      const { token: inviteToken, invitation } = await invitationService.invite({
        organizationId: req.organization.id, email, roleKey, invitedByUserId: req.userId,
      });
      void sendMail(email, `You've been invited to ${req.organization.display_name}`,
        `${req.user.display_name ?? "Someone"} invited you to join ${req.organization.display_name} on Phone Farm. `
        + `Use this invitation code to join: ${inviteToken}`);
      res.status(201).json({ invitationId: invitation.id, expiresAt: invitation.expires_at });
    }));

  app.post("/invitations/accept", authenticate, asyncRoute(async (req, res) => {
    const { token } = req.body ?? {};
    if (!token) return res.status(400).json({ error: "token is required" });
    const membership = await invitationService.acceptInvitation({ token, userId: req.userId });
    res.status(201).json({ membershipId: membership.id, organizationId: membership.organization_id });
  }));

  // Any active member may see the roster (no dedicated "member:view"
  // permission exists in the seeded catalog — matches the common SaaS
  // default that team visibility itself isn't privileged, only managing it
  // is). Requires the same transaction-scoped, RLS-protected read as /me.
  app.get("/organizations/:organizationId/members", authenticate, requireMembership(), asyncRoute(async (req, res) => {
    const members = await withTransaction(
      pool,
      (client) => membershipRepository.listForOrganization(req.organization.id, client),
      { organizationId: req.organization.id },
    );
    res.json({ members });
  }));

  // Suspends or reactivates a member's own standing in the organization —
  // the enforcement side already exists (requireMembership() itself 403s a
  // non-active membership on every other route); this is the missing
  // admin-facing way to change that status. Deliberately does not allow a
  // caller to change their OWN membership through this route — the simplest
  // way to prevent an org accidentally locking out its only active manager/
  // owner is to require a *different* member to do it. Hard deletion is out
  // of scope here (M16's account-deletion lifecycle, not this route).
  const MEMBERSHIP_STATUSES = new Set(["active", "suspended", "removed"]);
  app.patch("/organizations/:organizationId/members/:membershipId", authenticate, requireMembership(), requirePermission("member:manage"),
    asyncRoute(async (req, res) => {
      const { status } = req.body ?? {};
      if (!MEMBERSHIP_STATUSES.has(status)) {
        return res.status(400).json({ error: `status must be one of: ${[...MEMBERSHIP_STATUSES].join(", ")}` });
      }
      if (req.params.membershipId === req.membership.id) {
        return res.status(400).json({ error: "cannot change your own membership status through this route" });
      }
      const target = await withTransaction(
        pool,
        (client) => membershipRepository.getById(req.params.membershipId, client),
        { organizationId: req.organization.id },
      );
      if (!target || target.organization_id !== req.organization.id) {
        return res.status(404).json({ error: "unknown member" });
      }
      const updated = await withTransaction(
        pool,
        (client) => membershipRepository.setStatus(req.params.membershipId, status, client),
        { organizationId: req.organization.id },
      );
      res.json({ membershipId: updated.id, status: updated.status });
    }));

  app.post("/me/mfa/enroll", authenticate, asyncRoute(async (req, res) => {
    const primaryEmail = await userRepository.getPrimaryEmail(req.userId);
    const enrollment = await identityMfaService.enrollTotp({ userId: req.userId, email: primaryEmail?.email ?? "" });
    res.status(201).json(enrollment);
  }));

  app.post("/me/mfa/confirm", authenticate, asyncRoute(async (req, res) => {
    const { methodId, code } = req.body ?? {};
    if (!methodId || !code) return res.status(400).json({ error: "methodId and code are required" });
    const result = await identityMfaService.confirmTotp({ methodId, code });
    if (!result) return res.status(400).json({ error: "invalid code" });
    res.json(result);
  }));

  // Uniform response regardless of whether the email exists — never
  // confirms account existence to an unauthenticated caller. The reset
  // token itself is never in this HTTP response either way; it only ever
  // reaches the requester through sendMail() below (a no-op, logged
  // locally, when mailSender isn't configured).
  app.post("/password-reset/request", asyncRoute(async (req, res) => {
    const { email } = req.body ?? {};
    if (typeof email === "string" && email) {
      const user = await userRepository.getByEmail(email);
      if (user) {
        const { token: resetToken } = await emailActionService.issuePasswordResetToken(user.id);
        void sendMail(email, "Reset your Phone Farm password",
          `Use this code to reset your password (expires in 30 minutes): ${resetToken}`);
      }
    }
    res.status(202).json({ message: "if that email is registered, a reset link has been sent" });
  }));

  app.post("/password-reset/confirm", asyncRoute(async (req, res) => {
    const { token, newPassword } = req.body ?? {};
    if (!token || !newPassword) return res.status(400).json({ error: "token and newPassword are required" });
    validatePassword(newPassword);
    const result = await emailActionService.resetPassword({ token, newPassword });
    if (!result) return res.status(400).json({ error: "invalid or expired token" });
    res.status(204).end();
  }));

  app.post("/email-verification/confirm", asyncRoute(async (req, res) => {
    const { token } = req.body ?? {};
    if (!token) return res.status(400).json({ error: "token is required" });
    const result = await emailActionService.confirmEmailVerification(token);
    if (!result) return res.status(400).json({ error: "invalid or expired token" });
    res.status(204).end();
  }));

  // Final error handler: never leak internals (master prompt §9 "no stack
  // traces to users"). Known, caller-caused failures (bad role key,
  // duplicate slug/email, a validatePassword() rejection carrying its own
  // .status) map to 4xx; everything else is an opaque 500, logged
  // server-side only.
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    if (error?.code === "23505") return res.status(409).json({ error: "that value is already in use" });
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: error.message });
    }
    if (/unknown role key|unknown organization/.test(error?.message ?? "")) {
      return res.status(400).json({ error: error.message });
    }
    console.error("Cloud API request failed:", error);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
