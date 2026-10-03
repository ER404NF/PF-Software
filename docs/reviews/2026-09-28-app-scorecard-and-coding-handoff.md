# Phone Farm app scorecard and coding handoff

Date: 2026-09-28

## Scope and evidence

This is a fresh review of the current uncommitted checkout, including the web
client, server, desktop host, WDA/device path, AI VA path, proxy layers,
deployment work, and mobile scaffold. Scores mean:

- **9-10:** strong and proven for the claimed environment;
- **7-8:** solid implementation with bounded gaps;
- **5-6:** useful but materially incomplete or weakly validated;
- **3-4:** early or blocked by missing operational work;
- **0-2:** absent, scaffold-only, or unproven for the claimed purpose.

Evidence rerun for this review:

- server: **179 files, 1,424 tests, 1,392 passed, 0 failed, 32 skipped**;
- desktop: **159/159 passed**;
- system and desktop production dependency audits: **0 vulnerabilities**;
- `git diff --check`: pass;
- `HEAD` is `8073f8a89e44f9c567114f470e7e24005c6c8a99` and matches
  `origin/main`;
- real local browser at a 1536x816 full-screen viewport: the 90x160 fake-WDA
  stream rendered at **364.73x648.40**, preserved its 0.5625 aspect ratio, and
  kept the status bar, exit control, bezel, and Home control visible;
- sampled visible Operations controls had accessible names; the command input
  is now exposed as **Command**;
- the working tree before this report contained **66 changed paths: 39 modified
  and 27 untracked**. This report adds one more untracked path.

The 32 skipped server tests are explicitly gated external PostgreSQL/Redis
cases. A mounted PostgreSQL site-repository test exists, but no
`TEST_DATABASE_URL` was configured for this run.

## Headline assessment

| Area | Previous | Current | Verdict |
|---|---:|---:|---|
| Local software engineering and safety | 8.0 | **8.5/10** | Strong fail-closed behavior, attack controls, media validation, and regression discipline |
| Current operator experience | 6.5 | **7.5/10** | The major live-screen sizing defect is fixed; Operations remains dense |
| Production operations readiness | 4.5 | **5.0/10** | A reversible PostgreSQL slice and provider control plane now exist, but deployment, backup, monitoring, and physical acceptance remain open |
| Mobile-store readiness | 1.0 | **1.0/10** | Still a scaffold without native release packages or store/privacy completion |
| **Overall** | 6.0 | **6.5/10** | A capable, security-conscious beta with stronger local proof; still not a production-complete fleet service |

## Detailed ratings

| Parameter | Score | Current evidence and limit |
|---|---:|---|
| Usability and learnability | **7.5/10** | Fleet, Assignments, Operations, device status, and role context are understandable. Full-screen device use is now practical. Operations is still a long page with many unrelated controls. |
| UI cleanliness and consistency | **7/10** | Cohesive theme, predictable cards and statuses, and useful responsive behavior. Dense device facts and the long admin surface reduce scanability. |
| Information architecture | **6.5/10** | Fleet, Assignments, and Operations form a clear shell, but command, queue, applications, users, sites, proxies, provider exits, and audit share one scrolling workspace. |
| Role-specific experience | **8/10** | Host, Admin, Manager, VA, Content Creator, and Editor have capability-driven UI and server enforcement. Fleet visibility remains distinct from device control. |
| Accessibility | **7/10** | Labels, live regions, focus states, reduced motion, switch semantics, and the Command accessible name are present. The sampled Operations controls were named; a complete WCAG keyboard, screen-reader, contrast, and per-role audit has not passed. |
| Live phone screen and input | **8/10 code/browser** | Full-screen contain-fit now upscales low-resolution portrait video correctly and refits on resize/rotation. Tap, drag, wheel, keyboard, and Home mapping have focused coverage. Physical iPhone latency, FPS, rotation, and multi-device behavior remain unproven. |
| Core feature completeness | **8.2/10** | Fleet, assignments, roles, queue, audit, research/review, sites, proxy pool, device control, onboarding, 2FA, email hooks, media, and device-push code exist. Advanced paths still need real services and hardware. |
| Authentication and session security | **9/10** | Scrypt hashing, constant-time comparison, TOTP/recovery, throttling, secure-cookie policy, CSRF origin checks, session invalidation, and live identity refresh are implemented and tested. |
| Authorization and isolation | **8/10** | Capabilities, device/workspace grants, live revocation, lease generations, async rechecks, and server-side enforcement are strong. Most durable domains still use file authority. |
| Resistance to web/API attacks | **8.5/10** | Helmet/CSP with reports, rate limiting, CSRF checks, strict validation, hostile-input/fuzz coverage, bounded fields, bans, and fail-closed configuration exist. This is not an external penetration test or a distributed rate-limit deployment. |
| Information and secret safety | **7.5/10** | Proxy/recovery secrets use authenticated encryption, reusable tokens are hashed, responses omit credentials, and logs/packages avoid known secret forms. Production KMS or secret-manager operation is not implemented. |
| Privacy, retention, deletion, and export | **3/10** | Classification and threat-model work exists, but retention periods, account deletion/anonymization, verified evidence cleanup, data export, and a public deletion-request flow are not implemented. |
| Upload and media safety | **9/10** | Safe paths, quotas, cleanup, extension/MIME matching, and bounded magic/container signature checks now reject spoofed media before commit while preserving prior files. Malware scanning/quarantine and object lifecycle remain infrastructure decisions. |
| Device file push | **5/10 code** | Single-use hashed links, narrow download route, Safari-driving skill, bounded orchestrator, authorization rechecks, audit events, and explicit outcomes exist. Safari/Files accessibility labels and successful delivery are unverified on a real iPhone. |
| Reliability and error recovery | **8.5/10** | Strong fail-closed behavior, bounded retries, stale-authorization checks, process supervision, stream reconnect/freeze handling, queue recovery, and user-facing retry states. |
| Data durability | **7.5/10** | Atomic local persistence plus PostgreSQL repositories, migrations, RLS tests, and migration tools exist. Sites now have a reversible runtime `file|postgres` authority switch; eight other durable domains remain file-authoritative and the real deployment cutover has not run. |
| Backup and disaster recovery | **1/10** | No running backup policy, PITR proof, reconciled object/file restore, measured RPO/RTO, or restore drill. |
| Observability and incident response | **3/10** | Health endpoint, audit events, CSP reports, diagnostics, and rotating desktop logs exist. Central metrics, tracing, alerting, SLOs, paging, and a practiced incident workflow do not. |
| AI VA safety controls | **8/10** | Bounded actions, fresh observations, policy gates, quotas, exact approvals, evidence, challenge handoff, emergency stop, and provider schema validation are implemented. |
| AI VA live readiness | **3/10** | Adapters and workers are locally tested, but an approved real provider/account/app configuration and supervised real-iPhone read-only gate have not passed. Platform-visible actions should remain disabled until that proof exists. |
| Proxy pool and per-device routing | **7/10 code** | Encrypted upstream credentials, test/add/delete, exclusive device leases, tun2proxy/PF orchestration, fail-closed state, health checks, and device-originated verification contracts exist. Real Mac/two-phone routing and leak acceptance remain open. |
| Proxy-provider control plane | **6/10 local** | Exit inventory, region, enable/disable, normalized health, capacity, exclusive lease/release/rotation, strict configuration, audited APIs, role-aware UI, safe identifiers, and a deterministic adapter now exist. Lease state is in-process and only the deterministic adapter is implemented. |
| Fully owned live proxy network | **2/10** | There are no deployed regional exit nodes/IP supply, real provider adapter, durable lease authority, metering, abuse operations, node monitoring, or proven phone egress through owned exits. The current work must not be described as an Oxylabs-like live service yet. |
| Desktop install, update, and release | **6.5/10** | macOS/Windows workflows, dependency checks, WDA bundling, signed-update checks, diagnostics, and acceptance instructions are substantial. A current signed/notarized clean-machine Mac release with iPhones has not passed. |
| Automated test discipline | **9/10** | The fresh server and desktop suites are green, both production dependency audits are clean, and focused regressions cover the new screen, upload, provider, and durability behavior. Infrastructure-backed skips still need real services. |
| Maintainability | **5.5/10** | Focused services and repositories are improving boundaries, but `server/src/index.js` is about 4,786 lines and `client/app.js` about 4,600 lines. The current change set and dual authority modes increase review risk. |
| Mobile App Store / Google Play | **1/10** | No pinned complete mobile build, generated native release projects, secure enrollment flow, privacy manifest/Data Safety implementation, account deletion, signed archive/AAB, or store-device acceptance. |
| Physical hardware and scale evidence | **4/10** | Earlier proxy behavior was reported, and the physical checklist is now precise. Current live-screen, file-push, installation, two-phone isolation, fail-closed route kill, restart, and soak acceptance still need direct observation. |
| Git and release hygiene | **3.5/10** | `HEAD` matches `origin/main` and the diff is whitespace-clean, but the reviewed behavior lives across 67 working-tree paths after this report. It is not yet a clean, reproducible revision or pushed release candidate. |

## What the app can do now

- Authenticate operators with role and grant enforcement, TOTP/recovery, live
  session revocation, application review, account management, and audit trails.
- Present a multi-site fleet, assignments, health and routing state, human/AI
  ownership, live phone video, normalized input, keyboard input, Home, media
  workspaces, and remote site links.
- Stage and validate media, issue single-use phone download links, and drive a
  bounded Safari/Files push flow that still needs real-iPhone acceptance.
- Queue supported work and run a guarded AI research loop with evidence,
  budgets, policy decisions, human approvals, challenge handling, and takeover.
- Store and test upstream proxy credentials, lease a proxy per device, manage
  tun2proxy/PF state, and require device-originated egress verification before
  treating a route as protected.
- Configure and administer a local proxy-provider control plane with regions,
  capacity, health, enable/disable, lease, rotate, and release operations.
- Package desktop-host workflows for Mac and Windows, supervise WDA/iproxy
  processes, and expose diagnostics and first-run dependency guidance.

It cannot yet prove low-latency physical iPhone control, operate a real owned
regional proxy network, recover a production deployment from backup, complete
privacy deletion/export, run a supervised live AI VA, or ship through either
mobile store.

## Highest-to-lowest next steps

1. **Make the candidate reviewable.** Inventory all 67 current paths, remove
   only confirmed runtime/generated artifacts, review the complete diff, rerun
   all checks, and create one or more understandable commits. Do not claim that
   `origin/main` contains the reviewed features until those commits are pushed.
2. **Run the real Mac mini plus iPhone acceptance checklist.** Prove clean
   install, WDA signing/start, iproxy, live-screen FPS/latency/rotation/input,
   Safari file push, reconnect/restart, and a 30-minute soak.
3. **Prove two-phone routing isolation.** Assign distinct proxies, verify egress
   from each phone, test DNS/WebRTC/IPv6 leakage, kill each tunnel, and prove
   fail-closed behavior without cross-device leakage.
4. **Deploy one controlled environment.** Use the documented rollout, TLS,
   approved secrets, external health checks, and rollback. This unlocks real
   email, backup, observability, database, and remote-site proof.
5. **Continue reversible PostgreSQL authority cutover.** Exercise the current
   site slice against a real test database, then migrate one durable domain at a
   time with fail-closed authorization and rollback evidence.
6. **Implement backup, restore, and monitoring.** Choose RPO/RTO, automate
   database/file reconciliation, perform a disposable restore drill, and add
   centralized metrics, alerts, and an incident runbook.
7. **Implement privacy lifecycle support.** Add owner-approved retention,
   account deletion/anonymization, token/session revocation, media/evidence
   cleanup, data export, and a public request path.
8. **Build the real proxy provider behind the new contract.** Select the first
   approved regional node/IP architecture, implement a real adapter and durable
   leases, then add metering, health, monitoring, abuse handling, and physical
   egress/leak proof. Keep the current UI disclaimer until routing is verified.
9. **Run the supervised AI VA gate.** Configure one approved provider/account
   outside source control, pass read-only navigation and evidence persistence
   on a real iPhone, prove challenge/revocation/budget/emergency stops, then
   enable one reversible action at a time.
10. **Split and audit the UI/codebase.** Give Operations clear subsections,
    complete per-role accessibility testing, and extract bounded controllers
    from the two largest files without changing authority semantics.
11. **Start store delivery only after the host product stabilizes.** Add native
    iOS/Android projects, secure enrollment, privacy disclosures and deletion,
    signed builds, TestFlight/closed testing, and store metadata.

## Copy/paste handoff prompt for the coding agent

```text
Work in C:\Users\404de\Desktop\PHONE FARM on branch main. First read CLAUDE.md,
docs/reviews/2026-09-28-app-scorecard-and-coding-handoff.md,
docs/CODING_ROADMAP_STATUS.md, docs/MAC_INSTALLER_ACCEPTANCE.md,
docs/ROLE_CAPABILITY_MATRIX.md, and docs/productionization/THREAT_MODEL.md.
Preserve every existing modified and untracked file. Do not reset, discard,
overwrite, commit, or push work unless the owner explicitly directs that Git
action.

Use this loop until all locally eligible work is complete:
look for bugs/errors -> fix any found -> run focused verification -> run the
full relevant suite -> identify the next highest-priority eligible step ->
implement it -> repeat. Stop only at a real credential, purchase, owner/legal
decision, production deployment, or physical Mac/iPhone gate. Never convert
local/mock evidence into a hardware, routing, delivery, security, or store
claim.

Priority order:

P0 — make the working tree reviewable. Inventory and classify every current
modified/untracked path; preserve all source work; exclude only confirmed
runtime/generated artifacts; check for secrets; review the complete diff; run
git diff --check, the full server and desktop suites, and both production npm
audits. Prepare logical commit groups and a release report. Do not say the
features are on GitHub until the exact pushed SHA is verified.

P0 physical handoff — use docs/MAC_INSTALLER_ACCEPTANCE.md as the ordered
Mac-mini/two-iPhone test. Prove clean install and first-run diagnostics, WDA and
iproxy, full-screen geometry, FPS/latency, tap/swipe/type/Home/rotation, hidden
and release polling cleanup, real Safari/Files push, unplug/reconnect, restart,
30-minute soak, distinct per-phone proxy routes, device-originated egress,
DNS/WebRTC/IPv6 leakage, tunnel-kill fail-closed behavior, and rollback. Record
observed evidence per step; never pre-mark a physical result.

P1 — run the current sites PostgreSQL slice against TEST_DATABASE_URL and a
controlled deployment database. Verify migration, activation, authorization
failure, token rotation/deletion, connection loss/recovery, observation, and
rollback. Then cut over one additional durable domain at a time. Keep file as
the explicit rollback source until each domain is accepted; avoid a big-bang
rewrite.

P1 — add deployable backup/restore and observability: owner-approved RPO/RTO,
database PITR or equivalent, file/object reconciliation, secret rebinding, a
disposable restore drill, centralized structured metrics/logs, external health
checks, alerts, SLOs, and a small incident runbook. Do not log credentials,
tokens, private content, or phone screenshots.

P1 — implement privacy lifecycle support before store work: owner-approved
retention rules, self-service deletion/request flow, immediate session/token
revocation, de-identification or deletion, verified media/evidence cleanup,
data export, auditable completion, and a public deletion-request entry point.
Surface legal/product retention choices instead of inventing them.

P1 — continue the proxy roadmap behind the existing ProxyProvider contract.
Keep the deterministic adapter for tests. Design and implement one real,
approved provider/owned-node adapter with durable lease authority, regional
inventory, enable/disable, capacity, health, rotation, metering, monitoring,
credential isolation, and abuse operations. Preserve the UI/API statement that
routingApplied and routingVerified are false until the routing layer and a
device-originated egress check prove otherwise. Never call this an owned
Oxylabs-like service until regional exit infrastructure and operations are live.

P1 — activate the AI VA safely. Configure one approved provider, account, and
platform profile outside source control. Run a supervised read-only real-iPhone
session that proves multi-step navigation, evidence/candidate persistence,
challenge handoff, live authorization revocation, budget stops, and emergency
takeover. Keep platform-visible actions disabled until that passes, then enable
one reversible action at a time through existing policy and approval gates.

P2 — split the long Operations workspace into clear subnavigation or sections,
then run keyboard, focus, accessible-name, contrast, responsive, reduced-motion,
and screen-reader checks for Host, Admin, Manager, VA, Content Creator, and
Editor. Add focused regression tests for real failures only.

P2 — reduce change risk by extracting coherent route/composition modules from
system/server/src/index.js and view/controllers from system/client/app.js, one
bounded slice at a time behind the full regression suite.

P3 — treat iOS/Android stores as a separate delivery track after the host/web
product is stable. Add pinned Capacitor/native dependencies, generated native
projects, secure hub enrollment, lifecycle/error handling, privacy manifest and
Data Safety declarations, account deletion, signed archive/AAB, TestFlight or
closed testing, and store metadata. Do not call the current mobile scaffold
store-ready.

Baseline to preserve:
- server: 179 files, 1424 tests, 1392 passed, 0 failed, 32 skipped;
- desktop: 159/159 passed;
- system and desktop npm audit --omit=dev: 0 vulnerabilities;
- git diff --check: pass;
- live local full-screen: 364.73x648.40 canvas in a 1536x816 panel, 0.5625
  aspect ratio, controls visible;
- HEAD equals origin/main, while the reviewed work is still uncommitted across
  67 paths including this report.

For every completed item report the root cause, authoritative owner changed,
files changed, focused checks, full-suite result, directly observed evidence,
remaining limits, and the next highest-priority eligible step.
```

## 2026-09-28 continuation addendum

This addendum supersedes the numerical working-tree/test baseline above; it does
not rewrite the earlier snapshot.

### Directly observed current evidence

- Worktree: **75 paths** (**42 modified, 33 untracked, 0 staged**), classified as
  25 server source/script files, 5 client files, 30 tests, 12 documentation
  files, 2 package files, and 1 repository configuration file.
- Changed-path hygiene: no runtime/build/storage artifact and no
  high-confidence credential signature found; `git diff --check` passed.
- JavaScript syntax: `node --check` passed for all **58** changed/untracked
  `.js`, `.mjs`, and `.cjs` files.
- Server: **179 files, 1,435 tests, 1,403 passed, 0 failed, 32 skipped**.
- Desktop: **159/159 passed**.
- `npm audit --omit=dev`: **0 vulnerabilities** for both system and desktop.
- `HEAD` still equals `origin/main` at
  `8073f8a89e44f9c567114f470e7e24005c6c8a99`; none of the 75-path worktree is
  claimed to be committed or pushed.

### Bugs found and fixed during continuation

1. The Sites route extraction moved the shared public-origin resolver out of
   reach of file-push link issuance, causing a `ReferenceError` and HTTP 500.
   The composition root now owns that resolver and injects it into Sites.
2. A site WebSocket upgrade authenticated before deletion or token rotation
   could finish afterward. A buffered `devices` message could likewise pass a
   cached check, resume after deletion, and recreate a removed phone. Per-site
   authorization generations now invalidate both paths synchronously and are
   checked after every asynchronous authorization boundary.
3. A provider mutation could commit successfully and then be reported as 403
   when access changed immediately after the commit. The route now captures the
   identity at the provider's commit-time authorization point and reports that
   committed result accurately; revocation before commit still prevents the
   mutation.
4. Light and dark secondary text colors missed WCAG AA contrast. The tokens now
   meet the 4.5:1 normal-text threshold, and Operations has role-aware section
   navigation, labelled/focusable sections, an actual command label, captions,
   keyboard-sized targets, and reduced-motion behavior.

### Current self-evaluation

| Area | Score | Evidence and limit |
|---|---:|---|
| Local change reviewability | **9/10** | Exact inventory, artifact/secret scan, syntax/diff checks, complete suites, audits, and commit boundaries are present. It remains a large uncommitted set and requires human diff review/authorized commits. |
| Automated regression discipline | **9.5/10** | Server and desktop suites are green; site deletion/rotation races have deterministic tests and the complete Sites integration ran three times. Real PostgreSQL/Redis gates remain skipped without services. |
| Route/composition maintainability | **7/10** | Proxy-provider, Sites, file-push, network-check, and media routes are extracted and `index.js` is 4,392 lines. The composition root and `client/app.js` at 4,620 lines still require bounded extraction. |
| Operations accessibility | **8.5/10 local** | Semantic/focus/contrast/reduced-motion regressions are automated. Rendered keyboard, screen-reader, responsive, and per-role checks did not complete on this Windows host. |
| Physical Mac/iPhone readiness | **4/10 observed** | The acceptance procedure exists, but no current clean install, WDA/iproxy, two-phone, latency, reconnect, route/leak, or soak evidence was produced here. |
| Production database/backup/privacy/observability | **2/10 live** | Local contracts and a Sites PostgreSQL slice exist, but deployment authority, restore drills, RPO/RTO, retention decisions, deletion/export, central metrics, alerts, and incident exercises require owner/deployment work. |
| Real proxy/provider and AI operations | **3/10 live** | Safe local control planes exist. No approved provider credentials, regional exit infrastructure, device-originated routing proof, supervised AI account, or real-iPhone gate exists. |
| Mobile-store delivery | **1/10** | Still a separate future track with no signed native release or store acceptance. |

It would be inaccurate to rate every product area 9/10 from local Windows
evidence. The locally eligible reviewability/test milestone is at least 9/10;
the remaining low scores are blocked by owner decisions, credentials,
production infrastructure, deployment, and physical Mac/iPhone/store evidence.

### Logical commit plan (not executed)

1. Client live-screen/theme/Operations accessibility plus focused UI tests.
2. Account/auth/CSP/rate-limit/ban/notification hardening plus tests.
3. Media magic-byte validation and guarded device file-push path plus tests.
4. Proxy-provider contract, registry, route module, UI, and tests.
5. Sites/PostgreSQL authority slice, route module, authorization generations,
   migrations/tests, and rollback documentation.
6. WDA/process supervision and desktop/Mac acceptance material.
7. Productionization documentation, reports, package metadata, and ignore rules.

Because `system/server/src/index.js` contains composition for several domains,
it should be staged by hunk into the matching groups. No commit or push should
occur without the owner's explicit instruction.

## 2026-09-29 continuation addendum — authority-boundary review

The next P0 review pass used the code-review workflow to trace every changed
asynchronous mutation back to its durable owner. It reproduced stale-authority
commits in Sites and account administration, routing/enrollment continuation
after revocation, an ambiguous multiple-main-host configuration, and stale
privileged responses/provider health changes. The fixes are deliberately at
the repository, account-service, routing-orchestrator, and operator-config
boundaries rather than being route-only checks.

### New authoritative guarantees

1. Site create/update/rotate/remove reauthorize at the file or PostgreSQL
   repository commit point; async inventory reads reauthorize before response.
2. Account create/update/status/rename/session-revoke/two-factor-reset forward a
   commit-time authorization callback to the operator account repository.
3. Admins cannot revoke sessions or reset two-factor authentication for a host;
   the existing person-management hierarchy is applied consistently.
4. Routing start and automatic enrollment reauthorize after asynchronous
   discovery and immediately before stateful tunnel, PF, and identity changes.
   Safety teardown remains allowed to complete after revocation.
5. Operator configuration and main-host promotion reject a second main host.
6. Provider inventory/test results and provider health mutations reauthorize
   after awaited provider/network work.

### Directly observed verification

- Before the fixes, four new Sites tests failed because revoked calls committed;
  a new routing test failed because routing still started; an account-service
  test showed repository authorization was ignored; and the host-hierarchy
  integration probe returned HTTP 200 instead of 403.
- Focused sets after repair: **47/47**, **33/33**, **38/38**, and **42/42**.
- Complete server suite: **180 files, 1,442 tests, 1,410 passed, 0 failed,
  32 skipped**. External PostgreSQL/Redis tests remain skipped, not passed.
- Desktop suite: **159/159 passed**.
- System and desktop `npm audit --omit=dev`: **0 vulnerabilities** each.
- `node --check`: **66/66** changed or untracked JavaScript files passed.
- `git diff --check`: passed.
- Refined high-confidence credential scan: **83 files checked, 0 matches**.

### Refreshed inventory and release boundary

The worktree now contains **83 paths**: 49 tracked modifications and 34
untracked files, with nothing staged. Classification is 30 server source/script
files, 5 client files, 33 tests, 12 documentation files, 2 package files, and 1
repository configuration file. `HEAD` still equals `origin/main` at
`8073f8a89e44f9c567114f470e7e24005c6c8a99`. No commit or push was performed.
The existing seven logical commit groups still apply; the new repository and
route hunks belong with their Sites, account/auth, and network/WDA groups.

### Updated self-evaluation

| Area | Score | Evidence and limit |
|---|---:|---|
| Local change reviewability | **9/10** | Exact inventory, full suites, audits, syntax/diff checks, credential scan, and seven commit boundaries are current. Human diff approval and authorized commits remain. |
| Authorization/race resilience | **9/10 local** | Deterministic failures now cover repository commit points, host hierarchy, routing/enrollment revocation, stale reads, and provider health. Real PostgreSQL/Redis and physical WDA races remain unproven. |
| Automated regression discipline | **9.5/10** | 1,410 server passes and 159 desktop passes with zero failures. The 32 external-service tests remain skipped. |
| Route/composition maintainability | **7/10** | Extracted route families remain bounded, but `index.js` and `client/app.js` are still large and require future behavior-preserving slices. |
| Physical Mac/iPhone readiness | **4/10 observed** | No new hardware, WDA, iproxy, two-phone, latency, reconnect, routing/leak, or soak evidence was produced. |
| Production database/backup/privacy/observability | **2/10 live** | The next steps require a disposable database, deployment context, and owner RPO/RTO and retention decisions. |
| Real proxy/provider and AI operations | **3/10 live** | No approved provider infrastructure, credentials, device egress proof, or supervised real-iPhone AI session exists. |

The locally eligible P0 security and reviewability boundary is at least 9/10.
It remains inaccurate to elevate physical, production, provider, AI, privacy,
or store readiness from local Windows evidence.

## 2026-09-29 modularization addendum — audit and people routes

After the authority fixes passed the complete suite, the next bounded P1 slice
extracted `/api/audit`, `/api/people`, and their safe response builders into
`server/src/routes/auditPeopleRoutes.js`. `AuditService`, `PresenceStore`, the
assignment repository, device registry, and authorization helpers remain the
authoritative owners; the module receives live getters and pure policy
functions and owns no duplicate cache or durable state.

Focused route/service tests passed **8/8** and the full affected WebSocket/HTTP
integration passed **72/72**. Final server result: **181 files, 1,445 tests,
1,413 passed, 0 failed, 32 skipped**. Desktop: **159/159**. Both production
audits: **0 vulnerabilities**. Syntax: **68/68**. Diff check: passed. Credential
scan: **85 paths, 0 high-confidence matches**.

The final tree contains **85 paths**: 49 tracked modifications, 36 untracked,
and none staged. Classification is 31 server source/script files, 5 client
files, 34 tests, 12 documentation files, 2 package files, and 1 repository
configuration file. `HEAD` remains equal to `origin/main` at
`8073f8a89e44f9c567114f470e7e24005c6c8a99`. No Git commit or push occurred.

Self-evaluation remains **9/10** for local reviewability and authorization/race
resilience, **9.5/10** for automated regression discipline, and **7/10** for
route/composition maintainability. Physical, database, deployment, privacy,
provider, AI, rendered-accessibility, and store scores cannot be raised without
their stated external gates.

## 2026-09-29 addendum — account privacy and committed-result accuracy

The next P0 diff review found that `publicOperatorAccount()` included recent
login IPs in `/api/admin/users`, although no client code consumed them. A failing
integration assertion proved the disclosure. That history now has a dedicated
server-private repository/service read used only by the ban workflow, and the
public account serializer omits it. The unused legacy second-write ban helper was
removed so status plus ban metadata retain one atomic owner.

Fault injection then reproduced audit/outbox failures after durable bootstrap,
signup, login, recovery, user creation/update, session revocation, 2FA reset, and
logout work. These paths now perform security-critical revocation or fail-closed
socket suspension before best-effort audit logging and return the committed
result accurately. Recovery outbox failure compensates by clearing only the
exact just-created token hash, allowing a fresh retry without reintroducing token
invalidation abuse.

Verification is **182 server files / 1,446 tests / 1,414 passed / 0 failed / 32
skipped**, **159/159 desktop tests**, and **0 production vulnerabilities** in
both package trees. Syntax is **74/74**, `git diff --check` passes, and the
high-confidence credential scan found **0 matches across 91 paths**. The tree is
54 tracked modifications plus 37 untracked files, none staged; no runtime or
build artifact was found. `HEAD` and `origin/main` remain
`8073f8a89e44f9c567114f470e7e24005c6c8a99`. Nothing was committed or pushed.

This supports **8/10 local information and secret safety** and preserves **8.5/10
local reliability/error recovery**. It does not prove production audit
availability, privacy deletion/export, backup recovery, Mac/iPhone behavior,
phone-originated proxy egress, supervised AI operation, or store acceptance.

## 2026-10-02 addendum — locally eligible privacy, recovery, metrics, rendered-role, and extraction work

The remaining approved local slices are implemented. Privacy requests now have
a durable and idempotent policy-driven processor from locked account to exact
completion, with access-first revocation, category checkpoints, bounded failure
codes, retries, restart recovery, concurrent-claim exclusion, count-only dry
runs, cross-account isolation, and authorization checks immediately before each
destructive category. The policy is disabled when missing; shared evidence is
retained, and owned-media deletion cannot be selected until ownership is
demonstrable. This avoids inventing retention law or deleting ambiguous data.

Encrypted file and PostgreSQL backups can now be published as one reconciled
backup set only after both components succeed. The manifest contains hashes,
versions, timestamps, counts, and secret names but never values. Verification
and restore reject tampering, component mixing, symlinks, existing/unsafe
destinations, and implicit production databases. Hashing is chunked so large
components are not loaded into memory at once. No production/off-host backup or
restore drill was performed.

Operations metrics use bounded aggregate states only. The dashboard, alert
rules, and incident runbook cover actionable device, queue, intervention,
routing-protection, and AI outcome states without private or high-cardinality
labels. A synthetic Electron harness renders all six requested role profiles and
checks role visibility, keyboard focus, responsive/full-screen phone geometry,
read-only ownership, reduced motion, and dark-state rendering. It is not a
screen-reader or physical-device test. Session/account routes and the Operations
navigation controller were extracted without moving their authoritative state.

Current evidence is **205 system files / 1,551 tests / 1,519 passed / 0 failed /
32 external-service skips**, **160/160 desktop tests**, **0 production
vulnerabilities** in both dependency trees, **166/166 JavaScript syntax checks**,
**195 changed paths with 0 high-confidence credential matches**, and a passing
`git diff --check`. The tree contains **108 tracked modifications and 87
untracked files**, none staged. `HEAD` still equals local `origin/main` at
`8073f8a89e44f9c567114f470e7e24005c6c8a99`; no commit or push occurred.

Updated local scores: privacy lifecycle **7/10**, backup/recovery workflow
**6.5/10**, observability **6/10**, rendered accessibility **7.5/10**, and
route/composition maintainability **7.5/10**. These stay below 8 because legal
retention/media ownership, an off-host restore drill, deployed metrics and alert
delivery, assistive-technology acceptance, and further composition reduction
remain. Physical Mac/iPhone, phone egress, provider infrastructure, supervised
AI, production deployment, PostgreSQL/Redis execution, and store delivery retain
their earlier external scores.
