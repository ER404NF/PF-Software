# Roadmap Status Report — updated 2026-09-26

## 2026-09-26 (latest) — P3 complete for all 9 available domains; 2 more real bugs found

Extended P3 (started with sites — see the entry below) to every remaining domain that has a Postgres
adapter: assignments, platform accounts/policies, task queue/runs/checkpoints, approvals, interventions,
proxy pool, audit, and research. Each got the same treatment as sites: a migration script reusing the real
file store's own loading logic (never a hand-rolled parser), a real-PostgreSQL test against realistic
fixtures, and CI wiring — 9 scripts, 9 test files, 41 sub-tests total. Devices/hosts and leases remain
skipped (no Postgres adapter exists for either yet, already documented in `M05_DURABLE_DOMAIN_MIGRATION.md`).
None of the 9 domains had its actual cutover (step 4 — switching `index.js` to read Postgres) flipped: that
needs a real deployment to "watch run correctly for a while" first, per the handout's own explicit
instruction and its "no big-bang cutover" safety rule.

**Two more real bugs, on top of sites' own** (full detail in
[docs/productionization/P3_DOMAIN_CUTOVER.md](productionization/P3_DOMAIN_CUTOVER.md)):

- **A genuine cross-test-file bug, found only by running the *entire* suite together, not any file in
  isolation:** `automation.task_queue_snapshots` has exactly one row per organization by design — unlike
  every other domain's tables, there's no random per-test id to prevent collisions. The new task-queue
  migration test saved a real snapshot for the shared default organization and never cleaned it up,
  silently breaking a *different*, pre-existing test file's "nothing has been saved yet" precondition
  whenever both happened to run in the same `npm test` invocation. Fixed with a proper cleanup hook. This is
  exactly the kind of interaction bug that only running the whole suite together — not just the file you
  just touched — can ever surface, and why "run the full suite after every change" has been the standing
  practice all along.
- A test-fixture-only issue in the approvals migration test (a fixed past `expiresAt` that real lazy
  expiration correctly aged out by the time the test ran) — same root lesson as sites' `rotated_at` mistake:
  model fixtures on what the real system actually produces, not on what merely looks plausible.

Full local server suite: **164 files, 1,554 tests, 1,554 passed, 0 failed, 0 skipped** — the whole suite,
which is what caught the cross-file bug above; no individual new test file would have. This closes out P3
for every domain currently reachable without a real deployment. Full write-up in
[docs/productionization/P3_DOMAIN_CUTOVER.md](productionization/P3_DOMAIN_CUTOVER.md).

## 2026-09-26 — P3 begins: sites domain migration script, another real bug found

Started `PHASE1_TEAM_ROLLOUT_HANDOUT.md`'s P3 (move durable data off files, one domain at a time), following
its required order. Devices/hosts is skipped — `M05_DURABLE_DOMAIN_MIGRATION.md` already documented that it
needs its own design pass and has no Postgres adapter to cut over to yet; that's a pre-existing gap, not a
new decision.

**Sites domain**: wrote `system/server/scripts/migrate-sites-to-postgres.js`, a one-time, safe-to-re-run
(upsert by id) script that reads the real file-backed `sites.json` and writes matching rows into
`fleet.sites`, reporting before/after counts. The one subtlety that mattered: it preserves the **token hash**
exactly rather than generating a fresh one — neither the file nor Postgres store ever persists the plaintext
token, so a real site agent's already-saved token must keep verifying against whatever hash the migration
writes, or every Mac mini would need re-enrolling by hand the moment this ran for real.

**Another real bug, found by the migration's own test on its first run**: the test's fixture modeled a "never
rotated" site as `rotatedAt: null` — but `fleet.sites.rotated_at` is `NOT NULL DEFAULT now()`, and the real
file store never actually produces that state either (`siteStore.js`'s own `create()` always sets
`rotatedAt: now`, the same as `createdAt`, at creation — "never rotated" means *equal to created_at*, not
absent). Fixed the test fixture to match the real system's actual invariant, and separately hardened the
migration script itself with a defensive `rotatedAt ?? createdAt` coalesce, since the file store's own loader
doesn't validate every field's presence — a genuinely malformed legacy record shouldn't crash a one-time
migration either. A dedicated test proves the coalesce.

**Step 4 (the actual cutover — switching `index.js` to read Postgres instead of the file) is deliberately not
done.** The handout's own instruction is to watch the domain run correctly for a while post-cutover before
removing the file fallback — an operational observation step that requires a real deployment with real
traffic, which doesn't exist in this environment. Flipping a flag without that would be exactly the
"no big-bang cutover" mistake the handout's own safety rules (§2) exist to prevent. Full reasoning in
[docs/productionization/P3_DOMAIN_CUTOVER.md](productionization/P3_DOMAIN_CUTOVER.md).

Full local server suite: **156 files, 1,516 tests, 1,516 passed, 0 failed, 0 skipped.** Next: repeat this
same pattern (migration script + test, no cutover yet) for assignments, platform accounts/policies, task
queue/runs, approvals/interventions, research, proxy pool, and audit.

## 2026-09-26 — P2 fuzzing (2 more real bugs) + P4 decision recorded

Fuzzed every JSON-bodied cloud API route and every authenticated route, mounted for real, with malformed
JSON, `null`, bare arrays, wrong-typed fields, prototype-pollution shapes, oversized bodies, and hostile
Bearer tokens — 62 sub-tests in new `cloudApiFuzz.test.js`. Found and fixed **two more real bugs**:
`POST /login` and `POST /password-reset/request` both crashed with a 500 (`email.trim is not a function`)
when sent a non-string `email`, since both only checked `if (!email)` (a falsy check a truthy non-string
sails past) before calling straight into `userRepository.getByEmail()`. Fixed with an explicit
`typeof email !== "string"` check in both routes — for `/password-reset/request` specifically, this
preserves its own deliberate uniform-202 response for malformed input, it just stops the crash. Also caught
and corrected two test-only false positives along the way: expecting a 4xx from `/password-reset/request`'s
own intentionally-uniform 202 response, and a "hostile" Authorization header that Node's own `fetch()`
refused to even transmit (a raw UTF-16 surrogate half / control bytes aren't legal HTTP header content for
any real client either).

Added a real coverage gap closer: `GET /organizations/:id/members`'s own wrong-organization rejection
(the one route gated by `requireMembership()` alone, no specific permission — a different middleware
configuration than the two already fully matrix-tested).

**P4 (Redis: decide, don't assume) — decision recorded in
[M06_REDIS_FOUNDATION.md](productionization/M06_REDIS_FOUNDATION.md):** do not build out Redis-backed
presence/locks for Phase 1. At 5–8 devices behind one hub process, there's no multi-instance coordination
problem for Redis to solve yet; the device-lease race stays a PostgreSQL-level lock once that domain moves to
Postgres in P3. Revisit only if the owner wants multiple hub processes (e.g. zero-downtime deploys) or the
fleet outgrows a single hub's in-memory state — the M06 foundation is already there and proven (P1) for when
that day comes.

Full local server suite: **155 files, 1,510 tests, 1,510 passed, 0 failed, 0 skipped.** Full write-up in
[docs/productionization/P2_REAL_LOGIN_MOUNTED.md](productionization/P2_REAL_LOGIN_MOUNTED.md). This closes
out P1, P2 (including its step 5 fuzzing requirement), and P4. Remaining Phase 1 work (P2b real SMTP, P3
per-domain cutover, P5 real deployment, P6 further bug-hunting) is either owner-account-gated (real SMTP
provider, real Railway/hosting account, real Mac minis) or large enough to warrant its own dedicated pass.

## 2026-09-26 — P2: real login mounted into index.js, a second real bug found

Per `PHASE1_TEAM_ROLLOUT_HANDOUT.md`'s P2 task: mounted the M04 identity/organization system (built and
verified in earlier sessions, but never wired into the running server) into `system/server/src/index.js`,
behind `process.env.CLOUD_API_ENABLED === "true"`, at `/api/cloud` — additive, alongside the existing
file-backed operator login, which is completely untouched either way. Added `allowOrganizationSignup` to
`createCloudApi.js` (default `true`, so every existing caller keeps working) so Phase 1's mount can pass
`false` and 404 the one route (`POST /signup`) that creates a brand-new organization — Phase 1 has exactly
one, created once at startup via `ensureDefaultOrganization()`, and no public "create an account" route
should exist. Recorded the required role-model decision explicitly (P2 step 6): this identity layer replaces
only account lifecycle; device-control authorization (`roleCapabilities.js`) is untouched, the handout's own
recommended default.

**Doing this — actually mounting for real, not just testing `createCloudApi()` as its own standalone app —
found a second real, serious bug**, in `docs/productionization/P2_REAL_LOGIN_MOUNTED.md`: the cloud API's
`authenticate` middleware set `req.session = <bearer-token session row>` — but `index.js` already runs
`express-session` globally, which owns `req.session` as its own `Session` instance with a real `.touch()`
method, and depends on that object surviving to the end of the response. The two independent "session"
concepts collided the instant both existed on the same request, throwing `req.session.touch is not a
function` deep inside `express-session`'s own response hook. No standalone test of `createCloudApi()` could
ever have caught this — it only exists at the intersection of the two systems. Fixed by renaming the cloud
API's own property to `req.identitySession` everywhere it's set or read.

Added `system/server/test/integration/db/cloudApiMountedInIndex.test.js`: boots the **actual**
`system/server/src/index.js` with `CLOUD_API_ENABLED=true` against a real database and runs a complete,
real, end-to-end sequence over real HTTP — invite a VA by email, accept the invite, log in, enroll real TOTP
two-factor (computing a genuine code from the returned secret, not a stub), confirm it, log out, and confirm
the session is actually revoked afterward — plus confirms the legacy `/api/login` route is completely
unshadowed by the new mount. This is P2's own required proof ("an invite, real login, and a live two-factor
setup completed end to end — not a log line claiming it worked"), satisfied for real.

Full local server suite re-run after both fixes: **154 files, 1,447 tests, 1,447 passed, 0 failed, 0
skipped.** Full write-up in
[docs/productionization/P2_REAL_LOGIN_MOUNTED.md](productionization/P2_REAL_LOGIN_MOUNTED.md). Next:
finish the remaining authorization-matrix cells, fuzz every cloud-facing route, then P2b (real SMTP).

## 2026-09-26 — P1: real PostgreSQL + Redis verification, 7 real bugs found and fixed

Per `docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md`'s P1 task: brought up a real, disposable
PostgreSQL 16.14 (via `embedded-postgres`, no Docker/admin rights needed) and a real Redis-compatible server
(Memurai via `redis-memory-server`) as local dev tooling, then ran the full migration set and the entire
server suite against them for the first time in this project's history — every one of the 19 previously
CI-only/always-skipped real-database/Redis tests had, per the handout's own account, never actually executed
anywhere, including in GitHub Actions.

Doing so surfaced **7 real, previously-invisible bugs**, full detail in
[docs/productionization/P1_REAL_DATABASE_VERIFICATION.md](productionization/P1_REAL_DATABASE_VERIFICATION.md):

1. **Systemic RLS defect (the serious one):** once a custom Postgres GUC (`app.current_organization_id`/
   `app.current_user_id`) has been set via `SET LOCAL` and that transaction commits, `current_setting(name,
   true)` returns `''` — not `NULL` — for the rest of that session, even after `RESET`. Every RLS policy in
   this codebase compared that value directly against `::uuid`, so any query on a pooled connection that had
   previously served a `withTransaction()` call, run *without* a fresh transaction context, threw a raw
   Postgres exception instead of failing closed. Fixed with `NULLIF(current_setting(...), '')::uuid` across
   all 31 occurrences in 12 migration files — a real production-reliability defect, invisible to any mock,
   only reproducible against a real connection pool.
2. Seed data bug: the `manager` role was never actually granted `member:manage` (only `member:invite`),
   contradicting the route and test's own intent — one line missing from
   `1758838500000_seed-permissions-and-roles.js`.
3. `researchStore.js`'s cross-run dedup index keys use a `\u0000` join — fine in a JSON file, a hard Postgres
   error in `jsonb`. Fixed by base64-encoding/decoding those specific keys at the Postgres storage boundary
   only (`postgresResearchRunRepository.js`), leaving the shared dedup logic and the file store untouched.
4–5. Two test files (`postgresApprovalRepository.test.js`, `postgresAssignmentRepository.test.js`) share one
   mutable fake clock across many sequential sub-tests; several assertions depended on the clock having moved
   relative to fixture dates that it hadn't yet — the adapters were correct throughout; only the tests' own
   chronology was wrong.
6. `cloudApi.test.js` asserted RLS blocks a query run through the test's own connection pool — which connects
   as the Postgres **superuser**, and superusers bypass RLS unconditionally regardless of any policy or GUC
   context. Replaced with a real check (membership *is* visible with correct tenant context); the actual
   fail-closed property is already proven properly elsewhere via genuine non-superuser roles.
7. `redis/client.js`'s `enableOfflineQueue: false` rejected any command sent before ioredis's asynchronous
   connection handshake completed — including the very first health check after construction — causing
   `redisFoundation.test.js` to hang indefinitely the first time it ever ran against a real server. Removed;
   `connectTimeout`/`commandTimeout`/`health.js`'s own timeout wrapper already bound the cases that setting
   was meant to guard against.

**Final result: server suite 153 files, 1,443 tests, 1,443 passed, 0 failed, 0 skipped — the first time
every test in this project has ever run and passed for real, not skipped.** Desktop suite unaffected: 159
passed, 0 failed. Full migration round trip (up → down 0 → up) re-verified clean after every schema change.

This closes out Phase 1 task P1. Next: P2 (mount real login into the running server behind a flag).

## 2026-09-26 — M05 part 10: account policies, unblocked by a new shared sync-cache utility

Built `server/src/syncCache.js` — a generic, in-memory synchronously-readable cache backed by any durable
store — specifically to unblock platform accounts/policies (`policyStore.js`), which turned out to have the
exact same "read from a never-awaited hot path" constraint as background authorization: `index.js` feeds
`policyStore.effective(...).get(accountId)` straight into `actionPolicy.js`'s `validateAction()` gate, called
inline with no `await`. A naive per-call-query Postgres adapter would have satisfied an M02 contract's method
names while silently breaking the moment it was wired in for real — caught during design, not after shipping
a broken adapter. The cache loads the full snapshot once at construction, updates immediately on every local
write (before the durable write is even sent), and supports an optional poll-based refresh for picking up
another process's writes — deliberately poll-based, not push-based invalidation, since there's no real
multi-instance deployment here to test push-based invalidation against.

Built the M02 port (`persistence/policyRepository.js` + `persistence/filePolicyRepository.js`, no port existed
for this domain before now), the migration (`automation.account_policies`), and
`postgresPolicyRepository.js`, which loads the whole override table into a `syncCache` and keeps
`set()`/`clear()` returning the exact same plain object/void `PolicyStore` already returns — never a Promise
— while persisting to Postgres in the background.

Real-PostgreSQL test proves the interesting part directly: a write is visible to `effective()`/`describe()`
on the very next line in the *same* process, but a *separate* repository instance (simulating another
process/pod) only sees it after an explicit `refresh()` — the eventual-consistency boundary is demonstrated,
not just asserted in a comment. Also covers validation parity, config-then-default fallback, and tenant
isolation through a non-superuser role. 10 new pure unit tests cover the cache mechanism itself with no
database needed (load formats, write-before-persist-settles ordering, error reporting without breaking the
sync contract, refresh success/failure). Wired into `.github/workflows/db-migrations.yml` as the seventeenth
PostgreSQL CI step.

**Correction made before any further code was written:** background authorization
(`persistence/backgroundAuthorizationRepository.js`) has the identical synchronous-read constraint, but its
file adapter resolves through `authStore.js`'s own operator registry — the same data source
`operatorIdentityRepository.js`/`operatorAccountRepository.js` already read, and the same one already flagged
as needing an owner decision on reconciling with `identity.users` before any of it moves to Postgres.
`syncCache.js` is a necessary piece of that domain's eventual solution, but doesn't unblock it alone — the
identity-reconciliation decision is still the real gate. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **153 files, 1,312 tests, 1,293 passed, 0 failed, 19
skipped** (the 19 skips are every PostgreSQL/Redis-gated test, correctly skipping without a live database or
Redis).

## 2026-09-26 — M06 begins: Redis foundation (client, health check, key schema)

With every cleanly-fitting M05 domain done (see the entry below) and the rest genuinely blocked on design/
owner decisions, moved to M06 per the master prompt rather than spinning further on M05. Installed
`ioredis@^5` (0 vulnerabilities), then built the foundation layer only — deliberately not migrating any real
domain yet, mirroring how M03 (Postgres foundation) preceded M04/M05's actual domain work:

- `system/server/src/redis/client.js` — `createRedisClient()`, mirroring `db/pool.js`'s shape
  (`REDIS_URL`, timeouts, TLS-verification-must-be-explicit, a required client-level error handler,
  `enableOfflineQueue: false` so a caller finds out immediately when Redis is unreachable instead of hanging).
- `system/server/src/redis/health.js` — `checkRedisHealth()`, a bounded-timeout `PING`.
- `system/server/src/redis/keys.js` — the actual substance of
  [ADR-0003](productionization/adrs/ADR-0003-redis-ephemeral.md)'s action item 1: `orgKey()` builds the ADR's
  own `pf:org:{organizationId}:...` tenant-scoped format (UUID-validated, so a bad value can't collide with
  another tenant's namespace — the same guarantee Postgres RLS gives at the database layer, expressed as a
  naming convention since Redis has no RLS equivalent), and `assertBoundedPayload()` gives "no raw secrets or
  unbounded payloads in Redis" a real enforced ceiling (16 KiB) instead of leaving it as an unenforced
  sentence in the ADR. Deliberately did **not** add a speculative `globalKey()` helper or a generic
  `setWithTtl()` wrapper — no real caller needs either yet, and adding them now would be exactly the kind of
  ungrounded design this project avoids.

Real-Redis test (`system/server/test/integration/redis/redisFoundation.test.js`, new
`.github/workflows/redis-foundation.yml` with a `redis:7` service container) covers: health check
healthy/unhealthy (with a bounded wait, not a hang); an `orgKey()` value round-tripping through a real
`SET`/`GET` with a confirmed TTL; two organizations' keys never colliding. 6 pure unit tests
(`redisKeys.test.js`) cover `orgKey()`'s validation and the payload limit with no Redis required. Full write-up
in [docs/productionization/M06_REDIS_FOUNDATION.md](productionization/M06_REDIS_FOUNDATION.md). Full local
server suite re-run after this addition: **150 files, 1,298 tests, 1,280 passed, 0 failed, 18 skipped** (the
18 skips are every PostgreSQL/Redis-gated test, correctly skipping without a live database or Redis).

**Nothing real runs on Redis yet** — presence (`presenceStore.js`, currently in-process `Map`s) is the
concrete next candidate per ADR-0003's own stated use case, but that's real design work for its own slice, not
bundled into the foundation.

## 2026-09-26 — M05 part 9: research runs — closes out every cleanly-fitting domain

Added `automation.research_accounts` and `postgresResearchRunRepository.js`, satisfying
`persistence/researchRunRepository.js`'s 8-method contract. This was the most complex domain in M05 so far:
`researchStore.js` keeps one JSON file per (workspace, account) holding both a run's candidates and a
cross-run dedup index (`byContentId`/`byUrl`) that lets a later run recognize a previously-seen post and carry
its human review decision forward instead of resetting to "pending." Rather than redesigning that index as
live relational queries, the migration mirrors the file shape exactly — one row per
`(organization_id, workspace_id, account)` holding `{runs, candidateIndex}` as one `jsonb` blob, same
reasoning as the task queue snapshot. Critically, the dedup/merge algorithm itself (`candidateRecord`,
`findIndexEntry`, `upsertIndexEntry`, `mergeCandidate`, `indexCandidate`, `normalizePlatformAction`,
`samePlatformAction`) was exported from `researchStore.js` — these were already pure functions, so this was
an additive `export` keyword each, not a rewrite — and the Postgres adapter calls them in the identical
sequence the file store does. The cross-run dedup logic literally cannot drift between backends because it's
the same function calls in both. Re-ran `researchStore.js`'s existing 40 unit/integration tests after the
exports and confirmed nothing observable changed.

Real-PostgreSQL test proves the whole point of the cross-run index: a second run re-observing a post a human
already reviewed in an earlier run carries that `confirmed`/`removed` decision forward rather than
re-surfacing it as pending. Also covers invalid-key handling, candidate merge-not-duplicate, `locateCandidate`,
idempotent `recordPlatformAction`, `finalizeRun` validation, `setCandidateStatus` value restriction, tenant
scoping, and real tenant isolation through a non-superuser role. Wired into `.github/workflows/db-migrations.yml`
as the sixteenth PostgreSQL CI step.

**This closes out every M05 domain identified as fitting the migration pattern cleanly.** What's left —
platform accounts/policies (needs an M02 wrapper first), research evidence/device media (object storage per
ADR-0004, not Postgres), background authorization (needs a synchronous cached-snapshot design), operator
identity/accounts (needs an owner decision on reconciling with M04's identity model), leases and devices
(each needs its own design pass) — every remaining domain needs a design or owner decision before further
implementation, not just more mirroring. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **148 files, 1,291 tests, 1,274 passed, 0 failed, 17
skipped** (the 17 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 8: proxy pool, plus scope triage for the remaining domains

Added `automation.proxy_pool` and `postgresProxyPoolRepository.js`, satisfying
`persistence/proxyPoolRepository.js`'s 8-method contract. Reused `proxyPool.js`'s own `publicProxy()`/
`decryptProxyPassword()` pure transforms rather than duplicating them (per that module's own header comment),
and exported its previously-internal `validateFields()` for the same reason — re-ran its existing unit test
to confirm the export change was behavior-preserving. A partial unique index
(`organization_id, leased_to_device_id WHERE ... IS NOT NULL`) gives the "one leased proxy per device"
invariant a real database-level backstop on top of the application-code check.

**Triaged the rest of the master prompt's remaining M05 domains** rather than migrating them all
mechanically: research evidence and device media wrap *binary* file storage, which this repo's own
[ADR-0004](../docs/productionization/adrs/ADR-0004-object-storage.md) already assigns to object storage, not
PostgreSQL — out of scope for this migration pattern entirely. Background authorization
(`persistence/backgroundAuthorizationRepository.js`) is documented as synchronous by design (dispatch-loop
callers need an immediate, non-awaited answer) — a naive `async` adapter would satisfy the method-name
contract but violate that real constraint, so it needs a caching/snapshot design pass, not a direct port.
Operator identity/accounts are the two halves of the legacy `authStore.js` operator system — migrating the
*accounts themselves* (not just references to them) to Postgres would either fork a second permanent
identity/credential store next to `identity.users` or force reconciling the two, which is an owner decision
on the same order as the "one default organization" call already made, not something to default into
silently. That leaves **research runs** as the one cleanly-fitting domain still open.

Real-PostgreSQL test covers field validation, at-rest encryption, the exclusive per-device lease (assign,
reassign displacing the prior lease, release), `remove()`'s leased-proxy guard, `updateHealth()`'s safe-field
filtering, `publicList()`'s credential-free shape, tenant scoping, and real tenant isolation through a
non-superuser role. Wired into `.github/workflows/db-migrations.yml` as the fifteenth PostgreSQL CI step. Full
write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **147 files, 1,290 tests, 1,274 passed, 0 failed, 16
skipped** (the 16 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 7: audit events

Added `automation.audit_events` and `postgresAuditEventRepository.js`, satisfying
`persistence/auditEventRepository.js`'s two-method contract (`logEvent`/`listEvents`) — the domain
`CLAUDE.md` §3 names as "audit events, observability." Mirrors `auditLog.js` exactly: `operator`/`deviceId`
stay plain text, `detail` stays a round-tripped `jsonb` blob (redaction remains the caller's job, not this
layer's), and `listEvents()`'s "filter by operator/deviceId, newest first, then cap at limit" semantics are
expressed directly in SQL (`WHERE` + `ORDER BY at DESC` + `LIMIT`) rather than the file store's in-memory
filter/reverse/slice pipeline — same result, different mechanism.

Real-PostgreSQL test covers the full entry shape and exact `detail` round-tripping, newest-first ordering,
operator/deviceId filtering independently and combined, `limit` handling, an empty result for an organization
with nothing logged, tenant scoping, and real tenant isolation through a non-superuser role. Wired into
`.github/workflows/db-migrations.yml` as the fourteenth PostgreSQL CI step. This closes out the third domain
identified in the M02-persistence-port discovery (notifications, task queue snapshot, audit events); remaining
identified domains are research evidence, research runs, proxy pool, device media, background authorization,
and operator identity/accounts — plus platform accounts/policies, which still needs its own M02 wrapper
first. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **146 files, 1,289 tests, 1,274 passed, 0 failed, 15
skipped** (the 15 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 6: task queue snapshot (command-queue restart survival)

Added `automation.task_queue_snapshots` and `postgresTaskQueueSnapshotRepository.js`, satisfying
`persistence/taskQueueSnapshotRepository.js`'s two-method contract (`load`/`save`). This is the domain the
master prompt names directly — `CLAUDE.md` §7's "queue state survives process restarts." Per the port's own
design intent, the snapshot is one opaque `jsonb` blob per organization, not per-task rows — `taskQueue.js`
keeps all scheduling/dispatch/retry/checkpoint domain logic; only the read/write boundary moved.

The one piece of real logic in this domain — legacy bare-array migration and crash recovery for tasks that
were `RUNNING`/`DISPATCHED` when the process died — was extracted into an exported pure function,
`normalizeQueueSnapshot()`, in the contract module itself, so both the file and Postgres adapters share
exactly one copy rather than risking drift between two reimplementations of restart-recovery logic. The file
adapter's existing unit test was re-run after the extraction and passed unchanged.

Real-PostgreSQL test covers an empty snapshot before any save, exact round-tripping of tasks/paused/
humanHolds, `save()` upserting a single row per organization, RUNNING-task recovery into QUEUED within its
retry policy (and that a second `load()` doesn't double-apply the recovery), legacy bare-array migration
persisting the migrated shape, tenant scoping, and real tenant isolation through a non-superuser role. Wired
into `.github/workflows/db-migrations.yml` as the thirteenth PostgreSQL CI step. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **145 files, 1,288 tests, 1,274 passed, 0 failed, 14
skipped** (the 14 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 5: account notifications, and a discovery about remaining scope

Added `automation.account_notifications` and `postgresNotificationRepository.js`, mirroring
`accountNotificationStore.js` exactly (queue/list/deliveryContent/markCommitted/markAborted/markSent/
markFailed/canSecureRecovery). The AES-256-GCM encrypt/decrypt logic for recovery bodies was extracted out of
the file store's closures into exported, key-parameterized functions (`encryptNotificationBody`/
`decryptNotificationBody`) that both adapters now import, rather than duplicating security-sensitive crypto
code — re-verified the file store's own unit test still passes unchanged after the extraction. The schema
enforces the file store's "recovery bodies are never at rest in plaintext" guarantee directly with a `CHECK`
constraint tying `body`/`secure_payload` to `kind`, not just in application code.

**Scope discovery while picking this slice:** `system/server/src/persistence/` already contains a formalized
M02 repository-port layer (`assertXRepository()` + `fileXRepository.js`) for far more domains than this
status file had been tracking — research evidence, research runs, task queue snapshots, proxy pool, device
media, background authorization, operator identity, operator accounts, and audit events all already have one,
and `index.js` already calls through these ports rather than constructing the underlying stores directly. That
means most of the master prompt's remaining M05 domains are now Postgres-adapter-only work (no new M02
contract design needed) — the one exception found so far is platform accounts/policies (`policyStore.js`),
which `index.js` still constructs directly and has no M02 port yet.

Real-PostgreSQL test covers queue/list ordering, the `holdForCommit` → `markCommitted`/`markAborted` path
(idempotent on repeat calls), `markSent`/`markFailed`'s "only advance a still-queued item" guard, `mark*()` on
an unknown id returning `null`, recovery notifications being encrypted at rest and decrypted only through
`deliveryContent()`, `canSecureRecovery()` requiring no DB access, tenant scoping, and real tenant isolation
through a non-superuser role. Wired into `.github/workflows/db-migrations.yml` as the twelfth PostgreSQL CI
step. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **144 files, 1,287 tests, 1,274 passed, 0 failed, 13
skipped** (the 13 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 4: assignments

The complex domain flagged in the previous entry. Added `automation.assignments` (mirrors `assignmentStore.js`
exactly plus `organization_id`) and `postgresAssignmentRepository.js`, implementing all 8 contract methods
(`list`, `get`, `create`, `setStatus`, `reassign`, `renamePrincipal`, `reschedule`, `expireDue`). The
identity-mapping question flagged last entry was resolved the same way as approvals/interventions:
`assignee`/`createdBy` stay plain text tied to the file-backed `authStore.js` operator system, not
`identity.users` — reconciling that with M04's user model is a separate decision this slice does not force.
Timestamps are real `timestamptz` (unlike approvals'/interventions' bigint epoch-ms), explicitly re-serialized
back to ISO strings in the row mapper so the contract keeps returning what the file store always returned.
Recurrence reuses `zonedRecurrence.js` unchanged.

Two bugs found and fixed during this slice's own "check for errors, fix, check again" pass, not by CI (no
local database exists to run the real test against):

1. **`expireDue()` frozen-snapshot divergence** — the file store's `assertNoOverlap` closes over a pre-tick
   snapshot of all assignments, so within one batch tick every overlap check sees the same frozen state, never
   a sibling row already advanced earlier in the same tick. A first draft using a live DB query per row inside
   one shared transaction would have let an earlier row's update leak into a later row's overlap check —
   fixed by fetching one snapshot query up front and checking candidates against that static array instead.
2. **A tautological test assertion** in the conflict-isolation test that would pass regardless of the actual
   value — found on a self-review of the test file, replaced with real assertions on the expected `status` and
   `startAt`.

Real-PostgreSQL test covers create/list/get, overlap rejection and non-overlap success, `setStatus` state
transitions and history, recurring-completion window advancement, `reassign`/`renamePrincipal`/`reschedule`,
plain and recurring-with-conflict-isolation `expireDue` cases, tenant scoping, and real tenant isolation
through a non-superuser role. Wired into `.github/workflows/db-migrations.yml` as the eleventh PostgreSQL CI
step. This closes out the four M05 domains attempted so far (sites, approvals, interventions, assignments);
remaining M05 domains (leases, platform accounts/policies, task queue/runs/checkpoints, research metadata,
notifications, proxy/network metadata, audit metadata) are not started. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **143 files, 1,286 tests, 1,274 passed, 0 failed, 12
skipped** (the 12 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 3: interventions

Same shape and reasoning as approvals — `InterventionQueue` is exactly the same kind of small, self-contained,
already-tested class with a stable M02 contract. Added `automation.interventions` (mirrors its exact fields
plus `organization_id`) and `postgresInterventionRepository.js`, reusing the file store's own
`classifyIntervention()` reason-to-kind heuristic rather than reimplementing it, and throwing the identical
plain `Error` messages the file store throws (`InterventionQueue` has no custom error class, unlike
`ApprovalStore`/`SiteStore` — parity means matching that, not adding one it never had).

One deliberate non-parity decision, recorded rather than silently applied: this adapter does **not** replicate
`InterventionQueue`'s own `_trim()` (capping `RESOLVED` items to bound JSON file size) — a database table
doesn't have the unbounded-file-growth problem that only existed because of the old storage format; real
retention/pruning is a policy decision for later, not something to force into parity with a workaround that no
longer applies.

Real-PostgreSQL test proves task+kind deduplication (with auto-classification), claim/resolve state
transitions including the identical "Already claimed by X" rejection message, resolve-on-already-resolved
being a safe no-op that doesn't overwrite who resolved it first, `resolveForTask()` closing every open item at
once, and — same as sites/approvals — genuine tenant isolation through a non-superuser role. Wired into
`.github/workflows/db-migrations.yml` as the tenth PostgreSQL CI step. This closes out every M05 domain that
fits the "small, self-contained, already-tested class" shape; **assignments** is next and is meaningfully more
complex (recurrence, overlap detection, a JSON history array, and its own identity-mapping question, since its
`assignee`/`createdBy` fields are plain operator-username strings tied to the file-backed `authStore.js`
system, not `identity.users`). Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite: **142 files, 1,285 tests, 1,274 passed, 0 failed, 11 skipped** (the 11 skips are
every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 2: approvals (and why devices was skipped for now)

Before starting "devices" (next in the master prompt's suggested M05 order), repository inspection found a
real reason to reorder: `deviceRegistry.js` is a 77-line pure transform, not a stateful store like `SiteStore`
— device state is deeply live (connection status, capabilities, health reconstructed from actual USB/WDA
discovery on every restart), not simple CRUD data. Forcing that into today's "swap the persistence adapter
behind an unchanged contract" pattern would misrepresent what's actually happening. `approvalStore.js`, by
contrast, is exactly `SiteStore`'s shape — a small, self-contained, already-tested class with a stable M02
contract — so it became the second M05 domain instead, per the master prompt's own "follow this order unless
repository inspection proves a dependency requires adjustment."

Added `automation.approvals` (mirrors `ApprovalStore`'s exact fields plus `organization_id`; timestamps stored
as `bigint` epoch-ms, not `timestamptz`, deliberately matching the file store's `Date.now()`-based values
exactly rather than silently changing the adapter's return shape) and
`postgresApprovalRepository.js` — reuses `ApprovalStore`'s own `ApprovalError`/`approvalFingerprint`/
`APPROVAL_STATES` rather than reimplementing them, and replicates its lazy-expire-on-every-operation semantics
exactly (every method expires stale `PENDING`/`APPROVED` rows before doing its own work).

Real-PostgreSQL test proves fingerprint deduplication, approve/reject/consume semantics (including that a
double-consume returns `null` rather than consuming twice), identical `ApprovalError` codes for every rejected
case the file store rejects, lazy expiry actually firing on read (not silently vanishing), and — same as
sites — genuine tenant isolation through a non-superuser role. Wired into `.github/workflows/db-migrations.yml`
as the ninth PostgreSQL CI step. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite: **141 files, 1,284 tests, 1,274 passed, 0 failed, 10 skipped** (the 10 skips are
every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 begins: durable domain migration, sites (owner decision resolved)

Before starting M05 (migrating the existing file-backed domains — sites, devices, assignments, queue, etc. —
into PostgreSQL), hit a real fork rather than guessing through it: every migrated row needs an
`organization_id` per the master prompt's schema, but M04's cloud identity system is separate, parallel
infrastructure with no connection to the existing single-tenant site/device data. Asked directly: **the
existing deployment wraps in one auto-created default organization** (not left tenant-less). Recorded in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md)
since it shapes every subsequent M05 domain, not just this one.

Built the pattern each future domain should follow: `db/defaultOrganization.js` (idempotent bootstrap, `ON
CONFLICT ... DO UPDATE ... RETURNING`, not check-then-insert — safe against two processes racing on a fresh
database), a `fleet.sites` migration mirroring the existing file-backed `SiteStore`'s exact fields plus
`organization_id`, and `postgresSiteRepository.js` — satisfying the identical M02 `siteRepository.js` contract
(same methods, same `SiteError`/`duplicate_site`/`unknown_site` codes) so a caller never needs to know which
adapter is active. **`index.js` still uses the file adapter exclusively — nothing was cut over, no real site
data was migrated.** This is the "new implementation behind interface" step of the migration principle, not
the cutover.

Real-PostgreSQL test proves parity with the file adapter (identical create/rotate/verify/error-code behavior)
plus genuine tenant isolation on the new table through a non-superuser role — a different organization's
context sees nothing of the default organization's sites. Wired into `.github/workflows/db-migrations.yml` as
the eighth PostgreSQL CI step. Full local server suite: **140 files, 1,283 tests, 1,274 passed, 0 failed, 9
skipped** (the 9 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M04 part 6c: member suspension/reactivation

Closed the *suspension* half of the "suspension/deletion lifecycle" gap (hard deletion stays out of scope —
M16's GDPR-style anonymization work, not this milestone's). The enforcement already existed by construction:
`requireMembership()` already 403s a non-active membership and `authenticate()` already 401s a non-active
user, on every request. What was missing was the admin-facing way to actually change that status. Added
`GET /organizations/:id/members` (any active member can see the roster — no dedicated `member:view`
permission exists, matching the common default that team visibility isn't itself privileged) and
`PATCH /organizations/:id/members/:membershipId` (gated by `member:manage`, deliberately refusing to let a
caller change their own membership through this route — the simplest way to prevent an org locking itself out
of its own management, rather than building unverified "at least one active owner" invariant logic).

The real-PostgreSQL/real-HTTP test proves the enforcement is genuinely immediate, not just theoretically so: a
target user's session works, a manager suspends them, and that *same still-valid, unrevoked* session is
rejected on the very next request — no session revocation needed, because membership status is checked fresh
on every request already. Also covers wrong-role rejection, an invalid status value, self-targeting, and a
membership id from a different organization (400/400/404). Full write-up in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **138 files, 1,280 tests, 1,272 passed, 0 failed, 8 skipped** (unchanged counts — the new
subtests live inside the already PostgreSQL-gated `cloudApi.test.js`).

## 2026-09-26 — M04 part 6b: signup-from-invitation, real email delivery, password validation

Closed out three items part 6 had left open. `POST /signup-from-invitation` lets someone with no existing
account complete an invitation in one step — creates the user under the invitation's own email (never a
client-supplied one), marks it verified immediately (completing an *emailed* invitation link already proves
control of that address), then accepts. `createCloudApi()` gained optional `mailSender`/`companyEmail`
parameters (default `null` — every flow still works without them, just logs locally instead of sending,
matching `accountNotificationStore.js`'s own established convention); `/signup`, `/organizations/:id/invitations`,
and `/password-reset/request` now actually call `mailSender.js`, fire-and-forget so a slow or failing SMTP
call never adds latency to the HTTP response — matching this codebase's existing password-recovery-route
precedent for exactly that timing-side-channel reason. Also exported and wired in `authStore.js`'s existing
`validatePassword` (12-character minimum) to `/signup`, `/signup-from-invitation`, and `/password-reset/confirm`
— previously `/signup` accepted a password of any length, including empty.

New real-PostgreSQL/real-HTTP test coverage: signup-from-invitation creates a real, immediately-usable
account+session and rejects a reused token; a fake `mailSender` (recording calls) proves the three routes
above call it with the right recipient/content and that an unknown email triggers no send; an unknown
organization id 404s rather than 403ing; `/me/mfa/enroll` demonstrates `authenticate` behaves identically on a
route with no membership/permission layer. Full write-up in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **138 files, 1,280 tests, 1,272 passed, 0 failed, 8 skipped** (unchanged file/test counts
from part 6 — the new subtests all live inside the same PostgreSQL-gated `cloudApi.test.js`, which node:test
skips as one unit locally, same as every other DB-gated file).

## 2026-09-26 — M04 part 6: a real HTTP API and the required authorization matrix

Built `system/server/src/cloudApi/createCloudApi.js` — a self-contained Express app (signup, login with TOTP
MFA check, logout, `/me`, invitations, MFA enroll/confirm, password reset, email verification), deliberately
**not mounted into `system/server/src/index.js`**: it's new infrastructure for the master prompt's future
multi-tenant "Cloud Control Plane," architecturally separate from the existing single-tenant Human VA Mode
server. Every route is a thin translation to the already-tested service layer.

Building `GET /me` (list every organization a user belongs to) surfaced a real RLS gap: the existing tenant
policy only ever makes one `organization_id` visible per transaction, which would have hidden this
legitimately cross-tenant, self-scoped read entirely. Fixed with a new migration adding a second, SELECT-only
permissive policy keyed on a new `app.current_user_id` GUC (Postgres OR's multiple permissive policies
together — documented behavior) — deliberately not `FOR ALL`, since allowing writes under "user_id = me" would
let anyone insert a membership row for an organization they don't belong to. `withTransaction()` gained a
matching `userId` option.

Then built the master prompt's actual required authorization test matrix — anonymous / wrong organization /
wrong role / correct role / disabled user / expired session / revoked session — against a real, `.listen()`-ed
instance of the app, driven with real `fetch` calls, on `POST /organizations/:id/invitations`. All seven cases
pass locally against the mocked middleware layer; the real-HTTP-plus-real-Postgres version is wired into
`.github/workflows/db-migrations.yml` and awaits that workflow's first run, same as everything else in M04.

This is the deepest point M04 reaches this session: full write-up, what's deliberately NOT covered (email
delivery, the matrix on every *other* endpoint, where this API actually deploys), and the open decisions in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **138 files, 1,280 tests, 1,272 passed, 0 failed, 8 skipped** (the 8 skips are every
PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M04 part 5: email verification and password reset

Added `identity.email_action_tokens` (one new table backing both flows — they're nearly mechanically identical:
hashed, expiring, single-use tokens tied to a `purpose`) via a new migration, plus
`emailActionTokenRepository.js`/`emailActionService.js`. Requesting a new verification or reset token
invalidates any still-live one for the same user/purpose, so an old unread email link goes inert. A
password-reset token can't be replayed as a verification token or vice versa (checked at resolution time, not
just trusted from issuance). `resetPassword()` reuses `authStore.js`'s `hashPassword` and, when given a
session repository, revokes every existing session for that user — a reset is a security event that should
end other sessions, not coexist with a possibly-compromised one. Neither flow sends email yet;
`mailSender.js` already handles delivery for the file-backed system and is next in line to wire up, not
reinvent.

This closes out every M04 organization/identity sub-domain the master prompt named except signup-from-
invitation, WebAuthn, and — the big remaining one — **any actual HTTP route**, which is where the master
prompt's real authorization test matrix (anonymous/wrong-org/wrong-role/disabled/expired/revoked per sensitive
endpoint) becomes buildable and required. 9 new mocked unit tests plus a real-PostgreSQL integration test
(verification marks the real `user_emails.verified_at`, reset updates the real hash and revokes a real
session, a second reset request invalidates the first), wired into `.github/workflows/db-migrations.yml` as
the sixth PostgreSQL CI step. Full write-up in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **136 files, 1,268 tests, 1,261 passed, 0 failed, 7 skipped** (the 7 skips are every
PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M04 part 4: TOTP MFA and recovery codes

Added `identityMfaRepository.js`/`identityMfaService.js` against `identity.mfa_methods`/`recovery_codes`,
reusing `twoFactor.js`'s existing TOTP/AES-GCM/recovery-code implementation (already relied on elsewhere in
this codebase for proxy credential encryption) rather than a second crypto implementation — this only adds
the PostgreSQL persistence shape: enroll (stores the encrypted secret, returns the plaintext secret and QR URI
once), confirm (a real authenticator code moves the method from pending to verified and issues 10 recovery
codes, only their hashes persisted), verify-login (checks only *verified* methods — a pending enrollment can
never authenticate), single-use recovery-code consumption, disable.

9 mocked unit tests isolate the service's own logic against fake crypto; the real-PostgreSQL integration test
deliberately uses the REAL `twoFactor.js` functions (not fakes) so the actual encrypt/decrypt/TOTP round trip
through real storage is what gets verified once CI runs it — a genuinely generated code confirms enrollment
and later logs in, a stale code is rejected, a real recovery code is confirmed hashed at rest and single-use.
Wired into `.github/workflows/db-migrations.yml` as the fifth PostgreSQL CI step. Full scope, what's still open
(email verification/password reset, signup-from-invitation, WebAuthn), and everything else in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **134 files, 1,258 tests, 1,252 passed, 0 failed, 6 skipped** (the 6 skips are every
PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M04 part 3: invitations

Added invitation issuance/acceptance against `identity.invitations`. A small additive migration
(`1758839400000_add-role-to-invitations.js`) adds a `role_key` column the original schema design didn't
include — recorded up front as a deliberate schema disagreement, not a silent workaround. `invite()` validates
the role exists before creating anything; `acceptInvitation()` runs the accepted-state re-check, membership
creation, and role assignment inside one transaction, so two concurrent acceptance attempts of the same
invitation can't both succeed and a failure anywhere leaves nothing behind. Deliberately scoped to adding an
*existing* user to an organization — signup-from-invitation (creating a brand-new account) needs a password-
choosing flow this pass didn't build, and is called out as follow-up work rather than glossed over.

10 new mocked-repository unit tests plus a real-PostgreSQL integration test (accepted role grants exactly the
right permissions, double-acceptance rejected without disturbing the first membership, revoked invitations
rejected), wired into `.github/workflows/db-migrations.yml` as the fourth and final PostgreSQL CI step so far.
Full scope and open items in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **132 files, 1,248 tests, 1,243 passed, 0 failed, 5 skipped** (the 5 skips are every
PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M04 part 2: identity sessions

Added `identitySessionRepository.js`/`identitySessionService.js` against `identity.sessions`: issue/verify/
revoke/revoke-all/list-active, tokens hashed at rest using the same `crypto.randomBytes` + sha256 convention
already proven in `siteStore.js`'s enrollment tokens, raw token returned exactly once from `issueSession()`.
A validity check (`verifySession`) never touches `last_seen_at` itself, so probing a token can't masquerade as
real activity — callers call `touchSession()` explicitly for that. 8 new mocked-repository unit tests plus a
real-PostgreSQL integration test (issue/verify, revoke blocks verification without deleting the audit row,
revoke-all scoped correctly to one user, a session id can't be substituted for its token), wired into
`.github/workflows/db-migrations.yml` after the M04-part-1 test. Full details in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md), status
still **PASS WITH KNOWN LIMITATIONS** pending that workflow's first real run. Full local server suite:
**130 files, 1,237 tests, 1,233 passed, 0 failed, 4 skipped** (the 4 skips are every PostgreSQL-gated test,
correctly skipping without a live database).

## 2026-09-26 — M04 part 1: organization/user/membership/RBAC core

Built the first slice of M04 (organizations, users, memberships, roles/permissions) as a Postgres-backed
service layer alongside — not replacing — the existing file-backed `authStore.js`/`operators.config.json`
system. A second migration seeds the master prompt §4's 21-permission catalog and 7 system-template roles
(owner/administrator/manager/va_operator/researcher/reviewer/billing_admin); `organizationIdentityService.js`
composes `db/repositories/{organization,user,membership,role}Repository.js` inside real transactions —
`createOrganizationWithOwner()` creates an org, its first user, and an owner-role membership atomically, reusing
`authStore.js`'s own `hashPassword`/`verifyPassword` rather than a second password implementation.

Found and fixed a real bug while wiring the CI test for this in: the first draft of the seed migration passed
array parameters to node-pg-migrate's `pgm.sql()`, assuming Postgres-style `$1`/`$2` positional binding — that
function actually does its own `{name}`-style text substitution (checked against the installed package's own
type declarations, since nothing here can run it to find out empirically) and would have silently done the
wrong thing. Rewrote to use `pgm.db.query()`, which does take real parameterized SQL. Separately, discovered
node-pg-migrate's `down` reverts only the single most-recently-applied migration by default — with two
migrations now, the M03 tenant-isolation test's "down must remove the identity schema" assertion needed an
explicit `down 0` (revert everything) or it would have quietly tested the wrong thing.

Full scope, what's explicitly NOT built yet (sessions, MFA, email verification, invitations, any HTTP route),
and the open product decisions this deliberately did not guess at (Owner vs. Administrator distinction, how
this reconciles with the existing 5-role `roleCapabilities.js` model) are in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Status:
**PASS WITH KNOWN LIMITATIONS, PART 1 ONLY** — real verification is a new PostgreSQL integration test
(`organizationIdentity.test.js`) wired into `.github/workflows/db-migrations.yml`, which has not run in CI yet.

Locally verifiable pieces: 11 new mocked-pool unit tests for the repositories/service passed; both
PostgreSQL-gated test files confirmed to skip (not silently pass) without `TEST_DATABASE_URL`; `node --check`
passed on every new file. Full local server suite: **128 files, 1,228 tests, 1,225 passed, 0 failed, 3
skipped** (the 3 skips are the PostgreSQL-gated tests, correctly skipping without a live database).

## 2026-09-26 — M03: PostgreSQL foundation (unverified locally; CI-verified only)

Added the migration framework (`node-pg-migrate`), connection pool/health-check/transaction helpers
(`system/server/src/db/`), and the first migration — the identity/organization schema recommended by
[DATABASE_GAP_ANALYSIS.md](productionization/DATABASE_GAP_ANALYSIS.md)'s "first database slice" section, with
Row-Level Security on every tenant-scoped table. **No application code reads or writes this schema** — that is
a separate, not-yet-started milestone (M04).

This environment has no PostgreSQL, Docker, or database client installed, so none of this could be run against
a live database directly. Instead, [`.github/workflows/db-migrations.yml`](../.github/workflows/db-migrations.yml)
runs it for real against an ephemeral `postgres:16` GitHub Actions service container: migrate up, a genuine
tenant-isolation test through a non-superuser role (Org A/Org B cross-tenant SELECT/INSERT/UPDATE/DELETE
negative tests, plus a fail-closed check with no tenant context set), then migrate down and verifies the schema
is actually gone. **That workflow has not run yet as of this writing** — full details, exact scope decisions,
and what remains before M04 can start are in
[docs/productionization/M03_POSTGRES_FOUNDATION.md](productionization/M03_POSTGRES_FOUNDATION.md). Status is
recorded there as **PASS WITH KNOWN LIMITATIONS**, not PASS, until that workflow is confirmed green.

Locally verifiable pieces: 15 new unit tests for the pool/health/transaction helpers (mocked, no live database)
passed; `node --check` passed on every new file; `npm audit` is 0 vulnerabilities after pinning
`node-pg-migrate` to `^9.0.0` (an earlier `^7.0.0` resolution pulled in a `glob` version with a published high
severity advisory).

## 2026-09-25 — M02: remaining persistence-interface slices complete

Closed out every domain named in [M02_MODULARIZATION.md](productionization/M02_MODULARIZATION.md)'s remaining-slices
list with the same pattern as the slices before it: a repository contract, a file adapter that delegates to the
existing, still-authoritative implementation unchanged, and direct unit tests. Five slices landed in this pass:

1. **Sites and site credentials** — `siteRepository.js`/`fileSiteRepository.js` wrap `SiteStore`.
2. **Device assignments** — `assignmentRepository.js`/`fileAssignmentRepository.js` wrap `createAssignmentStore`.
   Device *leases* stayed out of scope: `deviceLease.js` is in-process controller-mode state with no file store
   behind it to wrap.
3. **Task queue snapshot** — `taskQueueSnapshotRepository.js`/`fileTaskQueueSnapshotRepository.js` extract
   the queue's atomic snapshot read/write and restart-recovery logic out of `taskQueue.js`; its scheduling/
   dispatch/retry mechanics stayed put since that's domain logic, not persistence.
4. **Approvals, interventions, research runs/evidence** — four repository/adapter pairs wrapping `ApprovalStore`,
   `InterventionQueue`, `researchStore.js`, and `researchEvidenceStore.js`, now used consistently by both the
   HTTP routes and `researchTaskRunner.js`'s dependency injection (previously the runner silently fell back to
   raw module imports instead of the same instances the routes used).
5. **Notifications, proxy pool, device media, research evidence** — `notificationRepository.js`,
   `proxyPoolRepository.js` (binds `proxyPoolStorePath` once instead of threading it through 9 call sites),
   `deviceMediaRepository.js`, and `researchEvidenceRepository.js` (screenshot save/resolve).

Every slice kept its existing file store authoritative, migrated no data, and changed no HTTP/WebSocket
behavior — see [M02_MODULARIZATION.md](productionization/M02_MODULARIZATION.md) for the exact scoping decisions
(what stayed a direct import and why) and the "M02 status" section for what this does and does not unblock:
M03 (PostgreSQL foundation) still requires the identity/organization schema and tenant-negative tests, which are
separate, not-yet-started M04-adjacent work.

Verification: full server suite run after every slice, culminating at **122 files, 1,199 tests, 1,199 passed, 0
failed, 0 skipped**. `node --check` passed on every changed entry point; `git diff --check` passed throughout.
Nothing in this pass was committed — left for manual review per the working session's instruction.

## 2026-09-25 — M02: background task/assignment/research authorization boundary

A fifth M02 slice moved the task queue's dispatch predicate, assignment target validation, and background
task-access checks off direct `authStore.js`/`researchAccess.js` imports and onto one named, synchronous
authorization boundary (`system/server/src/services/backgroundAuthorizationService.js` and its repository
contract/file adapter). Unlike the identity/session slices, this boundary stays synchronous by design — the
task queue's dispatch loop and the assignment routes' inline validation both need an immediate answer — and
that tradeoff, along with what a future async-backed identity source would need to do instead (publish a
refreshed snapshot behind the same boundary rather than making dispatch itself async), is written down in
[`docs/productionization/M02_MODULARIZATION.md`](productionization/M02_MODULARIZATION.md#background-task-assignment-and-research-authorization-identity-resolution).
`researchTaskRunner.js` also gained an injectable `canAccessDevice` parameter, matching its two existing
injected authorization resolvers instead of importing the third directly. No operator data was migrated;
`operators.config.json` remains authoritative, and no HTTP/WebSocket request-scoped authorization check was
touched. New file: `system/server/test/unit/backgroundAuthorizationService.test.js`.

## 2026-09-25 — productionization baseline and proposed architecture

The productionization program now has a source-and-test baseline plus an M01 architecture package under
[`docs/productionization/`](productionization/README.md). The package records the cloud/site execution
boundary, PostgreSQL authority, ephemeral Redis use, object storage, secret references/KMS, tenant and identity
models, billing abstraction, transactional outbox/audit model, and deployment topology. It also includes the
domain model and ERD, trust boundaries, data classification, threat model, and a table-by-table reconciliation
of the proposed database schema.

This milestone changes documentation only. It does not switch persistence, enable a cloud service, migrate
customer data, or alter device/runtime behavior. Organization/workspace semantics, identity provider, billing
provider/prices, cloud/regions, retention, licensing, legal identity, and native-mobile launch scope remain
explicit owner decisions. M02 service and persistence interfaces must preserve current behavior before any
database migration begins.

M01 was subsequently accepted as the direction for incremental implementation. M02 is now in progress. Its first
bounded slice introduces an audit-event repository contract, keeps the existing JSONL adapter authoritative, and
moves device-grant-aware audit reads into an audit service. No audit data was migrated and no API behavior was
intentionally changed. A second bounded slice now places the existing file session store behind the callback
contract required by both Express and WebSocket upgrades; its atomic files and revocation tombstones remain
authoritative. A third slice routes administrative account lifecycle operations through an async-first service and
repository while retaining `operators.config.json` as authority. A fourth slice now routes password login, pending MFA
identity reads, HTTP authentication/capability middleware, stored-session checks, and delayed network-check
reauthorization through an async-first identity service. The live `operators.config.json` projection remains
authoritative. Signup, recovery, and MFA persistence now use that same async boundary while delegating to the
existing atomic file implementation. WebSocket upgrade and per-message/session authorization now use an
async-refreshed, generation-ordered socket identity snapshot, preserving synchronous device authorization callbacks
and fail-closed mid-action revocation. Account updates now reconcile both controlled-device and read-only-watch
sessions before their response completes. Background queue/scheduler authorization remains bounded follow-up work. See
[`docs/productionization/M02_MODULARIZATION.md`](productionization/M02_MODULARIZATION.md).

## 2026-09-23 — required desktop version gate and direct release installers

Packaged desktop builds now check the public Phone Farm GitHub Releases feed before opening any host,
site-agent, or client window. When the installed and published versions differ, the operator must choose
**Update now**. Choosing **No — exit**, or exiting after a failed check/download, leaves the application
closed. The downloaded `.pkg`/`.exe` is constrained to trusted GitHub HTTPS hosts and is opened only after
its declared size and GitHub-provided SHA-256 digest match. Source/development launches skip this gate.

The Windows release artifact now has the stable user-facing name `Phone-Farm-Windows.exe`. The macOS
workflow reserves `Phone-Farm-macOS.pkg` for a signed/notarized package; until Apple credentials are
configured, the verified Apple-silicon package is a clearly marked unsigned Actions artifact rather than a
misleading stable Release download. The three root `BUILD_PHONE_FARM_INSTALLER.*` developer wrappers were
removed so they cannot be mistaken for the application. The actual large binaries remain release/CI assets
rather than Git-tracked files; CI still owns the platform-specific build, test, and packaging steps.

Automated tests cover version ordering, platform asset selection, digest/size enforcement, acceptance and
decline paths, failure-closed handling, and Electron lifecycle events attempting to bypass a denied gate.
Windows-local validation: desktop **159/159**, server **1,143/1,143**, both dependency audit gates clean,
and `Phone-Farm-Windows.exe` built with its packaged runtime verified. GitHub Actions run 35893483741 built,
installed, boot-tested, and uploaded the v0.2.2 arm64 unsigned `.pkg` on macOS; run 35893483864 built and
verified the Windows installer. This is packaging/update automation only: no physical Mac mini or iPhone
acceptance is claimed here, and the macOS stable Release asset remains blocked on Apple signing/notarization.

## 2026-09-21 — larger phone view and low-latency transport decision

The desktop live phone was artificially capped at 320 px wide and 660 px high.
It now uses up to 480 px / 860 px in the normal workspace, gets a larger desktop
column, and has a full-screen phone mode that preserves canvas-based input
coordinates. The WDA profile now asks for 30 fps at 50% scale and quality 45.
The relay begins dropping video at a 128 KiB WebSocket backlog instead of 1 MB,
so slow links keep the newest picture rather than displaying a queue of old
frames.

WDA remains the supported automation and fallback video path. Research found
that its MJPEG feed cannot satisfy a zero-backlog, smooth real-time target on
its own because it captures and JPEG-encodes each frame. The recommended
iOS 17+ experiment is CoreDevice HEVC display streaming plus CoreDevice HID
input. Requirements, licensing constraints, performance gates, and the staged
implementation plan are in [LIVE_CONTROL_TRANSPORT.md](LIVE_CONTROL_TRANSPORT.md).

## 2026-09-19 (latest) — response to the review of commit ae8b2f9: both CI runs were red, now fixed

The first GitHub run of the installer pipeline (macOS run 35432249587, Windows run 35432249628) failed. The review's findings were
each reproduced or checked before changing anything:

| Finding | Verdict | What was done |
|---|---|---|
| **Server exits 0 without listening when started through a symlinked folder** (macOS installer verification: "server did not report a listening port (exit=0)") | **Reproduced here** with a directory junction (direct path listens; linked path exits 0). Root cause: `import.meta.url === pathToFileURL(process.argv[1]).href` compares a symlink-resolved URL with an unresolved path; macOS temp folders are `/var` -> `/private/var`. | New `server/src/directExecution.js` compares real paths (case-insensitive on Windows); used by **both** `index.js` and `agentMain.js`. Tests start the real server and the real site agent through a linked folder, plus unit tests of the helper. The verifier's failure message now names this cause. |
| **4 Windows test failures** (`firstRunPage.test.js`: "runFix is in the page") | **Reproduced** by converting the page to CRLF, which is what a Windows checkout produces. The test's regex assumed LF. | The test now cuts the function out by matching braces after normalising any line ending; a test proves LF, CRLF and CR all work. The page itself was never broken. |
| `provisioningBoot.js` ignores the `env` it is given (preflight, iproxy, discovery tools, signing team fall back to global `process.env`) | **Confirmed** (harmless today because both callers pass `process.env`, but inconsistent). | Everything is now read from the supplied `env`, with bare command names as fallbacks; 4 tests, including "a value present only in the global environment is not picked up". |
| Multer 1.x (deprecated, known vulnerabilities) | **Confirmed**; `npm audit` was 0 but the package itself warns. | Upgraded to Multer 2.4.0; full server suite (uploads included) passes; a test keeps it on 2.x. |
| `.DS_Store` not ignored; `desktop/package.json` has no `author` | Confirmed | Ignored; `author` added (silences electron-builder's warning). |
| README points at `/releases/latest`, which is a 404 until a release exists | Confirmed | README now says where to get the installer before the first release (Actions artifact). |
| No Developer ID certificates configured -> `-UNSIGNED.pkg` | Correct, and **cannot be fixed in code**: needs your Apple Developer ID Application + Installer certificates and notarization credentials as GitHub secrets (`docs/MAC_RELEASE.md`). Until then the package works but macOS warns. | none |
| `electron-winstaller` install script "not approved by allowScripts" | Windows packaging had not been reached. Checked by running the real `npm run dist:win` locally: the real `npm run dist:win` (NSIS) completed and produced a 114 MB installer, and its packaged server booted, so nothing is blocking there | none needed if the build succeeded |
| Deprecated transitive build tooling (`glob@7`, `rimraf@2`, ...) | Build-only, audits clean | left as is |

Not a bug and untouched: the earlier `/time` timezone failures are fixed; the review confirms all 1,095 server tests passed on the macOS runner.
The pipeline got as far as producing `Phone-Farm-0.1.0-arm64-UNSIGNED.pkg` (electron-builder, pkgbuild and productbuild all succeeded) before
failing in the post-build verification, so the macOS install-to-`/Applications` step and the artifact upload have still never run. The same
caveat applies to the Windows installer build. **After this fix, re-run both workflows and review whatever the later stages show.**

---

## 2026-09-19 — macOS installer hardening: setup without Terminal, and a farm host that stays up

**Goal:** an operator installs the `.pkg`, opens Phone Farm and plugs in phones one by one, with no Xcode window and no
Terminal. The installer scripts were already written; this pass closed the gaps found when reading them as a first-time user.

**Setup without commands.** The setup screen's red rows now have a **Fix it** button where a fix can work: *Xcode installed
but not selected / licence not accepted / first-launch components unfinished* -> one standard macOS password prompt (via
`osascript`, no sudo typed by anyone); *iPhone tools missing* -> `brew install libimobiledevice libusbmuxd` when Homebrew
is on the Mac (progress shown on the row). Without Homebrew the row says to install it from brew.sh. Only two fixes exist, they
are allow-listed, take no user text, and run without a shell.

**A farm host that stays up.** The Mac is kept awake while the server or site agent runs; a crashed server or agent is
restarted with backoff (and reported after repeated crashes instead of looping); the app starts at login (default on for a
host/site, off for an operator workstation, one checkbox); only one copy can run; if the usual port 4173 is taken the next free
one is used; a failed start now says why (e.g. the server's own error line).

**Debuggable on a Mac.** The app is opened from Finder, so nothing showed on a console. It now writes a rotating log to
`~/Library/Logs/Phone Farm/` and **Help > Copy Diagnostics** puts a plain-text report (prerequisite rows, tool paths, WebDriverAgent
source, recent log; secrets scrubbed) on the clipboard; **Help > Show Log Folder** opens it.

**Continuous checks.** `cd desktop && npm run check:release` lists what can be verified without a Mac (needed files exist, are
not git-ignored, are committed; `git add -A` would not push a key/account file/node_modules; workflows parse and reference real
scripts; every module the app loads is in its package list; lockfiles match; the build plan is complete). It also runs inside the
desktop test suite, and the packaged-runtime verifier now requires every script/stylesheet/icon the web client's page names.

**Debugging pass (structured: reproduce, isolate, diagnose, fix).** Every API route (68) was hit with 380 hostile requests, the
WebSocket protocol with ~5,900 malformed messages, and the mock fleet soaked for a minute (1,385 actions). Findings:
1. **Malformed, `null` or oversized JSON returned 500 "request failed" on all 39 write routes.** Root cause: the global error
   handler had no branch for the body parser's client errors. Now 400 `INVALID_JSON` / 413 `PAYLOAD_TOO_LARGE` (parser text never
   echoed); 11 regression tests. Re-fuzz: 0 server errors.
2. **The setup page's "Fix it" could leave a row stuck on "Working…" with a dead button** if the request itself failed. Fixed, with
   behaviour tests that run the page's own function.
3. **The installer's read-me page still told people to open Xcode and run `brew install`** — the opposite of the goal. Rewritten
   in plain language to match the Fix it flow.
4. **Flaky desktop test:** two tests fought over port 4173 when the suite ran in parallel. The default port can now be set with
   `PHONE_FARM_PORT`; the tests no longer share one.
5. **A failure that would only have appeared on the first macOS GitHub build.** The new desktop tests start the real host flow;
   on Windows that skips the Mac checks, but on a clean macOS runner it runs them for real (no iPhone tools installed) and would
   have refused to start, failing the desktop test step and so the whole installer build. Found by reading the code for what
   differs on a Mac; fixed with an explicit development/test switch (`PHONE_FARM_SKIP_HOST_PREFLIGHT=1`, never set in the
   installed app) that the shared test harness sets. The other desktop tests were checked and already inject their machine.
No crash or hang came from the WebSocket fuzz or the soak (heap stable, 0 errors). One first-run detail to know about: the first
sign-in of a new administrator asks them to set up two-factor sign-in (an authenticator app), by design.

**Tests:** desktop suite **149** (was 97), server suite **1095**, server suite also passes under `TZ=Asia/Tokyo` as CI runs it. A
new end-to-end test drives the real first run: host setup starts the real server, the first admin is created from the setup page's
channel, and that admin signs in (up to the two-factor step).
`test/mainLifecycle.test.js` loads the real `main.js` against a stand-in for Electron and starts the **real server process**: it
kills it and watches it come back, checks a deliberate quit does not restart it, that every IPC channel refuses any page but the
setup page, and the busy-port fallback. The setup page's Fix it flow was exercised in a browser against a stubbed API.

**Still NOT done and not claimed:** the `.pkg` has never been built (needs macOS: the GitHub workflow does it); **the installer
files are still uncommitted** (`.github/`, `build-mac-pkg.cjs`, `wdaSource.js`, … are untracked, so GitHub has nothing to build);
the Fix it flows, the login item, the sleep blocker and Gatekeeper behaviour have never run on a Mac; no real iPhone was used;
the package is unsigned/not notarized until Apple certificates are added as secrets (see `docs/MAC_RELEASE.md`).

---

## 2026-09-19 — live phone stream, multi-site hub, remote access, and MS9–MS13 built

Everything below is implemented, has tests, and passes locally: server suite **1084/1084 (101 files)**,
desktop suite **97/97**. Nothing here has run against a real iPhone — see "Not verified" at the end.

**Live video, not screenshots.** The phone is now a video stream. WebDriverAgent's MJPEG server (device
port 9100, exposed through a second `iproxy` mapping) feeds one shared upstream per phone (`streamHub.js`)
to the controlling operator and any watchers; frames go to the browser as binary WebSocket messages.
Slow viewers drop frames instead of building lag, every frame is re-authorized per viewer, and when a
device cannot stream (mock without a stream, WDA without MJPEG) the client falls back to timed
screenshots and says so. Ports come from `portAllocator.js` and are allocated per device by the provisioner.

**The operator's screen is the phone.** `client/phoneStage.js` renders only the phone — no arrow buttons,
no Home button. Mouse wheel scrolls the phone (throttled into drags), click-drag swipes, a short press taps,
a long press and double click are real gestures, the keyboard types into the phone (Backspace and Enter
included), and the Home control is the phone's own bezel/gesture bar like a real iPhone. The layout is
phone-first.

**Multi-site.** One central hub plus one outbound-only site agent per location (`siteAgent.js`,
`npm run agent`). The agent dials the hub over TLS with its site id and a token (stored hashed), so a site
needs no inbound port. Devices show up on the hub namespaced as `<site>__<device>`; frames, taps, swipes,
typing, screenshots, file transfer and leases all work through the link; only an allow-listed set of calls
is accepted from a site; streams re-open automatically after a reconnect. Admins manage sites in the new
Sites panel.

**Remote operators.** Remote operators open the app (browser, installable PWA, or the desktop app in
"client" mode) and need only internet — Wi-Fi or mobile data. `deploy/hub/` has a Docker + Caddy hub with
automatic HTTPS; `docs/DEPLOY_HUB.md` explains it. `/healthz`, a web manifest, service worker (network-first,
never caches the API or the stream) and icons are in. The desktop app has host / client / site modes; the
Windows installer workflow exists. A Capacitor project for iOS/Android store apps is scaffolded in `mobile/`
(**not built**, needs the store accounts).

**Time zone.** `/time` is wall-clock in an explicit IANA zone; the default is now `America/Los_Angeles`
(`PHONE_FARM_TIMEZONE` overrides).

**MS9 — private markers.** Save/bookmark and other private markers use verify-before-toggle: the skill reads
the control's state, presses only when the state differs, then re-reads to confirm; an ambiguous read never
presses. The research record is written first, and an action on content with no record is refused.

**MS10 — configured account actions.** Every action (like, vote, repost, comment, …) has a per-account
policy `ALLOW_AUTONOMOUS` / `REQUIRE_APPROVAL` / `DISABLED`, default DISABLED, changeable only by an
administrator of that client and effective immediately. The validator enforces it before the device is
touched. Approvals are single-use and bound to the exact action, target and wording; a manager or admin
decides, and every decision is audited. Comments pass an application-level guard (exact and near
duplicates, rate limits, grounding in the viewed content, preset templates) and are recorded in a ledger
before sending; comment text is logged exactly as sent. A platform-visible action that fails is never
blindly retried — it goes to a person.

**Review panel (MS10.4 approval-gate UI, MS12.3 intervention queue UI).** A "Review" button opens a panel with three
tabs, in plain language. *Approvals*: each waiting action shows what the AI wants to do, on which post, and — for a
comment — the exact wording that will be posted; managers and admins approve or reject with an optional reason, others
see it read-only. *Needs a person*: everything the AI handed back (security check, unsure, unconfirmed action, comment not
sent, a person took over), with "I'll handle this" / "Mark as done"; managers and admins only, per-client. *What the AI
may do*: every action grouped (looking around / private markers / visible to others / comments) with Never / Ask a person
first / AI may do this on its own; only an administrator can change it. The server re-checks every request; the panel only
hides what a role cannot use. `npm run demo` now includes a demo account with one approval and one hand-back to try it.

**Mobile.** With a phone open on a narrow screen the phone now comes first (no sidebar above it) and the People list is
dropped there. Bug found and fixed while testing this: a phone opened while the browser tab was hidden — for example a
phone that locked its screen, reconnected and re-selected the device — never started its video when the tab came back.

**MS11 — timed sessions.** Sessions have step, time, spend, kept-candidate and per-action quotas and stop on
consecutive failures; a scoring profile decides what is kept; budgets and reports are rebuilt from
checkpoints, so a restart continues the session instead of resetting it. Each finished session has a
report (`/api/research/:account/runs/:runId/report`).

**MS12 — fleet.** A fleet gate limits concurrent AI workers and hourly spend and pins accounts to devices;
the intervention queue collects everything a person is needed for (challenge, low confidence, approval)
with claim/resolve and per-client visibility (`/api/fleet/ai`, `/api/fleet/interventions`).

**MS13 — optimization.** Local screen classification and a mechanical planner (open the app when closed,
move on after a recorded post) — no model call; a three-tier router (local / cheap / strong) that only
trusts the cheap model when it is confident and escalates otherwise or after a failure; a state-detection
cache keyed on the whole accessibility tree (never serves a challenge screen); adaptive pacing that never
waits less than the app needs to settle; search and near-duplicate lookup over an account's own records
(`/api/research/:account/search?q=` and `?similarTo=`); intervention analytics and optimization status
(`/api/fleet/analytics`). All of it is **off unless** `PHONE_FARM_OPTIMIZATIONS` is set
(`on`, or a list of `router,localPlanner,stateCache,pacing`), with `PHONE_FARM_CHEAP_MODEL` naming the cheap
provider.
`server/bench/` is the regression gate: a deterministic benchmark (`npm run bench`) runs the real skill and
mock phone under every optimization one at a time and all together, and a test fails if any of them lowers
the success rate, recall or action accuracy — including a deliberately bad configuration that the gate must
catch. Modeled result, 16 sessions: all optimizations on vs off — success rate 1.0 in both, cost per session
$1.31 → $0.35, latency 60.5 s → 28.0 s, strong-model calls 18.75 → 5.75, screenshots 18.75 → 0.

**Not verified (do not treat as done):**
- No real iPhone was used. Live MJPEG on real WDA, the real gesture timing (press-hold before drag), and
  Backspace/Enter through `wda/keys` are unconfirmed on hardware.
- Save/like/vote/repost/comment rely on accessibility labels taken from fixtures; the real apps' labels
  and app versions have not been checked.
- The benchmark's model cost and latency are modeled constants, not measurements; real vendor pricing and
  a supervised run are needed before relying on the savings numbers.
- The Docker hub image, the Windows installer and the macOS package were not built here; the store apps
  are unbuilt.
- `/time` uses the deployment time zone, not a per-site one.
- No slash-command form of `/policy`, `/comment`, `/template`, `/report`, `/fleet` (the Review panel and API cover them);
  no data-saver stream profile for weak mobile data; the Review panel was checked in the demo browser only, not on a phone.

---

## 2026-09-18 — real `.pkg` installer pipeline, `/time` timezone fix, Electron 44

**`/time` failures (3 tests on a real Mac).** Root cause: `commandParser.js` built wall-clock
times with process-local `Date` accessors (`new Date(now)` + `setHours`, and
`new Date(\`${date}T00:00:00\`)`), so `/time` meant a different window — and a different
"already passed" verdict — depending on the host's OS timezone. The Mac mini was on a US zone
(reproduced here with `America/Los_Angeles`: exactly the same 3 failures; the injected
`06:00Z` instant is 23:00 the previous day there, and the explicit-date window ends after
`12:00Z`). Fix: `/time` is wall-clock in one explicit IANA scheduling timezone,
`PHONE_FARM_TIMEZONE` (default `Europe/Rome` when this was written, `America/Los_Angeles` since 2026-09-19; invalid value stops startup), reusing
`zonedRecurrence.js`'s DST-correct helpers (now exported) instead of a second implementation.
The three failing assertions are unchanged. New regression coverage: a table of zones
(Rome, Bucharest, LA, Tokyo, Kiritimati UTC+14, UTC), explicit dates, "today" across the UTC
boundary, both 2026 Rome DST transitions, gap/repeated hours, and a child-process matrix that
runs the same inputs under six different *process* timezones and asserts identical output.
Server suite: **819/819**, also 819/819 with the whole suite forced into `America/Los_Angeles`
and into `Pacific/Kiritimati`. (`docs/COMMAND_QUEUE_SPEC.md` §/time updated.)

**The old "downloader" was not an installer** — `DOWNLOAD_PHONE_FARM.*` is now
`BUILD_PHONE_FARM_INSTALLER.*`, labelled **DEVELOPER TOOL — NOT THE PHONE FARM INSTALLER**; the
README's top section now sends users to GitHub Releases for one file, `Phone-Farm-<version>-arm64.pkg`.

**Packaging bug found and fixed.** electron-builder unconditionally drops a `node_modules`
directory at the *root* of an `extraResources` source (`app-builder-lib/out/util/filter.js`), so
the previous `extraResources: ../system` produced apps **without the server's dependencies**.
Runtime is now staged into `desktop/build/runtime/` from an explicit allow-list
(`prepare-runtime.cjs`; production `npm ci` into the staging directory, so accounts/storage/tests can
never ship) and shipped from that root. `verify-packaged-runtime.cjs` proves, against a real packaged
app, that dependencies resolve, forbidden files are absent, and the server **boots using the packaged
executable as its Node** while the bundle stays byte-for-byte unmodified — verified on a Windows
`electron-builder --win --dir` build here.

**Installer.** `build-mac-pkg.cjs`: electron-builder makes `Phone Farm.app`; `pkgbuild`/`productbuild`
make the package (install-location `/Applications`, non-relocatable, no scripts; welcome/read-me/
conclusion wizard pages; `hostArchitectures`); Developer ID signing, `notarytool` notarization and
stapling for app and package; verification with `codesign`, `pkgutil --check-signature`, `spctl`,
`stapler validate`, and an expanded-package inspection. Levels: notarized → `Phone-Farm-<v>-arm64.pkg`;
signed only → `…-NOT-NOTARIZED.pkg`; nothing → `…-UNSIGNED.pkg` (loudly warned; a tagged release fails
unless notarized or `ALLOW_UNSIGNED_RELEASE` is set). `.github/workflows/mac-installer.yml` runs the full
server suite (under a US timezone), desktop tests, audits, the build, verification, **installs the package
with macOS Installer on a clean runner and boots the installed app's server**, uploads the artifact, and on
`v*` tags publishes the Release. See `docs/MAC_RELEASE.md`.

**WebDriverAgent is bundled** (pinned tag + exact commit in `desktop/wda.lock.json`, unmodified,
BSD-3-Clause/Apache-2.0 with its `LICENSE`). On first launch it is copied to
`~/Library/Application Support/Phone Farm/wda-source/…` — nothing is built inside the signed app. An
unsigned WDA needs a development team: detected from the keychain when there is exactly one, else asked for
once in host setup; `WdaProcessManager` then adds `DEVELOPMENT_TEAM`, automatic provisioning and a team-unique
bundle id (argv unchanged when no team is configured, and never applied to an operator's own checkout).

**Security audit.** The Mac's "14 vulnerabilities (13 high, 1 critical)" were all in `desktop/`: `electron`
33.4.11 itself (**shipped** in every installed app — high, fixed 44.4.2) plus electron-builder 25's build-time
tree (`tar` critical, `app-builder-lib`, `node-gyp`, … — **never shipped**, but they run on the signing
machine). Upgraded to electron 44.4.2 / electron-builder 26.15.3 (and `js-yaml` 4.3.2, itself newly
flagged): `npm audit` now reports 0 in `desktop/` (all dependencies) and 0 in `system/`
(`--omit=dev` and full). `audit-gate.cjs` classifies findings as shipped vs build-only and fails CI on
either unless a build-only waiver is explicit.

Desktop suite: **82/82**. NOT done and not claimed: the `.pkg` has **not been built on macOS**, has not been
installed by a person, is **not signed or notarized** (no Apple credentials), and **no real iPhone** was
exercised (WDA signing automation is untested on hardware).

## 2026-09-18 — macOS installed-host automatic WDA startup and Electron isolation

The installed desktop host now resolves its Mac toolchain before starting the
server, including Finder-safe Apple Silicon/Intel Homebrew paths, full-Xcode
selection, `idevice_id`, `ideviceinfo`, `iproxy`, both `tun2proxy` binary names,
and a validated WebDriverAgent checkout from an explicit, persisted, or
per-user home path. Host mode supplies absolute tool paths plus
`AUTO_PROVISION_WDA=true` and `AUTO_DISCOVER_IOS_DEVICES=true` to the server's
existing `DeviceProvisioner`; it uses the Electron runtime, per-user
provisioning/derived-data storage, and no fresh empty manual device config.

The setup page now shows actionable prerequisite rows instead of falling
through to an empty fleet. Existing per-device provisioning reports WDA/tunnel
startup, readiness, unplug/replug, and human-action-required failures; signing
and provisioning errors now join trust, Developer Mode, certificate, and App
ID-limit errors in the bounded/manual-retry path.

The Electron privilege boundary was split: only the packaged local setup file
gets the IPC preload, every privileged call validates its sender window and
exact frame URL, and the HTTP(S) Phone Farm window has no preload. Both window
types deny popups and unexpected navigation; client URLs with embedded
credentials are rejected.

Direct `desktop/npm run dist:mac` now installs and verifies the production
`system` runtime before electron-builder copies it as `extraResources`.
Automated desktop and server tests cover both Homebrew layouts, WDA/tool
failure paths, environment construction, navigation/origin restrictions,
preload isolation, absolute binary use, and two-phone process/port isolation.
Validation on the Windows development host: desktop **12/12**, complete system
suite **800/800**, production dependency audit **0 vulnerabilities**, runtime
packaging preflight passed, changed JavaScript entry points passed
`node --check`, and `git diff --check` passed. `npm run dist:mac` reached
electron-builder after successfully preparing the bundled runtime, then exited
with its expected platform guard: macOS builds are supported only on macOS.
Therefore no DMG was produced here and the real two-iPhone flow remains
unverified; use `docs/MAC_INSTALLER_ACCEPTANCE.md` on the Mac mini before
changing that status.

## 2026-09-18 — downloadable desktop app: bootstrap lockout, account action
## menu, real email delivery, Electron host/client wrapper

Requested as "make this a downloadable app with an installer." Investigation
first found that most of the account/signup/approval backend and a first
edit-form UI already existed in the working tree from recent sessions
(`createSignupAccount`, `setOperatorAccountStatus`, the Users panel) but
undocumented here — this entry covers only what was actually new.

**Bootstrap + self-escalation lockout.** New `POST /api/setup/create-admin`
(`index.js`) creates the very first admin — loopback-only (`req.socket.
remoteAddress`) and permanently 404s once any approved admin exists, same
response shape as a route that never existed. `create-operator.js` (the CLI
path) is untouched. New `authStore.js#flagAndDeactivateOperator(username,
reason)` force-deactivates, force-signs-out (reuses the existing
`authVersion` bump), and records `securityFlagReason`/`securityFlaggedAt`.
Wired into two places: hitting the bootstrap endpoint after lockout while
authenticated as a non-admin, and any authenticated operator failing an
admin-only account-management route while targeting their *own* account
(`requireCapability`/`requireAnyCapability` gained an opt-in
`flagSelfEscalation` option — applied only to the two routes where
self-targeting is a real escalation vector, not blanket-applied to every
403). Every flag also writes a normal audit event.

**Kick / Change-role action menu** (`client/app.js`, `renderUsers()`).
"Kick" reuses the existing `PATCH .../users/:username {active:false}` path
unchanged (deactivation was already wired to force sign-out via
`authVersion`) — no new backend needed. "Change role" opens a click-to-open
side panel (not CSS `:hover`, matching `buildProxyPoolPicker`'s existing
accessibility rationale) listing the 5 roles, 3 visible with scroll for the
rest; picking Admin specifically shows "Are you sure you want to assign
admin role to {name}?" before applying. Verified live via the browser
preview against a disposable local instance: menu open/close, role list
scroll, the admin confirm/cancel path, a server-side validation error
(manager-without-teamId) surfacing without closing the panel, and Kick's
full deactivate-and-signal-inactive result.

**Real email delivery.** `accountNotificationStore.js` already built and
queued acceptance/rejection/recovery email content with nowhere to send
it — `deliveryState` just sat at `"queued"` forever. New
`mailSender.js` (nodemailer/SMTP, config via `SMTP_HOST`/`PORT`/`USER`/
`PASS`/`SECURE`, unconfigured ⇒ no-op with a logged reason like every other
optional integration here) plus `markSent`/`markFailed` on the
notification store. The account-status route awaits delivery and reports
the real outcome; the password-recovery route fires-and-forgets deliberately
(awaiting a real SMTP round-trip there would make a matching identifier's
response measurably slower than a non-matching one — an enumeration timing
side channel this endpoint's identical response message already guards
against).

**Desktop wrapper** (new top-level `desktop/`, sibling to `system/`).
One Electron app, two first-run modes: "Set up a new host on this machine"
spawns the unmodified `system/server/src/index.js` as a child process
(via `process.execPath` with `ELECTRON_RUN_AS_NODE=1` — the app's own
bundled Node runtime, so a host machine does not need a separate system
Node.js install) with persisted per-install `SESSION_SECRET`/
`TWO_FACTOR_MASTER_KEY` and its own storage root under Electron's
`userData`, then shows a one-time native create-admin form calling the
bootstrap endpoint above before handing off to the normal web login;
"Connect to an existing Phone Farm host" just opens a window at a given
URL — no server code ever runs on that machine. `system/client` and
`system/server` are reused unchanged.

**Root downloader.** `DOWNLOAD_PHONE_FARM.command` (macOS) and
`DOWNLOAD_PHONE_FARM.cmd` (Windows) are deliberately placed at repository
root, backed by `DOWNLOAD_PHONE_FARM.mjs`. After a clone or pull, they install
the exact locked server/desktop dependencies, run the full suite, and build the
local installer into ignored `desktop/dist/`. They do not download or generate
credentials, operators, device configuration, or runtime storage. Dry-run and
explicit skip-tests modes are available for validation and deliberate rebuilds.

Verification: **792/792 full-suite tests passed** (`npm test`, up from 756
at session start), including new coverage for `isLoopbackAddress`,
`flagAndDeactivateOperator`, the bootstrap-then-lockout sequence, both
self-escalation triggers (and confirming a non-self-targeting 403 is
*not* flagged), `mailSender.js` against a mocked SMTP transport, and a
full queue→send→`"sent"`/`"failed"` integration pass. `npm audit
--omit=dev` on `system/`: 0 vulnerabilities. The desktop app: `electron`/
`electron-builder` installed and the real Electron binary downloaded in
this environment; a dev-mode launch was smoke-tested (process starts,
loads `first-run.html`, no console errors) but the interactive host-setup
and connect-to-host click-through was **not** driven end-to-end — this
environment has no native-GUI automation tool wired up for a real Electron
window, only the browser preview used for the client UI above. Packaging:
the Windows `nsis` target is buildable and runnable on this machine; the
macOS `dmg` target is defined but unbuilt/unverified (non-macOS dev
machine, same hardware gate as every other Mac-only item in this doc).
Code-signing/notarization for either platform is explicitly out of scope
until the user decides on an Apple Developer / Windows code-signing
credential — unsigned builds work for local testing but trigger OS security
warnings on install.

## 2026-09-17 — MS17: fully automatic network enrollment

Closed the last manual gap in the automation pipeline: plugging in a phone
no longer requires clicking through network enrollment/IP discovery at
all, and Internet Sharing itself can now be turned on by the app.

Built `internetSharingManager.js` — enables Internet Sharing via the same
undocumented mechanism System Settings itself is known to use
(`com.apple.nat.plist` via `PlistBuddy`, restarting the
`com.apple.InternetSharing` launchd job, both through `sudo -n`), with the
primary interface auto-detected from `route get default`. Apple publishes
no schema for this plist, so this is explicitly best-effort — every call
site treats a failure as "log clear manual-fallback guidance and move on,"
never as something to retry blindly, and this is flagged as the single
piece of the whole project most likely to need adjustment once tested
against a real macOS version.

Built `autoNetworkEnrollment.js` — the continuous background version of
MS16.4's manual enrollment/discover-ip routes. Every poll tick it
statelessly recomputes which discovered UDIDs have no persisted `usbIface`
yet and which bridge members no device has already claimed, auto-pairing
only when exactly one of each is pending (otherwise flagging `"ambiguous"`
and waiting — the same "never guess" rule the manual flow already
enforced). Once enrolled, it attempts USB-IP discovery on a cooldown
without blocking other devices, and once an IP resolves for a device that
already has a pool proxy assigned, it calls
`networkRoutingOrchestrator.startRouting()` automatically —
`startRouting` is injected as a plain function rather than importing the
orchestrator directly, keeping the two modules decoupled.

Wired into `index.js` behind two independent flags
(`AUTO_ENABLE_INTERNET_SHARING`, `AUTO_NETWORK_ENROLLMENT`), both nested
under the existing `AUTO_ROUTE_PROXY_TUNNELS` gate. A new `autoEnrollment`
`device_list` field surfaces the loop's live per-device status
(`pending`/`ambiguous`/`discovering_ip`/`ready`/`routing` plus a
human-readable note) on the fleet card, informationally alongside the
existing manual controls, which remain a full fallback/override — e.g. to
unstick an `ambiguous` device without physically unplugging everything
else.

Combined with MS16, this closes the loop end to end as originally asked:
plug in a phone with `AUTO_PROVISION_WDA`, `AUTO_ROUTE_PROXY_TUNNELS`,
`AUTO_ENABLE_INTERNET_SHARING`, and `AUTO_NETWORK_ENROLLMENT` all set, and
— once verified on real hardware — it comes online, gets network-mapped,
gets its IP discovered, and starts routing through its already-assigned
pool proxy with no clicks. Assigning *which* proxy to a device remains a
deliberate one-click admin action, by design.

Verification: **780/780 full-suite tests passed** (`npm test`), including
new coverage for the PlistBuddy/launchctl argv construction and
rule-injection validation, default-route parsing, and
`autoNetworkEnrollment.js`'s full reconciliation logic (clean pairing,
ambiguity on either side, manual-UDID and already-claimed-member
exclusion, IP-discovery cooldown/struggling messaging, auto-routing vs.
stopping at "ready," and the timer lifecycle) — all against injected
fakes. Smoke-tested server boot on this non-macOS dev machine with every
new flag enabled: `detectPrimaryInterface()` correctly failed closed with
clear manual-fallback guidance (Windows has no `route get default`
equivalent) while the rest of the server stayed fully healthy — exactly
the intended degradation. Real `PlistBuddy`/`launchctl`/`route` behavior
and the NAT plist schema itself remain unverified until run on the Mac
mini.

## 2026-09-16 (final for the session) — MS16.6/16.7: routing fleet-card UI and health-check loop

Closed the last two documented gaps in Phase B part 2. MS16.6: a "Network
Routing" panel on every fleet card (gated by the new `routing:manage`
capability) showing enrollment/IP/routing status via one progressive-
disclosure button that always matches the next valid step — "Start network
enrollment" → "Confirm enrollment" → "Discover IP" → "Start routing" →
"Stop routing" — instead of several simultaneous buttons for steps that
aren't reachable yet. A `route_lost`/`tun_error`/`pf_syntax_error` state
correctly falls through to offering a retry rather than a stuck disabled
button (caught and fixed while writing this — the state list the client
checked against didn't yet include the new `route_lost` state below).

MS16.7: `networkRoutingOrchestrator.js` gained `checkHealth()` plus
`startHealthChecks()`/`stopHealthChecks()` (every `ROUTING_HEALTH_CHECK_
INTERVAL_MS`, default 30s, once at least one device is routed). For every
`ROUTED` device it confirms the tunnel process is alive and the device's PF
rule is still loaded (`pfctl -vvs rules`, parsed by the new
`parsePfCounters()` in `pfRuleGenerator.js`, which sums packet counts
across a device's several rules). Either check failing outside of a
deliberate `stopRouting()` call flips the device to a new `ROUTE_LOST`
state — distinct from the setup-time `TUN_ERROR`/`PF_SYNTAX_ERROR` — so a
tunnel that silently died or an externally-flushed anchor doesn't go
unnoticed. Deliberately not a "did packets increase" pass/fail signal
(a legitimately idle device isn't broken); the raw counter is recorded on
the route as informational data instead. A transient `inspectRules()`
failure skips only that tick's PF check rather than failing every routed
device. Wired into `index.js`: `startHealthChecks()` runs automatically
whenever `AUTO_ROUTE_PROXY_TUNNELS` is enabled.

Verification: **749/749 full-suite tests passed** (`npm test`), including
3 new `parsePfCounters()` unit tests and 8 new orchestrator tests (healthy
recording, tunnel-death detection, vanished-PF-rule detection, transient-
failure tolerance, multi-device single-inspect-per-tick batching, and the
health-check timer's own start/immediate-check/interval/stop lifecycle).
Smoke-tested server boot successfully with the flag on. This closes out
Phase A and both parts of Phase B as functionally complete pending real
Mac mini hardware verification — see `system/README.md` for the full
picture of what remains hardware-gated versus what's genuinely done.

## 2026-09-16 (latest, continued) — MS16.4: network enrollment and USB-IP discovery routes

Extended MS16 with the admin-triggered actions for the two remaining manual
inputs `start-routing` needed: `POST /api/admin/devices/:deviceId/
network-enrollment/start`/`confirm` (bridge-member before/after diffing via
`usbNetworkMapper.js`, persisted per device in the new `usbNetworkStore.js`)
and `POST .../discover-ip` (tcpdump-based capture via `usbIpDiscovery.js`,
now correctly routed through `sudo -n` like every other privileged
operation — it previously shelled directly to `tcpdump`, which would have
failed with a permission error on a real Mac since packet capture needs
root). `start-routing`'s `usbIp` now falls back to whatever `discover-ip`
already resolved when the caller omits it. Both enrollment and discovery
still refuse with 409 rather than ever guessing when the result is
ambiguous, matching the architecture guide's own philosophy for this
human-paced process.

Verification: **737/737 full-suite tests passed** (`npm test`), including
new coverage for the persisted enrollment/discovery store, the Mac's-own-
bridge-IP parser (`parseInterfaceIp`, distinct from `tunManager.js`'s
point-to-point `parseTunPeer` — same "inet" keyword, different line shape),
and tcpdump's corrected `sudo -n` argv; plus 8 integration tests for the
three new routes' auth/RBAC/disabled-state fallback against the real
server. Smoke-tested server boot successfully. Not yet built, as noted in
`system/README.md`: any fleet-card/admin UI for these or the routing
routes (API-only so far), and a periodic health-check loop for an
already-routed tunnel.

## 2026-09-16 (latest) — MS16: proxy tunnel routing (Phase B, part 2)

Built the remaining pieces of automated tunnel routing and wired them into
the live server behind a new opt-in flag: `pfRuleGenerator.js` (PF ruleset
text with strict interface-name/IPv4 validation — every interpolated field
is rejected outright if it doesn't match, not sanitized, since this is the
actual rule-injection boundary given `pfctl -nf` faithfully parses whatever
text comes out), `privilegedOps.js` (the narrow `sudo -n` boundary, scoped
to `pfctl` and this app's private anchor only — documents the exact
`/etc/sudoers.d` line a human configures out-of-band, never `-F all` on the
main ruleset), `tunManager.js` (per-device supervised `tun2proxy`, `utunN`
allocation, peer discovery via `ifconfig`, and credential redaction on
every log line it exposes — tun2proxy's own stdout can echo the
authenticated proxy URL back out), `usbNetworkMapper.js`/`usbIpDiscovery.js`
(the bridge-diffing and tcpdump-parsing logic the guide's enrollment
strategy needs — pure logic only, not yet wired to an HTTP action), and
`networkRoutingOrchestrator.js` (the `PROXY_LEASED -> TUN_STARTING ->
PF_APPLYING -> ROUTED` state machine, `TUN_ERROR`/`PF_SYNTAX_ERROR` instead
of ever guessing past a failure, full-replace PF regeneration across every
routed device).

Wired into `index.js` behind `AUTO_ROUTE_PROXY_TUNNELS=true` (also needs
`SHARED_BRIDGE_IFACE` and an encryption key; fails closed with a logged
reason otherwise) — `POST /api/admin/devices/:deviceId/start-routing`/
`stop-routing`, gated by a new `routing:manage` capability (Admin-only,
deliberately a higher bar than `proxy:assign`, since this starts privileged
processes and changes firewall rules). `start-routing` still takes the
device's USB-side IP as an admin-supplied input — network enrollment and IP
discovery remain manual per the architecture guide's own human-paced
enrollment strategy (§4.4/§4.5); MS16.4's parsing/diffing logic exists but
isn't yet exposed through a route or UI, and there is no periodic
health-check loop yet for an already-routed tunnel.

Verification: **722/722 full-suite tests passed** (`npm test`), including
new unit coverage for PF rule-injection resistance (malicious interface
names/IPs explicitly rejected, including a newline-smuggling attempt),
every sudo-wrapper argv shape, credential redaction, bridge/utun diffing,
tcpdump/ifconfig parsing, and the orchestrator's full state machine (happy
path, both error states, multi-device full-replace regeneration, stop/
last-device-clears-anchor semantics, retry/interface-reuse) — all against
injected fakes, no real `sudo`/`pfctl`/`tun2proxy`/`tcpdump` invoked.
Integration-tested the live HTTP routes' auth, admin-only RBAC, and the
"not enabled" 409 fallback against the real server. Manually smoke-tested
server boot with the flag on and off on this non-macOS dev machine
(correctly no-ops with a logged reason when `SHARED_BRIDGE_IFACE` is
unset). Real `pfctl`/`tun2proxy` behavior, the sudoers configuration
itself, and the architecture guide's AT-05/AT-06 leak/routing acceptance
tests remain unverified until run on the Mac mini.

## 2026-09-16 (later) — MS15: shared proxy pool (Phase B, part 1)

Built `proxyPool.js` (encrypted-at-rest credential storage reusing
`twoFactor.js`'s AES-256-GCM helpers directly, CRUD, and the exclusive
`AVAILABLE -> LEASED(deviceId) -> RELEASED` lease state machine), the
`POST`/`GET`/`DELETE /api/admin/proxies` and
`PATCH /api/admin/devices/:deviceId/proxy-assignment` routes behind two new
capabilities (`proxy:view-pool`, `proxy:assign` — Admin + Manager, kept
separate from the existing Admin-only `proxy:manage`), a `poolProxy` field
on `device_list` (visible only to `proxy:view-pool` holders), and the client
side: a "Proxy Pool" admin panel (add/list/delete) and a proxy-assignment
`<select>` on every fleet card. No route or list response ever returns
host, port, username, or password — only `id`, `provider`, `protocol`,
`country`, a derived flag emoji, `label`, and `leasedToDeviceId`.

This is credential storage and exclusive assignment only. Actually starting
a tunnel for a leased proxy (TUN/PF automation, Phase B part 2) is not
built and not started.

Verification: **651/651 full-suite tests passed** (`npm test`), including
13 new `proxyPool.js` unit tests and 10 new integration tests against the
real running server/RBAC (auth, capability gating across view/assign/manage,
cross-device lease exclusivity, `device_list` visibility scoped correctly,
audit trail, and an explicit assertion that the plaintext password never
appears in any response or audit record). Confirmed the client changes load
without any console error (every new `getElementById` reference resolves —
also proven statically by `clientBoundaries.test.js`) before authentication,
on this non-macOS dev machine; a full authenticated click-through on the Mac
mini is still recommended.

## 2026-09-16 — MS14: automated WDA/iproxy device provisioning (Phase A)

Built the opt-in (`AUTO_PROVISION_WDA=true`) provisioning pipeline described
in `Phone_Farm_Automation_Architecture.md` Phase A: `hostPreflight.js`,
`portAllocator.js`, `deviceProvisioningStore.js`, `processSupervisor.js` +
`wdaProcessManager.js` + `iproxyManager.js`, and the `deviceProvisioner.js`
orchestrator. A UDID with no explicit `devices.config.json` entry now gets
its WDA process and `iproxy` tunnel launched automatically, reuses a
persisted port/derived-data path across restarts and replugs, and surfaces
known manual-prerequisite failures (untrusted cert, Developer Mode, App ID
limit) as an actionable `user_action_required` banner instead of looping
retries — with a "Retry automatic setup" admin action
(`POST /api/admin/devices/:deviceId/retry-provisioning`, new
`device:provision` capability) for both that state and a hard
`provisioning_error`. Manually pinned `devices.config.json` WDA entries (the
MS5 hardware-validation path) are explicitly skipped by the provisioner, so
existing single-device bench-testing is unaffected. The existing 10-second
WDA-readiness loop is reused as-is to detect actual readiness; this feature
does not add a second `/status` poller.

Not built yet (tracked as Phase B, not part of MS14): the shared proxy pool,
per-device proxy assignment UI, and TUN/PF tunnel-routing automation.

Verification: **628/628 full-suite tests passed** (`npm test`), including 50
new unit tests covering port allocation, atomic provisioning-record
persistence, host preflight (including the ENOENT-vs-nonzero-exit
distinction), both process managers' argv construction (the mandatory
`iproxy -u`, unique per-device derived-data paths), and the provisioner's
full attach/detach/replug/failure-classification/retry state machine
against injected fakes — no real `xcodebuild`/`iproxy`/`idevice_id` was
invoked. Manually smoke-tested server boot with the flag on and off on this
non-macOS dev machine (correctly no-ops with a logged reason when
`platform !== "darwin"`). Real `xcodebuild`/`iproxy` process behavior, Xcode
trust-prompt flows, and physical USB attach/detach reconciliation remain
unverified until run on the Mac mini.

## 2026-09-15 — security review remediation and live-test readiness

Closed the 24 findings in the 2026-09-14 code review across WDA authorization
and session races, live-frame rate/failure isolation, upload reauthorization,
team and audit scope, recovery-token handling, account/username transactions,
write-first queue persistence, scheduler containment, physical-device config
validation and readiness, DST-safe recurrence, session cleanup, and deployment
hardening. Production startup now rejects mock fleets, weak session secrets,
unsafe exposure, caller-controlled network-check targets, and malformed WDA
identities. Stable public errors replace internal transport detail.

Verification: **566/566 full-suite tests passed** with `npm.cmd test`; 18 changed
JavaScript entry points passed `node --check`; focused deployment/WDA/network
coverage passed 94/94; explicit local startup returned the expected 401 from
`/api/me`; fail-closed startup without a strong secret exited nonzero; and
`git diff --check` passed. Physical Mac mini/WDA control and monitor acceptance,
live proxy routing, email delivery, model providers, research accounts, platform
skills, and deployed HTTPS remain external gates.

## 2026-09-14 — controlled WDA Live view

Implemented an opt-in one-second screenshot poller for a Human-controlled WDA
device detail view. Client and server both suppress overlapping live screenshot
requests; browser visibility pauses/resumes polling, and leaving detail,
release, sign-out, access loss, or three repeated failures stops it. Live frame
requests bypass the ordered input queue, while tap/swipe/Home/type commands keep
their existing serialized action-and-frame behavior and manual fallback.

Verification: **529/529 full-suite tests passed** with `npm.cmd test`, including
polling lifecycle, hidden-tab behavior, overlap suppression, release/sign-out
cleanup, and a fake-WDA concurrency check proving input starts while a delayed
live screenshot is still pending. This is screenshot polling, not video, and no
physical Mac mini/WDA monitor acceptance is claimed.

## 2026-09-12 — restricted VA fleet

Implemented one role-aware login flow, safe all-device fleet summaries, explicit
VA device grants that fail closed, and server-enforced Human-mode ownership for
selection and every later phone input. Grant and role changes are resolved live;
revocation immediately releases an open claim and removes the phone-control view.
The server now also pushes safe live operator profiles after role/grant edits,
and the browser discards in-flight privileged responses from the prior profile
generation instead of letting them repopulate cleared Admin data after demotion.
VA fleet summaries omit assignment instructions, authorized-operator lists, and
secret-bearing network configuration. Admin and Manager capability behavior is
preserved.

Verification: **470/470 full-suite tests passed** with `npm.cmd test`. Separate
browser sessions confirmed the Admin fleet/Operations experience and the VA
fleet, assigned-device control, release, logout, and restricted-device states.
No physical iPhone or WDA validation was performed for this milestone.

## 2026-09-11 — role capabilities and authenticated staff presence

The control plane now has five explicit roles mapped to named server-side
capabilities; route, command, and WebSocket checks use capabilities while device
and research grants remain independent boundaries. The matrix is documented in
[ROLE_CAPABILITY_MATRIX.md](ROLE_CAPABILITY_MATRIX.md).

The browser now has a persistent People sidebar backed by `GET /api/people` and
WebSocket presence broadcasts. It aggregates tabs into authenticated sessions,
shows only safe public identity/activity fields, tracks current human-controlled
phones, and handles logout, expiry, disconnect, and stale heartbeat cleanup. See
[PRESENCE_AND_PEOPLE.md](PRESENCE_AND_PEOPLE.md). The completed capability pass
was verified by a 435/435 full suite; presence then passed its 51 focused tests.
Physical phone/WDA validation remains a separate gate.

The same pass added [durable assignments](ASSIGNMENTS.md): role-aware creation,
assignee status updates, Manager/Admin reassignment, optional phone/account
scope, append-only history, and restart-safe persistence. The browser exposes an
Assignments workspace to every role and management controls only to operators
with `assignments:manage`.

Integrated verification after the assignment, scoped fleet, dashboard, and
phone-detail changes: **445/445 tests passed** with `npm test`. A browser review
against an isolated disposable local instance covered sign-in, People presence,
fleet summaries/filtering, assignment creation/history, and phone detail. It
found and fixed narrow-viewport top-bar overflow and a clipped assignment field;
the recheck showed no horizontal overflow and the browser console was clean.

## 2026-09-09 — MS3.3 research ownership

Implemented workspace-owned research accounts, explicit operator workspace grants,
authorization on every research route, workspace-separated storage, and audit
context. Admin status does not bypass the boundary. Legacy files remain untouched
and are not served implicitly. Configuration and reviewed migration are documented
in [RESEARCH_OWNERSHIP.md](RESEARCH_OWNERSHIP.md). No real customer mapping was assumed.

Verification: **354/354 full-suite tests passed** with `npm test` (current count,
up from the 215 recorded when this note was first written). Earlier
sections describing MS3.3 as undecided are historical and superseded by this update.
This completes the research-record boundary, not global queue/audit tenancy.
The production research runner now rechecks account authorization on every
bounded step. Device setup and MS5 physical acceptance remain pending hardware.

**Same-day follow-up:** the research/chat side panel and full `ContentCandidate`
schema population (Priority #3, referenced as "not started" in several sections
below that predate this work) were also completed 2026-09-09 — see the MS8
section's rewrite for the current field-by-field state. A real bug was found and
fixed in the process: `researchAccess.js`'s workspace-id validator (lowercase-only)
had drifted from looser, independently-written copies in `authStore.js` and
`create-operator.js`, so a grant like `"Client-A"` would load without error and
then permanently, silently fail to match the real `"client-a"` workspace at
request time. Fixed by extracting a single shared validator
(`server/src/researchId.js`) used by all three call sites, with a loud
`console.warn` on load if an operator's grant is dropped for being invalid.

Separately: the emergency **STOP AI / TAKE OVER** control, built in MS6.3 as
unconditionally operator-visible, became `admin`-only as part of the 2026-09-08
role-split pass below. This was confirmed as an intentional decision (not an
oversight) on 2026-09-09, and `CLAUDE.md` §4 / `docs/COMMAND_QUEUE_SPEC.md` §9
have been updated to state it explicitly rather than contradict the shipped
behavior.

**Second same-day follow-up:** a real security-relevant bug was found and fixed
during a live-browser check (not caught by any static survey): `role` and
`allowedDevices` were read from `req.session.operator` (HTTP) or a WebSocket
connection's handshake-time closure variable only once, at login/connect time —
never re-checked against the live operator registry, unlike
`researchWorkspaceFor()`, which already re-resolved grants live for exactly
this reason. A demoted admin or an operator with a revoked device grant kept
their old privileges — including the emergency-stop control — for the full
lifetime of any already-open session or WebSocket connection. Fixed with a new
`resolveOperator()` (`authStore.js`) threaded through every authorization
checkpoint in `index.js` (`requireAuth`, `requireRole`, the WS
`requireAdminWs`, and every `canAccessDevice`/`executeCommand` call), fail-
closed if the operator no longer exists. One existing test's expectation
changed from 403 to 401 for a deleted operator (a more precise status —
identity gone is an authentication failure, not merely an authorization one),
with 2 new regression tests proving a privilege change now takes effect on the
very next request/message with no re-login required, including on an
already-open WebSocket.

**Third same-day follow-up:** the cross-run research-candidate deduplication
gap described lower in this document (MS8 section) is now fixed. `createRun`
(`researchStore.js`) already deduped candidates *within* one call's own batch;
it now also checks a persisted per-account `candidateIndex` (keyed by
`platform_content_id`/`canonical_url`, additive — old JSON files without it
still load) so a later run re-observing the same post carries forward its
`review_state`/`first_seen_at` instead of resetting to a fresh `pending`
candidate and losing a reviewer's earlier decision, per `CLAUDE.md` §8. A new
row is still recorded per observation (nothing is silently dropped) and is
tagged `duplicate_of_run` so it's visible as a repeat rather than new.
`setCandidateStatus` keeps the index in sync so a review taken on any
occurrence carries forward to the next one. 3 new tests cover: review-state/
first-seen carry-forward (both `confirmed` and `removed`), a match via
`platform_content_id` alone when the URL itself changed between observations,
and legacy files with no `candidateIndex` key still loading correctly. This
was a scoped, low-risk fix (Option B from the three considered) rather than
the bigger flat-candidate-store restructure (Option A) — deferred until an
actual AI worker exists and real usage shows the embedded-per-run model is
the wrong shape.

**Fourth same-day follow-up:** MS8.1 (the model-provider interface) is now
built — see the MS8 section below for the full writeup. `modelProvider.js`
defines the vendor-agnostic `ModelProvider` contract and its MS8.1.6
contract test; `anthropicProvider.js` and `openAiCompatibleProvider.js` are
the two required adapters (the latter covers OpenAI/DeepSeek/Kimi/NVIDIA NIM
via one implementation, per MS8.1.4); `providerRegistry.js` is the
config-driven registry (`models.config.json`, credentials referenced by
environment-variable name only, mirroring `devices.config.json`'s pattern).
At that point this was pure plumbing and no real API key existed anywhere in
the repo. 30 tests covered the provider layer. This was undertaken on "keep coding" after the prior
three follow-ups, on the reasoning that `docs/CODING_ROADMAP.md` MS8.1.3
already prescribes which vendors/adapters to build (no open decision
remained to block on) and Priority #3 already established that the user
wants AI-VA-layer progress.

**Fifth same-day follow-up:** the hardware-independent MS8 execution path is
now built end to end. `observationPackage.js` captures accessibility/UI-tree
data first and falls back to a validated image. Config-driven, versioned
accessibility profiles exist for Instagram, Reddit, and X. The production
`researchTaskRunner` subscribes to scheduler dispatch, resolves one exact
authorized account, resolves the active model selection before each decision,
runs bounded verified steps, writes candidates and locally captured image
evidence, and completes or hands off through the durable queue. `/model set`
supports global, workspace, device, and task scopes without a restart.
The platform profiles and production path are locally tested but deliberately
disabled in the shipped empty configuration until actual app versions,
accounts, credentials, and a physical device are verified.

This is a point-in-time audit of `system/` against
[`docs/CODING_ROADMAP.md`](CODING_ROADMAP.md)'s milestones. Every claim below
was checked directly against the current code (file/line references included)
or a direct command (`git log`, `npm audit`, `grep`, `npm test`), not against
what the other docs say should exist.

**Update:** the original version of this report (below, still accurate for
MS5 and MS8 onward) found zero milestones complete. Since then, **MS1
through MS4, MS6, and MS7 were implemented and verified**. The 2026-09-08
current full automated suite is **354/354 passing**
(`npm test`). Earlier manual browser/curl passes still cover device control,
login/logout, audit, AI-mode handoff, and the command console; this latest
role-split pass adds automated DOM/authorization coverage and should still get
one final visual Chrome/Safari pass on the deployment Mac. See the top of each section
for what changed. MS5 (the only hardware-dependent milestone in this range)
remains genuinely blocked on the device's arrival — MS6 and MS7 were
completed out of the roadmap's original order since neither needs real
hardware to build or test.

---

## Summary

| MS | Name | Code status | Testing gate |
|---|---|---|---|
| 1 | Engineering foundations & test infra | ✅ Done | ✅ Passing (354-test full suite) |
| 2 | Human VA core hardening | ✅ Done | ✅ Passing (part of the 354) |
| 3 | Authentication & authorization | ✅ MS3.1/3.2, VA/admin roles and MS3.3 research-record ownership implemented; customer mappings/migration remain explicit setup | ✅ Passing (354-test full suite, 2026-09-09) |
| 4 | Persistence, audit & health | ✅ Done (MS4.1 rescoped — see detail) | ✅ Passing (part of the 354) |
| 5 | Real-device validation & scaling | 🟡 Reusable N-device mock soak runner built; physical WDA validation remains | ✅ 5 mocks/60 actions short proof passed; 30-minute and real-device gates not run |
| 6 | Controller mode & input-lease abstraction | ✅ Done (MS6.3 UI: see detail — STOP AI is now `admin`-only, a deliberate 2026-09-09 decision) | ✅ Passing (part of the 354) |
| 7 | Command & queue scheduler | ✅ Done | ✅ Passing (part of the 354) |
| 8 | AI VA read-only research mode | 🟡 Software path complete locally: providers, model selection, three versioned accessibility profiles, production runner, candidate/evidence pipeline and handoff | ✅ Local unit/integration coverage passing; live provider/app/device gate not run |
| 9 | Private research markers | ✅ Built: verify-before-toggle save/bookmark, record-before-act | ✅ Local tests passing; real-app labels unverified |
| 10 | Configured account actions | ✅ Built: per-account policy, single-use approvals, comment guard + ledger | ✅ Local tests passing; real-app labels unverified |
| 11 | Timed autonomous research sessions | ✅ Built: quotas, budgets, restart-safe checkpoints, session reports | ✅ Local tests passing; supervised device run not done |
| 12 | Multi-device AI fleet | ✅ Built: fleet gate, spend limits, affinity, intervention queue with a Review-panel UI | ✅ Local tests passing; multi-device hardware run not done |
| 13 | Optimization | ✅ Built, opt-in: local planner, 3-tier router, state cache, adaptive pacing, search/dedup, analytics, regression benchmark | ✅ Benchmark gate passing (modeled costs); real-model measurement not done |

🟡 = real code exists that maps to this milestone, but the milestone (as
scoped, with its testing gate) is not complete. ⬜ = no code exists for this
milestone at all.

---

## MS1 — Engineering foundations & test infrastructure

**Status: ✅ Done.**

| Step | Status |
|---|---|
| MS1.1.1 `.gitignore` | Done — root `.gitignore` excludes `node_modules/` and `system/storage/**`, keeping `.gitkeep` placeholders |
| MS1.1.2 First commit | Done — the user authorized the baseline commit on 2026-09-09 |
| MS1.1.3 `npm audit fix` | Done via an `overrides` entry pinning `qs` to `^6.16.0` (the declared `express`/`body-parser` ranges hadn't picked up the patched `qs` yet) — `npm audit` now reports 0 vulnerabilities |
| MS1.1.4 `maxPayload` cap | Done — `new WebSocketServer({ server, maxPayload: 64 * 1024 })` in [index.js](../system/server/src/index.js) |
| MS1.2 Test runner | Done — `node --test` (built-in, no new dependency), `npm test` runs `server/test/**/*.test.js` |
| MS1.3 Fake-WDA parity | Done — the fixture moved to `server/fixtures/fake-wda-server.js` (Node's test runner treats every file under a directory named `test` as a test file, which would have made `npm test` hang on the old location) and gained swipe/keys routes plus `/debug/history`, `/debug/hang`/`unhang`, and `/debug/delay` for the timeout/ordering tests below |
| MS1.4 Doc drift fix | Done — `system/README.md`'s status list, WebSocket protocol table, and coding-priority list now match the code |

## MS2 — Human VA core hardening

**Status: ✅ Done.** 26 tests passing (`npm test`), plus a manual pass through
the real browser client (select → tap the Instagram icon → swipe left →
type "hello" → release — each step confirmed via the rendered SVG).

- **MS2.1 automated coverage**: unit tests for `fileStore`/`researchStore`
  validation logic; integration tests driving `WdaDevice` against the fake-WDA
  fixture (tap/swipe/typeText, session reuse); integration tests driving the
  real relay WebSocket protocol end-to-end (select/tap/swipe/type/release,
  unknown-device and already-in-use error paths, out-of-range coordinates
  silently dropped).
- **MS2.2.1 WDA timeouts**: every `WdaDevice` fetch now carries
  `signal: AbortSignal.timeout(this.timeoutMs)` (default 8s, configurable per
  device via `devices.config.json`'s new optional `timeoutMs` field). Verified
  with a fixture that "hangs" on command — the call rejects well under the
  configured timeout and invalidates the cached session.
- **MS2.2.2 ordering guarantee**: proved with a real timing window (fixture
  response delay + two concurrent taps) that the second tap's request is never
  sent to the device until the first tap's *entire* round trip — including its
  post-tap screenshot — has completed. This is the actual property the
  per-connection action queue exists to guarantee, not just "no crash."
- Bonus: added a test proving `reportError` fires exactly once and flips the
  device to `offline` correctly on a real mid-session failure — MS2.3.2 (fire
  once, no duplicates) was a "verify" item and is now backed by a test rather
  than only code inspection.
- **MS2.3.1 busy-timeout retry affordance**: `client/app.js`'s `setBusy` now
  shows "No response from the device — you can try again." when the 10s
  safety net fires (rather than silently re-enabling controls with no
  explanation), and clears that message the moment a new action starts.

`index.js` also gained a guarded main-module check (`server.listen()` only
runs when the file is executed directly) so the integration tests above could
import and drive the real app in-process on an ephemeral port — required for
the WS protocol tests to exist at all, not optional polish.

**Follow-up (2026-09-07): a real gap against `CLAUDE.md` §3's literal
requirement, caught while doing unrelated work.** §3 lists "tap, swipe, text
input, home/back/device controls where supported" as current scope — the
hardware Home button had never actually been implemented; only tap/swipe/
type existed. Added: a new WS `home` message, `WdaDevice.pressHome()`
(confirmed against `research/WebDriverAgent`'s `FBCustomCommands.m` — real
WDA registers `POST /wda/homescreen` `.withoutSession`, unlike tap/swipe/
keys which are scoped under `/session/:id/...`, so this correctly skips
`ensureSession()`/`ensureWindowSize()` entirely), `MockDevice.pressHome()`,
a matching route on the fake-WDA fixture, and a Home button in the browser
UI next to the swipe controls. 5 more tests (170 total).

---

## MS3 — Authentication & authorization

**Status: ✅ MS3.1 (operator identity), MS3.2 (device RBAC), and MS3.3
(per-workspace research data ownership, implemented 2026-09-09 — see below)
all done and tested.**

What's implemented:

- **MS3.1 operator identity**: [authStore.js](../system/server/src/authStore.js)
  — scrypt password hashing with per-password salt and a constant-time
  (`timingSafeEqual`) comparison; operators loaded from `operators.config.json`
  (gitignored — it holds password hashes, unlike `devices.config.json`) via a
  live `Map`, mirroring how `index.js` exports `devices` for the same reason.
  `server/scripts/create-operator.js` creates/updates an operator with a
  properly hashed password — that file is never hand-edited.
  `POST /api/login`, `POST /api/logout`, `GET /api/me`, cookie sessions via
  `express-session` (in-memory only — doesn't survive a relay restart, tracked
  separately under MS4).
- **MS3.1.3 route + WS gating**: `requireAuth` middleware protects every
  `/api/devices/*` and `/api/research/*` route. The WebSocket upgrade itself
  is gated too — `wss` now uses `{ noServer: true }` with a manual
  `server.on("upgrade", ...)` handler that runs `express-session`'s own
  middleware against the raw upgrade request and rejects with HTTP 401 before
  the handshake completes if there's no valid session. This was the part of
  MS3 with no template to follow in the existing code — reused verbatim from
  `ws`'s own documented pattern for authenticating upgrades against an
  existing session store, rather than inventing a second auth mechanism.
- **MS3.2 device RBAC**: each operator has an `allowedDevices` list (`null` =
  every device, for an admin/lead VA). Enforced at `select_device` time (a
  disallowed device returns an error over the WebSocket, not silently
  ignored) and at every file route (403, not 404 — existence isn't hidden,
  just access).

**MS3.3, per-client/workspace ownership of *research* data** (as opposed to
device files, which MS3.2 covers) — the ownership-model decision this
originally needed was made and implemented 2026-09-09: `research.config.json`
declares `{id, workspaceId}` accounts, each operator carries an explicit
`allowedResearchWorkspaces` grant list (independent of `role` — an admin
gets no automatic bypass), and `researchAccess.js`'s `researchWorkspaceFor()`
is the single choke point every `/api/research/*` route resolves grants
through before touching `researchStore.js`. Full detail, including the
migration story for the old ungated flat files, is in
[RESEARCH_OWNERSHIP.md](RESEARCH_OWNERSHIP.md).

Verified: 39 automated tests (unit tests for `authStore.js`'s hashing/
verification/authorization logic; integration tests for the full login/
logout HTTP flow, an unauthenticated WS upgrade being rejected, a restricted
operator being blocked from an unauthorized device over WS and getting 403
on its files, and an authorized operator succeeding on both). Manual pass:
signed in through the real browser login form, selected and released a
device, signed out, confirmed `/api/me` returns 401 and the login form
reappears.

**Real bug found and fixed after the fact, while stress-testing MS6 (below):**
`client/app.js`'s login handler called `connect()` right after `fetch("/api/login")`
resolved, without reading the response body first. `fetch()`'s promise resolves
once headers arrive — it does not wait for the body — but this server (via
express-session's own internals) holds the response's last byte back until
the session has actually finished writing to disk. A real VA could occasionally
have their very first WebSocket connection rejected with 401 immediately after
signing in, purely from that timing gap, on a real login the credentials for
which were entirely correct. Root-caused via a deterministic ~15-repro-run
reduction (not a guess): confirmed empirically that `FileSessionStore.get()`
was sometimes reading the session file mid-write (empty content, valid JSON
error) because the caller had moved on before the write completed. Fixed by
awaiting the response body in `client/app.js`'s login and session-check paths,
and in the test helpers that do the same thing. This is exactly the kind of
defect the "run it 15-20 times in a row" stress-testing this project's test
suite makes possible was for — it never surfaced in a single manual run.

---

### 2026-09-08 follow-up — VA vs admin/dev operator profiles

**Status: ✅ Implemented and tested as a UI/access-layer extension of MS3.**
At the time this section was written, this did not complete MS3.3 — research
data ownership was still a separate, undecided concern. **MS3.3 was decided
and implemented the following day (2026-09-09); see the section above.**

What changed:

- Operators now carry one of five explicit feature roles: `admin`, `manager`,
  `va`, `content_creator`, or `editor`. Missing or unknown role values normalize
  to `va` (fail closed). This role is separate
  from `allowedDevices`; an admin does not automatically gain access to every
  phone.
- `GET /api/me` exposes only the safe browser profile: `username`, `role`,
  `allowedDevices`, and non-secret capability names. Password hashes remain
  server-only.
- `GET /api/audit`, `GET /api/queue`, and `POST /api/queue/command` require
  `admin` server-side. A VA calling them directly gets 403, even if the UI is
  bypassed.
- Direct WebSocket AI-management actions (`switch_to_ai`, `takeover`,
  `emergency_stop`) also require `admin`. Normal VA control remains unchanged:
  select/release, tap, swipe, type, Home, and normal file operations still use
  the existing device RBAC.
- Generic tasks created by a device-restricted admin carry that operator's
  allowed-device set into `TaskSpec.deviceSelector`; scheduler dispatch will
  not place the task on a phone the admin is not authorized to use.
- The browser now has two operator experiences without a second auth system:
  VAs get fleet + live control only; admins get those views plus a dedicated
  admin/dev workspace for the existing command parser, task queue, audit log,
  and AI-mode controls. Logout/login resets the role-aware UI so an admin panel
  cannot remain visible after switching to a VA session.
- Fleet-status visibility was intentionally preserved: authenticated operators
  still receive the existing global `device_list` status broadcast, while
  actual selection/control/file access remains enforced by `allowedDevices`.
  This UI pass did not redesign the protocol.

Verification: **209/209 automated tests passing**. New coverage includes safe
`/api/me`, VA 403s on admin APIs, successful admin use, normal VA device
control, server-side rejection of VA AI-mode messages, preservation of device
RBAC, restricted-admin scheduler dispatch, and a static client check proving
every DOM id referenced by `app.js` exists in `index.html`. A real-browser
visual pass on the deployment Mac remains manual.

Priority #3 (AI research/chat side panel and population of the existing
`ContentCandidate.platform_actions[]` / `evidence_refs[]` fields) was
**deliberately not started in this change** — it was completed the next day,
2026-09-09, alongside MS3.3 above. See the MS8 section for its current state.

---

## MS4 — Persistence, audit & health

**Status: ✅ Done, with one deliberate scope correction from the original plan.**

**Scope correction on MS4.1:** the original roadmap called for moving device
"in-use" status into a durable store so it survives a restart. Building it
surfaced that this was based on a wrong assumption — device claims are
inherently tied to a live WebSocket connection, and a relay restart already
drops every connection, so devices correctly reset to `idle` on their own.
Persisting and restoring that field naively would risk the opposite bug: a
device stuck "in-use" forever because the connection that once claimed it no
longer exists to release it. **What genuinely needed to survive a restart
instead: operator login sessions** (a real gap — every operator was getting
logged out on every relay restart) and the audit log itself. Both are done.

What's implemented:
- **File-backed sessions** — [fileSessionStore.js](../system/server/src/fileSessionStore.js),
  a custom `express-session` Store, one JSON file per session under
  `storage/sessions/` (gitignored). Deliberately not SQLite (the roadmap's
  original suggestion) — this data is small and low-throughput, every other
  persistence mechanism in this codebase is already a plain file, and
  `node:sqlite` is new enough to add a Node-version dependency this project
  doesn't otherwise have. Session cookies now last 24h and survive a restart.
- **Audit log** — [auditLog.js](../system/server/src/auditLog.js), append-only
  JSON-lines at `storage/audit/events.log` (gitignored). Records logins/
  logouts, device select/release (including denied and conflicting
  attempts — the RBAC violations are audit-worthy too), every tap/swipe/
  type_text, file upload/download/delete, and research candidate status
  changes. `type_text` events log length only, verified end-to-end by a test
  that types a "secret" string and asserts it never appears anywhere in the
  audit API's response. As of the 2026-09-08 operator-profile pass,
  `GET /api/audit` is admin-only and a logged-in VA receives HTTP 403.
- **Device health** — tracked in `index.js`'s `deviceHealth` Map (separate
  from the device adapter objects themselves, per Architecture Baseline §2:
  adapters execute primitives, they don't own control-plane bookkeeping).
  `lastSeenAt` and `consecutiveFailures` are surfaced in `device_list` and
  shown in the client. **Behavior change from the pre-MS4 code:** a device
  now only flips to `offline` after `OFFLINE_AFTER_FAILURES` (3) consecutive
  failures, not the first one — one network blip no longer alarms every
  other VA watching the device list or knocks the active VA off their own
  selection. Auto-recovers to `in-use` on the next success. The existing
  MS2 test that assumed immediate offline-on-first-failure was updated to
  match (split into a "single failure doesn't flip it" test and a "3
  failures does, and recovery works" test).

Verified: 56 automated tests total (up from 40), including — the actual MS4
testing-gate scenario — spawning the real relay as a **separate OS process**,
logging in, killing it, restarting it on the same port, and confirming both
the session (via the old cookie) and the audit history survive. Plus a
manual browser pass: signed in, selected/released a device, confirmed
`GET /api/audit` showed exactly `login_success` → `device_selected` →
`device_released` for that operator, newest first.

One thing worth knowing: while building this, the automated test suite was
found to be writing real session/audit files into the actual dev `storage/`
tree before `SESSION_STORE_DIR`/`AUDIT_LOG_PATH` env-var isolation was wired
up correctly (an ES-module import-ordering issue — fixed by importing
`index.js` dynamically after setting those env vars, in the one test file
that runs it in-process). The leaked test data was cleared from real storage
once found; it was never meaningful data to begin with.

---

## MS5 — Real-device validation & scaling

**Status: 🟡 The automated scale harness is built; physical validation remains.**
`npm run soak` creates isolated authenticated WebSocket clients and mock devices,
drives tap/swipe/home traffic concurrently, and fails when its error-rate or
heap-growth threshold is exceeded. A short 5-device proof completed 60 actions
with 0 errors and +1.4 MB heap. This proves the harness and concurrency path,
not the roadmap's 30-minute soak requirement. The one-iPhone WDA bench,
latency baseline, failure injection, 30-minute soak, and physical 1 → 2 → 5
gates remain unverified until the hardware is connected.

---

## MS6 — Controller mode & input-lease abstraction

**Status: ✅ Done, including the role-gated AI status and takeover UI.**

**Design decision worth flagging:** the six controller modes are a dimension
*orthogonal* to the existing `idle`/`in-use`/`offline` status, not a
replacement for it. A device's controller mode is `HUMAN` by default and
stays there through every normal select/tap/release cycle — `idle`/`in-use`/
`offline` are sub-states *within* `HUMAN` mode, exactly as before. Only an
explicit `switch_to_ai` moves a device into `AI_IDLE`/`AI_RUNNING`/
`AI_PAUSED`. This is why nothing about today's Human VA flow changed at all
by adding this — every existing MS1-4 test kept passing unmodified.

What's implemented:
- [controllerMode.js](../system/server/src/controllerMode.js) — the pure
  state machine: `HUMAN | AI_IDLE | AI_RUNNING | AI_PAUSED | HANDOFF | ERROR`
  and the full legal-transition table. `EMERGENCY_STOP` is legal from every
  single state by construction, not by a special-cased bypass — that's what
  makes "revoke AI input at the control-plane boundary" (CLAUDE.md §4)
  actually true rather than aspirational.
- [deviceLease.js](../system/server/src/deviceLease.js) — the stateful
  registry: `switchToAI` (HUMAN → AI_IDLE, only from an idle device),
  `switchToHuman` (graceful — blocks new AI actions immediately, then waits
  up to `timeoutMs` for whatever's already in flight via
  `registerPendingAiAction`, the hook a future AI worker calls before every
  action), and `emergencyStop` (synchronous, works even against a
  never-resolving pending action — verified by a test that registers a
  promise which never settles and confirms the stop still completes in
  under a second).
- WS protocol: `switch_to_ai`, `takeover`, `emergency_stop` — all
  device-RBAC-gated and, since the 2026-09-08 role pass, additionally
  admin-only; all are audited.
  `select_device` now rejects a device in an AI_* mode with "take over
  first" instead of just failing confusingly.
- Client: AI-mode interaction is now role-aware. Admins receive the
  management controls; VAs see the controller mode plus an admin-handoff note
  and cannot trigger takeover. The server enforces the same rule independently
  of client rendering.

**MS6.3 (dedicated UI — a read-only AI status pane, a permanently-visible
STOP AI button) was deferred here, then built once MS7 gave it something
real to show** (see its own section below).

Verified: 20 automated tests (up from 56 → 76 → 81 across MS1-6), including
the full transition table (every mode × every event), the graceful-handoff
timing behavior, and — the key MS6 correctness property — that
`emergency_stop` completes in well under a second against a WS-level
simulated "stuck AI worker" (a registered action that never resolves),
while a normal `takeover` correctly waits for a real in-flight action to
finish first. Manual pass: from the browser console, sent `switch_to_ai` for
a device, watched it render "— AI_IDLE" in the list, clicked it (triggering
`takeover`, not `select_device`), confirmed it was claimed and controllable,
and confirmed the audit trail showed `switched_to_ai → takeover →
device_selected → device_released` in order.

---

## MS7 — Command & queue scheduler

**Status: ✅ Done, built ahead of MS5 for the same reason MS6 was — no
hardware needed to build or test it against.**

What's implemented:
- [taskSpec.js](../system/server/src/taskSpec.js) — the `TaskSpec` shape (13
  states from `COMMAND_QUEUE_SPEC.md` §5) and pure time-window helpers
  (`isWindowOpen`, `hasWindowExpired`), each taking `now` as an explicit
  parameter rather than reading the real clock internally.
- [commandParser.js](../system/server/src/commandParser.js) — parses
  `/mode`, `/time` (same-day or explicit date), `/cresearch`, `/queue
  add|list|pause|resume|cancel|move|priority`, and `/pause`/`/resume`/`/stop`/
  `/takeover` into validated structured fields — never raw text. Anything
  without a leading `/` is a natural-language *proposal* only
  (`{ goal }`), never silently queued (§12) — turning it into a real
  `TaskSpec` is explicitly left to the model layer (MS8).
- [taskQueue.js](../system/server/src/taskQueue.js) — a factory (like MS4's
  `createAuditLog`, not a singleton — tests get a fully isolated queue with
  injected devices/lease, avoiding the manual-reset pain MS6's singleton
  `deviceLease` needed). Implements: eligibility (window + dependencies),
  per-device dispatch (multiple devices can each run their own task at
  once), FIFO-unless-reordered priority ordering, durable global queue-pause
  state, `FAILED_RETRYABLE` retry
  accounting up to `retryPolicy.maxRetries`, durable `backoffMs` eligibility
  deadlines that survive restart, checkpoints, and restart
  recovery (an interrupted `RUNNING`/`DISPATCHED` task is retried or
  `FAILED_FINAL`'d per its own retry policy on load — COMMAND_QUEUE_SPEC.md
  §14 has no dedicated "interrupted" state among its 13, so this reuses the
  same accounting a normal failure would).
- Queue admission now writes the task snapshot before adding it to the live
  scheduler. If a dispatch write fails after taking a device lease, the task
  and lease roll back to their prior states and a later tick can retry safely.
- `/cresearch` formalized in `docs/COMMAND_QUEUE_SPEC.md` as its own
  documented section (MS7.1.4) — no longer just a code-comment convention.
- `POST /api/queue/command` and `GET /api/queue`, both auth-gated;
  device-targeting commands (`/mode`, `/pause`, `/resume`, `/stop`,
  `/takeover`) are RBAC-checked exactly like `select_device`.
- **Real integration with MS6**, not just adjacent code: dispatching a task
  calls `deviceLease.switchToAI`/`applyEvent(START_TASK)`; a task reaching
  `NEEDS_HUMAN` triggers a genuine `switchToHuman` handoff, not a status
  flag; the existing WS `takeover` message (built in MS6, before any task
  concept existed) was updated to route through `taskQueue.takeoverDevice`
  so a human taking over via the UI properly cancels whatever queued task
  was running — without that fix, the queue would have kept believing it
  held a device that had just become `HUMAN`.

**A real gap in MS6 found and fixed while building this:** the controller-
mode transition table had no `TASK_FINISHED` transition from `AI_PAUSED` —
a paused task that got stopped or cancelled (a scenario MS6 had no reason to
exercise, since nothing could pause a task yet) would have left its device
stuck in `AI_PAUSED` forever, reachable only via a full human handoff or
emergency stop. Added the transition, updated MS6's own test suite.

**Two real bugs found and fixed via the test suite while building this** (not
via inspection — both surfaced as assertion failures against expected
behavior):
1. A task created with an `earliestStart` already in the past stayed stuck
   in `SCHEDULED` forever, because only `tick()` performed the `SCHEDULED` ->
   `QUEUED` transition and `addTask()` only called the dispatch step, not
   the window-check step. Fixed by having `addTask()` call `tick()`.
2. A task recovered from an interrupted restart (`FAILED_RETRYABLE` ->
   re-queued) never actually got re-dispatched, because queue construction
   loaded and recovered tasks but never called `tryDispatch()` afterward.
   Fixed by ticking once at the end of `createTaskQueue()`'s setup.
3. (Found while documenting `/time`'s date handling, not via a queue test
   directly): `timeToDate()`'s same-day path called the real `Date()`
   internally instead of using the injected `now` — meaning a same-day
   `/time` command's actual behavior depended on which real calendar day the
   test suite happened to run on, defeating the entire point of threading
   `now` through explicitly. Fixed, with a regression test using a
   far-future injected `now` specifically to catch this class of bug again.

Verified: 23 new tests (152 total, up from 129 across MS1-6), including a
full HTTP integration pass (login → `/time`/`/cresearch` → `/queue list`/
`priority`/`move`/`cancel` → `/mode ai`/`/pause`/`/resume`/`/stop`/
`/takeover` against the real `deviceLease` singleton) and manual verification
against the real running relay via curl: a `/time` command immediately
dispatched to the only idle mock device, `/queue cancel` released it, and
the audit trail correctly captured the full sequence.

**Follow-up (still same day):** `/device health [id]` and `/audit
[device|operator] [limit]` — both listed in `docs/CODING_ROADMAP.md` §1.1 as
"anticipated future commands," nominally "built at MS4" — had never actually
been added to the console, because no console existed until this milestone.
Added now that MS7 gives them somewhere to live: both are read-only
oversight, so (matching the pre-existing `GET /api/audit` route and the WS
device-list message, neither of which restrict visibility by RBAC) neither
is device-RBAC-gated, unlike every command above that actually acts on a
device. 8 more tests (160 total), verified against the live dev server via
curl.

---

## MS6.3 — Dedicated AI-console UI (built after MS7)

**Status: ✅ Done.** Deferred at MS6 because nothing could reach AI mode
except a direct WS message; built now that MS7's queue gives a device
something real to be doing.

What's implemented, in [client/app.js](../system/client/app.js) and
[style.css](../system/client/style.css):

- **MS6.3.1 status pane**: for admins, any device not in `HUMAN` mode shows
  current task/audit context. VAs see only the coarse controller mode and an
  admin-handoff message; they do not query the admin-only queue/audit APIs.
- **MS6.3.2 AI controls**: admins receive explicit pause/resume, stop-task,
  graceful takeover, and emergency-stop controls. Direct WebSocket
  `switch_to_ai`/`takeover`/`emergency_stop` is also admin-protected, so this
  is not merely hidden-button security.

**Two real bugs found and fixed while wiring this up, neither of them UI
bugs:**

1. **A genuine zombie-task bug in `emergency_stop` itself.** The WS handler
   called `deviceLease.emergencyStop()` directly, bypassing the task queue
   entirely — a `RUNNING` task would keep believing it held the device even
   after `emergency_stop` forced the mode back to `HUMAN` underneath it,
   permanently blocking that device from ever being dispatched to again.
   This is the exact same class of bug the `takeover` WS handler was already
   fixed for during MS7 — `emergency_stop` just hadn't been touched since.
   Fixed with a new `taskQueue.emergencyStopDevice()` (mirrors `stopDevice`,
   but ends in `HUMAN` via `deviceLease.emergencyStop()` instead of
   `AI_IDLE`, and — critically — stays synchronous, since the entire point of
   an emergency stop is never waiting on a stuck action).
2. **Dispatching a task never told anyone watching the device list.**
   `broadcastDeviceList()` was only ever called from inside WS message
   handlers — a task dispatching via the command console, the background
   queue tick, or (eventually) MS8's real worker calling back never reached
   a connected browser at all. Fixed by having `taskQueue` emit
   `dispatched`/`completed` events that `index.js` listens for, plus
   explicit broadcasts on the command-console cases (`mode`, `ai_pause`,
   `ai_resume`, `ai_stop`, `ai_takeover`) that change device state without
   going through those two events. Caught live, not by inspection: the
   status pane rendered "Task: none queued" for a device that was
   genuinely running one, until this was fixed.

**A third bug, unrelated to the UI itself, surfaced by testing the above:**
building this pane was the first code path in the whole app to fire two
concurrent authenticated requests for the same session (`Promise.all` over
`/api/queue` and `/api/audit`) — which exposed a real race in
[fileSessionStore.js](../system/server/src/fileSessionStore.js): `fs.writeFile`
is not atomic, so a `get()` landing mid-write could read a torn/empty file
and come back as "no session," a spurious 401 for a perfectly valid,
logged-in operator. Reproduced live in the browser (intermittent 401s on
`/api/queue`/`/api/audit`) before being root-caused. Fixed with a
temp-file-then-`rename()` write, which on Windows needed a further fix: NTFS
can transiently refuse to rename onto a file another handle has open (the
very `get()` racing it), so the rename retries a few times with a short
backoff rather than failing outright — a genuine OS-level lock that clears
itself almost immediately, not a real error.

Verified: 7 more tests (167 total) — `emergencyStopDevice` unit tests
(including one proving it never awaits a registered-but-never-resolving
pending action), a WS integration test proving a real `RUNNING` task ends
up `CANCELLED` after `emergency_stop` and the device dispatches cleanly
again afterward, a WS integration test proving an HTTP-dispatched task
reaches a connected client with no WS action of its own, and a
concurrency-stress regression test for the session-store race (100 rounds
of a `set()` racing 8 concurrent `get()`s, none ever allowed to see `null`).
Manual pass: live in the browser, dispatched a task via the command console,
watched the status pane render it correctly, hit STOP AI / TAKE OVER,
confirmed the device returned to plain `idle` with no AI-status residue,
and confirmed a fresh task immediately dispatched to it again cleanly.

**Fourth bug, found the next day during a dedicated tech-debt pass, in this
same feature:** `client/app.js`'s WS `error` handler only ever surfaced a
message when its `deviceId` matched `pendingDeviceId` or `currentDeviceId` —
both `null` for an operator who's watching but hasn't selected the AI-mode
device the STOP AI / TAKE OVER button is attached to. An `emergency_stop`
that failed (unknown device, RBAC denial) matched neither, so the error was
silently dropped — clicking a control COMMAND_QUEUE_SPEC.md §9 explicitly
calls "high-priority" gave zero feedback on failure. Fixed with a fallback
branch that surfaces any otherwise-unmatched error via the existing
`select-error` element. No automated coverage — this project's test suite is
server-only (`node --test` over `server/`), with no client-side test
infrastructure; verified live instead, by sending a raw `emergency_stop` for
an unknown device and confirming the message now renders where it silently
vanished before.

---

## MS8 — AI VA read-only research mode

**Status: 🟡 The software path is complete and locally tested. Activation and
the supervised live-device acceptance gate remain.**

- `modelProvider.js`, `anthropicProvider.js`, and
  `openAiCompatibleProvider.js` provide the vendor-independent contract and
  configured adapters. `modelSelection.js` persists `/model set` overrides
  at task, device, workspace, or global scope. The runner resolves this choice
  before every decision, so an operator can switch a running task safely.
- `observationPackage.js` prefers WDA accessibility source and falls back to
  validated PNG/JPEG/WebP images. `actionPolicy.js` permits only configured
  MS8 observation/navigation actions and continues to reject all MS9/MS10
  platform-visible actions.
- Versioned accessibility profiles now exist for Instagram, Reddit, and X.
  They detect supported read-only screens, restrict challenges to passive
  observation, execute through the shared Device API, and verify from a fresh
  observation. A regression test prevents the short X app name from matching
  generic `XCUIElementType*` nodes.
- `/cresearch <platform> [account-id] <minutes> <goal>` resolves exactly one
  configured account authorized for the current operator. Missing, mismatched,
  unauthorized, and ambiguous selections fail closed.
- `researchTaskRunner.js` is subscribed before startup dispatch. It executes
  bounded steps through the real queue/lease path, rechecks live account and
  lease authorization, handles retry and takeover states, and prevents restart
  or immediate-retry dispatch races from leaving zombie `RUNNING` tasks.
- Verified model discoveries create a durable run, append deduplicated
  `ContentCandidate` records, checkpoint task progress, and persist locally
  captured image evidence behind the same workspace/account authorization as
  the review API. Successful completion replaces the provisional overview with
  the final provider summary and records the outcome/completion time. The model
  cannot inject an arbitrary evidence reference.

The shipped `research.config.json`, `models.config.json`, and
`platform-skills.config.json` are empty. This is intentional: no real customer
account, provider credential, installed app version, or device was assumed.
MS8 becomes complete only after those values are supplied locally and the
scripted multi-step/provider test plus supervised read-only run pass on a real
iPhone. No live vendor call or platform action has been claimed.

---

## MS9 – MS13

**Status: ✅ Built and passing local tests (2026-09-19); not exercised on a real device.** The details are in
the 2026-09-19 entry at the top of this file. Where the code lives:

- MS9 — `stateToggle.js` (verify-before-toggle), `platformSkills/toggleActions.js`, `platformSkill.js`
  (re-observe), `researchStore.js` (`locateCandidate`, `recordPlatformAction`).
- MS10 — `actionCatalog.js`, `actionPolicy.js` (validator), `policyStore.js`, `approvalStore.js`,
  `commentGuard.js`, `commentTemplates.js`, `researchWorker.js`; API under `/api/research/:account/`
  (`policies`, `templates`, `approvals`).
- MS11 — `researchSession.js` (budgets, quotas, scoring, reports), `researchTaskRunner.js`.
- MS12 — `fleetPolicy.js`, `interventionQueue.js`, `researchAccess.js` (device affinity); API
  `/api/fleet/ai`, `/api/fleet/interventions`.
- MS13 — `optimization/` (`stateCache.js`, `screenClassifier.js`, `modelRouter.js`, `adaptivePacing.js`,
  `researchIndex.js`, `interventionAnalytics.js`), `optimizationRuntime.js` (opt-in wiring),
  `server/bench/` (regression benchmark), API `/api/research/:account/search` and `/api/fleet/analytics`.

Gaps that remain: see "Not verified" in the 2026-09-19 entry. The blocking dependency on the supervised MS8
device run still applies before any platform-visible action is enabled for a real account.

---

## Built, but not cleanly captured by any single milestone

Three things worth flagging so they don't get overlooked or accidentally
rebuilt:

1. **File transfer is fully implemented** — `fileStore.js` plus the four
   `/api/devices/:deviceId/files*` routes (list/upload/download/delete),
   already hardened against path traversal and unsafe filenames. This
   satisfies `CLAUDE.md` §3's "controlled media transfer" requirement for
   Human VA Pilot V1. It predates this roadmap entirely (it's in Section 0's
   "already working" baseline), which is why it doesn't have its own `MS#` —
   it's only referenced going forward, in MS3.2.3, as something that still
   needs authorization enforced on top of it. Don't mistake "no milestone
   number" for "not done."

2. **`WdaDevice.tapVerified()`** ([wdaDevice.js:78-91](../system/server/src/wdaDevice.js))
   is a fully-written retry-with-verification wrapper around `tap()` — but
   nothing calls it; `index.js` calls `.tap()` directly. It's dead code today.
   Its retry/verify shape is the closest existing thing in the codebase to
   MS9's "verify-before-toggle idempotency" pattern — worth reusing there (or
   in MS2.2's reliability work) instead of writing new retry logic from
   scratch.

3. **Naming drift to resolve, not urgent:** the HTTP route is
   `/api/research/...` while the roadmap's operator command is being
   standardized on `/cresearch` (MS7.1.4). Worth a deliberate decision later
   on whether the route gets renamed to match, rather than accidentally
   ending up with two different names for the same concept.

---

## Suggested next action

**All three originally-requested priorities are now done**: #1 (fleet UI),
#2 (VA/admin role split), and #3 (research review panel + full
`ContentCandidate` schema, plus MS3.3's ownership-model decision that #3
depended on) — all built, tested, and reflected above. 354/354 tests passing.

What's actually left, in rough priority order:

- **Physical/device-isolation track:** wait for client approval and
  reachability notes before making proxy/eSIM-specific code assumptions. The
  repo's Phase-0 egress assignment/verifier remains available and complete;
  the real SE pilot, receipt, leak evidence, and Mac-reachability proof are
  hardware work, out of scope until hardware/approval exists.
- **MS5** remains hardware-dependent: one real-iPhone bench pass, latency
  baseline, then 2- and 5-device soak tests.
- **Configure the first MS8 platform** with its actual installed app version,
  managed account, action policy, and model provider. The Instagram, Reddit,
  and X profiles already exist but have not been accepted against a real app.
- **Run the supervised MS8 gate** on the connected iPhone: multi-step read-only
  navigation, provider decision, candidate/evidence persistence, challenge
  handoff, and human takeover. Keep MS9 actions disabled until this passes.
- **Finish the research pipeline and provider controls:** create candidates
  only after verified discoveries, add `/model set`/per-task selection, then
  run the scripted multi-step test against both provider adapters.
- **Run the supervised real-device MS8 gate** only after the device, research
  account and vendor credential are approved and configured.

The first git commit is still pending because project rules require explicit
user approval before committing.
