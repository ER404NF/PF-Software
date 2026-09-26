# M03 — PostgreSQL foundation

Status: **PASS** — verified against a real, disposable PostgreSQL 16.14 for the first time in
[P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md): all 18 migrations apply cleanly from a
clean database, the full up/down/up round trip is clean, and the tenant-isolation test passes for real
(after a real bug this same verification found and fixed — see that document's finding #1, a systemic RLS
defect affecting every organization-scoped table). Still also verified by
[`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml) in CI.

Baseline: [M00_BASELINE.md](M00_BASELINE.md)
Gap analysis: [DATABASE_GAP_ANALYSIS.md](DATABASE_GAP_ANALYSIS.md)
M02 (precondition): [M02_MODULARIZATION.md](M02_MODULARIZATION.md)

## Goal

Per the master productionization prompt's M03 scope: local development PostgreSQL, a migration framework, DB
configuration, connection pooling, health checks, a test database, migration CI, and transaction helpers —
plus DATABASE_GAP_ANALYSIS.md's own "first database slice" recommendation, the initial identity/organization
schema. **No application code was wired to this schema in this milestone** — that is M04 (organization +
identity + RBAC), a separate, larger, not-yet-started piece of work.

## What was built

### Migration framework

[`node-pg-migrate`](https://www.npmjs.com/package/node-pg-migrate) (`^9.0.0`), an established, narrowly-scoped
tool rather than a hand-rolled migration runner — this codebase's dependency-audit gates already treat new
dependencies as a cost, but implementing migration-locking/ordering/tracking logic myself, with no way to test
it against a real database, is a worse risk than adopting a widely-used tool whose correctness isn't riding on
this session's own unverified code. Installed at `^9.0.0` specifically (not the first version resolved) because
`^7.0.0` pulled in a `glob` version with a published high-severity advisory; `npm audit` is 0 vulnerabilities at
the pinned version.

- `system/package.json`: `"migrate": "node-pg-migrate --migrations-dir server/migrations"`.
- `system/server/migrations/1758837600000_identity-and-organizations.js` — the first (and, as of this
  milestone, only) migration.

### Database configuration, connection pooling, health checks, transactions

- `system/server/src/db/pool.js` — `createPool()`/`resolvePoolConfig()`. Reads `DATABASE_URL` and
  `DATABASE_POOL_MAX`/`DATABASE_IDLE_TIMEOUT_MS`/`DATABASE_CONNECT_TIMEOUT_MS`/`DATABASE_STATEMENT_TIMEOUT_MS`/
  `DATABASE_SSL`. TLS verification is never silently disabled — `DATABASE_SSL=no-verify` must be explicit.
  Attaches a pool-level `error` handler (required by `pg`'s own documentation to avoid an unhandled exception
  crashing the process when an idle client's connection drops).
- `system/server/src/db/health.js` — `checkDatabaseHealth(pool)`, a bounded-timeout `SELECT 1`. Not wired into
  any HTTP route yet.
- `system/server/src/db/transaction.js` — `withTransaction(pool, fn, { organizationId })`, implementing
  DATABASE_GAP_ANALYSIS.md §2's `BEGIN; SET LOCAL app.current_organization_id; ...; COMMIT` pattern. The tenant
  id is set via `set_config($1, $2, true)` — parameterized, never string-interpolated into SQL text — and
  validated as a UUID shape before use. Always rolls back and releases the client on any thrown error,
  including a failure inside `ROLLBACK` itself.

None of `pool.js`/`health.js`/`transaction.js` is imported by `index.js` or any other application code yet.

### Identity/organization schema (first migration)

`identity` schema: `organizations`, `workspaces`, `users`, `user_emails`, `memberships`, `roles`,
`permissions`, `role_permissions`, `membership_roles`, `invitations`, `sessions`, `mfa_methods`,
`recovery_codes`, `security_events` — matching PF_SOFTWARE_DATABASE_LOGICAL_PHYSICAL_SCHEMA.md §7.1, with one
deliberate deviation recorded in DATABASE_GAP_ANALYSIS.md's "Schema disagreements" §1: primary keys default to
`gen_random_uuid()` (built into PostgreSQL 13+, no extension required) instead of requiring PostgreSQL 18's
`uuidv7()`, so this schema does not force a PostgreSQL 18 deployment requirement.

Row-Level Security (defense in depth, DATABASE_GAP_ANALYSIS.md §8) is enabled and forced on every
organization-scoped table this migration creates (`workspaces`, `memberships`, `invitations`, `roles`,
`security_events`), each restricted to `current_setting('app.current_organization_id', true)`. `users`,
`user_emails`, `sessions`, `mfa_methods`, and `recovery_codes` are deliberately NOT organization-scoped — a
user is a global identity that can belong to multiple organizations (ADR-0006/ADR-0007); tenant isolation for
those is an application-layer concern via the membership relationship, not row-level `organization_id`
filtering on the user record.

**Deliberately out of scope for this migration** (recorded in the migration file's own comments, not just
here):
- Database roles (`pf_owner`/`pf_app`/`pf_migrator`/...) — role topology is an environment/deployment decision
  (managed PostgreSQL providers vary in what they permit), not portable schema. Creating them belongs in a
  deployment runbook (M13) or an explicit ops script a DBA controls per environment, not in a migration that
  runs unattended in CI against a throwaway database.
- Composite tenant-integrity constraints (DATABASE_GAP_ANALYSIS.md §9, e.g. `(organization_id, id)` uniqueness
  pairs) — valuable once cross-domain tables reference `(organization_id, device_id)`-shaped foreign keys, which
  don't exist until later domains migrate (M05+). Nothing to compose against yet in an identity-only schema.

### CI verification (the only real verification that exists)

[`.github/workflows/db-migrations.yml`](../../.github/workflows/db-migrations.yml): a `postgres:16` service
container, `npm ci`, the existing `desktop/scripts/audit-gate.cjs --dir system` dependency-audit gate (same
convention as `mac-installer.yml`), `npm run migrate up`, then
`system/server/test/integration/db/tenantIsolation.test.js` with `TEST_DATABASE_URL` pointed at the service
container.

That test is this milestone's actual proof, once it has run:
- creates a **non-superuser** role (`pf_test_app_<random>`) with no `BYPASSRLS` — RLS does not apply to
  superusers or `BYPASSRLS` roles, so testing through the default superuser connection a CI Postgres service
  provides would prove nothing;
- confirms a connection with **no** tenant context set sees zero rows (fail closed, not fail open);
- confirms Org A can create and read its own workspace;
- confirms **Org B cannot `SELECT` Org A's workspace row**;
- confirms **Org B cannot `INSERT` a row claiming `organization_id = Org A`** (the `WITH CHECK` clause, not just
  `USING`);
- confirms Org B's `UPDATE`/`DELETE` against Org A's workspace by primary key affects zero rows;
- runs `migrate up` (no-op, already applied) then `migrate down`, asserting the `identity` schema is actually
  gone, proving the down migration is real and not a stub.

Local test run (everything except the two tests above, which require `TEST_DATABASE_URL`):
**system/server unit tests for `pool.js`/`health.js`/`transaction.js` — 15/15 passed**, using fakes/mocks, no
live database. `node --check` passed on every new file. `git diff --check` passed.

## What this does NOT mean

- **M03 is not "done" in the sense of being deployed or proven at scale.** It has not run against a real
  database anywhere yet — only in CI, and only once that workflow has actually executed.
- **This does not unblock M04.** M04 (organization + identity + RBAC, with comprehensive tenant/authorization
  tests) is separate, larger, not-yet-started application-layer work: services, routes, and a migration path
  for existing `operators.config.json` records into `identity.users`/`identity.memberships`, per
  DATABASE_GAP_ANALYSIS.md's "Before importing operators" checklist (none of which exists yet).
- **No file store was touched, migrated, or made non-authoritative.** `operators.config.json` and every other
  file store remain exactly as they were before this milestone.
- **Local development PostgreSQL** (one item in the master prompt's M03 scope) is now solved without requiring
  Docker or admin rights — see [P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md) for the
  `embedded-postgres`/`redis-memory-server` approach used to verify this milestone for real. A developer with
  Docker available may still prefer a `docker-compose.dev.yml` (not created, since it wasn't needed here), or
  can point `DATABASE_URL` at any PostgreSQL 13+ instance.

## Next steps toward M04

Per DATABASE_GAP_ANALYSIS.md's own gate, before any operator data is imported:
1. M02-style service/repository interfaces for authentication reads (already exist — see
   [M02_MODULARIZATION.md](M02_MODULARIZATION.md)'s identity slice) must be extended to optionally read from
   PostgreSQL behind the same contract, not replace the file adapter outright.
2. A migration manifest design (`migration_run_id`, `source_digest`, counts, idempotency) for importing
   `operators.config.json` records into `identity.users`/`identity.memberships`, preserving `authVersion` and
   revocation semantics.
3. Cross-tenant negative tests for every new authorization-sensitive route, not just the schema-level RLS test
   this milestone added.
4. An explicit rollback/forward-fix procedure and a real restore drill before any production data touches this
   schema (M19 territory, but the procedure should exist before M04 ships, not after).
