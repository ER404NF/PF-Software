# Database gap analysis

Status: **accepted M01 migration basis; no migration executed**
Date: **2026-09-25**
Current evidence: [M00_BASELINE.md](M00_BASELINE.md)
Target concepts: [DOMAIN_MODEL.md](DOMAIN_MODEL.md)

## Classification meanings

- **REQUIRED NOW**: represents current authoritative behavior or the minimum organization/identity foundation and
  must be designed before its corresponding file domain migrates.
- **REQUIRED LATER**: valid commercial/operational concept, but not required for the first organization/identity
  database slice.
- **MERGE WITH EXISTING CONCEPT**: the proposed table overlaps an existing aggregate or should initially be a
  field/event rather than an independent table.
- **NOT NEEDED**: no durable table is justified at present; revisit only with measured requirements.

These labels prioritize schema design; they do not authorize creating every `REQUIRED NOW` table in M03. M03
starts with organization/identity infrastructure and migrates no legacy store by default.

## Current persistence gaps

| Required production property | Current state | Gap |
| --- | --- | --- |
| Transactional authority | Atomic replacement per file; compensation across files | No cross-domain transaction/outbox |
| Horizontal concurrency | One process/local files and memory | No database locks/unique active-state enforcement across instances |
| Tenant enforcement | team/device/research grants | No organization FK, RLS or composite tenant integrity |
| Durable identity | usernames and logical string IDs often referenced directly | Mutable names and transport IDs act as relationships |
| Query/reporting | whole JSON snapshots and JSONL scans | No indexed relational queries or lifecycle joins |
| Large objects | local filesystem | No object metadata authority, signed access or lifecycle/versioning |
| Reusable secrets | environment, encrypted local fields, desktop config | No KMS references/rotation service |
| Backup/restore | local volume only | No PITR, object reconciliation or measured restore |
| Retention/deletion | ad hoc store behavior | No policy-driven deletion/anonymization jobs |
| Audit | append JSONL | No tenant-indexed immutable query/retention path |

## Proposed-table reconciliation

### Identity and organizations

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `organizations` | REQUIRED NOW | New top-level tenant; prerequisite for all authoritative cloud state |
| `organization_settings` | REQUIRED LATER | Start only when a setting has an approved owner/type; do not create an unbounded JSON dumping ground |
| `workspaces` | REQUIRED LATER | Optional sub-boundary; current `teamId`/research workspace values require explicit mapping |
| `users` | REQUIRED NOW | Replaces username-keyed person/login records with immutable identity |
| `user_emails` | REQUIRED NOW | Supports verified email lifecycle and normalized uniqueness separately from profile |
| `memberships` | REQUIRED NOW | Binds users to organizations and replaces implicit single-tenant operator scope |
| `roles` | REQUIRED NOW | Organization/global role definitions seeded from existing roles |
| `permissions` | REQUIRED NOW | Seed from current explicit capability strings |
| `role_permissions` | REQUIRED NOW | Durable role bundles; application still checks resource ownership |
| `membership_roles` | REQUIRED NOW | Allows scoped role assignment without embedding role name on user |
| `invitations` | REQUIRED LATER | Needed for commercial member onboarding after core membership flows |

### Authentication

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `sessions` | REQUIRED NOW | Replaces file sessions; stores token digest/version, expiry and revocation metadata |
| `mfa_methods` | REQUIRED NOW | Normalizes encrypted TOTP state and supports future methods without user-row secret fields |
| `recovery_codes` | REQUIRED NOW | One digested, consumable record per code rather than an embedded array |
| `security_events` | REQUIRED NOW | Durable throttling/account-security signal distinct from general product audit |

### Billing

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `plans` | REQUIRED LATER | Shape can be developed with non-commercial fixtures; prices require owner decision |
| `billing_customers` | REQUIRED LATER | Provider mapping; no raw payment credentials |
| `subscriptions` | REQUIRED LATER | Internal lifecycle derived from verified provider state |
| `subscription_events` | REQUIRED LATER | Unique/idempotent signed webhook record and processing result |
| `entitlements` | REQUIRED LATER | Product authorization reads internal entitlements, not browser/provider state |
| `usage_records` | REQUIRED LATER | Add only for approved billable/limit metrics; current process spend counter is insufficient |

### Fleet

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `sites` | REQUIRED NOW | Replaces `sites.json`; organization-owned, stable UUID, mutable safe slug/name |
| `site_credentials` | REQUIRED NOW | Rotatable hashed credential records; plaintext shown only at enrollment |
| `hosts` | REQUIRED NOW | Separates a physical/running installation from the customer site |
| `host_heartbeats` | REQUIRED LATER | Current live link/last-seen can start as host fields; append history when operations need it |
| `devices` | REQUIRED NOW | Stable cloud identity mapped to site-local logical ID/UDID reference |
| `device_capabilities` | MERGE WITH EXISTING CONCEPT | Start with validated structured capabilities on device/version; normalize only query-critical stable capabilities |
| `device_health_events` | REQUIRED LATER | Append health/recovery history after event volume/retention is designed |
| `device_assignments` | REQUIRED NOW | Replaces assignment snapshot/history; organization and immutable principals |
| `device_leases` | REQUIRED NOW | Enforces one active lease transactionally while preserving site-side generation checks |

### Platform accounts and policies

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `platform_accounts` | REQUIRED NOW | Replaces account definitions/ownership; no login credential in table |
| `account_policies` | REQUIRED NOW | Replaces configured/runtime policy split with versioned effective policy/history |

### Automation

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `tasks` | REQUIRED NOW | Replaces queue snapshot; immutable creator/member IDs and tenant scope |
| `task_runs` | REQUIRED NOW | Normalizes attempts/retries/provider/device binding and uncertain outcomes |
| `task_checkpoints` | REQUIRED NOW | Append checkpoints currently embedded in task documents |
| `task_schedules` | REQUIRED NOW | Represents windows/recurrence with explicit IANA zone and occurrence state |
| `ai_workers` | NOT NEEDED | Current workers are processes; persist worker identity only if future assignment/credential/health requirements justify it |

### Approvals and interventions

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `approvals` | REQUIRED NOW | Exact fingerprint, status, expiry and atomic one-time consumption |
| `interventions` | REQUIRED NOW | Replaces intervention snapshot; organization/task/account/device scope |

### Research

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `research_sessions` | REQUIRED NOW | Normalizes current run/session report and outcome |
| `research_candidates` | REQUIRED NOW | Durable per-organization content identity and dedup aliases |
| `research_observations` | REQUIRED NOW | Session-specific metrics/text/evidence/reason/score |
| `research_tags` | REQUIRED LATER | Current string tags can migrate after core candidate/session parity |
| `candidate_tags` | REQUIRED LATER | Join table follows normalized tag migration |
| `platform_actions` | REQUIRED NOW | Durable action/result linked to candidate/task/approval/device |

### Network

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `proxy_profiles` | REQUIRED NOW | Safe profile metadata and secret reference; replaces encrypted credential in pool JSON |
| `proxy_assignments` | REQUIRED NOW | Historical assignment with one active device/profile constraint |
| `network_verifications` | REQUIRED NOW | Immutable device-originated evidence and expiry; current status cache is not authority |

Transient USB interface, TUN interface, PID and enrollment snapshots remain site-local runtime/cache. Persist only
safe operational events needed for diagnosis; do not promote them to customer business identity.

### Storage

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `file_objects` | REQUIRED NOW | Authoritative ownership/checksum/classification/retention for object bytes |
| `file_references` | REQUIRED LATER | Add typed many-to-many references if one object is shared by multiple domain records; otherwise an owner type/id is sufficient initially |

### Notification, audit and operations

| Proposed table | Classification | Reconciliation |
| --- | --- | --- |
| `notifications` | REQUIRED NOW | Replaces account notification outbox; separate delivery attempts can follow measured need |
| `audit_events` | REQUIRED NOW | Replaces JSONL authority with append-oriented tenant/correlation queries |
| `incidents` | REQUIRED LATER | Needed with production alerting/on-call; not a substitute for raw health/security events |
| `api_keys` | REQUIRED LATER | Add for approved service/customer API use; store digest/metadata only |
| `webhooks` | REQUIRED LATER | Outbound customer webhook registrations/delivery are not current functionality |

## Schema disagreements and adjustments

1. Do not require PostgreSQL 18 UUIDv7 functions as an initial deployment constraint. Use application-generated
   UUIDv7 or a reviewed migration extension so supported managed PostgreSQL versions remain an owner/deployment
   choice.
2. Keep `Workspace` optional. Current `teamId` and research workspace cannot be merged blindly.
3. Do not persist `AIWorker` until a durable worker identity use case exists.
4. Do not normalize every capability/health point prematurely; stable authorization/query fields differ from
   high-volume operational events.
5. Add notification/outbox modeling explicitly; the proposed physical schema discusses billing events but current
   account notifications already require durable reconciliation.
6. Separate site from host instance. One customer site may replace or later run multiple hosts.
7. Add command idempotency/acknowledgement state either to task runs or a typed command table before cloud/site
   multi-instance dispatch.
8. Treat audit retention/anonymization as policy, not unrestricted cascade deletion.

## First database slice recommendation

M03 creates infrastructure and an empty versioned schema. The first migrated domain should be M04 identity and
organization, limited to:

```text
organizations
users
user_emails
memberships
roles
permissions
role_permissions
membership_roles
sessions
mfa_methods
recovery_codes
security_events
```

Before importing operators:

- M02 must place current auth/session access behind interfaces;
- migration must validate every legacy operator, create an immutable ID map and preserve auth-version/revocation;
- tenant choice for existing operators must be explicit in a migration manifest;
- cross-tenant and pooled-connection RLS tests must exist;
- rollback must return authority to the untouched legacy store;
- no legacy file is deleted after import.

## Acceptance gates before any domain becomes database-authoritative

- versioned forward migration and tested rollback/forward-fix strategy;
- schema classification test: tenant-scoped, global reference or platform-admin-only;
- RLS enabled/forced where intended; application role is not owner/superuser/`BYPASSRLS`;
- application authorization plus Org A/Org B negative tests;
- composite tenant integrity for high-risk relationships;
- import manifest with digest/counts/errors/version;
- repeat import is idempotent or clearly refused;
- parity/read comparison and failure-injection tests;
- backup and restore of that slice in a representative environment;
- explicit authority switch and recovery procedure.
