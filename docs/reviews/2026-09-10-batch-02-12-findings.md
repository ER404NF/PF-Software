# Code review — second batch of 12 findings

Date: 2026-09-10. Reviewed the current uncommitted working tree, including the fixes from the preceding batch. These are twelve additional findings, not a relisting of that batch.

The existing full suite passed **405/405 tests**. Additional checks used disposable loopback relays, temporary storage, real application modules with injected device/model fixtures, and source functions executed in a Node VM. No physical device, live model provider, or full browser was used. Application source was not edited by this review.

## 1. [P1, conditional configuration] A device named `sessions` exposes authentication storage through media uploads

Location: [fileStore.js:45](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/fileStore.js:45>); default session directory at [index.js:40](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/index.js:40>).

Media lives directly at `storage/<deviceId>`, while authentication sessions live at `storage/sessions`. `sessions` is accepted as a device ID, and the device loader does not reserve internal directory names. The media authorization check consequently permits an operator assigned that phone to replace session files through the ordinary upload route. Cookie signing does not protect the contents of a server-side session file.

Evidence: reproduced with an injected device named `sessions` and the default relative storage layout redirected to a temporary root. A VA held two legitimate sessions and used one to upload a replacement for the other session's record. The other session's request to `/api/queue` changed from HTTP **403 to 200**. All users, cookies, and files in the reproduction were disposable fixtures.

Condition: requires this colliding device ID and shared media/internal-storage layout; this is not a claim that a currently configured production device has that name.

Fix direction: put device media under a dedicated namespace such as `storage/devices/<id>` and keep all authentication/configuration/audit state outside it. Validate directory separation at startup and reject reserved or colliding IDs. Consider the other internal directory names as well.

## 2. [P1] The action policy validates the action name but not the control actually tapped

Location: [createAccessibilitySkill.js:68](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/platformSkills/createAccessibilitySkill.js:68>).

The platform skill adds arbitrary model-supplied `decision.target` text to its candidate selectors. A read-only navigation action such as `open_profile` can therefore select a Like button. The policy layer approves `open_profile`; it never verifies that the chosen element belongs to that operation. Post-action verification cannot undo a disallowed interaction already sent to the device.

Evidence: enabled `open_profile`, disabled `like`, and supplied `action: open_profile, target: Like` to the real policy and Instagram skill. On a fixture tree containing both controls, the selected target was **Like**, and the device received its coordinates `(0.15, 0.125)`.

Fix direction: resolve controls through action-specific, constrained selectors. Treat model target text as a hint within an allowed semantic category, never as authority to tap any matching element. Reject mismatches before sending input.

## 3. [P1] Input remains enabled while switching devices

Location: [app.js:622](<C:/Users/404de/Desktop/PHONE FARM/system/client/app.js:622>), input gate at [app.js:711](<C:/Users/404de/Desktop/PHONE FARM/system/client/app.js:711>).

Selecting B while controlling A changes `pendingDeviceId` but retains A's image and active controls. The click handler checks `currentDeviceId` and `busy`, not the pending selection. It can send a tap based on A's still-visible image after sending `select_device B`. The server serializes those messages, claims B, and applies the unscoped tap to B.

Evidence: executed the actual selection and click functions in a VM. With A's image still current and B pending, the client emitted `select_device B` followed by a tap containing coordinates but no device identity. This matches the server's selected-device routing.

Fix direction: disable input throughout pending selection and restore it only after the selected device is confirmed. Include the intended device ID/selection generation in action messages, and reject stale input on the server.

## 4. [P1] Graceful handoff grants human input when its timer expires, even if AI input is still pending

Location: [deviceLease.js:104](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/deviceLease.js:104>).

`switchToHuman` races the action against a timeout, clears the pending reference, and enters `HUMAN` regardless of which promise won. The outstanding device action is not cancelled or resolved. The new AI-task drain fix correctly retains ownership until settlement, but this handoff path still permits overlapping control.

Evidence: registered an unresolved AI action and called handoff with a short test timeout. Handoff completed with `canHumanSelect === true` while the action was still unresolved. The production default handoff timeout is 5 seconds; WDA requests can remain pending longer.

Fix direction: on timeout, revoke new AI submissions but retain an unavailable/recovery state until the already-submitted action is safely resolved. A control-plane timeout alone must not establish that physical input has stopped.

## 5. [P1] Emergency stop waits behind unrelated device input

Location: [index.js:978](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/index.js:978>), emergency handler at [index.js:1102](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/index.js:1102>).

All WebSocket messages enter the same per-connection action queue, including emergency stop. If an admin is waiting on a slow human-device action, an emergency stop for a different AI-controlled device does not reach the lease revocation code until the first action finishes.

Evidence: held a tap on human device D pending, then sent emergency stop for AI device A on the same authenticated admin socket. A stayed `AI_RUNNING`; only releasing D's pending tap allowed A to become `HUMAN`.

Fix direction: process authenticated emergency revocation through a separate immediate control path. Preserve role/device/session checks, but do not queue revocation behind ordinary device work.

## 6. [P1] Task-scoped model changes omit research-workspace authorization

Location: [index.js:666](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/index.js:666>).

The new `taskAccessError` checks both device access and research-account ownership for queue mutations. The task-scoped `/model set` branch does not use it: it checks only an assigned device ID. An admin who can access that device but lacks the task's research workspace can still change the task's model provider. Undispatched tasks with no device ID receive even less checking.

Evidence: a fixture admin with device access but no grant to workspace W received HTTP **400** when changing the research task's priority, but **200** when changing its task-scoped model provider. The stored model selection changed.

Fix direction: use the same complete task authorization before provider changes. Provider selection affects where research observations are processed and should not bypass account/workspace isolation.

## 7. [P1] Revocation during observation does not stop the model submission

Location: [researchWorker.js:67](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/researchWorker.js:67>).

The worker checks authorization before awaiting capture, then sends the captured content to the model without checking again. If device/account permission is revoked while the observation call is pending, the model still receives the data. Later checks prevent physical input, but happen after the disclosure boundary.

Evidence: a fixture device revoked authorization while completing `getUiTree`. The model callback was nevertheless invoked once with the observation; the step only subsequently returned `FAILED_FINAL`.

Fix direction: recheck live authorization, task ownership, and deadlines after capture and before calling the provider. Apply equivalent checks at other asynchronous data-export boundaries.

## 8. [P2] Cancelling during evidence capture can still mark the research run successful

Location: [researchTaskRunner.js:152](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/researchTaskRunner.js:152>).

After a verified candidate, the runner can await `device.render()` for evidence. Cancellation during that await does not stop later candidate writes or unconditional run finalization. The guard protects the queue's success report, but not the research run's success record.

Evidence: cancelled the task during the evidence renderer callback. The queue correctly ended `CANCELLED`, but the runner appended a candidate and finalized its research run with **`outcome: SUCCEEDED`**.

Preserving already-discovered candidates may be desirable; the bug is reporting the cancelled execution as a successful run. Recheck state after awaited evidence work and finalize records with the actual terminal outcome.

## 9. [P2] Reviews diverge between content-ID and URL aliases

Location: [researchStore.js:148](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/researchStore.js:148>).

The two persisted indexes can retain different review decisions for the same content. A later ID-only observation creates an entry without the known URL. Reviewing it updates the content-ID entry, leaving the URL entry stale. The previous stale-observation fix preserves whichever index entry is found, so it does not reconcile these aliases.

Evidence: created a candidate with both content ID and URL, confirmed it, created an ID-only observation, and removed that observation. A subsequent URL-only observation inherited **confirmed**, despite the latest human decision being **removed**.

Fix direction: preserve a canonical shared identity/review record and point every known alias at it. Updating a review must update all aliases and retain known identifiers.

## 10. [P2] Duplicate observations discard updated metrics

Location: [researchStore.js:153](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/researchStore.js:153>).

`mergeCandidate` updates `last_seen_at`, tags, and evidence, but never merges or stores new metrics. A newer observation's metrics disappear while the candidate's timestamp advances, leaving no way to recover the newer snapshot.

Evidence: created a candidate with `likes: 10` and appended the same content with `likes: 100`. The returned record still contained **10**.

Fix direction: define and implement latest-metrics replacement or durable timestamped metric observations. Do not silently discard fresh measurements while advancing the observation timestamp.

## 11. [P2] Changing any model selection reintroduces inherited property lookups

Location: [modelSelection.js:40](<C:/Users/404de/Desktop/PHONE FARM/system/server/src/modelSelection.js:40>).

The initial scope dictionaries correctly use null prototypes. `set()` clones them with object spread into ordinary objects. Subsequent `resolve()` calls read inherited properties for otherwise valid IDs such as `constructor` or `toString`, returning a function instead of a provider name and masking the configured default.

Evidence: configured a valid provider and made a global selection. Resolving the provider for device ID `constructor` returned **a function**, not the selected provider string. The accepted device-ID format permits that ID.

Fix direction: preserve null prototypes during updates, use `Map`, or require own-property membership for every scoped lookup. Validate that resolution returns a configured provider name.

## 12. [P2] Session expiry leaves the browser in an unauthenticated reconnect loop

Location: [app.js:305](<C:/Users/404de/Desktop/PHONE FARM/system/client/app.js:305>).

The server now closes invalid/expired sessions with code 1008, but the client treats every non-explicit logout as a network failure and schedules another connection. It does not recheck `/api/me` or return to the login form. Every following handshake fails while the application remains on the reconnecting screen.

Evidence: executed the actual connection handler with a `1008 / Session is no longer active` close event. It scheduled reconnection and did not show login. The behavior is directly connected to the current server's session-expiry close path.

Fix direction: distinguish authentication closure from transient connection loss. Revalidate the session and show login when authentication has expired, while retaining bounded reconnect behavior for network failures.

## Verification limits

The first finding depends on a colliding configured device name and matching storage roots; it is not an assertion about the current device inventory. The third and twelfth findings were exercised with source-function/DOM substitutes rather than a real browser. The other reproductions used application modules and isolated fixtures, not physical phones or live provider requests. These are code defects and edge cases, not reports of production incidents.

No application changes were made. This report is the review artifact; the user's existing changes and test-result files were preserved.
