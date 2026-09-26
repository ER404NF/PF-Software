# M00 productionization baseline

Status: **complete for source and automated/local evidence**
Recorded: **2026-09-25 (Europe/Rome)**
Repository: `ER404NF/PF-Software`
Branch: `main`
Baseline commit: `8977091dff2d386e1a79aec833f5551d94f15762`

## Outcome

The repository is a substantial, security-conscious local control-plane and desktop product, not an empty
prototype. It already implements human and AI device-control paths, a durable task/research layer, remote site
agents, WDA/iproxy provisioning, proxy/network controls, and tested desktop packaging. The cloud business plane
described by the productionization documents does not exist yet: authoritative state remains local and
file-backed, tenancy is expressed through team/device/research grants rather than organizations, and there is no
PostgreSQL, Redis, object store, billing system, customer portal, or production mobile application.

**M01 may begin.** M01 must reconcile the proposed commercial domain with the implementation below and record
owner decisions without treating the proposed database schema as already approved. M02's persistence/service
interfaces must precede M03 store migration. No existing file store should be deleted or silently bypassed.

This document records implementation evidence. It does not claim real Mac mini/iPhone, live proxy routing,
signed distribution, deployed cloud, backup/restore, or commercial readiness.

## 1. Evidence and inspection method

The baseline was derived from the tracked tree and active code, with canonical project documentation used as
context. Historical material under `archive/`, `source-material/`, `research/`, and `graphify-out/` was not
treated as current implementation.

Inspected evidence included:

- the current Git ref and tracked tree;
- all JavaScript entry points under `system/server/src`, `system/client`, and `desktop`;
- server, desktop, deployment, installer, mobile, and GitHub Actions manifests;
- all current HTTP route declarations and both WebSocket protocols;
- persistence implementations and their default/overridable paths;
- role/capability definitions and authorization helpers;
- current device, provider, platform-skill, and research configuration;
- current roadmap/status, deployment, installer, network, and review documents;
- full server and desktop test suites, dependency audits, installer build, and packaged-runtime verification.

There is no `AGENTS.md` in the repository. `CLAUDE.md` exists and was inspected, but source and tests take
precedence where that document is stale or internally inconsistent.

## 2. Repository tree summary

| Area | Tracked files | Current purpose |
| --- | ---: | --- |
| `system/` | 246 | Express/HTTP/WebSocket control plane, browser/PWA client, file-backed state, device/network/AI logic, tests and scripts |
| `desktop/` | 47 | Electron host/client/site wrapper, dependency discovery, supervision, update gate, packaging and 18 desktop test files |
| `docs/` | 30 before this baseline | Product, deployment, security/reliability, release and review documentation |
| `archive/` | 12 | Non-canonical historical material |
| `source-material/` | 8 | Non-canonical input/reference material |
| `deploy/` | 5 | Docker/Caddy hub deployment |
| `mobile/` | 3 | Capacitor configuration and placeholder web shell only |
| `.github/` | 2 | macOS and Windows installer workflows |
| root files | 7 | README, architecture baseline, repository instructions and Git configuration |

Active implementation size at this baseline:

- `system/server/src/index.js`: **4,033 lines**;
- server source: **100 JavaScript files**;
- browser client: **8 HTML/CSS/JavaScript files** plus icons/manifest/service worker;
- desktop production/scripts: approximately **40 JavaScript/CJS/HTML files** excluding tests and generated output.

The only pre-existing working-tree item was the user-owned, untracked `.claude/settings.local.json`. It was not
read, modified, staged, or included in build output.

## 3. Architecture as implemented

```text
Browser/PWA or Electron client
        |
        | HTTPS/HTTP + authenticated operator WebSocket
        v
system/server/src/index.js (single Node/Express control-plane process)
        |
        +-- auth, RBAC, assignments, queue, research, audit and local file stores
        +-- local Device API -> MockDevice or WdaDevice
        +-- optional provisioning -> xcodebuild WDA + per-UDID iproxy
        +-- optional routing -> tun2proxy + narrow privileged PF/tcpdump operations
        +-- remote devices -> SiteLinkHub
                              ^
                              | outbound authenticated WebSocket /agent-link
                              |
                        Mac site agent
                              |
                        WDA / iproxy / iPhones
```

The Electron application has three modes:

1. **Host**: supervises the bundled server, stores state below Electron `userData`, enables automatic iPhone
   discovery/WDA provisioning, and opens the local web UI.
2. **Client**: opens an allow-listed HTTP(S) Phone Farm origin without exposing privileged setup preload APIs.
3. **Site**: supervises the site-agent process, which opens an outbound authenticated link to a hub.

The Mac/site boundary is correctly local for USB/WDA execution. No implementation moves raw USB or xcodebuild
execution to a public cloud.

## 4. Executable entry points

| Entry point | Responsibility |
| --- | --- |
| `system/server/src/index.js` | Main HTTP/WebSocket server, static client, sessions, authorization, fleet, queue, research and network wiring |
| `system/server/src/agentMain.js` | Remote Mac site agent using local discovery/provisioning and an outbound hub link |
| `desktop/main.js` | Electron lifecycle, update gate, setup IPC, host/site supervision, settings and window security |
| `system/server/scripts/run-tests.js` | Sequential complete server test runner used by `npm test` |
| `system/server/scripts/create-operator.js` | Local operator bootstrap/maintenance helper |
| `desktop/scripts/build-mac-pkg.cjs` | macOS `.app`/`.pkg` build, signing, notarization and verification orchestration |
| `desktop/scripts/prepare-runtime.cjs` | Allow-listed packaged server runtime staging |
| `desktop/scripts/verify-packaged-runtime.cjs` | Packaged dependency, forbidden-file and real server boot verification |

## 5. Persistent stores and configuration

### Authoritative local/file-backed state

| Domain | Default path or layout | Notes |
| --- | --- | --- |
| Operators, password hashes, grants, MFA/recovery metadata | `system/operators.config.json` | Ignored by Git; atomic replacement; no organization entity |
| Browser sessions | `system/storage/sessions/*.json` | Custom `express-session` file store |
| Audit | `system/storage/audit/events.log` | Append-oriented JSON lines |
| Task queue, holds and retry state | `system/storage/queue/tasks.json` | Atomic snapshot replacement |
| Model selections | `system/storage/models/selection.json` | Task/workspace/device provider choices |
| Assignments and recurrence history | `system/storage/assignments/assignments.json` | Atomic snapshot replacement |
| Account notification outbox/recovery content | `system/storage/notifications/accounts.json` | Sensitive recovery content encrypted when a key is configured |
| Sites and hashed enrollment tokens | `system/storage/sites.json` | Site token is returned once; digest persists |
| Proxy pool, encrypted credentials, leases and health | `system/storage/proxy-pool.json` | Requires the configured encryption key to use credentials |
| USB network mappings | `system/storage/usb-network.json` | Local interface/IP observations |
| Automatic device provisioning | `system/storage/device-provisioning.json` | UDID-to-logical-device and preferred-port records |
| WDA build data | `system/storage/wda-derived-data/` | Local generated build artifacts, not cloud business state |
| Research runs/candidates/dedup indexes | `system/storage/research/<workspace>/<account>.json` | One JSON document per workspace/account |
| Research evidence | `system/storage/research-evidence/<workspace>/<account>/` | PNG/JPEG/WebP bytes on the local filesystem |
| Research approvals | `system/storage/research-approvals.json` | Single-use approval lifecycle |
| Comment safety ledger | `system/storage/comment-ledger.json` | Duplicate/rate safety history |
| Comment templates | `system/storage/comment-templates.json` | Per-workspace approved templates |
| Action policy overrides | `system/storage/action-policy-overrides.json` | Runtime policy layer |
| Intervention queue | `system/storage/interventions.json` | Open/claimed/resolved human interventions |
| Per-device uploads/media | `system/storage/devices/<deviceId>/` | Quota-limited local bytes |
| Manual device/network configuration | `system/devices.config.json` or explicit path | Repository default contains mock fixtures; desktop auto mode intentionally ignores it |

Every path above has either a direct environment override or is rooted by `FILE_STORE_DIR`. The five research
control stores use `APPROVAL_STORE_PATH`, `COMMENT_LEDGER_PATH`, `COMMENT_TEMPLATES_PATH`,
`ACTION_POLICY_OVERRIDES_PATH`, and `INTERVENTION_STORE_PATH` when supplied.

### Desktop-local state

- `userData/desktop-config.json`: mode, server URL/port, generated local secrets, WDA team preference and site
  credentials; written with owner-only permissions.
- `userData/host-storage/`: desktop host equivalents of operator, queue, model, assignment, notification,
  provisioning, proxy, USB, research, evidence, session, audit and media stores.
- `userData/wda-source/`: managed writable copies of the bundled pinned WebDriverAgent source.
- Electron log directory: rotating, scrubbed diagnostic log.
- Update downloads: unique temporary directory; size and SHA-256 verified before opening.

### Static configuration, not authoritative runtime state

- `models.config.json`: provider definitions and credential environment-variable names; currently empty.
- `platform-skills.config.json`: Instagram/Reddit/X skill enablement; currently empty.
- `research.config.json`: research account/workspace ownership and policies; currently empty.
- `devices.config.json`: two mock devices with fail-open fixture network policies.
- `desktop/wda.lock.json`: pinned upstream WDA repository/tag/commit.

### Memory-only state

Presence, login/recovery/signup throttles, current human owners, active device lease transitions, network
verification cache, stream subscribers, pending site RPCs, enrollment snapshots, spend totals, and live process
health are process-local. This prevents horizontal scaling and makes some protections reset on process restart.

### Existing local artifacts

Ignored local `system/storage` contains runtime/test remnants (audit/queue/session/UI-review files). Their names
were inventoried, but their contents were deliberately not opened or copied into this document because they may
contain account/session data. Production migration tooling must never treat arbitrary local remnants as trusted
input without validation and a migration manifest.

## 6. HTTP API inventory

The server declares **73 HTTP routes**. Major families are:

| Family | Implemented operations |
| --- | --- |
| Health/static UI | `GET /healthz`, static browser/PWA assets |
| Signup/bootstrap/auth | signup, first-admin creation, login/logout, current profile |
| MFA and recovery | TOTP setup/confirmation/verification, recovery receipt acknowledgement, email recovery request/completion |
| Audit and people | filtered audit events and role-safe presence/assignment summaries |
| User administration | list/create/update/review/rename, revoke sessions, reset 2FA, notification status |
| Assignments | list, create, update/status/reschedule |
| Device observation/files | monitor contract, diagnostics, list/upload/download/delete media |
| Device network | run network checks and change legacy per-device proxy enablement |
| Sites | create/list/update/delete and rotate enrollment tokens |
| Proxy pool | list/create/delete/test and assign pool proxies to devices |
| Routing/enrollment | start/confirm USB enrollment, discover phone IP, start/stop routing |
| Research | accounts, evidence, runs, candidate review, policies, templates, approvals, search and reports |
| AI fleet | fleet state, analytics and human interventions |
| Queue/commands | submit parsed commands and list durable tasks |

All sensitive APIs are mediated by authenticated operator resolution plus explicit capabilities and resource
checks. The health endpoint is intentionally unauthenticated and reveals only `{ ok: true }`.

## 7. WebSocket inventory

### Operator control WebSocket

The operator socket reuses the HTTP session middleware during upgrade, rejects unauthenticated upgrades, caps
payloads at 64 KiB, re-resolves the current operator for live authorization, and serializes input per connection.

Client message families:

- device ownership: `select_device`, `release_device`;
- read-only monitoring: `watch_device`, `refresh_watch`, `stop_watching`;
- screen transport: `refresh_screen`, `start_stream`, `stop_stream`;
- deterministic input: `tap`, `swipe`, `drag`, `long_press`, `double_tap`, `home`, `type_text`;
- AI control: `switch_to_ai`, `takeover`, `emergency_stop`;
- legacy task control aliases: `pause`, `resume`, `stop`, `pause_task`, `resume_task`, `stop_task`.

Server message families include live operator profile, fleet/presence snapshots, screenshot/live-view frames and
errors, stream lifecycle/state, watch frames, action acknowledgements, selection/watch results, and structured
errors. Live screenshots are server-cadence-limited and do not share an overlapping WDA session mutation with
input.

### Site-agent WebSocket (`/agent-link`)

- outbound connection from the site;
- `x-site-id` plus bearer enrollment token authentication;
- protocol version `1`;
- agent messages: `hello`, `devices`, `rpc_result`, `stream_state`, and binary image frames;
- hub messages: `rpc`, `stream_open`, `stream_close`;
- allow-listed RPC methods only: tap, swipe, drag, long press, double tap, type text, Home, render and UI tree;
- no arbitrary remote shell or generic command execution;
- remote fleet IDs are `<siteId>__<localId>` while raw local IDs remain site-scoped.

The protocol has reconnect, heartbeat, timeout, revocation and version rejection, but no durable command
idempotency ledger, cryptographic message-level replay protection, mTLS identity, or rolling compatibility range.

## 8. Authentication and sessions

- Passwords use Node `crypto.scrypt` with a random 16-byte salt and constant-time comparison.
- Password length is constrained to 12-512 characters.
- Browser sessions are file-backed, HTTP-only, SameSite=Lax, 24 hours, and secure when deployment is HTTPS.
- Production startup requires a strong `SESSION_SECRET`; public bind without secure-cookie conditions is rejected.
- TOTP secrets are encrypted; recovery codes are stored as digests.
- Recovery tokens are stored hashed in the operator store; notification delivery content is encrypted when the
  notification/2FA master key is configured.
- Login, second factor, recovery and signup have process-local throttles.
- Role/status/grant changes are re-resolved against the live operator registry; stale sessions do not retain old
  authorization.
- Session revocation increments authentication state and closes matching live sockets.

Missing commercial identity functions include verified general email ownership, organization membership and
invitations, session listing per user, distributed throttling, external identity/SSO, formal deletion workflows,
and organization-scoped identity records.

## 9. Roles, capabilities and resource authorization

Current roles:

```text
admin
manager
va
content_creator
editor
```

The implementation defines 25 explicit capabilities across fleet viewing/control, media, research, assignments,
queue/global queue, AI control, network checks, audit, models, users/team/access, proxies, provisioning, routing,
security, monitoring, sites, action policy and approvals. Admin receives every capability; lower roles receive
explicit allow-lists.

Capabilities do not replace resource authorization:

- device access uses `allowedDevices` and fails closed for a VA with no explicit grant;
- research access uses current `allowedResearchWorkspaces` plus account ownership;
- manager user/assignment/queue visibility is team-scoped;
- audit output is filtered by accessible device;
- UI hiding is supplementary; server routes and socket messages enforce the same boundaries.

The proposed production Owner/Billing Admin/Researcher/Reviewer roles and organization membership model are not
implemented. Existing role names and team semantics require explicit reconciliation rather than direct renaming.

## 10. Device and WDA architecture

- Device adapters are `MockDevice`, `WdaDevice`, and hub-side `RemoteDevice`.
- Unsupported types, malformed WDA endpoints, duplicate logical IDs, duplicate UDIDs and duplicate forwarded
  endpoints fail startup rather than becoming mocks.
- Automatic discovery uses `idevice_id`/`ideviceinfo` on macOS.
- `DeviceProvisioner` manages one WDA `xcodebuild` process and scoped `iproxy -u <UDID>` tunnels per phone.
- Control and MJPEG ports are allocated per phone and preferred ports are persisted for reconnect.
- Known trust, Developer Mode, signing and Apple App ID failures become actionable `user_action_required` states.
- Detaching one phone stops only its own WDA/tunnels; reconnect reuses identity and safe preferred ports.
- WDA sessions are coalesced/serialized, time-bounded and invalidated on failures.
- Authorization is rechecked after awaited preparation and immediately before physical input.
- Device ownership uses explicit human owners plus the shared human/AI lease state machine.
- Browser control supports tap, swipe, drag, long press, double tap, typing and Home.
- Screen observation supports WDA MJPEG streaming where configured and bounded screenshot/live-view fallback.

The tracked `devices.config.json` is a development fixture. Production deployment validation rejects mock devices,
and Electron automatic mode avoids loading that default file so discovery can populate a fresh installation.

## 11. Site architecture

The hub stores sites and hashed enrollment tokens. A Mac site agent validates its hub URL, refuses non-loopback
plain HTTP unless explicitly allowed for development, discovers/provisions local phones, and connects outbound.
The hub materializes each advertised phone as a `RemoteDevice`, preserves site isolation, rejects attempts to
shadow hub-local IDs, and removes/offlines devices on link loss or site deletion. Token rotation disconnects the
old agent immediately.

This is a useful local/cloud boundary to preserve. Production work should harden identity, replay/idempotency,
rolling-version compatibility, correlation/audit, and upgrade orchestration without introducing a generic shell.

## 12. Proxy and network architecture

Implemented locally:

- device network declarations and safe public summaries;
- encrypted proxy-pool credentials and per-device assignment leases;
- active proxy tests with classified errors;
- device-originated network verification and collision detection;
- explicit fail-closed access decisions for proxy-required devices;
- USB bridge enrollment and traffic-derived iPhone IP discovery;
- opt-in `tun2proxy` process management;
- narrow `sudo -n` boundary for PF/tcpdump operations;
- per-device PF/routing state, health checks and isolated recovery;
- optional Internet Sharing automation and optional network enrollment.

Not production-complete:

- `proxyProvider.js` is only a vendor-neutral contract; provider health and rotation are not implemented;
- current tracked mock configuration uses `fail-open`, suitable only for diagnostics/fixtures;
- macOS Internet Sharing automation relies on platform behavior that still needs physical verification;
- DNS, WebRTC, IPv6, route-kill and two-phone isolation require the documented real-device acceptance run;
- live vendor/self-hosted proxy credentials and accounts are not configured.

No code or UI may claim `PROTECTED` based only on host/tunnel state; device-originated egress verification remains
the deciding evidence.

## 13. AI and research architecture

The repository contains more than an AI placeholder:

- provider-neutral `observeAndPlan` contract;
- Anthropic and OpenAI-compatible adapters;
- config-driven provider registry with environment-referenced credentials;
- provider selection by task/workspace/device;
- durable task queue, retries, windows, dependencies, priorities, checkpoints and restart recovery;
- research worker/session runner and platform skill registry;
- Instagram, Reddit and X accessibility-based skills;
- structured model-decision validation;
- action policies (`ALLOW_AUTONOMOUS`, `REQUIRE_APPROVAL`, `DISABLED`);
- single-use, exact-action approvals;
- comment duplicate/rate/content guards and template library;
- research evidence, candidates, cross-run deduplication and human review;
- intervention queue, human takeover and emergency stop;
- optional optimization modules for routing, pacing, state caching and analytics.

Current default configuration contains no providers, research accounts or enabled platform skills, so live AI
research fails closed. Provider spend tracking is process-local and no commercial quota/entitlement service
exists. Real-platform labels/actions and prompt-injection resistance are not physically/red-team accepted.

## 14. Desktop architecture and releases

- Electron runs with `contextIsolation=true` and `nodeIntegration=false`.
- Privileged setup IPC is available only to the packaged local setup frame; remote app/client content receives no
  privileged preload.
- Navigation and new-window behavior are allow-listed.
- Host mode uses Electron's bundled Node runtime and a separately staged allow-listed server runtime.
- Finder-safe macOS discovery searches PATH, `/opt/homebrew/bin`, `/usr/local/bin`, and system paths for Xcode,
  libimobiledevice, iproxy and `tun2proxy`/`tun2proxy-bin`.
- WebDriverAgent is resolved from an explicit path, persisted/home checkout, or pinned bundled source.
- Host/site processes are supervised, restarted with backoff, logged, kept awake and optionally launched at login.
- Packaged startup uses a mandatory stable-release version gate. Refusal or failed lookup/download/digest
  verification exits before any host, site or client window starts.

Current public release: **v0.2.2**. It contains `Phone-Farm-Windows.exe` (113,612,453 bytes; GitHub asset digest
`sha256:260f1be62cd02619243e584a396458246a2dca156e179acc889bd33c76df088b`). The latest code-bearing branch
workflows at `e309c64` passed on both Windows and macOS.

The macOS arm64 package was built, installed and boot-tested on GitHub's macOS runner as an **unsigned** Actions
artifact. No stable `Phone-Farm-macOS.pkg` is published because Developer ID and notarization credentials are not
configured. Windows packaging also currently produces an unsigned executable.

## 15. Mobile state

`mobile/` is a three-file Capacitor scaffold:

- no `package.json` or lockfile;
- no generated iOS or Android native projects;
- placeholder hub URL;
- no native secure credential storage, notifications, deletion UX, store metadata, signing or physical tests.

The browser client is installable as a PWA, but the repository must not describe the mobile scaffold as a native
production application.

## 16. Deployment state

`deploy/hub` supplies a Node container behind Caddy with automatic HTTPS. The server volume persists
`system/storage`; environment configuration provides public URL, session secret, scheduling timezone and SMTP.
Tests boot the production-style hub, require a strong secret, reject unsafe public HTTP/session-cookie
configuration, and exercise an authenticated site link.

Missing production infrastructure includes PostgreSQL, Redis, object storage, secret/KMS integration,
declarative cloud environments, database/object backups, restore automation, HA, centralized telemetry,
production domain/status/support surfaces and measured RPO/RTO.

## 17. CI and release state

Two GitHub Actions workflows exist:

- macOS: full server tests under `TZ=Asia/Tokyo`, desktop tests, dependency audits, optional signing/notarization,
  `.pkg` build, independent verification, clean-runner installation, packaged server boot and artifact upload;
- Windows: full server/desktop tests, NSIS installer build and artifact/release upload.

Tagged releases require the tag to equal the desktop version. macOS tagged release fails closed without complete
signing/notarization unless an explicitly allowed unsigned release is requested. The stable macOS alias is never
assigned to an unsigned/not-notarized package.

Gaps: no general server/unit CI workflow independent of installer paths, no PostgreSQL migration/test service, no
container image publication/deployment pipeline, no Windows code signing, no signed update channel metadata, and
no production smoke/rollback environment.

## 18. Tests discovered and executed

### Discovered

- server: **107** test files (**27 integration**, **80 unit**);
- desktop: **18** test files;
- additional soak/demo/benchmark scripts exist but are not part of the required full suite.

### Executed on 2026-09-25

| Command | Result |
| --- | --- |
| `cd system && npm.cmd test` | **107 files, 1,143 tests, 1,143 passed, 0 failed, 0 skipped** |
| `cd desktop && npm.cmd test` | **159 passed, 0 failed, 0 skipped** |
| `cd system && npm.cmd audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `node desktop/scripts/audit-gate.cjs --dir system` | passed; 0 shipped/build-only findings |
| `node desktop/scripts/audit-gate.cjs --dir desktop` | passed; 0 shipped/build-only findings |
| `cd desktop && npm.cmd run dist:win` | passed after rerun with normal npm-cache access |
| packaged runtime verifier against `desktop/dist/win-unpacked/resources` | passed; real bundled server boot verified |

Local Windows artifact:

```text
desktop/dist/Phone-Farm-Windows.exe
size: 114,285,365 bytes
sha256: E10A397091ADE404A6D2EFE713CAF4B8A9375A195CFF8771612C40EE35CDFBC2
Authenticode: NotSigned
```

The first sandboxed build attempt failed before packaging because Windows denied access to npm's user cache and a
staged dependency directory (`EPERM`). The identical build rerun with normal host cache access succeeded. This is
recorded as an execution-environment limitation, not an application failure.

## 19. Failures and unverified boundaries

No automated test or dependency-audit failures remain at this baseline.

Still unverified or unavailable:

- physical Mac mini launch from `/Applications` with two trusted iPhones;
- WDA signing, trust/Developer Mode failure UX and automatic recovery on the target Mac;
- tap/swipe/type/Home and stream/screenshot latency on both physical phones;
- disconnect/reconnect while the other phone remains operational;
- live proxy provider accounts and real route/egress controls;
- DNS, WebRTC and IPv6 leak behavior;
- signed/notarized macOS installation and upgrade;
- signed Windows installation, upgrade, uninstall and SmartScreen behavior;
- deployed public HTTPS, SMTP delivery and authenticated multi-role browser acceptance;
- real AI model providers and real-platform skills;
- backup/restore and disaster-recovery objectives;
- native iOS/Android builds and store review.

## 20. Security-sensitive code paths

| Boundary | Principal files |
| --- | --- |
| Passwords, operator mutation, MFA/recovery | `authStore.js`, `twoFactor.js`, `recoveryThrottle.js`, account routes in `index.js` |
| Sessions and live revocation | `fileSessionStore.js`, session/upgrade middleware in `index.js` |
| Capabilities and device/research grants | `roleCapabilities.js`, `researchAccess.js`, authorization helpers in `index.js` |
| Physical input ownership | `deviceLease.js`, WDA authorization callbacks, WebSocket handlers |
| Upload/download isolation | `fileStore.js`, `mediaUploadQuota.js`, device file routes |
| Site identity and remote command boundary | `siteStore.js`, `siteLink.js`, `siteAgent.js`, `siteProtocol.js` |
| Proxy credentials and routing | `proxyPool.js`, `tunManager.js`, `privilegedOps.js`, `networkRoutingOrchestrator.js` |
| Network safety decision | `networkVerifier.js`, `networkPolicy.js`, `networkCheckTarget.js` |
| AI/model trust and approvals | `modelProvider.js`, provider adapters, `actionPolicy.js`, `approvalStore.js`, `researchWorker.js` |
| Desktop privilege/origin boundary | `windowSecurity.js`, `preload.js`, privileged IPC handlers in `main.js` |
| Installer/update trust | `autoUpdate.js`, packaging/verifier scripts, release workflows |

## 21. Secrets and configuration inventory

Secret values must remain outside source control. Current sensitive inputs include:

- `SESSION_SECRET`, `TWO_FACTOR_MASTER_KEY`, `ACCOUNT_NOTIFICATION_ENCRYPTION_KEY`;
- `PROXY_CREDENTIAL_ENCRYPTION_KEY` and encrypted proxy credentials;
- `SMTP_USER`, `SMTP_PASS`;
- provider keys referenced indirectly by `credentialEnv` entries;
- `SITE_TOKEN` and desktop-persisted site enrollment token;
- Apple signing/notarization credentials and certificates;
- future Windows signing credentials.

Operational/non-secret configuration includes bind/public URL, timezone, store paths, WDA/tool paths, WDA team
and bundle ID, port ranges, discovery/provisioning switches, optimization knobs, routing switches/interfaces,
network verification targets/ages, stream interval and signup limits.

Existing protections:

- ignored local account/runtime state;
- owner-only desktop settings;
- hashed site/recovery tokens where plaintext retrieval is unnecessary;
- encrypted TOTP/proxy/recovery-delivery material;
- packaged-runtime deny-list for accounts, storage, `.env`, keys, tests and fixtures;
- diagnostic redaction and configuration-name-only reporting.

Production gaps: secrets are still environment/local-file supplied rather than KMS-backed references; there is no
rotation service or organization-scoped secret authorization/audit plane.

## 22. Technical debt and document/code discrepancies

1. `index.js` is a 4,033-line composition root plus route/controller implementation. Incremental extraction is
   required; a one-shot rewrite would endanger proven authorization and device sequencing.
2. File-backed stores have good atomic-single-file patterns, but cross-store workflows still require compensation
   and cannot provide database transactions.
3. No explicit organization tenant exists. Current `teamId`, device grants and research workspace ownership are
   narrower concepts and cannot simply be relabeled as organizations.
4. Process-local throttles, presence, spend and active coordination prevent safe horizontal scaling.
5. `proxyProvider.js` advertises a future contract only; no operational provider health/rotation implementation is
   registered.
6. Billing, entitlements, invitations, customer portal, lifecycle deletion and commercial support/legal surfaces
   are absent.
7. Observability is local logs/diagnostics plus health state; there are no centralized metrics, traces, crash
   reporting or incident backend.
8. The current update gate is strict and digest-verified, but release signing is incomplete on both platforms.
9. The site protocol is intentionally typed and narrow, but needs production identity, durable idempotency and
   compatibility/upgrade design.
10. `fileStore.js` still contains a comment claiming real VA authentication does not exist; authentication and
    resource authorization are now implemented. The comment is stale documentation, not current behavior.
11. `CLAUDE.md` describes AI VA as future-only even though a bounded research worker/runtime now exists. It also
    contains a permissive statement about challenge bypass/account farming that conflicts with `Architecture
    Baseline.md` and the production safety model. M01 must explicitly resolve the canonical security/product
    position; production work must keep challenge states as human handoff.
12. `docs/CODING_ROADMAP_STATUS.md` is chronological and retains obsolete historical statements (including older
    test counts and a DMG-era claim). It should not be read as a single current-state specification.
13. The proposed PostgreSQL document is a target blueprint, not evidence that its entity names, role model,
    PostgreSQL 18 dependency or every proposed table is required now.

## 23. Migration risks

- Existing identities use usernames, logical device IDs, site IDs and composite remote IDs; mapping them to UUIDs
  must preserve audit/history and device continuity.
- Current records denormalize and embed history (queue snapshots, assignment history, research runs/candidates).
  Naive row import would lose ordering, review state or dedup aliases.
- User rename currently spans operator, assignment and task stores through compensation. Dual-write migration can
  make this worse unless a service boundary and transactional destination are introduced first.
- Device leases combine durable task/hold state with process-local active input. Database authority must not add
  latency or permit stale owners to execute physical input.
- Site links can reconnect while commands/streams are in flight. Cloud persistence needs idempotent command IDs and
  ownership generations before multi-process dispatch.
- Audit is append-oriented and may contain actors/resources that no longer exist. FKs must not erase necessary
  security history.
- Evidence and device media are path-based. Object migration needs checksums, opaque keys, ownership metadata and
  reconciliation before local bytes are removed.
- Secret-bearing records cannot be copied as ordinary columns. Proxy/site/provider material needs references,
  rotation and revocation semantics.
- A dual-read/dual-write period needs explicit authority and rollback rules; two authoritative stores are worse
  than one file store.
- Tenant context in pooled PostgreSQL connections must be transaction-local and tested against connection reuse.
- Redis loss must not release/duplicate authoritative leases, approvals, billing state or tasks.
- Backup claims cannot be made from configuration alone; restore must reconcile database rows, object data and
  secret references.

## 24. Recommendation for M01

**Proceed to M01 with the following constraints:**

1. Preserve the Mac/site execution boundary, Device API, lease generation checks, fail-closed network decision,
   typed site protocol and existing security regression suite.
2. Create ADRs and reconciled domain/trust/data-classification models before introducing PostgreSQL dependencies.
3. Define `Organization`, optional `Workspace`, existing `teamId`, site and research-account relationships
   explicitly; do not infer tenant ownership from client input.
4. Decide which current local stores remain legitimate site-agent/appliance state and which become cloud
   authority.
5. Design service/persistence interfaces in M02, then migrate one domain at a time with parity, idempotency,
   cross-tenant and rollback tests.
6. Treat pricing, billing provider, legal publisher/domain, licensing, retention, data residency, native-mobile
   launch scope and distribution route as `OWNER DECISION REQUIRED`.

The safest first M01 deliverables are the cloud/site boundary ADR, tenancy vocabulary/domain map, data
classification, trust-boundary map and threat model. Database table creation should wait for those decisions and
the separate database gap analysis required by the schema proposal.

