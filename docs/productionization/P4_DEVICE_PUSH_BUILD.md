# P4 build — getting a file from the server onto the actual phone

**Owner decision (confirmed 2026-09-27): build it now.** Per
[P4_DEVICE_PUSH_RESEARCH.md](P4_DEVICE_PUSH_RESEARCH.md)'s recommendation: direct Photos-library push is
confirmed infeasible without a jailbreak; the real, general-purpose, no-jailbreak path is driving Safari to
download the already-staged file, which iOS hands to the Files app on its own — this works regardless of
which destination app a VA ultimately wants the file in, and needs no target app to have opted into anything.

This is the one item from [PRODUCTION_READINESS_AUDIT.md](PRODUCTION_READINESS_AUDIT.md) that had no code
yet, by design, pending exactly this confirmation. Build it now; everything else in that document's priority
list stays as-is (owner/hardware-gated, not code-gated).

## Architecture: build this as a platform skill, not a one-off tap sequence

This codebase already has a contract for exactly this shape of work —
`system/server/src/platformSkill.js`'s required methods (`detectState`, `availableActions`, `execute`,
`verify`, `recover`) implement the perceive → plan → validate → act → verify loop CLAUDE.md's own
architecture section describes. Every existing skill (`server/src/platformSkills/*.js`) drives a social
app this same way. **Do not bolt tap/swipe calls directly into the file route handler** — build a new skill
(e.g. `server/src/platformSkills/filePushSkill.js`) that follows the same contract, so this feature inherits
the same verification discipline, audit correlation, and "uncertain state escalates to a human, never guesses"
behavior every other automated action in this app already has, instead of reinventing weaker versions of all
of that from scratch.

## The one real design problem to solve first: how does the phone's Safari authenticate?

The existing per-device file download route (`GET /api/devices/:deviceId/files/:filename`) requires
`req.session.operator` — a VA's own browser session. The phone's on-device Safari has no such session and
must never be given one (that would mean putting an operator's real session cookie on a phone you don't
fully control). Do not reuse that route directly.

**Build a separate, purpose-built link instead:**
1. A new authenticated route, callable only by an operator who already has `ACCESS_MEDIA` and access to that
   specific device (same checks the existing upload/download routes already make): e.g.
   `POST /api/devices/:deviceId/files/:filename/push-link`. It generates a **short-lived (5–10 minutes),
   single-use, cryptographically random token** bound to that exact `(deviceId, filename)` pair — reuse this
   project's existing token patterns (site tokens, email-action tokens: store a hash, never the raw token,
   generate with `crypto.randomBytes`) rather than inventing a new scheme.
2. A new, deliberately narrow, unauthenticated-by-session route that serves the file **only** given a valid,
   unexpired, not-yet-consumed token for that exact device+filename: e.g. `GET /d/:token`. Consuming it
   (marking it used) happens atomically with serving the file, so it cannot be replayed even if a network
   retry happens. Log every issuance and every consumption to the audit log, exactly like every other media
   action already is.
3. The new `filePushSkill.js` then: opens Safari, navigates to that one-time URL, waits for the download to
   actually complete (via the accessibility tree — WDA can inspect Safari's own download-progress UI element,
   not just "we sent a tap and assumed it worked"), and reports success or a specific failure reason per file.

## Build steps

1. **The token issuance/consumption mechanism** (server-side, no device interaction yet): new route pair as
   above, with real unit tests — expiry, single-use, wrong-device rejection, wrong-filename rejection, replay
   rejection. This part can be fully proven without any phone at all.
2. **The Safari-driving skill itself** (`filePushSkill.js`), against the existing mock device/fixture
   patterns this project already uses for every other skill: `detectState` recognizes "Safari on the one-time
   URL," "download in progress," "download complete," and an explicit "something went wrong" state rather
   than only ever a small few happy-path phases; `execute` drives the tap sequence (open Safari, type/navigate
   to the URL, confirm the download); `verify` re-checks the accessibility tree for a real "downloaded"
   signal, not just elapsed time; `recover` handles the ordinary retryable failures (page didn't load in time,
   etc.) the same way every other skill's `recover` already does. This part, too, can be built and tested
   against fixtures without real hardware — same discipline as every other skill in this project.
3. **Per-file success/failure reporting** back to whoever requested the push (the VA), not a silent
   fire-and-forget — reuse the existing audit-log/notification patterns rather than a new ad-hoc mechanism.
4. **Do not claim this works until it's run on a real iPhone.** Steps 1–3 can be fully built and tested in
   this environment exactly like everything else in this project's history — but per
   `PRODUCTION_READINESS_AUDIT.md` §16, this specific feature, more than almost anything else in that
   document, depends on real iOS/Safari UI behavior (download banners, Files-app integration, and their exact
   accessibility labels vary by iOS version) that a mock device cannot exercise. Mark it clearly
   **PASS WITH KNOWN LIMITATIONS — unverified on real hardware** until it's actually tried on one of the real
   Mac mini + iPhone pairs, and re-confirm §4's rating only after that happens.

## Safety rules (same as every other handout in this folder)

- Never commit or push without the owner explicitly asking in that session.
- Never fabricate a real-hardware verification claim — this feature specifically cannot be called "done"
  from software tests alone; say so plainly, the way step 4 above already does.
- Real secrets/tokens: the push-link token is generated and hashed server-side; never log the raw token,
  never put it anywhere but the URL itself, and keep its lifetime short.
- No big-bang cutover — this is a wholly new route/skill, additive from day one; nothing existing changes
  behavior because of it.

## Report template (same as the other handouts in this folder)

```text
Task: P4 build — device file push via Safari/Files
Files changed:
  - system/server/src/filePushLinkStore.js (new) — short-lived, single-use, hashed
    tokens bound to (deviceId, filename), same conventions as this project's other
    token stores (site/action/invitation/session tokens).
  - system/server/src/platformSkills/filePushSkill.js (new) — same detectState/
    availableActions/execute/verify/recover contract as every other skill in
    server/src/platformSkills/*.js; not run through assertPlatformSkill()/
    executeSkillAction() (documented at length in its own header — those are wired
    to actionCatalog.js's social-research action list, which "push a file to this
    phone" isn't part of).
  - system/server/src/filePushOrchestrator.js (new) — drives the skill's perceive
    -> plan -> act -> verify loop against a real device until the download
    completes or a bounded step budget is exhausted; returns one of SUCCESS /
    FAILED / NEEDS_HUMAN / TIMED_OUT / BLOCKED, never a silent fire-and-forget.
  - system/server/src/index.js — three new routes, additive only (nothing
    existing changes behavior):
      POST /api/devices/:deviceId/files/:filename/push-link  (issue a link)
      GET  /d/:token                                          (consume + serve)
      POST /api/devices/:deviceId/files/:filename/push        (drive the push,
        blocks until a real per-file outcome; requires the device to be in
        HUMAN controller mode first, re-checked on every poll during the run)
  - system/server/test/unit/filePushLinkStore.test.js (new, 7 tests)
  - system/server/test/unit/filePushSkill.test.js (new, 7 tests)
  - system/server/test/unit/filePushOrchestrator.test.js (new, 8 tests)
  - system/server/test/integration/filePushRoutes.test.js (new, 1 test covering
    the full route chain: issuance auth boundary, consumption + replay
    rejection, malformed/unknown token rejection, and the trigger route's own
    auth boundary and end-to-end wiring against the real MockDevice)

Security impact:
  - The phone's on-device Safari never receives a real operator session cookie —
    it authenticates with a 10-minute, single-use, cryptographically random token
    (crypto.randomBytes(32), only its SHA-256 hash persisted, constant-time
    comparison), exactly this project's existing token pattern.
  - "Wrong device"/"wrong filename" rejection happens at issuance time (same
    ACCESS_MEDIA + canAccessDevice + resolveFile checks the existing upload/
    download routes already enforce); the consuming GET /d/:token route takes
    only the token as input, so there is no separate deviceId/filename parameter
    for an attacker to mismatch against a stolen token in the first place.
  - Consumption is atomic with serving the file (mark-used and read happen in
    the same store call), so a network retry can never replay a token.
  - The trigger route requires the device to already be in HUMAN controller
    mode (CLAUDE.md §4's single-input-owner invariant) both before starting and
    on every poll during the run, so an AI task cannot start on the same device
    while a push is mid-flight, and a mode switch or access revocation mid-run
    stops the run at the next check rather than finishing on stale authorization.
  - Every issuance, every consumption, and every completed push is written to
    the existing audit log (file_push_link_issued / file_push_link_consumed /
    file_pushed_to_device), the same mechanism every other media action already
    uses — no new reporting channel invented for this feature.

Tests added: 23 new unit tests (link store, skill, orchestrator) + 1 new
  integration test (7 assertions across the full route chain).

Tests run (paste the real summary line):
  Full suite: 175 files, 1398 tests, 1367 passed, 0 failed, 31 skipped.
  npm audit --omit=dev: found 0 vulnerabilities.

Real hardware involved (yes/no, and what was actually confirmed): No. Every
  test above runs against either the fixture SafariFixture (a fully scripted
  fake Safari) or this project's existing MockDevice (Instagram/Camera/Settings
  home screen, no real Safari) — the latter proves the whole chain (route ->
  token issuance -> orchestrator -> skill -> a real device adapter instance)
  executes cleanly end-to-end and returns a specific, well-formed outcome
  (TIMED_OUT, since a mock phone has no Safari icon to find), never a crash, a
  hang, or a silent 200 with no result. Nothing here confirms real iOS/Safari
  accessibility-label behavior.

Known limitations:
  - The UI-text patterns in filePushSkill.js (which label identifies the Safari
    icon, the address bar, a download-in-progress vs download-complete banner,
    an error page) are a best-effort guess at real iOS/Safari accessibility
    labels, which genuinely vary by iOS version. Easy to find and adjust in one
    place (the *_PATTERNS constants) once real-hardware testing reveals the
    actual labels.
  - navigate_to_link submits the URL by typing a trailing "\n" into the address
    bar (XCUITest's own documented way to trigger a keyboard's "Go" action) —
    there is no dedicated WDA submit/press-return primitive in this codebase.
    Unverified on real hardware.
  - No integration test drives pushFileToDevice against a real WdaDevice
    instance (as opposed to MockDevice) — this codebase has no fixture seam for
    that, and a real WdaDevice would attempt actual HTTP calls to a WDA server
    that doesn't exist in the test environment.
  - Authorization is re-resolved from the live identity store after awaited
    observations and before every tap, text entry, or Home recovery. Automated
    route coverage proves revoking a device grant during an in-flight observation
    produces BLOCKED before another input reaches the device.

Status: PASS WITH KNOWN LIMITATIONS — unverified on real hardware.

Next task: try this on one of the real Mac mini + iPhone pairs (POST the
  /push route against a real device id) and use whatever the accessibility
  tree actually shows to correct filePushSkill.js's *_PATTERNS constants, then
  re-confirm PRODUCTION_READINESS_AUDIT.md §4/§16's rating.
```
