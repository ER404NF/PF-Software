# ADR-0009: Use transactional outbox events and append-oriented audit

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Engineering, security and operations

## Context

Current audit is append-only JSONL and several file-backed workflows use compensation. Production email, site
commands, object operations, billing and webhooks need retryable effects without publishing state before commit.

## Decision

Persist business transitions and outbox records in one PostgreSQL transaction. Workers deliver outbox effects
idempotently. Persist separate append-oriented audit/security events with correlation IDs and redacted metadata.
Do not introduce Kafka or event sourcing until measured scale/integration needs justify it.

## Options considered

| Option | Atomicity | Operational cost | Replay/query | Assessment |
| --- | --- | --- | --- | --- |
| PostgreSQL outbox + audit tables | Strong with business transaction | Moderate | Sufficient initially | Selected |
| Direct side effect after commit | Weak on crash window | Low | Poor | Rejected |
| Full event sourcing | Strong history | High redesign cost | Strong | Rejected for current migration |
| Kafka/event bus now | Strong distribution | High | Strong | Deferred |

## Trade-offs

Outbox polling adds worker/cleanup/monitoring requirements and at-least-once delivery semantics. It avoids a second
distributed system before need and closes the commit/publish crash window.

## Consequences

- Consumers and site/vendor operations require idempotency keys.
- Audit is not the command queue or mutable domain state.
- Audit access and retention are tenant/policy scoped.
- Correlation connects request, transaction, outbox, site acknowledgement and incident.

## Action items

1. [ ] Define event envelope, versioning and redaction rules.
2. [ ] Implement outbox repository/worker after PostgreSQL foundation.
3. [ ] Add crash/retry/duplicate/out-of-order tests.
4. [ ] Define audit retention, anonymization and append-only DB role.

