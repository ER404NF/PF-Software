# ADR-0005: Store reusable secrets behind references and KMS

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Security and operations; provider requires owner approval

## Context

Current deployments use environment variables, encrypted local fields and owner-only desktop configuration. A
multi-tenant cloud needs scoped access, rotation, audit and environment separation.

## Decision

Use a managed secret store/KMS where available. PostgreSQL holds a secret reference, safe metadata and rotation
state—not reusable plaintext. Site-local credentials use OS-secure storage where supported and are never exposed to
ordinary operator clients or model prompts.

## Options considered

| Option | Rotation/audit | Portability | Risk | Assessment |
| --- | --- | --- | --- | --- |
| Managed secret store/KMS | Strong | Provider abstraction needed | Lowest operational risk | Selected |
| Encrypted DB columns only | Application-managed | High | Key/bootstrap/rotation burden | Limited fallback |
| Environment variables | Deployment-simple | High | Weak tenant granularity/rotation | Bootstrap only |
| Plain config/database | None | High | Unacceptable | Rejected |

## Trade-offs

Managed services add cost and vendor-specific integration. A narrow `SecretProvider` interface preserves domain
portability without inventing custom cryptography.

## Consequences

- Secret reads are least-privilege, short-lived in memory and never logged.
- Proxy, AI, SMTP, billing, service and signing secrets have distinct identities/policies.
- Ending ownership immediately revokes/deletes reusable secrets.
- Database backup alone is insufficient; restore must rebind secret references.

## Action items

1. [ ] Define `SecretProvider` contract and secret metadata schema.
2. [ ] Inventory every current secret and rotation/revocation owner.
3. [ ] Select production provider and local-development adapter.
4. [ ] Add redaction, access-audit and restore-rebinding tests.

