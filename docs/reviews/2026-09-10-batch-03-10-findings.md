# Code review — batch 3, 10 findings

Reviewed the current PHONE FARM source on 2026-09-10. Request changes for the failures below. These are locally demonstrated edge cases, not reported production incidents. The existing suite passed **421/421**. No application source was modified.

Reproduction: from the repository root, run `node docs/reviews/batch03-probes.mjs`. Nine checks call the actual modules with isolated fixtures; check 9 executes the actual server/client function bodies in VM contexts. All fixture writes go to unique OS temporary directories. No physical phones, external providers, or live sessions were used. The probe asserts the current defective behavior; it is a diagnostic artifact, not a passing regression suite for the desired behavior.

## 1. [P1] A late session touch restores a logged-out session

Source: `system/server/src/fileSessionStore.js:65-76,96-109`.

An authenticated request still finishing when `/api/logout` destroys its session can subsequently call `touch`. This delegates to `set`, which writes and renames the old authenticated data without checking whether the session was destroyed. Already-started writes can also rename after `destroy` returns. The current WebSocket invalidation closes existing sockets, but does not prevent HTTP authentication or a new socket using the resurrected session ID.

Probe 1 delays the touch rename, destroys the session, releases the rename, and reads back the authenticated operator. Fix with per-session revocation/generation tracking and serialized operations; a stale touch or write must not recreate a revoked ID. Account for writes initiated after destruction by requests that already loaded the session.

## 2. [P1] Read-only navigation can select a publishing button

Source: `system/server/src/platformSkills/createAccessibilitySkill.js:68-75`; `accessibilityTree.js:80-88`; `instagramSkill.js:24`.

Removing model-supplied selector text did not make the static selectors safe. `open_comments` permits the substring `comment`, and the first framed matching element wins regardless of role or whether it publishes. A screen with a draft and a `Post comment` button before `View comments` selects the publishing button. `open_post` has the analogous broad `post` match.

Probe 2 executes the actual Instagram skill and records `targetText=post comment`, tap `(0.2,0.1)`. Use action-specific control identifiers/roles and explicit disambiguation; do not execute when navigation cannot be distinguished from mutation. This is a different remaining selector path from the previous model-target expansion finding.

## 3. [P1] Content bounds are used as the device viewport

Source: `system/server/src/platformSkills/accessibilityTree.js:92-101`.

`normalizedCenter` divides coordinates by the maximum extent of every framed node. Accessibility scroll containers can extend beyond the actual screen. A 100×200 viewport with a 2,000-high content container turns a target centered at y=100 into normalized y=0.05 rather than 0.5. WDA then taps a different physical location.

Probe 3 demonstrates this exact displacement. Normalize against the explicit screen/window viewport or adapter dimensions, and reject targets outside that viewport instead of clamping them onto the screen.

## 4. [P2] JSON accessibility trees select hidden and disabled controls

Source: `system/server/src/platformSkills/accessibilityTree.js:21-35`.

The XML path filters `visible=false` and `enabled=false`; the supported JSON path ignores both flags. An invisible, disabled `Profile` element preceding the usable `Profile` control is selected and tapped. This is conditional on a JSON tree carrying visibility/enable metadata, rather than the default XML WDA response.

Probe 4 selects the hidden node from a JSON tree. Apply equivalent eligibility rules across both formats and account for hidden ancestors. This is independent of substring disambiguation: both fixture labels are exact matches.

## 5. [P1] A challenge encountered after navigation triggers another input

Source: `system/server/src/platformSkills/createAccessibilitySkill.js:83-84,103-106`; `system/server/src/platformSkill.js:79-84`.

When the post-action observation detects a security challenge, verification returns ordinary `false`. The generic execution boundary immediately calls recovery, which presses Home. The worker subsequently treats this as a retryable failure rather than entering `NEEDS_HUMAN`. The model's pre-action screen classification cannot catch a challenge that appeared as a result of the action.

Probe 5 supplies a security-code screen after a scroll and records `FAILED_VERIFICATION` plus one Home press. Propagate an explicit challenge outcome to the worker, stop automatic recovery input, and preserve the challenge screen for the operator. This matches the pause requirement in `docs/FUTURE_AI_VA_SPEC.md:235-237`.

## 6. [P1] Revocation during execution still allows evidence writes and new reads

Source: `system/server/src/platformSkills/createAccessibilitySkill.js:51-54`; `system/server/src/platformSkill.js:74-78`.

The execution boundary checks authorization before `skill.execute`, but never checks again before `observeAfter`. Screenshot execution also saves the result of an awaited render without a fresh check. If access is revoked during render, the old worker writes protected evidence and initiates a further device observation after revocation. Worker ownership checks after the whole step cannot undo those operations.

Probe 6 revokes authorization inside render and records one evidence write, one subsequent observation, and `VERIFIED`. Recheck authorization after awaits and immediately before new reads or durable evidence writes. Do not start verification observation once ownership/access has been revoked. This concerns post-execution boundaries; the previous pre-provider revocation fix is present.

## 7. [P2] Cancellation between steps leaves an existing research run unfinished

Source: `system/server/src/researchTaskRunner.js:87-97,107-123`.

After a candidate creates a run, an ordinary cancellation during the inter-step delay makes the next loop return immediately. No finalizer records the run's cancellation or completion time. Expiry and failure exits have similar gaps. The recent cancellation-during-evidence fix finalizes only its own branch.

Probe 7 creates and records a candidate, cancels during the next delay, and receives `CANCELLED` with one run created and zero finalizer calls. Centralize finalization for an existing run when the worker exits permanently; retain it across a temporary pause or retry as appropriate.

## 8. [P1] A failed stop snapshot leaves contradictory task and lease states

Source: `system/server/src/taskQueue.js:253-263`.

`stopDevice` marks the live task CANCELLED, then persists, and only afterward releases the device. On ENOSPC or another write failure, it throws with the live task CANCELLED, the lease still AI_RUNNING, and the durable task still RUNNING. The worker sees cancellation and stops; the scheduler cannot reuse the lease. Restart recovery sees the stale running snapshot instead of the cancellation.

Probe 8 injects ENOSPC only for the disposable queue snapshot and verifies this combination. Make the stop failure path internally consistent: revoke/drain safely even if persistence fails, and explicitly handle the durable-state failure. Avoid leaving a terminal live task owning an active lease. A subsequent successful stop can recover the lease, but the original operation has already failed inconsistently.

## 9. [P2] A transient device error hides the release control without releasing ownership

Source: `system/client/app.js:292-293,696-710`; `system/server/src/index.js:912-921`.

The first failed action/render sends an error while the server intentionally retains selection and ownership. The client handles that same error by clearing its current device and hiding Release. It sends no `release_device` message, so the fleet still shows the phone occupied and another operator cannot claim it. The original operator must reselect, switch devices, or disconnect to recover.

Probe 9 runs the actual error funnel and deselect function bodies: server status remains `in-use`; client selection becomes null; no release message is sent. Keep selection with a retry/release affordance for transient errors, or explicitly release ownership when abandoning the client selection. This check uses VM stubs, not a rendered-browser interaction test.

## 10. [P1] Emergency stop permits a new owner before old physical input drains

Source: `system/server/src/deviceLease.js:136-139`; `system/server/src/controllerMode.js:52-60`.

Emergency stop immediately changes the mode to HUMAN and discards `pendingAiAction`. A previously submitted WDA input can still be unresolved and later take effect, but `canHumanSelect` now permits another operator to claim and issue input. The new timeout handling protects graceful takeover, yet emergency stop bypasses that protection. The durable human hold blocks queued AI dispatch; it does not block a human claim.

Probe 10 registers an unresolved input promise, performs emergency stop, and confirms `canHumanSelect=true` before that promise settles. Preserve immediate control-plane revocation and acknowledgement, while retaining a separate draining/unavailable flag until outstanding physical input settles or the adapter confirms abort. This does not require delaying the emergency-stop response.

## Validation limits

The standard suite and these deterministic fixtures do not establish real WDA timing, actual platform selectors, or browser rendering. The report demonstrates executable paths and their trigger conditions. No production occurrence is claimed. Application source remained unchanged; only this report and its reproduction script were added.
