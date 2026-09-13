# Phone Farm — Human VA Control System

This directory contains the active prototype for the current product: a relay server and browser client that let a **human VA** select an authorized phone, view its screen, and manually operate it.

The current implementation is a proof of concept, not the completed control plane.

## Current implementation status

Implemented now:

- config-driven mock and WDA devices;
- device list/status;
- exclusive device selection;
- screenshot/frame delivery;
- human click -> normalized coordinate -> WDA tap;
- swipe (four directions), text/keyboard input, and the hardware Home
  button, end to end for both mock and WDA devices;
- per-connection action queue enforcing strict in-order processing, so rapid
  or concurrent messages can't produce out-of-order frames;
- per-request timeout on every WDA call, so a hung real device surfaces as an
  error instead of stalling a connection indefinitely;
- WebSocket heartbeat + client auto-reconnect;
- device-side failure isolation (`offline` instead of crashing the server);
- per-device server-side file folders with list/upload/download/delete routes;
- lease-free, device-scoped media workspaces for every role granted
  `media:access`, including Content Creator and Editor;
- operator login/logout sessions, required for every device/research route
  and for the WebSocket connection itself;
- per-operator device authorization (an operator only reaches the devices
  they're allowed to — enforced server-side, not just hidden in the UI);
- five explicit operator roles mapped to server-side capabilities, layered on
  top of separate device and workspace authorization;
- authenticated live staff presence and a persistent People roster, with
  multi-tab/session aggregation and safe current-phone activity only;
- durable role-aware work assignments with optional phone/account scope,
  once/daily/weekly recurrence, VA progress controls, management-only
  reassignment/scheduling, and immutable actor history;
- file-backed sessions that survive a relay restart, and an append-only
  audit log of who did what (see "Persistence, audit & health" below);
- per-device health tracking (last-seen timestamp, consecutive-failure
  count) — a device only flips offline after a run of failures, not one blip,
  and releases the human claim when it becomes offline;
- the controller-mode/input-lease abstraction (`HUMAN`/`AI_IDLE`/`AI_RUNNING`/
  `AI_PAUSED`/`HANDOFF`/`ERROR`) and the take-over/emergency-stop mechanics —
  see "Controller mode and the input lease" below;
- the AI command console and task queue/scheduler (`/cresearch`,
  `/queue`, `/mode`, `/pause`/`/resume`/`/stop`/`/takeover`) — durable,
  restart-safe, with no production AI worker subscribed yet; see "AI command console
  and task queue" below;
- the MS8 model-provider adapters, UI-tree-first/screenshot-fallback observation
  package, fail-closed action policy, generic versioned platform-skill contract,
  and one bounded research-worker step with verified queue/lease handoff;
- workspace-owned research storage, cross-run candidate deduplication and the
  operator review panel;
- automated test suite (`npm test`) covering all of the above;
- fake-WDA test service for local development;
- Phase 0 of per-phone network isolation — assignment config, audit context,
  and on-demand verification against a device's observed egress IP, ready
  for Phases 1-3's real hardware; see "Network isolation (Phase 0)" below.
- a fleet-style client UI — a device grid grouped by host Mac, with drill-in
  to a per-device control view, plus a role-gated admin/dev workspace; see
  "Fleet UI" below.

Not implemented or activated yet:

- live model/account/app-version configuration and supervised real-device
  acceptance for the locally implemented Instagram, Reddit, and X research profiles;
- continuous/high-frequency frame streaming;
- automatic media ingestion into an iPhone Photos library;
- multi-pod production orchestration;
- the actual per-phone network hardware (SIMs, VLANs, routers, the iOS
  Configuration Profile) — Phases 1-3 of network isolation, physical work
  done separately.

See [`docs/CODING_ROADMAP.md`](../docs/CODING_ROADMAP.md) and
[`docs/CODING_ROADMAP_STATUS.md`](../docs/CODING_ROADMAP_STATUS.md) for the
milestone-by-milestone plan and current status.

## Run it

```bash
cd system
npm install
node server/scripts/create-operator.js <username> <password> --role=admin   # first time only
npm start
```

Open `http://localhost:4173`, sign in, select a device, and click the displayed screen to send a tap.

## Operator accounts — `operators.config.json`

Like devices, operators are config-driven — but the config itself is
generated, never hand-edited, because it holds password hashes:

```bash
node server/scripts/create-operator.js va1 <password> mock-1,mock-2 --role=va
node server/scripts/create-operator.js manager1 <password> mock-1,mock-2 --role=manager --team=team-a --full-name="Manager Name" --email=manager@gmail.com
node server/scripts/create-operator.js creator1 <password> --role=content_creator
node server/scripts/create-operator.js editor1 <password> --role=editor
node server/scripts/create-operator.js admin1 <password> --role=admin
```

`role` and `allowedDevices` answer different questions and are enforced
separately:

- `role` accepts `admin`, `manager`, `va`, `content_creator`, or `editor`.
  Each maps to explicit capabilities documented in
  `../docs/ROLE_CAPABILITY_MATRIX.md`; missing or unknown roles safely
  normalize to `va`.
- For Admin, Manager, Content Creator, and Editor, `allowedDevices: null` means
  all configured devices. Otherwise the array is the exact set that operator
  may control or access through device/file routes. Admin does **not** bypass
  an explicit device array.
- A VA always requires an explicit array. A missing or null VA grant resolves
  to `[]`, so the VA can see safe fleet summaries but cannot open any phone.
  Create one with explicit IDs, for example `mock-1,mock-2`, then manage the
  same grants in Operations > Users and Access.
- Relay startup rejects duplicate usernames and malformed `allowedDevices`
  values (including strings, invalid IDs, mixed arrays, and duplicate entries)
  before any account is published to the live authorization registry.
- Every newly created Manager requires a `teamId`. A Manager's user view is
  server-filtered to the same team and to VA, Content Creator, and Editor
  roles. Managers can review applications and rename those members. Admin
  remains the authority for assigning teams, roles, and grants.

### Signup, approval, 2FA, and recovery

Self-signup requires a full name, a canonical `@gmail.com` address, a username,
and the same 12+ character password twice. New applications are inactive VAs
with no device or research grants. They cannot sign in until an Admin or an
assigned same-team Manager accepts them. An Admin must assign the team before
the application appears to that Manager.

Accepted signup accounts enroll a TOTP authenticator on first sign-in. The
TOTP secret is encrypted at rest and ten one-time recovery codes are shown
until the operator explicitly acknowledges saving them. Refreshing that screen
restores the codes from a short-lived encrypted session receipt; the normal app
session is not authenticated until acknowledgement. Only recovery-code digests
remain in the account record afterward. Email recovery resets the password
and requires authenticator enrollment again. Configure a stable secret before
accepting real users:

```powershell
$env:TWO_FACTOR_MASTER_KEY = "use-a-long-random-secret-of-at-least-32-characters"
```

Approval, rejection, and recovery messages are written to the durable account
notification outbox. Set `COMPANY_FROM_EMAIL` when the company mailbox is
known. Until an SMTP/API delivery adapter and its credentials are configured,
items remain `awaiting_sender_configuration`; the app does not report them as
delivered. `ACCOUNT_NOTIFICATION_STORE_PATH` overrides the outbox path.

Re-running the script for an existing username updates that operator's
password, device list, and role. `operators.config.json` is gitignored — it's
credential material, not fixture data like `devices.config.json` — so a fresh
checkout needs at least one operator created before `npm start` is useful. The
browser receives only the safe profile (`username`, `role`, `allowedDevices`, and
the role's non-secret capability names)
from `/api/me`; password hashes never leave the server.

Sessions are cookie-based (`express-session`, file-backed — see "Persistence,
audit & health" below) and last 24h, surviving a relay restart. Set
`SESSION_SECRET` in the environment before running this anywhere beyond local
dev — without it, the server logs a warning and falls back to an insecure
default.

## Persistence, audit & health

- **Sessions** survive a relay restart via a custom file-backed
  `express-session` Store (`server/src/fileSessionStore.js`) — one JSON file
  per session under `storage/sessions/`, gitignored. Deliberately *not*
  SQLite: this data is small, low-throughput, and every other persistence
  mechanism in this project is already a plain file, so this stays
  consistent with that rather than introducing a database dependency (and a
  Node-version requirement — `node:sqlite` is comparatively new) for what
  doesn't need one yet.
- **Audit log** (`server/src/auditLog.js`) — append-only, one JSON object per
  line, at `storage/audit/events.log` (gitignored). Records logins/logouts,
  device select/release (including denied/conflicting attempts), every tap/
  swipe/type_text, file upload/download/delete, and research candidate
  status changes. Typed text is logged by **length only** — the text itself
  never reaches the log. Query it with `GET /api/audit` (optional
  `?operator=`, `?deviceId=`, `?limit=` query params). This endpoint is
  protected by `audit:view-sensitive` (Admin-only); other roles receive HTTP
  403. The client also hides the viewer, but the server check is the actual security
  boundary.
- **Device health** — each device tracks a last-seen timestamp and a
  consecutive-failure count, visible in the device list. A device only flips
  to `offline` after 3 failures in a row (`OFFLINE_AFTER_FAILURES` in
  `index.js`), not one blip, and releases its human claim at that boundary.
  Recovery requires a later health/device availability update; an offline
  phone cannot be opened. This is a byproduct of actual use, not active polling — an
  idle device nobody has selected gets no health signal until someone does.
- **What device state deliberately does *not* persist**: which device is
  "in-use" and by whom. That claim is inherently tied to a live WebSocket
  connection — a relay restart already drops every connection, so devices
  correctly reset to `idle` on their own. Persisting and restoring that
  field naively would risk the opposite bug: a device stuck "in-use" forever
  because the connection that once claimed it no longer exists to release it.

Both `SESSION_STORE_DIR` and `AUDIT_LOG_PATH` are environment-overridable
(defaulting to the `storage/` paths above) — used by the test suite to keep
test runs from writing into real dev data, not something you need to set
for normal use.

## Devices are config-driven — `devices.config.json`

The server reads device definitions at startup rather than hardcoding the fleet.

```json
{
  "devices": [
    { "id": "mock-1", "label": "iPhone SE — Bench 1 (mock)", "type": "mock" },
    { "id": "iphone-1", "label": "Fallback label", "type": "wda", "port": 8100, "udid": "00008110-..." }
  ]
}
```

### `mock`

An in-memory fake screen from `server/src/mockDevice.js`. Use it for client/server work without hardware.

### `wda`

A real authorized iOS test device controlled through WebDriverAgent via `server/src/wdaDevice.js`. `port` is the local forwarded WDA endpoint for that phone.

On macOS the relay runs `idevice_id -l` and `ideviceinfo` at startup. When a
configured WDA entry includes the matching `udid`, the fleet label is replaced
with the phone's current DeviceName automatically. Connected phones without a
matching WDA entry are shown as detected but unavailable, so USB discovery is
never mistaken for a configured control tunnel. Install `libimobiledevice` on
the main Mac and restart the relay after connecting or renaming phones. Set
`AUTO_DISCOVER_IOS_DEVICES=false` to disable discovery.

Both adapters expose the same tap/swipe/typeText/render contract. As new capabilities are added, extend the adapter interface consistently rather than special-casing the browser for WDA.

### `network` (optional, Phase 0 of per-phone network isolation)

See "Network isolation (Phase 0)" below.

## Bringing up a real phone

1. Build/install WebDriverAgent on the authorized test iPhone using Xcode.
2. Make that phone's WDA endpoint reachable on a dedicated local port on the Mac host (for example through the existing USB forwarding approach).
3. Add the WDA device, its UDID, and local port to `devices.config.json`. The
   displayed name then follows the device automatically.
4. Restart the relay and validate one device before adding more.

The exact real-hardware behavior remains unverified until bench-tested on the target Mac/phone setup.

## Running tests

```bash
npm test
```

Runs the full suite (`node --test`): unit tests for the file-storage and
research-storage validation logic, plus integration tests that drive the
relay's actual WebSocket protocol and the WDA adapter against the fake-WDA
fixture below. No hardware or manual setup required.

Run the configurable multi-device soak gate with:

```bash
npm run soak -- --devices=5 --duration-sec=1800 --actions-per-sec=2
```

The runner creates isolated temporary storage, authenticated WebSocket clients,
and one mock device per client. It reports attempts, errors, error rate, and
heap growth, and exits nonzero when `--max-error-rate` (default `0.01`) or
`--max-heap-growth-mb` (default `64`) is exceeded. The default duration is 30
minutes; a shorter run only validates the harness and does not satisfy MS5's
soak gate.

## Fake-WDA integration fixture

`server/fixtures/fake-wda-server.js` implements the WDA routes used by the
current adapter so the WDA path can be exercised without a physical phone.
It lives outside `server/test/` deliberately — Node's test runner treats
every file under a directory named `test`/`tests` as a test file, and this is
a long-running server, not a test.

```bash
node server/fixtures/fake-wda-server.js 8199
```

Point a WDA config entry at port `8199`. Debug-only routes not part of the
real WDA API, used by the automated tests and useful for manual poking too:

- `GET /debug/history` — every tap/swipe/keys/session/window-size/screenshot
  request received, in order;
- `GET /debug/last-tap` — just the most recent tap;
- `POST /debug/hang` / `POST /debug/unhang` — makes every route stop
  responding, to test client-side timeout behavior;
- `POST /debug/delay {"ms": N}` — delays every response by `N`ms;
- `POST /debug/reset` — clears history and counters back to a clean state.

## Current WebSocket protocol

The connection itself requires an authenticated session — the upgrade
handshake is rejected with HTTP 401 if the request doesn't carry a valid
session cookie (sign in via `/api/login` first). `select_device` additionally
checks that the signed-in operator is authorized for that specific device.

**Important for any client calling `/api/login`:** await the response body
(`res.json()`), not just the response itself, before doing anything that
depends on the session existing (like opening the WebSocket). `fetch()`
resolves once headers arrive, but this server holds the response's final
byte back until the session has actually finished writing to disk — a client
that acts right after headers arrive can occasionally race that write and
get a spurious 401 on its first connection attempt. `client/app.js` and the
test suite both do this correctly; it's only a risk for a future client
(e.g., an AI console) written without this in mind.

Server -> client:

- `operator_profile`: the current safe public operator profile. It is sent on
  connection and immediately after an Admin changes that operator's role or
  grants, so the browser replaces cached capabilities without requiring logout
  or refresh. The client clears capability-scoped DOM and rejects responses
  started under the older profile generation before loading the new safe view.
- `device_list`: viewer-specific safe summaries for every fleet device,
  including `id`, `label`, `hostLabel`, status/health, controller mode, safe
  network state, `assignedToViewer`, `canOpen`, `accessState`, and `openReason`.
  Task instructions, credentials, proxy secrets, and access lists are omitted
  for viewers without the corresponding management capability.
- `frame`: `{ deviceId, kind, data, mime? }`
- `error`: `{ deviceId?, message }`

Client -> server:

- `select_device`: `{ deviceId }` — rejected if the device is in AI mode (`controllerMode !== "HUMAN"`; see "Controller mode" below)
- `tap`: `{ x, y }` where coordinates are normalized from 0 to 1
- `swipe`: `{ direction }` where direction is `up`/`down`/`left`/`right`
- `home`: presses the hardware Home button — always returns to the
  springboard, backgrounding whatever app was open (unlike a tapped in-app
  Back control, which only works from screens that have one)
- `type_text`: `{ text }`, 1-1000 characters
- `release_device`
- `switch_to_ai`: `{ deviceId }` — Manager/Admin; moves an authorized idle device into
  `AI_IDLE`; rejected if it is claimed by a human
- `takeover`: `{ deviceId }` — Manager/Admin; stops AI control (gracefully)
  and claims the device for the caller, in one step
- `emergency_stop`: `{ deviceId }` — Manager/Admin; stops AI control
  immediately, without waiting on anything; does not claim the device

Every message is processed strictly in the order it was sent, per connection
(see the action queue in `server/src/index.js`) — a slow device call never
lets a later message's response arrive out of order.

## File transfer

Each configured device has a separate server-side folder under `storage/devices/<deviceId>/`. `FILE_STORE_DIR` overrides the parent storage directory; media still uses its `devices/` namespace. Internal names such as `sessions`, `audit`, and `queue` cannot be device IDs, and startup rejects overlapping media and internal-state paths. Legacy media from an older installation must be relocated from `storage/<deviceId>/` to this new namespace before use; internal storage must never be migrated as media.

Uploads are streamed through server-enforced capacity gates. Defaults are 10 GiB
per device, 100 GiB across all device media, and a 5 GiB filesystem free-space
reserve. Override these byte counts with `MEDIA_DEVICE_QUOTA_BYTES`,
`MEDIA_GLOBAL_QUOTA_BYTES`, and `MEDIA_MIN_FREE_BYTES`. Invalid values fail
startup; `0` is allowed when a limit or reserve intentionally needs to be
disabled. Quota rejection returns JSON with HTTP 413, while a threatened disk
reserve returns HTTP 507. Responses include the measured and configured byte
counts. Partial staging files are removed and an existing file is preserved
when its replacement fails.

Routes:

- `GET /api/devices/:id/files`
- `POST /api/devices/:id/files`
- `GET /api/devices/:id/files/:filename`
- `DELETE /api/devices/:id/files/:filename`

Every route above requires a logged-in operator authorized for that specific
device (403 otherwise). Sessions and the audit trail are durable. Research
records now separately require a configured owning workspace and explicit
operator workspace grants; admins have no automatic bypass. See
[Research ownership](../docs/RESEARCH_OWNERSHIP.md) for configuration, storage
layout, legacy-data migration and the boundary's limits. Existing operators
without grants cannot access research APIs until configured and the relay restarted.

Also, storing a file on the server is not the same as placing it in an iPhone Photos library. Device media ingestion is a separate future feature.

## Current coding priority

Unless a task specifies otherwise:

1. validate the Human VA path on one physical iPhone when hardware is connected;
2. configure one managed research account, its installed app version, and a model provider;
3. run the supervised MS8 read-only navigation/candidate/evidence gate;
4. keep MS9 platform markers disabled until the MS8 gate passes;
5. scale through measured 1 -> 2 -> 5 device gates.

Everything hardware-independent in the current Human VA Pilot scope is now
built (`docs/CODING_ROADMAP.md` MS1-MS4, MS6). The command/queue scheduler
(MS7) is also done. MS8's hardware-independent execution path, production
runner, provider switching, candidate/evidence pipeline, and three platform
profiles are implemented and tested; live configuration and supervised device
validation remain. See `docs/ROADMAP.md`.

## Scope note for coding agents

The active implementation scope is defined by root `README.md`, root `Architecture Baseline.md`, this file, and the current `system/` code.

Historical files under `../source-material/` and `../archive/` may discuss unrelated or superseded operating models. They are background research and should not be interpreted as requirements for this prototype unless the user explicitly requests a specific document.


## Controller mode and the input lease (built)

The exclusive input lease from the diagram below is implemented, not just
planned: `server/src/controllerMode.js` (the pure state machine — `HUMAN` /
`AI_IDLE` / `AI_RUNNING` / `AI_PAUSED` / `HANDOFF` / `ERROR`, and every legal
transition between them) and `server/src/deviceLease.js` (the stateful
registry that applies it to real devices and owns the async handoff).

```text
Human VA or AI VA -> Control Plane / input lease -> Device API -> Device Adapter -> Phone
```

What the lease guarantees independently of the worker implementation:

- `select_device` is rejected while a device is in an AI_* mode — a human
  must `takeover` first, never silently interrupting whatever holds the lease.
- `takeover` gracefully waits (bounded, `timeoutMs`) for whatever action is
  already in flight before declaring the device safely back under human
  control — via `registerPendingAiAction`, which the research worker calls
  around every device action.
- `emergency_stop` never waits on anything, from any state, including a
  worker that's genuinely stuck — Architecture Baseline.md §3's "revoke AI
  input at the control-plane boundary" requirement. It goes through
  `taskQueue.emergencyStopDevice()`, not `deviceLease.emergencyStop()`
  directly, so a `RUNNING` task gets cancelled instead of being left
  believing it still holds a device that was just yanked back to `HUMAN`.
  A submitted physical action remains tracked until it settles: human selection
  and new AI dispatch stay blocked even though stop is acknowledged immediately.
  A graceful takeover timeout leaves the device in `ERROR` until that action settles.
- The browser client surfaces this according to operator role. Admins see the
  current task/audit detail and AI-management controls; VAs see only the
  controller-mode state and an `AI-controlled — admin handoff required` note.
  This is not cosmetic authorization: direct `switch_to_ai`, `takeover`, and
  `emergency_stop` WebSocket messages from a VA are rejected server-side.

`server/src/researchWorker.js` uses this lease for one bounded, policy-checked
skill step and registers the in-flight promise before device input.
`server/src/researchTaskRunner.js` subscribes it to research-task dispatch and
owns the bounded loop. Device adapters continue to execute primitives while
the provider/worker decides what to do. Human and AI controllers can never have
simultaneous input ownership of the same device — that invariant is what the
state machine's transition table enforces structurally, not by convention.

## AI command console and task queue (built)

The operator-facing command system from `../docs/COMMAND_QUEUE_SPEC.md` —
`server/src/commandParser.js` parses the structured slash commands into
validated fields (never raw text) and `server/src/taskQueue.js` is the
durable, persisted scheduler that acts on them. Like the controller-mode
work above, this is real, tested infrastructure. Tasks queue, schedule, and
dispatch correctly; `researchTaskRunner.js` subscribes research tasks to the
bounded worker after all listeners exist, including restart recovery.

```text
POST /api/queue/command   { "text": "/cresearch instagram 30 Research AI coding reels" }
GET  /api/queue
```

The read-only AI device workspace sends the same endpoint an additional
`deviceId`. The server revalidates AI-workspace access and pins `/cresearch`,
`/cresearch`, and their `/queue add` forms to that exact phone; commands cannot
use the workspace context to target a different device. The chat accepts
`/cresearch <platform> [account-id] <minutes> <goal>` or the unambiguous
`/cresearch <platform> [--account <id>] --minutes <minutes> <goal>` (including `/ cresearch`
with an accidental space), `/device health`, `/pause`, `/resume`,
`/stop`, and `/mode human`.

Supported commands require explicit capabilities in addition to authentication.
Every device-targeting command is still checked against the operator's
`allowedDevices` scope. Global queue changes, model configuration, and sensitive
audit history remain Admin-only:

- `/time <start>-<end> <task>` is parsed for forward compatibility but rejected
  before queue admission until a generic task worker exists. `/cresearch
  <platform> <minutes> <goal>` — queue a real task
- `/queue add|list|pause|resume|cancel|move|priority ...` — queue management;
  `/queue add` accepts a `/time` or `/cresearch` command as its argument, but
  the same unsupported-worker rejection applies to `/time`
- `/mode ai|human <deviceId>`, `/pause|/resume|/stop|/takeover <deviceId>` —
  per-device AI control, built directly on `deviceLease`
- `/device health [deviceId]` — the same live status (`status`, `lastSeenAt`,
  `consecutiveFailures`, `controllerMode`) the WS device list already shows,
  as a console query instead of only a UI panel
- `/audit [device <id>|operator <username>] [limit]` — a console front end
  for the admin-only audit log. `[limit]` caps the result count; there's no
  date-range filter yet, only `auditLog.listEvents`'s existing `limit`.
- anything without a leading `/` is treated as a natural-language goal and
  returned as a **proposal only** (`{ goal }`) — it is never silently queued.
  Turning it into a real `TaskSpec` is the model layer's job (MS8), kept
  entirely out of this parser so it stays provider-agnostic.

What's real today: a task with no time window
dispatches immediately to a free device; a task can target a specific device
or take whichever frees up first; equal-priority tasks stay FIFO unless
`/queue move` reorders them; a task's window opening/closing is enforced on
a clock tick, not just at creation; the global `/queue pause` state survives
relay restarts; `FAILED_RETRYABLE` re-queues up to its
`retryPolicy.maxRetries` before going `FAILED_FINAL`, and a configured
`retryPolicy.backoffMs` now creates a durable retry deadline that is enforced
across relay restarts; a task that reaches
`NEEDS_HUMAN` triggers a real handoff (`deviceLease.switchToHuman`), not
just a status flag; and a relay restart recovers any task that was `RUNNING`
mid-crash per its retry policy, exactly like the persistence work above
already proved for sessions and audit history. Task admission is write-first,
and a failed dispatch write restores both the queued task and its prior device
lease so a disk error cannot create hidden work or a workerless `RUNNING` task.

A restricted admin cannot accidentally bypass device RBAC by creating a
generic task: task specs carry the creator's allowed-device set, and scheduler
dispatch rejects devices outside that set. Role answers "which management
features may I use?"; `allowedDevices` still answers "which phones may I act
on?".

## MS8 research execution path (built locally, awaiting live configuration)

The vendor-agnostic contract the future AI worker will use to reach a
language/vision model, per `CLAUDE.md` §6 ("never hard-code the system to a
single model provider") and `docs/CODING_ROADMAP.md` MS8.1. Like the
controller-mode and command-queue work above, this is real, tested
infrastructure. `researchWorker.js` calls `observeAndPlan` after capturing a
structured observation, and `researchTaskRunner.js` connects it to production
queue dispatch, exact account resolution, model selection, and durable records.

- `server/src/modelProvider.js` — the contract itself: a `ModelProvider` is
  any object with a `.name` and an `observeAndPlan(observation)` method
  returning a `StructuredDecision` (`screen_state`/`goal_progress`/`action`/
  `target`/`reason`/`confidence`, per `docs/FUTURE_AI_VA_SPEC.md` §3).
  `assertValidStructuredDecision` and `assertProviderContract` are the
  schema/contract checks every adapter's tests run against — a fifth vendor
  can be added later just by passing `assertProviderContract`, without
  touching the scheduler or device layer.
- `server/src/anthropicProvider.js` / `server/src/openAiCompatibleProvider.js`
  — the two adapters MS8.1.4 calls for: Anthropic needs its own (different
  request/response shape), while one `OpenAiCompatibleProvider` covers
  OpenAI, DeepSeek, Kimi (Moonshot), and NVIDIA NIM, which all speak the same
  chat-completions shape — configured per vendor via `baseUrl`/`model`, not
  coded per vendor.
- `server/src/providerRegistry.js` — config-driven, mirroring
  `devices.config.json`'s pattern: an optional `models.config.json` at the
  repo root lists `{ name, kind, model, baseUrl?, credentialEnv, default? }`
  entries. `credentialEnv` names an *environment variable* holding the real
  API key — the config file itself never holds a secret, so it's safe to
  commit, same reasoning as `operators.config.json` storing password hashes
  instead of passwords. No file means zero configured providers, not an
  error; nothing crashes on import either way.

`server/src/observationPackage.js` prefers the UI tree and safely falls back to
a screenshot; the adapters emit vendor-native multimodal requests.
`server/src/actionPolicy.js` enforces account policy and keeps every MS9/MS10
platform-visible action disabled. `server/src/platformSkill.js` defines the
detect/available/execute/verify/recover contract and rechecks the input lease
immediately before an action. `server/src/researchWorker.js` joins these pieces
for one bounded step and routes challenge/low-confidence states through the
real queue handoff. JSON and XML accessibility targets inherit hidden/disabled
ancestor state; zero-size or offscreen XML containers also make every
descendant ineligible, so stale covered coordinates cannot be tapped. Feed and
detail detection uses stable screen/container labels rather than descendant
engagement metrics, and post/thread/comments navigation requires a changed
before/after accessibility structure. Tests use fixtures and `MockDevice`; no
live vendor or real platform app has been exercised. See
`docs/CODING_ROADMAP_STATUS.md` for the
remaining MS8 gates.

## Network isolation (Phase 0)

Every phone today shares this Mac's one network path — no isolation exists
yet. The decided fix (source-material/Client Account Separation — Technical
Reference (REDACTED).md §3.5: a stable, unusual IP seen across many
otherwise-unrelated accounts is a real linkage risk, not fingerprint
spoofing or platform-detection evasion, both of which stay out of scope per
CLAUDE.md's non-goals) is per-phone hardware: a cellular SIM per phone, or a
dedicated LTE modem+SIM per VLAN for Wi-Fi-only phones, enforced against
silent fallback by an iOS Configuration Profile deployed out-of-band via
Apple Configurator. That hardware (Phases 1-3) doesn't exist yet and is out
of scope for this repo. **Phase 0, built here, is the repo-side config,
audit, and verification support** the rest builds on.

`devices.config.json`'s optional per-device `network` block
([deviceNetworkConfig.js](server/src/deviceNetworkConfig.js)) records the
assignment once hardware exists to have one:

```json
{
  "id": "mock-1",
  "network": { "egress": "cellular-sim", "simIccid": "8901...", "controlIface": "usb" }
}
```

- `egress`: `"cellular-sim"` (the phone's own SIM is its isolation boundary,
  identified by `simIccid`) or `"vlan-proxy"` (a Wi-Fi-only phone routing
  through a VLAN's shared dedicated modem, identified by `vlanId`).
- `controlIface` is always `"usb"` — WDA's control channel stays on the
  existing USB iproxy tunnel regardless of egress, untouched by this work.
- `enabled` records whether a configured proxy assignment is active in the
  control plane. Admins can change it from the fleet card through
  `PATCH /api/admin/devices/:deviceId/proxy`; the update is persisted and
  audited, and safe summaries are broadcast immediately. The external gateway
  or proxy provider remains responsible for applying the route to phone traffic.
- `failPolicy` defaults to `"fail-closed"` for real assignments. A missing,
  failed, mismatched, or stale check (15 minutes by default), and a disabled
  proxy assignment, block Human selection and AI dispatch. Set
  `NETWORK_VERIFICATION_MAX_AGE_MS` to 1000-86400000 to change the freshness
  window. A fresh passing check restores eligibility. The committed mock-only
  devices explicitly use `"fail-open"` so local simulation remains usable and
  visibly unverified; do not copy that exception into the Mac mini live config.
- Omitting `network` entirely (every device today) means "not yet assigned"
  — loading never fails or invents a default for a device without one.

[networkVerifier.js](server/src/networkVerifier.js) determines a device's
*actual* observed egress IP (via `POST /api/devices/:deviceId/network-check`
`{ checkUrl }` — the URL is supplied by the caller rather than read from
config, since no real per-device check endpoint exists until Phase 1-3
hardware does) and flags a mismatch specifically when two devices on
*different* assigned egress channels (different `simIccid`/`vlanId`) report
the *same* IP — the concrete, checkable form of "isolation silently failed"
(e.g. a modem dropped and the phone fell back to a shared network). Two
devices on the *same* `vlanId` sharing an IP is expected, not a mismatch.
[fake-network-check-server.js](server/fixtures/fake-network-check-server.js)
stands in for the real check endpoint so this is fully testable today.
The network-check route re-resolves the live session, capability, and exact
device grant after the probe completes and before returning observed IP,
region, DNS, bandwidth, or proxy-health data; revocation during a slow check
therefore returns only `401`/`403` and no operational result.

`networkVerified`/`networkMismatch`/`network` (the assignment) appear
alongside `status`/`controllerMode` in the WS `device_list` message and
`GET /api/devices` summaries, and every core Human VA Mode audit event
(`action_tap`/`action_swipe`/`action_home`/`action_type_text`/
`device_selected`/`device_released`/`file_*`) now records the device's
assigned `network.egress` in its `detail`, when one exists — the
"account/device context" field CLAUDE.md §8 requires for AI VA Mode's future
research records, applied here to today's Human VA Mode audit trail.

Not built: the actual hardware/routers/SIMs (Phases 1-3), and automatic or
periodic checking. Checks are on demand; once a fail-closed check ages past the
configured freshness window, the next Human action and every new/continuing AI
step fail closed until verification passes again.

## Fleet UI

The client (`system/client/`) remains plain `index.html`/`app.js`/`style.css`
with no framework or build step. It now has a role-aware view split on top of
the existing authentication system:

- **VA view**: safe cards for every fleet phone, with explicit assigned/not
  assigned text and server-calculated availability. Only an explicitly granted,
  online, idle, Human-mode phone has an Open device action. After opening, a VA
  can view/control the phone, tap/swipe/type/Home, use normal file transfer,
  return to Fleet, release, and sign out. Queue, audit, network-check, user,
  assignment, proxy/security, and AI-management controls are absent.
- **Admin/dev view**: everything a VA sees, plus an Admin-only proxy-assignment
  switch on proxy-routed device cards and a dedicated Admin workspace
  containing the existing command console, readable task-queue viewer, audit
  viewer, refresh controls, and AI-mode management. The UI calls the existing
  `/api/queue/command`, `/api/queue`, and `/api/audit` APIs rather than
  inventing a second control path.
- **To-do view**: Admins and Managers create once, daily, or weekly tasks for
  VAs they are authorized to manage. VAs see only their own scoped list and
  can Start or Complete it; reassignment, cancellation, and scheduling remain
  management-only. Completing a recurring task records that occurrence and
  advances its durable schedule.
- **Read-only live watch**: an Admin, or a Manager assigned to the active VA's
  team, can open an in-use VA phone as a read-only screen. The server requires
  `device:monitor`, the viewer's device grant, Human mode, active VA ownership,
  and same-team scope for Managers. It never transfers the input lease. Frames
  update after VA actions and through a two-second read-only refresh; stopping,
  revocation, logout, disconnect, or VA release clears the watched screen.
  Fleet details label runtime adapter availability separately from physical
  acceptance. A configured WDA adapter can provide frames without claiming that
  passive capture passed hardware acceptance. Set
  `monitorPhysicallyValidated: true` only on a `type: "wda"` device after that
  exact phone passes the live test; startup rejects the flag on mock devices.

The fleet view itself is a responsive grid of device cards grouped by
`hostLabel`. Each card shows live status (`idle`/`in-use`/rendered `warning`/
`offline`), label/ID/host, controller mode, grant state, current controller,
last seen/health, and safe egress/verification state. Opening a device enters
the existing live-control screen.
Returning to Fleet does **not** silently release the claim.

For admins, AI-mode cards include task state and relevant audit context plus
separate controls for pause/resume, graceful takeover, task stop, and
emergency stop. For VAs, the same card is non-takeover and states that admin
handoff is required.

**`hostLabel`** (`devices.config.json`, optional per device) is the fleet
grouping key. It is deliberately distinct from `WdaDevice`'s network `host`
option. A missing `hostLabel` falls into the implicit `"this-mac"` group. This
relay still manages its own local devices; there is no cross-Mac aggregator
yet.

**"Warning" status** remains a rendering-layer interpretation of existing
fields: `status !== "offline" && consecutiveFailures > 0`. No new device
state was added to the protocol.

**Visibility vs authorization:** an operator with `fleet:view` receives every
device as a safe viewer-specific summary. `canOpen` is display metadata only;
the server independently rechecks the live session, operator, role capability,
explicit grant, Human lease, device status, and WebSocket ownership for selection
and every later input. Grant/role/operator revocation releases the claim and
returns the client to Fleet without leaving a stale frame. Role/grant edits also
push a safe `operator_profile` update before the corresponding fleet broadcast;
late queue, audit, user, assignment, and People responses from the previous role
are discarded instead of repopulating cleared privileged UI.

**Test coverage:** `npm test` now includes static client-role safety checks
(including that every `getElementById` used by `app.js` exists in
`index.html`) plus HTTP/WS integration tests for safe `/api/me`, VA 403s on
admin-only APIs, admin access, direct VA AI-control rejection, normal VA device
control, restricted-admin scheduler dispatch, research ownership/review, model
adapters, observation fallback, policy enforcement and the bounded worker.
Full suite: **490/490 passing** on 2026-09-12. A final visual pass in Chrome/Safari on the deployment
Mac is still recommended because the repo does not run a full browser E2E
harness.

The AI research/chat side panel and full `ContentCandidate` fields
(`platform_actions[]`, `evidence_refs[]`, etc.) are implemented. Verified
discoveries now populate candidates automatically and attach evidence captured
by the control plane. Live app/device acceptance remains the MS8 gate.
