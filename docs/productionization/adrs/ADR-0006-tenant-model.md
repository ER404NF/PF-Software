# ADR-0006: Use organization as the top-level tenant

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Product owner, security and engineering

## Context

Current authorization combines role, optional `teamId`, device grants and research workspace ownership. None is a
complete commercial tenant. Blindly renaming `teamId` or workspace would create ambiguous ownership.

## Decision

Adopt `Organization` as the top-level tenant. A user acts through a current membership. `Workspace` is an optional
organization sub-boundary. Every tenant-owned record has an enforceable organization path; client-supplied tenant
IDs are selectors only.

## Options considered

| Option | Isolation clarity | Migration fit | Commercial fit | Assessment |
| --- | --- | --- | --- | --- |
| Organization + optional workspace | Strong | Requires explicit legacy mapping | Flexible | Proposed |
| Workspace as top-level tenant | Moderate | Name matches research concept only | Ambiguous teams/billing/sites | Rejected |
| Team as tenant | Weak | Reuses current field | Too narrow/mutable | Rejected |
| Database per tenant | Strong physical isolation | Complex migration/operations | Possible enterprise tier | Deferred |

## Trade-offs

The model adds membership/context selection and migration mapping. It provides one boundary for billing, sites,
devices, accounts, files and audit while keeping optional internal subdivision.

## Consequences

- User and organization are many-to-many unless owner scope restricts launch behavior.
- Authorization checks permission, entitlement and exact resource ownership.
- RLS is defense in depth; application checks remain mandatory.
- Current `teamId` and research workspace receive explicit migration records, never inferred globally.

## Action items

1. [ ] Owner decides multi-organization launch scope and workspace visibility.
2. [ ] Define legacy tenant mapping/import UI or manifest.
3. [ ] Define tenant context middleware and connection-pool rules.
4. [ ] Add Org A/Org B negative API/job/object/cache tests.
