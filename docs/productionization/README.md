# Productionization documentation

The productionization sequence preserves the working Phone Farm device-control system and adds commercial cloud
capabilities incrementally.

## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| M00 — baseline/freeze behavior | Complete | [M00_BASELINE.md](M00_BASELINE.md) |
| M01 — ADRs/domain/trust/data/threat model | Accepted direction | [ARCHITECTURE.md](ARCHITECTURE.md), [DOMAIN_MODEL.md](DOMAIN_MODEL.md), [TRUST_BOUNDARIES.md](TRUST_BOUNDARIES.md), [DATA_CLASSIFICATION.md](DATA_CLASSIFICATION.md), [THREAT_MODEL.md](THREAT_MODEL.md) |
| Database reconciliation | Accepted migration basis | [DATABASE_GAP_ANALYSIS.md](DATABASE_GAP_ANALYSIS.md) |
| M02 — modularization safety layer | Persistence-interface slices complete | [M02_MODULARIZATION.md](M02_MODULARIZATION.md) |
| M03 — PostgreSQL foundation | PASS — verified against a real, disposable PostgreSQL 16 for the first time; see P1 | [M03_POSTGRES_FOUNDATION.md](M03_POSTGRES_FOUNDATION.md), [P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md) |
| M04 — organization/identity/RBAC | Parts 1–6c verified for real against a live database (P1); now actually mounted into the running server behind a flag, proven end to end over real HTTP (P2); WebAuthn, hard deletion, platform-admin org/user suspension, and the matrix on remaining endpoints still remain | [M04_ORGANIZATION_IDENTITY.md](M04_ORGANIZATION_IDENTITY.md), [P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md), [P2_REAL_LOGIN_MOUNTED.md](P2_REAL_LOGIN_MOUNTED.md) |
| M05 — durable domain migration | 10 domains (sites, approvals, interventions, assignments, account notifications, task queue snapshot, audit events, proxy pool, research runs, account policies) — adapters now verified against a real database (P1), but still not cut over; everything is still file-authoritative | [M05_DURABLE_DOMAIN_MIGRATION.md](M05_DURABLE_DOMAIN_MIGRATION.md), [P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md) |
| M06 — Redis foundation | PASS — client/health-check verified against a real Redis-compatible server (P1); no domain (presence, rate limits, locks) migrated yet | [M06_REDIS_FOUNDATION.md](M06_REDIS_FOUNDATION.md), [P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md) |
| M07+ | Not started | |

## ADR register

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-0001](adrs/ADR-0001-cloud-site-boundary.md) | Cloud/site execution boundary | Accepted direction |
| [ADR-0002](adrs/ADR-0002-postgresql-authority.md) | PostgreSQL authoritative state | Accepted direction |
| [ADR-0003](adrs/ADR-0003-redis-ephemeral.md) | Redis for ephemeral coordination only | Accepted direction |
| [ADR-0004](adrs/ADR-0004-object-storage.md) | Object storage for large bytes | Accepted direction |
| [ADR-0005](adrs/ADR-0005-secrets-kms.md) | Secret references and KMS | Accepted direction; vendor open |
| [ADR-0006](adrs/ADR-0006-tenant-model.md) | Organization tenant model | Accepted direction |
| [ADR-0007](adrs/ADR-0007-identity-plane.md) | Commercial identity boundary | Accepted boundary; provider open |
| [ADR-0008](adrs/ADR-0008-billing-abstraction.md) | Provider-neutral billing/entitlements | Accepted abstraction; provider/pricing open |
| [ADR-0009](adrs/ADR-0009-event-audit-model.md) | Transactional outbox and append audit | Accepted direction |
| [ADR-0010](adrs/ADR-0010-deployment-topology.md) | Modular cloud plus outbound site agents | Accepted topology; cloud/region open |

## Phase 1 rollout (own team, not the commercial SaaS plan)

[PHASE1_TEAM_ROLLOUT_HANDOUT.md](PHASE1_TEAM_ROLLOUT_HANDOUT.md) — a self-contained handout for a coding agent
covering exactly what's left to reach a real internal rollout (1 Mac mini in Italy + 2 in Romania as
independent device hosts, a separate hub/database server — Railway is the leading candidate — real login, and
automated email through the existing `mailSender.js`), in order, with required proof for each step. The full
master prompt in the owner's Downloads folder describes the later, larger commercial-product phase; this
handout is the scoped-down version to execute first.

Progress against that handout's task list: **P1, P2, P3, and P4 done** — see
[P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md) (real PostgreSQL + Redis verification,
found and fixed a systemic RLS defect plus six other real bugs), 
[P2_REAL_LOGIN_MOUNTED.md](P2_REAL_LOGIN_MOUNTED.md) (real login mounted into the running server + a full
authorization-matrix/fuzzing pass, found and fixed 3 more real bugs, proven with a real end-to-end
invite/login/TOTP sequence over real HTTP), [M06_REDIS_FOUNDATION.md](M06_REDIS_FOUNDATION.md)'s P4 decision
(no Redis-backed domain needed yet at this fleet size), and
[P3_DOMAIN_CUTOVER.md](P3_DOMAIN_CUTOVER.md) (a working, tested migration script for all 9 domains that have
a Postgres adapter — sites, assignments, platform policies, task queue, approvals, interventions, proxy pool,
audit, research — found and fixed 2 more real bugs, one only visible when the whole test suite ran together;
actual cutover deliberately deferred to a real deployment for every domain — see that document for why).
Next: P2b (real SMTP delivery) or P5 (real deployment) — both need an owner-provided account/infrastructure
this environment cannot create on its own.

## Rules

- Proposed schema documents are targets, not current-state evidence.
- Owner decisions are never silently converted into engineering defaults.
- No file store is removed until parity, rollback, backup and restore are verified.
- Physical-device, routing, distribution and operational claims require their own acceptance evidence.
