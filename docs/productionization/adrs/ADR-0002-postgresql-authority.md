# ADR-0002: Use PostgreSQL as authoritative cloud state

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Engineering and security; operations approves supported version/service

## Context

Current JSON/JSONL/file stores provide useful local durability and atomic single-file replacement but cannot offer
cross-domain transactions, indexed tenant queries, horizontally safe concurrency, RLS or PITR.

## Decision

Use PostgreSQL as the authoritative cloud database. Introduce it behind persistence/service interfaces and migrate
one domain at a time. Use application authorization plus tenant-scoped constraints/RLS. Do not delete legacy files
until parity, rollback and restore are proven.

## Options considered

| Option | Transactions | Tenant enforcement | Migration cost | Assessment |
| --- | --- | --- | --- | --- |
| PostgreSQL | Strong relational transactions/constraints | Application + RLS/FKs | Medium | Selected |
| Continue file stores | Single-file only | Application-only | Low now, unsafe at scale | Rejected for cloud authority |
| Document database | Document transactions vary | Weaker relational integrity for this model | Medium | Rejected |
| Database per tenant | Strong isolation | Operationally expensive at launch | High | Defer for special tiers |

## Trade-offs

PostgreSQL adds migrations, pooling, operations and schema discipline. It materially simplifies lease uniqueness,
approval consumption, webhook idempotency, tenant integrity and restore compared with compensating file writes.

## Consequences

- Application request role is never owner, superuser or `BYPASSRLS`.
- Tenant context is verified and transaction-local.
- High-risk relationships include organization in constraints/FKs.
- PostgreSQL does not store large evidence bytes or reusable plaintext secrets.
- Supported PostgreSQL version must not be constrained solely for native UUIDv7 convenience.

## Action items

1. [ ] M02 persistence/service interfaces and contract tests.
2. [ ] M03 migrations, pooling, health, test database and CI.
3. [ ] Schema classification/RLS/connection-reuse tests.
4. [ ] Import manifests, parity comparison, rollback and restore procedures per domain.

