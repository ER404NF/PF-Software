# P3 — Move durable data off files, one domain at a time

Status: **PASS WITH KNOWN LIMITATIONS — all 9 domains that have a Postgres adapter now have a working,
tested migration script (steps 1–3); the actual cutover (step 4) is deliberately not flipped for any domain
yet.** Builds on [P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md) and
[P2_REAL_LOGIN_MOUNTED.md](P2_REAL_LOGIN_MOUNTED.md).

Domains done: sites, assignments, platform accounts/policies, task queue/runs/checkpoints, approvals,
interventions, proxy pool, audit, research. Domains skipped (documented gaps, not new decisions):
devices/hosts and leases — neither has a Postgres adapter to migrate to yet (see
`M05_DURABLE_DOMAIN_MIGRATION.md`).

See [`PHASE1_TEAM_ROLLOUT_HANDOUT.md`](PHASE1_TEAM_ROLLOUT_HANDOUT.md) §4 task P3 for the required order and
per-domain steps. Order: sites → devices/hosts → assignments → leases → platform accounts/policies → task
queue/runs/checkpoints → approvals/interventions → research → proxy pool → audit.

## Scope note: devices/hosts is skipped, per existing documentation, not silently

`M05_DURABLE_DOMAIN_MIGRATION.md`'s own "Why approvals, not devices" section already established that the
devices domain needs its own design pass before a Postgres adapter makes sense — no Postgres adapter exists
for it yet. P3 cannot cut over a domain that has no adapter to cut over to. This is a pre-existing, already
-documented gap, not a new decision made here; devices/hosts remains skipped until that design pass happens.

## Domain 1: sites — done through step 2 (migration script), steps 3–4 deliberately deferred

Per-domain steps, and where each stands:

1. **"The Postgres adapter already exists — confirm it against the real database from P1."** Done —
   `postgresSiteRepository.js` has been exercised extensively against the real local PostgreSQL throughout P1
   (`postgresSiteRepository.test.js` passes for real).
2. **"Write a one-time migration that reads the current file store and writes it into Postgres, recording
   before/after row counts."** Done — `system/server/scripts/migrate-sites-to-postgres.js`. Reads the real
   `SiteStore` (reusing its own loading/validation, not a hand-rolled JSON parse), upserts each site into
   `fleet.sites` by id (safe to re-run — never duplicates), and reports before/after counts, exiting non-zero
   if they don't reconcile. Critically, it preserves the **token hash** exactly rather than regenerating a
   fresh token — neither store ever persists the plaintext, so an existing site agent's already-saved token
   must keep verifying against whatever hash migrates, or every site agent would need to be re-enrolled by
   hand the moment this ran for real.
3. **"Run the domain's existing test suite against the real database, not the file store."** Already true —
   `postgresSiteRepository.test.js` already only runs against real PostgreSQL (skips otherwise), same as
   every M05 domain.
4. **"Cut `index.js` over to the Postgres adapter for that domain behind the same flag as P2; keep the file
   store readable as a fallback until you've watched it run correctly for a while, then remove it."**
   **Deliberately not done in this pass.** "Watched it run correctly for a while" is an operational
   observation step nobody can perform without a real, running deployment with real traffic — doing it
   without that would just be flipping a flag and hoping, which is exactly the "no big-bang cutover" safety
   rule (handout §2) this whole task exists to prevent. The wiring itself (an `if` branch in `index.js`
   choosing `createPostgresSiteRepository(pool)` vs. `createFileSiteRepository(path)` behind an env flag,
   mirroring `CLOUD_API_ENABLED`'s own pattern from P2) is small, mechanical follow-on work once there is a
   real environment to watch it in — see "Next steps."

### A real bug found while writing the migration script (again, only visible for real)

**Symptom:** the first real run of the migration script's test threw `null value in column "rotated_at" of
relation "sites" violates not-null constraint`.

**Root cause:** the test's own fixture set `rotatedAt: null` for a site, modeling what seemed like a
plausible "never rotated" state — but `fleet.sites.rotated_at` is `NOT NULL DEFAULT now()`, and the *real*
file store (`siteStore.js`'s `create()`) never actually writes `rotatedAt: null` either — it sets
`rotatedAt: now` (the same value as `createdAt`) at creation time, and only updates it on an explicit
`rotate()`. The column's real semantics are "when the current token was issued," which is always a real
timestamp; "never rotated" is expressed as *equal to created_at*, not absent. The test fixture modeled a
state the real system doesn't produce.

**Fix:** corrected the test fixture to match the real file store's actual invariant (`rotatedAt` initialized
to `createdAt`, never `null`) — *and*, since the file store's own loader (`SiteStore._load()`) doesn't itself
validate that every field is present (only `id` format and `tokenHash`'s type are checked), added a defensive
coalesce in the migration script itself (`rotatedAt = raw.rotatedAt ?? raw.createdAt`) so a genuinely
malformed or hand-edited legacy record doesn't crash the one-time migration either. A dedicated regression
test (a fixture record with `rotatedAt` entirely absent) proves the coalesce, separately from the "realistic
fixture" fix.

### Tests

- `system/server/test/integration/db/migrateSitesToPostgres.test.js` (new): real PostgreSQL — migrates every
  site preserving token hash/name/timezone exactly and counts reconcile; a legacy record missing `rotatedAt`
  is coalesced rather than rejected; an existing site agent's real (pre-migration) plaintext token still
  verifies successfully against the migrated row via `postgresSiteRepository.verifyToken()`; re-running the
  migration is idempotent (no duplicate rows); every migrated site belongs to the single default
  organization.
- Wired into `.github/workflows/db-migrations.yml` as its own CI step.

Local verification: `node --check` passed; full local server suite re-run after this addition: **156 files,
1,516 tests, 1,516 passed, 0 failed, 0 skipped.**

## Domains 2–9: assignments, platform policies, task queue, approvals, interventions, proxy pool, audit, research

Each follows the exact same shape as the sites domain above: a `scripts/migrate-<domain>-to-postgres.js`
script that reuses the real file store's own loading (never a hand-rolled parser), upserts into the existing
M05 Postgres schema preserving every field exactly, reports before/after counts, and is safe to re-run; a
real-PostgreSQL test proving it against a realistic (not real-production — none exists in this environment)
fixture; wiring into `.github/workflows/db-migrations.yml`. None of the 9 domains has had its cutover (step 4)
flipped, for the same reason as sites: that requires a real deployment to watch run correctly for a while
first.

| Domain | Script | Real bug found? |
| --- | --- | --- |
| Sites | `migrate-sites-to-postgres.js` | Yes — `rotated_at` NOT NULL fixture/coalesce (see above) |
| Assignments | `migrate-assignments-to-postgres.js` | None |
| Platform policies | `migrate-policies-to-postgres.js` | None (but hardened: invalid/hand-edited overrides are skipped and reported, not silently crashed on, since `PolicyStore`'s own loader — unlike every other file store — does no validation at all) |
| Task queue | `migrate-task-queue-to-postgres.js` | **Yes — a real test-isolation bug**, see below |
| Approvals | `migrate-approvals-to-postgres.js` | None (a test-fixture timing mistake, corrected — see below) |
| Interventions | `migrate-interventions-to-postgres.js` | None |
| Proxy pool | `migrate-proxy-pool-to-postgres.js` | None |
| Audit | `migrate-audit-log-to-postgres.js` | None |
| Research | `migrate-research-to-postgres.js` | None (the most structurally complex domain — a directory tree of per-workspace/account files, not one flat file — but the lessons from every earlier domain carried over cleanly) |

### Real bug: task queue migration test polluted a shared singleton row

**Symptom:** running the *entire* server suite together (not any single test file in isolation) failed
`postgresTaskQueueSnapshotRepository.test.js`'s own "load() reports an empty snapshot when none has been
saved yet" assertion — even though that test file, run alone, still passed.

**Root cause:** `automation.task_queue_snapshots` has exactly one row **per organization** (by design — see
`M05_DURABLE_DOMAIN_MIGRATION.md`'s task-queue-snapshot section), unlike every other domain's tables, which
key on a randomly-suffixed id/account that can never collide across test files. Every test in this project
shares the single default organization. `migrateTaskQueueToPostgres.test.js` saved a real snapshot for that
organization and never cleaned it up — invisible when that one file ran alone, but a real, order-dependent
pollution of a *different* test file's "nothing has been saved yet" precondition the moment both ran in the
same `npm test` invocation, which only running the whole suite together could ever surface.

**Fix:** the new test's own cleanup hook now deletes its row for the default organization afterward,
restoring the precondition every other test in this domain depends on.

### Test-fixture-only issue: approvals migration test used a stale-by-the-time-it-runs expiry

The approvals migration test's first draft modeled a still-pending approval with a fixed `expiresAt` several
years in the past — the *real* adapter's lazy-expiration logic (comparing against real `Date.now()` on every
read) correctly marked it `EXPIRED` the moment the test actually ran, which is correct behavior, just the
wrong fixture for what the test meant to prove. Same root lesson as sites' `rotated_at` issue: model the
fixture on what the real system actually produces and depends on, not on what merely looks plausible.

## Report (per handout §7)

```text
Task: P3 — all 9 available domains, steps 1–3 (migration script + verification); step 4 (cutover) deliberately
  deferred for every domain
Files changed:
  - system/server/scripts/migrate-{sites,assignments,policies,task-queue,approvals,interventions,proxy-pool,
    audit-log,research}-to-postgres.js (9 new scripts)
  - system/server/test/integration/db/migrate{Sites,Assignments,Policies,TaskQueue,Approvals,Interventions,
    ProxyPool,AuditLog,Research}ToPostgres.test.js (9 new test files, 41 sub-tests total)
  - system/server/src/researchStore.js: exported readAccount/safeAccountId (already exported) for the research
    migration's own file-reading needs
  - system/server/src/db/repositories/postgresResearchRunRepository.js: exported encodeIndexKeys so the
    migration builds the identical on-disk-to-Postgres payload shape the real adapter uses
  - .github/workflows/db-migrations.yml: 9 new CI steps + node --check coverage for every script
Database migrations: none new (uses the existing M05 schemas for all 9 domains).
Security impact: none negative — every migration preserves encrypted/hashed material verbatim (proxy
  passwords, site tokens) rather than re-deriving it; every script requires DATABASE_URL explicitly and never
  deletes or modifies its source file.
Tests added: 9 new integration test files, 41 sub-tests total.
Tests run: server suite — 164 files, 1,554 tests, 1,554 passed, 0 failed, 0 skipped (real PostgreSQL 16.14,
  real Redis-compatible server, both local dev instances per P1) — the FULL suite, not just each new file in
  isolation, which is what actually caught the task-queue cross-test-file bug documented above.
Manual/real-service tests performed: ran every migration script's core logic against a real, disposable
  PostgreSQL instance with realistic (not real-production, since none exists in this environment) fixture
  data for each domain, including deliberately-malformed/legacy-shaped records where each domain's own file
  store loader is lenient enough to permit one.
Real hardware / real device involved: none. No real production data exists in this environment for any of
  these 9 domains — that step can only happen against the real rollout's actual data, by whoever runs these
  scripts there.
Known limitations: step 4 (cutover) is not done for any domain — index.js still exclusively uses the
  file-backed repository for all 9, unconditionally, in every environment. This is intentional: the handout's
  own step 4 requires watching each domain "run correctly for a while" post-cutover, which requires a real
  deployment this environment cannot provide. Wiring the flag itself (mechanical, mirroring
  CLOUD_API_ENABLED's own pattern) is fast follow-on work once a real environment exists to observe each one.
Rollback plan: nothing to roll back — no default behavior changed for any domain. Every migration script is
  re-runnable and non-destructive (upsert or ON CONFLICT DO NOTHING, never deletes).
Status: PASS WITH KNOWN LIMITATIONS (step 4 intentionally deferred for all 9 domains, needs a real
  environment)
Next task: P2b (real SMTP delivery — needs an owner-provided provider account), or P5 (real deployment, which
  is also the prerequisite for actually performing any of these 9 domains' step 4 cutovers for real).
```
