# P1 — Real database/Redis verification (Phase 1 rollout)

Status: **PASS** — the full server suite now runs and passes for real against a live PostgreSQL 16 instance
and a live Redis-compatible instance, not mocks and not skips. This is the first time in this project's
history that has been true anywhere, including in CI (per
[`PHASE1_TEAM_ROLLOUT_HANDOUT.md`](PHASE1_TEAM_ROLLOUT_HANDOUT.md)'s own account, the 19 real-database/Redis
tests had, until this task, only ever skipped everywhere they'd been run).

See [`PHASE1_TEAM_ROLLOUT_HANDOUT.md`](PHASE1_TEAM_ROLLOUT_HANDOUT.md) §4 task P1 for what this satisfies.

## What was verified against, and how

No Docker is available in this environment (confirmed: `docker`/`docker compose` not found), and this
sandbox has no administrator rights (confirmed: installing PostgreSQL via Chocolatey failed on a permissions
error acquiring its package lock, before even reaching the actual install). Rather than block on
infrastructure the handout itself says this machine "does not need... forever, just for this verification,"
a real, disposable, no-admin-required PostgreSQL and Redis-compatible server were brought up as plain Node
child processes instead of system services:

- **PostgreSQL 16.14**, via the `embedded-postgres` npm package (`@embedded-postgres/windows-x64`), which
  downloads and runs a real, unmodified PostgreSQL binary distribution — not a mock, not a different database
  engine pretending to be Postgres. Runs as an ordinary user process bound to `127.0.0.1:55432`; its data
  directory is disposable and lives outside this repository.
- **A Redis-compatible server**, via the `redis-memory-server` npm package, which on Windows downloads and
  runs [Memurai](https://www.memurai.com/) (a real, wire-compatible Redis server for Windows) — bound to
  `127.0.0.1:56379`.

Both are dev-only tooling for this verification and ongoing local development, matching the handout's own P1
step 1 framing exactly. Neither is a project dependency; nothing in `system/package.json` changed for this.

## What was run

1. `npm run migrate up` from a clean database — all 18 migrations applied cleanly.
2. Full migration round trip: `migrate up` → `migrate down 0` (confirmed both the `identity` and `automation`
   schemas are completely gone) → `migrate up` again — clean both directions.
3. Full server suite (`cd system && npm test`) with `TEST_DATABASE_URL`/`TEST_REDIS_URL` set — every
   previously-skipped real-database/Redis test now **executes and passes**, not skips.
4. Full desktop suite (`cd desktop && npm test`) — confirmed the pre-existing baseline (159/159) is unaffected
   by any of this; this task never touches desktop code.

**Final result: server suite 153 files, 1443 tests, 1443 passed, 0 failed, 0 skipped. Desktop suite: 159
passed, 0 failed.**

## Bugs found and fixed — real ones, invisible to every mock

Exactly as the handout predicted ("whatever breaks here that didn't break against a mock is real"), running
for real surfaced seven distinct, genuine bugs that had never been caught in over ten domains' worth of
mocked/CI-only-assumed test authoring. Each is reproduce → root cause → fix → regression-verified, per §6.

### 1. Systemic RLS bypass-into-error bug (the serious one)

**Symptom:** `postgresPolicyRepository`, `postgresResearchRunRepository`, and `tenantIsolation.test.js`'s
`memberships_self_read` case all threw `invalid input syntax for type uuid: ""` on queries that should have
either succeeded or failed closed (zero rows) — never a raw SQL exception.

**Root cause, reproduced directly:**
```sql
-- before any GUC is ever referenced in a session:
SELECT current_setting('app.current_organization_id', true);  -- NULL

BEGIN;
SELECT set_config('app.current_organization_id', '11111111-...', true);  -- transaction-local
COMMIT;

SELECT current_setting('app.current_organization_id', true);  -- '' — NOT NULL!
```
Once a custom (non-built-in) GUC has been referenced/set at least once in a session — even via `SET LOCAL`/
`set_config(name, value, true)` inside a transaction that later commits — PostgreSQL's placeholder tracking
for that parameter name means `current_setting(name, missing_ok := true)` returns an **empty string**, not
`NULL`, for the remainder of that session whenever no transaction-local value is currently in effect. An
explicit `RESET` does not restore true `NULL` either (verified directly). Every RLS policy in this codebase
was written as `organization_id = current_setting('app.current_organization_id', true)::uuid` — and
`''::uuid` is a hard Postgres error (`22P02`), not a false comparison.

**Why this matters in production, not just in this test:** every `withTransaction()` call sets this GUC via
exactly this pattern. In a real connection pool, once a physical connection has served **any** request through
`withTransaction()`, that connection's session-level "unset" state for `app.current_organization_id` becomes
`''` forever after (for the life of that pooled connection) — not `NULL`. Any code path that queries an
RLS-protected table **without** going through `withTransaction()` on such a connection — the exact shape of
`membershipRepository.get(orgId, userId)`'s own default `runner = pool` parameter — does not fail closed with
zero rows; it throws a raw, uncaught-looking Postgres exception instead. Not a data leak (the query never
returns another tenant's row), but a real reliability/availability bug that only a live connection pool can
ever exhibit, and exactly the shape of thing this handout's method (§6) exists to catch.

**Fix:** every RLS policy expression across every migration — 31 occurrences across 12 files — hardened from
```sql
organization_id = current_setting('app.current_organization_id', true)::uuid
```
to
```sql
organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
```
`NULLIF(x, '')` converts the empty-string "reset" state back to true `NULL` before the cast, so the
comparison becomes `organization_id = NULL` (always false, fail closed, no exception) regardless of a pooled
connection's GUC-placeholder history. This is a schema-level fix, not a call-site discipline problem — it
protects every current and future caller, including ones that (correctly or not) query outside
`withTransaction()`. Migrations affected:
`1758837600000_identity-and-organizations.js` (10 occurrences — `workspaces`, `memberships`, `invitations`,
`roles`, `security_events`), `1758841200000_membership-self-read-policy.js`, `1758842100000_fleet-sites.js`,
and every `automation.*` migration from approvals through account-policies (2 each). None of these migrations
had ever been applied to a real, persistent database before this task, so they were edited in place rather
than patched with a follow-up migration — the same principle already applied to the seed-permissions fix
below.

**Regression coverage:** the existing real-Postgres test suites for every affected domain already exercise
the exact code paths this bug broke (every domain's own tenant-isolation test, plus
`tenantIsolation.test.js`'s `memberships_self_read` case, plus the two adapters that surfaced it directly) —
all now pass clean against the corrected schema. No new test file was needed; the bug was already covered by
existing coverage that had simply never run for real before.

### 2. Seed data bug: `manager` role missing `member:manage`

**Symptom:** every `cloudApi.test.js` assertion expecting a `manager`-role user to successfully suspend/
reactivate a member, or to receive the specific 400/404 rejections that route returns, instead got a blanket
403.

**Root cause:** `1758838500000_seed-permissions-and-roles.js`'s `ROLES.manager` array granted `member:invite`
but never `member:manage`, even though the route's own design (and the pre-existing test's own name, "a
manager can suspend another member") clearly intended managers to have both. A one-line omission in
never-before-applied seed data.

**Fix:** added `"member:manage"` alongside `"member:invite"` in the `manager` role's permission list.

### 3. `\u0000 cannot be converted to text` — research-run candidate index in jsonb

**Symptom:** `postgresResearchRunRepository`'s `createRun`/`appendCandidate`/`locateCandidate` tests failed
with Postgres error `22P05` the moment a candidate had a `platform_content_id`.

**Root cause:** `researchStore.js`'s own `findIndexEntry()` builds cross-run dedup index keys as
`` `${platform}\u0000${platformContentId}` `` — a NUL-byte join that a JSON **file** stores without issue (the
byte is written as the escaped text `\u0000`), but PostgreSQL's `text`/`jsonb` types reject an embedded NUL
byte outright, at any nesting depth, including as an object key. Storing the whole `{runs, candidateIndex}`
blob as one `jsonb` value (this domain's whole design, see `M05_DURABLE_DOMAIN_MIGRATION.md`'s research-runs
section) inherited this incompatibility the moment a candidate actually had a platform content id.

**Fix:** `postgresResearchRunRepository.js` now base64-encodes/decodes every `candidateIndex.byContentId`/
`byUrl` **key** at the Postgres storage boundary only (`encodeIndexKeys()`/`decodeIndexKeys()`), immediately
before `JSON.stringify()` and immediately after reading the row back. The shared pure functions imported from
`researchStore.js` (`findIndexEntry`, `upsertIndexEntry`, `indexCandidate`, etc.) never see the encoded form —
they operate on the original, `\u0000`-containing keys in memory exactly as the file store does; only the
bytes actually written to Postgres are encoded. `researchStore.js` and the file-backed store are untouched.

### 4–5. Test-only bugs: a shared fake clock never advanced to match fixture dates

`postgresApprovalRepository.test.js` and `postgresAssignmentRepository.test.js` each use one mutable `clock`
variable across many sequential `t.test()` blocks, standing in for `Date.now()`. Two distinct mistakes, same
root cause:
- **Approvals:** two sub-tests asserted something that could only be true if the clock had advanced between a
  `request()` and a later `decide()`/`list()` call, but the clock was never actually moved before those
  specific assertions — one assertion (`decided.expiresAt > approval.expiresAt`) was comparing two identical
  timestamps by construction; the other (`list()` finding a still-PENDING approval) ran *after* a different
  sub-test had already advanced the clock past every approval's original expiry window, so lazy-expiration had
  correctly expired everything by the time it ran.
- **Assignments:** two sub-tests called `setStatus(..., "in_progress", ...)` on an assignment whose `startAt`
  was in the fixture's future relative to the *actual* current value of the shared clock at that point in the
  file (the clock advance the test intended to precede that call was written *after* it, or never written for
  a later, similarly-shaped case) — the adapter's real "cannot start before startAt" guard is correct and
  working; the test's chronology just didn't match its own fixtures.

**Fix:** advanced `clock` to the correct point in each test *before* the assertion/call that depends on it, and
(for the approvals `list()` case) had that specific assertion create its own fresh, guaranteed-pending
approval rather than depending on the state of approvals created many sub-tests earlier under a since-moved
clock. No adapter code changed for either file — both adapters were already behaving exactly as designed.

### 6. Test-only false premise: asserting RLS blocks a superuser connection

**Symptom:** `cloudApi.test.js`'s `signup-from-invitation` test asserted that
`membershipRepository.get(orgId, userId)` — called with **no** transaction/GUC context — would see nothing,
citing RLS. It saw the row.

**Root cause:** this test file's `pool` connects using `TEST_DATABASE_URL` directly, which in this
environment (and in every CI service container, which always provisions a plain `postgres` superuser) is a
PostgreSQL **superuser**. Superusers bypass row-level security unconditionally, regardless of
`FORCE ROW LEVEL SECURITY`, regardless of any GUC/transaction context — this is fundamental PostgreSQL
behavior, not a bug in any policy. The assertion was checking something that structurally can never be true
through this connection. (Note this predates and is unrelated to finding #1 above — even with #1 fixed, a
superuser bypasses the policy check entirely and never even evaluates the expression.)

**Fix:** replaced the false assertion with one that's actually meaningful — that the membership *is* visible
when read *with* the correct tenant context via `withTransaction()`. The real "does RLS actually deny an
out-of-context or wrong-tenant read" property is already proven properly, through a genuine dedicated
non-superuser role, in every M05 domain's own "RLS: a different organization cannot see..." test and in
`tenantIsolation.test.js`'s dedicated role-based tests — this assertion was redundant coverage asserting an
impossible negative, not a real check.

### 7. `redis/client.js`: every command raced the connection handshake

**Symptom:** the M06 Redis foundation's own real-Redis test (`redisFoundation.test.js`) hung indefinitely the
first time it ever ran against a real Redis-compatible server, rather than passing or failing — it had only
ever been confirmed to *skip cleanly* without `TEST_REDIS_URL` before this task.

**Root cause:** `createRedisClient()` set `enableOfflineQueue: false`, reasoning (in its own comment) that a
caller "needs to know Redis is down, not hang until a reconnect succeeds." But `ioredis` begins connecting
**asynchronously** the instant `new Redis(...)` returns — the socket is not yet writable. Any command issued
before that handshake completes (exactly what `checkRedisHealth()` does the moment a client is constructed,
and exactly what this test does) is a command sent before the connection exists, and
`enableOfflineQueue: false` makes ioredis **reject** that command immediately
(`"Stream isn't writeable and enableOfflineQueue options is false"`) rather than queue it — indistinguishable,
from the caller's side, from Redis actually being down. Worse, this rejection also hit the client's own
`.quit()` call in cleanup, producing an unhandled rejection that left the test process hanging rather than
exiting. A mock Redis client has no handshake to race, so this could never surface until a real server (and
real connection latency, however small) existed to race against.

**Fix:** removed `enableOfflineQueue: false` entirely. Commands issued during the (typically sub-millisecond,
locally) connection window now queue harmlessly and flush once connected, instead of failing. The original
goal — never hang forever waiting on a genuinely dead Redis — is still met: `connectTimeout`/`commandTimeout`
bound any individual command, and `health.js`'s own `Promise.race(..., timeoutMs)` wrapper bounds a health
check specifically, regardless of what ioredis's internal queue is doing.

**Regression coverage:** `redisFoundation.test.js` (already written, previously unable to prove this) now
passes in under three seconds: health check healthy/unhealthy-with-bounded-wait, key round-trip, cross-org key
isolation.

### Not a bug: a self-inflicted test-invocation mistake

The very first full run also showed `db/pool.test.js`'s "resolvePoolConfig requires a connection string" test
failing. This was caused by exporting `DATABASE_URL` for the *entire* `npm test` invocation (needed only for
the separate `npm run migrate` command) — that unit test specifically asserts behavior when `DATABASE_URL` is
unset, and my own shell environment was masking that. Re-ran with only `TEST_DATABASE_URL`/`TEST_REDIS_URL`
exported (matching the handout's own P1 step 3 instruction precisely, and how CI's `db-migrations.yml` scopes
these variables per-step rather than globally) and this "failure" disappeared with no code or test change —
recorded here only so a future run isn't puzzled by it re-appearing under the same invocation mistake.

## Report (per handout §7)

```text
Task: P1 — Prove the database foundation against a real database
Files changed:
  - system/server/migrations/*.js (11 files): NULLIF() hardening on every RLS policy expression
  - system/server/migrations/1758838500000_seed-permissions-and-roles.js: manager role gains member:manage
  - system/server/src/db/repositories/postgresResearchRunRepository.js: base64 candidateIndex key encoding
  - system/server/src/redis/client.js: removed enableOfflineQueue: false (connection-handshake race)
  - system/server/test/integration/db/postgresApprovalRepository.test.js: clock-ordering fixes
  - system/server/test/integration/db/postgresAssignmentRepository.test.js: clock-ordering fixes
  - system/server/test/integration/db/postgresPolicyRepository.test.js: wait-for-persist race fix
  - system/server/test/integration/db/cloudApi.test.js: corrected false RLS-via-superuser assertion
Database migrations: all 18 existing migrations edited in place (RLS policy text + one seed-data addition);
  no new migration files. Full up/down/up round trip re-verified clean after every change.
Security impact: fixes a real (availability, not confidentiality — see finding #1) RLS-enforcement defect
  present in every organization-scoped table since the very first identity migration; every affected policy
  re-verified via each domain's own real-Postgres tenant-isolation test after the fix.
Tests added: none new; existing coverage (already written across 10+ M05 domains plus M04's identity suite)
  was sufficient — it had simply never executed for real before this task.
Tests run: server suite — 153 files, 1443 tests, 1443 passed, 0 failed, 0 skipped (real PostgreSQL 16.14 +
  real Redis-compatible server, both local dev instances — see below). Desktop suite — 159 passed, 0 failed
  (unaffected, run for baseline confirmation only).
Manual/real-service tests performed: full migration round trip (up/down 0/up) against a real, disposable
  PostgreSQL 16.14 instance (embedded-postgres, no admin rights, no Docker); full suite executed against that
  same instance plus a real Memurai (Redis-protocol-compatible) instance via redis-memory-server.
Real hardware / real device involved: none — this task is database/backend verification only, no Mac mini or
  iPhone involved.
Known limitations: verified against a *disposable, local* PostgreSQL/Redis, not a managed/hosted instance —
  P5's real deployment (Railway or otherwise) still needs its own confirmation once that infrastructure
  exists. No Docker was available or used; `docker-compose.dev.yml` was not created, since embedded-postgres/
  redis-memory-server fully satisfied "a real, disposable database for this verification and ongoing local
  dev" without requiring Docker Desktop or admin rights on this machine — a future contributor with Docker
  available may still prefer a compose file, but nothing here depends on one existing.
Rollback plan: every RLS/seed change is a schema edit to migrations that have never touched a real production
  database; there is no rollback beyond re-running `migrate down 0` against this same disposable instance,
  already verified clean.
Status: PASS
Next task: P2 — wire real login into the running app (single organization, invite-only)
```
