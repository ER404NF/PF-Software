# P2 — Real login mounted into the running app

Status: **PASS** — the identity/organization system (M04) is now actually mounted inside
`system/server/src/index.js`, reachable over real HTTP, behind an explicit environment flag, alongside the
existing file-backed operator login (untouched). A real invite → accept → login → TOTP-enroll → TOTP-confirm
→ logout sequence has been run end to end against a live PostgreSQL database and a live, actually-running
instance of the real server — not createCloudApi() tested in isolation, and not a log line claiming it
worked.

See [`PHASE1_TEAM_ROLLOUT_HANDOUT.md`](PHASE1_TEAM_ROLLOUT_HANDOUT.md) §4 task P2 (and P2's step 6 decision)
for what this satisfies. Builds on [P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md).

## What was built

1. **`system/server/src/index.js`**: a new block, gated entirely behind `process.env.CLOUD_API_ENABLED ===
   "true"`, placed just before `createServer(app)`. When the flag is unset (the default — every existing
   test and deployment is unaffected), none of this code runs: no pool is created, nothing is imported at
   runtime beyond the `import` statements themselves. When enabled, it:
   - requires `DATABASE_URL` to be set (throws a clear startup error otherwise, rather than mounting a
     half-configured API);
   - calls `ensureDefaultOrganization(pool)` once at startup — satisfying P2 step 1 ("ensure the one default
     organization exists"; no organization-creation flow was built, since there is exactly one, per Phase 1's
     own scope);
   - constructs every M04 repository/service exactly as `cloudApi.test.js` already does, reusing this
     server's own existing `mailSender` and `COMPANY_FROM_EMAIL`/`TWO_FACTOR_MASTER_KEY` configuration rather
     than inventing separate ones;
   - mounts the resulting Express app at `/api/cloud`, alongside (never replacing) the existing file-backed
     `/api/login` and friends.
2. **`createCloudApi.js`: `allowOrganizationSignup` option (new, defaults to `true`)**. Phase 1 explicitly
   forbids a public "create an account" route — `POST /signup` creates a brand-new *organization*, which is
   the Phase 2 multi-tenant self-serve flow this handout defers. `index.js`'s mount passes
   `allowOrganizationSignup: false`, which 404s that one route (not 403 — consistent with this codebase's own
   existing "don't confirm or deny a route's existence" convention) while leaving every other route,
   including the invite-only `signup-from-invitation`, untouched. Defaulting to `true` keeps every pre-existing
   caller/test of `createCloudApi()` (written for M04's full multi-tenant design) working unchanged.
3. **The required role-model decision (P2 step 6), made and recorded, not left implicit**: this identity layer
   replaces only account lifecycle (invite/accept/login/logout/sessions/MFA). Device-control authorization
   (`roleCapabilities.js`'s five-role model, `requireCapability()`, every `/api/devices`/`/api/research` route)
   is completely unchanged — confirmed by inspection (no new import touches `roleCapabilities.js`, and the
   real end-to-end test explicitly asserts the legacy `/api/login` route is still reachable and unshadowed
   after mounting). This is the handout's own recommended default, adopted as-is since nothing here argued
   otherwise.

## Bugs found and fixed — again, only visible once mounted for real

### 1. `req.session` name collision with `express-session` (serious)

**Symptom:** the moment the cloud API's `authenticate` middleware ran on a request that had also passed
through `index.js`'s own `express-session` middleware (i.e. every request, once mounted — session middleware
is global), any route that sent a JSON response threw `TypeError: req.session.touch is not a function` deep
inside `express-session`'s own `res.end` hook. `createCloudApi.test.js` — which exercises this same API as
its own **standalone** Express app with no `express-session` anywhere — could never have caught this; the
bug only exists at the intersection of the two, which is exactly what mounting for real, for the first time,
exposed.

**Root cause:** `cloudApi/middleware/authenticate.js` set `req.session = session` (the verified Bearer-token
session **database row**) after a successful check. `system/server/src/index.js` already runs
`express-session` globally, which sets `req.session` to its own `Session` instance (with a real `.touch()`
method) for every request, and its own response hook depends on that object still being intact when the
response ends. Two independent, differently-designed subsystems happened to pick the identical property name
for two entirely different kinds of "session" — invisible until both existed on the same request at once.

**Fix:** renamed the cloud API's own property to `req.identitySession` everywhere (the middleware itself, and
`createCloudApi.js`'s one other reader of it, the `/logout` route). No behavior change for
`createCloudApi.js`'s own standalone tests beyond the property name; `test/unit/cloudApi/middleware.test.js`
updated to match.

**Regression coverage:** `system/server/test/integration/db/cloudApiMountedInIndex.test.js` (new) boots the
real `index.js` with `CLOUD_API_ENABLED=true` against a real database and proves, over real HTTP: the mounted
API is reachable and the legacy login route is untouched; `allowOrganizationSignup: false` really 404s
`/signup` when mounted for real; and the complete invite → accept → login → real-TOTP-enroll →
real-TOTP-confirm-with-a-freshly-computed-code → logout → confirmed-revoked sequence, end to end, against the
actual running server.

## Fuzzing pass (P2 step 5 / P6 step 1) — two more real bugs

Every JSON-bodied cloud API route, mounted for real and hit with malformed JSON, `null`, a bare array,
wrong-typed fields, prototype-pollution shapes, and an oversized body; every authenticated route also hit
with a hostile (but actually-sendable — see below) Bearer token. Found and fixed two more real bugs before
any test in this pass was allowed to report clean:

### 2. `POST /login` and `POST /password-reset/request`: `email.trim is not a function`

**Symptom:** sending `{"email": 12345, ...}` (a number instead of a string) to either route threw a 500
(`TypeError: email.trim is not a function` inside `userRepository.getByEmail()`).

**Root cause:** both routes checked only `if (!email)` before calling `userRepository.getByEmail(email)` — a
falsy check that a *number* (or any other truthy non-string) sails straight through. `getByEmail()` itself
calls `email.trim().toLowerCase()` unconditionally, assuming its caller already validated the type — a
reasonable assumption for an internal repository method (this codebase validates at system boundaries, not
in every internal call), but the boundary here — the HTTP route — never actually did.

**Fix:** both routes now check `typeof email !== "string"` (in addition to the existing emptiness check)
before calling into the repository. `/password-reset/request`'s fix preserves its own deliberate uniform-202
behavior exactly — a malformed `email` now safely falls through to the same "if that email is registered..."
response as an absent one, rather than crashing.

### 3. Two test-only false positives, corrected rather than "fixed" in product code

- `/password-reset/request` returning `202` for a well-formed-JSON-but-wrong-shape body (array, wrong types,
  prototype pollution) is *itself correct* — its whole design is a response that never varies with the
  input, to avoid confirming or denying account existence. The fuzz test's blanket "expect a 4xx" assumption
  was too rigid for this one, deliberately-uniform route; narrowed to expect the uniform `202` specifically
  for semantically-malformed-but-parseable bodies, while still expecting a real `4xx`/`413` for bodies that
  are rejected before the route even runs (unparseable JSON, oversized).
- A "hostile Authorization header" case using a raw UTF-16 surrogate half and NUL/control bytes made the
  test's own `fetch()` call throw *client-side* (`Headers.append: ... is an invalid header value`) before any
  request was even sent — confirmed directly rather than assumed. HTTP header values are octet sequences, not
  arbitrary JS strings; no real HTTP client can transmit those bytes in a header either, so it wasn't a
  realistic attack to fuzz. Replaced with a very long token and a SQL-injection-shaped string — both
  legitimately transmittable, and both correctly rejected with a clean 4xx.

Full pass: **62/62 sub-tests pass** in
`system/server/test/integration/db/cloudApiFuzz.test.js`, wired into
`.github/workflows/db-migrations.yml` as its own CI step.

## Report (per handout §7)

```text
Task: P2 — Wire real login into the running app (single organization, invite-only)
Files changed:
  - system/server/src/index.js: mounts the cloud API at /api/cloud behind CLOUD_API_ENABLED
  - system/server/src/cloudApi/createCloudApi.js: allowOrganizationSignup option; email type validation in
    /login and /password-reset/request (real bug fixes)
  - system/server/src/cloudApi/middleware/authenticate.js: req.session -> req.identitySession (real bug fix)
  - system/server/test/integration/db/cloudApi.test.js: allowOrganizationSignup test
  - system/server/test/integration/db/cloudApiMountedInIndex.test.js (new): real end-to-end mount proof
  - system/server/test/integration/db/cloudApiFuzz.test.js (new): 62 hostile-input sub-tests, every route
  - system/server/test/unit/cloudApi/middleware.test.js: updated for the rename
  - .github/workflows/db-migrations.yml: 2 new CI steps (mounted end-to-end test, fuzz test)
Database migrations: none new.
Security impact: fixes (a) a real request-object property collision between two independent session concepts
  that could otherwise corrupt the legacy operator's express-session state on any request that also happened
  to exercise the cloud API's Bearer-token path once both were mounted together, and (b) two real unhandled-
  exception paths (500s) reachable by any caller sending a non-string email to /login or
  /password-reset/request — not a data exposure in either case, but a real availability/robustness defect a
  real client (or an attacker probing for weaknesses) could trivially trigger.
Tests added: 2 new full-file integration tests (cloudApiMountedInIndex.test.js: 3 sub-tests;
  cloudApiFuzz.test.js: 62 sub-tests) plus 1 new sub-test in the existing cloudApi.test.js.
Tests run: server suite — 155 files, 1509 tests, 1509 passed, 0 failed, 0 skipped (real PostgreSQL 16.14,
  real Redis-compatible server, both local dev instances per P1).
Manual/real-service tests performed: booted the actual system/server/src/index.js with
  CLOUD_API_ENABLED=true and a real DATABASE_URL; issued real HTTP requests for every step of invite → accept
  → login → TOTP enroll → TOTP confirm (with a real, freshly computed code from the returned secret) →
  logout → confirmed-revoked; fuzzed every JSON-bodied route and every authenticated route with hostile,
  actually-transmittable input.
Real hardware / real device involved: none.
Known limitations: the authorization matrix (anonymous/wrong-org/wrong-role/correct-role/disabled/expired/
  revoked) is fully proven on the two permission-gated routes (member:invite, member:manage) and the
  authenticate-only path (via /me/mfa/enroll); GET /organizations/:id/members (membership-only, no specific
  permission) has real coverage of its own logic but not a full repeat of every matrix cell specifically at
  the HTTP layer yet.
Rollback plan: CLOUD_API_ENABLED defaults to unset/false; reverting to that state (or simply not setting it
  in any environment) fully restores pre-P2 behavior with zero code changes needed.
Status: PASS
Next task: P2b (wire real SMTP credentials and prove real email delivery), and/or the remaining
  authorization-matrix cell for GET /organizations/:id/members.
```
