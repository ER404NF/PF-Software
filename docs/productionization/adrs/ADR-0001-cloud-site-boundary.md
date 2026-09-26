# ADR-0001: Keep physical-device execution at the Mac site

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Engineering and security; product owner approves deployment scope

## Context

WDA, USB discovery, iproxy, xcodebuild, Internet Sharing and PF routing require local macOS/device access. The
existing site agent already connects outbound to a hub with a typed RPC allow-list.

## Decision

The cloud owns business state, authorization and command coordination. The Mac site agent remains the trusted
local gateway for deterministic device and routing operations. The link is outbound authenticated TLS and carries
versioned typed commands only. No generic remote shell is added.

## Options considered

| Option | Complexity | Security | Operability | Assessment |
| --- | --- | --- | --- | --- |
| Keep execution at site | Medium | Smallest USB/privilege boundary | Works behind site NAT | Selected |
| Move execution to cloud | High | Requires exposing/tunneling local hardware | Poor fit for Xcode/USB | Rejected |
| Run complete authority per site | Medium | Fragments tenant/business state | Hard multi-site reconciliation | Rejected as cloud model |

## Trade-offs

Cloud commands are asynchronous and sites may be offline, so command expiry, idempotency, acknowledgement and
uncertain results become first-class. In return, USB and privileged routing never become public-cloud services.

## Consequences

- Preserve `agentMain.js`, `SiteAgent`, `SiteLinkHub`, Device API and per-phone managers.
- Add production site identity, revocation, replay/idempotency and compatibility negotiation.
- Keep emergency fail-close locally available during cloud loss.
- Cloud must not equate a delivered command with an applied physical action.

## Action items

1. [ ] Define versioned command envelope and acknowledgement states.
2. [ ] Add durable command idempotency/correlation state.
3. [ ] Design rotatable production site identity and enrollment.
4. [ ] Test site loss, replay, revocation and rolling upgrades.

