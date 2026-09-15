# Additional role and error-handling findings

**Date:** 2026-09-15  
**Scope:** Admin, Manager, VA, Content Creator, and Editor behavior in the current dirty `system/` working tree  
**Method:** Disposable local relay, five role-specific fixture accounts, HTTP/WebSocket actions, persisted-state fixtures, targeted source tracing, and the full automated suite. Application source was not changed.

## Result

This pass found **11 additional open issues: 9 P1 and 2 P2**. The current 24-finding code-review verdict and all prior review reports were treated as exclusions. The strongest new risks are unbounded login attempts, a resettable two-factor attempt counter, fail-open malformed account state, ambiguous completed phone input, and duplicate persisted task IDs that can run on two phones.

The fresh suite passed **566/566**. The targeted probe passed all 12 checks in [`2026-09-15-role-error-handling-probes.mjs`](./2026-09-15-role-error-handling-probes.mjs). The Codex in-app browser could not be launched because automatic approval review reported that its selected browser model was at capacity. Role screens were therefore source-traced and their backing actions were exercised through the disposable relay; this report does not claim a completed visual browser pass. Physical phones, WDA, live providers, email delivery, and deployed HTTPS were not exercised.

## Resolution — 2026-09-15

All 11 findings below are resolved in the current working tree. Regression
coverage now includes login and 2FA throttling, mandatory enrollment for
Admin-created users, worker-role assignment progress, the network-check UI,
action-applied receipts, strict account and durable-task validation, bounded
signup intake, command idempotency, and uncertain research-review recovery.

The exact `npm.cmd test` command passes **578/578** across 53 test files. The
running local server on port 4187 serves byte-identical current copies of
`index.html`, `app.js`, and `research.js`, and the signed-out login page was
confirmed in the Codex browser. This resolution does not claim physical iPhone,
live WDA, provider, outbound email, or deployed HTTPS validation.

## Role coverage

| Role | Actions checked | New failure paths |
| --- | --- | --- |
| Admin | Login, user creation, fail-closed phone recovery, AI commands | No login throttle, password-only created users, no network-check control, uncertain commands lose input and can duplicate work |
| Manager | Login, assignment creation, fail-closed phone recovery | No network-check control; creates assignments two roles cannot progress |
| VA | Login/2FA, phone selection and tap, assignments, research panel | Resettable 2FA budget; completed tap reported as phone failure; research errors bypass common handling |
| Content Creator | Login, own assignments, research panel | Own assignment cannot be started/completed; research errors bypass common handling |
| Editor | Login, own assignments, research review | Own assignment cannot be started/completed; Admin-created account can bypass 2FA |

## Findings

### 1. [P1] Password login has no rate limit

**Reproduction:** Eight rapid wrong-password requests for one existing Admin account from one source all returned `401`; none returned `429` or a cooldown. [`index.js:159`](../../system/server/src/index.js) verifies each request and writes `login_failed` but has no account, source, or global limiter.

**Impact:** An attacker can guess passwords at the full rate the host permits and amplify audit-log writes. The two-factor layer does not protect accounts created without 2FA, including finding 3 below.

**Required handling:** Apply layered limits by normalized username and source IP, add a bounded global circuit breaker, and use the same generic response for known and unknown users. Persist or share counters across restart when this service is deployed across processes. Suggested copy after the limit:

> Too many sign-in attempts. Wait a few minutes before trying again.

**Acceptance:** A bounded burst reaches `429` without another password hash calculation or unbounded audit growth; another username cannot trivially bypass the source limit; successful sign-in clears only the appropriate account counter.

### 2. [P1] Re-entering the password resets the two-factor attempt budget

**Reproduction:** A valid-password login created a 2FA challenge. Four invalid codes returned `401`. Reposting the correct password with the same session replaced `pendingAuth` with `failedAttempts: 0`; four more invalid codes again returned `401` instead of the fifth-attempt `429`. The reset is at [`index.js:172`](../../system/server/src/index.js); the limit is scoped only to that pending session at [`index.js:132`](../../system/server/src/index.js).

**Impact:** Anyone who obtains a password can make unlimited TOTP/recovery-code guesses by refreshing the challenge before attempt five. Parallel sessions provide the same bypass.

**Required handling:** Count failures by operator plus source independently of the replaceable session challenge. A new password verification must not reduce the live failure count. Expire counters by a defined window and invalidate all outstanding challenges when the limit is reached.

**Acceptance:** Four wrong codes, another correct-password login, and one more wrong code produce the configured lockout. Concurrent sessions share the limit, and a valid second factor resets it only after successful authentication.

### 3. [P1 — conditional] The Admin Create user flow silently creates password-only accounts

**Reproduction:** The Admin user form has no 2FA choice at [`index.html:307`](../../system/client/index.html). Its request omits `twoFactorRequired` at [`app.js:3112`](../../system/client/app.js). The server defaults the omitted field to false at [`authStore.js:384`](../../system/server/src/authStore.js). A created Editor immediately received HTTP `200` from `/api/login`, with no 2FA setup or verification response.

**Impact:** Self-signup accounts require authenticator enrollment, but an Admin can create an Admin, Manager, or staff account with weaker password-only authentication without seeing a warning. This is a P1 if 2FA is intended for every human account; otherwise the product needs to state the exception explicitly.

**Required handling:** Default new human accounts to `twoFactorRequired: true`. If a password-only break-glass account is required, make it an explicit security-only option with a confirmation, reason, audit event, and prominent status on the user card.

**Acceptance:** A user created through the ordinary form must enroll or verify 2FA before `/api/me` succeeds. A test must cover every role, including Admin and Manager.

### 4. [P1] Content Creator and Editor assignments cannot be progressed by their assignees

**Reproduction:** A Manager can assign VA, Content Creator, or Editor accounts through `MANAGER_ASSIGNABLE_ROLES` at [`index.js:802`](../../system/server/src/index.js). Both additional roles received and could view their own assignments, but `PATCH ... {status:"in_progress"}` returned `403`. The server permits own progress only when the exact role is VA at [`index.js:924`](../../system/server/src/index.js), and the UI uses the same exact-role check at [`app.js:1091`](../../system/client/app.js).

**Impact:** A normal Manager can create work that its assigned person cannot Start or Complete. The only recovery is for a Manager to maintain the worker's progress manually, which makes the assignment history inaccurate.

**Required handling:** Either let each supported assignee role progress its own assigned → in-progress → completed transitions, or remove Content Creator and Editor from eligible assignees and explain that assignments are VA-only. Use one server-provided `canProgress` contract so UI and API cannot drift.

**Acceptance:** Every role shown in the assignee picker can complete the advertised workflow through both UI and direct API. Ineligible roles never appear as selectable assignees.

### 5. [P1] Fail-closed phones tell managers to run a check that the UI cannot run

**Reproduction:** A disposable fail-closed phone with no verification was blocked as designed. Admin and Manager have `network-health:verify` at [`roleCapabilities.js:56`](../../system/server/src/roleCapabilities.js), and the server exposes `POST /api/devices/:deviceId/network-check` at [`index.js:1286`](../../system/server/src/index.js). The client only displays **Last verification** and **Isolation** at [`app.js:1691`](../../system/client/app.js); it contains no `/network-check` request or network-check control. The only network mutation rendered on a card is the Admin proxy toggle near [`app.js:1882`](../../system/client/app.js).

**Impact:** After first setup, expiry, mismatch, or a route change, the phone is correctly unusable but a normal Admin/Manager has no in-app recovery path. The server's message says to “run the network check again,” creating a dead end unless someone knows the raw API.

**Required handling:** Add **Run network check** for authorized Admin/Manager users, with pending, pass, fail, timeout, stale-result, and permission-change states. Show the configured target/route label without exposing credentials. Keep the phone blocked until an authoritative current result succeeds.

**Acceptance:** A fail-closed card with missing/stale/failed verification provides the authorized action and updates from a fresh server response. VA, Content Creator, and Editor receive role-appropriate contact-manager guidance and no control.

### 6. [P1] A completed phone action can be reported as a failed phone action

**Reproduction:** A fixture device accepted exactly one tap, then failed the screenshot refresh. The socket returned only `Couldn't reach Partial action fixture.` even though `tapCount` was already 1. The server awaits the physical tap at [`index.js:2450`](../../system/server/src/index.js), records it, and then awaits `sendFrame()` at [`index.js:2462`](../../system/server/src/index.js). Screenshot failure is converted to the generic transport error near [`index.js:2024`](../../system/server/src/index.js). Swipe, Home, and text use the same sequence.

**Impact:** The operator reasonably retries a tap, submission, Home press, or typed text that already reached the phone. On a social app that can duplicate publication, reactions, or navigation.

**Required handling:** Return action acknowledgement separately from screen refresh. When input succeeded but refresh failed, retain ownership and say:

> The tap reached the phone, but the screen could not refresh. Do not repeat it until you check the phone or refresh the screen.

Include a stable result code such as `action_applied_refresh_failed`, the action request ID, and a dedicated **Refresh screen** action. Do not count this as an input failure.

**Acceptance:** A successful input followed by failed render produces exactly one device input, an explicit applied-but-unverified response, and no automatic replay. The client does not label the phone unreachable solely from the refresh failure.

### 7. [P1 — conditional] Malformed account status values fail open at startup

**Reproduction:** An operator record with `active: "false"` and misspelled `accountStatus: "pendng"` passed `validateOperatorConfig()` and authenticated with its valid password. Startup validation at [`authStore.js:226`](../../system/server/src/authStore.js) checks username and device grants but not these fields. Normalization treats any value except literal `false` as active and any unknown status as approved at [`authStore.js:102`](../../system/server/src/authStore.js) and [`authStore.js:107`](../../system/server/src/authStore.js).

**Impact:** A manual edit, migration error, partial external config generator, or typo intended to disable or hold an account can instead authorize it. This crosses the authentication boundary.

**Required handling:** Validate `active` as boolean, `accountStatus` against the enum, role against known values, hashes against the stored format, and 2FA field consistency before loading any account. Reject the whole config with the exact operator and field; never coerce authorization state open.

**Acceptance:** Both malformed values stop startup with actionable errors. Unknown authorization-related fields never normalize to a more privileged state.

### 8. [P1 — conditional] Duplicate persisted task IDs can run simultaneously on different phones

**Reproduction:** A version-2 queue snapshot containing two valid queued records with the same `id` loaded successfully. On two idle phones, both records became `RUNNING`, each on a different phone. [`taskQueue.js:55`](../../system/server/src/taskQueue.js) validates only the outer snapshot, then normalizes each task without schema or uniqueness validation. Mutations resolve the first match through `getTask()` at [`taskQueue.js:143`](../../system/server/src/taskQueue.js).

**Impact:** Corruption, a migration mistake, or external snapshot tooling can create two active owners under one task identity. Cancellation/result reporting targets only the first match, while task-keyed worker coalescing may leave the second running record without a worker.

**Required handling:** Fully validate every loaded task and reject duplicate IDs before restoring leases or dispatching. Quarantine an invalid snapshot with a clear startup diagnostic; do not partially normalize or run it.

**Acceptance:** A duplicate ID snapshot starts no worker and acquires no device lease. The diagnostic names the duplicate ID and snapshot path. Cover null/malformed records and impossible state/selector combinations in the same validator.

### 9. [P2] Anonymous signup can grow durable account and audit storage without bound

**Reproduction:** Four rapid anonymous applications with unique Gmail addresses and usernames all returned `201` and were persisted. [`index.js:144`](../../system/server/src/index.js) creates the durable account and audit event with no source, address, queue-size, or global throttle.

**Impact:** An unauthenticated client can fill `operators.config.json`, the audit log, and the Admin review surface. Unique identities bypass duplicate checks and impose password-hashing cost on every request.

**Required handling:** Add source/global rate limits, a bounded pending-application capacity, and stale-pending cleanup. Return a stable generic receipt without confirming whether an identity already exists. Keep password hashing behind the cheapest safe abuse checks.

**Acceptance:** A burst reaches `429` or bounded backpressure, pending records cannot exceed the configured cap, restart does not erase the limit, and legitimate applicants receive a clear retry time.

### 10. [P1] Lost AI-command responses can create duplicate tasks, while the UI erases the original command

**Evidence:** `/cresearch` is a mutating queue command, but [`runAdminCommand`](../../system/client/app.js) calls `requestJson` at [`app.js:2044`](../../system/client/app.js) without the existing `uncertain` mode or an idempotency key. If the server queues the task and the response is lost, the client says the change was not confirmed. The AI chat then clears its input after every result at [`app.js:3225`](../../system/client/app.js), even when `runAiWorkspaceCommand` returned false.

**Impact:** An Admin/Manager cannot tell whether research started, loses the exact command, and may reconstruct and resubmit it. That can queue two AI tasks for the same goal and cause later duplicate device work.

**Required handling:** Give every mutating command a client request ID and make queue admission idempotent for that operator/request. On network loss, retain the input, show an uncertain result, refresh the queue by request ID, and enable retry only after reconciliation.

**Acceptance:** Drop the response after durable task creation. The UI retains the command, finds the created task on reconciliation, and a retry returns the same task rather than creating a second one.

### 11. [P2] Research review bypasses the shared timeout and safe error handling

**Evidence:** [`research.js:19`](../../system/client/research.js) calls `fetch` directly and always parses JSON. It does not use the timeout, invalid-response handling, typed network errors, or consistent copy in [`app.js:172`](../../system/client/app.js). All five roles can reach research review when granted the capability.

**Impact:** A relay timeout, proxy HTML error, empty response, or lost connection can leave the panel waiting indefinitely or show technical messages such as JSON parser errors. Reviewers do not learn whether a submitted Confirm/Remove decision was saved.

**Required handling:** Move the shared request helper into a client module available to both scripts. For review mutations, preserve the intended choice, mark the result uncertain on transport loss, reload authoritative candidate state, and offer Retry only if the saved state differs.

**Acceptance:** Timeout, offline, non-JSON `502`, `401`, and response-loss-after-save fixtures all end visibly with plain guidance. A saved review is never resubmitted merely because its response was lost.

## Recommended coding order

1. Fix authentication boundaries: findings 1, 2, 7, and 9.
2. Enforce the intended 2FA policy for created users: finding 3.
3. Separate physical action completion from frame refresh and add command idempotency: findings 6 and 10.
4. Validate the complete persisted queue before lease restoration: finding 8.
5. Restore normal role workflows and fail-closed recovery: findings 4 and 5.
6. Route Research through the shared client request contract: finding 11.

## Minimum regression coverage

- Login: layered wrong-password limits and a 2FA attempt counter that survives challenge replacement and parallel sessions.
- Account lifecycle: Admin-created users of every role follow the chosen 2FA policy; malformed persisted status fields fail closed.
- Signup: source/global burst limits, restart persistence, pending queue capacity, and non-enumerating responses.
- Assignments: every selectable assignee role can perform its allowed progress transitions through UI and API.
- Network UI: fail-closed missing, stale, failed, passed, timed-out, and access-revoked checks.
- Device input: input succeeds while render fails for tap, swipe, Home, and text; each produces an applied-but-unverified result without replay.
- Queue recovery: duplicate IDs, malformed records, impossible states, and zero lease/worker activity after validation failure.
- AI commands and research review: response lost after commit, idempotent reconciliation, preserved input, invalid JSON, timeout, and authentication expiry.
