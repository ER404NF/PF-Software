# Data classification and handling

Status: **accepted M01 direction; retention periods remain open**
Date: **2026-09-25**

Retention periods and legal bases are owner/legal decisions. This document defines engineering handling classes,
not final legal policy.

## Classes

| Class | Meaning | Examples | Minimum controls |
| --- | --- | --- | --- |
| Public | Approved for public distribution | marketing pages, public docs, released installer metadata | integrity review, normal backups |
| Internal | Operational data with limited harm if exposed | component versions, non-sensitive health, generic metrics | authenticated access, encrypted transport, controlled logs |
| Confidential | Customer/business/personal data | user profile, memberships, device labels, tasks, research metadata, audit context | tenant authorization, encryption, access audit, retention/deletion policy |
| Restricted | High-impact security, credential or sensitive content | password hashes, MFA material, session/recovery tokens, proxy credentials, evidence bytes, private uploads, signing keys | least privilege, KMS/secret manager or strong encryption, no ordinary logs, rotation/revocation, tightly audited access |

## Domain classification

| Data | Class | Authoritative location | Special handling |
| --- | --- | --- | --- |
| Organization name/settings | Confidential | PostgreSQL | tenant-scoped; deletion workflow |
| User profile/email | Confidential | PostgreSQL | verified ownership, minimize exports/logs |
| Password hash | Restricted | PostgreSQL/identity provider | modern adaptive hash; never returned |
| Session/recovery/API token | Restricted | hash/digest plus secure client cookie/storage | plaintext shown/sent only when necessary; revoke/expire |
| TOTP seed/recovery code | Restricted | encrypted seed / digested code | per-user key policy; one-time recovery codes |
| Membership/role/permission | Confidential | PostgreSQL | authorization-sensitive; audit changes |
| Site credential | Restricted | digest or secret reference | rotate/revoke; never list plaintext |
| Device UDID | Restricted | site-local or encrypted/scoped cloud identifier | avoid browser/log exposure; display logical ID |
| Device label/capability/health | Confidential | PostgreSQL | tenant-scoped; health contains no raw secrets |
| Screenshots/research evidence/uploads | Restricted | object storage | opaque keys, signed short-lived access, checksum, retention |
| Tasks/checkpoints/model decisions | Confidential; Restricted if content includes customer data | PostgreSQL/object storage | schema validation; minimize raw prompts |
| Platform account handle/policy | Confidential | PostgreSQL | workspace/org authorization |
| Platform login credential | Restricted | secret manager only | never place in task, model prompt or PostgreSQL plaintext |
| Proxy endpoint/location | Confidential | PostgreSQL | reveal only to authorized proxy operators |
| Proxy password | Restricted | secret manager | no browser return, logs or audit metadata |
| Network verification IP/location | Confidential | PostgreSQL | retention and role-gated visibility |
| Billing customer/subscription | Confidential | PostgreSQL | billing-role scope; provider IDs not authorization |
| Card/CVV | Prohibited | hosted payment provider only | never enters Phone Farm systems |
| Audit/security event | Confidential, sometimes Restricted | append-oriented PostgreSQL | immutable access path, redacted metadata |
| Signing/notarization private key | Restricted | CI secret store/HSM | release-only identity; never repository/artifact |

## Handling requirements

### Collection and minimization

- collect only fields needed for a documented product/security purpose;
- separate content/evidence from operational metadata;
- do not make raw UDIDs, emails, platform handles or filenames storage keys;
- do not send infrastructure credentials or unrelated tenant data to an AI provider.

### Storage

- encrypt production data at rest and in transit;
- store large/restricted bytes in object storage with PostgreSQL ownership metadata;
- store reusable secrets in a secret manager/KMS, not ordinary columns;
- use checksums and immutable identifiers for migration/reconciliation;
- environment, tenant and classification must be explicit.

### Logging and telemetry

Never log passwords, session/site/recovery tokens, TOTP seeds, recovery codes, proxy passwords, SMTP/provider keys,
payment credentials, signing material or unnecessary evidence text/images. Logs use correlation and resource IDs,
bounded safe error codes and redacted metadata.

### Access and export

- every operation resolves current membership and exact resource ownership;
- signed object access is short-lived and operation-specific;
- exports are generated as audited jobs, stored as Restricted objects and expire;
- support/break-glass access is approved, time-bounded and audited.

### Retention and deletion

Engineering must support configurable policies and deletion jobs. Sessions/recovery material and reusable secrets
are revoked/deleted immediately when ownership ends. Evidence/uploads are asynchronously deleted and verified.
Billing/audit retention requires approved legal policy; `ON DELETE CASCADE` alone is not a privacy process.

## Prohibited storage

- raw card number or CVV;
- plaintext password, reusable session token or recovery code;
- raw proxy/provider/SMTP/signing secret in source, logs or ordinary database fields;
- unrestricted large screenshot/video blobs in PostgreSQL;
- secret values in Redis;
- customer data in CI fixtures or public issue text.

## Owner decisions required

- legal bases, retention periods and deletion/anonymization rules;
- launch jurisdictions and residency requirements;
- whether any evidence category is prohibited or requires consent;
- support-access process and audit retention;
- AI provider data-use/retention contracts.
