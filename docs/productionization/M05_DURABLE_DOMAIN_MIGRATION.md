# M05 — Durable Domain Migration (part 1: sites · part 2: approvals · part 3: interventions · part 4: assignments · part 5: account notifications · part 6: task queue snapshot · part 7: audit events · part 8: proxy pool · part 9: research runs · part 10: account policies)

Status: **PASS, TEN DOMAINS ONLY** — PostgreSQL-backed repositories exist for sites, approvals, interventions,
assignments, account notifications, the task queue snapshot, audit events, the proxy pool, research runs, and
account policies; each satisfies its existing file-backed contract exactly, and each is now covered by a
real-PostgreSQL parity + tenant-isolation test that has actually **run and passed against a real database**
(see [P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md) — that pass found and fixed 5 real
bugs across these domains' own tests/adapters, plus a systemic RLS defect affecting all of them). Not yet
re-confirmed against CI's own separate service container. **The running server still uses the file-backed
adapters exclusively for everything.** Nothing in `system/server/src/index.js` was changed; no real data has
been migrated; this milestone is the "new implementation behind interface" step of DATABASE_GAP_ANALYSIS.md's
own migration principle, not the cutover step.

Part 9 closed out every domain that fit the migration pattern as a thin query-per-call mirror. Part 10
(account policies) needed one more piece of shared infrastructure first — a synchronously-readable cache
(`server/src/syncCache.js`) — because unlike every domain before it, its read path is called inline from a
never-awaited hot path (see part 10's own section below). That same infrastructure directly unblocks
background authorization, the other domain this document previously flagged as needing exactly this design.

**A note on domain order:** the master prompt's own suggested M05 order is sites, devices, assignments,
leases, .... This document picks approvals next instead of devices, and explains why in its own section below
— repository inspection found a real complexity mismatch, not an arbitrary reordering.

Baseline: [M00_BASELINE.md](M00_BASELINE.md)
Precondition: [M04_ORGANIZATION_IDENTITY.md](M04_ORGANIZATION_IDENTITY.md)

## Owner decision this milestone depends on

The master prompt's fleet schema requires every site to belong to an `organization_id`, but M04's cloud
identity system is separate, parallel infrastructure — nothing connects it to the existing single-tenant site/
device data. **Asked directly rather than guessed:** should the existing deployment map onto one auto-created
default organization, or stay tenant-less until a real second tenant exists? Answer received: **wrap the
existing deployment in one default organization.** This is recorded here because it materially shapes every
subsequent M05 domain, not just sites — every future domain's Postgres adapter should follow the same pattern
this document establishes.

## What was built

### Default organization bootstrap

`system/server/src/db/defaultOrganization.js` — `ensureDefaultOrganization(pool, { slug, displayName })`.
Idempotent (`INSERT ... ON CONFLICT (slug) DO UPDATE ... RETURNING *`, not a check-then-insert, so two
processes racing to bootstrap a fresh database can't both succeed at inserting and hit a duplicate-slug
error). Deliberately **not a migration** — a migration runs once per schema version across potentially many
installs/environments; "does *this* install have its default organization row yet" is a per-runtime bootstrap
concern, handled at construction time by whichever repository needs it.

### fleet.sites (first M05 migration)

`system/server/migrations/1758842100000_fleet-sites.js` — a `fleet` schema and `fleet.sites` table mirroring
the existing file-backed `SiteStore`'s exact fields (`system/server/src/siteStore.js`) plus `organization_id
uuid NOT NULL`. Site identity and its hashed enrollment token stay combined in one table — matching the M03
disagreement already recorded for the identity schema (a `sites`/`site_credentials` split is a later
migration-design decision, not something this slice changes). The site id itself is the primary key (a
human-chosen slug like `"downtown-office"`, exactly as `SiteStore` uses it today), not a fresh UUID, so no
translation layer sits between the existing repository contract and this table. Row-Level Security, same
pattern as every identity-schema tenant-scoped table.

### PostgreSQL site repository

`system/server/src/db/repositories/postgresSiteRepository.js` — `createPostgresSiteRepository(pool, options)`
(async, unlike `createFileSiteRepository` — it resolves/caches the default organization once at construction)
satisfies `persistence/siteRepository.js`'s exact contract: `list`, `get`, `create`, `rotate`, `update`,
`remove`, `verifyToken`, `markSeen`. Reuses `SiteStore`'s own `SiteError` class and error codes
(`duplicate_site`, `unknown_site`) so a caller doesn't need to special-case which adapter is active — that
interchangeability is the entire point of the M02 repository-contract slice this builds on. Every operation
runs inside `withTransaction(pool, fn, { organizationId })`, scoped to the single default organization this
install has.

**Deliberately out of scope:** this adapter does not yet support more than one organization owning sites —
that is real multi-tenant fleet management (a site-registration UI/API that lets a *new* cloud customer create
their own sites), separate follow-on work once there is an actual second tenant to build it for. Right now,
every site any caller creates lands in the one default organization, matching the owner decision above.

### Tests (sites)

- `system/server/test/unit/db/defaultOrganization.test.js` — 2 tests against a fake pool: the upsert SQL shape
  and parameters, including an overridden slug/displayName.
- `system/server/test/integration/db/postgresSiteRepository.test.js` — real PostgreSQL:
  - **Parity with the file-backed contract**: create/list/get, duplicate-id rejection with the identical
    `SiteError`/`duplicate_site` the file adapter throws, token verification (real token accepted; wrong,
    `null`, and malformed-prefix tokens all rejected), rotate invalidates the old token and issues a working
    new one, `markSeen`/`update` behave as expected, `rotate`/`update` on an unknown id throw
    `SiteError`/`unknown_site`, `remove` deletes the row and returns `false` (not an error) when called again.
  - **Default-organization behavior**: every site created lands under the one default organization; a second
    `createPostgresSiteRepository()` call doesn't create a second default org row (bootstrap idempotency,
    exercised against a real database, not just the mocked unit test).
  - **Real tenant isolation on `fleet.sites`**, through a genuine non-superuser role (RLS does not apply to
    superusers, so testing through the CI Postgres service's default connection would prove nothing): a
    *different* organization's transaction context cannot see the default organization's site at all.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) as the eighth
  PostgreSQL CI step.

### Why approvals, not devices, is the second domain

Repository inspection before starting devices found a real complexity/suitability mismatch, not just personal
preference: `system/server/src/deviceRegistry.js` is a 77-line *pure transform* (`loadDevices(raw,
discoveries)`), not a stateful CRUD-able store like `SiteStore`. Device state is deeply live — connection
status, capabilities, and health are reconstructed from actual USB/WDA discovery on every restart and mutated
continuously at runtime; `devices.config.json` only persists static configuration overrides for manually-pinned
hardware-validation scenarios. Forcing that into a Postgres CRUD contract right now, matching this session's
established "swap the persistence adapter behind an unchanged contract" pattern, would misrepresent what's
actually happening (nothing here is really "durable domain data" in the sense sites/approvals are) and risks
producing something that looks proven but isn't representative of the real system. `approvalStore.js`, by
contrast, is exactly the same shape as `SiteStore` was: a small, self-contained, already-tested class with a
stable, already-defined M02 repository contract — a better-fitting next domain, per the master prompt's own
"follow this order unless repository inspection proves a dependency requires adjustment."

### automation.approvals (second M05 migration)

`system/server/migrations/1758843000000_automation-approvals.js` mirrors the file-backed `ApprovalStore`'s
exact fields (`system/server/src/approvalStore.js`) plus `organization_id`. Two shape decisions worth recording
explicitly rather than leaving implicit in the SQL:

- `requested_at`/`expires_at`/`decided_at`/`consumed_at` are `bigint` (epoch milliseconds), **not**
  `timestamptz` — deliberately matching the file store's `Date.now()`-based numeric timestamps exactly, so the
  adapter returns identically-typed values (a `timestamptz` column would come back as a `Date`/string via the
  `pg` driver, silently changing the contract's return shape for any caller comparing these against
  `Date.now()`).
- `workspace_id` is the existing research-workspace slug (e.g. `"client-a"`) — a different, older tenant-like
  boundary than `organization_id`, preserved as plain text and *not* conflated with the new organization model,
  matching the same "preserve existing business-key semantics, add organization_id purely for this milestone's
  RLS layer" decision already applied to sites' human-chosen ids.

### PostgreSQL approval repository

`system/server/src/db/repositories/postgresApprovalRepository.js` satisfies `persistence/approvalRepository.js`'s
exact contract (`request`, `decide`, `findApproved`, `consume`, `get`, `list`), reusing `ApprovalStore`'s own
`ApprovalError` class/codes (`unknown_approval`/`not_pending`/`bad_decision`) and its exported
`approvalFingerprint()`/`APPROVAL_STATES` rather than reimplementing either. Replicates the file store's
lazy-expire-on-every-operation semantics exactly: every method runs an `UPDATE ... SET state = 'EXPIRED' WHERE
state IN ('PENDING','APPROVED') AND expires_at < now` before doing its own work, so a `get()`/`list()`/`decide()`
against a stale approval sees it as `EXPIRED`, never as still-`PENDING`.

### Tests (approvals)

- `system/server/test/integration/db/postgresApprovalRepository.test.js` — real PostgreSQL: fingerprint
  deduplication (asking twice returns the same open approval, not a duplicate row); approving grants a fresh
  expiry window and `findApproved()`/`consume()` work correctly, with a second `consume()` returning `null`
  rather than consuming again; deciding an already-decided approval, an unknown id, and a bad decision value
  each throw the identical `ApprovalError` code the file store throws; a `PENDING` approval past its expiry is
  lazily marked `EXPIRED` on the very next read rather than silently disappearing, and can no longer be decided;
  `list()` filters correctly by `workspaceId` and `state`; every approval belongs to the single default
  organization; real tenant isolation through a non-superuser role, matching the sites test's pattern.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) as the ninth
  PostgreSQL CI step.

### automation.interventions and PostgreSQL intervention repository (third domain)

Same shape and reasoning as approvals — `InterventionQueue` is exactly the same kind of small, self-contained,
already-tested class. `system/server/migrations/1758843900000_automation-interventions.js` mirrors its exact
fields plus `organization_id`; `system/server/src/db/repositories/postgresInterventionRepository.js` satisfies
`persistence/interventionRepository.js`'s contract (`open`, `claim`, `resolve`, `resolveForTask`, `list`,
`counts`), reusing the file store's own `classifyIntervention()` rather than reimplementing the
reason-to-kind heuristic, and throwing the identical plain `Error` messages the file store throws (unlike
approvals/sites, `InterventionQueue` has no custom error class — parity means matching that, not adding one).

**One deliberate non-parity decision, recorded rather than silently applied:** this adapter does **not**
replicate `InterventionQueue`'s own `_trim()` (capping `RESOLVED` items at `maxResolved` to bound JSON file
size) — a database table doesn't have the unbounded-file-growth problem that existed only because of the old
storage format. Retention/pruning here is a policy decision for later
(DATABASE_GAP_ANALYSIS.md's own "audit retention/anonymization as policy, not unrestricted cascade deletion"),
not something to force into parity with a workaround that no longer applies.

### automation.assignments and PostgreSQL assignment repository (fourth domain)

`system/server/migrations/1758844800000_automation-assignments.js` creates
`automation.assignments`, mirroring the file-backed `assignmentStore.js`
exactly plus `organization_id`. Deliberate decisions, each recorded in the
migration's own header comment:

- `assignee`/`created_by` are plain `text`, not a foreign key to
  `identity.users` — same precedent as approvals'/interventions' actor
  fields, since assignments are tied to the file-backed `authStore.js`
  operator system today, and reconciling that with M04's user model is a
  separate decision this slice does not force.
- `start_at`/`end_at`/`created_at`/`updated_at`/`last_completed_at` are real
  `timestamptz` columns (unlike approvals'/interventions' bigint epoch-ms
  choice), because the file contract already returns ISO strings for these
  fields. `postgresAssignmentRepository.js`'s `toAssignment()` row mapper
  explicitly re-serializes every timestamptz value back to an ISO string via
  an `iso()` helper, so callers see exactly what the file store returned
  rather than a silently-changed field type.
- `recurrence`/`status` are `CHECK`-constrained to the same enums the file
  store enforces in application code.
- An `assignments_overlap_scan_idx` partial index
  (`WHERE exclusive AND start_at IS NOT NULL`) supports the overlap-conflict
  scan without indexing rows that can never participate in one.

`system/server/src/db/repositories/postgresAssignmentRepository.js`
implements all 8 contract methods (`list`, `get`, `create`, `setStatus`,
`reassign`, `renamePrincipal`, `reschedule`, `expireDue`), reusing
`zonedRecurrence.js`'s `advanceRecurringWindow()`/`validTimeZone()` unchanged
so recurrence math is identical to the file store's, and replicating the
file store's un-exported `schedule()` validation and `assertNoOverlap()`
conflict check.

**Bug found and fixed during implementation, before any test caught it:**
`expireDue()` processes every due assignment in one tick and must decide,
for each recurring assignment being advanced, whether its *new* window
conflicts with any other assignment. The file store's real semantics are
subtle: `assertNoOverlap` closes over the pre-tick `assignments` array,
which is never reassigned until every row in the batch has been mapped —
so within one `expireDue()` tick, every overlap check sees the same frozen
pre-tick snapshot, never a sibling row that was already advanced earlier in
the same tick. My first draft used a live DB query per row inside the loop,
which — because all rows shared one transaction — would let an earlier
row's UPDATE become visible to a later row's overlap check, silently
diverging from the file store's frozen-snapshot behavior under recurring
assignments that collide with each other. Fixed by fetching one snapshot
query at the start of `expireDue()` and checking candidates against that
static in-memory array (`findOverlapInSnapshot()`) instead of re-querying
the table mid-loop.

### Tests (interventions)

- `system/server/test/integration/db/postgresInterventionRepository.test.js` — real PostgreSQL: `open()`
  deduplicates on task+kind (auto-classifying `kind` from `reason` via the reused `classifyIntervention()`
  when not given explicitly); `claim()` then `resolve()` transitions correctly, and a second claim by a
  *different* claimant is rejected with the identical message the file store throws; `resolve()` on an
  already-resolved item is a no-op that doesn't overwrite who resolved it first; `claim()`/`resolve()` on an
  unknown id throw the identical `"Unknown intervention."` message; `resolveForTask()` closes every open item
  for a task in one call; `list()` filters by state and workspace; every intervention belongs to the single
  default organization; real tenant isolation through a non-superuser role.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) as the tenth
  PostgreSQL CI step.

Local verification: 2 new mocked unit tests (defaultOrganization, from the sites work) passed; all three
real-PostgreSQL test files confirmed to skip cleanly (not silently pass) without `TEST_DATABASE_URL`;
`node --check` passed on every new file.

### Tests (assignments)

- `system/server/test/integration/db/postgresAssignmentRepository.test.js` — real PostgreSQL:
  `create()`/`list()`/`get()` including the initial history entry; overlap rejection for two exclusive
  assignments on the same device with intersecting windows, and confirmation that non-overlapping windows
  succeed; `setStatus()` enforces the same state-machine transitions the file store enforces and appends
  history; a recurring assignment's `setStatus('completed')` advances the window (new `startAt`, `occurrence`
  incremented, a `recurrence_completed` history action); `reassign()` (changes assignee, resets to
  `"assigned"`, rejected for terminal assignments); `renamePrincipal()` (renames both `assignee` and
  `createdBy` matches, returns only the rows actually changed, leaves unrelated assignments untouched);
  `reschedule()` (updates the window, rejected for terminal assignments); `expireDue()` for plain
  (non-recurring) expiry; and — specifically to prove the frozen-snapshot fix below — an `expireDue()` case
  that constructs a second "blocker" assignment on the same device whose window collides with the recurring
  assignment's *advanced* window but not its current one, asserting the advance is skipped and the window is
  left untouched rather than silently overlapping; tenant scoping to the default organization; real tenant
  isolation through a non-superuser role.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) as the
  eleventh PostgreSQL CI step.

**Two bugs found and fixed while writing this slice, as a concrete instance of "check for errors, fix, check
again" rather than a one-shot implementation:**

1. The `expireDue()` frozen-snapshot divergence described above — found by re-reading the file store's
   closure semantics line by line against my first Postgres draft, not by a failing test (there is no local
   database to run the real test against).
2. The test's own first draft of the conflict-isolation assertion was tautological —
   `assert.equal(advanced.status, "in_progress" === advanced.status ? advanced.status : advanced.status, ...)`
   — which passes regardless of the actual value and would never have caught a regression. Found on a
   re-read of the test file for correctness, not by CI (which cannot run locally). Replaced with real
   assertions on the exact expected `status` and `startAt`.

Local verification: `node --check` passed on both new files; the real-PostgreSQL test file confirmed to skip
cleanly (not silently pass) without `TEST_DATABASE_URL`; full local `node --test` suite re-run after this
domain was added: 143 files, 1286 tests, 1274 passed, 0 failed, 12 skipped (skips are exactly the
real-PostgreSQL-only test files, expected with no local PostgreSQL).

### automation.account_notifications and PostgreSQL notification repository (fifth domain)

**A discovery, not just a build:** this domain revealed that `system/server/src/persistence/` already contains
a *formalized* M02 repository-port layer — `assertXRepository()` contracts plus `fileXRepository.js` adapters —
for far more domains than this document had previously tracked, including notifications, research evidence,
research runs, task queue snapshots, proxy pool, device media, background authorization, operator identity,
operator accounts, and audit events. `index.js` already calls `createFileNotificationRepository(...)` rather
than constructing `accountNotificationStore` directly — the M02 groundwork for this domain (and several others
below) was already complete before this slice began; only the Postgres side was missing. This changes the
"Next steps" list below: several of the master prompt's remaining M05 domains are Postgres-adapter-only work
now, not also new M02 contract design.

`system/server/migrations/1758845700000_automation-account-notifications.js` creates
`automation.account_notifications`, mirroring `accountNotificationStore.js`'s exact fields plus
`organization_id`. Deliberate decisions:

- `to_email`/`from_email` are plain text, not `identity.users` FKs — the recipient is frequently a
  not-yet-created applicant, not an existing platform user.
- `body` and `secure_payload` are mutually exclusive columns, enforced by a `CHECK` constraint tied to `kind`:
  a `account_recovery` notification's body is AES-256-GCM ciphertext (`secure_payload` jsonb: algorithm/iv/
  tag/ciphertext) and `body` must be `NULL`; every other kind has a plaintext `body` and `secure_payload` must
  be `NULL`. This keeps the file store's "recovery bodies are never at rest in plaintext" guarantee expressed
  in the schema itself, not just in application code.
- The encryption/decryption logic itself was **not duplicated**. `accountNotificationStore.js`'s
  `encryptBody`/`decryptBody` closures were extracted into exported, key-parameterized functions
  (`encryptNotificationBody`/`decryptNotificationBody`), and both the file store and the new
  `postgresNotificationRepository.js` import the same implementation — a deliberate choice to avoid two
  independent copies of security-sensitive AES-GCM handling ever drifting apart. The file store's own
  behavior was re-verified unchanged after this refactor (same unit tests, same results).
- `markCommitted`/`markAborted`/`markSent`/`markFailed` replicate the file store's "only advance a state that
  hasn't already moved on" guard exactly: a `SELECT` inside the transaction decides whether the precondition
  state still holds before the `UPDATE`, and an item already past that state is returned unchanged rather than
  clobbered — matching `accountNotificationStore.js`'s `setCommitState`/`setDeliveryOutcome` semantics, which
  exist so a late retry can never overwrite a more-recent outcome.
- `canSecureRecovery()` stays a pure, synchronous capability check (no DB round trip) — same as the file
  store, since it only reports whether an encryption key was configured at construction time.

### Tests (account notifications)

- `system/server/test/integration/db/postgresNotificationRepository.test.js` — real PostgreSQL: acceptance/
  rejection notifications queue with the correct subject/body/kind and list in descending `createdAt` order;
  `holdForCommit` notifications stay `pending_account_commit` until `markCommitted`/`markAborted`, and
  committing/aborting twice is a no-op that doesn't change an already-advanced state; `markSent`/`markFailed`
  only advance a currently-`queued` item and leave a `sent` item alone on a later `markFailed` call; `mark*()`
  on an unknown id returns `null`; a recovery notification's row has `body IS NULL` and an AES-256-GCM
  `secure_payload` at rest, and only `deliveryContent()` ever returns the decrypted token;
  `canSecureRecovery()` reflects the configured key with no query, and queuing a recovery notification without
  a key throws the identical message the file store throws; every notification belongs to the single default
  organization; real tenant isolation through a non-superuser role.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) as the
  twelfth PostgreSQL CI step.

Local verification: `node --check` passed on every new/modified file; the refactored
`accountNotificationStore.js` was re-run against its existing unit test
(`test/unit/notificationRepository.test.js`) to confirm the extraction changed nothing observable; the new
real-PostgreSQL test file confirmed to skip cleanly (not silently pass) without `TEST_DATABASE_URL`; full
local `node --test` suite re-run after this domain was added: **144 files, 1287 tests, 1274 passed, 0 failed,
13 skipped** (skips are exactly the real-PostgreSQL-only test files, expected with no local PostgreSQL).

### automation.task_queue_snapshots and PostgreSQL task queue snapshot repository (sixth domain)

The simplest port so far — only `load()`/`save()` — but this is the domain the master prompt's own command-
queue requirement 7 names directly ("queue state survives process restarts", `CLAUDE.md` §7). The port's own
header comment is explicit that the queue's scheduling/eligibility/dispatch/retry/checkpoint mechanics
(docs/COMMAND_QUEUE_SPEC.md §3,6-9,14) stay in `taskQueue.js` as domain logic and never move behind this
port — only the snapshot read/write boundary does. That framing carries directly into the schema: the
snapshot is stored as a single opaque `jsonb` blob per organization
(`automation.task_queue_snapshots(organization_id PRIMARY KEY, payload, updated_at)`), not normalized into
per-task rows or columns. Normalizing 13 task states into relational columns here would duplicate
`taskQueue.js`'s own domain logic in SQL for no parity benefit; a snapshot blob is the accurate schema for a
snapshot, and it makes the adapter itself almost entirely storage plumbing.

**The one piece of real logic — legacy-format migration and crash recovery — was extracted, not duplicated.**
`fileTaskQueueSnapshotRepository.js`'s `load()` used to inline: bare-array legacy migration, backfilling
fields absent from older snapshots (`kind`, `maxDurationSec`, `retryNotBefore`), normalizing retry policies,
and recovering any task still `RUNNING`/`DISPATCHED` when the process died (requeuing it within its retry
policy, or marking it `FAILED_FINAL`, per `docs/COMMAND_QUEUE_SPEC.md` §10). This logic is storage-agnostic —
it operates on whatever was decoded from storage, regardless of whether that came from a file or a database
row — so it was pulled out into an exported pure function, `normalizeQueueSnapshot()`, in
`persistence/taskQueueSnapshotRepository.js` itself (the contract module). Both `fileTaskQueueSnapshotRepository.js`
and the new `postgresTaskQueueSnapshotRepository.js` call the same function, so crash-recovery/migration
behavior cannot drift between the two backends. The file adapter's own existing unit test
(`test/unit/taskQueueSnapshotRepository.test.js`) was re-run after this extraction and passed unchanged.

`postgresTaskQueueSnapshotRepository.js`'s `save()` is a single `INSERT ... ON CONFLICT (organization_id) DO
UPDATE` (one row per organization, matching the "exactly one snapshot per install" reality); `load()` reads
that row, runs it through `normalizeQueueSnapshot()`, and — matching the file adapter's own behavior of
silently persisting a migrated/recovered snapshot back to disk — writes the result back if anything changed,
so a second `load()` never re-applies recovery to an already-recovered task.

### Tests (task queue snapshot)

- `system/server/test/integration/db/postgresTaskQueueSnapshotRepository.test.js` — real PostgreSQL: an empty
  snapshot before anything is saved; `save()`/`load()` round-trip tasks, `paused`, and `humanHolds` exactly;
  `save()` upserts (one row per organization, not a growing history); a task still `RUNNING` when "the
  process died" is recovered into `QUEUED` (within its retry policy) with an `interrupted_by_restart` result,
  and a second `load()` does not re-apply that recovery; a legacy bare-array payload is migrated to the
  current shape and the migration is persisted, not just returned in memory; the snapshot belongs to the
  single default organization; real tenant isolation through a non-superuser role.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) as the
  thirteenth PostgreSQL CI step.

Local verification: `node --check` passed on every new/modified file; the refactored
`persistence/taskQueueSnapshotRepository.js`/`fileTaskQueueSnapshotRepository.js` were re-run against the
existing unit test to confirm the extraction changed nothing observable; the new real-PostgreSQL test file
confirmed to skip cleanly (not silently pass) without `TEST_DATABASE_URL`; full local `node --test` suite
re-run after this domain was added: **145 files, 1288 tests, 1274 passed, 0 failed, 14 skipped** (skips are
exactly the real-PostgreSQL-only test files, expected with no local PostgreSQL).

### automation.audit_events and PostgreSQL audit event repository (seventh domain)

`system/server/migrations/1758847500000_automation-audit-events.js` creates `automation.audit_events`,
mirroring `auditLog.js`'s exact fields (`id`, `at`, `operator`, `type`, `deviceId`, `detail`) plus
`organization_id`. `operator`/`device_id` stay plain text, not FKs — same precedent as approvals/
interventions/assignments. `detail` is `jsonb`, preserving the file store's guarantee that whatever detail
object a caller passes round-trips exactly; redacting sensitive fields (e.g. never logging actual typed text)
remains the caller's responsibility, not this layer's, exactly as `auditLog.test.js` documents for the file
store. Three indexes support `listEvents()`'s access patterns: `(organization_id, at DESC)` for the
newest-first ordering every call uses, and partial indexes on `operator`/`device_id` for the two filters.

`postgresAuditEventRepository.js` implements both contract methods (`logEvent`, `listEvents`) as thin SQL:
`logEvent` is a single `INSERT ... RETURNING *`; `listEvents` is one `SELECT` with `organization_id` plus
optional `operator`/`device_id` filters, `ORDER BY at DESC`, and a `LIMIT` — the same "filter, newest first,
then cap" semantics as the file store's filter → `reverse()` → `slice(0, limit)` pipeline, just expressed in
SQL instead of in-memory array operations.

### Tests (audit events)

- `system/server/test/integration/db/postgresAuditEventRepository.test.js` — real PostgreSQL: `logEvent()`
  returns the full entry shape and round-trips an arbitrary `detail` object exactly; `listEvents()` returns
  newest first; filtering by `operator` and `deviceId` independently and together; `limit` is respected and
  defaults to 200; an organization with nothing logged yet returns an empty list, not an error; every event
  belongs to the single default organization; real tenant isolation through a non-superuser role.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) as the
  fourteenth PostgreSQL CI step.

Local verification: `node --check` passed on every new file; the new real-PostgreSQL test file confirmed to
skip cleanly (not silently pass) without `TEST_DATABASE_URL`; full local `node --test` suite re-run after
this domain was added: **146 files, 1289 tests, 1274 passed, 0 failed, 15 skipped** (skips are exactly the
real-PostgreSQL-only test files, expected with no local PostgreSQL).

### automation.proxy_pool and PostgreSQL proxy pool repository (eighth domain)

`system/server/migrations/1758848400000_automation-proxy-pool.js` creates `automation.proxy_pool`, mirroring
`proxyPool.js`'s exact fields plus `organization_id`. `id` keeps the file store's own `"px_<uuid>"` text
format rather than switching to a bare `uuid` column, since routes/tests already treat proxy ids as opaque
prefixed strings. `password_encrypted` is `text`, not `jsonb` — `proxyPool.js`'s own AES-256-GCM helper
(`twoFactor.js`'s `encryptTotpSecret`/`decryptTotpSecret`, the same one TOTP secrets use) already serializes
to one delimited `"iv.tag.ciphertext"` string. A partial unique index on `(organization_id,
leased_to_device_id) WHERE leased_to_device_id IS NOT NULL` gives the file store's "a device holds at most
one leased proxy" invariant a real database-level backstop, not just an application-code guarantee.

**Pure transforms were reused, not duplicated**, exactly as `persistence/proxyPoolRepository.js`'s own header
comment prescribes for a future adapter: `publicProxy()` (the credential-free response shape) and
`decryptProxyPassword()` stay direct `proxyPool.js` imports. `validateFields()` was not previously exported —
it was internal to `proxyPool.js` — so it was given an `export` keyword (a pure addition, no behavior change;
its own unit test was re-run and passed unchanged) so the Postgres adapter validates incoming fields
identically instead of re-implementing that validation a second time.

`postgresProxyPoolRepository.js` implements all 8 contract methods. `assignToDevice()` replicates the file
store's exact lease-transfer sequence — find whatever this device currently holds, release it if the target
differs, then lease the target — as ordered `UPDATE`s inside one transaction, so it can never violate the new
unique index by trying to hold both leases at once mid-operation.

### Tests (proxy pool)

- `system/server/test/integration/db/postgresProxyPoolRepository.test.js` — real PostgreSQL: `create()`
  rejects invalid fields with the same message the file store throws, encrypts the password at rest (the
  stored column is never the plaintext), and round-trips through `get()`/`load()`; `assignToDevice()` enforces
  the exclusive lease (a proxy already leased elsewhere is rejected, re-assigning a device to a different
  proxy releases the old one first, releasing with `proxyId: null` clears the lease); `remove()` refuses a
  leased proxy with the identical message and succeeds once released, and removing an already-removed proxy
  is a clean `false`; `updateHealth()` stores only the known-safe fields and drops anything else; `publicList()`
  never exposes host/port/username/password; every proxy belongs to the single default organization; real
  tenant isolation through a non-superuser role.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) as the
  fifteenth PostgreSQL CI step.

Local verification: `node --check` passed on every new/modified file; `proxyPool.js`'s existing unit test
(`test/unit/proxyPoolRepository.test.js`) was re-run after exporting `validateFields()` to confirm nothing
observable changed; the new real-PostgreSQL test file confirmed to skip cleanly (not silently pass) without
`TEST_DATABASE_URL`; full local `node --test` suite re-run after this domain was added: **147 files, 1290
tests, 1274 passed, 0 failed, 16 skipped** (skips are exactly the real-PostgreSQL-only test files, expected
with no local PostgreSQL).

### automation.research_accounts and PostgreSQL research run repository (ninth domain)

Unlike sites/approvals/interventions/assignments/notifications/audit-events, this domain's storage shape is
deliberately **not** normalized into per-run/per-candidate rows. `researchStore.js` keeps one JSON file per
`(workspace, account)`, holding both `runs` (each with its own `candidates` array) and a `candidateIndex`
(two lookup tables, `byContentId`/`byUrl`) that lets a later run recognize the same real-world post it saw
before and carry the human's review decision forward instead of re-surfacing it as "pending." Every operation
in the file store loads that whole unit, mutates it, and writes it back whole — there is no operation that
touches one run or one candidate in isolation from the rest of the account's history. `automation.research_
accounts` mirrors that shape exactly: one row per `(organization_id, workspace_id, account)`, with `payload`
holding `{ runs, candidateIndex }` as a single `jsonb` blob — the same reasoning already applied to the task
queue snapshot, just keyed by workspace+account instead of only by organization.

**The dedup/merge logic itself was reused, not duplicated.** `candidateRecord()`, `findIndexEntry()`,
`upsertIndexEntry()`, `mergeCandidate()`, `indexCandidate()`, `normalizePlatformAction()`, and
`samePlatformAction()` in `researchStore.js` were already pure (data in, data out — no `fs` calls); they only
needed an `export` keyword added, not a rewrite. `postgresResearchRunRepository.js` imports all seven and
calls them in the exact same sequence the file store's own `createRun`/`appendCandidate`/
`recordPlatformAction`/`setCandidateStatus` do — the only thing that changed is swapping `readAccount`/
`writeAccount`'s `fs` calls for a Postgres row read/write (`loadData`/`saveData`), including the same
null-prototype hardening on `byContentId`/`byUrl` (`Object.assign(Object.create(null), ...)`) that protects
against a platform-supplied value like `"__proto__"` becoming prototype access instead of an ordinary key.
This means the cross-run dedup behavior — the most intricate logic in this domain — cannot drift between the
file and Postgres backends, because it is literally the same function calls in both.

`safeAccountId()` (already exported, pure, no `fs`) gates every method exactly as `accountFile()` gated the
file store's: an invalid workspace or account id returns `null` immediately rather than querying anything.

### Tests (research runs)

- `system/server/test/integration/db/postgresResearchRunRepository.test.js` — real PostgreSQL: invalid
  workspace/account returns `null`, not an empty list; `createRun()` stores candidates as `pending` and
  round-trips through `getRun()`/`listRuns()`; `appendCandidate()` merges a second observation of the same
  content into the same candidate rather than creating a duplicate; **a later run re-observing the same post
  carries its prior human review decision forward instead of resetting to pending** (the cross-run dedup
  index's whole purpose); `locateCandidate()` finds content by URL or platform id and never invents one;
  `recordPlatformAction()` mirrors an action into its candidate and a repeat is a no-op, not a duplicate
  entry; `finalizeRun()` requires a non-empty overview and records outcome/`completedAt`; `setCandidateStatus()`
  only accepts `confirmed`/`removed`; every research account belongs to the single default organization; real
  tenant isolation through a non-superuser role.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) as the
  sixteenth PostgreSQL CI step.

Local verification: `node --check` passed on every new/modified file; `researchStore.js`'s existing unit
tests (`test/unit/researchStore.test.js`, `test/unit/researchRunRepository.test.js`,
`test/integration/researchOps.test.js` — 40 tests total) were re-run after exporting the seven pure helper
functions to confirm nothing observable changed; the new real-PostgreSQL test file confirmed to skip cleanly
(not silently pass) without `TEST_DATABASE_URL`; full local `node --test` suite re-run after this domain was
added: **148 files, 1291 tests, 1274 passed, 0 failed, 17 skipped** (skips are exactly the
real-PostgreSQL-only test files, expected with no local PostgreSQL).

### server/src/syncCache.js and PostgreSQL account policy repository (tenth domain)

`index.js` reads policy decisions through a synchronous closure —
`effectiveActionPolicies.get: accountId => policyStore.effective(...).get(accountId)` — fed straight into
`actionPolicy.js`'s `validateAction()`, which calls `accountPolicies?.get(accountId)` inline, never awaited.
That is the exact same "callers need an immediate, non-awaited answer" constraint
`persistence/backgroundAuthorizationRepository.js`'s own header already documents for a different domain. A
Postgres-backed `effective()` that queried the database per call would silently break that hot path the
moment it was wired in for real, even though it would satisfy an M02 contract's method names — this was caught
during design, before any adapter code was written for it, rather than shipping a port that would only break
once actually wired in.

`system/server/src/syncCache.js` (deliberately **not** under `redis/` — its first real backend is Postgres, and
the pattern applies to any durable backend) is the shared infrastructure this needed: an in-memory `Map` that
is the only thing ever read synchronously, loaded in full once at construction, updated immediately on every
local write (before the durable write is even sent, so a reader in the same process never sees a write "go
missing" mid-flight), with an optional periodic poll-based refresh so the process eventually picks up writes
made by another instance. This is deliberately poll-based eventual consistency, not push-based invalidation
(Redis keyspace notifications, Postgres `LISTEN`/`NOTIFY`, or similar) — there is no real multi-instance
deployment in this environment to test push-based invalidation against, so a short poll interval is a
correct, honest, and testable stand-in rather than a more complex mechanism nothing here can actually verify.
A write failure is reported via `onPersistError`, never thrown back into the synchronous `set()`/`delete()`
call — the cache optimistically leads, the backend catches up.

`system/server/migrations/1758850200000_automation-account-policies.js` creates
`automation.account_policies`, an ordinary relational mirror of `PolicyStore`'s override map (`account_id`,
`action`, `value`, `changed_by`, `changed_at`) — the sync-cache constraint shapes the *adapter*, not this
schema. `system/server/src/db/repositories/postgresPolicyRepository.js` loads the whole table into a
`syncCache` at construction; `set()`/`clear()` update the cache synchronously and return the same plain
object/void `PolicyStore.set()`/`clear()` already return (never a Promise, matching the existing contract
exactly) while persisting to Postgres in the background; `effective()`/`describe()` read only from the cache,
reusing `actionPolicy.js`'s own `ACTIONS`/`POLICY_VALUES` for validation rather than duplicating it. A
`refresh()` method is exposed on the returned object beyond the four required contract methods, so a caller
(or a test) can force this process to pick up another instance's write sooner than a configured poll
interval.

`system/server/src/persistence/policyRepository.js` (the M02 port, `assertPolicyRepository`) and
`system/server/src/persistence/filePolicyRepository.js` (wrapping the existing `PolicyStore` unchanged — no
cache needed there, since an in-memory `Map` is already synchronous) were written alongside this, since no
M02 port existed for this domain before now.

### Tests (account policies)

- `system/server/test/unit/policyRepository.test.js` — the M02 contract test: the file adapter satisfies the
  contract and preserves `PolicyStore`'s behavior, including wrapping an already-constructed store for
  injection.
- `system/server/test/unit/syncCache.test.js` — 10 pure unit tests (no Redis/Postgres) covering the cache
  mechanism itself: loading from a Map/array/object, synchronous read-after-write *before* the durable write
  settles, a `persist()` rejection being reported without being thrown back into `set()`, `delete()`,
  `refresh()` picking up a change and a failed `refresh()` preserving the last-known-good snapshot, and timer
  cleanup.
- `system/server/test/integration/db/postgresPolicyRepository.test.js` — real PostgreSQL: `set()` validates
  identically to the file store and returns a plain object, never a Promise; a write is visible to
  `effective()`/`describe()` on the very next line in the same process; `describe()` falls back to a
  configured base policy, then `DISABLED`, when there is no override; `clear()` removes an override
  synchronously; the write actually lands in the `automation.account_policies` table, not only in memory; **a
  separate repository instance (simulating another process) only sees a write after an explicit `refresh()`**
  — proving the documented eventual-consistency boundary is real and observable, not a silently-assumed
  property; tenant scoping; real tenant isolation through a non-superuser role.
- Wired into [`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) as the
  seventeenth PostgreSQL CI step.

Local verification: `node --check` passed on every new file; full local `node --test` suite re-run after this
domain was added: **153 files, 1312 tests, 1293 passed, 0 failed, 19 skipped** (skips are exactly the
real-PostgreSQL/real-Redis-only test files, expected with no local database or Redis).

## Not in this part (still open within M05)

- **Everything is still file-authoritative.** `index.js` was not touched. No dual-read, no cutover, no
  migration-manifest tooling for importing *real* existing `sites.json`/`research-approvals.json`/
  `interventions.json`/notification-store/task-queue-snapshot/audit-log/proxy-pool/research-account/
  policy-override rows into Postgres — this milestone only proves each new adapter *can* replace the old one,
  not that it has.
- **Devices** specifically needs its own design pass before a Postgres adapter makes sense — see "Why
  approvals, not devices" above — not just implementation time.
- **Leases** has no file store to migrate at all (see M02_MODULARIZATION.md) and needs its own design pass,
  not just implementation time.
- **Research evidence and device media are object-storage domains, not a Postgres fit at all** — both
  `persistence/researchEvidenceRepository.js` (screenshot evidence) and
  `persistence/deviceMediaRepository.js` (per-device file transfer) exist to wrap *binary file* storage under
  `MEDIA_ROOT`/an evidence directory, not relational rows. This repo's own accepted direction
  ([ADR-0004](adrs/ADR-0004-object-storage.md): "Object storage for large bytes") already rules out Postgres
  for this data. Migrating these two means building an object-storage adapter (S3/GCS-compatible or
  equivalent) behind the same ports, not the migration-mirrors-a-table pattern every domain above used —
  correctly out of scope for "durable domain migration to PostgreSQL" as this milestone has been executing it.
- **Background authorization (`persistence/backgroundAuthorizationRepository.js`) turned out to be
  identity-reconciliation-gated too, not purely a sync-cache job — caught by reading what its file adapter
  actually reads before writing a Postgres one.** `fileBackgroundAuthorizationRepository.js`'s three methods
  (`getOperatorByUsername`, `canAccessDevice`, `researchWorkspaceFor`) all resolve through `authStore.js`'s own
  in-memory operator registry — the identical data source `persistence/operatorIdentityRepository.js`/
  `persistence/operatorAccountRepository.js` already read, and the same one this document already flagged as
  needing an owner decision on reconciling with `identity.users` before any of it moves to Postgres. The
  `syncCache.js` infrastructure account policies just built is a real, necessary *part* of this domain's
  eventual solution (its own header is explicit about needing exactly that shape of cache) — but it doesn't
  unblock the domain by itself, because there is no decided Postgres-backed operator table yet for the cache
  to load from. This was corrected in this same session before any adapter code was written for it, matching
  the same discipline applied to platform accounts/policies.
- **Operator identity/accounts (`persistence/operatorIdentityRepository.js` +
  `persistence/operatorAccountRepository.js`) are the two halves of the file-backed `authStore.js` operator
  system** (VA login: passwords, MFA, sessions, recovery, account lifecycle) — the same system whose
  `assignee`/`createdBy`/`operator` fields approvals/interventions/assignments/audit-events already store as
  plain text rather than `identity.users` FKs, deliberately deferring reconciliation with M04's identity
  model. Migrating the operator accounts *themselves* to Postgres is a materially bigger decision than
  migrating records that merely reference them by username: it would either entrench a second, permanent,
  parallel identity/credential store next to `identity.users`/`identity.identity_sessions`, or require
  reconciling the two systems outright. That is an owner decision (same weight as the "one default
  organization" decision this document already resolved), not something to default into silently. Flagged
  here rather than attempted.
- **Multi-tenant site/approval/intervention/assignment/notification/task-queue/audit/proxy-pool/research-run/
  policy creation** — a real second organization creating its own records through these adapters isn't wired
  to anything (no route calls any of the new constructors yet; each is proven correct in isolation, not
  integrated).
- **`InterventionQueue`'s `_trim()` behavior has no equivalent yet** — see "one deliberate non-parity decision"
  above; a real retention policy is deferred, not silently decided.

## Next steps toward the rest of M05

1. Every domain still open is genuinely gated on a design or owner decision, not implementation time alone:
   research evidence/device media (object storage — needs an S3/GCS-compatible adapter design), background
   authorization *and* operator identity/accounts (both need the same owner decision on reconciling
   `authStore.js`'s operator registry with `identity.users` — `syncCache.js` is ready the moment that decision
   is made, but the decision itself is the actual blocker). Leases and devices remain in the same category
   from earlier parts of this document.
2. Once several domains have parity adapters, design the actual migration-manifest tooling
   (`migration_run_id`/`source_digest`/counts, per DATABASE_GAP_ANALYSIS.md §16) for importing real file-store
   data — this milestone deliberately did not attempt that yet, since there is no real production data in this
   environment to migrate and rehearse against.
3. The cutover step itself (switching `index.js` to the Postgres adapter for any domain) requires the full
   migration principle checklist DATABASE_GAP_ANALYSIS.md §17 lays out — backup, validation, rollback,
   observation period — appropriate for a real deployment with real data, not something to flip during an
   unattended session.
