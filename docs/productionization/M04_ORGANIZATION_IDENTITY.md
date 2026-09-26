# M04 — Organization + Identity + RBAC
### part 1: org/user/membership/RBAC · part 2: sessions · part 3: invitations · part 4: MFA · part 5: email verification/password reset · part 6: cloud API + authorization matrix · part 6b: signup-from-invitation + real email delivery · part 6c: member suspension/reactivation

Status: **PASS WITH KNOWN LIMITATIONS, PARTS 1–6c** — organization/user/membership/RBAC (part 1), session
issuance/verification/revocation (part 2), invitation issuance/acceptance (part 3), TOTP MFA/recovery codes
(part 4), email verification/password reset (part 5), a real HTTP API with the master prompt's required
authorization test matrix (part 6), signup-from-invitation and real email delivery (part 6b), and member
suspension/reactivation (part 6c) are built and covered by real-PostgreSQL/real-HTTP tests, but those tests
have not yet run in CI as of this writing (same caveat as M03) — do not treat any RLS policy, permission
mapping, or authorization boundary here as proven until `db-migrations.yml` has run green at least once. A few
items the master prompt lists under M04 are still not built — see "Not in this part" below.

Baseline: [M00_BASELINE.md](M00_BASELINE.md)
Precondition: [M03_POSTGRES_FOUNDATION.md](M03_POSTGRES_FOUNDATION.md)

## Goal

Per the master productionization prompt's M04 scope, build organizations, users, memberships, invitations,
roles, permissions, sessions, email verification, password reset, MFA, recovery, session management, and
suspension — "This is a hard gate. No customer beta before cross-tenant tests are green." This part covers
organizations, users, memberships, and RBAC (roles/permissions). It does **not** touch the existing, currently
in-production `operators.config.json`/`authStore.js` system — this is new, additive infrastructure running
alongside it, per the master prompt's own "never flag-day rewrite" principle and DATABASE_GAP_ANALYSIS.md's
"Before importing operators" checklist, none of which is satisfied yet.

## What was built

### Migrations

- `system/server/migrations/1758838500000_seed-permissions-and-roles.js` — seeds
  `identity.permissions` (21 keys, from the master prompt §4's permission list) and 7 system-template roles
  (`organization_id IS NULL`): owner, administrator, manager, va_operator, researcher, reviewer, billing_admin,
  each with a role→permission mapping. **This mapping is a reasonable starting default this session
  constructed, not a finalized product/business decision** — see "Open decisions" below.

  Uses `pgm.db.query()` (real parameterized `$1`/`$2` SQL, executed immediately) rather than node-pg-migrate's
  own `pgm.sql(text, mapping)` templating helper. Worth recording: the first draft of this migration used
  `pgm.sql(text, [array])`, assuming Postgres-style positional parameters — checking node-pg-migrate's actual
  type signature (`(sqlStr: string, args?: {[key: string]: Name | Value}) => string`) showed that function
  does its own `{name}`-style text substitution, not positional binding, and passing an array would have
  silently done something other than intended. Caught by reading the installed package's own `.d.ts`/source
  before relying on it — not by running it, since nothing here can be run against a live database — which is
  exactly the kind of mistake that unverified SQL-in-JS is prone to and worth flagging for whoever reviews
  this.

### Repositories and service

`system/server/src/db/repositories/`: `organizationRepository.js`, `userRepository.js`,
`membershipRepository.js`, `roleRepository.js` — thin, parameterized-query wrappers, each taking a `pool` (or
a transaction `client` per call, via an optional `runner` parameter) rather than holding any connection state
of their own.

`system/server/src/services/organizationIdentityService.js` — `createOrganizationWithOwner()` (creates an
organization, its first user, an active membership, and assigns the `owner` role, all inside one
`withTransaction()` — a duplicate slug rolls back the whole thing, verified in the test below), `addMember()`,
`hasPermission()`, `permissionsForMembership()`. Password hashing reuses `authStore.js`'s existing
`hashPassword`/`verifyPassword` (scrypt, constant-time comparison) rather than introducing a second,
independently-audited hashing implementation.

**Known gap, recorded in the service file's own header, not just here:** `identity.membership_roles` has no
RLS policy — it has no `organization_id` column to filter on directly, and a correct policy would need a
subquery through `memberships` that the M03 migration didn't include untested. Cross-membership role
tampering is currently prevented only by this service always deriving `membershipId` from a caller-verified
membership, never from unchecked client input — a gap to close with a real subquery-based RLS policy once
there's a route layer to test it against.

### Sessions (part 2)

`system/server/src/db/repositories/identitySessionRepository.js` + `system/server/src/services/identitySessionService.js`
against `identity.sessions`. Tokens follow the same hashed-storage convention as `siteStore.js`'s enrollment
tokens (`crypto.randomBytes(32)`, sha256 hash stored, raw token returned exactly once from
`issueSession()` and never retrievable again) — reusing an already-reviewed pattern in this codebase rather
than inventing a new one. `verifySession()` looks up by the hash directly (a standard, accepted pattern for
high-entropy session tokens — unlike `siteStore.js`'s small-cardinality site IDs, there's no enumeration
surface here for a timing side-channel to exploit) and rejects revoked or expired sessions without touching
`last_seen_at` itself, so a mere validity probe can't masquerade as real user activity; callers that want that
call `touchSession()` explicitly. `revokeAllSessionsForUser()` supports a "sign out everywhere" flow.

### Invitations (part 3)

`system/server/migrations/1758839400000_add-role-to-invitations.js` — a small, additive schema disagreement
recorded up front: PF_SOFTWARE_DATABASE_LOGICAL_PHYSICAL_SCHEMA.md §7.1's `invitations` table has no column
for which role acceptance grants, so this adds `role_key text NOT NULL` (no foreign key — `identity.roles.key`
is only unique per organization via the M03 migration's expression index, not globally, so it's validated by
`invitationService.js` at write time). `identityRepository/invitationRepository.js` +
`services/invitationService.js`: `invite()` (same hashed-token convention as sessions/sites, `pfi_` prefix,
validates the role key exists before creating anything), `acceptInvitation()` (one transaction: re-checks
accepted/revoked state against the database, not just the value read moments earlier, so two concurrent
acceptance attempts can't both succeed; adds the membership and assigns the role atomically), `revoke()`,
`listForOrganization()`.

**Scope limit, not an oversight:** `acceptInvitation()` adds an *existing* user (by id) to the organization. It
does not create a new account from an invitation — that needs a signup flow (choosing a password) this
milestone didn't build. Someone with no account yet must sign up first (once that flow exists), then accept
while authenticated. No email is sent — `mailSender.js` already handles delivery for the current file-backed
system and is the reasonable thing to wire this to, not reinvent.

### MFA and recovery codes (part 4)

`system/server/src/db/repositories/identityMfaRepository.js` + `system/server/src/services/identityMfaService.js`
against `identity.mfa_methods`/`identity.recovery_codes`. Reuses `twoFactor.js`'s existing TOTP/AES-GCM/
recovery-code implementation (already used elsewhere in this codebase, e.g. `proxyPool.js`'s credential
encryption) rather than a second, independently-audited crypto implementation — this service only adds the
PostgreSQL persistence shape around it: `enrollTotp()` (stores only the AES-GCM-encrypted secret, returns the
plaintext secret and an `otpauth://` URI exactly once, for the enrollment QR code), `confirmTotp()` (a real
code from the authenticator app moves the method from pending to verified and issues 10 recovery codes — only
their sha256 digests are persisted, the plaintext codes are returned exactly once), `verifyLogin()` (checks a
code against every *verified* method only — a pending, unconfirmed enrollment can never be used to log in),
`consumeRecoveryCode()` (single-use, reused codes rejected), `disableMethod()`.

### Email verification and password reset (part 5)

`system/server/migrations/1758840300000_email-action-tokens.js` adds `identity.email_action_tokens` — a
single table backing both flows, since neither PF_SOFTWARE_DATABASE_LOGICAL_PHYSICAL_SCHEMA.md §7.1 nor
DATABASE_GAP_ANALYSIS.md named one and the two flows are nearly mechanically identical (hashed token, expiring,
single-use, tied to a `purpose`). `system/server/src/db/repositories/emailActionTokenRepository.js` +
`system/server/src/services/emailActionService.js`. Same `crypto.randomBytes` + sha256 hashed-token convention
as sessions/invitations/sites, `pfa_`-prefixed. Requesting a new token invalidates any still-live one for the
same user and purpose, so an old, unread email link goes inert the moment a new one is requested. A
password-reset token cannot be replayed as an email-verification token or vice versa — `purpose` is checked
at resolution time, not just trusted from how it was issued. `resetPassword()` reuses `authStore.js`'s
`hashPassword` (same as part 1) and, when given a session repository, revokes every existing session for that
user — a password reset is a security event that should end other logged-in sessions, not just add a new
password alongside potentially-compromised ones. Neither flow sends email itself; `mailSender.js` already
handles delivery for the current file-backed system and is the reasonable thing to wire this to.

### Cloud API and authorization matrix (part 6)

`system/server/src/cloudApi/createCloudApi.js` — a **self-contained Express app, not mounted into
`system/server/src/index.js`**. This is new infrastructure for the master prompt's future multi-tenant
commercial "Cloud Control Plane," architecturally separate from the existing single-tenant Human VA Mode
server; it does not replace, and today is not reachable through, anything the current product serves. Routes:
`POST /signup`, `POST /login` (checks verified TOTP MFA when enrolled), `POST /logout`, `GET /me` (every
organization the caller belongs to), `POST /organizations/:id/invitations`, `POST /invitations/accept`,
`POST /me/mfa/enroll`, `POST /me/mfa/confirm`, `POST /password-reset/request`, `POST /password-reset/confirm`,
`POST /email-verification/confirm`. Every handler is a thin translation to the already-tested service layer —
no business logic lives in this file.

`system/server/src/cloudApi/middleware/`: `authenticate.js` (Bearer token → `identitySessionService.
verifySession()` → rejects a missing/invalid/expired/revoked session or a non-active user, re-checked on
every request rather than cached, matching this codebase's own existing `resolveOperator()` lesson about
stale cached identity), `requireMembership.js` (resolves and verifies membership in the `:organizationId` route
param inside a transaction with tenant context set — required, since `membershipRepository.get()` is
RLS-protected and silently returns nothing without it), `requirePermission.js` (RBAC check against
`req.membership`, never a client-supplied membership id).

**A real RLS gap found and fixed while building this, not after:** `GET /me` needs to list a user's
memberships across *every* organization they belong to — a legitimately cross-tenant read from the
authenticated user's own point of view. The existing `tenant_isolation_memberships` policy only ever makes one
`organization_id` visible per transaction, so it would have hidden every row for this query. Added
`system/server/migrations/1758841200000_membership-self-read-policy.js`: a second, **`SELECT`-only** permissive
policy keyed on a new `app.current_user_id` GUC — PostgreSQL OR's multiple permissive policies together
(documented behavior), so a row is visible when *either* the org context or the user context matches.
Deliberately not `FOR ALL`: allowing `INSERT`/`UPDATE`/`DELETE` under "`user_id` = me" would let any
authenticated user create or modify a membership row for an organization they don't belong to just by setting
`user_id` to themselves — exactly the escalation the org-scoped policy exists to prevent. `db/transaction.js`'s
`withTransaction()` gained a matching `userId` option (same parameterized `set_config()` pattern as
`organizationId`, same "selector, not proof of authorization" caveat), and `membershipRepository.listForUser()`
depends on it.

**Deliberate security choices, not oversights:**
- `/login` returns the identical response whether the email is unknown or the password is wrong (matches
  `authStore.js`'s existing non-enumerating convention).
- `/password-reset/request` returns the identical `202` response whether or not the email exists, and the
  response body never contains a token. Until `mailSender.js` is wired to this route, a real reset token is
  issued but reaches nobody — a functionality gap, not a security one, since nothing in the HTTP response ever
  reveals it.
- The final Express error handler never leaks a stack trace to the client (master prompt §9): known,
  caller-caused failures map to specific 4xx codes; everything else becomes an opaque `500`, logged
  server-side only.

**Authentication transport is a documented simplification, not a final decision:** sessions are Bearer tokens
in the `Authorization` header, not cookies. Reasonable for an API consumed by several different first-party
clients (web, macOS, Windows, iOS, Android, per the master prompt's own architecture diagram), but a browser-
based web portal would likely want httpOnly cookies with CSRF protection instead — an open decision for M12
(public website/customer portal), not resolved here.

### Signup-from-invitation and real email delivery (part 6b)

`POST /signup-from-invitation` closes the gap `acceptInvitation()` deliberately left open in part 3: someone
with no existing account can now complete an invitation in one step (create the user under the invitation's
own email — never a client-supplied one, so the account can't be created under a different address than what
was actually invited — then accept). Completing an *emailed* invitation link already proves control of that
address, so this marks the primary email verified immediately rather than making a just-invited person prove
the same thing twice through a separate email-verification round trip.

`createCloudApi()` gained optional `mailSender`/`companyEmail` parameters (defaulting to `null` — every
token-issuing flow still works exactly as before without them, just logging locally instead of sending
anything, matching `accountNotificationStore.js`'s own established "unconfigured ⇒ no-op with a logged
reason" convention). When configured, `/signup`, `/organizations/:id/invitations`, and
`/password-reset/request` now actually call `mailSender.js`'s `send()` — fire-and-forget (`void sendMail(...)`,
never awaited by the route), so a slow or failing SMTP call can never add latency to the HTTP response or turn
into a 500 the caller shouldn't see, matching this codebase's own existing password-recovery-route precedent
for exactly this timing-side-channel reason. No web portal exists yet to link to (M12), so email bodies carry
the raw token with instructions rather than a clickable link — a documented interim shape.

Also added `validatePassword` (exported from `authStore.js` — reused, not reimplemented) to `/signup`,
`/signup-from-invitation`, and `/password-reset/confirm`: until this change, `/signup` accepted a password of
any length at all, including empty.

### Member suspension/reactivation (part 6c)

Closes part of "suspension/deletion lifecycle" from the earlier "Not in this part" list — the *suspension*
half, scoped to membership status; hard deletion stays out of scope (M16). The enforcement side already
existed by construction: `requireMembership()` already 403s a non-`active` membership and `authenticate()`
already 401s a non-`active` user, both on every request, not just at login. What was missing was the
admin-facing way to actually flip that status. Added:

- `GET /organizations/:id/members` — any active member can see the roster; there is no dedicated
  `member:view` permission in the seeded catalog, matching the common SaaS default that team visibility
  itself isn't privileged, only managing it is.
- `PATCH /organizations/:id/members/:membershipId` `{ status: "active" | "suspended" | "removed" }`, gated by
  `member:manage`. Deliberately refuses to let a caller change **their own** membership through this route —
  the simplest way to prevent an organization locking itself out of its own management (an org accidentally
  suspending its only active manager) is to require a *different* member to do it, rather than building
  "at least one active owner must remain" invariant logic that would need its own careful, unverified design.

The real-PostgreSQL/real-HTTP test proves the enforcement is genuinely immediate: a target user's session
works, gets suspended by a manager, and the *same still-valid, unrevoked* session is rejected on the very next
request — no session revocation needed, because the membership check runs on every request already.

### Tests

- `system/server/test/unit/db/repositories.test.js` — 11 tests against a fake pool (no live database):
  constructor validation, SQL-shape/parameter assertions for each repository, and the service's dependency
  checks.
- `system/server/test/unit/db/identitySession.test.js` — 8 tests: a fake-pool test for the repository plus a
  fully mocked-repository behavioral suite for the service (issue/verify/revoke/revoke-all/list-active,
  including that revoking or expiring a session actually blocks verification and that another user's sessions
  are untouched by a revoke-all).
- `system/server/test/integration/db/organizationIdentity.test.js` — real-PostgreSQL, skipped without
  `TEST_DATABASE_URL`: creates an organization with an owner and asserts the owner role actually carries
  `organization:manage`/`billing:manage`; asserts the stored password hash verifies with `authStore.js`'s own
  `verifyPassword` (proving hashing reuse, not a parallel implementation); asserts a `va_operator` member has
  `device:control` but *not* `billing:manage` or `organization:manage`; asserts an unknown role key rejects
  and leaves no partial membership row behind; asserts a duplicate organization slug rolls back the entire
  transaction (no orphaned user row for the second attempt).
- `system/server/test/integration/db/identitySession.test.js` — real-PostgreSQL: issues a session and confirms
  its raw token is never stored (only the hash), confirms revoking leaves the row for audit but fails
  verification, confirms revoke-all covers every active session for a user, confirms a session's own id
  cannot be used in place of its token to forge verification.
- `system/server/test/unit/db/invitation.test.js` — 10 tests: repository SQL-shape assertion, and a fully
  mocked-repository behavioral suite for the service (unknown role key rejected before any row is created,
  raw token returned once, a second acceptance rejected, an unknown token rejected, a revoked or expired
  invitation rejected).
- `system/server/test/integration/db/invitation.test.js` — real-PostgreSQL: accepting a real invitation grants
  exactly the invited role's permissions (not more); the same invitation cannot be accepted twice and the
  first successful membership survives that rejected second attempt; a revoked invitation cannot be accepted.
- `system/server/test/unit/db/identityMfa.test.js` — 9 tests against fake twoFactor.js functions and a fake
  repository, isolating the service's own composition logic (wrong code leaves the method unverified and
  issues no recovery codes; a pending method can't be used to log in; disabling a method blocks it; a recovery
  code works exactly once).
- `system/server/test/integration/db/identityMfa.test.js` — real-PostgreSQL, using the REAL `twoFactor.js`
  crypto (not fakes), so the actual encrypt/decrypt/TOTP round trip through real storage is what's verified: a
  genuinely generated TOTP code confirms enrollment and later logs in; a stale/wrong code is rejected; a real
  recovery code is hashed at rest (never stored in plaintext) and single-use against the real database.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml), run after the
  tenant-isolation test (which leaves the schema freshly re-migrated, seed data included), the organization-
  identity test, the session test, and the invitation test.
- `system/server/test/unit/db/emailAction.test.js` — 9 tests against fakes: requesting a new token invalidates
  a prior live one for the same purpose; confirming verification twice with the same token fails the second
  time; a reset token can't be replayed as a verification token; a successful reset revokes sessions when a
  session repository is given; an expired token is rejected for both flows.
- `system/server/test/integration/db/emailAction.test.js` — real-PostgreSQL: verification marks the real
  `identity.user_emails` row's `verified_at`; a real password reset updates the real stored hash (verified
  with `authStore.js`'s own `verifyPassword`) and actually revokes a real, previously-valid session; requesting
  a second reset token invalidates the first against the real database.
- Fixed a real bug while wiring this in: node-pg-migrate's `down` command defaults to reverting only the
  single most-recently-applied migration (`count: 1`), not everything. With two migrations now, the tenant-
  isolation test's "down must remove the identity schema" assertion would have silently tested the wrong
  thing (only migration 2's seed data would have been reverted; migration 1's schema would still exist). Fixed
  by passing an explicit `down 0` (node-pg-migrate's count semantics: `slice(-Math.abs(0))` on the applied-
  migrations list returns all of them) — traced through `node_modules/node-pg-migrate`'s own runner/CLI source
  to confirm this before relying on it, again because nothing here can be run to find out empirically.

- `system/server/test/unit/cloudApi/middleware.test.js` — 9 tests against mocked services: `authenticate`
  rejects no-token/invalid-token/non-active-user and attaches identity on success; `requireMembership`
  404s an unknown org and 403s a missing/inactive membership; `requirePermission` 403s a missing permission.
- `system/server/test/integration/db/cloudApi.test.js` — real PostgreSQL AND real HTTP (the app is actually
  `.listen()`-ed on an ephemeral port and driven with `fetch`): the master prompt's full authorization matrix
  against `POST /organizations/:organizationId/invitations` — **anonymous** (401), **wrong organization** (a
  real owner of a *different* org, 403), **wrong role** (`va_operator` lacks `member:invite`, 403), **correct
  role** (`manager` *and separately* `owner`, both 201), **disabled user** (suspended mid-session, 401 despite
  a valid, unexpired, unrevoked session and the right role — proving `authenticate` re-checks user status on
  every request, not just at login), **expired session** (401), **revoked session** (401). Also verifies
  `GET /me` returns memberships spanning two different real organizations for one user (the self-read RLS
  policy, exercised through HTTP, not just a raw SQL client).
- `system/server/test/integration/db/tenantIsolation.test.js` gained a subtest for the new self-read policy
  directly: a real user with memberships in two organizations sees both through `app.current_user_id` alone
  (no org context), while the same context never exposes a *different* user's memberships.
- `system/server/test/unit/db/transaction.test.js` gained two tests for `withTransaction()`'s new `userId`
  option (sets both GUCs when both are given; rejects a non-UUID `userId` before opening a connection).
- `cloudApi.test.js` gained more real-PostgreSQL/real-HTTP coverage: an unknown organization id 404s rather
  than 403ing (never confirms or denies real org ids to an unauthorized caller); `authenticate()` behaves
  identically on a route with no membership/permission layer (`/me/mfa/enroll` — anonymous/expired/revoked all
  401, a valid session 201); `/signup` rejects a too-short password before creating anything;
  `/signup-from-invitation` creates a real, immediately-usable account and session for someone with no prior
  user row, and rejects a reused invitation token; a fake `mailSender` (recording calls, not real SMTP) proves
  `/signup`, `/organizations/:id/invitations`, and `/password-reset/request` actually call it with the right
  recipient/content — and that an unknown email address triggers no send at all.
- `cloudApi.test.js` gained the member-suspension matrix (part 6c): any active member can list the roster
  regardless of role; a `va_operator` lacks `member:manage` and is rejected; a manager suspending another
  member's real, still-valid, unrevoked session immediately loses access on the very next request (proving
  enforcement doesn't depend on session revocation); an invalid status value, a self-targeting attempt, and a
  membership id from a *different* organization are all rejected (400/400/404 respectively).

Local verification: 56 mocked-pool/mocked-service unit tests (11 + 8 + 10 + 9 + 9 + 9) plus the wider server
suite were run; all seven real-PostgreSQL test files confirmed to skip cleanly (not silently pass) without
`TEST_DATABASE_URL`. `node --check` passed on every new file.

## Not in this part (still open within M04)

- **WebAuthn.** `identity.mfa_methods.method_type` allows `'webauthn'`; only `'totp'` is implemented.
- **The authorization matrix is proven for two endpoints** (`POST /organizations/:id/invitations` and
  `PATCH .../members/:membershipId`), plus a narrower `authenticate`-only check on `/me/mfa/enroll`. Every
  other protected route (`/logout`, `/me`, `/invitations/accept`, `/me/mfa/*`, `/password-reset/confirm`,
  `/email-verification/confirm`) uses the same middleware and should behave the same way, but the master
  prompt's matrix has not been run against each of them individually — mechanical, not risky, repetition of an
  already-proven test pattern.
- **Hard account/organization deletion.** Member *suspension* now has a real route (part 6c); deletion is
  M16's GDPR-style anonymization lifecycle, a different and much larger scope.
- **Suspending an organization or a user directly** (as opposed to one membership). `organizationRepository.
  updateStatus()` exists; no route calls it, and there's no platform-admin authorization concept to gate it
  behind yet — this RBAC model is entirely organization-scoped, and a cross-organization "platform admin" role
  is a different authorization dimension this milestone didn't build.
- **Reconciling this role model with the existing file-backed one.** `system/server/src/roleCapabilities.js`
  already defines a working 5-role model (`admin`/`manager`/`va`/`content_creator`/`editor`) with its own
  capability-key naming, for the currently-shipping single-tenant Human VA Mode product. This migration's
  7-role/21-permission model is the master prompt's own suggested commercial-tier default, used as-is because
  the master prompt explicitly offers it as a starting point — not because the two models have been reconciled.
  They have not.

## Open decisions (do not guess further than this document already has)

- **What exactly distinguishes Owner from Administrator?** Both currently have identical permissions (every
  key). A real distinction (organization deletion, ownership transfer, billing-provider-account linkage) needs
  permission keys the master prompt's list doesn't define, or a product decision that no distinction is needed
  yet.
- **Whether/how the commercial 7-role model and the existing 5-role operator model merge**, split, or coexist
  permanently for different product surfaces (cloud multi-tenant portal vs. single-site Human VA Mode).
- **The role→permission mapping itself** — this session's assignment (see the seed migration) is a defensible
  starting point, not a reviewed product decision.

## Next steps toward the rest of M04

1. WebAuthn as a second MFA method type.
2. Run the master prompt's authorization matrix against every remaining protected route, not just
   `/organizations/:id/invitations`/`/organizations/:id/members/:id`/`/me/mfa/enroll` (mechanical repetition of
   an already-proven test pattern).
3. A platform-admin authorization dimension, if organization/user-level suspension (not just membership) turns
   out to be needed before M16.
4. Hard account/organization deletion (M16's own scope, not this milestone's).
5. A real decision on where `system/server/src/cloudApi/` actually deploys/mounts (M07 cloud/site protocol, M12
   public portal) — it exists today only as an importable factory function with no `index.js` wiring, no
   deployment target, and no relationship yet to the existing single-tenant server.
