# ADR-0003: Limit Redis to ephemeral coordination

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Engineering and security

## Context

Presence, throttles, short locks and caches must work across cloud instances. Current equivalents are process-local.
Making Redis authoritative would create data-loss and fail-open risks.

## Decision

Use Redis for rate limits, presence, short-lived locks, cache and bounded idempotency windows. Prefix every
tenant-sensitive key with organization ID and use TTLs. PostgreSQL remains authoritative for leases, approvals,
tasks, sessions, billing and audit.

## Options considered

| Option | Latency | Failure semantics | Complexity | Assessment |
| --- | --- | --- | --- | --- |
| Redis ephemeral + PostgreSQL authority | Low | Redis can be rebuilt | Medium | Selected |
| PostgreSQL for all ephemeral state | Moderate | Simple authority | Lower initially | Valid fallback for early slices |
| Redis as primary queue/lease store | Low | Data loss/split authority risk | High | Rejected |
| Process memory | Lowest | No horizontal coordination | Low | Development only |

## Trade-offs

Some features may be degraded during Redis loss and the application must define safe fallback per feature. This is
preferable to treating an unavailable cache as permission or losing authoritative state.

## Consequences

- No raw secrets or unbounded payloads in Redis.
- Keys follow `pf:org:{org_id}:...` with explicit global exceptions.
- Cache entries include version/revision and short TTL.
- Redis outage cannot grant access or duplicate physical input/approval consumption.

## Action items

1. [ ] Define key registry, payload limits and TTLs.
2. [ ] Add Redis health/degradation behavior.
3. [ ] Test flush, outage, stale cache and cross-tenant key isolation.
4. [ ] Add Redis only when a bounded M06 use case requires it.

