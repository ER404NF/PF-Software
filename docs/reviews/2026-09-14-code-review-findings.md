# PHONE FARM code review findings

**Date:** 2026-09-14  
**Scope:** Current dirty `system/` working tree, with emphasis on the new WDA live-view path and the surrounding authentication, authorization, queue, persistence, and physical-device integration boundaries.  
**Verification:** `npm.cmd test` from `system/`: **529 passed, 0 failed**. `git diff --check`: no whitespace errors. No physical iPhone, live WDA, email provider, proxy route, or deployed HTTPS environment was available in this Windows review.

## Result

This pass found **24 actionable issues: 15 P1 and 9 P2**. Passing tests do not cover the adversarial timing, persistence-failure, multi-team, deployment, and malformed-configuration cases below.

| # | Priority | Finding |
|---|---|---|
| 1 | P1 | A revoked controller can still execute input after asynchronous WDA preparation. |
| 2 | P1 | Live screenshots race the shared WDA session state. |
| 3 | P1 | Live-frame failure handling can mutate a device after ownership or authorization changed. |
| 4 | P1 | The live-frame protocol has no server-side cadence limit. |
| 5 | P2 | Optional live-view failures poison global device health and release ownership. |
| 6 | P1 | A grant revoked during a multipart upload does not stop the final file commit. |
| 7 | P1 | Manager queue access is device/account scoped but not team scoped. |
| 8 | P1 | The `/audit` command bypasses the device filtering used by the audit API. |
| 9 | P1 | People summaries disclose other users' assignment metadata. |
| 10 | P1 | Recovery requests are unthrottled and invalidate earlier recovery tokens. |
| 11 | P1 | Plaintext recovery tokens are retained in the notification store. |
| 12 | P1 | Account review, notification creation, audit, and session revocation are non-atomic. |
| 13 | P1 | Username rename is non-atomic across operator and assignment stores. |
| 14 | P1 | Username rename leaves queued tasks owned by a nonexistent principal. |
| 15 | P1 | Several queue mutations publish live state before durable persistence succeeds. |
| 16 | P1 | Background scheduler persistence errors can terminate the relay process. |
| 17 | P1 | Duplicate physical-device identities can create two independent leases for one iPhone. |
| 18 | P2 | Unknown device types silently become mock phones. |
| 19 | P2 | Malformed WDA host/port settings survive startup. |
| 20 | P2 | Configured WDA phones are advertised available before any health probe succeeds. |
| 21 | P2 | WDA window dimensions are trusted without validation. |
| 22 | P2 | Daily and weekly assignments drift across daylight-saving changes. |
| 23 | P2 | Session storage masks I/O corruption and grows tombstones indefinitely. |
| 24 | P2 | Network/deployment error paths expose avoidable attack and information-leak surfaces. |

## Findings and fixes

### 1. [P1] A revoked controller can still execute input after asynchronous WDA preparation

The WebSocket handler checks the current grant and ownership at `index.js:2272-2282`, then calls `selected.tap()` at `index.js:2293-2294`. `WdaDevice.tap()` awaits session creation and window-size lookup before it sends the physical tap at `wdaDevice.js:69-78`. A role/grant/lease change during either await does not prevent the final WDA request. The same class of gap exists for positioned swipes and other adapter methods that perform preparation before the action.

**Fix:** pass a live authorization/lease guard into the adapter operation and invoke it after every await and immediately before the mutating fetch. Bind the check to the selected device, owning socket, and lease generation. Add a delayed-session test that revokes the grant before the WDA tap endpoint is reached and asserts that no tap arrives.

### 2. [P1] Live screenshots race the shared WDA session state

`handleLiveFrame()` deliberately runs outside `actionQueue` at `index.js:1946-1971`. The adapter stores a mutable `sessionId`, but `ensureSession()` has no shared in-flight promise at `wdaDevice.js:31-43`. A custom client can request a live frame while the initial selection frame is creating a session, or a live refresh can race input after a session invalidation. Both calls can create sessions, overwrite `sessionId`, and issue later requests against different sessions.

**Fix:** serialize operations per physical WDA adapter, or at minimum coalesce session creation with one `sessionPromise` and protect invalidation with a generation token. Preserve input priority by scheduling screenshots as cancellable, lower-priority reads rather than allowing uncontrolled transport concurrency. Test concurrent `render()` and `tap()` from a sessionless adapter and require exactly one session creation.

### 3. [P1] Live-frame failure handling can mutate a device after ownership or authorization changed

The success branch revalidates the session, selection, grant, owner, lease, and network policy after `render()`. The catch branch at `index.js:1988-1999` only checks object identity and socket state before incrementing failures, sending details, marking the device offline, and releasing the current selection. A grant, role, lease, or network-policy change during the screenshot can therefore let a stale failure affect current global state.

**Fix:** perform the same post-await session and `selectedAccessActive(target)` validation before failure accounting or response delivery. Associate health results with an operation/ownership generation so an old request cannot alter a newly claimed device.

### 4. [P1] The live-frame protocol has no server-side cadence limit

`liveFramePending` at `index.js:2394-2404` prevents overlap on one socket but imposes no minimum interval. A custom authenticated controller can send the next request immediately after each response, driving continuous screenshots, base64 encoding, JSON serialization, and watcher fan-out much faster than the one-second browser setting.

**Fix:** enforce a per-device and per-operator token bucket or monotonic next-allowed timestamp on the server. Return a stable throttled response, cap concurrent screenshots globally, and collect size/rate metrics. Test a burst client and prove the WDA screenshot rate stays bounded.

### 5. [P2] Optional live-view failures poison global device health and release ownership

Every failed live screenshot calls the same `recordFailure()` used for control failures and, after three failures, marks the phone offline and releases the user at `index.js:1988-1999`. Enabling an optional one-Hz view can therefore eject a working controller because the screenshot endpoint alone is slow or temporarily failing.

**Fix:** separate passive-display health from control/tunnel health. A live-view failure should stop or degrade live view; only an independent health probe or a failed required control-frame operation should transition the whole device offline.

### 6. [P1] A grant revoked during a multipart upload does not stop the final file commit

Authorization is checked before `upload.single("file")` at `index.js:1159-1166`. After up to 2 GB streams to disk, the completion handler renames the staged file into the device store and audits using the old session identity at `index.js:1167-1185` without re-resolving the operator or grant.

**Fix:** after Multer completes and immediately before rename, resolve the live session/operator again and recheck media capability plus exact device access. On failure, abort the quota reservation, delete only the staging file, and return 401/403. Add a delayed-upload revocation regression.

### 7. [P1] Manager queue access is device/account scoped but not team scoped

`taskAccessError()` at `index.js:1413-1425` considers only device and research-account grants. A Manager with broad or overlapping grants can list, prioritize, move, cancel, pause, resume, or stop work created by another team's manager. This conflicts with the product rule that each manager controls only assigned team members.

**Fix:** add a server-side task-scope decision based on the current creator/assignee team, with explicit Admin override and self-created access. Apply it consistently to list and every mutation. Add two managers with shared device grants but different teams and prove cross-team reads and writes return 403.

### 8. [P1] The `/audit` command bypasses the device filtering used by the audit API

The HTTP audit route filters events through `canAccessDevice()` at `index.js:354-363`. The command implementation at `index.js:1574-1583` returns `auditLog.listEvents()` directly. A device-restricted Admin can therefore read events for unauthorized phones through `/audit` even though the REST route hides them.

**Fix:** share one audit-query function that applies capability and device filtering before limits are applied. Cover unrestricted and restricted Admins through both interfaces.

### 9. [P1] People summaries disclose other users' assignment metadata

`publicPeople()` builds `visibleAssignments` with `assignmentScopeAllowed()` at `index.js:366-385`. That checks only whether the viewer can access the referenced device/account; it does not require self, creator, or manageable team membership like `canViewAssignment()`. Because every role has `people:view`, a VA or read-only user sharing a phone can receive another person's assignment ID, device, status, and schedule.

**Fix:** filter with `canViewAssignment(item, viewer)` and return either `assignment: null` or a non-identifying busy state outside scope. Add cross-team and VA/shared-device WebSocket plus `/api/people` tests.

### 10. [P1] Recovery requests are unthrottled and invalidate earlier recovery tokens

`POST /api/recovery/request` at `index.js:242-251` has no IP, account, or delivery-rate limit. Each valid request replaces the stored digest at `authStore.js:546-565`, immediately invalidating any earlier recovery message. Anyone who knows a username or Gmail address can repeatedly invalidate the user's link and flood the future mail provider.

**Fix:** use layered IP and normalized-account throttles, retain one unexpired token instead of rotating it on every request, and queue delivery only after the durable token state succeeds. Audit only bounded, non-enumerating metadata.

### 11. [P1] Plaintext recovery tokens are retained in the notification store

`accountNotificationStore.queue()` embeds the recovery token in `body` and writes the complete body to `accounts.json` at `accountNotificationStore.js:28-51`. File mode reduces exposure but does not remove the reusable bearer secret from backups, diagnostics, or disk compromise, and no cleanup removes it after use or expiry.

**Fix:** hand the token directly to an email provider or encrypt a short-lived outbox payload with a separate key. Remove/expire the outbox entry after delivery and never expose bodies through administrative listings or logs.

### 12. [P1] Account review, notification creation, audit, and session revocation are non-atomic

The status route commits the account change first, then writes the notification, audit event, and session revocation at `index.js:548-562`. A notification or audit write failure returns 500 after the account has already changed and can skip the explicit revocation/broadcast path. The administrator cannot tell which parts occurred.

**Fix:** create a persist-first transaction/outbox record containing the account transition and required notification, then publish live operator state and revoke sessions. Make audit failure non-authoritative or include it in the same durable transaction. Return an explicit partial-delivery state only when the account change is known committed.

### 13. [P1] Username rename is non-atomic across operator and assignment stores

The rename route commits assignment references first and the operator file second at `index.js:569-590`. If the operator write fails after `assignmentStore.renamePrincipal()`, assignments reference the new username while the only login remains under the old username.

**Fix:** stage and atomically commit a combined state change, or implement rollback with tested failure injection. Do not publish either store until both durable snapshots are ready.

### 14. [P1] Username rename leaves queued tasks owned by a nonexistent principal

Rename updates assignments and the operator record, but no task-queue principal migration exists. Tasks retain `createdBy: previousUsername`; dispatch later resolves that username at `index.js:721-726`, receives no operator, and permanently fails the authorization gate.

**Fix:** migrate queued task ownership in the same rename transaction, or replace mutable usernames in durable references with immutable operator IDs. Test scheduled, queued, paused, retrying, and completed task records across rename and restart.

### 15. [P1] Several queue mutations publish live state before durable persistence succeeds

`cancelTask`, `pauseTask`, and `resumeTask` mutate the task and lease before `persist()` at `taskQueue.js:192-234`. `moveTask`, `setPriority`, global pause/resume, and checkpoint likewise mutate live structures before persistence at `taskQueue.js:343-389`. On disk failure the API throws, but memory and sometimes the physical lease remain changed while restart restores the old state.

**Fix:** construct a cloned next snapshot, persist it first, then publish memory/lease changes. Where immediate physical revocation is required, record a durable hold/error state and expose an explicit recovery condition. Add write-failure tests for every mutator, not only admission, dispatch, and selected stop paths.

### 16. [P1] Background scheduler persistence errors can terminate the relay process

The five-second timer calls `taskQueue.tick()` and `expireAssignments()` without a try/catch at `index.js:2453-2458`. Both perform synchronous filesystem writes. Disk-full, permission, or rename errors escape the timer callback as uncaught exceptions and can terminate the server, dropping every control and watch connection.

**Fix:** catch each subsystem independently, mark scheduling degraded, preserve human/AI safety holds, emit a redacted operational event, and keep serving safe read-only state. Test injected write failures during both timer operations.

### 17. [P1] Duplicate physical-device identities can create two independent leases for one iPhone

`loadDevices()` validates logical IDs but does not enforce unique UDIDs or WDA host/port endpoints at `index.js:431-445`. Two different logical IDs can point to the same physical phone. `humanOwners` and `deviceLease` are keyed by logical ID, so two operators can independently claim and send input to one iPhone.

**Fix:** validate unique logical IDs, UDIDs, and normalized WDA endpoints before adapters or lease maps are created. Refuse startup with a precise configuration error. Add duplicate-UDID and duplicate-endpoint tests.

### 18. [P2] Unknown device types silently become mock phones

Any type other than exact `wda` enters the `else` branch and creates `MockDevice` at `index.js:438-442`. A production typo such as `wdaa` produces a healthy-looking fake phone that accepts actions instead of failing startup.

**Fix:** accept only explicit `mock` and `wda` values and reject everything else. Keep mocks behind an explicit development configuration.

### 19. [P2] Malformed WDA host/port settings survive startup

`loadDevices()` passes unvalidated host, port, and timeout values to `WdaDevice` at `index.js:438-439`; the constructor interpolates them into a URL at `wdaDevice.js:20-28`. Missing ports become `http://127.0.0.1:undefined`, and invalid values are discovered only after a user claims the phone.

**Fix:** validate host as an approved local address, port as an integer in range, timeout within a bounded range, label as non-empty, and UDID as required for physical deployments. Fail startup before publishing fleet state.

### 20. [P2] Configured WDA phones are advertised available before any health probe succeeds

`WdaDevice` starts with `status = "idle"` at `wdaDevice.js:20-28`. There is no startup `/status` probe, so a stopped iProxy tunnel or WDA process appears available and can be claimed. The first failure still leaves it in use until the shared three-failure threshold is reached.

**Fix:** start physical adapters in `checking`/`offline`, probe `/status` with a timeout, and mark available only after a valid ready response. Supervise the tunnel and periodically re-probe without conflating health with ownership.

### 21. [P2] WDA window dimensions are trusted without validation

`ensureWindowSize()` assigns `body.value` directly at `wdaDevice.js:46-56`; taps multiply its fields at `wdaDevice.js:69-78`. Missing, string, zero, negative, or extreme dimensions can yield `null`/invalid coordinates or misleading success.

**Fix:** require finite positive dimensions within a sensible iOS bound before caching or using them. Reject malformed JSON with a stable adapter error and invalidate only the relevant session generation.

### 22. [P2] Daily and weekly assignments drift across daylight-saving changes

Recurring schedules advance by fixed 24-hour or seven-day millisecond intervals at `assignmentStore.js:161-176` and `assignmentStore.js:310-326`. A task scheduled for 09:00 local time becomes 08:00 or 10:00 after a DST transition.

**Fix:** store an IANA timezone plus intended local wall-clock schedule, and advance calendar days/weeks in that zone. Add Europe/Rome spring-forward and fall-back regressions, including skipped and duplicated local times.

### 23. [P2] Session storage masks I/O corruption and grows tombstones indefinitely

`FileSessionStore.get()` treats every read error and every JSON parse error as a missing session at `fileSessionStore.js:37-51`, turning permission/disk corruption into unexplained logout instead of an operational alarm. `destroy()` creates a tombstone and adds every SID to an in-memory Set at `fileSessionStore.js:107-118`; neither tombstones nor expired, never-read session files are swept.

**Fix:** suppress only `ENOENT`; surface other I/O/parse errors through the callback and monitoring. Store revocation expiry, periodically remove expired session files/tombstones, and bound the in-memory set. Add permission, corrupt-file, and cleanup tests.

### 24. [P2] Network/deployment error paths expose avoidable attack and information-leak surfaces

When `ALLOW_NETWORK_CHECK_URL_OVERRIDE=true`, `index.js:1233-1242` accepts any caller URL without scheme, hostname, redirect, or private-address validation, creating an SSRF path if the test flag reaches a real deployment. Multiple handlers also return raw `error.message`, including live frames at `index.js:1991-1992`, network checks at `index.js:1277`, and upload middleware at `index.js:1684-1689`. The server permits a known default session secret and omits a secure cookie at `index.js:80-93`, while `server.listen(PORT)` at `index.js:2443-2447` does not explicitly bind loopback.

**Fix:** remove caller URL overrides from production builds or constrain them to an explicit loopback test allowlist with redirects disabled. Map internal failures to stable public codes and log redacted detail server-side. Bind loopback by default, require explicit host/TLS configuration for network exposure, fail startup without strong secrets outside an explicit development mode, and set secure cookies when HTTPS is used.

## Recommended repair order

1. Close the physical-input and upload revocation races (#1, #3, #6).
2. Serialize/rate-limit WDA live traffic and separate health domains (#2, #4, #5).
3. Repair manager/audit/people authorization scope (#7-#9).
4. Replace recovery and account lifecycle writes with throttled transactional/outbox handling (#10-#14).
5. Make all queue mutations persist-first and contain timer failures (#15-#16).
6. Validate physical-device identity/configuration and add real readiness state (#17-#21).
7. Correct recurrence, session cleanup, and deployment hardening (#22-#24).

## Test gaps to add

- Grant/session/lease revocation during delayed WDA session creation and window lookup.
- Concurrent sessionless live render plus tap; require one WDA session and deterministic ordering.
- Server-side screenshot rate limiting under custom-client bursts.
- Live screenshot-only failures that do not mark a controllable device offline.
- Grant revocation after upload begins and before staged-file rename.
- Cross-team Manager queue and People-summary isolation with overlapping device grants.
- Restricted Admin parity between `/api/audit` and `/audit`.
- Recovery throttling, token reuse/rotation, outbox cleanup, and delivery-write failure.
- Operator/assignment/task rename failure injection and restart consistency.
- Persistence failure for every queue mutation and both background timers.
- Duplicate UDID/endpoint, unknown adapter type, invalid WDA port, and WDA readiness probes.
- DST transitions for daily and weekly assignments.
- Session permission/corruption errors and expiry/tombstone sweeping.

