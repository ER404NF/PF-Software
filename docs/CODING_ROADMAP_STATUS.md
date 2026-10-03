# Roadmap Status Report — updated 2026-10-03

## 2026-10-03 (latest, part 25) — proxy-pool server and client boundaries

The manual proxy-pool HTTP family now lives in
`server/src/routes/proxyPoolRoutes.js`. `index.js` remains the composition root
and injects the existing repository, encryption/decryption boundary, cache
refresh/getter, device-network map, device scope checks, current-operator
reauthorizer, tester, serializers, audit helper, broadcaster, and configuration
mutation. The module creates no repository, cache, lease map, or alternate
state owner. The exact `VIEW_PROXY_POOL`, `MANAGE_PROXY`, and `ASSIGN_PROXY`
middleware boundaries and existing public response formats remain in place.

Both successful and failed saved-proxy tests reauthorize after the awaited
network operation and before health persistence. Revocation therefore returns
no successful test data and cannot mutate health. Expected validation and
lease errors retain their HTTP status; unexpected repository or tester errors
reach Express error middleware. Public responses and audit metadata continue
to exclude proxy host, port, username, password, ciphertext, and encryption
material. Focused route-contract tests cover all seven routes, exact middleware,
missing encryption, device scope, malformed assignment IDs, exclusive leases,
assigned-proxy deletion, both revocation paths, unknown failures, and response
redaction. Those unit tests passed **8/8** and the existing proxy integration
suite passed **18/18**.

The browser's proxy pool/provider owner now lives in
`client/proxyPoolController.js`, loaded before `app.js`. It exclusively owns
the current pool and loaded flag and exposes only `refresh()`, `clear()`,
`isLoaded()`, and `getPool()` plus test-facing operations. Every asynchronous
read and mutation captures the profile generation and suppresses success and
failure output after session, role, or capability changes. Sign-out and live
role changes clear the pool, provider inventory, messages, form, and password.
All untrusted values use `textContent`; buttons are restored on every outcome;
pool/provider failures remain independent; and pool changes still rebuild the
fleet proxy pickers. The device assignment picker also suppresses stale results
after loss of `ASSIGN_PROXY`.

Focused client/controller and boundary coverage passed **54/54**. The rendered
Electron role acceptance initially exposed a timing race in its own Tab-focus
sampling: Chromium could still report `BODY` before focus traversal committed.
The harness now waits for that browser task; the rendered acceptance test
passed **three consecutive focused runs** and again in the complete desktop
suite. This is local rendered evidence, not screen-reader or physical-device
acceptance.

Final evidence: complete system suite **209 files, 1,578 tests, 1,546 passed,
0 failed, 32 skipped**; the 32 PostgreSQL/Redis cases remain unexecuted.
Desktop suite: **160/160 passed**. Both production dependency audits reported
**0 vulnerabilities**. All **174/174** changed or untracked JavaScript files
passed `node --check`; `git diff --check` passed; and the refined
high-confidence credential scan found **0 matches across 203 changed paths**
(one `sk-assignment` documentation substring was inspected and rejected as a
token-pattern false positive).

The worktree is **203 paths: 108 tracked modifications, 95 untracked files,
0 staged**. `HEAD` and local `origin/main` remain equal at
`8073f8a89e44f9c567114f470e7e24005c6c8a99`; nothing was committed or pushed.
`server/src/index.js` is 4,511 lines and `client/app.js` is 4,068 lines.
Bounded route/controller maintainability is now **8/10 local**: the two files
remain substantial composition surfaces, but the proxy feature has one server
route boundary and one client state owner with direct contract coverage. No
physical Mac/iPhone, device routing, provider infrastructure, deployment,
database, restore-drill, alert-delivery, AI-live, or store score changes follow
from this local extraction.

## 2026-10-03 (latest, part 24) — accurate rendered roles and bounded assignment/people extraction

Rendered acceptance no longer invents account roles. The Electron matrix now
covers each authoritative role exactly once: `host`, `admin`, `manager`, `va`,
`content_creator`, and `editor`. It derives panel and input expectations from
the server capability table. Human versus AI control is a separate device-state
scenario: a real Manager account opens an AI-controlled synthetic phone
read-only and cannot acquire human input. Keyboard focus, desktop/narrow
overflow, full-screen handling, dark mode, reduced motion, and human-mode input
checks remain. This is rendered local evidence, not screen-reader or physical
device acceptance.

The assignment access helpers and `/api/assignments` route family now live in
`server/src/routes/assignmentRoutes.js`. `index.js` remains the composition root
and injects the existing repository, capability middleware, device/account
scope checks, management hierarchy, recurrence/status rules, audit helper,
broadcast functions, and expiry owner. The module creates no cache. Focused
contract tests cover route registration, exact capability middleware, scope
filtering, bounded worker progress, validation errors, and propagation of
unknown persistence failures.

People and Assignments rendering and interaction now live in
`client/peopleAssignmentsController.js`. The controller receives DOM nodes,
HTTP access, profile-generation and capability accessors, current profile and
device getters, formatting, and message handling from `app.js`; server responses
remain authoritative. Focused tests cover stale response suppression after role
changes, unavailable data, live device-grant changes, and assignment mutation
failure/retry cleanup. Rendering continues to assign untrusted values through
`textContent`.

Final local evidence for this milestone: focused assignment routes **4/4**;
focused client/controller boundaries **50/50**; rendered desktop acceptance and
the complete desktop suite **160/160**; complete system suite **207 files,
1,562 tests, 1,530 passed, 0 failed, 32 skipped**. The 32 PostgreSQL/Redis tests
remain unexecuted. Both production dependency audits found **0 vulnerabilities**.
All **170/170** changed or untracked JavaScript files passed `node --check`;
the refined credential scan found **0 high-confidence matches across 199
paths**; and `git diff --check` passed. The final worktree is **199 paths: 108
tracked modifications, 91 untracked files, 0 staged**. `HEAD` and local
`origin/main` remain equal at
`8073f8a89e44f9c567114f470e7e24005c6c8a99`; nothing was committed or pushed.
`index.js` is 4,658 lines and `app.js` is 4,295 lines.

Brutal re-score: rendered role/accessibility coverage remains **7.5/10 local**
because no screen reader or assistive-technology session ran; route/code
maintainability improves from **7/10 to 7.5/10**, not 8, because `index.js`
and `app.js` remain large composition surfaces. No physical, provider,
deployment, backup-drill, AI-live, or store score changes from these local
tests.

## 2026-10-02 (latest, part 23) — privacy tombstone correctness and pre-enumeration authorization

The completed privacy processor previously reported anonymization while retaining
the original username in both the inactive account record and completed privacy
request. Assignments and tasks independently recalculated a username-derived
tombstone, the documented `anonymize_actor` audit mode did not rewrite append-only
events, and administrator authorization was first refreshed only after the
planning pass had enumerated private account data.

One request-scoped HMAC tombstone is now resolved, collision-checked, and durably
stored when processing is claimed. That exact value is injected into account,
assignment, task, audit-completion, and request operations. The file account
authority atomically renames the inactive account and rejects a conflicting
tombstone even if a preflight check races. It records only the deletion request
ID needed for retry identity; the completed request removes both `accountUsername`
and `lookupDigest` while remaining queryable by request ID. A retry recognizes
the already-renamed account by request ID and tombstone, so a restart after
account anonymization does not create a new identity or rerun a completed
category.

The audit log remains append-only. The unimplemented `anonymize_actor` policy
mode was removed; `retain` is now the only accepted audit mode. Existing shared
audit evidence is not rewritten or deleted, and the new completion event uses
the same tombstone. Unsupported modes fail policy validation before planning or
mutation. Administrator authority is checked before any planning read, after the
awaited planning pass before results can be returned, before the durable claim,
before every destructive category, and again at the file repository commit for
the account rename. Collision responses and failure codes are bounded and never
contain the original username.

Regression evidence directly covers removal of the original username from the
account configuration and completed request, one tombstone across assignments
and tasks, idempotent second execution, preflight and authoritative file-store
collision rejection, restart recovery between account anonymization and request
completion, revoked planning authorization, unsupported audit modes, and file
repository commit authorization. There is no PostgreSQL operator-account adapter
in the current architecture, so no PostgreSQL parity claim is made for this
file-authoritative account lifecycle.

Focused privacy/account verification passed **47/47**. The complete system suite
passed **205 files, 1,555 tests, 1,523 passed, 0 failed, 32 skipped**; all skips
still require external PostgreSQL or Redis and are not passes. Desktop passed
**160/160**. Both production dependency audits reported **0 vulnerabilities**.
All **166/166** changed or untracked JavaScript files passed `node --check`; the
refined credential scan found **0 high-confidence matches across 195 paths**;
and `git diff --check` passed.

The worktree remains **195 paths: 108 tracked modifications, 87 untracked files,
0 staged**. `HEAD` and local `origin/main` remain equal at
`8073f8a89e44f9c567114f470e7e24005c6c8a99`. Nothing was committed or pushed.
Privacy lifecycle remains **7/10 local**, now for external reasons rather than
the corrected identifier leak: owner-approved retention periods, demonstrable
media ownership/cleanup, deployed execution, and legal acceptance remain open.
Physical Mac/iPhone, production deployment, real proxy egress, AI-live, database,
restore-drill, alert-delivery, and store scores are unchanged.

## 2026-10-02 (latest, part 22) — sub-7 local hardening loop

The expanded working-tree inventory was exactly **179 files** before this milestone (107 tracked modifications
and 72 untracked). Four bounded untracked artifacts were added below (the PostgreSQL backup module, its CLI and
test, plus the observability dashboard), so the current inventory is **183 files**: 107 tracked modifications,
76 untracked files, and 0 staged. Classification is 74 source files, 85 tests/fixtures, 15 documentation files,
and 9 configuration/packaging files. With the current
nine-group commit map and clean gates, local change reviewability is **7/10**; it cannot rise further without
owner review, commits, and a verified remote revision.

Device file push now models Safari's download-confirmation sheet instead of treating it as an unknown state and
retrying until timeout. It locates a real Download button, reauthorizes immediately before the tap, and verifies
that the next observation is downloading or complete. Focused file-push coverage passed **39/39**. This supports
**7/10 local code readiness**, while physical Safari/Files delivery remains unverified.

Proxy-provider leases gained an authoritative `getLease()` contract. Route-local cache loss can no longer allow
the same logical device to acquire a second lease from another provider; lease, rotate, and release operations
recover ownership from provider state after restart. Focused provider coverage passed **41/41**. The provider
control plane is now **7/10 locally**, but this is not a live proxy network or routing proof.

Observability now includes reusable request-rate, server-error-ratio, and average-duration recording rules plus
an importable, bounded operations dashboard covering scrape status, traffic, errors, latency, and uptime. Focused
health/metrics/deployment coverage passed **12/12**. This supports **7/10 local configuration readiness** only;
collector deployment, receiver delivery, external checks, and an incident exercise remain external gates.

Backup and restore now refuse source or encrypted-object path swaps through descriptor-based no-follow checks.
The new PostgreSQL slice runs `pg_dump` into private staging, encrypts it before publication, keeps credentials in
environment variables, requires an exact disposable-restore confirmation, runs `pg_restore`, and always removes
plaintext staging data. Focused backup coverage passed **11/11**. This raises local backup readiness to **6.5/10**,
not 7: real PostgreSQL restore evidence, database/file reconciliation, approved RPO/RTO/retention, off-host
storage, and a timed production-shaped drill remain absent.

Rendered browser inspection confirmed that Operations previously showed every authorized panel in one long page.
It now exposes one role-allowed section at a time, preserves hash deep links, marks one navigation link current,
and moves keyboard focus to the selected panel. Focused client coverage passed **78/78** and direct browser
inspection observed one visible panel after selecting Users. Information architecture is now **7/10 locally**.

The latest complete suite passed **1,502/1,534**, with **0 failures** and **32 external PostgreSQL/Redis skips**,
across **201 files**. Nothing was committed or pushed. Remaining sub-7 categories require an owner/legal decision,
deployment or database services, Git authorization, credentials/purchases, physical Mac/iPhone infrastructure,
owned regional proxy nodes, supervised live AI, or signed store delivery; none is converted into a local claim.

## 2026-10-02 (latest, part 21) — safe default fleet, deployable monitoring, and current Windows installer

The tracked `system/devices.config.json` is now an empty production-safe fleet. Simulation remains available
only through `npm run demo` and explicit test fixtures. The network-route integration fixture moved under
`server/fixtures`, and every integration test that requires `mock-1`/`mock-2` now sets `DEVICE_CONFIG_PATH`
explicitly. The first complete run correctly exposed one missed implicit dependency in `routingRoutes.test.js`;
after migrating all affected tests, the focused set passed **84/84**, `wsProtocol` passed **74/74**, and the
final complete suite passed.

The deployment package now includes an optional Compose `monitoring` profile with pinned Prometheus LTS 3.5.5,
private bearer-token scraping, 15-day local retention, and bounded availability, server-error-ratio, and restart
rules. The incident runbook prohibits private payloads and defines triage, rollback, and closeout evidence. YAML
parsing and **11/11** focused health/metrics/deployment checks pass. Docker is not installed on this Windows host,
so `docker compose config`, collector startup, dashboard wiring, external health checks, receiver delivery, and a
timed incident exercise remain deployment gates. This supports raising observability from **4/10 to 5/10 local
configuration readiness**, not operational acceptance.

Desktop **0.2.2** tests passed **159/159**. A fresh Windows NSIS build completed and produced the ignored local
artifact `desktop/dist/Phone-Farm-Windows.exe` (116,908,383 bytes; SHA-256
`157C57DEED337E0B649D4308CBC728E1B5EE49D9445A74527E450068AF58B32A`). The unpacked application passed the
packaged-runtime verifier, including bundled WDA and real server boot. The installer is unsigned and was neither
committed nor published; no macOS package can be built or notarized on this Windows host.

Final local verification: system **1,491/1,523 passed**, **0 failed**, **32 PostgreSQL/Redis skips**, across **200
files**; desktop **159/159**; both production audits **0 vulnerabilities**; **152/152** changed/untracked JavaScript
files passed `node --check`; refined credential scan **0 matches**; runtime/build artifact candidates in Git **0**;
and `git diff --check` passed. The tree contains **179 paths**: 107 tracked modifications, 72 untracked, and 0
staged. The tracked diff is **5,605 insertions and 1,170 deletions across 107 files**. Nothing was committed or
pushed.

External/non-physical gates remain: Docker or disposable PostgreSQL/Redis for the 32 tests, an owner-approved
privacy retention/deletion policy, deployment credentials and alert receiver, real proxy/provider infrastructure,
AI provider/account configuration, signing/notarization identities, Git commit/push authorization, and mobile
store accounts. Physical Mac/iPhone, routing/leak, file-delivery, and assistive-technology acceptance also remain
open and must not be inferred from these local results.

## 2026-10-02 (latest, part 20) — deterministic WDA tests, privacy intake/export, and encrypted file restore

The two timing-sensitive WDA live-frame tests no longer depend on arbitrary sleeps or a response delay that put
two sequential WDA calls exactly on the command timeout boundary. The fake WDA fixture can now hold and release
screenshot responses independently of input, records screenshot completion, and binds a one-shot failure to the
request that consumed it. The integration tests wait for observed WDA state transitions and use isolated limiter
keys. The target pair passed **25/25**, the complete `wsProtocol` file passed **74/74** three consecutive times,
and the repaired pair remained green in every later complete suite.

The first privacy-lifecycle implementation adds a public, rate-limited deletion-request page that returns the
same response for known and unknown accounts and stores an HMAC lookup digest instead of an unknown raw
identifier. A signed-in operator must re-enter the current password and type `DELETE MY ACCOUNT`. The account
lock, auth-version increment, recovery-token removal, TOTP/recovery-code removal, and durable request happen
before best-effort audit/notification work. The repository commit callback now rechecks the authoritative stored
session rather than the request's cached principal, so a concurrent logout cannot complete a stale deletion
mutation. Main-host and last-active-admin invariants fail closed.

The public request store is now bounded to 8 MiB and 10,000 requests, validates every durable lifecycle record,
and validates/reads through one descriptor. Oversized, symbolic-link, swapped, or malformed state fails closed
instead of being loaded into memory or used for account decisions. Gmail identifiers are canonicalized before
digesting; a later verified username request upgrades the matching active public request instead of duplicating
it, and bad credentials create no verified request.

Signed-in users can download a bounded JSON export of their explicit account profile, assignments where they are
the assignee, tasks they created, audit-event metadata, and deletion-request status. The route reauthorizes after
collecting data and before returning bytes, uses `no-store`, reports category truncation, and excludes password,
MFA/recovery material, raw lookup digests, audit detail, task execution evidence, and other users' records. The
export explicitly reports that shared media/research evidence lacks per-account ownership metadata and is not yet
included. This is not completed deletion: owner-approved retention, de-identification, media/evidence ownership,
verified cleanup, retry processing, and auditable completion remain open.

The first disaster-recovery code slice adds streaming AES-256-GCM backups for the file store and atomic restore
to a new directory. Opaque encrypted objects are verified against manifest size and SHA-256, tampering and unsafe
paths fail closed, existing destinations are never overwritten, and the encrypted manifest records only the
names of deployment secrets that must be rebound. The key and secret values are never stored or printed. The
runbook requires the hub to be quiesced and correctly labels this as a local file-storage slice, not PostgreSQL
PITR or a production restore drill. Owner-approved RPO/RTO/retention, off-host scheduling, database/file
reconciliation, monitoring, and a timed production-shaped restore remain external gates.

A bounded-resource review additionally found that restore loaded `manifest.enc` without a size ceiling and that
backup accepted unbounded file and secret-name inventories. The file-backup authority now caps manifests at
64 MiB, file inventories at 100,000, required-secret names at 128, and relative paths at 1,024 characters. It
validates and reads the manifest through the same descriptor, rejects manifest symlinks/path swaps, and creates
no restore target on these failures.

The same bounded-state review found that the device file-push one-time-link store read an unbounded JSON file
and accepted malformed persisted records. It now caps the store at 1 MiB and 10,000 active links, bounds device,
filename, issuer, and TTL inputs, validates every persisted record, and validates/reads through one descriptor.
Oversized, symbolic-link, swapped, or malformed state fails closed before token matching. This hardens the local
delivery control plane only; a real Safari/Files delivery on an assigned iPhone is still unverified.

Focused privacy verification passed **20/20**. Focused backup/CLI verification passed **7/7**. Focused device
file-push verification passed **27/27**. The final complete system suite passed **1,488/1,520**, with **0 failures**
and **32 external PostgreSQL/Redis skips**, across **199
files**. Desktop passed **159/159**. System and desktop production audits each reported **0 vulnerabilities**.
All **147/147** changed or untracked JavaScript files passed `node --check`; `git diff --check` passed; the refined
credential scan checked all **169** changed paths with **0 high-confidence matches**; and no runtime/build/storage
artifact was found.

The stable tree contains **169 paths**: 102 tracked modifications, 67 untracked files, and 0 staged. Classification
is 72 source files, 78 tests/fixtures, 14 documentation files, and 5 configuration/packaging files. The tracked
diff is **5,499 insertions and 1,147 deletions across 102 files**. `HEAD` and the local `origin/main` reference
remain equal at `8073f8a89e44f9c567114f470e7e24005c6c8a99`. Nothing was committed or pushed.

Evidence supports raising privacy lifecycle from **3/10 to 5/10 local code** and backup/disaster recovery from
**1/10 to 3/10 local code**. Neither reaches 8 because cleanup policy/execution and a real reconciled restore are
unproven. Local change reviewability remains **7/10**: the inventory and gates are current, but 169 uncommitted
paths still require owner-reviewed commits and a verified remote SHA.

### Updated logical commit plan (not executed)

1. Client live-screen/theme/Operations accessibility and focused UI tests.
2. Account/auth/CSP/rate-limit/ban/notification hardening and tests.
3. Privacy request, account-lock, data-export UI/routes/stores, and focused tests.
4. Media signature validation and guarded device file-push implementation/tests.
5. Proxy-provider contract, registry, routes, UI, and tests.
6. Sites/PostgreSQL authority slice, authorization generations, migrations/tests, and rollback docs.
7. WDA/process supervision, deterministic live-frame tests, and desktop/Mac acceptance material.
8. Encrypted file backup/restore library, CLI, tests, package scripts, and runbook.
9. Productionization documents, reports, deployment metadata, and ignore rules.

`system/server/src/index.js` spans several domains and must be staged by hunk into the matching groups. No commit
or push is authorized. This local evidence does not prove physical Mac/iPhone behavior, PostgreSQL/Redis,
production deployment, phone-originated proxy routing, monitoring/alerts, deletion cleanup, supervised AI,
signed native builds, or store acceptance.

## 2026-09-30 (latest, part 19) — committed-result isolation and bounded operational data

A P0 fault-injection pass found that audit-storage errors could still replace authoritative results
across assignments, WebSocket input, command mutations, proxy/provider leases, media operations,
Sites lifecycle operations, research controls, and network verification. Those call sites now use one
best-effort audit boundary: durable mutations and explicit authorization denials retain their real HTTP
or WebSocket outcome, while the operational log records only a generic audit-write failure. A stale
WebSocket peer was also able to throw during a presence/fleet broadcast after account creation had
committed; broadcasts are now isolated per peer and an unusable peer is terminated without changing
the mutation response.

Operational error logging now retains only a bounded error kind. SMTP exception text, recipients,
subjects, tokens, database paths, and transport URLs are not copied into application logs. If both an
email send and its failure-state persistence fail, the account mutation remains successful and reports
`pending_reconciliation` rather than a misleading 500.

The first locally deployable observability slice separates `GET /healthz` liveness from `GET /readyz`
readiness. File-backed mode reports PostgreSQL as `not_required`; a PostgreSQL-authoritative process
runs the existing bounded database probe and returns 503 while unavailable. The unauthenticated
response contains only status and latency, never exception or connection text. Focused audit-outage,
WebSocket, Sites, research, media, network, notification, safe-log, health-route, and deployment checks
are green. A separately authenticated `/metrics` route now publishes process uptime and bounded HTTP
count/duration aggregates without path, query, user, device, payload, or content labels. It remains
hidden when `METRICS_BEARER_TOKEN` is not configured, and the container deployment passes the optional
secret only through environment configuration. An explicitly configured metrics token must be a bounded
token-safe value (32–512 characters), so a weak or malformed token fails startup rather than silently
weakening the endpoint. Raw session-touch, database, Redis, transaction rollback,
and synchronous-cache error text is no longer copied into logs. Task-queue and research-worker audit failures
are also isolated after authoritative persistence or device-action results; they can no longer replace a
committed result or strand a verified run.

The follow-on information-safety pass now validates model-provider configuration before constructing an
adapter. Malformed JSON and malformed provider collections fail closed without aborting server startup;
unsafe names, environment-variable references, models, and credential-bearing/non-HTTP URLs are rejected
without being echoed into logs. Routing state and HTTP responses retain catalog error codes and public messages
instead of host command stderr, paths, or provider details. Database and Redis health results retain only a
bounded error kind. Model, UI-tree capture, platform-skill, recovery, and file-push exceptions are sanitized
before they can enter model observations, task/session history, audit records, or browser responses; original
exceptions remain private to in-process recovery and rejection paths.
Automatic network-enrollment status follows the same rule: bridge inspection, IP discovery, and automatic
routing failures publish a retryable state plus bounded error kind, not host command output.
The remote-site boundary now follows the same contract: site-agent RPC failures carry only a bounded code
and public message, while discovery status text is authored by the hub instead of accepted from the remote
agent. WDA MJPEG reconnect and stall notices likewise use fixed public diagnostics rather than socket,
hostname, or transport exception text.
Direct Site-agent startup now rejects credential-bearing hub URLs, reduces accepted addresses to their
origin, and logs only bounded transport/handler error kinds. Paths, queries, fragments, embedded passwords,
and raw remote exception text therefore cannot enter the agent URL or its operational log.

Complete server verification after these changes: **192 files, 1,496 tests, 1,464 passed, 0 failed,
32 skipped**. The skipped tests still require external PostgreSQL or Redis and are not passes.
Desktop verification remains **159/159 passed**. System and desktop production audits each report
**0 vulnerabilities**. The current tree contains **153 paths**: 101 tracked modifications and 52 untracked
files, with 0 staged; all **133/133** changed or untracked JavaScript files pass `node --check`, the refined
high-confidence credential scan reports **0 matches across 153 paths**, and `git diff --check` passes.
`HEAD` still equals `origin/main` at `8073f8a89e44f9c567114f470e7e24005c6c8a99`; none of this work was
committed or pushed.

This is local implementation evidence only. No external monitor or alert is deployed, no database
outage was exercised against a controlled deployment, and no Mac/iPhone, proxy egress, backup restore,
privacy deletion, AI provider, or store acceptance gate is raised by this work.

## 2026-09-29 (latest, part 11) — private identity data and post-commit failure boundaries

A P0 review of the account and recovery flows reproduced two classes of defects that the prior green suite did
not cover. First, the administrative user-list shape serialized each operator's recent login IP history even
though the browser never uses it. Second, several identity mutations committed successfully and then returned
HTTP 500, skipped immediate live-session cleanup, or could escape an asynchronous callback when a later audit or
notification write failed.

Recent login IPs now remain inside a narrow server-private repository method used only to seed the
defense-in-depth signup blocklist after a ban. The public account shape never contains them. The obsolete second
ban-metadata writer was removed; account status and ban metadata still commit atomically through the single
account repository boundary.

Signup, first-admin bootstrap, login bookkeeping, account creation/update, explicit session revocation, 2FA
reset, recovery completion, and logout now treat post-commit audit/outbox failures accurately. Security effects
run first: committed password recovery and account-security changes revoke live sessions before best-effort
auditing. A failed recovery outbox write rolls back only the exact newly generated token hash, so a later retry
can deliver a fresh token without weakening the existing-token reuse protection or exposing account existence.
Live authorization reconciliation suspends affected sockets before asynchronous refresh and stays fail-closed if
that refresh fails.

The fault-injection tests first reproduced login-IP disclosure, misleading 500 responses, a stranded recovery
token, skipped recovery revocation, and an unguarded logout callback. Focused repair sets passed **32/32**,
**8/8**, and **5/5**. Complete server result: **182 files, 1,446 tests, 1,414 passed, 0 failed, 32 skipped**;
the skips still require external PostgreSQL or Redis and are not passes. Desktop: **159/159**. System and desktop
production audits: **0 vulnerabilities**. Syntax: **74/74** changed or untracked JavaScript files. `git diff
--check`: passed. The refined high-confidence credential scan checked **91 paths with 0 matches**.

The tree now contains **91 paths**: 54 tracked modifications and 37 untracked files, with nothing staged.
Classification: 34 server source/script files, 5 client files, 37 tests, 12 documentation files, 2 package files,
and 1 repository configuration file. No runtime/build/storage artifact was found. `HEAD` still equals
`origin/main` at `8073f8a89e44f9c567114f470e7e24005c6c8a99`; no commit or push occurred.

Evidence supports raising **information and secret safety to 8/10 locally**: password/MFA/recovery material was
already excluded or encrypted, and recent network-location history is now server-private with a regression test.
Reliability/error recovery remains **8.5/10 local**, now with explicit cross-store and audit-outage coverage.
These results do not raise physical Mac/iPhone, live database/backup, deployed observability, privacy deletion,
provider egress, AI live-operation, or store-delivery scores.

## 2026-09-28 (latest, part 10) — first reversible PostgreSQL authority slice: sites

The migration adapters existed, but the running server always constructed the file site repository. The
site admin routes and `SiteLinkHub` also assumed synchronous repository calls, so merely swapping in the
existing asynchronous PostgreSQL adapter would have returned promises as data and broken site-agent
authorization.

Added an explicit `SITE_REPOSITORY_BACKEND=file|postgres` selector. File remains the default;
`postgres` requires `DATABASE_URL`, unknown values fail startup, the pool is shared with the optional cloud
identity API, and shutdown closes it. Site routes now await durable writes. Site-agent upgrade and live-link
authorization await the same repository and fail closed on a database error. Live messages use a coalesced
one-second authorization recheck so a video stream cannot turn FPS into PostgreSQL QPS; app-driven token
rotation/deletion still disconnects immediately. The old file remains untouched as the rollback source.

Focused result: **20/20 passed** for backend configuration, async authorization coalescing/failure, and the
existing full site-link integration. The mounted-server PostgreSQL test is present but skipped locally because
`TEST_DATABASE_URL` is not configured. Full system suite: **178 files, 1408 tests, 1376 passed, 0 failed,
32 skipped**. Desktop suite: **159/159 passed**. Both production audits: **0 vulnerabilities**. This proves
the reversible wiring and file-default behavior locally; migration/activation/observation against the real
deployment database remains a deployment gate, and the other eight durable domains remain file-authoritative.

## 2026-09-28 (part 9) — worktree inventory and physical acceptance handoff tightened

The scorecard baseline had 51 dirty paths. After the requested live-screen fix and the bounded follow-on work,
the current inventory is **61 paths: 36 modified and 25 untracked**. Classification: 11 documentation, 5 web
client, 2 maintained package manifests/lockfiles, 2 server scripts, 13 server source, 27 tests, and 1 repository
ignore file. No runtime storage, temp files, packaged installers, dependency trees, private keys, or known
credential signatures were found. The generated-but-maintained `system/package-lock.json` is the only generated
commit candidate. Runtime `.env` files and `.claude/settings.local.json` were not ignored; `.gitignore` now
excludes them while keeping `.env.example` trackable. Storage/tmp/dist/runtime build exclusions were rechecked.

`docs/MAC_INSTALLER_ACCEPTANCE.md` now provides the ordered real-Mac/two-iPhone run requested by the scorecard:
clean install and preflight, WDA/iproxy, contain-fit geometry and coordinate mapping, portrait/landscape, FPS and
latency evidence, hidden/release/signout live-poll cleanup, real Safari/Files push, two independent proxy routes,
device-originated egress, DNS/WebRTC/IPv6 checks, tunnel/iproxy/WDA fault isolation, unplug/reconnect, restart,
30-minute soak, rollback, and one evidence row per step. It does not mark any hardware, routing, signing, or
notarization result as passed.

## 2026-09-27 (latest, part 8) — low-resolution live screens now scale without distortion or cropping

Reproduced the scorecard's full-screen defect in the real demo at a 1536x864 browser viewport: the
fake-WDA stream's 90x160 canvas remained exactly 90x160 while its full-screen panel occupied the whole
viewport. The canvas had only CSS maximums, so nothing requested an upscale.

`phoneStage.js` now contain-fits each decoded frame from its intrinsic dimensions into the current CSS
width/height ceilings. It refits on a rotated frame, browser resize, full-screen change, and phone-panel
resize. Full-screen height uses the actual toolbar, bezel, wrapper, and panel padding measurements rather
than a fixed viewport subtraction, so toolbar wrapping or browser zoom cannot silently crop the bottom of
the phone. Input still normalizes against the canvas's displayed rectangle; no letterboxed control box was
introduced.

Focused regression: **57/57 passed**, covering portrait and landscape contain-fit, rotation, tap/drag/wheel/
keyboard/Home behavior, and the displayed-rectangle mapping boundary. Real-browser recheck at 1536x864:
the 90x160 portrait stream rendered at **391.73x696.40**, retained its 0.5625 aspect ratio, exactly matched
its wrapper, and left the toolbar and Home control visible. A click at approximately 75% x / 25% y reached
fake WDA at 281.32 / 167.04 on its 375x667 coordinate space; drag, wheel, text, and Home also reached the
fixture. Full server suite: **175 files, 1401 tests, 1370 passed, 0 failed, 31 skipped**. This is browser/demo
validation, not physical Mac/iPhone latency, rotation, or monitor acceptance.

## 2026-09-27 (latest, part 7) — P4 built: device file push via Safari/Files

Owner confirmed the decision recorded in `docs/productionization/P4_DEVICE_PUSH_BUILD.md`: build the
researched device-push mechanism now rather than leave it as research. Built per that handout's architecture
requirement (a real platform skill, not ad-hoc taps):

- `filePushLinkStore.js` — short-lived (10 min), single-use, hashed tokens bound to one `(deviceId,
  filename)` pair, this project's existing token conventions.
- `platformSkills/filePushSkill.js` — same `detectState`/`availableActions`/`execute`/`verify`/`recover`
  contract every other skill uses; deliberately driven by its own small orchestrator
  (`filePushOrchestrator.js`) rather than the shared `executeSkillAction()` engine, since that engine is wired
  to the social-research action catalog and "push a file to this phone" isn't part of it (documented in the
  skill's own header).
- Three new, additive routes in `index.js`: issue a one-time link, consume it (the phone's own Safari hits
  this, never given a real operator session), and a blocking trigger route that drives the whole thing and
  returns a specific per-file outcome (SUCCESS/FAILED/NEEDS_HUMAN/TIMED_OUT/BLOCKED) — gated on the device
  already being in `HUMAN` controller mode, re-checked on every poll, not just once.
- Found and fixed two real bugs during testing (not just happy-path tests passing): the orchestrator's very
  first observation call had no authorization check at all (an uncaught exception instead of a clean
  `BLOCKED`), and a second, subtler version of the same gap — `captureObservation()` re-checks authorization
  itself on every call, so a `canExecute` that changes its answer *between* calls could still throw
  uncaught from deeper inside the loop. Fixed by having every observation call recognize that specific error
  and convert it to `BLOCKED`, rather than relying only on a pre-emptive check that could race against the
  shared helper's own internal re-check.
- 23 new unit tests (link store, skill, orchestrator fixtures) + 1 new integration test (full route chain:
  issuance auth boundary, consume-once-then-404-on-replay, malformed/unknown token rejection, the trigger
  route's own auth boundary, and end-to-end wiring against the real `MockDevice` — which has no Safari icon to
  find, so the one honest thing that test proves is that the whole chain runs cleanly to a specific outcome,
  never a crash or a silent no-op).
- Full suite after: **175 files, 1398 tests, 1367 passed, 0 failed, 31 skipped.** `npm audit --omit=dev`:
  still 0 vulnerabilities.

**Not claimed working, honestly:** per the build handout's own explicit instruction, this is marked **PASS
WITH KNOWN LIMITATIONS — unverified on real hardware.** The skill's UI-text patterns (which label identifies
Safari's address bar, a download-in-progress vs. download-complete banner, an error page) are a best-effort
guess at real iOS accessibility labels that genuinely vary by iOS version — nothing about that can be proven
without an actual iPhone. See `docs/productionization/P4_DEVICE_PUSH_BUILD.md`'s completed report template for
the full detail, and `PRODUCTION_READINESS_AUDIT.md` §4/§6 for the updated rating.

## 2026-09-27 (part 6) — real bug found and fixed: the proxy pool was completely broken in the demo

The owner reported "I added everything correctly but was not able to see any proxies." Reproduced directly
rather than guessed at: ran `npm run demo`, signed in as the demo admin (confirmed real `proxy:manage` /
`proxy:view-pool` capabilities), and submitted a real `POST /api/admin/proxies` exactly as the client does.

**Root cause, confirmed:** `POST /api/admin/proxies` requires `TWO_FACTOR_MASTER_KEY` (or
`PROXY_CREDENTIAL_ENCRYPTION_KEY`) to be set, to encrypt the stored proxy password — `server/scripts/demo.js`
never set either one, so every add silently 503'd with `"the proxy pool is unavailable until
TWO_FACTOR_MASTER_KEY... is configured"`. The packaged desktop app was never affected — `desktop/main.js`'s
`hostSecrets()` already generates a real one for every real install — so this was invisible anywhere except
the one place a person can currently try the app before a real deployment exists. The same missing key would
also have blocked the deeper OS-level tunnel-routing feature (`networkRoutingOrchestrator.js` decrypts the
same stored password using the same key) for the identical reason, had a real Mac gotten that far.

**Fixed:** `demo.js` now generates a real `TWO_FACTOR_MASTER_KEY` at startup, same as the real desktop app
already does. Re-ran the exact repro end to end after the fix — add (`201`), list (shows it), the real
rendered UI panel (proxy card with Test/Delete buttons), delete (`200`) — all confirmed live in a real
browser, not just via the API. Added `server/test/unit/demoScript.test.js` so this can't silently regress.
Full server suite after the fix: **175 files, 1398 tests, 1367 passed, 0 failed, 31 skipped** (skips are the
same real-database/Redis-only tests as every prior pass).

**Still unverified, honestly:** this fixes the proxy *pool* (adding/seeing/testing/assigning credentials) —
confirmed working now, in software. The actual OS-level traffic routing through a proxy
(`AUTO_ROUTE_PROXY_TUNNELS`, macOS-only, needs `sudo`/PF/tun2proxy) has never been run on a real Mac and
remains exactly as unverified as everything else in this project that depends on real hardware — this fix
does not change that.

## 2026-09-27 (part 5) — P2b actually done: a false positive caught and corrected along the way

Part 4's entry (below) reported P2b done after real Brevo credentials produced a `"deliveryState":"sent"`
with no transport error. **That was premature and has been corrected — it is left in place below rather than
rewritten, because the correction itself is the useful record.** The owner checked their inbox and Brevo's
Activity Log and found nothing had arrived: every send showed both "Sent" *and* "Error." Brevo's own error
detail: the sender address used (`bb46b8001@smtp-brevo.com`, an SMTP login identifier, not a real mailbox)
was never a verified sender, so Brevo accepted the SMTP transaction and then rejected the message at a later
stage — a failure mode that never surfaces as a `mailSender`/nodemailer error, which is exactly why the
code-level "sent" signal alone was not sufficient proof.

**Real lesson, worth keeping:** a mail-relay accepting a message is not the same claim as the message being
delivered — this handout's own "never fabricate a real-delivery claim" rule means checking the *provider's*
delivery status (or, better, the actual recipient inbox), not just the absence of a local transport error.

**Fixed and re-proven:** the owner added and verified a real address they control
(`404.design00@gmail.com`) as a single sender in Brevo. Re-ran the identical proof with that as
`COMPANY_FROM_EMAIL`, sending to a recipient the owner specified (`yfy264417@gmail.com`) — all four emails
(invite, password-reset, received, accepted) sent with no transport error, **and the owner independently
confirmed they actually arrived** this time. That is the first point where "sent" and "delivered" are both
true, confirmed by the person who can see the inbox.

`PHASE1_TEAM_ROLLOUT_HANDOUT.md`'s P2b section has the full three-attempt account. Going forward,
`COMPANY_FROM_EMAIL` must be `404.design00@gmail.com` (or a properly domain-authenticated sender if one gets
set up later) — never the raw SMTP login again.

## 2026-09-27 (part 4) — P2b done: real Brevo credentials wired, real delivery proved

The owner provided real Brevo SMTP credentials in chat. Set as process environment only (never written to a
file in this repo) and used to boot the actual server for real, driving the real HTTP routes — not a
service-layer shortcut — for all four notification kinds this app sends: the M04 cloud API's invite and
password-reset-request routes, and the legacy file-backed system's self-service-signup ("received") and
admin-acceptance ("accepted") routes.

**First attempt failed for real**, honestly reported rather than glossed over: Brevo rejected every send with
`535 5.7.1 Unauthorized IP address` — a real Brevo account-level IP-authorization control, not a code defect.
The owner authorized the IP in Brevo's dashboard. **Second attempt: all four sends succeeded** — confirmed by
the complete absence of any transport error (the failed run had logged one per send) and by the "accepted"
email's own API response explicitly flipping from `"deliveryState":"failed"` to `"deliveryState":"sent"` for
the identical call.

This closes out P2b (`PHASE1_TEAM_ROLLOUT_HANDOUT.md` §4) in full — see that document's P2b section for the
complete step-by-step report. One thing carried forward for whoever sets up the real deployment (P5): the
same four env vars need setting there too, and that host's own IP will need separate authorization in
Brevo's dashboard — authorizing this dev machine's IP does not cover it.

## 2026-09-27 (part 3) — Independent re-verification confirmed; one polish item added

A second, independent pass re-checked every claim from part 2's audit fixes — read the actual diffs (not
just the report text), re-ran the full suite itself, re-opened the real demo in a real browser and read the
actual HTTP response headers, re-ran `npm audit` on both new dependencies. **Every claimed fix was confirmed
genuinely fixed**, several ratings raised as a result (auth 8→9, uploads 6→8, headers 4→9, rate limiting
5→8, durability 8→9). One residual, explicitly-optional polish item was named for §7: a CSP
violation-reporting endpoint, since a `report-uri` was declared but nothing was listening on it yet.

Added it: `index.js`'s CSP now includes `report-uri: /api/csp-report`, and that route logs incoming
violation reports through the existing audit log (`type: "csp_violation"`) rather than requiring a manual
browser console check to notice a future accidental policy mismatch. Two new tests
(`cspReporting.test.js`): the header carries the directive and a real report is accepted and logged; a
malformed report body still gets a clean, non-500 response.

Nothing else changed — §9 (email) and §12 (deployment) remain owner-gated exactly as before, §4 (device
push) remains researched-not-built pending owner confirmation, §16 (real hardware) remains unreachable from
this environment.

## 2026-09-27 (part 2) — Production readiness audit: 5 of 8 priority items fixed, 1 researched

Worked through `docs/productionization/PRODUCTION_READINESS_AUDIT.md`'s priority-ordered action list.

**§5 — WDA MJPEG tuning (`wdaProcessManager.js`, `processSupervisor.js`):** WDA's own MJPEG server was never
configured — every session ran full-resolution, high-quality frames at WDA's conservative fixed rate, the
likely actual cause of "the stream feels slow" rather than this app's own streaming pipeline (already good).
Now sets `MJPEG_SERVER_FRAMERATE=20`, `MJPEG_SERVER_SCREENSHOT_QUALITY=30`, `MJPEG_SCALING_FACTOR=50` by
default, each overridable per deployment via `WDA_MJPEG_*` env vars.
`processSupervisor.js`'s `start()`/`_spawnNow()` gained an optional `env` parameter (merged over
`process.env`, reused across restarts) to carry this through — a small, generically useful addition, not
WDA-specific.

**§7 — security headers moved into the app itself (`index.js`, new `helmet` dependency):** previously these
headers (HSTS, nosniff, referrer-policy) existed only in `deploy/hub/Caddyfile`, which Railway (the leading
hosting candidate) would never run, since Railway terminates TLS itself. Added `helmet()` with a deliberately
custom CSP (not defaults) — `img-src` allows `blob:` for `phoneStage.js`'s frame-rendering pipeline,
`connect-src 'self'` covers the app's own same-origin WebSocket. The one inline `<script>` in `index.html`
(theme bootstrap) moved to an external file (`theme-bootstrap.js`) since a strict `script-src 'self'` blocks
inline scripts. Verified for real: `curl -I` against the actual running demo server shows every header now
present, and a real SVG phone frame was confirmed decoding correctly through the `blob:` URL pipeline under
the new policy (exact icon colors read back from the rendered canvas).

**§3 — upload file-type allowlist (`fileStore.js`, `index.js`):** multer previously had no `fileFilter` at
all — any extension, any declared MIME type was accepted and stored as-is. Added
`rejectedMediaUploadReason()`: an allowlist of the video/image/audio extensions this app's actual use case
needs, checked against both the extension and the declared MIME type (rejecting a mismatch as a spoofed-type
signal). Four pre-existing tests that happened to upload `.txt`/`.json` fixtures for unrelated reasons
(replacement-safety, quota enforcement, reserved-device-id protection) were updated to use an allowed
type — each was about something else and would otherwise have started passing for the wrong reason.

**§8 — general API rate limiting (`index.js`, new `express-rate-limit` dependency):** ordinary API routes
had no general limiter (only login/2FA/signup/recovery did). Added one scoped to `/api`, keyed by operator
username when signed in (falling back to IP only when unauthenticated) — deliberately not IP-keyed for
authenticated traffic, since this fleet's VAs can share one office/NAT IP per hub and an IP-keyed limit would
risk one session collaterally throttling every coworker on it. Limit/window are env-configurable
(`API_RATE_LIMIT_MAX`/`_WINDOW_MS`) so a dedicated test could prove the real 429 behavior deterministically
without touching the generous production default (300/minute), which the full suite confirms doesn't
interfere with any existing test's normal traffic.

**§1 — CSRF protection (`index.js`), with a deliberate design change from the audit's own suggestion:** the
audit named a token (double-submit cookie) as the example fix. Implemented Origin/Referer verification
instead — OWASP's own recognized alternative — because a token would have required retrofitting roughly 20
existing test files' hand-rolled `fetch()` helpers to carry it, for no actual gain in this app's threat model
(CSRF is fundamentally a browser-only attack; a browser cannot be made to omit or spoof its `Origin` header
on a cross-origin state-changing request, so checking it is just as real a defense, with zero client-side
plumbing and zero test-suite disruption). Proven with a real forged-cross-origin-POST test using an actual
session cookie.

**§4 — device-file-push mechanism: researched, not built,** per the audit's own explicit instruction. Full
findings in [docs/productionization/P4_DEVICE_PUSH_RESEARCH.md](productionization/P4_DEVICE_PUSH_RESEARCH.md):
direct Photos-library push is confirmed infeasible without a jailbreak (AFC2, the mechanism that would allow
it, doesn't exist on a stock device); the `com.apple.mobile.house_arrest` AFC service is real, current, and
what Appium's own real-device `push_file` command uses, but only reaches an app's own sandbox for apps that
opt in via `UIFileSharingEnabled` — it can't target arbitrary apps like Photos or Instagram. Recommended path:
automate an existing in-app import flow with the tap/swipe primitives already built (the same thing a human
VA does by hand today) — flagged for the owner to confirm before any code is written.

**Left untouched, all owner/hardware-gated exactly as the audit says:** §9 (email — needs the real Brevo
credential), §12 (deployment — needs the hosting decision), §16 (real-hardware re-verification — no real Mac
mini/iPhone reachable from this environment).

Full local server suite after all of the above: **169 files, 1,608 tests, 1,608 passed, 0 failed, 0 skipped**
(real PostgreSQL 16 + real Redis-compatible server).

## 2026-09-27 — Phase 1 handout: P2b's code confirmed already done; P6 bug hunt complete

Worked through `docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md` starting from §7's first action.

**Baseline confirmed matching the handout's own expectation:** server suite 165 files/1,328 tests/1,298
passed/0 failed/30 skipped without a local database (exactly as documented); desktop suite 159/159.

**P2b — investigated, not redone:** the handout's steps 3 ("wire `emailActionService.js` into real routes")
and 4 ("wire the invite email for both flows") turned out to already be done, confirmed by reading the
actual mount code rather than assuming — `createCloudApi.js`'s routes already call `emailActionService`,
`index.js`'s real `CLOUD_API_ENABLED` mount already passes the real `mailSender`, and the file-based
self-service flow's own emails (this session's earlier work) already share the same `mailSender.js`. What's
left of P2b is exactly the owner-gated part: a real Brevo credential and a real delivery proof, neither of
which this environment can supply.

**P5 — genuinely blocked**, hosting provider still undecided; no deployment-specific work started, per the
handout's own explicit instruction not to.

**P6 — the bug-hunting pass, done in full for every item not requiring a real deployment.** One real bug
found: `authStore.js`'s `recordAccountBan()` had no length cap on the `reason` field, unlike every other
free-text field in that file — fixed with a 1000-character cap. Otherwise, every item proved already-correct
behavior for real rather than finding new bugs:
- Extended `cloudApiFuzz.test.js` to two routes it had missed, and wrote a new
  `adminUsersFuzz.test.js` (22 sub-tests) giving the legacy `/api/admin/users*` routes their first
  hostile-input pass ever — including this session's own new `banned` status, `reason` field, and
  role-ceiling logic.
- New `postgresConnectionLoss.test.js`: severed a running server's real Postgres connections mid-request
  (via `pg_terminate_backend` from a separate admin connection, not by stopping the shared database service)
  and confirmed every request still gets a clean response, no crash, and the exact route recovers moments
  later.
- New genuine-concurrency tests (not the sequential "A then B" kind already in the suite): two WebSocket
  connections racing to claim the same device with no `await` between the sends
  (`wsProtocol.test.js`), and two database calls racing to accept the same invitation
  (`invitation.test.js`) — both confirmed exactly one winner, run repeatedly to rule out flakiness.
- New two-independent-sites test (`siteLink.test.js`) — the only test in that file running two real site
  agents at once, matching the actual fleet shape (Italy + 2 in Romania) — confirmed one disconnecting
  mid-session leaves the other's already-open control session completely unaffected.

Full write-up: [docs/productionization/P6_BUG_HUNT.md](productionization/P6_BUG_HUNT.md).

Full local server suite after this pass: **167 files, 1,597 tests, 1,597 passed, 0 failed, 0 skipped**
(real PostgreSQL 16 + real Redis-compatible server — every test able to run against a real database did).

**Two things only the owner can unblock, surfaced per the handout's own §5:** the hub hosting provider
(Railway vs. something else — nothing signed up for yet), and the real Brevo SMTP credential (the one
pasted earlier this session never reached a usable state).

## 2026-09-26 — VA self-service onboarding, a host role tier, and a separate Ban mechanism

Built the requested VA sign-up/approval workflow end to end, then extended it twice more based on follow-up
direction: separate Reject/Ban/Kick actions (not one relabeled button), and a `host` role above `admin` for
running multiple hubs (each hub = one Mac mini + its phones, e.g. 1 mac mini + 2 phones in Italy, 2 mac
minis + phones in Romania).

**Onboarding email + Waiting for approval tab:**
- `accountNotificationStore.js` gained a `"received"` notification kind, sent the moment `/api/signup`
  creates a pending account ("your application was received, an admin will review it").
- A new **Waiting for approval** panel in Operations (`system/client/index.html`/`app.js`), visible to
  anyone with `MANAGE_USERS` or `MANAGE_TEAM_MEMBERS`, lists only `accountStatus === "pending"` applicants
  with Accept/Decline/Ban buttons, reusing the existing `PATCH /api/admin/users/:username/status` route.

**Reject vs Kick vs Ban — three distinct actions, not one relabeled button:**
- **Reject** — onboarding-only. Declines a still-pending application (`accountStatus: "rejected"`).
- **Kick** — already existed (`buildUserActionsMenu`'s "⋮" menu): deactivates an approved operator
  (`active: false`) for an ordinary firing/offboarding; reversible by reactivating.
- **Ban** — new, separate, for security incidents ("someone steals information or models from us"),
  available both during onboarding and after approval. Sets a new `accountStatus: "banned"` (distinct from
  `"rejected"`), ends all sessions, records who/why/when (`authStore.js`'s `recordAccountBan`), and
  blocklists the account's most-recently-seen login IP addresses (`banStore.js`) against **new signups**
  (not logins — see limits below). Lifting a ban is restricted to `host`-role operators only.

**A `host` role above `admin`, for multi-hub ownership:**
- `roleCapabilities.js` gained `OPERATOR_ROLES.HOST`, with the same full capability set as admin — the
  distinction from admin is about *who can promote whom*, not which features are reachable.
- `index.js`'s new `maxAssignableRoles()`: admin can create/promote up to `manager`; host can create/promote
  up to `admin`; only the **main host** (`isMainHost` flag) can create/promote to `host` itself. `admin`
  can no longer manage or even see a `host` account (`canManagePerson` updated); a `host` can manage
  everyone, including admins.
- `isMainHost` is set **only** via `server/scripts/create-operator.js --main-host` (requires
  `--role=host`) — never through any HTTP route. `createOperatorAccount`'s input has no such field at all,
  and `updateOperatorAccount`'s allowlist deliberately omits it, so a request body can never reach it even
  if someone tried to smuggle it in (verified by a dedicated test).

**Documented limits, not overclaimed:**
- A ban is **not** an unbreakable network perimeter. It only knows the handful of IP addresses this specific
  account was last seen logging in from (`recentLoginIps`, capped at 5) — a new IP (different network, VPN,
  mobile data, a new device) isn't stopped by it. There is no device/browser fingerprinting in this codebase
  to layer on top yet.
- The blocklist is checked at `/api/signup` only, deliberately **not** at `/api/login`: this team can share
  one office/NAT IP per hub, and gating login on IP would risk locking out every legitimate coworker on that
  same network the moment one person is banned, for no real extra security (the banned account is already
  fully blocked via `accountStatus === "banned"` regardless of IP).

Tests: `server/test/unit/authStore.test.js` (isMainHost/recentLoginIps config validation, six-role
capability check), `server/test/integration/hostRoleAndBans.test.js` (new — role-ceiling enforcement,
canManagePerson host/admin boundary, isMainHost never settable via HTTP, full ban→blocklist→lift-ban flow,
self-ban refused, ban/lift-ban never require an email unlike approve/reject),
`server/test/unit/clientRoleUi.test.js` and `server/test/integration/accountEmailDelivery.test.js` updated
for the new wording/email-count. Two pre-existing tests in `operatorManagement.test.js` fixed: they created
a second admin account via the now-restricted `POST /api/admin/users` route as pure test setup, unrelated to
what those tests actually check — switched to a role within the creator's ceiling, or to a direct
`authStore.js` import, as appropriate.

Full local server suite: **165 files, 1,559 tests, 1,559 passed, 0 failed, 0 skipped** (real PostgreSQL 16 +
real Redis-compatible server). Manually verified in the browser via `npm run demo`: signup → Waiting for
approval tab → Accept/Ban both exercised for real over HTTP, role dropdown correctly hides "Host" from a
non-main-host admin, banned account correctly blocked from login and shows no Lift-ban button to an admin.

## 2026-09-26 — P3 complete for all 9 available domains; 2 more real bugs found

Extended P3 (started with sites — see the entry below) to every remaining domain that has a Postgres
adapter: assignments, platform accounts/policies, task queue/runs/checkpoints, approvals, interventions,
proxy pool, audit, and research. Each got the same treatment as sites: a migration script reusing the real
file store's own loading logic (never a hand-rolled parser), a real-PostgreSQL test against realistic
fixtures, and CI wiring — 9 scripts, 9 test files, 41 sub-tests total. Devices/hosts and leases remain
skipped (no Postgres adapter exists for either yet, already documented in `M05_DURABLE_DOMAIN_MIGRATION.md`).
None of the 9 domains had its actual cutover (step 4 — switching `index.js` to read Postgres) flipped: that
needs a real deployment to "watch run correctly for a while" first, per the handout's own explicit
instruction and its "no big-bang cutover" safety rule.

**Two more real bugs, on top of sites' own** (full detail in
[docs/productionization/P3_DOMAIN_CUTOVER.md](productionization/P3_DOMAIN_CUTOVER.md)):

- **A genuine cross-test-file bug, found only by running the *entire* suite together, not any file in
  isolation:** `automation.task_queue_snapshots` has exactly one row per organization by design — unlike
  every other domain's tables, there's no random per-test id to prevent collisions. The new task-queue
  migration test saved a real snapshot for the shared default organization and never cleaned it up,
  silently breaking a *different*, pre-existing test file's "nothing has been saved yet" precondition
  whenever both happened to run in the same `npm test` invocation. Fixed with a proper cleanup hook. This is
  exactly the kind of interaction bug that only running the whole suite together — not just the file you
  just touched — can ever surface, and why "run the full suite after every change" has been the standing
  practice all along.
- A test-fixture-only issue in the approvals migration test (a fixed past `expiresAt` that real lazy
  expiration correctly aged out by the time the test ran) — same root lesson as sites' `rotated_at` mistake:
  model fixtures on what the real system actually produces, not on what merely looks plausible.

Full local server suite: **164 files, 1,554 tests, 1,554 passed, 0 failed, 0 skipped** — the whole suite,
which is what caught the cross-file bug above; no individual new test file would have. This closes out P3
for every domain currently reachable without a real deployment. Full write-up in
[docs/productionization/P3_DOMAIN_CUTOVER.md](productionization/P3_DOMAIN_CUTOVER.md).

## 2026-09-26 — P3 begins: sites domain migration script, another real bug found

Started `PHASE1_TEAM_ROLLOUT_HANDOUT.md`'s P3 (move durable data off files, one domain at a time), following
its required order. Devices/hosts is skipped — `M05_DURABLE_DOMAIN_MIGRATION.md` already documented that it
needs its own design pass and has no Postgres adapter to cut over to yet; that's a pre-existing gap, not a
new decision.

**Sites domain**: wrote `system/server/scripts/migrate-sites-to-postgres.js`, a one-time, safe-to-re-run
(upsert by id) script that reads the real file-backed `sites.json` and writes matching rows into
`fleet.sites`, reporting before/after counts. The one subtlety that mattered: it preserves the **token hash**
exactly rather than generating a fresh one — neither the file nor Postgres store ever persists the plaintext
token, so a real site agent's already-saved token must keep verifying against whatever hash the migration
writes, or every Mac mini would need re-enrolling by hand the moment this ran for real.

**Another real bug, found by the migration's own test on its first run**: the test's fixture modeled a "never
rotated" site as `rotatedAt: null` — but `fleet.sites.rotated_at` is `NOT NULL DEFAULT now()`, and the real
file store never actually produces that state either (`siteStore.js`'s own `create()` always sets
`rotatedAt: now`, the same as `createdAt`, at creation — "never rotated" means *equal to created_at*, not
absent). Fixed the test fixture to match the real system's actual invariant, and separately hardened the
migration script itself with a defensive `rotatedAt ?? createdAt` coalesce, since the file store's own loader
doesn't validate every field's presence — a genuinely malformed legacy record shouldn't crash a one-time
migration either. A dedicated test proves the coalesce.

**Step 4 (the actual cutover — switching `index.js` to read Postgres instead of the file) is deliberately not
done.** The handout's own instruction is to watch the domain run correctly for a while post-cutover before
removing the file fallback — an operational observation step that requires a real deployment with real
traffic, which doesn't exist in this environment. Flipping a flag without that would be exactly the
"no big-bang cutover" mistake the handout's own safety rules (§2) exist to prevent. Full reasoning in
[docs/productionization/P3_DOMAIN_CUTOVER.md](productionization/P3_DOMAIN_CUTOVER.md).

Full local server suite: **156 files, 1,516 tests, 1,516 passed, 0 failed, 0 skipped.** Next: repeat this
same pattern (migration script + test, no cutover yet) for assignments, platform accounts/policies, task
queue/runs, approvals/interventions, research, proxy pool, and audit.

## 2026-09-26 — P2 fuzzing (2 more real bugs) + P4 decision recorded

Fuzzed every JSON-bodied cloud API route and every authenticated route, mounted for real, with malformed
JSON, `null`, bare arrays, wrong-typed fields, prototype-pollution shapes, oversized bodies, and hostile
Bearer tokens — 62 sub-tests in new `cloudApiFuzz.test.js`. Found and fixed **two more real bugs**:
`POST /login` and `POST /password-reset/request` both crashed with a 500 (`email.trim is not a function`)
when sent a non-string `email`, since both only checked `if (!email)` (a falsy check a truthy non-string
sails past) before calling straight into `userRepository.getByEmail()`. Fixed with an explicit
`typeof email !== "string"` check in both routes — for `/password-reset/request` specifically, this
preserves its own deliberate uniform-202 response for malformed input, it just stops the crash. Also caught
and corrected two test-only false positives along the way: expecting a 4xx from `/password-reset/request`'s
own intentionally-uniform 202 response, and a "hostile" Authorization header that Node's own `fetch()`
refused to even transmit (a raw UTF-16 surrogate half / control bytes aren't legal HTTP header content for
any real client either).

Added a real coverage gap closer: `GET /organizations/:id/members`'s own wrong-organization rejection
(the one route gated by `requireMembership()` alone, no specific permission — a different middleware
configuration than the two already fully matrix-tested).

**P4 (Redis: decide, don't assume) — decision recorded in
[M06_REDIS_FOUNDATION.md](productionization/M06_REDIS_FOUNDATION.md):** do not build out Redis-backed
presence/locks for Phase 1. At 5–8 devices behind one hub process, there's no multi-instance coordination
problem for Redis to solve yet; the device-lease race stays a PostgreSQL-level lock once that domain moves to
Postgres in P3. Revisit only if the owner wants multiple hub processes (e.g. zero-downtime deploys) or the
fleet outgrows a single hub's in-memory state — the M06 foundation is already there and proven (P1) for when
that day comes.

Full local server suite: **155 files, 1,510 tests, 1,510 passed, 0 failed, 0 skipped.** Full write-up in
[docs/productionization/P2_REAL_LOGIN_MOUNTED.md](productionization/P2_REAL_LOGIN_MOUNTED.md). This closes
out P1, P2 (including its step 5 fuzzing requirement), and P4. Remaining Phase 1 work (P2b real SMTP, P3
per-domain cutover, P5 real deployment, P6 further bug-hunting) is either owner-account-gated (real SMTP
provider, real Railway/hosting account, real Mac minis) or large enough to warrant its own dedicated pass.

## 2026-09-26 — P2: real login mounted into index.js, a second real bug found

Per `PHASE1_TEAM_ROLLOUT_HANDOUT.md`'s P2 task: mounted the M04 identity/organization system (built and
verified in earlier sessions, but never wired into the running server) into `system/server/src/index.js`,
behind `process.env.CLOUD_API_ENABLED === "true"`, at `/api/cloud` — additive, alongside the existing
file-backed operator login, which is completely untouched either way. Added `allowOrganizationSignup` to
`createCloudApi.js` (default `true`, so every existing caller keeps working) so Phase 1's mount can pass
`false` and 404 the one route (`POST /signup`) that creates a brand-new organization — Phase 1 has exactly
one, created once at startup via `ensureDefaultOrganization()`, and no public "create an account" route
should exist. Recorded the required role-model decision explicitly (P2 step 6): this identity layer replaces
only account lifecycle; device-control authorization (`roleCapabilities.js`) is untouched, the handout's own
recommended default.

**Doing this — actually mounting for real, not just testing `createCloudApi()` as its own standalone app —
found a second real, serious bug**, in `docs/productionization/P2_REAL_LOGIN_MOUNTED.md`: the cloud API's
`authenticate` middleware set `req.session = <bearer-token session row>` — but `index.js` already runs
`express-session` globally, which owns `req.session` as its own `Session` instance with a real `.touch()`
method, and depends on that object surviving to the end of the response. The two independent "session"
concepts collided the instant both existed on the same request, throwing `req.session.touch is not a
function` deep inside `express-session`'s own response hook. No standalone test of `createCloudApi()` could
ever have caught this — it only exists at the intersection of the two systems. Fixed by renaming the cloud
API's own property to `req.identitySession` everywhere it's set or read.

Added `system/server/test/integration/db/cloudApiMountedInIndex.test.js`: boots the **actual**
`system/server/src/index.js` with `CLOUD_API_ENABLED=true` against a real database and runs a complete,
real, end-to-end sequence over real HTTP — invite a VA by email, accept the invite, log in, enroll real TOTP
two-factor (computing a genuine code from the returned secret, not a stub), confirm it, log out, and confirm
the session is actually revoked afterward — plus confirms the legacy `/api/login` route is completely
unshadowed by the new mount. This is P2's own required proof ("an invite, real login, and a live two-factor
setup completed end to end — not a log line claiming it worked"), satisfied for real.

Full local server suite re-run after both fixes: **154 files, 1,447 tests, 1,447 passed, 0 failed, 0
skipped.** Full write-up in
[docs/productionization/P2_REAL_LOGIN_MOUNTED.md](productionization/P2_REAL_LOGIN_MOUNTED.md). Next:
finish the remaining authorization-matrix cells, fuzz every cloud-facing route, then P2b (real SMTP).

## 2026-09-26 — P1: real PostgreSQL + Redis verification, 7 real bugs found and fixed

Per `docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md`'s P1 task: brought up a real, disposable
PostgreSQL 16.14 (via `embedded-postgres`, no Docker/admin rights needed) and a real Redis-compatible server
(Memurai via `redis-memory-server`) as local dev tooling, then ran the full migration set and the entire
server suite against them for the first time in this project's history — every one of the 19 previously
CI-only/always-skipped real-database/Redis tests had, per the handout's own account, never actually executed
anywhere, including in GitHub Actions.

Doing so surfaced **7 real, previously-invisible bugs**, full detail in
[docs/productionization/P1_REAL_DATABASE_VERIFICATION.md](productionization/P1_REAL_DATABASE_VERIFICATION.md):

1. **Systemic RLS defect (the serious one):** once a custom Postgres GUC (`app.current_organization_id`/
   `app.current_user_id`) has been set via `SET LOCAL` and that transaction commits, `current_setting(name,
   true)` returns `''` — not `NULL` — for the rest of that session, even after `RESET`. Every RLS policy in
   this codebase compared that value directly against `::uuid`, so any query on a pooled connection that had
   previously served a `withTransaction()` call, run *without* a fresh transaction context, threw a raw
   Postgres exception instead of failing closed. Fixed with `NULLIF(current_setting(...), '')::uuid` across
   all 31 occurrences in 12 migration files — a real production-reliability defect, invisible to any mock,
   only reproducible against a real connection pool.
2. Seed data bug: the `manager` role was never actually granted `member:manage` (only `member:invite`),
   contradicting the route and test's own intent — one line missing from
   `1758838500000_seed-permissions-and-roles.js`.
3. `researchStore.js`'s cross-run dedup index keys use a `\u0000` join — fine in a JSON file, a hard Postgres
   error in `jsonb`. Fixed by base64-encoding/decoding those specific keys at the Postgres storage boundary
   only (`postgresResearchRunRepository.js`), leaving the shared dedup logic and the file store untouched.
4–5. Two test files (`postgresApprovalRepository.test.js`, `postgresAssignmentRepository.test.js`) share one
   mutable fake clock across many sequential sub-tests; several assertions depended on the clock having moved
   relative to fixture dates that it hadn't yet — the adapters were correct throughout; only the tests' own
   chronology was wrong.
6. `cloudApi.test.js` asserted RLS blocks a query run through the test's own connection pool — which connects
   as the Postgres **superuser**, and superusers bypass RLS unconditionally regardless of any policy or GUC
   context. Replaced with a real check (membership *is* visible with correct tenant context); the actual
   fail-closed property is already proven properly elsewhere via genuine non-superuser roles.
7. `redis/client.js`'s `enableOfflineQueue: false` rejected any command sent before ioredis's asynchronous
   connection handshake completed — including the very first health check after construction — causing
   `redisFoundation.test.js` to hang indefinitely the first time it ever ran against a real server. Removed;
   `connectTimeout`/`commandTimeout`/`health.js`'s own timeout wrapper already bound the cases that setting
   was meant to guard against.

**Final result: server suite 153 files, 1,443 tests, 1,443 passed, 0 failed, 0 skipped — the first time
every test in this project has ever run and passed for real, not skipped.** Desktop suite unaffected: 159
passed, 0 failed. Full migration round trip (up → down 0 → up) re-verified clean after every schema change.

This closes out Phase 1 task P1. Next: P2 (mount real login into the running server behind a flag).

## 2026-09-26 — M05 part 10: account policies, unblocked by a new shared sync-cache utility

Built `server/src/syncCache.js` — a generic, in-memory synchronously-readable cache backed by any durable
store — specifically to unblock platform accounts/policies (`policyStore.js`), which turned out to have the
exact same "read from a never-awaited hot path" constraint as background authorization: `index.js` feeds
`policyStore.effective(...).get(accountId)` straight into `actionPolicy.js`'s `validateAction()` gate, called
inline with no `await`. A naive per-call-query Postgres adapter would have satisfied an M02 contract's method
names while silently breaking the moment it was wired in for real — caught during design, not after shipping
a broken adapter. The cache loads the full snapshot once at construction, updates immediately on every local
write (before the durable write is even sent), and supports an optional poll-based refresh for picking up
another process's writes — deliberately poll-based, not push-based invalidation, since there's no real
multi-instance deployment here to test push-based invalidation against.

Built the M02 port (`persistence/policyRepository.js` + `persistence/filePolicyRepository.js`, no port existed
for this domain before now), the migration (`automation.account_policies`), and
`postgresPolicyRepository.js`, which loads the whole override table into a `syncCache` and keeps
`set()`/`clear()` returning the exact same plain object/void `PolicyStore` already returns — never a Promise
— while persisting to Postgres in the background.

Real-PostgreSQL test proves the interesting part directly: a write is visible to `effective()`/`describe()`
on the very next line in the *same* process, but a *separate* repository instance (simulating another
process/pod) only sees it after an explicit `refresh()` — the eventual-consistency boundary is demonstrated,
not just asserted in a comment. Also covers validation parity, config-then-default fallback, and tenant
isolation through a non-superuser role. 10 new pure unit tests cover the cache mechanism itself with no
database needed (load formats, write-before-persist-settles ordering, error reporting without breaking the
sync contract, refresh success/failure). Wired into `.github/workflows/db-migrations.yml` as the seventeenth
PostgreSQL CI step.

**Correction made before any further code was written:** background authorization
(`persistence/backgroundAuthorizationRepository.js`) has the identical synchronous-read constraint, but its
file adapter resolves through `authStore.js`'s own operator registry — the same data source
`operatorIdentityRepository.js`/`operatorAccountRepository.js` already read, and the same one already flagged
as needing an owner decision on reconciling with `identity.users` before any of it moves to Postgres.
`syncCache.js` is a necessary piece of that domain's eventual solution, but doesn't unblock it alone — the
identity-reconciliation decision is still the real gate. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **153 files, 1,312 tests, 1,293 passed, 0 failed, 19
skipped** (the 19 skips are every PostgreSQL/Redis-gated test, correctly skipping without a live database or
Redis).

## 2026-09-26 — M06 begins: Redis foundation (client, health check, key schema)

With every cleanly-fitting M05 domain done (see the entry below) and the rest genuinely blocked on design/
owner decisions, moved to M06 per the master prompt rather than spinning further on M05. Installed
`ioredis@^5` (0 vulnerabilities), then built the foundation layer only — deliberately not migrating any real
domain yet, mirroring how M03 (Postgres foundation) preceded M04/M05's actual domain work:

- `system/server/src/redis/client.js` — `createRedisClient()`, mirroring `db/pool.js`'s shape
  (`REDIS_URL`, timeouts, TLS-verification-must-be-explicit, a required client-level error handler,
  `enableOfflineQueue: false` so a caller finds out immediately when Redis is unreachable instead of hanging).
- `system/server/src/redis/health.js` — `checkRedisHealth()`, a bounded-timeout `PING`.
- `system/server/src/redis/keys.js` — the actual substance of
  [ADR-0003](productionization/adrs/ADR-0003-redis-ephemeral.md)'s action item 1: `orgKey()` builds the ADR's
  own `pf:org:{organizationId}:...` tenant-scoped format (UUID-validated, so a bad value can't collide with
  another tenant's namespace — the same guarantee Postgres RLS gives at the database layer, expressed as a
  naming convention since Redis has no RLS equivalent), and `assertBoundedPayload()` gives "no raw secrets or
  unbounded payloads in Redis" a real enforced ceiling (16 KiB) instead of leaving it as an unenforced
  sentence in the ADR. Deliberately did **not** add a speculative `globalKey()` helper or a generic
  `setWithTtl()` wrapper — no real caller needs either yet, and adding them now would be exactly the kind of
  ungrounded design this project avoids.

Real-Redis test (`system/server/test/integration/redis/redisFoundation.test.js`, new
`.github/workflows/redis-foundation.yml` with a `redis:7` service container) covers: health check
healthy/unhealthy (with a bounded wait, not a hang); an `orgKey()` value round-tripping through a real
`SET`/`GET` with a confirmed TTL; two organizations' keys never colliding. 6 pure unit tests
(`redisKeys.test.js`) cover `orgKey()`'s validation and the payload limit with no Redis required. Full write-up
in [docs/productionization/M06_REDIS_FOUNDATION.md](productionization/M06_REDIS_FOUNDATION.md). Full local
server suite re-run after this addition: **150 files, 1,298 tests, 1,280 passed, 0 failed, 18 skipped** (the
18 skips are every PostgreSQL/Redis-gated test, correctly skipping without a live database or Redis).

**Nothing real runs on Redis yet** — presence (`presenceStore.js`, currently in-process `Map`s) is the
concrete next candidate per ADR-0003's own stated use case, but that's real design work for its own slice, not
bundled into the foundation.

## 2026-09-26 — M05 part 9: research runs — closes out every cleanly-fitting domain

Added `automation.research_accounts` and `postgresResearchRunRepository.js`, satisfying
`persistence/researchRunRepository.js`'s 8-method contract. This was the most complex domain in M05 so far:
`researchStore.js` keeps one JSON file per (workspace, account) holding both a run's candidates and a
cross-run dedup index (`byContentId`/`byUrl`) that lets a later run recognize a previously-seen post and carry
its human review decision forward instead of resetting to "pending." Rather than redesigning that index as
live relational queries, the migration mirrors the file shape exactly — one row per
`(organization_id, workspace_id, account)` holding `{runs, candidateIndex}` as one `jsonb` blob, same
reasoning as the task queue snapshot. Critically, the dedup/merge algorithm itself (`candidateRecord`,
`findIndexEntry`, `upsertIndexEntry`, `mergeCandidate`, `indexCandidate`, `normalizePlatformAction`,
`samePlatformAction`) was exported from `researchStore.js` — these were already pure functions, so this was
an additive `export` keyword each, not a rewrite — and the Postgres adapter calls them in the identical
sequence the file store does. The cross-run dedup logic literally cannot drift between backends because it's
the same function calls in both. Re-ran `researchStore.js`'s existing 40 unit/integration tests after the
exports and confirmed nothing observable changed.

Real-PostgreSQL test proves the whole point of the cross-run index: a second run re-observing a post a human
already reviewed in an earlier run carries that `confirmed`/`removed` decision forward rather than
re-surfacing it as pending. Also covers invalid-key handling, candidate merge-not-duplicate, `locateCandidate`,
idempotent `recordPlatformAction`, `finalizeRun` validation, `setCandidateStatus` value restriction, tenant
scoping, and real tenant isolation through a non-superuser role. Wired into `.github/workflows/db-migrations.yml`
as the sixteenth PostgreSQL CI step.

**This closes out every M05 domain identified as fitting the migration pattern cleanly.** What's left —
platform accounts/policies (needs an M02 wrapper first), research evidence/device media (object storage per
ADR-0004, not Postgres), background authorization (needs a synchronous cached-snapshot design), operator
identity/accounts (needs an owner decision on reconciling with M04's identity model), leases and devices
(each needs its own design pass) — every remaining domain needs a design or owner decision before further
implementation, not just more mirroring. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **148 files, 1,291 tests, 1,274 passed, 0 failed, 17
skipped** (the 17 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 8: proxy pool, plus scope triage for the remaining domains

Added `automation.proxy_pool` and `postgresProxyPoolRepository.js`, satisfying
`persistence/proxyPoolRepository.js`'s 8-method contract. Reused `proxyPool.js`'s own `publicProxy()`/
`decryptProxyPassword()` pure transforms rather than duplicating them (per that module's own header comment),
and exported its previously-internal `validateFields()` for the same reason — re-ran its existing unit test
to confirm the export change was behavior-preserving. A partial unique index
(`organization_id, leased_to_device_id WHERE ... IS NOT NULL`) gives the "one leased proxy per device"
invariant a real database-level backstop on top of the application-code check.

**Triaged the rest of the master prompt's remaining M05 domains** rather than migrating them all
mechanically: research evidence and device media wrap *binary* file storage, which this repo's own
[ADR-0004](../docs/productionization/adrs/ADR-0004-object-storage.md) already assigns to object storage, not
PostgreSQL — out of scope for this migration pattern entirely. Background authorization
(`persistence/backgroundAuthorizationRepository.js`) is documented as synchronous by design (dispatch-loop
callers need an immediate, non-awaited answer) — a naive `async` adapter would satisfy the method-name
contract but violate that real constraint, so it needs a caching/snapshot design pass, not a direct port.
Operator identity/accounts are the two halves of the legacy `authStore.js` operator system — migrating the
*accounts themselves* (not just references to them) to Postgres would either fork a second permanent
identity/credential store next to `identity.users` or force reconciling the two, which is an owner decision
on the same order as the "one default organization" call already made, not something to default into
silently. That leaves **research runs** as the one cleanly-fitting domain still open.

Real-PostgreSQL test covers field validation, at-rest encryption, the exclusive per-device lease (assign,
reassign displacing the prior lease, release), `remove()`'s leased-proxy guard, `updateHealth()`'s safe-field
filtering, `publicList()`'s credential-free shape, tenant scoping, and real tenant isolation through a
non-superuser role. Wired into `.github/workflows/db-migrations.yml` as the fifteenth PostgreSQL CI step. Full
write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **147 files, 1,290 tests, 1,274 passed, 0 failed, 16
skipped** (the 16 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 7: audit events

Added `automation.audit_events` and `postgresAuditEventRepository.js`, satisfying
`persistence/auditEventRepository.js`'s two-method contract (`logEvent`/`listEvents`) — the domain
`CLAUDE.md` §3 names as "audit events, observability." Mirrors `auditLog.js` exactly: `operator`/`deviceId`
stay plain text, `detail` stays a round-tripped `jsonb` blob (redaction remains the caller's job, not this
layer's), and `listEvents()`'s "filter by operator/deviceId, newest first, then cap at limit" semantics are
expressed directly in SQL (`WHERE` + `ORDER BY at DESC` + `LIMIT`) rather than the file store's in-memory
filter/reverse/slice pipeline — same result, different mechanism.

Real-PostgreSQL test covers the full entry shape and exact `detail` round-tripping, newest-first ordering,
operator/deviceId filtering independently and combined, `limit` handling, an empty result for an organization
with nothing logged, tenant scoping, and real tenant isolation through a non-superuser role. Wired into
`.github/workflows/db-migrations.yml` as the fourteenth PostgreSQL CI step. This closes out the third domain
identified in the M02-persistence-port discovery (notifications, task queue snapshot, audit events); remaining
identified domains are research evidence, research runs, proxy pool, device media, background authorization,
and operator identity/accounts — plus platform accounts/policies, which still needs its own M02 wrapper
first. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **146 files, 1,289 tests, 1,274 passed, 0 failed, 15
skipped** (the 15 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 6: task queue snapshot (command-queue restart survival)

Added `automation.task_queue_snapshots` and `postgresTaskQueueSnapshotRepository.js`, satisfying
`persistence/taskQueueSnapshotRepository.js`'s two-method contract (`load`/`save`). This is the domain the
master prompt names directly — `CLAUDE.md` §7's "queue state survives process restarts." Per the port's own
design intent, the snapshot is one opaque `jsonb` blob per organization, not per-task rows — `taskQueue.js`
keeps all scheduling/dispatch/retry/checkpoint domain logic; only the read/write boundary moved.

The one piece of real logic in this domain — legacy bare-array migration and crash recovery for tasks that
were `RUNNING`/`DISPATCHED` when the process died — was extracted into an exported pure function,
`normalizeQueueSnapshot()`, in the contract module itself, so both the file and Postgres adapters share
exactly one copy rather than risking drift between two reimplementations of restart-recovery logic. The file
adapter's existing unit test was re-run after the extraction and passed unchanged.

Real-PostgreSQL test covers an empty snapshot before any save, exact round-tripping of tasks/paused/
humanHolds, `save()` upserting a single row per organization, RUNNING-task recovery into QUEUED within its
retry policy (and that a second `load()` doesn't double-apply the recovery), legacy bare-array migration
persisting the migrated shape, tenant scoping, and real tenant isolation through a non-superuser role. Wired
into `.github/workflows/db-migrations.yml` as the thirteenth PostgreSQL CI step. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **145 files, 1,288 tests, 1,274 passed, 0 failed, 14
skipped** (the 14 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 5: account notifications, and a discovery about remaining scope

Added `automation.account_notifications` and `postgresNotificationRepository.js`, mirroring
`accountNotificationStore.js` exactly (queue/list/deliveryContent/markCommitted/markAborted/markSent/
markFailed/canSecureRecovery). The AES-256-GCM encrypt/decrypt logic for recovery bodies was extracted out of
the file store's closures into exported, key-parameterized functions (`encryptNotificationBody`/
`decryptNotificationBody`) that both adapters now import, rather than duplicating security-sensitive crypto
code — re-verified the file store's own unit test still passes unchanged after the extraction. The schema
enforces the file store's "recovery bodies are never at rest in plaintext" guarantee directly with a `CHECK`
constraint tying `body`/`secure_payload` to `kind`, not just in application code.

**Scope discovery while picking this slice:** `system/server/src/persistence/` already contains a formalized
M02 repository-port layer (`assertXRepository()` + `fileXRepository.js`) for far more domains than this
status file had been tracking — research evidence, research runs, task queue snapshots, proxy pool, device
media, background authorization, operator identity, operator accounts, and audit events all already have one,
and `index.js` already calls through these ports rather than constructing the underlying stores directly. That
means most of the master prompt's remaining M05 domains are now Postgres-adapter-only work (no new M02
contract design needed) — the one exception found so far is platform accounts/policies (`policyStore.js`),
which `index.js` still constructs directly and has no M02 port yet.

Real-PostgreSQL test covers queue/list ordering, the `holdForCommit` → `markCommitted`/`markAborted` path
(idempotent on repeat calls), `markSent`/`markFailed`'s "only advance a still-queued item" guard, `mark*()` on
an unknown id returning `null`, recovery notifications being encrypted at rest and decrypted only through
`deliveryContent()`, `canSecureRecovery()` requiring no DB access, tenant scoping, and real tenant isolation
through a non-superuser role. Wired into `.github/workflows/db-migrations.yml` as the twelfth PostgreSQL CI
step. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **144 files, 1,287 tests, 1,274 passed, 0 failed, 13
skipped** (the 13 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 4: assignments

The complex domain flagged in the previous entry. Added `automation.assignments` (mirrors `assignmentStore.js`
exactly plus `organization_id`) and `postgresAssignmentRepository.js`, implementing all 8 contract methods
(`list`, `get`, `create`, `setStatus`, `reassign`, `renamePrincipal`, `reschedule`, `expireDue`). The
identity-mapping question flagged last entry was resolved the same way as approvals/interventions:
`assignee`/`createdBy` stay plain text tied to the file-backed `authStore.js` operator system, not
`identity.users` — reconciling that with M04's user model is a separate decision this slice does not force.
Timestamps are real `timestamptz` (unlike approvals'/interventions' bigint epoch-ms), explicitly re-serialized
back to ISO strings in the row mapper so the contract keeps returning what the file store always returned.
Recurrence reuses `zonedRecurrence.js` unchanged.

Two bugs found and fixed during this slice's own "check for errors, fix, check again" pass, not by CI (no
local database exists to run the real test against):

1. **`expireDue()` frozen-snapshot divergence** — the file store's `assertNoOverlap` closes over a pre-tick
   snapshot of all assignments, so within one batch tick every overlap check sees the same frozen state, never
   a sibling row already advanced earlier in the same tick. A first draft using a live DB query per row inside
   one shared transaction would have let an earlier row's update leak into a later row's overlap check —
   fixed by fetching one snapshot query up front and checking candidates against that static array instead.
2. **A tautological test assertion** in the conflict-isolation test that would pass regardless of the actual
   value — found on a self-review of the test file, replaced with real assertions on the expected `status` and
   `startAt`.

Real-PostgreSQL test covers create/list/get, overlap rejection and non-overlap success, `setStatus` state
transitions and history, recurring-completion window advancement, `reassign`/`renamePrincipal`/`reschedule`,
plain and recurring-with-conflict-isolation `expireDue` cases, tenant scoping, and real tenant isolation
through a non-superuser role. Wired into `.github/workflows/db-migrations.yml` as the eleventh PostgreSQL CI
step. This closes out the four M05 domains attempted so far (sites, approvals, interventions, assignments);
remaining M05 domains (leases, platform accounts/policies, task queue/runs/checkpoints, research metadata,
notifications, proxy/network metadata, audit metadata) are not started. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite re-run after this addition: **143 files, 1,286 tests, 1,274 passed, 0 failed, 12
skipped** (the 12 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 3: interventions

Same shape and reasoning as approvals — `InterventionQueue` is exactly the same kind of small, self-contained,
already-tested class with a stable M02 contract. Added `automation.interventions` (mirrors its exact fields
plus `organization_id`) and `postgresInterventionRepository.js`, reusing the file store's own
`classifyIntervention()` reason-to-kind heuristic rather than reimplementing it, and throwing the identical
plain `Error` messages the file store throws (`InterventionQueue` has no custom error class, unlike
`ApprovalStore`/`SiteStore` — parity means matching that, not adding one it never had).

One deliberate non-parity decision, recorded rather than silently applied: this adapter does **not** replicate
`InterventionQueue`'s own `_trim()` (capping `RESOLVED` items to bound JSON file size) — a database table
doesn't have the unbounded-file-growth problem that only existed because of the old storage format; real
retention/pruning is a policy decision for later, not something to force into parity with a workaround that no
longer applies.

Real-PostgreSQL test proves task+kind deduplication (with auto-classification), claim/resolve state
transitions including the identical "Already claimed by X" rejection message, resolve-on-already-resolved
being a safe no-op that doesn't overwrite who resolved it first, `resolveForTask()` closing every open item at
once, and — same as sites/approvals — genuine tenant isolation through a non-superuser role. Wired into
`.github/workflows/db-migrations.yml` as the tenth PostgreSQL CI step. This closes out every M05 domain that
fits the "small, self-contained, already-tested class" shape; **assignments** is next and is meaningfully more
complex (recurrence, overlap detection, a JSON history array, and its own identity-mapping question, since its
`assignee`/`createdBy` fields are plain operator-username strings tied to the file-backed `authStore.js`
system, not `identity.users`). Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite: **142 files, 1,285 tests, 1,274 passed, 0 failed, 11 skipped** (the 11 skips are
every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 part 2: approvals (and why devices was skipped for now)

Before starting "devices" (next in the master prompt's suggested M05 order), repository inspection found a
real reason to reorder: `deviceRegistry.js` is a 77-line pure transform, not a stateful store like `SiteStore`
— device state is deeply live (connection status, capabilities, health reconstructed from actual USB/WDA
discovery on every restart), not simple CRUD data. Forcing that into today's "swap the persistence adapter
behind an unchanged contract" pattern would misrepresent what's actually happening. `approvalStore.js`, by
contrast, is exactly `SiteStore`'s shape — a small, self-contained, already-tested class with a stable M02
contract — so it became the second M05 domain instead, per the master prompt's own "follow this order unless
repository inspection proves a dependency requires adjustment."

Added `automation.approvals` (mirrors `ApprovalStore`'s exact fields plus `organization_id`; timestamps stored
as `bigint` epoch-ms, not `timestamptz`, deliberately matching the file store's `Date.now()`-based values
exactly rather than silently changing the adapter's return shape) and
`postgresApprovalRepository.js` — reuses `ApprovalStore`'s own `ApprovalError`/`approvalFingerprint`/
`APPROVAL_STATES` rather than reimplementing them, and replicates its lazy-expire-on-every-operation semantics
exactly (every method expires stale `PENDING`/`APPROVED` rows before doing its own work).

Real-PostgreSQL test proves fingerprint deduplication, approve/reject/consume semantics (including that a
double-consume returns `null` rather than consuming twice), identical `ApprovalError` codes for every rejected
case the file store rejects, lazy expiry actually firing on read (not silently vanishing), and — same as
sites — genuine tenant isolation through a non-superuser role. Wired into `.github/workflows/db-migrations.yml`
as the ninth PostgreSQL CI step. Full write-up in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md).
Full local server suite: **141 files, 1,284 tests, 1,274 passed, 0 failed, 10 skipped** (the 10 skips are
every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M05 begins: durable domain migration, sites (owner decision resolved)

Before starting M05 (migrating the existing file-backed domains — sites, devices, assignments, queue, etc. —
into PostgreSQL), hit a real fork rather than guessing through it: every migrated row needs an
`organization_id` per the master prompt's schema, but M04's cloud identity system is separate, parallel
infrastructure with no connection to the existing single-tenant site/device data. Asked directly: **the
existing deployment wraps in one auto-created default organization** (not left tenant-less). Recorded in
[docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md](productionization/M05_DURABLE_DOMAIN_MIGRATION.md)
since it shapes every subsequent M05 domain, not just this one.

Built the pattern each future domain should follow: `db/defaultOrganization.js` (idempotent bootstrap, `ON
CONFLICT ... DO UPDATE ... RETURNING`, not check-then-insert — safe against two processes racing on a fresh
database), a `fleet.sites` migration mirroring the existing file-backed `SiteStore`'s exact fields plus
`organization_id`, and `postgresSiteRepository.js` — satisfying the identical M02 `siteRepository.js` contract
(same methods, same `SiteError`/`duplicate_site`/`unknown_site` codes) so a caller never needs to know which
adapter is active. **`index.js` still uses the file adapter exclusively — nothing was cut over, no real site
data was migrated.** This is the "new implementation behind interface" step of the migration principle, not
the cutover.

Real-PostgreSQL test proves parity with the file adapter (identical create/rotate/verify/error-code behavior)
plus genuine tenant isolation on the new table through a non-superuser role — a different organization's
context sees nothing of the default organization's sites. Wired into `.github/workflows/db-migrations.yml` as
the eighth PostgreSQL CI step. Full local server suite: **140 files, 1,283 tests, 1,274 passed, 0 failed, 9
skipped** (the 9 skips are every PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M04 part 6c: member suspension/reactivation

Closed the *suspension* half of the "suspension/deletion lifecycle" gap (hard deletion stays out of scope —
M16's GDPR-style anonymization work, not this milestone's). The enforcement already existed by construction:
`requireMembership()` already 403s a non-active membership and `authenticate()` already 401s a non-active
user, on every request. What was missing was the admin-facing way to actually change that status. Added
`GET /organizations/:id/members` (any active member can see the roster — no dedicated `member:view`
permission exists, matching the common default that team visibility isn't itself privileged) and
`PATCH /organizations/:id/members/:membershipId` (gated by `member:manage`, deliberately refusing to let a
caller change their own membership through this route — the simplest way to prevent an org locking itself out
of its own management, rather than building unverified "at least one active owner" invariant logic).

The real-PostgreSQL/real-HTTP test proves the enforcement is genuinely immediate, not just theoretically so: a
target user's session works, a manager suspends them, and that *same still-valid, unrevoked* session is
rejected on the very next request — no session revocation needed, because membership status is checked fresh
on every request already. Also covers wrong-role rejection, an invalid status value, self-targeting, and a
membership id from a different organization (400/400/404). Full write-up in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **138 files, 1,280 tests, 1,272 passed, 0 failed, 8 skipped** (unchanged counts — the new
subtests live inside the already PostgreSQL-gated `cloudApi.test.js`).

## 2026-09-26 — M04 part 6b: signup-from-invitation, real email delivery, password validation

Closed out three items part 6 had left open. `POST /signup-from-invitation` lets someone with no existing
account complete an invitation in one step — creates the user under the invitation's own email (never a
client-supplied one), marks it verified immediately (completing an *emailed* invitation link already proves
control of that address), then accepts. `createCloudApi()` gained optional `mailSender`/`companyEmail`
parameters (default `null` — every flow still works without them, just logs locally instead of sending,
matching `accountNotificationStore.js`'s own established convention); `/signup`, `/organizations/:id/invitations`,
and `/password-reset/request` now actually call `mailSender.js`, fire-and-forget so a slow or failing SMTP
call never adds latency to the HTTP response — matching this codebase's existing password-recovery-route
precedent for exactly that timing-side-channel reason. Also exported and wired in `authStore.js`'s existing
`validatePassword` (12-character minimum) to `/signup`, `/signup-from-invitation`, and `/password-reset/confirm`
— previously `/signup` accepted a password of any length, including empty.

New real-PostgreSQL/real-HTTP test coverage: signup-from-invitation creates a real, immediately-usable
account+session and rejects a reused token; a fake `mailSender` (recording calls) proves the three routes
above call it with the right recipient/content and that an unknown email triggers no send; an unknown
organization id 404s rather than 403ing; `/me/mfa/enroll` demonstrates `authenticate` behaves identically on a
route with no membership/permission layer. Full write-up in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **138 files, 1,280 tests, 1,272 passed, 0 failed, 8 skipped** (unchanged file/test counts
from part 6 — the new subtests all live inside the same PostgreSQL-gated `cloudApi.test.js`, which node:test
skips as one unit locally, same as every other DB-gated file).

## 2026-09-26 — M04 part 6: a real HTTP API and the required authorization matrix

Built `system/server/src/cloudApi/createCloudApi.js` — a self-contained Express app (signup, login with TOTP
MFA check, logout, `/me`, invitations, MFA enroll/confirm, password reset, email verification), deliberately
**not mounted into `system/server/src/index.js`**: it's new infrastructure for the master prompt's future
multi-tenant "Cloud Control Plane," architecturally separate from the existing single-tenant Human VA Mode
server. Every route is a thin translation to the already-tested service layer.

Building `GET /me` (list every organization a user belongs to) surfaced a real RLS gap: the existing tenant
policy only ever makes one `organization_id` visible per transaction, which would have hidden this
legitimately cross-tenant, self-scoped read entirely. Fixed with a new migration adding a second, SELECT-only
permissive policy keyed on a new `app.current_user_id` GUC (Postgres OR's multiple permissive policies
together — documented behavior) — deliberately not `FOR ALL`, since allowing writes under "user_id = me" would
let anyone insert a membership row for an organization they don't belong to. `withTransaction()` gained a
matching `userId` option.

Then built the master prompt's actual required authorization test matrix — anonymous / wrong organization /
wrong role / correct role / disabled user / expired session / revoked session — against a real, `.listen()`-ed
instance of the app, driven with real `fetch` calls, on `POST /organizations/:id/invitations`. All seven cases
pass locally against the mocked middleware layer; the real-HTTP-plus-real-Postgres version is wired into
`.github/workflows/db-migrations.yml` and awaits that workflow's first run, same as everything else in M04.

This is the deepest point M04 reaches this session: full write-up, what's deliberately NOT covered (email
delivery, the matrix on every *other* endpoint, where this API actually deploys), and the open decisions in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **138 files, 1,280 tests, 1,272 passed, 0 failed, 8 skipped** (the 8 skips are every
PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M04 part 5: email verification and password reset

Added `identity.email_action_tokens` (one new table backing both flows — they're nearly mechanically identical:
hashed, expiring, single-use tokens tied to a `purpose`) via a new migration, plus
`emailActionTokenRepository.js`/`emailActionService.js`. Requesting a new verification or reset token
invalidates any still-live one for the same user/purpose, so an old unread email link goes inert. A
password-reset token can't be replayed as a verification token or vice versa (checked at resolution time, not
just trusted from issuance). `resetPassword()` reuses `authStore.js`'s `hashPassword` and, when given a
session repository, revokes every existing session for that user — a reset is a security event that should
end other sessions, not coexist with a possibly-compromised one. Neither flow sends email yet;
`mailSender.js` already handles delivery for the file-backed system and is next in line to wire up, not
reinvent.

This closes out every M04 organization/identity sub-domain the master prompt named except signup-from-
invitation, WebAuthn, and — the big remaining one — **any actual HTTP route**, which is where the master
prompt's real authorization test matrix (anonymous/wrong-org/wrong-role/disabled/expired/revoked per sensitive
endpoint) becomes buildable and required. 9 new mocked unit tests plus a real-PostgreSQL integration test
(verification marks the real `user_emails.verified_at`, reset updates the real hash and revokes a real
session, a second reset request invalidates the first), wired into `.github/workflows/db-migrations.yml` as
the sixth PostgreSQL CI step. Full write-up in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **136 files, 1,268 tests, 1,261 passed, 0 failed, 7 skipped** (the 7 skips are every
PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M04 part 4: TOTP MFA and recovery codes

Added `identityMfaRepository.js`/`identityMfaService.js` against `identity.mfa_methods`/`recovery_codes`,
reusing `twoFactor.js`'s existing TOTP/AES-GCM/recovery-code implementation (already relied on elsewhere in
this codebase for proxy credential encryption) rather than a second crypto implementation — this only adds
the PostgreSQL persistence shape: enroll (stores the encrypted secret, returns the plaintext secret and QR URI
once), confirm (a real authenticator code moves the method from pending to verified and issues 10 recovery
codes, only their hashes persisted), verify-login (checks only *verified* methods — a pending enrollment can
never authenticate), single-use recovery-code consumption, disable.

9 mocked unit tests isolate the service's own logic against fake crypto; the real-PostgreSQL integration test
deliberately uses the REAL `twoFactor.js` functions (not fakes) so the actual encrypt/decrypt/TOTP round trip
through real storage is what gets verified once CI runs it — a genuinely generated code confirms enrollment
and later logs in, a stale code is rejected, a real recovery code is confirmed hashed at rest and single-use.
Wired into `.github/workflows/db-migrations.yml` as the fifth PostgreSQL CI step. Full scope, what's still open
(email verification/password reset, signup-from-invitation, WebAuthn), and everything else in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **134 files, 1,258 tests, 1,252 passed, 0 failed, 6 skipped** (the 6 skips are every
PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M04 part 3: invitations

Added invitation issuance/acceptance against `identity.invitations`. A small additive migration
(`1758839400000_add-role-to-invitations.js`) adds a `role_key` column the original schema design didn't
include — recorded up front as a deliberate schema disagreement, not a silent workaround. `invite()` validates
the role exists before creating anything; `acceptInvitation()` runs the accepted-state re-check, membership
creation, and role assignment inside one transaction, so two concurrent acceptance attempts of the same
invitation can't both succeed and a failure anywhere leaves nothing behind. Deliberately scoped to adding an
*existing* user to an organization — signup-from-invitation (creating a brand-new account) needs a password-
choosing flow this pass didn't build, and is called out as follow-up work rather than glossed over.

10 new mocked-repository unit tests plus a real-PostgreSQL integration test (accepted role grants exactly the
right permissions, double-acceptance rejected without disturbing the first membership, revoked invitations
rejected), wired into `.github/workflows/db-migrations.yml` as the fourth and final PostgreSQL CI step so far.
Full scope and open items in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Full
local server suite: **132 files, 1,248 tests, 1,243 passed, 0 failed, 5 skipped** (the 5 skips are every
PostgreSQL-gated test, correctly skipping without a live database).

## 2026-09-26 — M04 part 2: identity sessions

Added `identitySessionRepository.js`/`identitySessionService.js` against `identity.sessions`: issue/verify/
revoke/revoke-all/list-active, tokens hashed at rest using the same `crypto.randomBytes` + sha256 convention
already proven in `siteStore.js`'s enrollment tokens, raw token returned exactly once from `issueSession()`.
A validity check (`verifySession`) never touches `last_seen_at` itself, so probing a token can't masquerade as
real activity — callers call `touchSession()` explicitly for that. 8 new mocked-repository unit tests plus a
real-PostgreSQL integration test (issue/verify, revoke blocks verification without deleting the audit row,
revoke-all scoped correctly to one user, a session id can't be substituted for its token), wired into
`.github/workflows/db-migrations.yml` after the M04-part-1 test. Full details in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md), status
still **PASS WITH KNOWN LIMITATIONS** pending that workflow's first real run. Full local server suite:
**130 files, 1,237 tests, 1,233 passed, 0 failed, 4 skipped** (the 4 skips are every PostgreSQL-gated test,
correctly skipping without a live database).

## 2026-09-26 — M04 part 1: organization/user/membership/RBAC core

Built the first slice of M04 (organizations, users, memberships, roles/permissions) as a Postgres-backed
service layer alongside — not replacing — the existing file-backed `authStore.js`/`operators.config.json`
system. A second migration seeds the master prompt §4's 21-permission catalog and 7 system-template roles
(owner/administrator/manager/va_operator/researcher/reviewer/billing_admin); `organizationIdentityService.js`
composes `db/repositories/{organization,user,membership,role}Repository.js` inside real transactions —
`createOrganizationWithOwner()` creates an org, its first user, and an owner-role membership atomically, reusing
`authStore.js`'s own `hashPassword`/`verifyPassword` rather than a second password implementation.

Found and fixed a real bug while wiring the CI test for this in: the first draft of the seed migration passed
array parameters to node-pg-migrate's `pgm.sql()`, assuming Postgres-style `$1`/`$2` positional binding — that
function actually does its own `{name}`-style text substitution (checked against the installed package's own
type declarations, since nothing here can run it to find out empirically) and would have silently done the
wrong thing. Rewrote to use `pgm.db.query()`, which does take real parameterized SQL. Separately, discovered
node-pg-migrate's `down` reverts only the single most-recently-applied migration by default — with two
migrations now, the M03 tenant-isolation test's "down must remove the identity schema" assertion needed an
explicit `down 0` (revert everything) or it would have quietly tested the wrong thing.

Full scope, what's explicitly NOT built yet (sessions, MFA, email verification, invitations, any HTTP route),
and the open product decisions this deliberately did not guess at (Owner vs. Administrator distinction, how
this reconciles with the existing 5-role `roleCapabilities.js` model) are in
[docs/productionization/M04_ORGANIZATION_IDENTITY.md](productionization/M04_ORGANIZATION_IDENTITY.md). Status:
**PASS WITH KNOWN LIMITATIONS, PART 1 ONLY** — real verification is a new PostgreSQL integration test
(`organizationIdentity.test.js`) wired into `.github/workflows/db-migrations.yml`, which has not run in CI yet.

Locally verifiable pieces: 11 new mocked-pool unit tests for the repositories/service passed; both
PostgreSQL-gated test files confirmed to skip (not silently pass) without `TEST_DATABASE_URL`; `node --check`
passed on every new file. Full local server suite: **128 files, 1,228 tests, 1,225 passed, 0 failed, 3
skipped** (the 3 skips are the PostgreSQL-gated tests, correctly skipping without a live database).

## 2026-09-26 — M03: PostgreSQL foundation (unverified locally; CI-verified only)

Added the migration framework (`node-pg-migrate`), connection pool/health-check/transaction helpers
(`system/server/src/db/`), and the first migration — the identity/organization schema recommended by
[DATABASE_GAP_ANALYSIS.md](productionization/DATABASE_GAP_ANALYSIS.md)'s "first database slice" section, with
Row-Level Security on every tenant-scoped table. **No application code reads or writes this schema** — that is
a separate, not-yet-started milestone (M04).

This environment has no PostgreSQL, Docker, or database client installed, so none of this could be run against
a live database directly. Instead, [`.github/workflows/db-migrations.yml`](../.github/workflows/db-migrations.yml)
runs it for real against an ephemeral `postgres:16` GitHub Actions service container: migrate up, a genuine
tenant-isolation test through a non-superuser role (Org A/Org B cross-tenant SELECT/INSERT/UPDATE/DELETE
negative tests, plus a fail-closed check with no tenant context set), then migrate down and verifies the schema
is actually gone. **That workflow has not run yet as of this writing** — full details, exact scope decisions,
and what remains before M04 can start are in
[docs/productionization/M03_POSTGRES_FOUNDATION.md](productionization/M03_POSTGRES_FOUNDATION.md). Status is
recorded there as **PASS WITH KNOWN LIMITATIONS**, not PASS, until that workflow is confirmed green.

Locally verifiable pieces: 15 new unit tests for the pool/health/transaction helpers (mocked, no live database)
passed; `node --check` passed on every new file; `npm audit` is 0 vulnerabilities after pinning
`node-pg-migrate` to `^9.0.0` (an earlier `^7.0.0` resolution pulled in a `glob` version with a published high
severity advisory).

## 2026-09-25 — M02: remaining persistence-interface slices complete

Closed out every domain named in [M02_MODULARIZATION.md](productionization/M02_MODULARIZATION.md)'s remaining-slices
list with the same pattern as the slices before it: a repository contract, a file adapter that delegates to the
existing, still-authoritative implementation unchanged, and direct unit tests. Five slices landed in this pass:

1. **Sites and site credentials** — `siteRepository.js`/`fileSiteRepository.js` wrap `SiteStore`.
2. **Device assignments** — `assignmentRepository.js`/`fileAssignmentRepository.js` wrap `createAssignmentStore`.
   Device *leases* stayed out of scope: `deviceLease.js` is in-process controller-mode state with no file store
   behind it to wrap.
3. **Task queue snapshot** — `taskQueueSnapshotRepository.js`/`fileTaskQueueSnapshotRepository.js` extract
   the queue's atomic snapshot read/write and restart-recovery logic out of `taskQueue.js`; its scheduling/
   dispatch/retry mechanics stayed put since that's domain logic, not persistence.
4. **Approvals, interventions, research runs/evidence** — four repository/adapter pairs wrapping `ApprovalStore`,
   `InterventionQueue`, `researchStore.js`, and `researchEvidenceStore.js`, now used consistently by both the
   HTTP routes and `researchTaskRunner.js`'s dependency injection (previously the runner silently fell back to
   raw module imports instead of the same instances the routes used).
5. **Notifications, proxy pool, device media, research evidence** — `notificationRepository.js`,
   `proxyPoolRepository.js` (binds `proxyPoolStorePath` once instead of threading it through 9 call sites),
   `deviceMediaRepository.js`, and `researchEvidenceRepository.js` (screenshot save/resolve).

Every slice kept its existing file store authoritative, migrated no data, and changed no HTTP/WebSocket
behavior — see [M02_MODULARIZATION.md](productionization/M02_MODULARIZATION.md) for the exact scoping decisions
(what stayed a direct import and why) and the "M02 status" section for what this does and does not unblock:
M03 (PostgreSQL foundation) still requires the identity/organization schema and tenant-negative tests, which are
separate, not-yet-started M04-adjacent work.

Verification: full server suite run after every slice, culminating at **122 files, 1,199 tests, 1,199 passed, 0
failed, 0 skipped**. `node --check` passed on every changed entry point; `git diff --check` passed throughout.
Nothing in this pass was committed — left for manual review per the working session's instruction.

## 2026-09-25 — M02: background task/assignment/research authorization boundary

A fifth M02 slice moved the task queue's dispatch predicate, assignment target validation, and background
task-access checks off direct `authStore.js`/`researchAccess.js` imports and onto one named, synchronous
authorization boundary (`system/server/src/services/backgroundAuthorizationService.js` and its repository
contract/file adapter). Unlike the identity/session slices, this boundary stays synchronous by design — the
task queue's dispatch loop and the assignment routes' inline validation both need an immediate answer — and
that tradeoff, along with what a future async-backed identity source would need to do instead (publish a
refreshed snapshot behind the same boundary rather than making dispatch itself async), is written down in
[`docs/productionization/M02_MODULARIZATION.md`](productionization/M02_MODULARIZATION.md#background-task-assignment-and-research-authorization-identity-resolution).
`researchTaskRunner.js` also gained an injectable `canAccessDevice` parameter, matching its two existing
injected authorization resolvers instead of importing the third directly. No operator data was migrated;
`operators.config.json` remains authoritative, and no HTTP/WebSocket request-scoped authorization check was
touched. New file: `system/server/test/unit/backgroundAuthorizationService.test.js`.

## 2026-09-25 — productionization baseline and proposed architecture

The productionization program now has a source-and-test baseline plus an M01 architecture package under
[`docs/productionization/`](productionization/README.md). The package records the cloud/site execution
boundary, PostgreSQL authority, ephemeral Redis use, object storage, secret references/KMS, tenant and identity
models, billing abstraction, transactional outbox/audit model, and deployment topology. It also includes the
domain model and ERD, trust boundaries, data classification, threat model, and a table-by-table reconciliation
of the proposed database schema.

This milestone changes documentation only. It does not switch persistence, enable a cloud service, migrate
customer data, or alter device/runtime behavior. Organization/workspace semantics, identity provider, billing
provider/prices, cloud/regions, retention, licensing, legal identity, and native-mobile launch scope remain
explicit owner decisions. M02 service and persistence interfaces must preserve current behavior before any
database migration begins.

M01 was subsequently accepted as the direction for incremental implementation. M02 is now in progress. Its first
bounded slice introduces an audit-event repository contract, keeps the existing JSONL adapter authoritative, and
moves device-grant-aware audit reads into an audit service. No audit data was migrated and no API behavior was
intentionally changed. A second bounded slice now places the existing file session store behind the callback
contract required by both Express and WebSocket upgrades; its atomic files and revocation tombstones remain
authoritative. A third slice routes administrative account lifecycle operations through an async-first service and
repository while retaining `operators.config.json` as authority. A fourth slice now routes password login, pending MFA
identity reads, HTTP authentication/capability middleware, stored-session checks, and delayed network-check
reauthorization through an async-first identity service. The live `operators.config.json` projection remains
authoritative. Signup, recovery, and MFA persistence now use that same async boundary while delegating to the
existing atomic file implementation. WebSocket upgrade and per-message/session authorization now use an
async-refreshed, generation-ordered socket identity snapshot, preserving synchronous device authorization callbacks
and fail-closed mid-action revocation. Account updates now reconcile both controlled-device and read-only-watch
sessions before their response completes. Background queue/scheduler authorization remains bounded follow-up work. See
[`docs/productionization/M02_MODULARIZATION.md`](productionization/M02_MODULARIZATION.md).

## 2026-09-23 — required desktop version gate and direct release installers

Packaged desktop builds now check the public Phone Farm GitHub Releases feed before opening any host,
site-agent, or client window. When the installed and published versions differ, the operator must choose
**Update now**. Choosing **No — exit**, or exiting after a failed check/download, leaves the application
closed. The downloaded `.pkg`/`.exe` is constrained to trusted GitHub HTTPS hosts and is opened only after
its declared size and GitHub-provided SHA-256 digest match. Source/development launches skip this gate.

The Windows release artifact now has the stable user-facing name `Phone-Farm-Windows.exe`. The macOS
workflow reserves `Phone-Farm-macOS.pkg` for a signed/notarized package; until Apple credentials are
configured, the verified Apple-silicon package is a clearly marked unsigned Actions artifact rather than a
misleading stable Release download. The three root `BUILD_PHONE_FARM_INSTALLER.*` developer wrappers were
removed so they cannot be mistaken for the application. The actual large binaries remain release/CI assets
rather than Git-tracked files; CI still owns the platform-specific build, test, and packaging steps.

Automated tests cover version ordering, platform asset selection, digest/size enforcement, acceptance and
decline paths, failure-closed handling, and Electron lifecycle events attempting to bypass a denied gate.
Windows-local validation: desktop **159/159**, server **1,143/1,143**, both dependency audit gates clean,
and `Phone-Farm-Windows.exe` built with its packaged runtime verified. GitHub Actions run 35893483741 built,
installed, boot-tested, and uploaded the v0.2.2 arm64 unsigned `.pkg` on macOS; run 35893483864 built and
verified the Windows installer. This is packaging/update automation only: no physical Mac mini or iPhone
acceptance is claimed here, and the macOS stable Release asset remains blocked on Apple signing/notarization.

## 2026-09-21 — larger phone view and low-latency transport decision

The desktop live phone was artificially capped at 320 px wide and 660 px high.
It now uses up to 480 px / 860 px in the normal workspace, gets a larger desktop
column, and has a full-screen phone mode that preserves canvas-based input
coordinates. The WDA profile now asks for 30 fps at 50% scale and quality 45.
The relay begins dropping video at a 128 KiB WebSocket backlog instead of 1 MB,
so slow links keep the newest picture rather than displaying a queue of old
frames.

WDA remains the supported automation and fallback video path. Research found
that its MJPEG feed cannot satisfy a zero-backlog, smooth real-time target on
its own because it captures and JPEG-encodes each frame. The recommended
iOS 17+ experiment is CoreDevice HEVC display streaming plus CoreDevice HID
input. Requirements, licensing constraints, performance gates, and the staged
implementation plan are in [LIVE_CONTROL_TRANSPORT.md](LIVE_CONTROL_TRANSPORT.md).

## 2026-09-19 (latest) — response to the review of commit ae8b2f9: both CI runs were red, now fixed

The first GitHub run of the installer pipeline (macOS run 35432249587, Windows run 35432249628) failed. The review's findings were
each reproduced or checked before changing anything:

| Finding | Verdict | What was done |
|---|---|---|
| **Server exits 0 without listening when started through a symlinked folder** (macOS installer verification: "server did not report a listening port (exit=0)") | **Reproduced here** with a directory junction (direct path listens; linked path exits 0). Root cause: `import.meta.url === pathToFileURL(process.argv[1]).href` compares a symlink-resolved URL with an unresolved path; macOS temp folders are `/var` -> `/private/var`. | New `server/src/directExecution.js` compares real paths (case-insensitive on Windows); used by **both** `index.js` and `agentMain.js`. Tests start the real server and the real site agent through a linked folder, plus unit tests of the helper. The verifier's failure message now names this cause. |
| **4 Windows test failures** (`firstRunPage.test.js`: "runFix is in the page") | **Reproduced** by converting the page to CRLF, which is what a Windows checkout produces. The test's regex assumed LF. | The test now cuts the function out by matching braces after normalising any line ending; a test proves LF, CRLF and CR all work. The page itself was never broken. |
| `provisioningBoot.js` ignores the `env` it is given (preflight, iproxy, discovery tools, signing team fall back to global `process.env`) | **Confirmed** (harmless today because both callers pass `process.env`, but inconsistent). | Everything is now read from the supplied `env`, with bare command names as fallbacks; 4 tests, including "a value present only in the global environment is not picked up". |
| Multer 1.x (deprecated, known vulnerabilities) | **Confirmed**; `npm audit` was 0 but the package itself warns. | Upgraded to Multer 2.4.0; full server suite (uploads included) passes; a test keeps it on 2.x. |
| `.DS_Store` not ignored; `desktop/package.json` has no `author` | Confirmed | Ignored; `author` added (silences electron-builder's warning). |
| README points at `/releases/latest`, which is a 404 until a release exists | Confirmed | README now says where to get the installer before the first release (Actions artifact). |
| No Developer ID certificates configured -> `-UNSIGNED.pkg` | Correct, and **cannot be fixed in code**: needs your Apple Developer ID Application + Installer certificates and notarization credentials as GitHub secrets (`docs/MAC_RELEASE.md`). Until then the package works but macOS warns. | none |
| `electron-winstaller` install script "not approved by allowScripts" | Windows packaging had not been reached. Checked by running the real `npm run dist:win` locally: the real `npm run dist:win` (NSIS) completed and produced a 114 MB installer, and its packaged server booted, so nothing is blocking there | none needed if the build succeeded |
| Deprecated transitive build tooling (`glob@7`, `rimraf@2`, ...) | Build-only, audits clean | left as is |

Not a bug and untouched: the earlier `/time` timezone failures are fixed; the review confirms all 1,095 server tests passed on the macOS runner.
The pipeline got as far as producing `Phone-Farm-0.1.0-arm64-UNSIGNED.pkg` (electron-builder, pkgbuild and productbuild all succeeded) before
failing in the post-build verification, so the macOS install-to-`/Applications` step and the artifact upload have still never run. The same
caveat applies to the Windows installer build. **After this fix, re-run both workflows and review whatever the later stages show.**

---

# 2026-10-02 (latest, part 21) — privacy completion engine, coordinated backup sets, bounded operations metrics, and rendered role checks

The policy-driven privacy lifecycle now continues from `account_locked` through
durable, idempotent `processing`, `retryable_failed`, and `completed` states.
Access is revoked before cleanup, every destructive category reauthorizes the
initiating administrator, progress is checkpointed by category, restart recovery
releases interrupted claims, and concurrent workers have one winner. Planning
returns bounded counts only. Account-owned assignment and task references are
pseudonymized; the account record is stripped of credentials, recovery, 2FA,
security, contact, grant, and session data. Shared records are retained. Media
deletion remains disabled until media has demonstrable account ownership, and
the whole processor fails closed unless an explicit versioned policy selects a
mode for every category. No legal retention duration was invented.

Backup tooling now creates one UUID backup-set manifest that binds the encrypted
file snapshot and encrypted PostgreSQL dump by streaming SHA-256 hashes,
versions, timestamps, membership counts, and required secret *names*. It never
stores secret values. Publication is an atomic rename after both components and
their reconciliation pass; failed staging is removed. Verification rejects
tampering, mixed components, unexpected members, symbolic links, unsafe or
existing destinations, and incomplete sets. Restore requires an exact
confirmation, a new filesystem target, and an explicitly disposable database.
This is a locally tested workflow, not evidence of crash consistency, PITR,
off-host durability, an achieved RPO/RTO, or a completed recovery drill.

The protected metrics surface now exports only fixed-vocabulary aggregates for
device connectivity/controllability, queue state, open intervention category,
routed/protected device totals, and AI outcomes. Tests enumerate the permitted
labels and exclude usernames, device IDs, accounts, URLs, paths, tokens,
screenshots, proxy material, and arbitrary errors. Alerts and dashboard panels
were added only for states with runbook responses. Alert delivery remains a
deployment gate.

A real Electron BrowserWindow harness now checks each real operator role exactly
once: Host, Admin, Manager, VA, Content Creator, and Editor. It checks role and
capability-derived panel visibility, human-mode input ownership, and a separate
manager viewing an AI-controlled device read-only, plus keyboard focus, desktop and
narrow overflow, live-screen geometry, full-screen entry/exit handling,
read-only input ownership, dark-state rendering, and reduced motion. The test
uses synthetic accounts/devices only. It does not prove screen-reader behavior
or physical-device acceptance. The harness also disables repository-side cache
pollution by running Chromium inside disposable user data and working folders.

Two bounded composition extractions were completed: `/api/me` and `/api/logout`
now live in `routes/sessionAccountRoutes.js`, while Operations panel navigation
and focus behavior live in `client/operationsController.js`. Existing stores,
services, capability checks, revocation ordering, and composition remain the
authoritative owners; neither module adds a cache.

Final local evidence for this slice:

- focused privacy/backup regression set: **14/14 passed** after the final
  authorization and streaming-hash review;
- focused rendered Electron role acceptance: **1/1 passed**, with no repository
  cache directory left afterward;
- complete system suite: **205 files, 1,551 tests, 1,519 passed, 0 failed,
  32 skipped**; the skips require external PostgreSQL/Redis and are not passes;
- complete desktop suite: **160/160 passed**;
- system and desktop production audits: **0 vulnerabilities** each;
- syntax: **166/166** changed or untracked JavaScript files passed `node --check`;
- refined credential scan: **195 paths, 0 high-confidence matches**;
- `git diff --check`: **passed**.

The final worktree inventory is **195 paths**: **108 tracked modifications, 87
untracked files, 0 staged**. Classification is 73 server source/script/fixture
files, 86 server tests, 8 web-client files, 1 desktop source file, 2 desktop
tests, 15 documentation files, 5 deployment/observability files, 4 system
package/configuration/documentation files, and 1 repository configuration file.
The tracked diff is **5,992 insertions and 1,203 deletions across 108 files**.
`HEAD` and local `origin/main` remain equal at
`8073f8a89e44f9c567114f470e7e24005c6c8a99`; nothing is staged, committed, or
pushed.

Brutal self-evaluation: privacy lifecycle is **7/10 local** (complete engine and
revocation semantics, but owner retention rules and owned-media cleanup remain),
backup/disaster recovery is **6.5/10 local** (coordinated encrypted sets, but no
off-host automation or measured restore drill), observability is **6/10 local**
(safe metrics/dashboard/rules/runbook, but no deployed collector, alert delivery,
or incident exercise), rendered accessibility is **7.5/10 local** (six roles in
Electron, but no assistive-technology acceptance), and route maintainability is
**7.5/10** after the two bounded extractions. Physical Mac/iPhone, real routing,
live provider, live AI, deployment, external database, recovery-drill, and store
scores are unchanged.

---

## 2026-09-19 — macOS installer hardening: setup without Terminal, and a farm host that stays up

**Goal:** an operator installs the `.pkg`, opens Phone Farm and plugs in phones one by one, with no Xcode window and no
Terminal. The installer scripts were already written; this pass closed the gaps found when reading them as a first-time user.

**Setup without commands.** The setup screen's red rows now have a **Fix it** button where a fix can work: *Xcode installed
but not selected / licence not accepted / first-launch components unfinished* -> one standard macOS password prompt (via
`osascript`, no sudo typed by anyone); *iPhone tools missing* -> `brew install libimobiledevice libusbmuxd` when Homebrew
is on the Mac (progress shown on the row). Without Homebrew the row says to install it from brew.sh. Only two fixes exist, they
are allow-listed, take no user text, and run without a shell.

**A farm host that stays up.** The Mac is kept awake while the server or site agent runs; a crashed server or agent is
restarted with backoff (and reported after repeated crashes instead of looping); the app starts at login (default on for a
host/site, off for an operator workstation, one checkbox); only one copy can run; if the usual port 4173 is taken the next free
one is used; a failed start now says why (e.g. the server's own error line).

**Debuggable on a Mac.** The app is opened from Finder, so nothing showed on a console. It now writes a rotating log to
`~/Library/Logs/Phone Farm/` and **Help > Copy Diagnostics** puts a plain-text report (prerequisite rows, tool paths, WebDriverAgent
source, recent log; secrets scrubbed) on the clipboard; **Help > Show Log Folder** opens it.

**Continuous checks.** `cd desktop && npm run check:release` lists what can be verified without a Mac (needed files exist, are
not git-ignored, are committed; `git add -A` would not push a key/account file/node_modules; workflows parse and reference real
scripts; every module the app loads is in its package list; lockfiles match; the build plan is complete). It also runs inside the
desktop test suite, and the packaged-runtime verifier now requires every script/stylesheet/icon the web client's page names.

**Debugging pass (structured: reproduce, isolate, diagnose, fix).** Every API route (68) was hit with 380 hostile requests, the
WebSocket protocol with ~5,900 malformed messages, and the mock fleet soaked for a minute (1,385 actions). Findings:
1. **Malformed, `null` or oversized JSON returned 500 "request failed" on all 39 write routes.** Root cause: the global error
   handler had no branch for the body parser's client errors. Now 400 `INVALID_JSON` / 413 `PAYLOAD_TOO_LARGE` (parser text never
   echoed); 11 regression tests. Re-fuzz: 0 server errors.
2. **The setup page's "Fix it" could leave a row stuck on "Working…" with a dead button** if the request itself failed. Fixed, with
   behaviour tests that run the page's own function.
3. **The installer's read-me page still told people to open Xcode and run `brew install`** — the opposite of the goal. Rewritten
   in plain language to match the Fix it flow.
4. **Flaky desktop test:** two tests fought over port 4173 when the suite ran in parallel. The default port can now be set with
   `PHONE_FARM_PORT`; the tests no longer share one.
5. **A failure that would only have appeared on the first macOS GitHub build.** The new desktop tests start the real host flow;
   on Windows that skips the Mac checks, but on a clean macOS runner it runs them for real (no iPhone tools installed) and would
   have refused to start, failing the desktop test step and so the whole installer build. Found by reading the code for what
   differs on a Mac; fixed with an explicit development/test switch (`PHONE_FARM_SKIP_HOST_PREFLIGHT=1`, never set in the
   installed app) that the shared test harness sets. The other desktop tests were checked and already inject their machine.
No crash or hang came from the WebSocket fuzz or the soak (heap stable, 0 errors). One first-run detail to know about: the first
sign-in of a new administrator asks them to set up two-factor sign-in (an authenticator app), by design.

**Tests:** desktop suite **149** (was 97), server suite **1095**, server suite also passes under `TZ=Asia/Tokyo` as CI runs it. A
new end-to-end test drives the real first run: host setup starts the real server, the first admin is created from the setup page's
channel, and that admin signs in (up to the two-factor step).
`test/mainLifecycle.test.js` loads the real `main.js` against a stand-in for Electron and starts the **real server process**: it
kills it and watches it come back, checks a deliberate quit does not restart it, that every IPC channel refuses any page but the
setup page, and the busy-port fallback. The setup page's Fix it flow was exercised in a browser against a stubbed API.

**Still NOT done and not claimed:** the `.pkg` has never been built (needs macOS: the GitHub workflow does it); **the installer
files are still uncommitted** (`.github/`, `build-mac-pkg.cjs`, `wdaSource.js`, … are untracked, so GitHub has nothing to build);
the Fix it flows, the login item, the sleep blocker and Gatekeeper behaviour have never run on a Mac; no real iPhone was used;
the package is unsigned/not notarized until Apple certificates are added as secrets (see `docs/MAC_RELEASE.md`).

---

## 2026-09-19 — live phone stream, multi-site hub, remote access, and MS9–MS13 built

Everything below is implemented, has tests, and passes locally: server suite **1084/1084 (101 files)**,
desktop suite **97/97**. Nothing here has run against a real iPhone — see "Not verified" at the end.

**Live video, not screenshots.** The phone is now a video stream. WebDriverAgent's MJPEG server (device
port 9100, exposed through a second `iproxy` mapping) feeds one shared upstream per phone (`streamHub.js`)
to the controlling operator and any watchers; frames go to the browser as binary WebSocket messages.
Slow viewers drop frames instead of building lag, every frame is re-authorized per viewer, and when a
device cannot stream (mock without a stream, WDA without MJPEG) the client falls back to timed
screenshots and says so. Ports come from `portAllocator.js` and are allocated per device by the provisioner.

**The operator's screen is the phone.** `client/phoneStage.js` renders only the phone — no arrow buttons,
no Home button. Mouse wheel scrolls the phone (throttled into drags), click-drag swipes, a short press taps,
a long press and double click are real gestures, the keyboard types into the phone (Backspace and Enter
included), and the Home control is the phone's own bezel/gesture bar like a real iPhone. The layout is
phone-first.

**Multi-site.** One central hub plus one outbound-only site agent per location (`siteAgent.js`,
`npm run agent`). The agent dials the hub over TLS with its site id and a token (stored hashed), so a site
needs no inbound port. Devices show up on the hub namespaced as `<site>__<device>`; frames, taps, swipes,
typing, screenshots, file transfer and leases all work through the link; only an allow-listed set of calls
is accepted from a site; streams re-open automatically after a reconnect. Admins manage sites in the new
Sites panel.

**Remote operators.** Remote operators open the app (browser, installable PWA, or the desktop app in
"client" mode) and need only internet — Wi-Fi or mobile data. `deploy/hub/` has a Docker + Caddy hub with
automatic HTTPS; `docs/DEPLOY_HUB.md` explains it. `/healthz`, a web manifest, service worker (network-first,
never caches the API or the stream) and icons are in. The desktop app has host / client / site modes; the
Windows installer workflow exists. A Capacitor project for iOS/Android store apps is scaffolded in `mobile/`
(**not built**, needs the store accounts).

**Time zone.** `/time` is wall-clock in an explicit IANA zone; the default is now `America/Los_Angeles`
(`PHONE_FARM_TIMEZONE` overrides).

**MS9 — private markers.** Save/bookmark and other private markers use verify-before-toggle: the skill reads
the control's state, presses only when the state differs, then re-reads to confirm; an ambiguous read never
presses. The research record is written first, and an action on content with no record is refused.

**MS10 — configured account actions.** Every action (like, vote, repost, comment, …) has a per-account
policy `ALLOW_AUTONOMOUS` / `REQUIRE_APPROVAL` / `DISABLED`, default DISABLED, changeable only by an
administrator of that client and effective immediately. The validator enforces it before the device is
touched. Approvals are single-use and bound to the exact action, target and wording; a manager or admin
decides, and every decision is audited. Comments pass an application-level guard (exact and near
duplicates, rate limits, grounding in the viewed content, preset templates) and are recorded in a ledger
before sending; comment text is logged exactly as sent. A platform-visible action that fails is never
blindly retried — it goes to a person.

**Review panel (MS10.4 approval-gate UI, MS12.3 intervention queue UI).** A "Review" button opens a panel with three
tabs, in plain language. *Approvals*: each waiting action shows what the AI wants to do, on which post, and — for a
comment — the exact wording that will be posted; managers and admins approve or reject with an optional reason, others
see it read-only. *Needs a person*: everything the AI handed back (security check, unsure, unconfirmed action, comment not
sent, a person took over), with "I'll handle this" / "Mark as done"; managers and admins only, per-client. *What the AI
may do*: every action grouped (looking around / private markers / visible to others / comments) with Never / Ask a person
first / AI may do this on its own; only an administrator can change it. The server re-checks every request; the panel only
hides what a role cannot use. `npm run demo` now includes a demo account with one approval and one hand-back to try it.

**Mobile.** With a phone open on a narrow screen the phone now comes first (no sidebar above it) and the People list is
dropped there. Bug found and fixed while testing this: a phone opened while the browser tab was hidden — for example a
phone that locked its screen, reconnected and re-selected the device — never started its video when the tab came back.

**MS11 — timed sessions.** Sessions have step, time, spend, kept-candidate and per-action quotas and stop on
consecutive failures; a scoring profile decides what is kept; budgets and reports are rebuilt from
checkpoints, so a restart continues the session instead of resetting it. Each finished session has a
report (`/api/research/:account/runs/:runId/report`).

**MS12 — fleet.** A fleet gate limits concurrent AI workers and hourly spend and pins accounts to devices;
the intervention queue collects everything a person is needed for (challenge, low confidence, approval)
with claim/resolve and per-client visibility (`/api/fleet/ai`, `/api/fleet/interventions`).

**MS13 — optimization.** Local screen classification and a mechanical planner (open the app when closed,
move on after a recorded post) — no model call; a three-tier router (local / cheap / strong) that only
trusts the cheap model when it is confident and escalates otherwise or after a failure; a state-detection
cache keyed on the whole accessibility tree (never serves a challenge screen); adaptive pacing that never
waits less than the app needs to settle; search and near-duplicate lookup over an account's own records
(`/api/research/:account/search?q=` and `?similarTo=`); intervention analytics and optimization status
(`/api/fleet/analytics`). All of it is **off unless** `PHONE_FARM_OPTIMIZATIONS` is set
(`on`, or a list of `router,localPlanner,stateCache,pacing`), with `PHONE_FARM_CHEAP_MODEL` naming the cheap
provider.
`server/bench/` is the regression gate: a deterministic benchmark (`npm run bench`) runs the real skill and
mock phone under every optimization one at a time and all together, and a test fails if any of them lowers
the success rate, recall or action accuracy — including a deliberately bad configuration that the gate must
catch. Modeled result, 16 sessions: all optimizations on vs off — success rate 1.0 in both, cost per session
$1.31 → $0.35, latency 60.5 s → 28.0 s, strong-model calls 18.75 → 5.75, screenshots 18.75 → 0.

**Not verified (do not treat as done):**
- No real iPhone was used. Live MJPEG on real WDA, the real gesture timing (press-hold before drag), and
  Backspace/Enter through `wda/keys` are unconfirmed on hardware.
- Save/like/vote/repost/comment rely on accessibility labels taken from fixtures; the real apps' labels
  and app versions have not been checked.
- The benchmark's model cost and latency are modeled constants, not measurements; real vendor pricing and
  a supervised run are needed before relying on the savings numbers.
- The Docker hub image, the Windows installer and the macOS package were not built here; the store apps
  are unbuilt.
- `/time` uses the deployment time zone, not a per-site one.
- No slash-command form of `/policy`, `/comment`, `/template`, `/report`, `/fleet` (the Review panel and API cover them);
  no data-saver stream profile for weak mobile data; the Review panel was checked in the demo browser only, not on a phone.

---

## 2026-09-18 — real `.pkg` installer pipeline, `/time` timezone fix, Electron 44

**`/time` failures (3 tests on a real Mac).** Root cause: `commandParser.js` built wall-clock
times with process-local `Date` accessors (`new Date(now)` + `setHours`, and
`new Date(\`${date}T00:00:00\`)`), so `/time` meant a different window — and a different
"already passed" verdict — depending on the host's OS timezone. The Mac mini was on a US zone
(reproduced here with `America/Los_Angeles`: exactly the same 3 failures; the injected
`06:00Z` instant is 23:00 the previous day there, and the explicit-date window ends after
`12:00Z`). Fix: `/time` is wall-clock in one explicit IANA scheduling timezone,
`PHONE_FARM_TIMEZONE` (default `Europe/Rome` when this was written, `America/Los_Angeles` since 2026-09-19; invalid value stops startup), reusing
`zonedRecurrence.js`'s DST-correct helpers (now exported) instead of a second implementation.
The three failing assertions are unchanged. New regression coverage: a table of zones
(Rome, Bucharest, LA, Tokyo, Kiritimati UTC+14, UTC), explicit dates, "today" across the UTC
boundary, both 2026 Rome DST transitions, gap/repeated hours, and a child-process matrix that
runs the same inputs under six different *process* timezones and asserts identical output.
Server suite: **819/819**, also 819/819 with the whole suite forced into `America/Los_Angeles`
and into `Pacific/Kiritimati`. (`docs/COMMAND_QUEUE_SPEC.md` §/time updated.)

**The old "downloader" was not an installer** — `DOWNLOAD_PHONE_FARM.*` is now
`BUILD_PHONE_FARM_INSTALLER.*`, labelled **DEVELOPER TOOL — NOT THE PHONE FARM INSTALLER**; the
README's top section now sends users to GitHub Releases for one file, `Phone-Farm-<version>-arm64.pkg`.

**Packaging bug found and fixed.** electron-builder unconditionally drops a `node_modules`
directory at the *root* of an `extraResources` source (`app-builder-lib/out/util/filter.js`), so
the previous `extraResources: ../system` produced apps **without the server's dependencies**.
Runtime is now staged into `desktop/build/runtime/` from an explicit allow-list
(`prepare-runtime.cjs`; production `npm ci` into the staging directory, so accounts/storage/tests can
never ship) and shipped from that root. `verify-packaged-runtime.cjs` proves, against a real packaged
app, that dependencies resolve, forbidden files are absent, and the server **boots using the packaged
executable as its Node** while the bundle stays byte-for-byte unmodified — verified on a Windows
`electron-builder --win --dir` build here.

**Installer.** `build-mac-pkg.cjs`: electron-builder makes `Phone Farm.app`; `pkgbuild`/`productbuild`
make the package (install-location `/Applications`, non-relocatable, no scripts; welcome/read-me/
conclusion wizard pages; `hostArchitectures`); Developer ID signing, `notarytool` notarization and
stapling for app and package; verification with `codesign`, `pkgutil --check-signature`, `spctl`,
`stapler validate`, and an expanded-package inspection. Levels: notarized → `Phone-Farm-<v>-arm64.pkg`;
signed only → `…-NOT-NOTARIZED.pkg`; nothing → `…-UNSIGNED.pkg` (loudly warned; a tagged release fails
unless notarized or `ALLOW_UNSIGNED_RELEASE` is set). `.github/workflows/mac-installer.yml` runs the full
server suite (under a US timezone), desktop tests, audits, the build, verification, **installs the package
with macOS Installer on a clean runner and boots the installed app's server**, uploads the artifact, and on
`v*` tags publishes the Release. See `docs/MAC_RELEASE.md`.

**WebDriverAgent is bundled** (pinned tag + exact commit in `desktop/wda.lock.json`, unmodified,
BSD-3-Clause/Apache-2.0 with its `LICENSE`). On first launch it is copied to
`~/Library/Application Support/Phone Farm/wda-source/…` — nothing is built inside the signed app. An
unsigned WDA needs a development team: detected from the keychain when there is exactly one, else asked for
once in host setup; `WdaProcessManager` then adds `DEVELOPMENT_TEAM`, automatic provisioning and a team-unique
bundle id (argv unchanged when no team is configured, and never applied to an operator's own checkout).

**Security audit.** The Mac's "14 vulnerabilities (13 high, 1 critical)" were all in `desktop/`: `electron`
33.4.11 itself (**shipped** in every installed app — high, fixed 44.4.2) plus electron-builder 25's build-time
tree (`tar` critical, `app-builder-lib`, `node-gyp`, … — **never shipped**, but they run on the signing
machine). Upgraded to electron 44.4.2 / electron-builder 26.15.3 (and `js-yaml` 4.3.2, itself newly
flagged): `npm audit` now reports 0 in `desktop/` (all dependencies) and 0 in `system/`
(`--omit=dev` and full). `audit-gate.cjs` classifies findings as shipped vs build-only and fails CI on
either unless a build-only waiver is explicit.

Desktop suite: **82/82**. NOT done and not claimed: the `.pkg` has **not been built on macOS**, has not been
installed by a person, is **not signed or notarized** (no Apple credentials), and **no real iPhone** was
exercised (WDA signing automation is untested on hardware).

## 2026-09-18 — macOS installed-host automatic WDA startup and Electron isolation

The installed desktop host now resolves its Mac toolchain before starting the
server, including Finder-safe Apple Silicon/Intel Homebrew paths, full-Xcode
selection, `idevice_id`, `ideviceinfo`, `iproxy`, both `tun2proxy` binary names,
and a validated WebDriverAgent checkout from an explicit, persisted, or
per-user home path. Host mode supplies absolute tool paths plus
`AUTO_PROVISION_WDA=true` and `AUTO_DISCOVER_IOS_DEVICES=true` to the server's
existing `DeviceProvisioner`; it uses the Electron runtime, per-user
provisioning/derived-data storage, and no fresh empty manual device config.

The setup page now shows actionable prerequisite rows instead of falling
through to an empty fleet. Existing per-device provisioning reports WDA/tunnel
startup, readiness, unplug/replug, and human-action-required failures; signing
and provisioning errors now join trust, Developer Mode, certificate, and App
ID-limit errors in the bounded/manual-retry path.

The Electron privilege boundary was split: only the packaged local setup file
gets the IPC preload, every privileged call validates its sender window and
exact frame URL, and the HTTP(S) Phone Farm window has no preload. Both window
types deny popups and unexpected navigation; client URLs with embedded
credentials are rejected.

Direct `desktop/npm run dist:mac` now installs and verifies the production
`system` runtime before electron-builder copies it as `extraResources`.
Automated desktop and server tests cover both Homebrew layouts, WDA/tool
failure paths, environment construction, navigation/origin restrictions,
preload isolation, absolute binary use, and two-phone process/port isolation.
Validation on the Windows development host: desktop **12/12**, complete system
suite **800/800**, production dependency audit **0 vulnerabilities**, runtime
packaging preflight passed, changed JavaScript entry points passed
`node --check`, and `git diff --check` passed. `npm run dist:mac` reached
electron-builder after successfully preparing the bundled runtime, then exited
with its expected platform guard: macOS builds are supported only on macOS.
Therefore no DMG was produced here and the real two-iPhone flow remains
unverified; use `docs/MAC_INSTALLER_ACCEPTANCE.md` on the Mac mini before
changing that status.

## 2026-09-18 — downloadable desktop app: bootstrap lockout, account action
## menu, real email delivery, Electron host/client wrapper

Requested as "make this a downloadable app with an installer." Investigation
first found that most of the account/signup/approval backend and a first
edit-form UI already existed in the working tree from recent sessions
(`createSignupAccount`, `setOperatorAccountStatus`, the Users panel) but
undocumented here — this entry covers only what was actually new.

**Bootstrap + self-escalation lockout.** New `POST /api/setup/create-admin`
(`index.js`) creates the very first admin — loopback-only (`req.socket.
remoteAddress`) and permanently 404s once any approved admin exists, same
response shape as a route that never existed. `create-operator.js` (the CLI
path) is untouched. New `authStore.js#flagAndDeactivateOperator(username,
reason)` force-deactivates, force-signs-out (reuses the existing
`authVersion` bump), and records `securityFlagReason`/`securityFlaggedAt`.
Wired into two places: hitting the bootstrap endpoint after lockout while
authenticated as a non-admin, and any authenticated operator failing an
admin-only account-management route while targeting their *own* account
(`requireCapability`/`requireAnyCapability` gained an opt-in
`flagSelfEscalation` option — applied only to the two routes where
self-targeting is a real escalation vector, not blanket-applied to every
403). Every flag also writes a normal audit event.

**Kick / Change-role action menu** (`client/app.js`, `renderUsers()`).
"Kick" reuses the existing `PATCH .../users/:username {active:false}` path
unchanged (deactivation was already wired to force sign-out via
`authVersion`) — no new backend needed. "Change role" opens a click-to-open
side panel (not CSS `:hover`, matching `buildProxyPoolPicker`'s existing
accessibility rationale) listing the 5 roles, 3 visible with scroll for the
rest; picking Admin specifically shows "Are you sure you want to assign
admin role to {name}?" before applying. Verified live via the browser
preview against a disposable local instance: menu open/close, role list
scroll, the admin confirm/cancel path, a server-side validation error
(manager-without-teamId) surfacing without closing the panel, and Kick's
full deactivate-and-signal-inactive result.

**Real email delivery.** `accountNotificationStore.js` already built and
queued acceptance/rejection/recovery email content with nowhere to send
it — `deliveryState` just sat at `"queued"` forever. New
`mailSender.js` (nodemailer/SMTP, config via `SMTP_HOST`/`PORT`/`USER`/
`PASS`/`SECURE`, unconfigured ⇒ no-op with a logged reason like every other
optional integration here) plus `markSent`/`markFailed` on the
notification store. The account-status route awaits delivery and reports
the real outcome; the password-recovery route fires-and-forgets deliberately
(awaiting a real SMTP round-trip there would make a matching identifier's
response measurably slower than a non-matching one — an enumeration timing
side channel this endpoint's identical response message already guards
against).

**Desktop wrapper** (new top-level `desktop/`, sibling to `system/`).
One Electron app, two first-run modes: "Set up a new host on this machine"
spawns the unmodified `system/server/src/index.js` as a child process
(via `process.execPath` with `ELECTRON_RUN_AS_NODE=1` — the app's own
bundled Node runtime, so a host machine does not need a separate system
Node.js install) with persisted per-install `SESSION_SECRET`/
`TWO_FACTOR_MASTER_KEY` and its own storage root under Electron's
`userData`, then shows a one-time native create-admin form calling the
bootstrap endpoint above before handing off to the normal web login;
"Connect to an existing Phone Farm host" just opens a window at a given
URL — no server code ever runs on that machine. `system/client` and
`system/server` are reused unchanged.

**Root downloader.** `DOWNLOAD_PHONE_FARM.command` (macOS) and
`DOWNLOAD_PHONE_FARM.cmd` (Windows) are deliberately placed at repository
root, backed by `DOWNLOAD_PHONE_FARM.mjs`. After a clone or pull, they install
the exact locked server/desktop dependencies, run the full suite, and build the
local installer into ignored `desktop/dist/`. They do not download or generate
credentials, operators, device configuration, or runtime storage. Dry-run and
explicit skip-tests modes are available for validation and deliberate rebuilds.

Verification: **792/792 full-suite tests passed** (`npm test`, up from 756
at session start), including new coverage for `isLoopbackAddress`,
`flagAndDeactivateOperator`, the bootstrap-then-lockout sequence, both
self-escalation triggers (and confirming a non-self-targeting 403 is
*not* flagged), `mailSender.js` against a mocked SMTP transport, and a
full queue→send→`"sent"`/`"failed"` integration pass. `npm audit
--omit=dev` on `system/`: 0 vulnerabilities. The desktop app: `electron`/
`electron-builder` installed and the real Electron binary downloaded in
this environment; a dev-mode launch was smoke-tested (process starts,
loads `first-run.html`, no console errors) but the interactive host-setup
and connect-to-host click-through was **not** driven end-to-end — this
environment has no native-GUI automation tool wired up for a real Electron
window, only the browser preview used for the client UI above. Packaging:
the Windows `nsis` target is buildable and runnable on this machine; the
macOS `dmg` target is defined but unbuilt/unverified (non-macOS dev
machine, same hardware gate as every other Mac-only item in this doc).
Code-signing/notarization for either platform is explicitly out of scope
until the user decides on an Apple Developer / Windows code-signing
credential — unsigned builds work for local testing but trigger OS security
warnings on install.

## 2026-09-17 — MS17: fully automatic network enrollment

Closed the last manual gap in the automation pipeline: plugging in a phone
no longer requires clicking through network enrollment/IP discovery at
all, and Internet Sharing itself can now be turned on by the app.

Built `internetSharingManager.js` — enables Internet Sharing via the same
undocumented mechanism System Settings itself is known to use
(`com.apple.nat.plist` via `PlistBuddy`, restarting the
`com.apple.InternetSharing` launchd job, both through `sudo -n`), with the
primary interface auto-detected from `route get default`. Apple publishes
no schema for this plist, so this is explicitly best-effort — every call
site treats a failure as "log clear manual-fallback guidance and move on,"
never as something to retry blindly, and this is flagged as the single
piece of the whole project most likely to need adjustment once tested
against a real macOS version.

Built `autoNetworkEnrollment.js` — the continuous background version of
MS16.4's manual enrollment/discover-ip routes. Every poll tick it
statelessly recomputes which discovered UDIDs have no persisted `usbIface`
yet and which bridge members no device has already claimed, auto-pairing
only when exactly one of each is pending (otherwise flagging `"ambiguous"`
and waiting — the same "never guess" rule the manual flow already
enforced). Once enrolled, it attempts USB-IP discovery on a cooldown
without blocking other devices, and once an IP resolves for a device that
already has a pool proxy assigned, it calls
`networkRoutingOrchestrator.startRouting()` automatically —
`startRouting` is injected as a plain function rather than importing the
orchestrator directly, keeping the two modules decoupled.

Wired into `index.js` behind two independent flags
(`AUTO_ENABLE_INTERNET_SHARING`, `AUTO_NETWORK_ENROLLMENT`), both nested
under the existing `AUTO_ROUTE_PROXY_TUNNELS` gate. A new `autoEnrollment`
`device_list` field surfaces the loop's live per-device status
(`pending`/`ambiguous`/`discovering_ip`/`ready`/`routing` plus a
human-readable note) on the fleet card, informationally alongside the
existing manual controls, which remain a full fallback/override — e.g. to
unstick an `ambiguous` device without physically unplugging everything
else.

Combined with MS16, this closes the loop end to end as originally asked:
plug in a phone with `AUTO_PROVISION_WDA`, `AUTO_ROUTE_PROXY_TUNNELS`,
`AUTO_ENABLE_INTERNET_SHARING`, and `AUTO_NETWORK_ENROLLMENT` all set, and
— once verified on real hardware — it comes online, gets network-mapped,
gets its IP discovered, and starts routing through its already-assigned
pool proxy with no clicks. Assigning *which* proxy to a device remains a
deliberate one-click admin action, by design.

Verification: **780/780 full-suite tests passed** (`npm test`), including
new coverage for the PlistBuddy/launchctl argv construction and
rule-injection validation, default-route parsing, and
`autoNetworkEnrollment.js`'s full reconciliation logic (clean pairing,
ambiguity on either side, manual-UDID and already-claimed-member
exclusion, IP-discovery cooldown/struggling messaging, auto-routing vs.
stopping at "ready," and the timer lifecycle) — all against injected
fakes. Smoke-tested server boot on this non-macOS dev machine with every
new flag enabled: `detectPrimaryInterface()` correctly failed closed with
clear manual-fallback guidance (Windows has no `route get default`
equivalent) while the rest of the server stayed fully healthy — exactly
the intended degradation. Real `PlistBuddy`/`launchctl`/`route` behavior
and the NAT plist schema itself remain unverified until run on the Mac
mini.

## 2026-09-16 (final for the session) — MS16.6/16.7: routing fleet-card UI and health-check loop

Closed the last two documented gaps in Phase B part 2. MS16.6: a "Network
Routing" panel on every fleet card (gated by the new `routing:manage`
capability) showing enrollment/IP/routing status via one progressive-
disclosure button that always matches the next valid step — "Start network
enrollment" → "Confirm enrollment" → "Discover IP" → "Start routing" →
"Stop routing" — instead of several simultaneous buttons for steps that
aren't reachable yet. A `route_lost`/`tun_error`/`pf_syntax_error` state
correctly falls through to offering a retry rather than a stuck disabled
button (caught and fixed while writing this — the state list the client
checked against didn't yet include the new `route_lost` state below).

MS16.7: `networkRoutingOrchestrator.js` gained `checkHealth()` plus
`startHealthChecks()`/`stopHealthChecks()` (every `ROUTING_HEALTH_CHECK_
INTERVAL_MS`, default 30s, once at least one device is routed). For every
`ROUTED` device it confirms the tunnel process is alive and the device's PF
rule is still loaded (`pfctl -vvs rules`, parsed by the new
`parsePfCounters()` in `pfRuleGenerator.js`, which sums packet counts
across a device's several rules). Either check failing outside of a
deliberate `stopRouting()` call flips the device to a new `ROUTE_LOST`
state — distinct from the setup-time `TUN_ERROR`/`PF_SYNTAX_ERROR` — so a
tunnel that silently died or an externally-flushed anchor doesn't go
unnoticed. Deliberately not a "did packets increase" pass/fail signal
(a legitimately idle device isn't broken); the raw counter is recorded on
the route as informational data instead. A transient `inspectRules()`
failure skips only that tick's PF check rather than failing every routed
device. Wired into `index.js`: `startHealthChecks()` runs automatically
whenever `AUTO_ROUTE_PROXY_TUNNELS` is enabled.

Verification: **749/749 full-suite tests passed** (`npm test`), including
3 new `parsePfCounters()` unit tests and 8 new orchestrator tests (healthy
recording, tunnel-death detection, vanished-PF-rule detection, transient-
failure tolerance, multi-device single-inspect-per-tick batching, and the
health-check timer's own start/immediate-check/interval/stop lifecycle).
Smoke-tested server boot successfully with the flag on. This closes out
Phase A and both parts of Phase B as functionally complete pending real
Mac mini hardware verification — see `system/README.md` for the full
picture of what remains hardware-gated versus what's genuinely done.

## 2026-09-16 (latest, continued) — MS16.4: network enrollment and USB-IP discovery routes

Extended MS16 with the admin-triggered actions for the two remaining manual
inputs `start-routing` needed: `POST /api/admin/devices/:deviceId/
network-enrollment/start`/`confirm` (bridge-member before/after diffing via
`usbNetworkMapper.js`, persisted per device in the new `usbNetworkStore.js`)
and `POST .../discover-ip` (tcpdump-based capture via `usbIpDiscovery.js`,
now correctly routed through `sudo -n` like every other privileged
operation — it previously shelled directly to `tcpdump`, which would have
failed with a permission error on a real Mac since packet capture needs
root). `start-routing`'s `usbIp` now falls back to whatever `discover-ip`
already resolved when the caller omits it. Both enrollment and discovery
still refuse with 409 rather than ever guessing when the result is
ambiguous, matching the architecture guide's own philosophy for this
human-paced process.

Verification: **737/737 full-suite tests passed** (`npm test`), including
new coverage for the persisted enrollment/discovery store, the Mac's-own-
bridge-IP parser (`parseInterfaceIp`, distinct from `tunManager.js`'s
point-to-point `parseTunPeer` — same "inet" keyword, different line shape),
and tcpdump's corrected `sudo -n` argv; plus 8 integration tests for the
three new routes' auth/RBAC/disabled-state fallback against the real
server. Smoke-tested server boot successfully. Not yet built, as noted in
`system/README.md`: any fleet-card/admin UI for these or the routing
routes (API-only so far), and a periodic health-check loop for an
already-routed tunnel.

## 2026-09-16 (latest) — MS16: proxy tunnel routing (Phase B, part 2)

Built the remaining pieces of automated tunnel routing and wired them into
the live server behind a new opt-in flag: `pfRuleGenerator.js` (PF ruleset
text with strict interface-name/IPv4 validation — every interpolated field
is rejected outright if it doesn't match, not sanitized, since this is the
actual rule-injection boundary given `pfctl -nf` faithfully parses whatever
text comes out), `privilegedOps.js` (the narrow `sudo -n` boundary, scoped
to `pfctl` and this app's private anchor only — documents the exact
`/etc/sudoers.d` line a human configures out-of-band, never `-F all` on the
main ruleset), `tunManager.js` (per-device supervised `tun2proxy`, `utunN`
allocation, peer discovery via `ifconfig`, and credential redaction on
every log line it exposes — tun2proxy's own stdout can echo the
authenticated proxy URL back out), `usbNetworkMapper.js`/`usbIpDiscovery.js`
(the bridge-diffing and tcpdump-parsing logic the guide's enrollment
strategy needs — pure logic only, not yet wired to an HTTP action), and
`networkRoutingOrchestrator.js` (the `PROXY_LEASED -> TUN_STARTING ->
PF_APPLYING -> ROUTED` state machine, `TUN_ERROR`/`PF_SYNTAX_ERROR` instead
of ever guessing past a failure, full-replace PF regeneration across every
routed device).

Wired into `index.js` behind `AUTO_ROUTE_PROXY_TUNNELS=true` (also needs
`SHARED_BRIDGE_IFACE` and an encryption key; fails closed with a logged
reason otherwise) — `POST /api/admin/devices/:deviceId/start-routing`/
`stop-routing`, gated by a new `routing:manage` capability (Admin-only,
deliberately a higher bar than `proxy:assign`, since this starts privileged
processes and changes firewall rules). `start-routing` still takes the
device's USB-side IP as an admin-supplied input — network enrollment and IP
discovery remain manual per the architecture guide's own human-paced
enrollment strategy (§4.4/§4.5); MS16.4's parsing/diffing logic exists but
isn't yet exposed through a route or UI, and there is no periodic
health-check loop yet for an already-routed tunnel.

Verification: **722/722 full-suite tests passed** (`npm test`), including
new unit coverage for PF rule-injection resistance (malicious interface
names/IPs explicitly rejected, including a newline-smuggling attempt),
every sudo-wrapper argv shape, credential redaction, bridge/utun diffing,
tcpdump/ifconfig parsing, and the orchestrator's full state machine (happy
path, both error states, multi-device full-replace regeneration, stop/
last-device-clears-anchor semantics, retry/interface-reuse) — all against
injected fakes, no real `sudo`/`pfctl`/`tun2proxy`/`tcpdump` invoked.
Integration-tested the live HTTP routes' auth, admin-only RBAC, and the
"not enabled" 409 fallback against the real server. Manually smoke-tested
server boot with the flag on and off on this non-macOS dev machine
(correctly no-ops with a logged reason when `SHARED_BRIDGE_IFACE` is
unset). Real `pfctl`/`tun2proxy` behavior, the sudoers configuration
itself, and the architecture guide's AT-05/AT-06 leak/routing acceptance
tests remain unverified until run on the Mac mini.

## 2026-09-16 (later) — MS15: shared proxy pool (Phase B, part 1)

Built `proxyPool.js` (encrypted-at-rest credential storage reusing
`twoFactor.js`'s AES-256-GCM helpers directly, CRUD, and the exclusive
`AVAILABLE -> LEASED(deviceId) -> RELEASED` lease state machine), the
`POST`/`GET`/`DELETE /api/admin/proxies` and
`PATCH /api/admin/devices/:deviceId/proxy-assignment` routes behind two new
capabilities (`proxy:view-pool`, `proxy:assign` — Admin + Manager, kept
separate from the existing Admin-only `proxy:manage`), a `poolProxy` field
on `device_list` (visible only to `proxy:view-pool` holders), and the client
side: a "Proxy Pool" admin panel (add/list/delete) and a proxy-assignment
`<select>` on every fleet card. No route or list response ever returns
host, port, username, or password — only `id`, `provider`, `protocol`,
`country`, a derived flag emoji, `label`, and `leasedToDeviceId`.

This is credential storage and exclusive assignment only. Actually starting
a tunnel for a leased proxy (TUN/PF automation, Phase B part 2) is not
built and not started.

Verification: **651/651 full-suite tests passed** (`npm test`), including
13 new `proxyPool.js` unit tests and 10 new integration tests against the
real running server/RBAC (auth, capability gating across view/assign/manage,
cross-device lease exclusivity, `device_list` visibility scoped correctly,
audit trail, and an explicit assertion that the plaintext password never
appears in any response or audit record). Confirmed the client changes load
without any console error (every new `getElementById` reference resolves —
also proven statically by `clientBoundaries.test.js`) before authentication,
on this non-macOS dev machine; a full authenticated click-through on the Mac
mini is still recommended.

## 2026-09-16 — MS14: automated WDA/iproxy device provisioning (Phase A)

Built the opt-in (`AUTO_PROVISION_WDA=true`) provisioning pipeline described
in `Phone_Farm_Automation_Architecture.md` Phase A: `hostPreflight.js`,
`portAllocator.js`, `deviceProvisioningStore.js`, `processSupervisor.js` +
`wdaProcessManager.js` + `iproxyManager.js`, and the `deviceProvisioner.js`
orchestrator. A UDID with no explicit `devices.config.json` entry now gets
its WDA process and `iproxy` tunnel launched automatically, reuses a
persisted port/derived-data path across restarts and replugs, and surfaces
known manual-prerequisite failures (untrusted cert, Developer Mode, App ID
limit) as an actionable `user_action_required` banner instead of looping
retries — with a "Retry automatic setup" admin action
(`POST /api/admin/devices/:deviceId/retry-provisioning`, new
`device:provision` capability) for both that state and a hard
`provisioning_error`. Manually pinned `devices.config.json` WDA entries (the
MS5 hardware-validation path) are explicitly skipped by the provisioner, so
existing single-device bench-testing is unaffected. The existing 10-second
WDA-readiness loop is reused as-is to detect actual readiness; this feature
does not add a second `/status` poller.

Not built yet (tracked as Phase B, not part of MS14): the shared proxy pool,
per-device proxy assignment UI, and TUN/PF tunnel-routing automation.

Verification: **628/628 full-suite tests passed** (`npm test`), including 50
new unit tests covering port allocation, atomic provisioning-record
persistence, host preflight (including the ENOENT-vs-nonzero-exit
distinction), both process managers' argv construction (the mandatory
`iproxy -u`, unique per-device derived-data paths), and the provisioner's
full attach/detach/replug/failure-classification/retry state machine
against injected fakes — no real `xcodebuild`/`iproxy`/`idevice_id` was
invoked. Manually smoke-tested server boot with the flag on and off on this
non-macOS dev machine (correctly no-ops with a logged reason when
`platform !== "darwin"`). Real `xcodebuild`/`iproxy` process behavior, Xcode
trust-prompt flows, and physical USB attach/detach reconciliation remain
unverified until run on the Mac mini.

## 2026-09-15 — security review remediation and live-test readiness

Closed the 24 findings in the 2026-09-14 code review across WDA authorization
and session races, live-frame rate/failure isolation, upload reauthorization,
team and audit scope, recovery-token handling, account/username transactions,
write-first queue persistence, scheduler containment, physical-device config
validation and readiness, DST-safe recurrence, session cleanup, and deployment
hardening. Production startup now rejects mock fleets, weak session secrets,
unsafe exposure, caller-controlled network-check targets, and malformed WDA
identities. Stable public errors replace internal transport detail.

Verification: **566/566 full-suite tests passed** with `npm.cmd test`; 18 changed
JavaScript entry points passed `node --check`; focused deployment/WDA/network
coverage passed 94/94; explicit local startup returned the expected 401 from
`/api/me`; fail-closed startup without a strong secret exited nonzero; and
`git diff --check` passed. Physical Mac mini/WDA control and monitor acceptance,
live proxy routing, email delivery, model providers, research accounts, platform
skills, and deployed HTTPS remain external gates.

## 2026-09-14 — controlled WDA Live view

Implemented an opt-in one-second screenshot poller for a Human-controlled WDA
device detail view. Client and server both suppress overlapping live screenshot
requests; browser visibility pauses/resumes polling, and leaving detail,
release, sign-out, access loss, or three repeated failures stops it. Live frame
requests bypass the ordered input queue, while tap/swipe/Home/type commands keep
their existing serialized action-and-frame behavior and manual fallback.

Verification: **529/529 full-suite tests passed** with `npm.cmd test`, including
polling lifecycle, hidden-tab behavior, overlap suppression, release/sign-out
cleanup, and a fake-WDA concurrency check proving input starts while a delayed
live screenshot is still pending. This is screenshot polling, not video, and no
physical Mac mini/WDA monitor acceptance is claimed.

## 2026-09-12 — restricted VA fleet

Implemented one role-aware login flow, safe all-device fleet summaries, explicit
VA device grants that fail closed, and server-enforced Human-mode ownership for
selection and every later phone input. Grant and role changes are resolved live;
revocation immediately releases an open claim and removes the phone-control view.
The server now also pushes safe live operator profiles after role/grant edits,
and the browser discards in-flight privileged responses from the prior profile
generation instead of letting them repopulate cleared Admin data after demotion.
VA fleet summaries omit assignment instructions, authorized-operator lists, and
secret-bearing network configuration. Admin and Manager capability behavior is
preserved.

Verification: **470/470 full-suite tests passed** with `npm.cmd test`. Separate
browser sessions confirmed the Admin fleet/Operations experience and the VA
fleet, assigned-device control, release, logout, and restricted-device states.
No physical iPhone or WDA validation was performed for this milestone.

## 2026-09-11 — role capabilities and authenticated staff presence

The control plane now has five explicit roles mapped to named server-side
capabilities; route, command, and WebSocket checks use capabilities while device
and research grants remain independent boundaries. The matrix is documented in
[ROLE_CAPABILITY_MATRIX.md](ROLE_CAPABILITY_MATRIX.md).

The browser now has a persistent People sidebar backed by `GET /api/people` and
WebSocket presence broadcasts. It aggregates tabs into authenticated sessions,
shows only safe public identity/activity fields, tracks current human-controlled
phones, and handles logout, expiry, disconnect, and stale heartbeat cleanup. See
[PRESENCE_AND_PEOPLE.md](PRESENCE_AND_PEOPLE.md). The completed capability pass
was verified by a 435/435 full suite; presence then passed its 51 focused tests.
Physical phone/WDA validation remains a separate gate.

The same pass added [durable assignments](ASSIGNMENTS.md): role-aware creation,
assignee status updates, Manager/Admin reassignment, optional phone/account
scope, append-only history, and restart-safe persistence. The browser exposes an
Assignments workspace to every role and management controls only to operators
with `assignments:manage`.

Integrated verification after the assignment, scoped fleet, dashboard, and
phone-detail changes: **445/445 tests passed** with `npm test`. A browser review
against an isolated disposable local instance covered sign-in, People presence,
fleet summaries/filtering, assignment creation/history, and phone detail. It
found and fixed narrow-viewport top-bar overflow and a clipped assignment field;
the recheck showed no horizontal overflow and the browser console was clean.

## 2026-09-09 — MS3.3 research ownership

Implemented workspace-owned research accounts, explicit operator workspace grants,
authorization on every research route, workspace-separated storage, and audit
context. Admin status does not bypass the boundary. Legacy files remain untouched
and are not served implicitly. Configuration and reviewed migration are documented
in [RESEARCH_OWNERSHIP.md](RESEARCH_OWNERSHIP.md). No real customer mapping was assumed.

Verification: **354/354 full-suite tests passed** with `npm test` (current count,
up from the 215 recorded when this note was first written). Earlier
sections describing MS3.3 as undecided are historical and superseded by this update.
This completes the research-record boundary, not global queue/audit tenancy.
The production research runner now rechecks account authorization on every
bounded step. Device setup and MS5 physical acceptance remain pending hardware.

**Same-day follow-up:** the research/chat side panel and full `ContentCandidate`
schema population (Priority #3, referenced as "not started" in several sections
below that predate this work) were also completed 2026-09-09 — see the MS8
section's rewrite for the current field-by-field state. A real bug was found and
fixed in the process: `researchAccess.js`'s workspace-id validator (lowercase-only)
had drifted from looser, independently-written copies in `authStore.js` and
`create-operator.js`, so a grant like `"Client-A"` would load without error and
then permanently, silently fail to match the real `"client-a"` workspace at
request time. Fixed by extracting a single shared validator
(`server/src/researchId.js`) used by all three call sites, with a loud
`console.warn` on load if an operator's grant is dropped for being invalid.

Separately: the emergency **STOP AI / TAKE OVER** control, built in MS6.3 as
unconditionally operator-visible, became `admin`-only as part of the 2026-09-08
role-split pass below. This was confirmed as an intentional decision (not an
oversight) on 2026-09-09, and `CLAUDE.md` §4 / `docs/COMMAND_QUEUE_SPEC.md` §9
have been updated to state it explicitly rather than contradict the shipped
behavior.

**Second same-day follow-up:** a real security-relevant bug was found and fixed
during a live-browser check (not caught by any static survey): `role` and
`allowedDevices` were read from `req.session.operator` (HTTP) or a WebSocket
connection's handshake-time closure variable only once, at login/connect time —
never re-checked against the live operator registry, unlike
`researchWorkspaceFor()`, which already re-resolved grants live for exactly
this reason. A demoted admin or an operator with a revoked device grant kept
their old privileges — including the emergency-stop control — for the full
lifetime of any already-open session or WebSocket connection. Fixed with a new
`resolveOperator()` (`authStore.js`) threaded through every authorization
checkpoint in `index.js` (`requireAuth`, `requireRole`, the WS
`requireAdminWs`, and every `canAccessDevice`/`executeCommand` call), fail-
closed if the operator no longer exists. One existing test's expectation
changed from 403 to 401 for a deleted operator (a more precise status —
identity gone is an authentication failure, not merely an authorization one),
with 2 new regression tests proving a privilege change now takes effect on the
very next request/message with no re-login required, including on an
already-open WebSocket.

**Third same-day follow-up:** the cross-run research-candidate deduplication
gap described lower in this document (MS8 section) is now fixed. `createRun`
(`researchStore.js`) already deduped candidates *within* one call's own batch;
it now also checks a persisted per-account `candidateIndex` (keyed by
`platform_content_id`/`canonical_url`, additive — old JSON files without it
still load) so a later run re-observing the same post carries forward its
`review_state`/`first_seen_at` instead of resetting to a fresh `pending`
candidate and losing a reviewer's earlier decision, per `CLAUDE.md` §8. A new
row is still recorded per observation (nothing is silently dropped) and is
tagged `duplicate_of_run` so it's visible as a repeat rather than new.
`setCandidateStatus` keeps the index in sync so a review taken on any
occurrence carries forward to the next one. 3 new tests cover: review-state/
first-seen carry-forward (both `confirmed` and `removed`), a match via
`platform_content_id` alone when the URL itself changed between observations,
and legacy files with no `candidateIndex` key still loading correctly. This
was a scoped, low-risk fix (Option B from the three considered) rather than
the bigger flat-candidate-store restructure (Option A) — deferred until an
actual AI worker exists and real usage shows the embedded-per-run model is
the wrong shape.

**Fourth same-day follow-up:** MS8.1 (the model-provider interface) is now
built — see the MS8 section below for the full writeup. `modelProvider.js`
defines the vendor-agnostic `ModelProvider` contract and its MS8.1.6
contract test; `anthropicProvider.js` and `openAiCompatibleProvider.js` are
the two required adapters (the latter covers OpenAI/DeepSeek/Kimi/NVIDIA NIM
via one implementation, per MS8.1.4); `providerRegistry.js` is the
config-driven registry (`models.config.json`, credentials referenced by
environment-variable name only, mirroring `devices.config.json`'s pattern).
At that point this was pure plumbing and no real API key existed anywhere in
the repo. 30 tests covered the provider layer. This was undertaken on "keep coding" after the prior
three follow-ups, on the reasoning that `docs/CODING_ROADMAP.md` MS8.1.3
already prescribes which vendors/adapters to build (no open decision
remained to block on) and Priority #3 already established that the user
wants AI-VA-layer progress.

**Fifth same-day follow-up:** the hardware-independent MS8 execution path is
now built end to end. `observationPackage.js` captures accessibility/UI-tree
data first and falls back to a validated image. Config-driven, versioned
accessibility profiles exist for Instagram, Reddit, and X. The production
`researchTaskRunner` subscribes to scheduler dispatch, resolves one exact
authorized account, resolves the active model selection before each decision,
runs bounded verified steps, writes candidates and locally captured image
evidence, and completes or hands off through the durable queue. `/model set`
supports global, workspace, device, and task scopes without a restart.
The platform profiles and production path are locally tested but deliberately
disabled in the shipped empty configuration until actual app versions,
accounts, credentials, and a physical device are verified.

This is a point-in-time audit of `system/` against
[`docs/CODING_ROADMAP.md`](CODING_ROADMAP.md)'s milestones. Every claim below
was checked directly against the current code (file/line references included)
or a direct command (`git log`, `npm audit`, `grep`, `npm test`), not against
what the other docs say should exist.

**Update:** the original version of this report (below, still accurate for
MS5 and MS8 onward) found zero milestones complete. Since then, **MS1
through MS4, MS6, and MS7 were implemented and verified**. The 2026-09-08
current full automated suite is **354/354 passing**
(`npm test`). Earlier manual browser/curl passes still cover device control,
login/logout, audit, AI-mode handoff, and the command console; this latest
role-split pass adds automated DOM/authorization coverage and should still get
one final visual Chrome/Safari pass on the deployment Mac. See the top of each section
for what changed. MS5 (the only hardware-dependent milestone in this range)
remains genuinely blocked on the device's arrival — MS6 and MS7 were
completed out of the roadmap's original order since neither needs real
hardware to build or test.

---

## Summary

| MS | Name | Code status | Testing gate |
|---|---|---|---|
| 1 | Engineering foundations & test infra | ✅ Done | ✅ Passing (354-test full suite) |
| 2 | Human VA core hardening | ✅ Done | ✅ Passing (part of the 354) |
| 3 | Authentication & authorization | ✅ MS3.1/3.2, VA/admin roles and MS3.3 research-record ownership implemented; customer mappings/migration remain explicit setup | ✅ Passing (354-test full suite, 2026-09-09) |
| 4 | Persistence, audit & health | ✅ Done (MS4.1 rescoped — see detail) | ✅ Passing (part of the 354) |
| 5 | Real-device validation & scaling | 🟡 Reusable N-device mock soak runner built; physical WDA validation remains | ✅ 5 mocks/60 actions short proof passed; 30-minute and real-device gates not run |
| 6 | Controller mode & input-lease abstraction | ✅ Done (MS6.3 UI: see detail — STOP AI is now `admin`-only, a deliberate 2026-09-09 decision) | ✅ Passing (part of the 354) |
| 7 | Command & queue scheduler | ✅ Done | ✅ Passing (part of the 354) |
| 8 | AI VA read-only research mode | 🟡 Software path complete locally: providers, model selection, three versioned accessibility profiles, production runner, candidate/evidence pipeline and handoff | ✅ Local unit/integration coverage passing; live provider/app/device gate not run |
| 9 | Private research markers | ✅ Built: verify-before-toggle save/bookmark, record-before-act | ✅ Local tests passing; real-app labels unverified |
| 10 | Configured account actions | ✅ Built: per-account policy, single-use approvals, comment guard + ledger | ✅ Local tests passing; real-app labels unverified |
| 11 | Timed autonomous research sessions | ✅ Built: quotas, budgets, restart-safe checkpoints, session reports | ✅ Local tests passing; supervised device run not done |
| 12 | Multi-device AI fleet | ✅ Built: fleet gate, spend limits, affinity, intervention queue with a Review-panel UI | ✅ Local tests passing; multi-device hardware run not done |
| 13 | Optimization | ✅ Built, opt-in: local planner, 3-tier router, state cache, adaptive pacing, search/dedup, analytics, regression benchmark | ✅ Benchmark gate passing (modeled costs); real-model measurement not done |

🟡 = real code exists that maps to this milestone, but the milestone (as
scoped, with its testing gate) is not complete. ⬜ = no code exists for this
milestone at all.

---

## MS1 — Engineering foundations & test infrastructure

**Status: ✅ Done.**

| Step | Status |
|---|---|
| MS1.1.1 `.gitignore` | Done — root `.gitignore` excludes `node_modules/` and `system/storage/**`, keeping `.gitkeep` placeholders |
| MS1.1.2 First commit | Done — the user authorized the baseline commit on 2026-09-09 |
| MS1.1.3 `npm audit fix` | Done via an `overrides` entry pinning `qs` to `^6.16.0` (the declared `express`/`body-parser` ranges hadn't picked up the patched `qs` yet) — `npm audit` now reports 0 vulnerabilities |
| MS1.1.4 `maxPayload` cap | Done — `new WebSocketServer({ server, maxPayload: 64 * 1024 })` in [index.js](../system/server/src/index.js) |
| MS1.2 Test runner | Done — `node --test` (built-in, no new dependency), `npm test` runs `server/test/**/*.test.js` |
| MS1.3 Fake-WDA parity | Done — the fixture moved to `server/fixtures/fake-wda-server.js` (Node's test runner treats every file under a directory named `test` as a test file, which would have made `npm test` hang on the old location) and gained swipe/keys routes plus `/debug/history`, `/debug/hang`/`unhang`, and `/debug/delay` for the timeout/ordering tests below |
| MS1.4 Doc drift fix | Done — `system/README.md`'s status list, WebSocket protocol table, and coding-priority list now match the code |

## MS2 — Human VA core hardening

**Status: ✅ Done.** 26 tests passing (`npm test`), plus a manual pass through
the real browser client (select → tap the Instagram icon → swipe left →
type "hello" → release — each step confirmed via the rendered SVG).

- **MS2.1 automated coverage**: unit tests for `fileStore`/`researchStore`
  validation logic; integration tests driving `WdaDevice` against the fake-WDA
  fixture (tap/swipe/typeText, session reuse); integration tests driving the
  real relay WebSocket protocol end-to-end (select/tap/swipe/type/release,
  unknown-device and already-in-use error paths, out-of-range coordinates
  silently dropped).
- **MS2.2.1 WDA timeouts**: every `WdaDevice` fetch now carries
  `signal: AbortSignal.timeout(this.timeoutMs)` (default 8s, configurable per
  device via `devices.config.json`'s new optional `timeoutMs` field). Verified
  with a fixture that "hangs" on command — the call rejects well under the
  configured timeout and invalidates the cached session.
- **MS2.2.2 ordering guarantee**: proved with a real timing window (fixture
  response delay + two concurrent taps) that the second tap's request is never
  sent to the device until the first tap's *entire* round trip — including its
  post-tap screenshot — has completed. This is the actual property the
  per-connection action queue exists to guarantee, not just "no crash."
- Bonus: added a test proving `reportError` fires exactly once and flips the
  device to `offline` correctly on a real mid-session failure — MS2.3.2 (fire
  once, no duplicates) was a "verify" item and is now backed by a test rather
  than only code inspection.
- **MS2.3.1 busy-timeout retry affordance**: `client/app.js`'s `setBusy` now
  shows "No response from the device — you can try again." when the 10s
  safety net fires (rather than silently re-enabling controls with no
  explanation), and clears that message the moment a new action starts.

`index.js` also gained a guarded main-module check (`server.listen()` only
runs when the file is executed directly) so the integration tests above could
import and drive the real app in-process on an ephemeral port — required for
the WS protocol tests to exist at all, not optional polish.

**Follow-up (2026-09-07): a real gap against `CLAUDE.md` §3's literal
requirement, caught while doing unrelated work.** §3 lists "tap, swipe, text
input, home/back/device controls where supported" as current scope — the
hardware Home button had never actually been implemented; only tap/swipe/
type existed. Added: a new WS `home` message, `WdaDevice.pressHome()`
(confirmed against `research/WebDriverAgent`'s `FBCustomCommands.m` — real
WDA registers `POST /wda/homescreen` `.withoutSession`, unlike tap/swipe/
keys which are scoped under `/session/:id/...`, so this correctly skips
`ensureSession()`/`ensureWindowSize()` entirely), `MockDevice.pressHome()`,
a matching route on the fake-WDA fixture, and a Home button in the browser
UI next to the swipe controls. 5 more tests (170 total).

---

## MS3 — Authentication & authorization

**Status: ✅ MS3.1 (operator identity), MS3.2 (device RBAC), and MS3.3
(per-workspace research data ownership, implemented 2026-09-09 — see below)
all done and tested.**

What's implemented:

- **MS3.1 operator identity**: [authStore.js](../system/server/src/authStore.js)
  — scrypt password hashing with per-password salt and a constant-time
  (`timingSafeEqual`) comparison; operators loaded from `operators.config.json`
  (gitignored — it holds password hashes, unlike `devices.config.json`) via a
  live `Map`, mirroring how `index.js` exports `devices` for the same reason.
  `server/scripts/create-operator.js` creates/updates an operator with a
  properly hashed password — that file is never hand-edited.
  `POST /api/login`, `POST /api/logout`, `GET /api/me`, cookie sessions via
  `express-session` (in-memory only — doesn't survive a relay restart, tracked
  separately under MS4).
- **MS3.1.3 route + WS gating**: `requireAuth` middleware protects every
  `/api/devices/*` and `/api/research/*` route. The WebSocket upgrade itself
  is gated too — `wss` now uses `{ noServer: true }` with a manual
  `server.on("upgrade", ...)` handler that runs `express-session`'s own
  middleware against the raw upgrade request and rejects with HTTP 401 before
  the handshake completes if there's no valid session. This was the part of
  MS3 with no template to follow in the existing code — reused verbatim from
  `ws`'s own documented pattern for authenticating upgrades against an
  existing session store, rather than inventing a second auth mechanism.
- **MS3.2 device RBAC**: each operator has an `allowedDevices` list (`null` =
  every device, for an admin/lead VA). Enforced at `select_device` time (a
  disallowed device returns an error over the WebSocket, not silently
  ignored) and at every file route (403, not 404 — existence isn't hidden,
  just access).

**MS3.3, per-client/workspace ownership of *research* data** (as opposed to
device files, which MS3.2 covers) — the ownership-model decision this
originally needed was made and implemented 2026-09-09: `research.config.json`
declares `{id, workspaceId}` accounts, each operator carries an explicit
`allowedResearchWorkspaces` grant list (independent of `role` — an admin
gets no automatic bypass), and `researchAccess.js`'s `researchWorkspaceFor()`
is the single choke point every `/api/research/*` route resolves grants
through before touching `researchStore.js`. Full detail, including the
migration story for the old ungated flat files, is in
[RESEARCH_OWNERSHIP.md](RESEARCH_OWNERSHIP.md).

Verified: 39 automated tests (unit tests for `authStore.js`'s hashing/
verification/authorization logic; integration tests for the full login/
logout HTTP flow, an unauthenticated WS upgrade being rejected, a restricted
operator being blocked from an unauthorized device over WS and getting 403
on its files, and an authorized operator succeeding on both). Manual pass:
signed in through the real browser login form, selected and released a
device, signed out, confirmed `/api/me` returns 401 and the login form
reappears.

**Real bug found and fixed after the fact, while stress-testing MS6 (below):**
`client/app.js`'s login handler called `connect()` right after `fetch("/api/login")`
resolved, without reading the response body first. `fetch()`'s promise resolves
once headers arrive — it does not wait for the body — but this server (via
express-session's own internals) holds the response's last byte back until
the session has actually finished writing to disk. A real VA could occasionally
have their very first WebSocket connection rejected with 401 immediately after
signing in, purely from that timing gap, on a real login the credentials for
which were entirely correct. Root-caused via a deterministic ~15-repro-run
reduction (not a guess): confirmed empirically that `FileSessionStore.get()`
was sometimes reading the session file mid-write (empty content, valid JSON
error) because the caller had moved on before the write completed. Fixed by
awaiting the response body in `client/app.js`'s login and session-check paths,
and in the test helpers that do the same thing. This is exactly the kind of
defect the "run it 15-20 times in a row" stress-testing this project's test
suite makes possible was for — it never surfaced in a single manual run.

---

### 2026-09-08 follow-up — VA vs admin/dev operator profiles

**Status: ✅ Implemented and tested as a UI/access-layer extension of MS3.**
At the time this section was written, this did not complete MS3.3 — research
data ownership was still a separate, undecided concern. **MS3.3 was decided
and implemented the following day (2026-09-09); see the section above.**

What changed:

- Operators now carry one of five explicit feature roles: `admin`, `manager`,
  `va`, `content_creator`, or `editor`. Missing or unknown role values normalize
  to `va` (fail closed). This role is separate
  from `allowedDevices`; an admin does not automatically gain access to every
  phone.
- `GET /api/me` exposes only the safe browser profile: `username`, `role`,
  `allowedDevices`, and non-secret capability names. Password hashes remain
  server-only.
- `GET /api/audit`, `GET /api/queue`, and `POST /api/queue/command` require
  `admin` server-side. A VA calling them directly gets 403, even if the UI is
  bypassed.
- Direct WebSocket AI-management actions (`switch_to_ai`, `takeover`,
  `emergency_stop`) also require `admin`. Normal VA control remains unchanged:
  select/release, tap, swipe, type, Home, and normal file operations still use
  the existing device RBAC.
- Generic tasks created by a device-restricted admin carry that operator's
  allowed-device set into `TaskSpec.deviceSelector`; scheduler dispatch will
  not place the task on a phone the admin is not authorized to use.
- The browser now has two operator experiences without a second auth system:
  VAs get fleet + live control only; admins get those views plus a dedicated
  admin/dev workspace for the existing command parser, task queue, audit log,
  and AI-mode controls. Logout/login resets the role-aware UI so an admin panel
  cannot remain visible after switching to a VA session.
- Fleet-status visibility was intentionally preserved: authenticated operators
  still receive the existing global `device_list` status broadcast, while
  actual selection/control/file access remains enforced by `allowedDevices`.
  This UI pass did not redesign the protocol.

Verification: **209/209 automated tests passing**. New coverage includes safe
`/api/me`, VA 403s on admin APIs, successful admin use, normal VA device
control, server-side rejection of VA AI-mode messages, preservation of device
RBAC, restricted-admin scheduler dispatch, and a static client check proving
every DOM id referenced by `app.js` exists in `index.html`. A real-browser
visual pass on the deployment Mac remains manual.

Priority #3 (AI research/chat side panel and population of the existing
`ContentCandidate.platform_actions[]` / `evidence_refs[]` fields) was
**deliberately not started in this change** — it was completed the next day,
2026-09-09, alongside MS3.3 above. See the MS8 section for its current state.

---

## MS4 — Persistence, audit & health

**Status: ✅ Done, with one deliberate scope correction from the original plan.**

**Scope correction on MS4.1:** the original roadmap called for moving device
"in-use" status into a durable store so it survives a restart. Building it
surfaced that this was based on a wrong assumption — device claims are
inherently tied to a live WebSocket connection, and a relay restart already
drops every connection, so devices correctly reset to `idle` on their own.
Persisting and restoring that field naively would risk the opposite bug: a
device stuck "in-use" forever because the connection that once claimed it no
longer exists to release it. **What genuinely needed to survive a restart
instead: operator login sessions** (a real gap — every operator was getting
logged out on every relay restart) and the audit log itself. Both are done.

What's implemented:
- **File-backed sessions** — [fileSessionStore.js](../system/server/src/fileSessionStore.js),
  a custom `express-session` Store, one JSON file per session under
  `storage/sessions/` (gitignored). Deliberately not SQLite (the roadmap's
  original suggestion) — this data is small and low-throughput, every other
  persistence mechanism in this codebase is already a plain file, and
  `node:sqlite` is new enough to add a Node-version dependency this project
  doesn't otherwise have. Session cookies now last 24h and survive a restart.
- **Audit log** — [auditLog.js](../system/server/src/auditLog.js), append-only
  JSON-lines at `storage/audit/events.log` (gitignored). Records logins/
  logouts, device select/release (including denied and conflicting
  attempts — the RBAC violations are audit-worthy too), every tap/swipe/
  type_text, file upload/download/delete, and research candidate status
  changes. `type_text` events log length only, verified end-to-end by a test
  that types a "secret" string and asserts it never appears anywhere in the
  audit API's response. As of the 2026-09-08 operator-profile pass,
  `GET /api/audit` is admin-only and a logged-in VA receives HTTP 403.
- **Device health** — tracked in `index.js`'s `deviceHealth` Map (separate
  from the device adapter objects themselves, per Architecture Baseline §2:
  adapters execute primitives, they don't own control-plane bookkeeping).
  `lastSeenAt` and `consecutiveFailures` are surfaced in `device_list` and
  shown in the client. **Behavior change from the pre-MS4 code:** a device
  now only flips to `offline` after `OFFLINE_AFTER_FAILURES` (3) consecutive
  failures, not the first one — one network blip no longer alarms every
  other VA watching the device list or knocks the active VA off their own
  selection. Auto-recovers to `in-use` on the next success. The existing
  MS2 test that assumed immediate offline-on-first-failure was updated to
  match (split into a "single failure doesn't flip it" test and a "3
  failures does, and recovery works" test).

Verified: 56 automated tests total (up from 40), including — the actual MS4
testing-gate scenario — spawning the real relay as a **separate OS process**,
logging in, killing it, restarting it on the same port, and confirming both
the session (via the old cookie) and the audit history survive. Plus a
manual browser pass: signed in, selected/released a device, confirmed
`GET /api/audit` showed exactly `login_success` → `device_selected` →
`device_released` for that operator, newest first.

One thing worth knowing: while building this, the automated test suite was
found to be writing real session/audit files into the actual dev `storage/`
tree before `SESSION_STORE_DIR`/`AUDIT_LOG_PATH` env-var isolation was wired
up correctly (an ES-module import-ordering issue — fixed by importing
`index.js` dynamically after setting those env vars, in the one test file
that runs it in-process). The leaked test data was cleared from real storage
once found; it was never meaningful data to begin with.

---

## MS5 — Real-device validation & scaling

**Status: 🟡 The automated scale harness is built; physical validation remains.**
`npm run soak` creates isolated authenticated WebSocket clients and mock devices,
drives tap/swipe/home traffic concurrently, and fails when its error-rate or
heap-growth threshold is exceeded. A short 5-device proof completed 60 actions
with 0 errors and +1.4 MB heap. This proves the harness and concurrency path,
not the roadmap's 30-minute soak requirement. The one-iPhone WDA bench,
latency baseline, failure injection, 30-minute soak, and physical 1 → 2 → 5
gates remain unverified until the hardware is connected.

---

## MS6 — Controller mode & input-lease abstraction

**Status: ✅ Done, including the role-gated AI status and takeover UI.**

**Design decision worth flagging:** the six controller modes are a dimension
*orthogonal* to the existing `idle`/`in-use`/`offline` status, not a
replacement for it. A device's controller mode is `HUMAN` by default and
stays there through every normal select/tap/release cycle — `idle`/`in-use`/
`offline` are sub-states *within* `HUMAN` mode, exactly as before. Only an
explicit `switch_to_ai` moves a device into `AI_IDLE`/`AI_RUNNING`/
`AI_PAUSED`. This is why nothing about today's Human VA flow changed at all
by adding this — every existing MS1-4 test kept passing unmodified.

What's implemented:
- [controllerMode.js](../system/server/src/controllerMode.js) — the pure
  state machine: `HUMAN | AI_IDLE | AI_RUNNING | AI_PAUSED | HANDOFF | ERROR`
  and the full legal-transition table. `EMERGENCY_STOP` is legal from every
  single state by construction, not by a special-cased bypass — that's what
  makes "revoke AI input at the control-plane boundary" (CLAUDE.md §4)
  actually true rather than aspirational.
- [deviceLease.js](../system/server/src/deviceLease.js) — the stateful
  registry: `switchToAI` (HUMAN → AI_IDLE, only from an idle device),
  `switchToHuman` (graceful — blocks new AI actions immediately, then waits
  up to `timeoutMs` for whatever's already in flight via
  `registerPendingAiAction`, the hook a future AI worker calls before every
  action), and `emergencyStop` (synchronous, works even against a
  never-resolving pending action — verified by a test that registers a
  promise which never settles and confirms the stop still completes in
  under a second).
- WS protocol: `switch_to_ai`, `takeover`, `emergency_stop` — all
  device-RBAC-gated and, since the 2026-09-08 role pass, additionally
  admin-only; all are audited.
  `select_device` now rejects a device in an AI_* mode with "take over
  first" instead of just failing confusingly.
- Client: AI-mode interaction is now role-aware. Admins receive the
  management controls; VAs see the controller mode plus an admin-handoff note
  and cannot trigger takeover. The server enforces the same rule independently
  of client rendering.

**MS6.3 (dedicated UI — a read-only AI status pane, a permanently-visible
STOP AI button) was deferred here, then built once MS7 gave it something
real to show** (see its own section below).

Verified: 20 automated tests (up from 56 → 76 → 81 across MS1-6), including
the full transition table (every mode × every event), the graceful-handoff
timing behavior, and — the key MS6 correctness property — that
`emergency_stop` completes in well under a second against a WS-level
simulated "stuck AI worker" (a registered action that never resolves),
while a normal `takeover` correctly waits for a real in-flight action to
finish first. Manual pass: from the browser console, sent `switch_to_ai` for
a device, watched it render "— AI_IDLE" in the list, clicked it (triggering
`takeover`, not `select_device`), confirmed it was claimed and controllable,
and confirmed the audit trail showed `switched_to_ai → takeover →
device_selected → device_released` in order.

---

## MS7 — Command & queue scheduler

**Status: ✅ Done, built ahead of MS5 for the same reason MS6 was — no
hardware needed to build or test it against.**

What's implemented:
- [taskSpec.js](../system/server/src/taskSpec.js) — the `TaskSpec` shape (13
  states from `COMMAND_QUEUE_SPEC.md` §5) and pure time-window helpers
  (`isWindowOpen`, `hasWindowExpired`), each taking `now` as an explicit
  parameter rather than reading the real clock internally.
- [commandParser.js](../system/server/src/commandParser.js) — parses
  `/mode`, `/time` (same-day or explicit date), `/cresearch`, `/queue
  add|list|pause|resume|cancel|move|priority`, and `/pause`/`/resume`/`/stop`/
  `/takeover` into validated structured fields — never raw text. Anything
  without a leading `/` is a natural-language *proposal* only
  (`{ goal }`), never silently queued (§12) — turning it into a real
  `TaskSpec` is explicitly left to the model layer (MS8).
- [taskQueue.js](../system/server/src/taskQueue.js) — a factory (like MS4's
  `createAuditLog`, not a singleton — tests get a fully isolated queue with
  injected devices/lease, avoiding the manual-reset pain MS6's singleton
  `deviceLease` needed). Implements: eligibility (window + dependencies),
  per-device dispatch (multiple devices can each run their own task at
  once), FIFO-unless-reordered priority ordering, durable global queue-pause
  state, `FAILED_RETRYABLE` retry
  accounting up to `retryPolicy.maxRetries`, durable `backoffMs` eligibility
  deadlines that survive restart, checkpoints, and restart
  recovery (an interrupted `RUNNING`/`DISPATCHED` task is retried or
  `FAILED_FINAL`'d per its own retry policy on load — COMMAND_QUEUE_SPEC.md
  §14 has no dedicated "interrupted" state among its 13, so this reuses the
  same accounting a normal failure would).
- Queue admission now writes the task snapshot before adding it to the live
  scheduler. If a dispatch write fails after taking a device lease, the task
  and lease roll back to their prior states and a later tick can retry safely.
- `/cresearch` formalized in `docs/COMMAND_QUEUE_SPEC.md` as its own
  documented section (MS7.1.4) — no longer just a code-comment convention.
- `POST /api/queue/command` and `GET /api/queue`, both auth-gated;
  device-targeting commands (`/mode`, `/pause`, `/resume`, `/stop`,
  `/takeover`) are RBAC-checked exactly like `select_device`.
- **Real integration with MS6**, not just adjacent code: dispatching a task
  calls `deviceLease.switchToAI`/`applyEvent(START_TASK)`; a task reaching
  `NEEDS_HUMAN` triggers a genuine `switchToHuman` handoff, not a status
  flag; the existing WS `takeover` message (built in MS6, before any task
  concept existed) was updated to route through `taskQueue.takeoverDevice`
  so a human taking over via the UI properly cancels whatever queued task
  was running — without that fix, the queue would have kept believing it
  held a device that had just become `HUMAN`.

**A real gap in MS6 found and fixed while building this:** the controller-
mode transition table had no `TASK_FINISHED` transition from `AI_PAUSED` —
a paused task that got stopped or cancelled (a scenario MS6 had no reason to
exercise, since nothing could pause a task yet) would have left its device
stuck in `AI_PAUSED` forever, reachable only via a full human handoff or
emergency stop. Added the transition, updated MS6's own test suite.

**Two real bugs found and fixed via the test suite while building this** (not
via inspection — both surfaced as assertion failures against expected
behavior):
1. A task created with an `earliestStart` already in the past stayed stuck
   in `SCHEDULED` forever, because only `tick()` performed the `SCHEDULED` ->
   `QUEUED` transition and `addTask()` only called the dispatch step, not
   the window-check step. Fixed by having `addTask()` call `tick()`.
2. A task recovered from an interrupted restart (`FAILED_RETRYABLE` ->
   re-queued) never actually got re-dispatched, because queue construction
   loaded and recovered tasks but never called `tryDispatch()` afterward.
   Fixed by ticking once at the end of `createTaskQueue()`'s setup.
3. (Found while documenting `/time`'s date handling, not via a queue test
   directly): `timeToDate()`'s same-day path called the real `Date()`
   internally instead of using the injected `now` — meaning a same-day
   `/time` command's actual behavior depended on which real calendar day the
   test suite happened to run on, defeating the entire point of threading
   `now` through explicitly. Fixed, with a regression test using a
   far-future injected `now` specifically to catch this class of bug again.

Verified: 23 new tests (152 total, up from 129 across MS1-6), including a
full HTTP integration pass (login → `/time`/`/cresearch` → `/queue list`/
`priority`/`move`/`cancel` → `/mode ai`/`/pause`/`/resume`/`/stop`/
`/takeover` against the real `deviceLease` singleton) and manual verification
against the real running relay via curl: a `/time` command immediately
dispatched to the only idle mock device, `/queue cancel` released it, and
the audit trail correctly captured the full sequence.

**Follow-up (still same day):** `/device health [id]` and `/audit
[device|operator] [limit]` — both listed in `docs/CODING_ROADMAP.md` §1.1 as
"anticipated future commands," nominally "built at MS4" — had never actually
been added to the console, because no console existed until this milestone.
Added now that MS7 gives them somewhere to live: both are read-only
oversight, so (matching the pre-existing `GET /api/audit` route and the WS
device-list message, neither of which restrict visibility by RBAC) neither
is device-RBAC-gated, unlike every command above that actually acts on a
device. 8 more tests (160 total), verified against the live dev server via
curl.

---

## MS6.3 — Dedicated AI-console UI (built after MS7)

**Status: ✅ Done.** Deferred at MS6 because nothing could reach AI mode
except a direct WS message; built now that MS7's queue gives a device
something real to be doing.

What's implemented, in [client/app.js](../system/client/app.js) and
[style.css](../system/client/style.css):

- **MS6.3.1 status pane**: for admins, any device not in `HUMAN` mode shows
  current task/audit context. VAs see only the coarse controller mode and an
  admin-handoff message; they do not query the admin-only queue/audit APIs.
- **MS6.3.2 AI controls**: admins receive explicit pause/resume, stop-task,
  graceful takeover, and emergency-stop controls. Direct WebSocket
  `switch_to_ai`/`takeover`/`emergency_stop` is also admin-protected, so this
  is not merely hidden-button security.

**Two real bugs found and fixed while wiring this up, neither of them UI
bugs:**

1. **A genuine zombie-task bug in `emergency_stop` itself.** The WS handler
   called `deviceLease.emergencyStop()` directly, bypassing the task queue
   entirely — a `RUNNING` task would keep believing it held the device even
   after `emergency_stop` forced the mode back to `HUMAN` underneath it,
   permanently blocking that device from ever being dispatched to again.
   This is the exact same class of bug the `takeover` WS handler was already
   fixed for during MS7 — `emergency_stop` just hadn't been touched since.
   Fixed with a new `taskQueue.emergencyStopDevice()` (mirrors `stopDevice`,
   but ends in `HUMAN` via `deviceLease.emergencyStop()` instead of
   `AI_IDLE`, and — critically — stays synchronous, since the entire point of
   an emergency stop is never waiting on a stuck action).
2. **Dispatching a task never told anyone watching the device list.**
   `broadcastDeviceList()` was only ever called from inside WS message
   handlers — a task dispatching via the command console, the background
   queue tick, or (eventually) MS8's real worker calling back never reached
   a connected browser at all. Fixed by having `taskQueue` emit
   `dispatched`/`completed` events that `index.js` listens for, plus
   explicit broadcasts on the command-console cases (`mode`, `ai_pause`,
   `ai_resume`, `ai_stop`, `ai_takeover`) that change device state without
   going through those two events. Caught live, not by inspection: the
   status pane rendered "Task: none queued" for a device that was
   genuinely running one, until this was fixed.

**A third bug, unrelated to the UI itself, surfaced by testing the above:**
building this pane was the first code path in the whole app to fire two
concurrent authenticated requests for the same session (`Promise.all` over
`/api/queue` and `/api/audit`) — which exposed a real race in
[fileSessionStore.js](../system/server/src/fileSessionStore.js): `fs.writeFile`
is not atomic, so a `get()` landing mid-write could read a torn/empty file
and come back as "no session," a spurious 401 for a perfectly valid,
logged-in operator. Reproduced live in the browser (intermittent 401s on
`/api/queue`/`/api/audit`) before being root-caused. Fixed with a
temp-file-then-`rename()` write, which on Windows needed a further fix: NTFS
can transiently refuse to rename onto a file another handle has open (the
very `get()` racing it), so the rename retries a few times with a short
backoff rather than failing outright — a genuine OS-level lock that clears
itself almost immediately, not a real error.

Verified: 7 more tests (167 total) — `emergencyStopDevice` unit tests
(including one proving it never awaits a registered-but-never-resolving
pending action), a WS integration test proving a real `RUNNING` task ends
up `CANCELLED` after `emergency_stop` and the device dispatches cleanly
again afterward, a WS integration test proving an HTTP-dispatched task
reaches a connected client with no WS action of its own, and a
concurrency-stress regression test for the session-store race (100 rounds
of a `set()` racing 8 concurrent `get()`s, none ever allowed to see `null`).
Manual pass: live in the browser, dispatched a task via the command console,
watched the status pane render it correctly, hit STOP AI / TAKE OVER,
confirmed the device returned to plain `idle` with no AI-status residue,
and confirmed a fresh task immediately dispatched to it again cleanly.

**Fourth bug, found the next day during a dedicated tech-debt pass, in this
same feature:** `client/app.js`'s WS `error` handler only ever surfaced a
message when its `deviceId` matched `pendingDeviceId` or `currentDeviceId` —
both `null` for an operator who's watching but hasn't selected the AI-mode
device the STOP AI / TAKE OVER button is attached to. An `emergency_stop`
that failed (unknown device, RBAC denial) matched neither, so the error was
silently dropped — clicking a control COMMAND_QUEUE_SPEC.md §9 explicitly
calls "high-priority" gave zero feedback on failure. Fixed with a fallback
branch that surfaces any otherwise-unmatched error via the existing
`select-error` element. No automated coverage — this project's test suite is
server-only (`node --test` over `server/`), with no client-side test
infrastructure; verified live instead, by sending a raw `emergency_stop` for
an unknown device and confirming the message now renders where it silently
vanished before.

---

## MS8 — AI VA read-only research mode

**Status: 🟡 The software path is complete and locally tested. Activation and
the supervised live-device acceptance gate remain.**

- `modelProvider.js`, `anthropicProvider.js`, and
  `openAiCompatibleProvider.js` provide the vendor-independent contract and
  configured adapters. `modelSelection.js` persists `/model set` overrides
  at task, device, workspace, or global scope. The runner resolves this choice
  before every decision, so an operator can switch a running task safely.
- `observationPackage.js` prefers WDA accessibility source and falls back to
  validated PNG/JPEG/WebP images. `actionPolicy.js` permits only configured
  MS8 observation/navigation actions and continues to reject all MS9/MS10
  platform-visible actions.
- Versioned accessibility profiles now exist for Instagram, Reddit, and X.
  They detect supported read-only screens, restrict challenges to passive
  observation, execute through the shared Device API, and verify from a fresh
  observation. A regression test prevents the short X app name from matching
  generic `XCUIElementType*` nodes.
- `/cresearch <platform> [account-id] <minutes> <goal>` resolves exactly one
  configured account authorized for the current operator. Missing, mismatched,
  unauthorized, and ambiguous selections fail closed.
- `researchTaskRunner.js` is subscribed before startup dispatch. It executes
  bounded steps through the real queue/lease path, rechecks live account and
  lease authorization, handles retry and takeover states, and prevents restart
  or immediate-retry dispatch races from leaving zombie `RUNNING` tasks.
- Verified model discoveries create a durable run, append deduplicated
  `ContentCandidate` records, checkpoint task progress, and persist locally
  captured image evidence behind the same workspace/account authorization as
  the review API. Successful completion replaces the provisional overview with
  the final provider summary and records the outcome/completion time. The model
  cannot inject an arbitrary evidence reference.

The shipped `research.config.json`, `models.config.json`, and
`platform-skills.config.json` are empty. This is intentional: no real customer
account, provider credential, installed app version, or device was assumed.
MS8 becomes complete only after those values are supplied locally and the
scripted multi-step/provider test plus supervised read-only run pass on a real
iPhone. No live vendor call or platform action has been claimed.

---

## MS9 – MS13

**Status: ✅ Built and passing local tests (2026-09-19); not exercised on a real device.** The details are in
the 2026-09-19 entry at the top of this file. Where the code lives:

- MS9 — `stateToggle.js` (verify-before-toggle), `platformSkills/toggleActions.js`, `platformSkill.js`
  (re-observe), `researchStore.js` (`locateCandidate`, `recordPlatformAction`).
- MS10 — `actionCatalog.js`, `actionPolicy.js` (validator), `policyStore.js`, `approvalStore.js`,
  `commentGuard.js`, `commentTemplates.js`, `researchWorker.js`; API under `/api/research/:account/`
  (`policies`, `templates`, `approvals`).
- MS11 — `researchSession.js` (budgets, quotas, scoring, reports), `researchTaskRunner.js`.
- MS12 — `fleetPolicy.js`, `interventionQueue.js`, `researchAccess.js` (device affinity); API
  `/api/fleet/ai`, `/api/fleet/interventions`.
- MS13 — `optimization/` (`stateCache.js`, `screenClassifier.js`, `modelRouter.js`, `adaptivePacing.js`,
  `researchIndex.js`, `interventionAnalytics.js`), `optimizationRuntime.js` (opt-in wiring),
  `server/bench/` (regression benchmark), API `/api/research/:account/search` and `/api/fleet/analytics`.

Gaps that remain: see "Not verified" in the 2026-09-19 entry. The blocking dependency on the supervised MS8
device run still applies before any platform-visible action is enabled for a real account.

---

## Built, but not cleanly captured by any single milestone

Three things worth flagging so they don't get overlooked or accidentally
rebuilt:

1. **File transfer is fully implemented** — `fileStore.js` plus the four
   `/api/devices/:deviceId/files*` routes (list/upload/download/delete),
   already hardened against path traversal and unsafe filenames. This
   satisfies `CLAUDE.md` §3's "controlled media transfer" requirement for
   Human VA Pilot V1. It predates this roadmap entirely (it's in Section 0's
   "already working" baseline), which is why it doesn't have its own `MS#` —
   it's only referenced going forward, in MS3.2.3, as something that still
   needs authorization enforced on top of it. Don't mistake "no milestone
   number" for "not done."

2. **`WdaDevice.tapVerified()`** ([wdaDevice.js:78-91](../system/server/src/wdaDevice.js))
   is a fully-written retry-with-verification wrapper around `tap()` — but
   nothing calls it; `index.js` calls `.tap()` directly. It's dead code today.
   Its retry/verify shape is the closest existing thing in the codebase to
   MS9's "verify-before-toggle idempotency" pattern — worth reusing there (or
   in MS2.2's reliability work) instead of writing new retry logic from
   scratch.

3. **Naming drift to resolve, not urgent:** the HTTP route is
   `/api/research/...` while the roadmap's operator command is being
   standardized on `/cresearch` (MS7.1.4). Worth a deliberate decision later
   on whether the route gets renamed to match, rather than accidentally
   ending up with two different names for the same concept.

---

## Suggested next action

**All three originally-requested priorities are now done**: #1 (fleet UI),
#2 (VA/admin role split), and #3 (research review panel + full
`ContentCandidate` schema, plus MS3.3's ownership-model decision that #3
depended on) — all built, tested, and reflected above. 354/354 tests passing.

What's actually left, in rough priority order:

- **Physical/device-isolation track:** wait for client approval and
  reachability notes before making proxy/eSIM-specific code assumptions. The
  repo's Phase-0 egress assignment/verifier remains available and complete;
  the real SE pilot, receipt, leak evidence, and Mac-reachability proof are
  hardware work, out of scope until hardware/approval exists.
- **MS5** remains hardware-dependent: one real-iPhone bench pass, latency
  baseline, then 2- and 5-device soak tests.
- **Configure the first MS8 platform** with its actual installed app version,
  managed account, action policy, and model provider. The Instagram, Reddit,
  and X profiles already exist but have not been accepted against a real app.
- **Run the supervised MS8 gate** on the connected iPhone: multi-step read-only
  navigation, provider decision, candidate/evidence persistence, challenge
  handoff, and human takeover. Keep MS9 actions disabled until this passes.
- **Finish the research pipeline and provider controls:** create candidates
  only after verified discoveries, add `/model set`/per-task selection, then
  run the scripted multi-step test against both provider adapters.
- **Run the supervised real-device MS8 gate** only after the device, research
  account and vendor credential are approved and configured.

The first git commit is still pending because project rules require explicit
user approval before committing.
# 2026-09-28 (latest, part 11) — uploads reject spoofed media before commit

The upload route previously trusted the client-controlled filename extension and
MIME type. A payload such as HTML renamed to `.mp4` could therefore pass the
allow-list and become durable media. Uploads now remain in their hidden staging
file until a bounded header read confirms a supported media signature consistent
with the requested extension. A mismatch returns the stable
`MEDIA_CONTENT_REJECTED` error, releases the reserved quota, removes the staging
file, and leaves an existing same-name file untouched.

The detector covers JPEG, PNG, GIF, WebP, WebM, ISO-BMFF MP4/MOV/M4A/HEIF,
MP3, WAV, and AAC signatures. This is content-type validation, not an antivirus
scanner or full decoder; malware scanning and object-storage quarantine remain a
deployment/product decision.

Focused regression: **86/86 passed**, including spoof rejection, cleanup, quota
release, and preservation of a prior file. Full system suite: **178 files, 1,411
tests, 1,379 passed, 0 failed, 32 skipped** (external PostgreSQL/Redis services
were not configured, so those explicitly gated tests remained skipped).

---

# 2026-09-28 (latest, part 12) — proxy-provider operational contract and deterministic adapter

`proxyProvider.js` was only a health/rotation placeholder and could not express
the provider control-plane behavior named in the production handoff. It now
defines exit inventory, regions, enable/disable, normalized health, capacity,
exclusive leases, release, and atomic rotation. A deterministic in-memory
adapter exercises those semantics without credentials or network side effects;
disabled, unhealthy, full, unknown, and no-alternate cases fail closed.

This is a control-contract milestone, not an exit network. The adapter is not
registered automatically and does not open a socket, start a tunnel, or change
phone egress. Configuration/registry wiring, durable or provider-owned lease
state, audited admin controls, real regional nodes/IP supply, monitoring,
metering, abuse operations, and device-originated leak verification remain.

Focused regression: **8/8 passed**. Full system suite: **178 files, 1,416 tests,
1,384 passed, 0 failed, 32 skipped** (external PostgreSQL/Redis services were not
configured).

---

# 2026-09-28 (latest, part 13) — configured proxy-provider admin control plane

The operational provider contract now has an explicit configuration loader and
audited HTTP/admin surfaces. No configuration remains a valid disabled state;
an explicit missing, oversized, malformed, duplicate, or unknown provider
configuration fails startup. The deterministic adapter is accepted only in test
mode or with an explicit local-development gate.

Authorized operators can inspect safe exit inventory and capacity. Admins can
enable or disable exit admission. Device-authorized proxy assigners can lease,
rotate, and release a provider exit; their live session, capability, and device
grant are rechecked around the asynchronous provider operation. Provider-facing
lease IDs are stable hashes instead of raw logical device IDs. All mutations are
audited and every response explicitly says routing was neither applied nor
verified. The Operations UI displays health, region, capacity, and lease counts,
scrubs them on demotion, and repeats the same routing disclaimer.

This remains a locally tested control plane. The deterministic lease association
is in-process, and no real provider adapter, regional exit infrastructure,
durable provider lease authority, metering, or abuse operation has been selected
or proven. Physical phone egress and leak verification remain mandatory.

Focused regressions: registry/API **24/24**, provider UI **55/55**, lease/rotate/
release **25/25**, and command accessible-name **19/19** passed. Final full
system suite: **179 files, 1,424 tests, 1,392 passed, 0 failed, 32 skipped**
(external PostgreSQL/Redis services were not configured).

---

# 2026-09-28 (latest, part 14) — reviewability pass fixed four security races

The complete 67-path working tree was re-inventoried before review: 17 server
source files, 5 client files, 30 tests, 12 documentation files, 2 maintained
package files, and 1 repository configuration file. No runtime/build artifact or
high-confidence secret signature was found in that set; ignored local storage,
temporary files, dependencies, installers, and operator data remain excluded.

Reviewing the new authorization and provider paths found four reproducible gaps:

- file push captured the request-time operator object, so a device-grant
  revocation during an awaited observation could still be followed by input;
- provider exit enable/disable did not reauthorize at the provider commit point;
- concurrent lease requests against two providers could both observe no current
  lease and leave one provider lease orphaned;
- ban status was persisted before ban-reason validation, so an invalid reason
  returned 400 after partially banning the account.

File push now accepts asynchronous authorization, re-resolves live identity
after observation, and checks before every tap, text entry, and Home recovery.
Provider mutations receive a commit-time authorization callback and all
lease/rotate/release operations serialize per logical device. Ban metadata and
status validate and persist in one account-store write. The CSP reporting route
was also hardened during the same review: unauthenticated writes are rate-limited
and only bounded, query-stripped diagnostic fields are logged; script samples are
discarded.

Focused verification: **60/60 passed** across route-level revocation, provider
concurrency/reauthorization, atomic ban failure, CSP privacy/rate limiting, and
the affected unit boundaries. Final full system suite: **179 files, 1,429 tests,
1,397 passed, 0 failed, 32 skipped** (external PostgreSQL/Redis services were not
configured). Desktop suite: **159/159 passed**. Both production dependency
audits: **0 vulnerabilities**. `node --check` passed on all **53** changed or
untracked JavaScript files and `git diff --check` passed. None of these checks is
physical-device, live-routing, provider, deployment, or delivery evidence.

---

# 2026-09-28 (latest, part 15) — route boundaries, site revocation races, and review-ready local evidence

Five bounded route families were extracted from `server/src/index.js` without
changing their durable owners: proxy-provider administration now lives in
`routes/proxyProviderRoutes.js`, site administration in `routes/siteRoutes.js`,
guarded device file-push delivery in `routes/filePushRoutes.js`, network
verification in `routes/networkCheckRoutes.js`, and media CRUD/upload in
`routes/mediaRoutes.js`. `index.js` remains the composition root and is now
4,392 lines (down from approximately
4,786 at the start of this slice). The
provider route preserves per-device serialization, commit-time authorization,
auditing, safe logical lease identifiers, and explicit `routingApplied: false` /
`routingVerified: false` responses.

The extraction review found two site-link races. First, moving the shared hub
origin helper into the Sites module broke file-push link issuance with a
`ReferenceError`; the helper is now owned once by composition and injected into
Sites. Second, a WebSocket upgrade or buffered device message authorized before
site deletion/token rotation could complete afterward and repopulate the fleet.
`SiteLinkHub` now assigns a per-site authorization generation to every accepted
connection, invalidates it synchronously on deletion/rotation, and rechecks it
after asynchronous authorization before consuming any message. Deterministic
tests cover stale upgrades and buffered device advertisements.

Operations accessibility also received a bounded improvement: role-aware
section navigation, focusable labelled panels, a real command-input label,
table captions, 44-pixel navigation targets, reduced-motion-aware scrolling,
and corrected light/dark muted text contrast. Automated accessibility boundary
tests pass. A rendered screen-reader/per-role audit is still required; the
Windows Electron probe was stopped after it triggered the reported native
memory-address dialog, and no physical or rendered acceptance is claimed.

Focused evidence:

- accessibility/security boundary set: **48/48 passed**;
- proxy-provider route/control set: **28/28 passed**;
- extracted file-push route/skill set: **31/31 passed**;
- extracted network-check boundary: **51/51 passed**;
- extracted media CRUD/upload boundary: **87/87 passed**;
- file-push plus site authorization race set: **6/6 passed**;
- complete `siteLink.test.js`: **14/14 passed on three consecutive runs**;
- complete server suite: **179 files, 1,435 tests, 1,403 passed, 0 failed, 32 skipped**;
- desktop suite: **159/159 passed**;
- both production dependency audits: **0 vulnerabilities**;
- `node --check`: **58/58 changed or untracked JavaScript files passed**;
- `git diff --check`: **passed**.

The current inventory is **75 paths**: 25 server source/script files, 5 client
files, 30 tests, 12 documentation files, 2 package files, and 1 repository
configuration file. Of these, 42 are tracked modifications and 33 are untracked
source/test/documentation files; nothing is staged. The changed-path review
found no runtime/build/storage artifact and no high-confidence credential
signature. This is locally reviewable evidence, not a commit, pushed SHA,
release, deployment, Mac build, iPhone acceptance, or security certification.

Recommended commit boundaries once the owner explicitly authorizes Git work:

1. live-screen/client shell, theme, Operations navigation, and accessibility tests;
2. account/authentication, CSP/rate-limit, ban atomicity, and notification hardening;
3. media validation and the guarded Safari/Files push path;
4. proxy-provider contract, registry, serialized route controls, UI, and tests;
5. Sites/PostgreSQL authority slice, site-link generation guards, and tests;
6. WDA/process-supervision/desktop handoff behavior and acceptance documentation;
7. productionization reports, roadmap material, package metadata, and ignore rules.

`server/src/index.js` must be hunk-split across the relevant groups rather than
assigned wholesale to one commit. No commit or push was performed.

---

# 2026-09-29 (latest, part 16) — commit-point authorization and host authority invariants

A second complete-diff security pass concentrated on asynchronous authorization
boundaries and authoritative state owners. The review reproduced five related
classes of failure before changing code:

- Sites create, update, token rotation, and removal could pass route
  authorization, wait for an asynchronous repository operation, and still
  commit after the operator session was revoked.
- Account administration mutations used request-time authority. Session
  invalidation and two-factor reset also allowed an admin to act on a host even
  though host accounts are outside the admin management boundary.
- Automatic routing and network enrollment could continue after asynchronous
  interface discovery even if routing authority was withdrawn in the meantime.
- Configuration accepted more than one `isMainHost` account, allowing the
  unique top-level host authority to become ambiguous.
- Async Sites/proxy inventory and proxy-test responses could return privileged
  or health-mutating results after the caller lost access.

The smallest durable owners now enforce those invariants. Site and operator
account repository mutations accept an authorization callback and invoke it at
the durable commit boundary; both the file and PostgreSQL Sites adapters follow
the same contract. Account routes re-resolve the live operator and person
management boundary before commit. Routing rechecks authority after discovery,
before tunnel/PF changes, and before publishing active state; enrollment
rechecks before persisting interface or IP identity. Routing teardown still
finishes after revocation because cleanup is the fail-closed safety action.
Operator configuration and `setMainHost` reject a second main host. Async Sites
and provider reads reauthorize before returning, and proxy-test health changes
reauthorize before mutation.

Deterministic focused evidence:

- Sites commit-point authorization and main-host invariant: **47/47 passed**;
- account repository/route authorization and host hierarchy: **33/33 passed**;
- routing/enrollment authorization boundaries: **38/38 passed**;
- final Sites/provider stale-response and health-mutation set: **42/42 passed**.

Final complete server suite: **180 files, 1,442 tests, 1,410 passed, 0 failed,
32 skipped**. The skipped tests still require external PostgreSQL or Redis
services and are not counted as passing. Desktop suite: **159/159 passed**.
Both production dependency audits found **0 vulnerabilities**. `node --check`
passed for all **66** changed or untracked JavaScript entry points;
`git diff --check` passed; the refined high-confidence credential scan checked
all **83** changed paths and found **0 matches**.

The refreshed worktree contains **83 paths**: 30 server source/script files, 5
client files, 33 tests, 12 documentation files, 2 package files, and 1 repository
configuration file. There are 49 tracked modifications, 34 untracked files, and
0 staged files. `HEAD` and `origin/main` remain equal at
`8073f8a89e44f9c567114f470e7e24005c6c8a99`; none of this work is committed or
pushed. The seven existing logical commit boundaries remain appropriate, with
these authorization changes hunk-split into the Sites, account/auth, and
network/WDA groups.

This evidence is local and automated. It does not prove the PostgreSQL adapter
against a real database, Redis behavior, a Mac build, physical iPhone/WDA or
iproxy behavior, phone routing, provider egress, deployment, delivery, rendered
accessibility, or production security.

---

# 2026-09-29 (latest, part 17) — audit and people route boundary

With the P0 defects closed, the next locally eligible maintenance slice moved
the audit and people HTTP endpoints and their response composition out of
`server/src/index.js` into `routes/auditPeopleRoutes.js`. This is an extraction,
not a new state owner: authorized audit reads still belong to `AuditService`;
presence, assignments, device labels, capabilities, management hierarchy, and
device grants remain injected from their existing owners. Getter injection
preserves the composition root's initialization order without caching stale
state.

The focused route/service unit boundary passed **8/8**. The complete affected
WebSocket/HTTP integration suite passed **72/72**, including authentication,
role changes, team-scoped assignment summaries, device filtering, and audit
filtering. The final complete server suite passed **1,413/1,445**, with **0
failures** and **32 external PostgreSQL/Redis skips**, across **181 files**.
Desktop remained **159/159**. Both production audits found **0
vulnerabilities**; `node --check` passed **68/68** changed or untracked
JavaScript files; `git diff --check` passed; and the credential scan checked all
**85** paths with **0 high-confidence matches**.

The final inventory is **85 paths**: 31 server source/script files, 5 client
files, 34 tests, 12 documentation files, 2 package files, and 1 repository
configuration file. There are 49 tracked modifications, 36 untracked files, and
0 staged files. `HEAD` still equals `origin/main` at
`8073f8a89e44f9c567114f470e7e24005c6c8a99`; no commit or push was performed.

`server/src/index.js` is 4,496 lines and `client/app.js` is 4,620 lines after
the accumulated feature and hardening work. Further extraction remains useful,
but the next high-value proofs are gated by a disposable PostgreSQL/Redis
environment, deployment/owner decisions, or physical Mac/iPhone hardware.

---
