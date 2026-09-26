# ADR-0007: Introduce a commercial identity domain behind an interface

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Product owner, security and engineering

## Context

The current operator store has strong local primitives—scrypt, MFA, recovery digests, session revocation and live
authorization rechecks—but it is a single-installation file registry without organization memberships,
invitations, distributed throttling or commercial lifecycle operations.

## Decision

Create an identity domain with immutable users, verified emails, memberships, permissions, sessions, MFA,
recovery and security events behind stable application interfaces. Use established crypto/libraries. Whether the
credential implementation is first-party or an external identity provider remains an owner/security decision.

## Options considered

| Option | Control | Delivery/operations | Portability | Assessment |
| --- | --- | --- | --- | --- |
| External managed IdP | Lower | Strong managed security/SSO | Vendor dependency | Candidate |
| Internal identity on PostgreSQL | High | Highest security/ops burden | High | Candidate |
| Hybrid abstraction | High domain control | Integration complexity | Best migration flexibility | Selected architecture |
| Keep operator files | Local only | Cannot scale commercially | High | Legacy adapter only |

## Trade-offs

An abstraction adds work and cannot hide every provider semantic. It prevents authorization/business domains from
depending on browser claims or one vendor and allows the current local adapter during migration.

## Consequences

- Product APIs resolve current user/session/membership rather than deserialize roles from clients.
- Sessions and revocation are authoritative and listable.
- Signup, verification, reset and recovery have bounded, auditable state machines.
- MFA/recovery and brute-force controls are required regardless of provider.

## Action items

1. [ ] Owner/security select provider strategy and enterprise SSO scope.
2. [ ] Define identity interfaces and current-file adapter in M02.
3. [ ] Add organization membership and tenant-context model.
4. [ ] Build migration/revocation/negative authorization tests before authority switch.
