# Phone Farm app scorecard and coding handoff

Date: 2026-09-27

## Scope and scoring

This review covers the current uncommitted checkout, the browser client, server,
desktop host, proxy/routing layer, AI VA path, deployment files, and mobile
scaffold. Scores use this scale:

- **9-10:** strong and proven for the claimed environment;
- **7-8:** solid implementation with bounded gaps;
- **5-6:** usable but materially incomplete or weakly validated;
- **3-4:** early or blocked by missing operational work;
- **0-2:** absent, scaffold-only, or unproven for the claimed purpose.

Headline assessment:

| Area | Score | Verdict |
|---|---:|---|
| Local software engineering and safety | **8.0/10** | Strong authorization, failure handling, and regression discipline |
| Current operator experience | **6.5/10** | Clean shell and clear roles, but the live phone view has a serious sizing defect and Operations is dense |
| Production operations readiness | **4.5/10** | Deployment code exists; live deployment, backup/restore, centralized monitoring, and full physical acceptance do not |
| Mobile-store readiness | **1.0/10** | Capacitor placeholder only; no native projects, signed builds, privacy implementation, or store package |
| **Overall** | **6.0/10** | A capable, security-conscious beta; not a production-complete service yet |

## Detailed ratings

| Parameter | Score | Current evidence and limit |
|---|---:|---|
| Usability and learnability | **7/10** | Login, Fleet, Assignments, and Operations are understandable; Fleet exposes useful status. The admin page is long and control-dense. |
| UI cleanliness and consistency | **7/10** | Cohesive monochrome theme, consistent cards, status colors, light/dark mode, and plain-language actions. Dense cards and narrow layouts reduce scanability. |
| Information architecture | **6.5/10** | Three main workspaces are clear, but user management, sites, proxies, queue, command console, and audit all share one long Operations page. |
| Role-specific experience | **8/10** | Host, Admin, Manager, VA, Content Creator, and Editor have explicit capability-driven surfaces. Server enforcement remains authoritative. |
| Accessibility | **6.5/10** | Good use of labels, live regions, focus styles, reduced-motion support, tabs, and switch semantics. One visible command input had no accessible name, and no complete WCAG/keyboard/contrast audit has passed. |
| Live phone screen and input experience | **5/10** | Streaming, reconnect, FPS status, normalized gestures, keyboard input, and full-screen entry exist. In a 1536x864 browser, the full-screen demo canvas remained only **90x160 px**, leaving most of the screen empty. |
| Core feature completeness | **8/10** | Fleet, assignments, roles, queue, audit, research/review, sites, proxy pool, device control, onboarding, 2FA, and email paths exist. Several advanced paths still need live infrastructure or hardware acceptance. |
| Authentication and session security | **9/10** | Scrypt password hashing, constant-time comparison, TOTP/recovery, throttling, secure cookie policy, CSRF Origin/Referer checks, and live identity refresh are implemented and tested. |
| Authorization and isolation | **8/10** | Explicit capabilities plus device/workspace grants, live revocation, lease generations, and server-side checks are strong. File-backed identity and additive cloud identity remain two systems; full production tenant cutover is incomplete. |
| Resistance to web/API attacks | **8/10** | Helmet/CSP, CSP reporting, rate limits, strict inputs, hostile-body fuzz tests, fail-closed configuration, and non-enumerating recovery are present. This is not an external penetration test, and the limiter is not yet proven as a distributed control. |
| Information and secret safety | **7.5/10** | Proxy and recovery data use AES-256-GCM, reusable tokens are hashed, browser responses omit credentials, desktop logs redact secret shapes, and packages exclude runtime data. Production KMS/secret-manager operation is not implemented. |
| Privacy, retention, deletion, and export | **3/10** | A classification/threat model exists, but retention periods, account deletion/anonymization, verified evidence deletion, and user data export are not implemented. |
| Upload and media safety | **7.5/10** | Safe paths, limits, quota/cleanup behavior, and extension plus declared-MIME allowlists exist. Magic-byte sniffing, malware scanning/quarantine, and object-storage lifecycle controls remain. |
| Reliability and error recovery | **8.5/10** | Strong fail-closed behavior, bounded retries, stale-authorization checks, process supervision, stream reconnect/freeze detection, queue recovery, and user-facing retry states. |
| Data durability | **7/10** | Atomic local persistence plus PostgreSQL repositories, migrations, RLS tests, and migration tools exist. Many live routes still use the file adapters and the production authority switch is incomplete. |
| Backup and disaster recovery | **1/10** | No automated backup policy, point-in-time recovery, reconciled object restore, measured RPO/RTO, or restore drill. |
| Observability and incident response | **3/10** | Health endpoint, audit events, rotating desktop logs, diagnostics, and CSP reports exist. No centralized metrics, tracing, security-event pipeline, paging, SLOs, or incident workflow is running. |
| AI VA safety controls | **8/10** | Bounded actions, fresh observations, policy gates, quotas, exact approvals, evidence records, human handoff, emergency stop, and provider schema validation are implemented. |
| AI VA live readiness | **3/10** | Adapters and worker path are locally tested, but shipped provider/account/platform configs are empty and the supervised real-provider, real-app, real-iPhone gate has not passed. |
| Proxy pool and per-device routing control | **7/10** | Encrypted credential pool, test/add/delete, exclusive device leases, country metadata, tun2proxy/PF orchestration, fail-closed state, health checks, and device-originated egress verification exist. End-to-end Mac/two-phone leak acceptance remains open. |
| Fully owned proxy-provider capability | **2/10** | `ProxyProvider` is only a vendor-neutral contract; health and exit rotation are deliberately unimplemented. The app manages upstream proxy credentials and routes. It is not yet an Oxylabs-like owned exit network with regional nodes, inventory, rotation, metering, and operations. |
| Desktop install, update, and release engineering | **6.5/10** | macOS/Windows workflows, package inspection, WDA bundling, signed-update checks, and first-run diagnostics are well tested. No current signed/notarized clean-machine Mac release and full iPhone acceptance were proved in this review. |
| Automated test discipline | **9/10** | Server: **175 files, 1398 tests, 1367 passed, 0 failed, 31 skipped**. Desktop: **159/159 passed**. Both production dependency audits report **0 vulnerabilities**. Current skips are infrastructure-backed cases without a configured test PostgreSQL/Redis environment. |
| Maintainability | **6/10** | Services/repositories and focused modules are improving boundaries, but `server/src/index.js` is about 4,380 lines and `client/app.js` about 4,177 lines. Dual persistence modes and a large client controller increase change risk. |
| Mobile App Store / Google Play readiness | **1/10** | Only a loading-page Capacitor scaffold exists. There is no pinned mobile dependency graph, generated native projects, account deletion, privacy manifest/data-safety implementation, signed archive/AAB, or store-device acceptance. |
| Physical hardware and scale evidence | **4/10** | Some earlier one-phone/proxy behavior was reported working, but current live-screen sizing, file push, two-phone isolation, route-kill/leak checks, installation, restart, and soak acceptance are incomplete. |
| Git/release hygiene | **4/10** | `HEAD` matches `origin/main` and `git diff --check` passes, but the candidate now contains **51 changed paths: 29 modified and 22 untracked**, including this report. It is not a clean reproducible release revision. |

## Most important findings

1. The live screen's full-screen mode is functionally misleading. It expands the
   panel but does not enlarge a low-resolution canvas. CSS uses only `max-width`
   and `max-height`, while the canvas keeps its intrinsic 90x160 CSS size.
2. The current proxy feature is a secure upstream-proxy manager and Mac routing
   controller. It is not a fully owned proxy provider. A real owned provider
   also needs regional exit servers/IP supply, provisioning, rotation, health,
   capacity, metering, abuse handling, and operations.
3. Security controls are substantially ahead of operational maturity. Backup,
   restore, alerting, privacy deletion, live tenant cutover, and physical
   acceptance are the production blockers.
4. The new work is not captured in a clean Git revision. Tests prove the working
   tree, not the commit currently on `origin/main`.

## Copy/paste handoff prompt for the coding agent

```text
Work in C:\Users\404de\Desktop\PHONE FARM on branch main. First read CLAUDE.md,
docs/reviews/2026-09-27-app-scorecard-and-coding-handoff.md,
docs/CODING_ROADMAP_STATUS.md, docs/ROLE_CAPABILITY_MATRIX.md, and
docs/productionization/THREAT_MODEL.md. Preserve all existing uncommitted work;
do not reset, discard, overwrite, commit, or push it unless I explicitly ask.

Use this loop until every locally eligible item is complete:
look for bugs/errors -> fix any found -> run focused verification -> run the
full relevant suite -> identify the next highest-priority eligible item ->
implement it -> repeat. Stop only at a real credential, purchase, legal/product
decision, production deployment, or physical Mac/iPhone gate. Never claim a
hardware, routing, delivery, security, or store result that was not actually
observed.

Priority order:

P0. Fix the live phone screen sizing defect first. Reproduce with `npm.cmd run
demo`: in a 1536x864 browser, the fake-WDA canvas is currently only 90x160 px
even after Full screen is selected. Make normal and full-screen modes scale a
low-resolution MJPEG canvas to the largest size that fits the available width
and height while preserving aspect ratio. Support portrait and landscape,
rotation, narrow layouts, browser zoom, and the AI side panel. Keep the status
bar and exit control reachable; do not crop the phone. Confirm that tap, drag,
scroll, and keyboard coordinate mapping still uses the displayed rectangle and
reaches the correct intrinsic WDA coordinates. Add focused regression coverage
that would fail with max-size-only CSS, then verify the rendered browser
geometry. At 1536x864, a portrait demo frame should use most of the available
height rather than remain at its 90x160 intrinsic CSS size.

P0. Make the working tree reviewable after the screen fix. Inventory all
current modified and untracked files, separate generated/runtime artifacts from
source, verify ignored secrets and storage are absent, run `git diff --check`,
the complete server and desktop suites, and both production dependency audits.
Prepare a concise release report and exact files to commit. Do not commit or
push without an explicit instruction.

P0 physical handoff. Prepare, but do not fake, one ordered Mac/iPhone acceptance
run covering clean install, first-run dependency checks, WDA signing/start,
iproxy, live screen size/FPS/latency, tap/swipe/type/rotation, disconnect and
reconnect, file push, proxy assignment, tun2proxy/PF start/stop, device-originated
egress, DNS/WebRTC/IPv6 leakage, fail-closed tunnel kill, restart recovery, and
two phones with distinct routes. Automate every safe diagnostic and leave only
the exact physical actions as a checklist.

P1. Complete the authoritative production identity/data path. Remove the
file-backed versus cloud-identity split through a staged, reversible cutover;
run the real PostgreSQL/RLS/connection-loss tests; keep tenant, role, device,
workspace, session, WebSocket, and background-worker authorization fail-closed.
Do not do a big-bang rewrite.

P1. Add backup and recovery as a tested feature: documented RPO/RTO, automated
PostgreSQL backup/PITR for the chosen environment, object/file reconciliation,
secret rebinding, and a disposable restore drill with measured results. Add
centralized structured logs/metrics, external health checks, alerts, and a small
incident runbook without logging secrets or sensitive content.

P1. Implement privacy lifecycle support before any store work: self-service
account deletion/request flow, session/token revocation, de-identification or
deletion of profile/data according to an explicit retention policy, verified
media/evidence cleanup, auditable completion, and a public deletion-request
entry point. Do not invent legal retention periods; surface the owner decision.

P1. Harden uploads with magic-byte/type detection and safe quarantine/rejection
behavior. Keep path, quota, authorization, and cleanup guarantees. Do not add an
external malware service unless credentials/vendor choice are approved.

P1. Treat the proxy roadmap truthfully. The current app manages upstream proxy
credentials and Mac routing; it is not an owned Oxylabs-like network. First
finish the provider control plane behind the existing ProxyProvider contract:
provider/exit inventory, regions, enable/disable, health, rotation, capacity,
lease state, audit, and admin UI, with a deterministic local adapter for tests.
Keep credentials server-side and encrypted. Document the separate infrastructure
gate for real regional exit nodes/IP supply, provisioning, monitoring, abuse
handling, and real-device leak tests. Never label the feature “fully owned”
until those nodes and operational proofs exist.

P1. Run AI VA activation safely: configure one approved provider/account/app
profile outside source control, pass a supervised read-only real-iPhone session,
verify evidence/candidate persistence, challenge handoff, authorization
revocation, budget stops, and emergency takeover. Keep platform-visible actions
disabled until the read-only gate passes; then enable one reversible action at a
time through the existing policy and approval system.

P2. Improve the admin UX and accessibility. Split the long Operations page into
clear sub-navigation or collapsible sections without weakening role gates. Add
an accessible label to `#command-input`, then run a real keyboard, focus,
screen-reader-name, responsive, contrast, and reduced-motion audit for every
role. Add only regression checks that prove real behavior.

P2. Reduce maintenance risk by extracting coherent route/composition modules
from `system/server/src/index.js` and view/controllers from
`system/client/app.js`, one bounded slice at a time behind existing tests.

P3. Treat iOS/Android store delivery as a separate track after the host/web
product is stable. Add pinned Capacitor dependencies and lockfile, generated
native projects, secure hub enrollment, native lifecycle/error handling,
privacy manifest/Data Safety implementation, account deletion, signed builds,
TestFlight/closed testing, and store metadata. Do not call the current mobile
folder store-ready.

Current verification baseline to preserve:
- system: 175 files, 1398 tests, 1367 passed, 0 failed, 31 skipped;
- desktop: 159/159 passed;
- system and desktop `npm audit --omit=dev`: 0 vulnerabilities;
- `git diff --check`: pass;
- current HEAD and origin/main match, while the working tree has 51 changed
  paths (29 modified, 22 untracked, including this report).

For each completed item, report: root cause, files changed, why the authoritative
owner was changed, focused checks, full-suite result, remaining risks, and the
next highest-priority eligible step.
```
