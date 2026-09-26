# ADR-0010: Deploy a modular cloud control plane with outbound site agents

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Product owner, operations, security and engineering

## Context

The repository currently runs one Node hub behind Caddy and local Electron/site processes. Commercial operation
needs scalable API/WebSocket capacity, workers, managed data services, safe deployment and recovery without
turning every module into a microservice.

## Decision

Deploy a modular Node cloud application with separately scalable API/WebSocket and worker process types, backed by
managed PostgreSQL, Redis, object storage and secret/KMS services. Sites connect outbound. Use declarative
infrastructure and rolling/blue-green deployment with migration compatibility gates.

## Options considered

| Option | Delivery speed | Scale/failure isolation | Operations | Assessment |
| --- | --- | --- | --- | --- |
| Modular application + workers | High | Adequate, extract later | Moderate | Proposed |
| Immediate microservices | Low | High theoretical | Excessive for current team/state | Rejected |
| Single VM/file volume | High initially | Poor HA/tenant scale | Simple but fragile | Development/pilot only |
| Serverless-only | Mixed | Managed scale | Long WebSocket/site link constraints | Not primary |

## Trade-offs

A modular deployment shares a codebase and some failure domain but enables faster safe migration. Clear module and
data ownership makes later extraction possible based on measured load.

## Consequences

- API instances are stateless apart from bounded connection state.
- Workers own retries/outbox/background jobs.
- Site link capacity and connection draining need explicit design.
- Migrations are backward-compatible across a rolling deployment.
- Vendor, region, availability tier and cost are unresolved owner/operations decisions.

## Action items

1. [ ] Select cloud, regions, residency and availability target.
2. [ ] Define dev/staging/production environments and IaC.
3. [ ] Add independent application CI, container publication and deployment gates.
4. [ ] Design migration sequencing, health, rollback, backups and restore drills.
5. [ ] Load-test API/WebSocket/site connection and worker boundaries before extraction.
