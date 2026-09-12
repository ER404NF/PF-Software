# Code review — 12 open findings

Reviewed: 2026-09-10. Scope: current working tree under `system/`, including uncommitted changes. This is a review, not a patch set. Application source was not changed by this review.

The full existing suite passed **384/384 tests** in the last run. The findings below come from additional targeted checks; a passing existing suite does not cover these cases. Hardware, live model providers, and a deployed HTTPS reverse proxy were not tested.

The workspace changed during the review. The previous rejected-upload deletion, human disconnect ownership, and stale research review-index findings received fixes. They are **excluded** from this open batch. The upload reproduction now preserved the existing file; the ownership and index fixes were checked in the final source. An older ownership probe was stopped because it assumed ownership would be released immediately, which the corrected code deliberately prevents.

## 1. [P1] Stale file responses can delete a file on the wrong phone

Location: [app.js:736](<C:/Users/404de/Desktop/PHONE FARM/system/client/app.js:736>), with deletion at [app.js:772](<C:/Users/404de/Desktop/PHONE FARM/system/client/app.js:772>).

`refreshFiles()` sends a request using the current device, but neither captures that identity for rendering nor rejects stale responses. The generated links and delete callbacks use the later value of `currentDeviceId`.

Trigger: start loading A's files, switch to B, let B's response finish, then let A's older response arrive. The displayed filename comes from A while download/delete requests target B. If B contains that filename, the operator deletes B's file while looking at A's stale row.

Evidence: executed the actual file-list functions in a Node VM with a small DOM fixture and controlled response ordering. The row displayed `a-private.txt`, its download URL was `/api/devices/b/files/a-private.txt`, and clicking delete issued `DELETE /api/devices/b/files/a-private.txt`.

Fix direction: capture device identity and a request generation at fetch time, discard stale responses, and bind each row's actions to its originating device. Invalidate pending file responses on deselection and logout.

## 2. [P1] Queue cancellation bypasses restricted-admin device authorization

Location: [index.js:611](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/index.js:611>).

The `/queue cancel <taskId>` branch calls `cancelTask` without authorizing the task's device. The equivalent `/stop <deviceId>` operation performs a device authorization check. An admin restricted to other phones can therefore cancel an active task on an inaccessible phone by using its task ID.

Evidence: against a disposable local relay, an admin whose `allowedDevices` excluded the target received HTTP `400` for `/stop <target>`, but HTTP `200` for `/queue cancel <target-task>`. The target task changed to `CANCELLED`.

Fix direction: resolve and authorize the task before mutation. Apply consistent task/workspace/device rules to cancellation, priority changes, and reordering; global queue visibility alone should not imply permission to control every device.

## 3. [P1] Research execution does not recheck the creator's device permission

Location: [researchTaskRunner.js:63](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/researchTaskRunner.js:63>).

The live authorization callback checks research-workspace access only. A task retains its device allow-list from admission, and the worker never checks the current operator's `allowedDevices` before observation or input. Removing device permission while leaving workspace access intact does not revoke research control. The same stale allow-list can survive a restart with changed operator configuration.

Evidence: ran the real queue, runner, and worker with injected device/provider fixtures. The operator initially had `allowedDevices: ['d']`; planning changed it to `[]`. The worker still executed one swipe and completed the task as `SUCCEEDED`.

Fix direction: combine current device authorization with current workspace authorization at dispatch, before observation, and at the final execution boundary. Do not use the persisted admission allow-list as the sole authority.

## 4. [P1] AI task cancellation redispatches before pending device input settles

Location: [taskQueue.js:192](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/taskQueue.js:192>).

`cancelTask` releases the device mode and immediately tries to dispatch the next task. It never drains the pending AI action tracked by `deviceLease`. Lease tokens prevent a stale task from starting later actions, but cannot stop an action already submitted to the device.

Evidence: registered an unresolved pending action for the first task and queued a second task. Cancelling the first immediately made the second `RUNNING` and the device `AI_RUNNING` while the original action remained unresolved. This allows a new worker to submit input over the old action.

Fix direction: revoke new input immediately, but keep the device unavailable to another worker until the existing atomic action settles or explicit recovery resolves its outcome. Apply the same invariant to stop and time-window expiry, which also release and redispatch.

## 5. [P1] Screenshot cropping makes browser taps target different coordinates

Location: [style.css:259](<C:/Users/404de/Desktop/PHONE FARM/system/client/style.css:259>).

Screenshots are forced into a `300px × 534px` box with `object-fit: cover`. Different screenshot aspect ratios are cropped. The click handler normalizes the visible box as though it represented the entire image, so the server receives coordinates for a different point on the phone.

Evidence: source and coordinate calculation for a 390×844 screenshot. At 10% of the displayed height, the visible point corresponds to source y≈144.32, but the client/server mapping sends y=84.4. The mismatch does not require a failed WDA request or rotation.

Fix direction: preserve the image aspect ratio and normalize against the actual image content rectangle. If cropping or letterboxing is intentional, account for its scale and offsets explicitly.

Validation limit: this was a calculation against the current CSS and click mapping, not a physical-device or browser screenshot test.

## 6. [P2] Screenshot fallback fails inside every shared accessibility skill

Location: [createAccessibilitySkill.js:22](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/platformSkills/createAccessibilitySkill.js:22>).

`captureObservation` supports screenshot fallback when a UI tree is unavailable. However, the shared platform skill unconditionally requires readable accessibility text in `detectState`, including for a passive `observe` decision. A valid screenshot-based model decision therefore fails before execution. Recovery can press Home despite the original action being read-only observation.

Evidence: ran the real worker with a device exposing a valid screenshot and no UI tree, a valid high-confidence `observe` decision, and the real Instagram skill. The provider received `source: screenshot`; the step returned `FAILED_RETRYABLE` with `instagram accessibility tree contained no readable elements`, pressed Home once, and exhausted the default retry policy into `FAILED_FINAL`.

Fix direction: support passive screenshot observations without requiring accessibility selectors. For navigation that cannot be grounded without a tree, use an explicit supported fallback or human handoff rather than automatic Home recovery.

## 7. [P2] WDA coordinates stay in the old orientation

Location: [wdaDevice.js:47](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/wdaDevice.js:47>).

`ensureWindowSize` caches the window dimensions until a request fails. A successful rotation or app-induced orientation change does not invalidate them. Subsequent normalized taps and positioned swipes use the old dimensions.

Evidence: a local HTTP WDA fixture initially reported 390×844 and then 844×390 in the same session. Two center taps caused only one size request. The second tap was `{x:195,y:422}` instead of `{x:422,y:195}`.

Fix direction: refresh dimensions when transforming input, or reliably invalidate the cache on an observed viewport/orientation change. Keep screenshot geometry and input geometry consistent.

## 8. [P2] A screenshot-capture action can verify without capturing anything

Location: [createAccessibilitySkill.js:45](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/platformSkills/createAccessibilitySkill.js:45>).

`capture_screenshot` is grouped with passive observation and returns an observation marker without calling the device renderer. Verification returns true for the same action. When accessibility data is available, both observation passes use the tree, so neither captures an image. The runner saves evidence only when a candidate is present, making a standalone screenshot action a successful no-op.

Evidence: ran `runResearchStep` with an available UI tree, the real Instagram skill, an allowed `capture_screenshot` decision, and a renderer counter. Result: `VERIFIED`, with **zero** screenshot calls.

Fix direction: implement capture as an actual image acquisition and durable evidence operation, return its reference, and verify that artifact. Do not report capture success based only on a UI-tree read.

## 9. [P2] The task duration limit is never enforced

Location: [taskQueue.js:501](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/taskQueue.js:501>); accepted field at [taskSpec.js:105](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/taskSpec.js:105>).

TaskSpec accepts and persists `maxDurationSec`, but the scheduler only expires tasks using `latestEnd`. A duration-limited task without a wall-clock end can keep running indefinitely, and a shorter duration cap inside a larger time window is also ignored.

Evidence: created and dispatched a task with `maxDurationSec: 1`, advanced the scheduler to 60 seconds after dispatch, and observed that the task remained `RUNNING`.

Fix direction: validate and enforce a durable execution deadline derived from the duration policy. Define pause/retry accounting explicitly and prevent late worker actions from crossing that deadline.

## 10. [P2] A truncated audit log swallows the first new event

Location: [auditLog.js:25](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/auditLog.js:25>).

The reader skips malformed lines, but the writer assumes the existing file ends with a newline. After a crash leaves a partial final JSON record, the next successful event is appended directly to it. Both fragments then occupy one malformed line, so the valid new event disappears from reads.

Evidence: seeded a temporary log with an incomplete JSON fragment, called `logEvent`, and then `listEvents`. The write returned a new event ID, but the readable event count was zero.

Fix direction: recover the append boundary before writing after restart—preserve or quarantine the torn tail and start the next record on a new line. Verify the first post-restart event survives.

## 11. [P2] The active-task display can show a cancelled task

Location: [app.js:340](<C:/Users/404de/Desktop/PHONE FARM/system/client/app.js:340>).

`fetchActiveTasksByDevice` places every task into the same per-device map without filtering its state. Later historical or queued entries overwrite the actual running task. Fleet cards can show an unrelated goal or cancelled state while AI is actively controlling the phone.

Evidence: executed the actual function with a running task followed by a cancelled task for the same device. The returned map selected the cancelled task.

Fix direction: select the current lease-holding task (`RUNNING`/`PAUSED`) explicitly. Show queued work separately rather than depending on queue array order.

## 12. [P2, HTTPS deployment] Browser control always opens an insecure WebSocket

Location: [app.js:262](<C:/Users/404de/Desktop/PHONE FARM/system/client/app.js:262>).

The socket URL always begins with `ws://`. Serving the UI through HTTPS does not change it to `wss://`, so the browser's mixed-content restriction prevents the control connection to a normal non-localhost HTTPS deployment.

Evidence: executed the actual `connect()` function in a VM with `location.protocol: 'https:'` and host `phones.example`; it constructed `ws://phones.example`. The current code never examines the page protocol.

Fix direction: choose `wss:` for HTTPS and `ws:` for HTTP, preserving the host and port. Validate through the intended reverse-proxy setup.

Validation limit: URL construction was reproduced; a deployed TLS proxy and real browser mixed-content failure were not exercised. This does not affect the current plain-HTTP local pilot.

## Evidence boundaries and suggested order

The HTTP findings used disposable loopback relays, test-only operators/devices, and isolated session/audit/queue data. Worker, scheduler, and WDA checks used real application modules with local fixtures. Browser-function checks executed source functions in a Node VM with controlled DOM/network substitutes, not a full browser.

Address the wrong-device file operation and both authorization gaps first, followed by atomic-action ownership and coordinate mapping. Then repair screenshot behavior, duration enforcement, audit recovery, and display/deployment issues. Add focused regression tests for these triggers rather than treating the existing 384 passing tests as coverage of them.
