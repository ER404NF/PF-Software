# Role UI and error-handling audit

**Date:** 2026-09-13  
**Scope:** Admin, Manager, VA, Content Creator, and Editor roles in the current `system/` application  
**Method:** Real browser interaction against an isolated local relay with disposable users, sessions, stores, and mock phones; targeted source tracing for failures that were unsafe or impractical to trigger. No application source was changed.

## Result

The audit found **18 open role and error-handling issues: 4 P1 and 14 P2**. The most urgent problems are a failed sign-out that leaves the server session valid, an admin path that can reject the current or last active admin, and destructive account/file actions that are easy to trigger accidentally.

The current automated suite still passes **494/494**. That result does not cover the browser failure paths below. Physical phones, WebDriverAgent failures, live providers, and deployed HTTPS were not tested in this pass.

## Resolution update — 2026-09-13

All 18 findings below are addressed in the current working tree. The fixes add fail-closed local logout with persistent server-revocation retry, server enforcement for self/last-admin rejection, destructive-action confirmations, checked and retryable file deletion, one typed request/error path, state-aware phone and AI actions, per-assignment retry state, stale-presence handling, role display names, role-safe copy, and a compact sticky device control layout.

Regression coverage now includes the rejected logout and file-delete paths, the five-role phone-state presentation boundary, AI task-state controls, server action metadata, and direct self/last-admin protections. The full suite passes **499/499** after these changes. This automated result does not replace a final manual browser pass at the target viewport or deployment validation against physical devices.

## Role coverage

| Role | Surfaces exercised | Main gaps found |
| --- | --- | --- |
| Admin | Fleet, Human/AI switching, AI workspace, assignments, queue, users, files, sign-out | Self/last-admin rejection, destructive controls, invalid AI actions, stale queue copy, failed sign-out |
| Manager | Fleet, operations, assignments, team users | Self-management controls that the server rejects, misleading user-management copy, stale queue copy |
| VA | Fleet, assigned/unassigned phones, phone input, files, assignments, sign-out | AI lock message lacks a useful next step, global availability count, hidden phone controls, silent empty actions, stale presence |
| Content Creator | Read-only fleet and research review | Raw role name, inconsistent locked-phone treatment, stale research explanation |
| Editor | Read-only fleet | Disabled control still says `Open device`, raw role presentation, no clear read-only action label |

## Findings

### 1. [P1] Sign-out can fail silently and leave the session authenticated

**Evidence:** Reproduced in the browser. While signed in as a VA, the relay was stopped and **Sign out** was clicked. The page stayed signed in. After the relay restarted and the page reloaded, the same session authenticated automatically.

**Cause:** [`system/client/app.js:650`](../../system/client/app.js) closes the WebSocket, then awaits `/api/logout` before clearing the operator profile or returning to the login view. A rejected `fetch` has no `catch` or `finally`, so the local cleanup never runs.

**Required handling:** Always clear sensitive UI state and return to login in `finally`. If the server did not confirm revocation, show:

> You are signed out on this screen, but the server could not confirm session revocation. Close this browser and try again when Phone Farm is online.

Do not claim that the server session was revoked when the request failed. Add a retry path and prevent automatic authenticated recovery from hiding the failed sign-out.

**Acceptance:** Stop the relay, click Sign out, restart the relay, and reload. The user must see the login screen and must not regain an authenticated workspace without signing in again.

### 2. [P1] An admin can reject their own account or the last active admin

**Evidence:** The admin's own user card visibly includes **Reject account**. This destructive case was source-traced rather than executed. [`system/client/app.js:2452`](../../system/client/app.js) renders the button; [`system/server/src/index.js:472`](../../system/server/src/index.js) permits an admin to review any manageable user; [`system/server/src/authStore.js:439`](../../system/server/src/authStore.js) changes the account to rejected/inactive without the last-active-admin protection used by the normal account-update path.

**Required handling:** Enforce both rules on the server:

- The current session cannot reject its own account.
- The last active admin cannot be rejected, deactivated, or demoted.

Hide or disable the button when either rule applies and state why. Suggested copy:

> You cannot reject the account you are currently using.

> This is the last active admin account. Create or activate another admin first.

**Acceptance:** Direct HTTP calls as well as UI actions must return a stable conflict/forbidden response and leave the account and sessions unchanged.

### 3. [P1] Destructive account and security controls have no confirmation or change review

**Evidence:** Observed in the Admin user UI and confirmed in [`system/client/app.js:2307`](../../system/client/app.js) through the user-card handlers. **Sign out all sessions**, **Reset 2FA**, **Reject account**, and broad account changes can be submitted in one click or one undifferentiated Save operation.

**Risk:** A normal double-click, wrong-row click, or unnoticed role/grant edit can lock out a person, revoke sessions, reset authentication, or remove phone access.

**Required handling:** Before the request, show a confirmation that names the person and exact effect. Examples:

> Sign out all sessions for audit-va? They will need to sign in again on every device.

> Reset two-factor authentication for audit-va? Their current authenticator will stop working.

> Reject audit-va? Their sessions will end and they will lose Phone Farm access.

For the broad Save action, show a concise before/after change list. Disable the initiating control while the request is pending and prevent duplicate submissions.

### 4. [P1] File deletion is one click and a failed deletion looks successful

**Evidence:** Source-traced in [`system/client/app.js:2049`](../../system/client/app.js) and [`system/client/app.js:2056`](../../system/client/app.js). The file row uses an `×` button, sends `DELETE`, ignores the response status, and refreshes the list. There is no confirmation, busy state, or persistent error.

**Required handling:** Label the action **Delete**, confirm with both filename and phone, check `response.ok`, and keep the row present on failure. Suggested copy:

> Delete `brief.pdf` from Audit iPhone 1? This cannot be undone.

> `brief.pdf` was not deleted. Check your connection and try again.

### 5. [P2] A VA blocked by AI receives a vague, duplicated explanation

**Evidence:** Reproduced. The assigned phone showed both **“An authorized operations user must return this phone to Human mode.”** and **“AI-controlled — an operations handoff is required.”**, with no useful VA action. Sources: [`system/server/src/index.js:918`](../../system/server/src/index.js) and [`system/client/app.js:1511`](../../system/client/app.js).

**Required handling:** Show one role-specific message:

- **VA:** `This phone is currently controlled by AI. Contact your manager or use another assigned phone.`
- **Admin/Manager:** `This phone is controlled by AI. Open the AI workspace or return it to Human mode.`
- **Read-only roles:** `This phone is controlled by AI. You can view its status, but you cannot control it.`

Use a disabled label such as **AI in control** instead of **Open device**.

### 6. [P2] The VA availability count includes phones the VA cannot open

**Evidence:** Reproduced. A VA assigned only one of two idle Human-mode phones saw **2 Available**, although only one card could be opened. [`system/client/app.js:1162`](../../system/client/app.js) counts global idle Human phones instead of `canOpen` phones.

**Required handling:** Label the primary number **Available to you** and count `device.canOpen`. If fleet-wide idle count is useful, present it separately as **Fleet idle**.

### 7. [P2] An empty queue tells Admin and Manager that their role has no queue access

**Evidence:** Reproduced for both roles. The empty queue displayed **“Queue access is not available for this role.”** despite both roles having operations access. [`system/client/app.js:421`](../../system/client/app.js) installs that message during a prior profile state; [`system/client/app.js:2130`](../../system/client/app.js) does not restore the normal empty message from [`system/client/index.html:283`](../../system/client/index.html).

**Required handling:** Reset the empty state on every authorized refresh:

> No tasks are currently in the queue.

Reserve the access-denied message for roles that cannot open the operations surface.

### 8. [P2] Manager sees self-management actions that the server refuses

**Evidence:** Reproduced. The Manager's own card showed **Change username** and **Reject account**. Attempting the rename produced the technical server response **“a manager cannot rename their own account.”** The UI exposure comes from the person list and generic rendering; the server refusal is at [`system/server/src/index.js:503`](../../system/server/src/index.js).

**Required handling:** Keep the manager's own card for presence if needed, but omit actions they cannot perform. Prefer server-provided action metadata such as `canRename`, `canReview`, and a safe reason so the UI does not duplicate authorization rules.

### 9. [P2] AI workspace actions are enabled in impossible states

**Evidence:** Reproduced. On an AI-idle phone with no running task, **Pause**, **Resume**, and **Stop task** were all visible. Pause returned **“Error: no running task on that device.”** The suggestions are always rendered in [`system/client/index.html:175`](../../system/client/index.html).

**Required handling:** Derive controls from current task state:

- Show **Pause** only for a running task.
- Show **Resume** only for a paused task.
- Show **Stop task** only for a running or paused task.
- Keep **Return to Human** available only when the lease can safely hand off.

If state changes between rendering and the request, refresh state and say:

> This task is no longer running. The current phone status has been refreshed.

### 10. [P2] Assignment update errors are immediately erased

**Evidence:** Source-traced in [`system/client/app.js:924`](../../system/client/app.js). `updateAssignment` writes an error, then always calls `refreshAssignments`; that refresh starts by clearing the same message.

**Required handling:** Refresh only after success. On failure, retain the existing card and show the error beside that assignment with **Retry**. Keep the failed value in the editor so the manager does not need to reconstruct it.

### 11. [P2] Reassign and Cancel mutate assignments too easily

**Evidence:** Source-traced in [`system/client/app.js:829`](../../system/client/app.js). Cancel submits on one click, and changing the reassign select immediately sends the request. Controls remain active during the request.

**Required handling:** Use an explicit **Save assignee** action, require confirmation for Cancel, disable the affected card while pending, and restore the prior value if the request fails. Suggested copy:

> Cancel this assignment for audit-va? Completed work and history will remain visible.

### 12. [P2] Empty text and upload submissions do nothing

**Evidence:** Reproduced on a Human-controlled mock phone. Sending empty text and submitting Upload without a selected file produced no visible response. Sources: [`system/client/app.js:2008`](../../system/client/app.js) and [`system/client/app.js:2068`](../../system/client/app.js).

**Required handling:** Disable **Send** until text exists and disable **Upload** until a file is selected. If submission still occurs, show **Enter text to send** or **Choose a file first** in the relevant panel.

### 13. [P2] Role names expose internal enum formatting

**Evidence:** Reproduced as **CONTENT_CREATOR**. [`system/client/app.js:351`](../../system/client/app.js) uppercases the stored enum.

**Required handling:** Use a display map: **Admin**, **Manager**, **VA**, **Content Creator**, and **Editor**. Keep internal role values out of user-facing copy.

### 14. [P2] Essential phone controls, including Release, are below the fold

**Evidence:** Reproduced at a 1265×712 viewport. After opening a phone, the screen filled the visible detail area; swipe, Home, text, and **Release device** required a long page scroll. The controls follow the screen in [`system/client/index.html:142`](../../system/client/index.html).

**Required handling:** Put **Release device** in the detail header and keep a compact control bar visible or sticky. Constrain the rendered screen height to the available viewport while preserving its aspect ratio.

### 15. [P2] Presence remains Online while the relay is disconnected

**Evidence:** Reproduced. During relay outage, the connection badge changed to **Reconnecting**, but People still showed **1 online** and the VA as **Online / Active now**. The WebSocket close path at [`system/client/app.js:1078`](../../system/client/app.js) clears fleet state but does not invalidate presence.

**Required handling:** On disconnect, mark presence as unavailable or stale and show the last successful update time:

> Presence unavailable while reconnecting. Last updated 10:42:18.

Do not display a live Online label until a fresh presence message arrives.

### 16. [P2] Several network-facing forms do not handle a rejected request

**Evidence:** The logout case was reproduced; the same missing rejected-`fetch` handling is source-visible in login, assignment creation/update, and some operations commands in [`system/client/app.js`](../../system/client/app.js).

**Required handling:** Use one request helper that distinguishes HTTP rejection, invalid response data, timeout, cancellation, and network loss. Every form must disable duplicate submission, restore controls in `finally`, and keep the user's input on failure. Suggested general copy:

> Phone Farm could not be reached. Your change was not confirmed. Check the connection and try again.

For device input where completion is uncertain:

> Connection was lost while sending the action. It may have reached the phone. Wait for the screen to refresh before trying again.

### 17. [P2] Detail and AI control errors can be written into a hidden Fleet message

**Evidence:** Source-traced in [`system/client/app.js:1648`](../../system/client/app.js). A command failure outside the command console writes to `selectErrorEl`, which belongs to the Fleet section at [`system/client/index.html:130`](../../system/client/index.html). A failure triggered from the detail/AI workspace can therefore be invisible.

**Required handling:** Attach errors to the surface that initiated the action, or use a shared visible `role="alert"` notification. Keep the message until the user dismisses it or retries successfully.

### 18. [P2] Read-only and research-role guidance is inconsistent or stale

**Evidence:** Reproduced. Editor saw a disabled button still labeled **Open device** followed by **“Your role can view this phone but cannot control it.”** Content Creator on an AI phone received no comparable button. The Research panel says **“AI chat and automatic collection are not connected yet.”** even though the current product has an AI workspace and research worker. Sources: [`system/client/app.js:1520`](../../system/client/app.js) and [`system/client/index.html:344`](../../system/client/index.html).

**Required handling:** Use consistent status labels such as **View only**, **AI in control**, **In use**, and **Offline**. Remove or rewrite the stale Research explanation to describe the actual current workflow and its prerequisites.

## Common error-handling contract

Apply these rules to every role and action rather than fixing each message independently:

1. **Every action ends visibly.** Show success, a recoverable error, or an explicitly uncertain result. Never silently return on invalid input or rejected network requests.
2. **Messages answer three questions.** What happened, whether the requested change occurred, and what the user can do next.
3. **Use role-safe detail.** A VA may be told to contact a manager or choose another assigned phone. Do not disclose another operator's identity unless that role is authorized to see it.
4. **Keep errors near the action.** Use an `aria-live` status/alert on the current panel; do not route detail errors into a hidden Fleet element.
5. **Prevent duplicate work.** Disable the initiating control while a request is pending and make repeated clicks idempotent where possible.
6. **Preserve recoverable input.** Do not clear forms, selections, file rows, or assignment edits until success is confirmed.
7. **Confirm destructive actions.** Name the user, phone, task, session effect, or filename. State whether the action can be undone.
8. **Treat disconnects as uncertainty.** Never state success after a network loss. Refresh authoritative state before enabling a repeated device action.
9. **Keep authorization on the server.** Disabled or hidden controls improve usability but do not replace current session, role, assignment, device-mode, and ownership checks.

## Phone-state copy matrix

| State | VA copy | Admin/Manager copy | Content Creator/Editor copy |
| --- | --- | --- | --- |
| AI controlled | This phone is currently controlled by AI. Contact your manager or use another assigned phone. | This phone is controlled by AI. Open the AI workspace or return it to Human mode. | This phone is controlled by AI. You can view its status, but you cannot control it. |
| Human in use | This phone is already in use. Choose another assigned phone or contact your manager. | This phone is already in use. Review the current owner before taking over. | This phone is currently in use. |
| Offline | This phone is offline. Try another assigned phone. Contact your manager if this phone is required. | This phone is offline. Check its Mac, USB connection, WDA, and last health error. | This phone is offline. |
| Detected, WDA not configured | This phone is connected but not ready. Contact your manager. | This phone is connected but not ready. Configure its WDA tunnel before opening it. | This phone is connected but not ready. |
| Not assigned | This phone is not assigned to you. Contact your manager if you need access. | This phone is outside your current device access. Review the user's grant before changing it. | This phone is not available to your account. |
| Connection lost during input | Connection was lost while sending the action. It may have reached the phone. Wait for the screen to refresh before trying again. | Same copy, followed by authoritative owner/lease refresh. | Live status is unavailable while reconnecting. |

## Recommended coding order

1. Fix failed logout cleanup and server-session behavior; add the outage/restart browser regression.
2. Block self-rejection and last-admin rejection on the server; cover direct API calls.
3. Add confirmations, busy states, and response checking for account security and file deletion.
4. Introduce shared request/error handling and surface-local status regions.
5. Make phone and AI controls state-aware and apply the copy matrix.
6. Correct role presentation, availability counts, queue empty state, assignment recovery, stale presence, and responsive control placement.

## Minimum regression coverage

- Browser test: relay loss during Sign out does not leave or restore an authenticated workspace.
- Integration tests: current admin and last active admin cannot be rejected through the status route.
- Browser tests: every destructive control confirms the exact target and submits once.
- Browser test: a failed file deletion keeps the file visible and shows a retryable error.
- Role matrix tests: each phone state returns the correct safe copy and action set for all five roles.
- Browser test: a VA's **Available to you** count equals the number of `canOpen` devices.
- Browser test: empty authorized queue says **No tasks are currently in the queue**.
- Browser test: AI buttons match task state and recover from stale state.
- Browser test: assignment errors persist beside the affected assignment and preserve input.
- Browser test: disconnect marks presence stale and keeps device actions disabled until fresh state arrives.
- Responsive browser test: Release, Home, swipe, and text controls are reachable without a long document scroll at common laptop sizes.
