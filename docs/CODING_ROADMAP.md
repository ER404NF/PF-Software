# Coding Roadmap & Testing Strategy — MS1 → MS13

This document translates the existing canonical docs (`README.md`, `Architecture
Baseline.md`, `docs/FUTURE_AI_VA_SPEC.md`, `docs/COMMAND_QUEUE_SPEC.md`,
`docs/PLATFORM_CAPABILITY_MATRIX.md`, `docs/ROADMAP.md`) into a single ordered,
numbered execution plan: concrete milestones (`MS1`, `MS2`, ...), each broken into
steps and substeps, each gated by a testing strategy that must pass before the
next milestone starts.

**This document does not override those canonical docs — it is the "how do we
actually build this, in order, with what tests" layer underneath them.** Where
this doc assigns an `MS#` to something, the source requirement still lives in
the file named next to it. If the two ever disagree, the canonical doc wins and
this file should be corrected.

No code changes have been made as part of writing this document. Per your
request, this is the planning artifact to review before coding starts.

---

## 0. Current state (verified against the actual code, not the docs)

Before planning forward, here's what's actually true in `system/` today, confirmed
by reading the source directly:

**Already working:**
- Config-driven device registry (`devices.config.json` → `MockDevice` / `WdaDevice`)
- Device list/status broadcast over WebSocket, exclusive selection (`in-use` lock)
- Tap, **and also swipe and text input** — all three are implemented end-to-end
  (client buttons/form → WS message → `server/src/index.js` → `WdaDevice.swipe()` /
  `.typeText()`)
- Per-connection action queue (strict in-order processing, prevents out-of-order
  frames)
- WebSocket heartbeat (ping/pong) that releases a device if a VA's tab goes dark
  without a clean close
- Device-side failure isolation (`offline` status instead of crashing the relay)
- Per-device file storage with path-traversal-hardened list/upload/download/delete
- A basic AI-research data layer already exists: `researchStore.js` +
  `/api/research/:account/runs` already implement most of the `ContentCandidate`
  shape from `Architecture Baseline.md` §8 — this is a head start for MS8, not
  something to build from scratch
- A fake-WDA fixture (`server/test/fake-wda-server.js`) for hardware-free
  development

**Important correction to the existing docs:** `system/README.md` and the root
`README.md` backlog both currently say swipe and text input are "not implemented
yet." That's stale — they're in the code (`server/src/index.js:265-290`,
`client/app.js` swipe/type handlers). MS2 below fixes the docs; until then, treat
this section as the source of truth for what's built.

**Confirmed gaps (not yet built):**
- No automated tests anywhere, no `.gitignore`, no operator auth, no persistence
  beyond in-memory `Map`s, no audit log, no controller-mode state machine, no
  command/queue scheduler, no AI worker of any kind. All of these are milestones
  below.

---

## 1. Commands used throughout this roadmap

`docs/COMMAND_QUEUE_SPEC.md` formally defines `/mode`, `/time`, `/queue`, and
`/pause` / `/resume` / `/stop` / `/takeover`. It does not yet define
`/cresearch`, even though the code already references it in comments
(`researchStore.js`, `index.js`) as the command whose output the research API
stores. **Correction from the previous draft: the command is `/cresearch`, not
`/research`** — this revision uses `/cresearch` consistently and MS7 formally
adds it to `COMMAND_QUEUE_SPEC.md` as a documented command rather than a
code-comment-only convention.

| Command | Defined in | Purpose |
|---|---|---|
| `/mode human\|ai [device\|group]` | COMMAND_QUEUE_SPEC.md §2 | Switch a device's controller mode |
| `/time <start>-<end> <task>` | COMMAND_QUEUE_SPEC.md §2 | Bounded-window task |
| `/queue add\|list\|pause\|resume\|cancel\|move\|priority` | COMMAND_QUEUE_SPEC.md §3 | Queue management |
| `/pause` `/resume` `/stop` `/takeover` | COMMAND_QUEUE_SPEC.md §3 | AI control, independent of the queue |
| `/cresearch <platform> <duration> <goal>` | **New — formalized in MS7** | Shorthand for a research-flavored `/time` task; compiles to the same `TaskSpec` + feeds `researchStore.js` |

Natural-language commands (COMMAND_QUEUE_SPEC.md §12) remain supported in
parallel — `/cresearch` is sugar on top of that path, not a replacement for it.

### 1.1 Anticipated future commands (not yet specified — design when the milestone arrives)

These aren't committed syntax. They're a working list so each milestone below
doesn't have to invent its console surface from scratch when it starts — exact
argument shapes get finalized (and added to `COMMAND_QUEUE_SPEC.md` for real,
the same way MS7 does for `/cresearch`) at the milestone listed, not before.
Add to this list as new needs surface; don't feel bound by it.

| Working name | Built at | Purpose |
|---|---|---|
| `/device health [id]` | MS4 (console form actually built MS7.1.5, once a console existed to add it to) | Console health check (last-seen, failure count) instead of only a UI panel — ✅ built |
| `/audit <device\|operator> [range]` | MS4 (console form actually built MS7.1.5, ditto) | Query the audit log without a separate page — ✅ built (`[range]` is a result-count limit today, not a date range) |
| `/model list` | MS8 | List configured model providers and which is active per scope |
| `/model set <provider> [device\|workspace]` | MS8 | Switch which model backend an AI task/worker uses — see §1.2 below |
| `/review <candidate_id> confirm\|remove` | MS8/MS9 | Console shortcut for the VA candidate-review action (mirrors the existing `PATCH /api/research/.../candidates/:id` route) |
| `/policy get <account> [action]` | MS10 | Inspect current per-action policy (`ALLOW_AUTONOMOUS`/`REQUIRE_APPROVAL`/`DISABLED`) |
| `/policy set <account> <action> <value>` | MS10 | Change per-action policy without redeploying |
| `/comment approve <id>` / `/comment reject <id>` | MS10 | Approval-gate action for a drafted AI-generated comment |
| `/template add\|list\|remove` | MS10 | Manage the approved preset-comment template library |
| `/report <run_id\|session_id>` | MS11 | Generate/export a session report |
| `/fleet status` | MS12 | Overview of all concurrent AI workers across devices |

### 1.2 Model providers must stay swappable

The AI worker must not be built against one vendor. Confirmed requirement:
Anthropic, OpenAI (GPT), Kimi (Moonshot), NVIDIA (NIM), DeepSeek, or any other
provider should all be usable, chosen by configuration rather than by which
one happened to get coded first. This is expanded into concrete steps in
MS8.1 — the short version: a `models.config.json` alongside the existing
`devices.config.json` (same pattern the project already uses for hardware),
plus the `/model` commands above to switch providers without a redeploy.

---

## 2. Testing philosophy (applies to every milestone below)

The project currently has zero test infrastructure and only three runtime
dependencies (`express`, `multer`, `ws`). To stay consistent with that minimal
footprint:

- **Test runner:** Node's built-in `node:test` + `node:assert/strict`. No new
  dependency. *Trade-off:* less tooling/UX polish than Jest or Vitest (no
  built-in mocking library, no watch-mode UI), but zero install footprint and
  one less thing to keep updated — reasonable for a project this size. Revisit
  if the test suite grows large enough that the lack of a mocking library
  becomes real friction.
- **HTTP integration tests:** start the real Express app in-process on an
  ephemeral port, hit it with `fetch`, tear it down after. No `supertest`
  dependency needed.
- **WebSocket integration tests:** use the already-installed `ws` package as a
  test client against an in-process relay instance.
- **Device-adapter tests:** run `WdaDevice` against `fake-wda-server.js` (once
  MS1 brings it to parity with the real adapter).
- **Every milestone from here down ends with a "testing gate."** The next
  milestone doesn't start until its predecessor's gate passes. That's the
  mechanism for "testing strategy as milestones," not a separate document.
- **Hardware-dependent checks are always called out explicitly** as manual/
  supervised steps — they can't be automated from a dev machine and shouldn't
  be reported as "tested" until actually run on real hardware.

---

## MS1 — Engineering foundations & test infrastructure

**Depends on:** nothing (do this first)
**Maps to:** cross-cutting prerequisite for all of `docs/ROADMAP.md`
**Why:** Every later milestone's testing gate assumes a test runner, a clean git
history, and a fake-WDA fixture that actually covers the current adapter. None
of that exists yet — building on top of it now means redoing it later under
pressure.

### Steps

**MS1.1 — Repo hygiene**
- MS1.1.1 Add `.gitignore` (`node_modules/`, `storage/*` with `.gitkeep`
  placeholders so the folder structure survives)
- MS1.1.2 Make the first commit — baseline snapshot, after the `.gitignore` is
  in place, not before
- MS1.1.3 `npm audit fix` (resolves the current moderate `qs`/`body-parser`
  advisories)
- MS1.1.4 Cap `WebSocketServer`'s `maxPayload` (e.g. 64 KB — every legitimate
  message today is under 1 KB)

**MS1.2 — Test runner**
- MS1.2.1 Add `"test": "node --test server/test/"` to `package.json`
- MS1.2.2 Establish the convention: `server/test/unit/*.test.js`,
  `server/test/integration/*.test.js`
- MS1.2.3 Write one smoke test (e.g. `fileStore.safeFilename`) to prove the
  runner works before anything else depends on it

**MS1.3 — Fake-WDA fixture parity**
- MS1.3.1 Add `POST /session/:id/wda/swipe` to `fake-wda-server.js`
- MS1.3.2 Add `POST /session/:id/wda/keys` to `fake-wda-server.js`
- MS1.3.3 Extend the existing `/debug/last-tap` pattern to also expose
  `/debug/last-swipe` and `/debug/last-keys`, so tests can assert on them the
  same way

**MS1.4 — Fix documentation drift**
- MS1.4.1 Update `system/README.md`'s "Not implemented yet" list and WebSocket
  protocol table to match reality (swipe/`type_text` already shipped)
- MS1.4.2 Add a "Running tests" section to `system/README.md`

### Testing gate (must pass before MS2)
- `npm test` runs and passes (smoke test green)
- `npm audit` shows no moderate+ vulnerabilities
- `git log` shows a clean initial commit; `git status` shows `node_modules/` and
  `storage/*` untracked
- Manual: `curl` the three fake-WDA routes (tap/swipe/keys) directly, confirm
  each is reflected in its matching `/debug/last-*` endpoint

---

## MS2 — Human VA core hardening

**Depends on:** MS1
**Maps to:** `docs/ROADMAP.md` Stage 1 (partial) / root `README.md` backlog #1-3
**Why:** Swipe and text input are coded but unverified against anything
WDA-shaped, and there's no regression coverage for the input-validation and
ordering bugs that were already hit and hand-fixed once (see project history:
race conditions in frame ordering, `type_text` silently dropping over the length
cap and freezing the UI). This milestone makes "already implemented" mean
"proven," not just "present."

### Steps

**MS2.1 — Automated coverage for what already exists**
- MS2.1.1 Unit: `fileStore.safeFilename`/`safeDeviceId` — valid names, path
  traversal (`../`), control characters, oversized names, header-unsafe
  punctuation
- MS2.1.2 Unit: `researchStore.safeAccountId`, `setCandidateStatus` status
  whitelist (only `confirmed`/`removed` accepted)
- MS2.1.3 Integration: `WdaDevice` against the now-complete fake WDA server —
  tap, swipe, `typeText`, and session invalidation on a simulated failure
- MS2.1.4 Integration: relay WebSocket protocol end-to-end — `select_device` →
  `tap` → `swipe` → `type_text` → `release_device`, using a real `ws` client
  against an in-process relay on an ephemeral port

**MS2.2 — Reliability fixes surfaced by writing those tests**
- MS2.2.1 Add `AbortSignal.timeout(...)` to every `WdaDevice` fetch call; add a
  test where the fake-WDA server intentionally hangs a response and assert the
  device flips to `offline` within a bounded time instead of hanging forever
- MS2.2.2 Test action-queue ordering under rapid concurrent messages (fire 5
  taps back-to-back, assert frames come back in the order sent)

**MS2.3 — Frame refresh / interaction feedback polish**
- MS2.3.1 Client: if the 10s busy-timeout safety net ever fires, surface a
  visible "still waiting / retry" affordance instead of silently re-enabling
  controls
- MS2.3.2 Server: confirm `reportError` fires exactly once per failure (no
  duplicate error broadcasts)

### Testing gate (must pass before MS3)
- All MS2 unit + integration tests green in `npm test`
- Manual: run `fake-wda-server.js`, drive one full session through the real
  browser client (select → tap → swipe → type → release), confirm each action
  shows up correctly in `/debug/last-*`
- Exit condition (matches `docs/ROADMAP.md` Stage 1, partial): swipe and text
  input work end-to-end against a WDA-shaped backend, not just the mock

---

## MS3 — Authentication & authorization

**Depends on:** MS2
**Maps to:** root `README.md` backlog #4-5, `Architecture Baseline.md` §4 (human
workflow starts with "login")
**Why:** `system/README.md` already flags this as a known gap — file storage is
separated by folder structure only, with no check that the VA making the request
is actually the one assigned to that device. This is the single biggest reason
the current prototype isn't safe as real multi-user infrastructure.

### Steps

**MS3.1 — Operator identity**
- MS3.1.1 Decide the auth mechanism: recommend a simple session-cookie login
  backed by a local operator table to start. *Trade-off:* fast to ship, no
  external dependency, vs. no SSO/OAuth — acceptable for a small internal VA
  team; revisit if the client needs SSO later
- MS3.1.2 `POST /api/login`, session middleware, `POST /api/logout`
- MS3.1.3 Require an authenticated session for the WebSocket upgrade and every
  `/api/devices/*` and `/api/research/*` route

**MS3.2 — Authorization / RBAC**
- MS3.2.1 Operator → allowed-device list
- MS3.2.2 Enforce at `select_device` time (today anyone can select any device)
- MS3.2.3 Enforce at file-route time (today anyone who knows a `deviceId` can
  list/upload/download/delete its files)

**MS3.3 — Per-client data separation**
- MS3.3.1 Extend storage layout and research accounts with an owning
  client/workspace id
- MS3.3.2 Add regression tests asserting operator A can never reach operator
  B's selected device, files, or research runs

### Testing gate (must pass before MS4)
- Unit: the allow/deny decision function — covers allow, deny, unknown
  operator, unknown device
- Integration: attempt cross-operator access to another operator's selected
  device / files / research run → expect a rejection, with a permanent
  regression test for it
- Manual: two browser sessions logged in as two different operators — confirm
  neither can see or touch the other's claimed device
- Exit: no route is reachable without authentication except login itself

---

## MS4 — Persistence, audit & health

**Depends on:** MS3
**Maps to:** root `README.md` backlog #6, `Architecture Baseline.md` (persistent
sessions/audit database, device/host heartbeat)
**Why:** accountability (who did what, when) and fleet visibility without
babysitting every tab — both explicit client-facing requirements, and both
currently missing (state lives only in an in-memory `Map` that a relay restart
wipes clean).

### Steps

**MS4.1 — Persistent state**
- MS4.1.1 Move device status / session claims out of the in-memory `Map` into a
  durable store. Recommend SQLite: file-based, zero extra infrastructure,
  consistent with the project's "no infra" style so far
- MS4.1.2 Recover in-flight state on relay restart — a device must never appear
  falsely "in-use" forever just because the process restarted

**MS4.2 — Audit events**
- MS4.2.1 Append-only audit log: device select/release, every tap/swipe/
  `type_text` (log coordinates/direction/text *length*, not full typed text, to
  avoid logging sensitive input), every file upload/download/delete, every
  research-candidate status change
- MS4.2.2 `GET /api/audit` (operator-scoped) for review

**MS4.3 — Health / heartbeat**
- MS4.3.1 Extend the existing WS ping/pong heartbeat into a per-device health
  signal surfaced in the UI (last-seen timestamp, consecutive-failure count)
- MS4.3.2 Auto-mark a device offline after N consecutive WDA failures,
  auto-recover on the next success

### Testing gate (must pass before MS5)
- Unit: audit-log writer (append-only, correct ordering, long-text redaction)
- Integration: kill and restart the relay mid-session, confirm device state
  reconciles sanely — this is the automated version of a bug already hit and
  hand-fixed once (device stuck "in-use" after a client disconnect)
- Manual: kill the fake-WDA process mid-tap, confirm the device flips offline
  and the audit log records it
- Exit: restarting the relay never permanently strands a device, and every
  state-changing action has a corresponding audit row

---

## MS5 — Real-device validation & scaling

**Depends on:** MS4
**Maps to:** root `README.md` backlog #7-8, `docs/ROADMAP.md` Stage 1 exit
condition
**Why:** everything above is unproven until it survives an actual iPhone and
actual concurrent VAs. This is the milestone that answers "does this actually
work," not "does the code look right."

### Steps

**MS5.1 — Single real device bench test** *(hardware-dependent)*
- MS5.1.1 Build/install WebDriverAgent on one authorized iPhone via Xcode
- MS5.1.2 Point one `devices.config.json` entry at it; run the full MS2 manual
  checklist against real hardware
- MS5.1.3 Record baseline latency (tap round-trip, screenshot round-trip) as
  the reference point for detecting future regressions

**MS5.2 — Scale gates**
- MS5.2.1 2-device soak: two VAs concurrently for 30+ minutes, no cross-talk,
  no memory growth
- MS5.2.2 5-device soak: five devices concurrently for an extended session
  (mock devices are an acceptable stand-in for the ones without hardware yet)

**MS5.3 — Failure-injection pass** *(hardware-dependent)*
- MS5.3.1 Kill the WDA process mid-action on the real device, confirm MS4's
  offline/audit path fires correctly on real hardware, not just against the
  fake server

### Testing gate (must pass before MS6)
- Automated: a soak-test script (reuses MS2's WS integration client,
  parameterized to N concurrent connections against N devices) asserting error
  rate stays under a threshold and memory doesn't grow unbounded over the run
- Manual/hardware *(cannot be verified without the physical device — mark
  explicitly unverified until run)*: the real-iPhone bench test and
  failure-injection pass
- Exit: matches `docs/ROADMAP.md` Stage 1's own exit condition verbatim — "a
  human VA can reliably operate authorized real devices and recover common
  failures"

---

## MS6 — Controller mode & input-lease abstraction

**Status: done ahead of MS5** — it needs no hardware to build or test, so it
was completed while MS5 stays blocked on the device's arrival. **MS6.3
(dedicated AI-console UI: a status pane, a permanently-visible STOP AI
button) was deferred** — with no real AI worker yet, there's no way to reach
AI mode except a direct WS message, so a status pane would be UI for a
feature nothing can currently trigger. The *mechanism* MS6.3.2 asks for is
built instead: device-list clicks are mode-aware (`takeover` instead of
`select_device` when a device isn't in `HUMAN` mode), so the interaction
exists without adding a control that would sit permanently inert today. See
`docs/CODING_ROADMAP_STATUS.md` MS6 for full detail. Steps below are the
original plan, kept for reference.

**Depends on:** MS5
**Maps to:** `docs/ROADMAP.md` Stage 2, `CLAUDE.md` §4, root `README.md`
backlog #9-10, `Architecture Baseline.md` §3
**Why:** this is the load-bearing wall between a now-proven-reliable Human VA
Mode and everything AI-related below. `CLAUDE.md` is explicit that this must
exist *before* AI VA work begins, specifically so Human VA never regresses once
AI is introduced.

### Steps

**MS6.1 — State machine**
- MS6.1.1 Introduce the explicit per-device mode `HUMAN | AI_IDLE | AI_RUNNING |
  AI_PAUSED | HANDOFF | ERROR`, replacing today's `idle`/`in-use`/`offline`
  status (which becomes a derived view for the UI, not the source of truth)
- MS6.1.2 Encode the state invariants from `Architecture Baseline.md` §3
  directly as tests: one lease per device; `HUMAN` blocks AI input;
  `AI_RUNNING` blocks human input but keeps takeover available; handoff is
  atomic and logged

**MS6.2 — Handoff transaction**
- MS6.2.1 Switch-to-Human: block new AI actions → finish/timeout the current
  atomic action → checkpoint the AI task → release the AI lease → activate
  human controls → log the handoff
- MS6.2.2 Switch-to-AI: validate device health, account authorization, and
  policy → lock human input → acquire the lease → resume/start per queue policy
- MS6.2.3 Emergency stop: revoke AI input at the control-plane boundary,
  independent of any in-flight action

**MS6.3 — UI surface**
- MS6.3.1 Human-mode read-only AI status pane (current task/queue, last action)
  — as of the 2026-09-09 admin/VA role split, the detailed pane is admin-only;
  a VA-role operator sees a static "admin handoff required" note instead
- MS6.3.2 Always-visible (to whichever role can see the AI-mode surface at
  all — currently `admin` only, see above) **STOP AI / TAKE OVER** control
  wired directly to MS6.2.3 — not routed through normal command parsing, so
  it works even if the command parser is stuck

### Testing gate (must pass before MS7)
- Unit: the full state-transition table — every `(state, event)` pair,
  including illegal transitions correctly rejected
- Integration: simulate an AI action mid-flight, trigger human takeover
  mid-action, assert exactly one input owner exists at every instant (a
  fuzz-style test firing simulated human and AI actions concurrently at random
  and asserting the invariant never breaks, run for many iterations)
- Manual: stub "AI worker" that taps on a timer — take over via the UI
  mid-tap, confirm no double input reaches the device
- Exit: matches Stage 2's own exit condition — "mode can switch without
  reconnecting/restarting the device and without concurrent input"

---

## MS7 — Command & queue scheduler

**Depends on:** MS6
**Maps to:** `docs/ROADMAP.md` Stage 3, `docs/COMMAND_QUEUE_SPEC.md`
**Why:** this is the operator-facing surface the client actually types into.
None of `/time`, `/queue`, `/mode`, or `/cresearch` is useful until tasks
durably queue, survive a restart, and hand off to each other automatically.

### Steps

**MS7.1 — TaskSpec & parser**
- MS7.1.1 Implement the `TaskSpec` shape from `COMMAND_QUEUE_SPEC.md` §4
- MS7.1.2 Structured command parser: `/mode`, `/time <start>-<end> <task>`
  (with optional explicit date, per §2)
- MS7.1.3 Natural-language → proposed-`TaskSpec` path (§12), kept
  model-agnostic at the interface (feeds into MS8's provider abstraction —
  don't let a specific vendor's API shape leak into the parser)
- MS7.1.4 Formalize `/cresearch <platform> <duration> <goal>` as sugar over
  `/time` plus a research-flavored `TaskSpec` — add it to
  `COMMAND_QUEUE_SPEC.md` as its own documented section, replacing the
  code-comment-only convention it's currently referenced by
- MS7.1.5 Add the §1.1 "anticipated future commands" that are ready by this
  point (`/device health`, `/audit`) as real, validated commands if their
  milestones (MS4) are already done — don't let the console fall behind what
  the system can already do

**MS7.2 — Queue engine**
- MS7.2.1 `/queue add|list|pause|resume|cancel|move|priority`
- MS7.2.2 Eligibility check (§6): window open, dependencies met, device/account
  free, policy allows it, concurrency limits respected
- MS7.2.3 Immediate next-eligible dispatch on task completion (§8) — no human
  click required between successful tasks

**MS7.3 — Time windows, retries, checkpoints**
- MS7.3.1 Window semantics (§7): `SCHEDULED` → eligible → stop/checkpoint at
  window end → `PARTIAL`/`EXPIRED`
- MS7.3.2 Retry policy per action type (§10): retryable outright, verify-then-
  retry, or never-blind-retry (comments)
- MS7.3.3 Checkpoint writer (§11), reusing MS4's persistence layer

**MS7.4 — Restart recovery**
- MS7.4.1 On boot: load nonterminal tasks, mark interrupted `RUNNING` attempts
  as recovery-needed, reconcile leases, re-observe device state before
  resuming (§14)

### Testing gate (must pass before MS8)
- Unit: eligibility function (every combination of window/dependency/lease/
  policy/concurrency), window-semantics transitions, retry-policy-per-action
  table
- Integration: queue 3 fake tasks with dependencies and overlapping windows
  against a stub worker, assert dispatch order matches spec exactly; kill the
  scheduler process mid-`RUNNING` task and restart it, assert the §14 recovery
  sequence runs correctly
- Manual: type real `/time`, `/queue`, and `/cresearch` commands into the
  console against the still-stubbed worker, watch chaining happen with no
  clicks between tasks
- Exit: matches Stage 3's exit condition — "fake workers can execute scheduled
  queued tasks deterministically across restarts"

---

## MS8 — AI VA read-only research mode

**Depends on:** MS7
**Maps to:** `docs/ROADMAP.md` Stage 4, `docs/FUTURE_AI_VA_SPEC.md` §§2-4, 11,
14, `docs/PLATFORM_CAPABILITY_MATRIX.md`
**Why:** this is the client's actual AI VA ask — find good content —
deliberately fenced to zero platform-visible actions until MS9 proves the
internal record-keeping works first.

### Steps

**MS8.1 — Model-provider interface (must support multiple vendors from day one)**
- MS8.1.1 `ModelProvider.observe_and_plan(context) -> StructuredDecision`
  boundary (`FUTURE_AI_VA_SPEC.md` §14). The interface must not leak
  vendor-specific request/response shapes upward — swapping providers must
  never touch the scheduler or device layer
- MS8.1.2 Config-driven provider registry, mirroring the pattern
  `devices.config.json` already established for hardware: a `models.config.json`
  listing each configured provider (name, API base URL, model id, credential
  reference) rather than hardcoding any vendor into the code. Credentials are
  secret references per `Architecture Baseline.md` §13, never plaintext
- MS8.1.3 Confirmed requirement: **Anthropic, OpenAI (GPT), Kimi (Moonshot),
  NVIDIA (NIM), and DeepSeek must all be usable**, chosen by config, not by
  which one got coded first — plus room to add others later without changing
  the interface
- MS8.1.4 Practical shortcut: DeepSeek, Kimi, and NVIDIA NIM all expose
  OpenAI-compatible chat-completion endpoints (configurable base URL + model
  name), so one `OpenAICompatibleProvider` implementation covers all three.
  Anthropic needs its own adapter (different request/response shape). Budget
  for building **two** provider adapters at this milestone — Anthropic and the
  OpenAI-compatible one — not four separate ones
- MS8.1.5 Per-task or per-workspace provider selection, overridable at runtime
  via `/model set` (§1.1) once MS8 ships — switching providers must not require
  a redeploy
- MS8.1.6 Define a minimum contract test every provider adapter must pass
  (given a fixture observation, returns a schema-valid `StructuredDecision`)
  so a fifth vendor can be added later just by passing this test, without
  touching anything upstream

**MS8.2 — Observation package**
- MS8.2.1 Accessibility/UI-tree observation first, screenshot fallback
  (`Architecture Baseline.md`'s stated preferred order)
- MS8.2.2 Structured decision schema per §3 (`screen_state`/`goal_progress`/
  `action`/`target`/`reason`/`confidence`)

**MS8.3 — Action validator**
- MS8.3.1 Enforce the action-policy table (`ALLOW_AUTONOMOUS`/
  `REQUIRE_APPROVAL`/`DISABLED`) — only read-only actions are enabled at this
  milestone (scroll/open/observe/capture/copy_link)

**MS8.4 — Platform skill framework**
- MS8.4.1 `PlatformSkill` interface (§11): `detect_state` / `available_actions`
  / `execute` / `verify` / `recover`
- MS8.4.2 One real skill first — pick the client's highest-priority platform
  from `PLATFORM_CAPABILITY_MATRIX.md`, covering the screen states already
  enumerated there

**MS8.5 — Research record pipeline**
- MS8.5.1 Wire the skill's "found something" decision into the *already
  existing* `createRun`/candidate schema in `researchStore.js` — this is the
  one piece of MS8 that's already partially built
- MS8.5.2 Deduplication by platform + stable content ID / canonical URL

**MS8.6 — Human handoff**
- MS8.6.1 `NEEDS_HUMAN` transition on MFA/CAPTCHA/security-review/low-
  confidence (§13), routed through MS6's handoff transaction — not a
  separate, parallel handoff path

### Testing gate (must pass before MS9)
- Unit: action validator against the full policy table (every action × every
  policy value); decision-schema validation (malformed/incomplete decisions
  rejected before reaching the skill)
- Unit: the MS8.1.6 provider contract test, run against **both** provider
  adapters (Anthropic and the OpenAI-compatible one) — same fixture in, same
  schema-valid `StructuredDecision` shape out, regardless of vendor
- Integration: run the skill against a scripted fixture UI-tree/screenshot
  sequence (no live platform involved) and assert correct `ContentCandidate`
  records, correct dedup, and correct `NEEDS_HUMAN` transitions on injected
  challenge screens — run once per configured provider to confirm the
  scheduler/skill layer genuinely doesn't care which one is active
- Integration: `/model set` swaps the active provider for a task without a
  restart; the next decision comes from the newly-selected provider
- Manual/supervised *(real account, real device — cannot be simulated)*: one
  real device, one real account, read-only browsing only, human watching every
  action live
- Exit: matches `FUTURE_AI_VA_SPEC.md` §16 gates 2-3 and Stage 4's exit
  condition — "supervised AI can browse and collect useful content without
  platform-visible actions"

---

## MS9 — Private research markers

**Depends on:** MS8
**Maps to:** Stage 5, `FUTURE_AI_VA_SPEC.md` §16 gate 4

### Steps
- MS9.1 Save/Unsave (Instagram), Save/Unsave (Reddit), Bookmark/Unbookmark (X)
  skill actions
- MS9.2 Verify-before-toggle idempotency — check current saved state before
  acting (`COMMAND_QUEUE_SPEC.md` §10)
- MS9.3 Mirror every save action into the `ContentCandidate`'s
  `platform_actions[]`

### Testing gate (must pass before MS10)
- Unit: idempotency check (already-saved → no-op; not-saved → save; ambiguous
  result → verify-before-retry, per §10)
- Integration: fixture sequence that saves, then re-runs the identical task —
  assert no duplicate save call and no duplicate candidate created
- Manual/supervised: real device, one platform — confirm the saved item
  appears both on-platform and in the internal record
- Exit: "AI can collect and revisit candidates reliably with both platform and
  internal storage"

---

## MS10 — Configured account actions

**Depends on:** MS9
**Maps to:** Stage 6, `FUTURE_AI_VA_SPEC.md` §§7-8

### Steps
- MS10.1 Like/Unlike, Upvote/Downvote/Clear, Repost/Undo — each behind its own
  per-action policy value
- MS10.2 Comment system: preset templates + AI-generated content-grounded
  drafts
- MS10.3 Duplicate/repetition prevention, enforced in application logic, not
  left to the model's prompt
- MS10.4 Approval-gate UI for `REQUIRE_APPROVAL` actions

### Testing gate (must pass before MS11)
- Unit: duplicate-comment detector (exact text and near-duplicate within a
  time window); approval-gate state machine
- Integration: a `DISABLED` action is rejected before it reaches the Device
  API; a `REQUIRE_APPROVAL` action is held until approved, then executes and
  is audited
- Manual/supervised: one real comment posted end-to-end with a human approving
  it first
- Exit: "actions execute only when allowed, are verified, logged, and mirrored
  to research records"

---

## MS11 — Timed autonomous research sessions

**Depends on:** MS10
**Maps to:** Stage 7

### Steps
- MS11.1 Time-bounded multi-step jobs using MS7's scheduler and MS8-10's worker
- MS11.2 Scoring profiles (`FUTURE_AI_VA_SPEC.md` §12) and candidate quotas/
  stop conditions
- MS11.3 Session reports (candidates found, actions taken, cost/latency)
- MS11.4 Recovery from app/device/model failure mid-session

### Testing gate (must pass before MS12)
- Integration: a full simulated session against fixtures, start to finish,
  including one injected mid-session failure — assert the correct
  `PARTIAL`/`EXPIRED`/`SUCCEEDED` outcome
- Manual/supervised: one real timed session, unattended for its window, human
  reviewing the report afterward
- Exit: "a supervisor can queue multiple research jobs and observe them
  complete sequentially within defined windows"

---

## MS12 — Multi-device AI fleet

**Depends on:** MS11
**Maps to:** Stage 8

### Steps
- MS12.1 Fleet scheduler coordinating multiple concurrent AI workers
- MS12.2 Device/account affinity, workspace concurrency policy, resource
  budgets
- MS12.3 Centralized monitoring and an intervention queue for human VAs

### Testing gate (must pass before MS13)
- Integration: N simulated workers against N fixture devices — assert no
  account is ever operated by two workers at once, concurrency limits
  respected under load
- Manual: real multi-device soak with a human intervening on one device
  mid-run without affecting the others
- Exit: "several devices can run independent research tasks while humans can
  take over any device safely"

---

## MS13 — Optimization

**Depends on:** MS12
**Maps to:** Stage 9

### Steps
- MS13.1 Local/cheap screen classification before expensive vision calls
- MS13.2 Model routing by task difficulty
- MS13.3 Cached platform-state detection, adaptive screenshot frequency
- MS13.4 Dedup/search/indexing improvements, operator-intervention analytics

### Testing gate
- A benchmark suite comparing latency/cost before and after each optimization,
  regression-gated so no optimization is allowed to reduce action success rate
- Exit: measured improvement in cost-per-session / latency with no measurable
  regression in success rate (`Architecture Baseline.md` §16 metrics)

---

## Milestone summary

| MS | Name | Depends on | Hardware-dependent? |
|---|---|---|---|
| 1 | Engineering foundations & test infra | — | No |
| 2 | Human VA core hardening | 1 | No (fake-WDA only) |
| 3 | Authentication & authorization | 2 | No |
| 4 | Persistence, audit & health | 3 | No |
| 5 | Real-device validation & scaling | 4 | **Yes** |
| 6 | Controller mode & input-lease abstraction | 5 | No |
| 7 | Command & queue scheduler | 6 | No |
| 8 | AI VA read-only research mode | 7 | Partial (MS8.6/manual gate) |
| 9 | Private research markers | 8 | Partial |
| 10 | Configured account actions | 9 | Partial |
| 11 | Timed autonomous research sessions | 10 | Partial |
| 12 | Multi-device AI fleet | 11 | Partial |
| 13 | Optimization | 12 | No |

MS1-4 and MS6-7 can be fully built and tested without any physical phone. MS5 is
the first hard hardware gate. MS8 onward each keep an automatable fixture-based
gate plus a smaller, explicitly-labeled supervised/manual gate on real hardware
— never claim those manual gates are "done" without actually running them.

---

## Non-goals (repeated here as a guardrail, not new)

Per `README.md` and `CLAUDE.md`: no fake-account generation, no CAPTCHA/
security-control bypass, no fingerprint/location spoofing, no ban-replacement
loops, no engagement-boosting campaigns. If a real platform ever demands MFA or
a security challenge, the correct behavior at every milestone from MS8 onward is
`NEEDS_HUMAN`, never a workaround.

## Assumptions / open questions to confirm before coding starts

1. ~~MS3 auth mechanism~~ — **resolved:** implemented as session-cookie login
   (`express-session`), no pushback received. Revisit only if the client asks
   for SSO later.
2. ~~MS4 persistence choice~~ — **resolved, deviated from this doc's original
   SQLite recommendation:** implemented as plain JSON files instead (one per
   session, one append-only log for audit events), matching every other
   persistence mechanism already in this codebase and avoiding a Node-version
   dependency on the still-fairly-new `node:sqlite`. Revisit if audit query
   needs grow past what a linear file scan handles comfortably.
3. **MS7 `/cresearch` formalization** — this doc assumes `/cresearch` compiles
   to a `/time`-shaped `TaskSpec`. If the client's mental model for it is
   different (e.g., no time bound, different argument order), say so before
   MS7 locks in the syntax in `COMMAND_QUEUE_SPEC.md`.
4. **MS8 platform choice** — which platform (Instagram/Reddit/X) should get the
   first real `PlatformSkill`? Recommend picking whichever the client actually
   wants research on first, rather than building all three in parallel.
5. ~~MS8.1 model provider~~ — **resolved:** must stay swappable across
   Anthropic, OpenAI/GPT, Kimi, NVIDIA, DeepSeek, and anything added later; see
   §1.2 and MS8.1. Still open: which providers have credentials/access ready
   *right now*, since MS8.1.4 only needs two working adapters to prove the
   abstraction, not all five on day one — which two should come first?

This document does not modify `CLAUDE.md`'s canonical-doc precedence list. If
you want `docs/CODING_ROADMAP.md` added to that list formally, that's a small
follow-up edit to `README.md` / `Architecture Baseline.md` — say the word and
it's done.
