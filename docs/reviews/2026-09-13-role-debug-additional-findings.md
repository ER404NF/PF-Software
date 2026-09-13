# Additional role and error-handling findings

**Date:** 2026-09-13  
**Scope:** Admin, Manager, VA, Content Creator, and Editor workflows in the current dirty `system/` working tree  
**Method:** Current-source tracing, disposable relay/session/config stores, command-parser probes, queue/lease probes, and platform-skill accessibility fixtures. The 27 findings in the supplied review and the 18 findings already resolved in `2026-09-13-role-ux-error-handling-findings.md` were treated as the exclusion list.

## Result

This pass found **17 additional issues: 9 P1 and 8 P2**. Three P1 findings are conditional on malformed configuration or deployment of the advertised network fail policy. No application source was changed.

The current automated suite passes **499/499**. The targeted probes below use mock devices and disposable local state. Physical iPhones, live WebDriverAgent sessions, live providers, real network isolation, and deployed multi-browser behavior remain unverified.

| # | Priority | Finding |
| --- | --- | --- |
| 1 | P1 — fixed | `/time` tasks acquired an AI lease although no worker could execute them. |
| 2 | P1 — fixed | A malformed non-VA string device grant authorized substring device IDs. |
| 3 | P1 — fixed | Duplicate usernames made the live account and the account being edited different records. |
| 4 | P1 — fixed | XML accessibility parsing could tap descendants of hidden or disabled containers. |
| 5 | P1 — fixed | Feed text could be mistaken for a detail screen and verify a no-op navigation as successful. |
| 6 | P1 — fixed | A network check returned sensitive results after the operator lost device access. |
| 7 | P1 — fixed | A Manager could see another team’s assignment through a shared phone summary. |
| 8 | P1 — fixed | `fail-closed` network policy permitted Human and AI use after a verified mismatch. |
| 9 | Fixed | Upload streaming now enforces device/global quotas and a filesystem reserve. |
| 10 | Fixed | Media-capable roles have a device-scoped, lease-free files workspace. |
| 11 | Fixed | Numeric research account IDs use explicit `--account` / `--minutes` syntax. |
| 12 | Fixed | Destructive and mode commands reject trailing arguments before execution. |
| 13 | Fixed | X accepts standalone `Reply`/`Replies` navigation but rejects composer controls. |
| 14 | Fixed | Assignment choices use server-derived team eligibility and recover from stale scope. |
| 15 | Fixed | Reviewers get same-origin links only for server-issued evidence references. |
| 16 | Fixed | A short-lived encrypted receipt survives refresh until explicit acknowledgement. |
| 17 | Fixed | Monitor status separates adapter availability from physical acceptance. |

## Findings

### 1. [Fixed] `/time` tasks acquire an AI lease although no worker can execute them

**Resolved 2026-09-13:** the command endpoint now rejects `/time` (including
through `/queue add`) before task creation until a generic worker exists. The
integration regression proves that neither queue state nor any device lease
changes. `/cresearch` remains the supported executable form.

**Evidence:** Reproduced with a real `taskQueue`, `deviceLease`, `MockDevice`, and the registered research runner. A `kind: "generic"` task ended in `RUNNING`; the phone lease was `AI_RUNNING`; `researchTaskRunner.waitForTask(task.id)` returned `null`. [`index.js:1369`](../../system/server/src/index.js) creates `/time` work as `generic`, while [`researchTaskRunner.js:197`](../../system/server/src/researchTaskRunner.js) ignores every non-research dispatch.

**User impact:** An Admin or Manager can submit a documented `/time` command, receive a task object that looks accepted, and lose the phone to AI until the time window expires even though no work is happening.

**Required handling:** Reject executable generic tasks before queue admission until a generic worker is registered. Suggested response:

> General scheduled tasks are not available yet. Use `/cresearch` for supported research work.

**Acceptance:** Every admitted task kind has exactly one worker. A rejected `/time` command creates no task and changes no device lease.

### 2. [P1 — conditional] A malformed non-VA string device grant authorizes substring device IDs

**Resolved 2026-09-13:** persisted operator loading now rejects malformed or
duplicate device grants, and the authorization primitive independently treats a
non-array, non-null grant as no access. The `mock-10`/`mock-1` substring case is
covered directly.

**Evidence:** A disposable Admin record with `allowedDevices: "mock-10"` was loaded. `canAccessDevice(operator, "mock-1")` returned `true`. [`authStore.js:100`](../../system/server/src/authStore.js) preserves the raw value, and [`authStore.js:591`](../../system/server/src/authStore.js) calls `.includes(deviceId)`. Only malformed VA grants are normalized fail-closed.

**Required handling:** Validate every loaded operator before publishing the registry. `allowedDevices` must be `null` or an array of unique valid IDs for every role. Refuse startup with the username and invalid field; authorization must never call a polymorphic string `.includes`.

**Acceptance:** A string, object, mixed array, or duplicate grant fails startup or resolves to no access. `mock-10` never authorizes `mock-1`.

### 3. [P1 — conditional] Duplicate usernames split live authorization from account mutation

**Resolved 2026-09-13:** configuration validation rejects duplicate usernames
before publishing the live registry or allowing a mutation to read the config.

**Evidence:** A two-row config used the same username for a VA and an Admin. The live registry exposed the last row, the Admin. Updating that username changed the first row because [`mapConfig`](../../system/server/src/authStore.js) overwrites Map entries at line 131 while [`updateOperatorAccount`](../../system/server/src/authStore.js) uses `findIndex` at line 367. The API response still described the unchanged Admin row. The persisted file contained the changed hidden VA row and unchanged live Admin row.

**Required handling:** Reject duplicate usernames while loading configuration, before the server accepts connections. Use one validated username index for reads and mutations.

**Acceptance:** Startup fails with `duplicate operator username: <name>`. No management endpoint can report success unless the record used for authorization is the record persisted.

### 4. [Fixed] XML accessibility parsing can tap descendants of hidden or disabled containers

**Resolved 2026-09-13:** XML scanning is now stack-based and propagates an
ancestor's hidden, disabled, zero-size, or offscreen state to its descendants.
The regression contains four ineligible `Profile` descendants followed by one
valid control and proves only the valid coordinate is selected.

**Evidence:** A fixture placed a visible `Comments` button inside an XML parent with `visible="false" enabled="false"`. `findAccessibleElement` returned the child and its coordinates. [`accessibilityTree.js:42`](../../system/server/src/platformSkills/accessibilityTree.js) scans tags independently; the check at line 51 does not carry ancestor state.

**User impact:** AI can tap a stale, covered, or unavailable coordinate. The real control at that coordinate may differ from the hidden accessibility child.

**Required handling:** Parse XML as a hierarchy and propagate hidden/disabled state through descendants. If a requested target exists only in an ineligible subtree, return a safe blocked result without pressing Home or tapping.

**Acceptance:** Nested hidden, disabled, zero-size, and offscreen ancestors make every descendant ineligible. Add equivalent JSON and XML fixtures.

### 5. [Fixed] Feed text can verify a no-op navigation as successful

**Resolved 2026-09-13:** Instagram, Reddit, and X detail states no longer use
generic likes/views/upvotes/reposts text. Stable feed markers take precedence,
and post/thread/comments navigation cannot verify against an unchanged
accessibility fingerprint. All three platform profiles have regression cases.

**Evidence:** An Instagram feed fixture contained `Home feed`, a post card, and `12 likes`. Detection returned `post` because [`instagramSkill.js:14`](../../system/server/src/platformSkills/instagramSkill.js) checks the generic word `likes` before the feed rule. Calling `verify(open_post)` with the exact unchanged observation returned `true` through [`createAccessibilitySkill.js:106`](../../system/server/src/platformSkills/createAccessibilitySkill.js). X and Reddit use similarly broad engagement words.

**User impact:** The runner can record a navigation as verified while it remains on the old screen, then make the next model decision against the wrong state.

**Required handling:** Detect state from stable page/container identifiers and routes rather than descendant content metrics. Navigation verification must require a changed screen identity, selected item identity, or a structural before/after change.

**Acceptance:** An unchanged feed containing likes/views/upvotes cannot satisfy `open_post`, `open_thread`, or `open_comments` verification.

### 6. [Fixed] A network check returns sensitive results after access revocation

**Resolved 2026-09-13:** after the probe completes, the route re-resolves the
session and rechecks the live capability and device grant before requester
audit detail or response disclosure. A delayed-check regression revokes access
mid-request and receives only a `403` with no IP or region.

**Evidence:** A Manager started a delayed network check for an allowed phone. The grant was removed before the checker returned. The request still completed with HTTP `200`, observed IP `203.0.113.42`, and the observed region. [`index.js:1154`](../../system/server/src/index.js) authorizes only before `networkVerifier.checkDevice`; the continuation at line 1176 audits and returns the result without resolving the current operator or device grant again.

**Required handling:** Capture the session identity/version, then re-resolve the operator and recheck capability and exact device grant after the await and before audit detail or response disclosure. Return `401` or `403` without observed network data when access changed.

**Acceptance:** Revocation while the check is pending returns no IP, region, DNS, bandwidth, or proxy-health detail to that requester.

### 7. [Fixed] A Manager can see another team’s assignment through a shared phone summary

**Resolved 2026-09-13:** fleet summaries now apply the same
`canViewAssignment` decision as the assignment API before attaching any
assignment identity or schedule. A shared-phone cross-team WebSocket regression
proves the phone remains visible while the other team's assignment is `null`.

**Evidence:** A Manager in `team-a` and a VA in `team-b` both had access to `mock-1`. The Manager’s WebSocket `device_list` included the VA’s assignment ID, username, status, and schedule. The assignment APIs correctly use `canViewAssignment` at [`index.js:729`](../../system/server/src/index.js), but [`summary`](../../system/server/src/index.js) attaches the globally selected assignment to every user with `MANAGE_ASSIGNMENTS` at line 1008.

**Required handling:** Apply `canViewAssignment(assignment, viewer)` before adding assignment data to a phone summary. If the relevant global assignment is outside scope, return `assignment: null` or a non-identifying occupancy state.

**Acceptance:** A same-device Manager never receives another team’s assignee, assignment ID, instructions, or schedule through HTTP or WebSocket summaries.

### 8. [P1 — conditional] `fail-closed` network policy does not close control

**Resolved 2026-09-13:** one shared network-policy decision now gates fleet
opening, every selected Human action, scheduler dispatch, and continuing
research steps. Failed, mismatched, disabled, missing, or stale verification
blocks fail-closed devices; a fresh pass makes them eligible again. The two
committed mock devices explicitly opt into fail-open for local simulation.

**Evidence:** A disposable phone used `failPolicy: "fail-closed"` and an expected IPv4 different from the observed IP. After the verifier set `networkMismatch: true`, its fleet summary still returned `canOpen: true` and `accessState: "assigned_available"`. [`deviceNetworkConfig.js:99`](../../system/server/src/deviceNetworkConfig.js) defaults the policy to fail-closed, but [`deviceOpenDecision`](../../system/server/src/index.js) and the scheduler gate at line 668 do not consume the policy or verification state.

**Required handling:** Define the enforcement boundary before production use. For fail-closed devices, a known mismatch, disabled proxy, failed verification, or stale required verification must block Human selection and AI dispatch with a clear Admin/Manager remediation path.

Suggested copy:

> This phone is blocked because its network route failed verification. Check the proxy or gateway, run the network check again, or use another phone.

**Acceptance:** A fail-closed mismatch creates no Human or AI lease. A successful fresh check makes the phone eligible again. Fail-open devices remain visibly degraded but follow their configured policy.

### 9. [Fixed] Authorized uploads have no quota or storage-pressure handling

**Evidence:** Source-traced because filling the workstation disk would be destructive. [`index.js:1063`](../../system/server/src/index.js) accepts one file up to 2 GB, but there is no per-device, per-operator, file-count, daily, or total free-space limit before more uploads are accepted.

**User impact:** A Content Creator, Editor, VA, Manager, or Admin with media access can repeatedly upload large source files until the relay host runs out of disk, affecting sessions, audit, queue, research, and every phone.

**Required handling:** Add configurable device and global quotas, reserve-space checks during streaming, and a stable `413`/`507` response. Keep existing files intact when capacity is insufficient.

Suggested copy:

> This phone’s media storage is full. Remove an old file or ask an administrator to increase its limit. Your file was not uploaded.

**Acceptance:** Crossing any quota aborts and removes only the temporary upload, reports current/maximum usage, and does not damage internal stores.

### 10. [Fixed] Content Creator and Editor have media permission but no media workspace

**Evidence:** Both roles receive `media:access` in [`roleCapabilities.js:68`](../../system/server/src/roleCapabilities.js), and the file endpoints accept that capability. The client exposes files only after `confirmSelection`; [`selectDevice`](../../system/client/app.js) returns immediately without `device:control` at line 2119. These roles also cannot live-watch, and the UI has no independent Files navigation.

**Required handling:** Add a device-scoped media browser that does not claim the input lease. Show only granted phones and apply action-level capability metadata for list, download, upload, and delete.

**Acceptance:** Content Creator and Editor can complete every media action the capability promises without gaining screen input or live-monitor access.

### 11. [Fixed] Numeric research account IDs cannot be addressed by `/cresearch`

**Evidence:** `/cresearch instagram 123 30 inspect numeric account` parsed `123` as the duration, omitted the account ID, and changed the goal to `30 inspect numeric account`. [`commandParser.js:83`](../../system/server/src/commandParser.js) decides whether an explicit account exists solely by checking if the token is numeric. Numeric IDs are otherwise valid research identifiers.

**Required handling:** Resolve account IDs from the authorized account registry, or use unambiguous syntax such as `--account 123 --minutes 30`. Reject ambiguous input rather than silently shifting tokens.

**Acceptance:** Numeric IDs select the exact account, and malformed/ambiguous forms return usage text without queueing a task.

### 12. [Fixed] Destructive and mode commands silently ignore trailing arguments

**Evidence:** `/queue cancel task-123 please-do-not-run` parsed as cancellation of `task-123`; `/mode ai mock-1 accidental-extra-text` parsed as a valid mode switch. [`commandParser.js:106`](../../system/server/src/commandParser.js) and queue cases beginning at line 165 validate required tokens but not exact arity.

**Required handling:** Enforce exact arity for `/mode`, `/pause`, `/resume`, `/stop`, `/takeover`, `/queue cancel`, `/queue move`, `/queue priority`, `/queue list`, `/queue pause`, and `/queue resume`.

**Acceptance:** Any unexpected token returns the specific usage string and performs no mutation.

### 13. [Fixed] X’s normal `Replies` control is rejected by `open_comments`

**Evidence:** The X skill declares `reply` and `replies` as targets at [`xSkill.js:19`](../../system/server/src/platformSkills/xSkill.js), but the shared safety filter at [`createAccessibilitySkill.js:16`](../../system/server/src/platformSkills/createAccessibilitySkill.js) accepts only labels based on `comments`. A visible `Replies` button produced `x open_comments target was not accessible` and no tap.

**Required handling:** Make the safe navigation predicate platform/action-specific. Accept standalone `Reply`/`Replies` when they are read-only navigation controls while continuing to reject `Post your reply`, `Send`, and composer controls.

**Acceptance:** X `Replies` opens the reply thread; publication controls remain blocked in JSON and XML fixtures.

### 14. [Fixed] Manager assignment UI offers people outside the Manager’s team

**Evidence:** [`populateAssignmentForm`](../../system/client/app.js) includes every non-Admin/non-Manager person for a Manager at line 890. The server later rejects outside-team assignment through [`canManagePerson`](../../system/server/src/index.js) at line 708.

**User impact:** The Manager can fill out and submit a form that was impossible from the start, then receives a permission error after the work is lost or must be corrected.

**Required handling:** Return server-derived `canAssign` metadata or a scoped assignee list and render only eligible people. Preserve all form fields if scope changes before submission.

**Acceptance:** Manager dropdowns contain self and eligible same-team members only; a stale target produces a local, recoverable error and refreshes the choices.

### 15. [Fixed] Research reviewers cannot open stored evidence

**Evidence:** The authorized evidence route exists at [`index.js:1243`](../../system/server/src/index.js). [`research.js:46`](../../system/client/research.js) renders `evidence_refs` as plain text, so a VA, Content Creator, Editor, Manager, or Admin reviewer cannot inspect the screenshot supporting a candidate.

**Required handling:** Render same-origin evidence references as authenticated **View evidence** links or thumbnails. Keep arbitrary candidate strings non-clickable and preserve account/workspace authorization on every request.

**Acceptance:** An authorized reviewer can open each evidence image; an unauthorized account or stale session receives no bytes and the UI shows a useful access error.

### 16. [Fixed] Refresh after 2FA confirmation loses one-time recovery codes

**Evidence:** [`index.js:178`](../../system/server/src/index.js) permanently configures 2FA, authenticates the session, and returns the only plaintext recovery-code copy. The client stores the completion profile and codes only in memory at [`app.js:730`](../../system/client/app.js). Refreshing before **I saved the codes — continue** runs `/api/me`, opens the app, and the codes cannot be shown again.

**Required handling:** Add a recoverable enrollment receipt/acknowledgement flow, or require a successful download/copy step before the session leaves setup. Warn on refresh/navigation while acknowledgement is pending. Do not put plaintext codes into URL, local storage, logs, or normal account responses.

**Acceptance:** Refreshing or closing at the code screen leads to a secure way to finish or restart enrollment; it never silently enters the app while making the displayed recovery option unrecoverable.

### 17. [Fixed] Monitoring status contradicts the available live-watch action

**Evidence:** Fleet summaries calculate `canWatch` from the live Human/AI state, but also attach `monitorState()` at [`index.js:1022`](../../system/server/src/index.js). [`monitorContract.js:5`](../../system/server/src/monitorContract.js) always reports `available: false`. The detail panel therefore says **Physical monitor: Physical iPhone and WebDriverAgent passive-capture validation is required** at [`app.js:1584`](../../system/client/app.js) even when the same screen offers and successfully starts live watch against the configured adapter.

**Required handling:** Use one runtime monitor contract. Derive availability from the adapter/device and preserve a separate `physicallyValidated` or environment label if needed.

**Acceptance:** `canWatch`, the Watch action, and the detail facts cannot disagree. Mock/local capability and physical validation status are labeled separately.

## Recommended coding order

1. Stop unsupported generic task admission and enforce fail-closed network eligibility.
2. Validate operator config shape and uniqueness before startup.
3. Recheck authorization after network-check awaits and scope fleet assignments with `canViewAssignment`.
4. Fix accessibility ancestry, state detection, and navigation verification before supervised AI use.
5. Add upload quotas and the independent media workspace for Content Creator and Editor.
6. Make command parsing strict and unambiguous.
7. Filter Manager assignees, expose authorized evidence, finish 2FA acknowledgement, and unify monitor status.

## Minimum regression coverage

- Integration: every admitted task kind has a worker; unsupported `/time` work does not acquire a lease.
- Startup: malformed grants and duplicate usernames fail with actionable config errors.
- Platform fixtures: hidden XML ancestors, unchanged feeds, X Replies navigation, and publication-control rejection.
- Integration: grant revocation during network check returns no sensitive result.
- Role matrix: cross-team assignments never appear in Manager fleet summaries.
- Queue/lease: a fail-closed mismatch blocks Human selection and AI dispatch until a fresh passing check.
- Media: Content Creator and Editor can use authorized file routes through the UI; quota failures preserve existing data.
- Parser: numeric account selection and exact command arity.
- Browser: Manager assignee filtering, evidence viewing, 2FA refresh at recovery-code stage, and consistent Watch availability.
