# M02 modularization safety layer

Status: **persistence-interface slices complete; see "M02 status" below for what that does and does not unblock**
Date started: **2026-09-25**
Baseline: [M00_BASELINE.md](M00_BASELINE.md)
Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)

## Goal

Place stable service and persistence boundaries around current behavior before PostgreSQL or other production
infrastructure is introduced. Each slice keeps the existing file store authoritative, preserves HTTP/WebSocket
contracts, adds direct module tests, and passes the complete system and desktop suites.

## Completed slices

### Audit events

The server now composes audit behavior through three layers:

```text
routes, workers and schedulers
  -> audit service (authorization-aware reads)
  -> audit event repository contract
  -> current JSONL file adapter
```

The service retains the established `logEvent()` and `listEvents()` surface used by current modules. Authorized
audit filtering moved out of the server entry point and remains device-grant aware. A later PostgreSQL adapter can
implement the same repository contract without changing routes or domain workers.

Files:

- `system/server/src/services/auditService.js`
- `system/server/src/persistence/auditEventRepository.js`
- `system/server/src/persistence/fileAuditEventRepository.js`
- `system/server/test/unit/auditService.test.js`

No data migration occurred. The JSONL audit file remains authoritative.

### Sessions

The composition root now creates the session store through a stable callback-based contract and file adapter.
The adapter retains the existing owner-only session files, atomic replacement, revocation tombstones, sweep logic,
and shared HTTP/WebSocket store instance. A future PostgreSQL session adapter must implement the same `get()`,
`set()`, `destroy()`, and `touch()` contract before it can replace the file adapter.

Files:

- `system/server/src/persistence/sessionStore.js`
- `system/server/src/persistence/fileSessionStore.js`
- `system/server/test/unit/sessionStore.test.js`

No session data migration occurred. The current per-session files remain authoritative.

### Operator account administration

Administrative account reads and mutations now use an async-first service and repository contract. The current
adapter delegates to the existing atomic `operators.config.json` implementation, but routes await every operation
so a later PostgreSQL adapter does not require another route signature rewrite. This slice covers listing,
creating, updating, reviewing, renaming, session invalidation, and administrator-initiated 2FA reset.

The existing compensation around username reference migration and account-review notification commits remains in
place. Background authorization and live WebSocket authorization still use the existing `authStore.js` path and
will move in separate safety slices.

Files:

- `system/server/src/persistence/operatorAccountRepository.js`
- `system/server/src/persistence/fileOperatorAccountRepository.js`
- `system/server/src/services/operatorAccountService.js`
- `system/server/test/unit/operatorAccountService.test.js`

No operator record was migrated. `operators.config.json` remains authoritative.

### HTTP authentication and authorization identity reads

Password login, signup, recovery, MFA configuration/verification, pending MFA challenge resolution, HTTP
authentication/capability middleware, stored-session rechecks, and post-probe network authorization now use an
async-first identity service and repository contract. The current file adapter delegates mutations to the existing
atomic `authStore.js` implementation and reads its live in-memory projection of `operators.config.json`, so role,
device-grant, activation, approval, and `authVersion` changes continue to take effect without requiring a new login.
Repository failures flow to centralized request error handling, while invalid, expired, deactivated, or
version-mismatched identities fail closed.

The repository returns internal records because password and MFA verification need protected fields. Routes still
use the explicit `publicOperator()` projection before returning an identity to a browser. Correct passwords for
pending or rejected accounts retain the existing status-specific login response; incorrect credentials retain the
non-enumerating response.

Files:

- `system/server/src/persistence/operatorIdentityRepository.js`
- `system/server/src/persistence/fileOperatorIdentityRepository.js`
- `system/server/src/services/identityService.js`
- `system/server/test/unit/identityService.test.js`

WebSocket upgrades and message/session validation now resolve through the same async identity service. Each socket
keeps only a synchronously readable authorization snapshot for device adapter callbacks; the snapshot is refreshed
before message handling and by the session heartbeat. Account changes that can alter authorization suspend that
snapshot before refreshing it, so a WDA input cannot pass through the transition on stale grants. Concurrent
refreshes are coalesced and generation-ordered so an older lookup cannot restore stale access. Controlled-device
and read-only-watch sessions are both released when their access disappears.

No identity data was migrated. `operators.config.json` remains authoritative. Background task and assignment
authorization still uses the legacy synchronous `authStore.js` path because those callback contracts are currently
synchronous; converting them requires a separate queue/scheduler boundary rather than hiding asynchronous I/O in a
boolean callback.

### Background task, assignment, and research authorization identity resolution

The task queue's dispatch predicate, assignment target validation, and background task-access checks each
resolved a *different* operator's identity than the one already attached to the current request/connection
(the task's creator, an assignment's assignee) by importing `authStore.js#operatorByUsername` and
`researchAccess.js#researchWorkspaceFor` directly, in four separate places in `index.js` plus a fifth in
`researchTaskRunner.js`. These now share one boundary.

This boundary is deliberately synchronous, unlike the identity/session services above: the task queue's
`canDispatch` predicate and the assignment routes' inline validation both need an immediate answer, not an
awaited one. The resolvers behind it still read the same live in-memory operator registry and research
config as before. A future database-backed identity source must publish a synchronously readable, refreshed
snapshot behind this same boundary (mirroring the WebSocket identity snapshot above) rather than making the
task queue's dispatch loop itself async — that snapshot/refresh mechanism is explicitly deferred until an
actual async-backed identity source exists to refresh from.

Files:

- `system/server/src/persistence/backgroundAuthorizationRepository.js`
- `system/server/src/persistence/fileBackgroundAuthorizationRepository.js`
- `system/server/src/services/backgroundAuthorizationService.js`
- `system/server/test/unit/backgroundAuthorizationService.test.js`

`researchTaskRunner.js` gained an injectable `canAccessDevice` parameter (defaulting to the same
`authStore.js` implementation as before) alongside its existing `operatorForUsername`/
`workspaceForOperatorAccount` parameters, closing an inconsistency where two of the three authorization
resolvers were already dependency-injected but the third was a direct module import.

Deliberately left untouched: every `canAccessDevice(req.currentOperator, ...)` / `canAccessDevice(currentOperator(), ...)`
call site that checks the *current* request's or connection's own already-resolved operator (HTTP routes,
WebSocket handlers) — those are pure policy checks on an identity resolved elsewhere (already covered by the
HTTP/WebSocket identity slices above), not background identity resolution, and moving them would be
indiscriminate churn rather than a bounded slice.

No operator data was migrated. `operators.config.json` remains authoritative.

### Sites and site credentials

`system/server/src/persistence/siteRepository.js` + `fileSiteRepository.js` wrap the existing `SiteStore` class
(site identity and its hashed enrollment token together — DATABASE_GAP_ANALYSIS.md's proposed `sites`/
`site_credentials` split is a later migration-design decision, not something this interface slice changes).
`index.js`'s single `SiteStore` construction now goes through the adapter; `SiteLinkHub` receives the same
object and is unaffected since it only calls the three methods the adapter exposes. No site data was migrated.

### Device assignments and leases

`system/server/src/persistence/assignmentRepository.js` + `fileAssignmentRepository.js` wrap the existing
`createAssignmentStore` factory. Device **leases** are explicitly out of scope: `deviceLease.js` is an
in-process controller-mode state machine with no file store behind it — there is nothing to place a
repository interface around until it moves to shared/distributed backing (Redis, per ADR-0003), which is
later, separate work (M06), not this interface slice. No assignment data was migrated.

### Task queue snapshot (runs/checkpoints)

`system/server/src/persistence/taskQueueSnapshotRepository.js` + `fileTaskQueueSnapshotRepository.js` extract
the task queue's durable snapshot read/write (atomic write-with-retry, legacy-array migration, interrupted-task
recovery on load) out of `taskQueue.js` into its own persistence port; individual task runs and checkpoints
are fields on the persisted task record, so they moved with it. The queue's scheduling/eligibility/dispatch/
retry mechanics stayed in `taskQueue.js` unchanged — that is domain/scheduling logic, not a persistence
concern. `createTaskQueue({ storePath })` still works unchanged; `repository` is a new optional override for
tests or a future adapter. No queue data was migrated.

### Approvals, interventions, and research run/evidence metadata

`approvalRepository.js`/`fileApprovalRepository.js` wrap `ApprovalStore`; `interventionRepository.js`/
`fileInterventionRepository.js` wrap `InterventionQueue`; `researchRunRepository.js`/
`fileResearchRunRepository.js` wrap `researchStore.js`'s run/candidate/observation functions;
`researchEvidenceRepository.js`/`fileResearchEvidenceRepository.js` wrap `researchEvidenceStore.js`'s
screenshot save/resolve functions. All four are now used consistently by both the HTTP routes in `index.js`
and by `researchTaskRunner.js`'s existing dependency-injection parameters (previously index.js left those
parameters at their module-import defaults; now they're wired explicitly to the same repository instances the
HTTP routes use). `CommentLedger`, `TemplateLibrary`, and `PolicyStore` were left as direct class imports —
out of scope for this pass, candidates for a later slice if warranted. No approval, intervention, or research
data was migrated.

### Notifications, proxy pool, and device media (object metadata)

`notificationRepository.js`/`fileNotificationRepository.js` wrap `createAccountNotificationStore`.
`proxyPoolRepository.js`/`fileProxyPoolRepository.js` bind `proxyPoolStorePath` once instead of threading it
through 9 call sites in `index.js`; pure transforms that don't touch storage (`decryptProxyPassword()`,
`publicProxy()`) stay as direct `proxyPool.js` imports. `deviceMediaRepository.js`/
`fileDeviceMediaRepository.js` wrap `fileStore.js`'s per-device file operations; its path-safety validators
(`safeFilename`, `safeDeviceId`) stay direct since they're pure checks, not storage operations.

Deliberately out of scope: `proxyPoolStorePath` itself is still passed directly to `NetworkRoutingOrchestrator`
and `AutoNetworkEnrollment` (the physical PF/tunnel routing subsystem, a different and much larger concern —
M08 network isolation, not this slice) — those two constructors were not touched. `deviceNetworkStore.js`'s
`setDeviceProxyEnabled()` (a single call site mutating the shared `devices.config.json`, the same file the
broader device registry owns) was also left as a direct import rather than folded into a new repository, since
it isn't its own bounded store. `networkVerifier.js` has no persisted store at all — verification results are
computed live, not durable — so there is currently nothing to wrap for `network_verifications`; that gap is
DATABASE_GAP_ANALYSIS.md's to close at the schema-design stage, not something this slice fabricates
infrastructure for. No notification, proxy, or device-media data was migrated.

## M02 status

Every domain named in the original remaining-slices list (sites/credentials, device assignments/leases, task
queue/runs/checkpoints, approvals/interventions/research metadata, notifications/proxy/network metadata, and
object metadata) now has a repository interface in front of it, following the acceptance gates below. This
does **not** by itself mean M03 can begin: DATABASE_GAP_ANALYSIS.md's "first database slice" section requires
the identity/organization schema and tenant-negative tests to exist first, and those are M04-adjacent design
and implementation work that has not started — only the ADR-level direction (ADR-0006, ADR-0007) is accepted
so far. The persistence interfaces this document tracks are a precondition for that work, not a substitute
for it.

## Per-slice acceptance gates

- current file adapter remains authoritative;
- service/repository contract has direct tests;
- server entry point owns composition, not persistence details;
- HTTP and WebSocket behavior remains compatible;
- focused and complete suites pass;
- changed JavaScript entry points pass `node --check`;
- `git diff --check` passes;
- documentation names what changed and what did not.
