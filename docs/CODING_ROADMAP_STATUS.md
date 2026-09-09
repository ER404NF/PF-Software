# Roadmap Status Report — updated 2026-09-09

## 2026-09-09 — MS3.3 research ownership

Implemented workspace-owned research accounts, explicit operator workspace grants,
authorization on every research route, workspace-separated storage, and audit
context. Admin status does not bypass the boundary. Legacy files remain untouched
and are not served implicitly. Configuration and reviewed migration are documented
in [RESEARCH_OWNERSHIP.md](RESEARCH_OWNERSHIP.md). No real customer mapping was assumed.

Verification: **351/351 full-suite tests passed** with `npm test` (current count,
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
current full automated suite is **351/351 passing**
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
| 1 | Engineering foundations & test infra | ✅ Done | ✅ Passing (351-test full suite) |
| 2 | Human VA core hardening | ✅ Done | ✅ Passing (part of the 351) |
| 3 | Authentication & authorization | ✅ MS3.1/3.2, VA/admin roles and MS3.3 research-record ownership implemented; customer mappings/migration remain explicit setup | ✅ Passing (351-test full suite, 2026-09-09) |
| 4 | Persistence, audit & health | ✅ Done (MS4.1 rescoped — see detail) | ✅ Passing (part of the 351) |
| 5 | Real-device validation & scaling | 🟡 Reusable N-device mock soak runner built; physical WDA validation remains | ✅ 5 mocks/60 actions short proof passed; 30-minute and real-device gates not run |
| 6 | Controller mode & input-lease abstraction | ✅ Done (MS6.3 UI: see detail — STOP AI is now `admin`-only, a deliberate 2026-09-09 decision) | ✅ Passing (part of the 351) |
| 7 | Command & queue scheduler | ✅ Done | ✅ Passing (part of the 351) |
| 8 | AI VA read-only research mode | 🟡 Software path complete locally: providers, model selection, three versioned accessibility profiles, production runner, candidate/evidence pipeline and handoff | ✅ Local unit/integration coverage passing; live provider/app/device gate not run |
| 9 | Private research markers | ⬜ Not started, blocked on MS8 | ❌ Not run |
| 10 | Configured account actions | ⬜ Not started, blocked on MS8-9 | ❌ Not run |
| 11 | Timed autonomous research sessions | ⬜ Not started, blocked on MS10 (MS7 now done) | ❌ Not run |
| 12 | Multi-device AI fleet | ⬜ Not started, blocked on MS11 | ❌ Not run |
| 13 | Optimization | ⬜ Not started, blocked on MS12 | ❌ Not run |

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

- Operators now carry an explicit feature role: `va` or `admin`. Missing or
  unknown role values normalize to `va` (fail closed). This role is separate
  from `allowedDevices`; an admin does not automatically gain access to every
  phone.
- `GET /api/me` exposes only the safe browser profile: `username`, `role`, and
  `allowedDevices`. Password hashes remain server-only.
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
  once), FIFO-unless-reordered priority ordering, `FAILED_RETRYABLE` retry
  accounting up to `retryPolicy.maxRetries`, durable `backoffMs` eligibility
  deadlines that survive restart, checkpoints, and restart
  recovery (an interrupted `RUNNING`/`DISPATCHED` task is retried or
  `FAILED_FINAL`'d per its own retry policy on load — COMMAND_QUEUE_SPEC.md
  §14 has no dedicated "interrupted" state among its 13, so this reuses the
  same accounting a normal failure would).
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

**Status: ⬜ Not started, and structurally blocked**, not just unscheduled:
MS9-10 need MS8's completed real skill and record pipeline, MS11 needs MS8-10 to exist
first (MS7's scheduler it also depends on is now done), MS12 needs MS11,
MS13 needs MS12. No code exists for any of them.

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
depended on) — all built, tested, and reflected above. 351/351 tests passing.

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
