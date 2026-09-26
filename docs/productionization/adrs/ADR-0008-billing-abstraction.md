# ADR-0008: Isolate billing providers behind internal entitlements

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Engineering and security; product owner selects provider, plans and prices

## Context

No billing domain exists. Commercial authorization must not depend on browser state or arbitrary raw provider
status, and Phone Farm must never collect raw card numbers/CVV.

## Decision

Implement a provider-neutral billing service. Hosted/provider-controlled checkout collects payment. Verified,
idempotent webhooks update internal subscription state and derived entitlements. Product authorization queries the
entitlement service.

## Options considered

| Option | Security/compliance | Portability | Product control | Assessment |
| --- | --- | --- | --- | --- |
| Hosted checkout + internal entitlements | Strong | Provider adapter | Strong | Selected |
| Direct card handling | High PCI burden | Low | Unnecessary | Rejected |
| Client/provider state as authorization | Weak/replayable | Low | Poor | Rejected |
| No abstraction | Faster first integration | Provider lock-in | Moderate | Rejected |

## Trade-offs

Internal entitlements require reconciliation and careful webhook ordering but provide stable application semantics
and allow provider replacement.

## Consequences

- Provider events are signature-verified, uniquely stored, replay-safe and auditable.
- Entitlement examples include site/device/member limits and AI/research/audit/retention features.
- Payment credentials never enter Phone Farm.
- Development plans use clearly non-commercial fixtures; no invented pricing ships.

## Action items

1. [ ] Owner selects provider, launch plans, prices, currencies and countries.
2. [ ] Define billing provider and entitlement interfaces.
3. [ ] Add event/order/idempotency test fixtures.
4. [ ] Add reconciliation, suspension/grace and support runbooks.

