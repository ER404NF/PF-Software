# Production Readiness Audit — Coding Agent Handout

**Repository:** `ER404NF/PF-Software` · **First audited:** 2026-09-27 · **Independently re-verified:**
2026-09-27 (same day, second pass) — every rating below was re-checked against the actual code, the actual
test run, and a real browser, not taken on the fixing agent's word.

## Independent re-verification note (read this first)

A coding agent worked through this document's priority list since the first pass and updated it in place
claiming items 1, 2, 3, 5, 7, 8 fixed and item 6 (device push) researched. Before accepting any of that, this
pass **re-did the same checks independently**:
- Read the actual diffs for every claimed fix (`wdaProcessManager.js`, `processSupervisor.js`,
  `fileStore.js`, `index.js`'s `helmet()`/CSP/CSRF/rate-limiter blocks) line by line, not just the report text.
- Ran the full server suite myself: **169 files, 1364 tests, 1333 passed, 0 failed, 31 skipped** (skips are
  the same real-database/Redis tests that only run with `TEST_DATABASE_URL`/`TEST_REDIS_URL` set, same as
  every prior pass — not a regression). Desktop suite: **159/159**.
- Re-ran `npm audit --omit=dev` on both packages after the two new dependencies (`helmet`, `express-rate-limit`)
  — **still 0 vulnerabilities, both packages.**
- **Opened the real demo in a real browser** and confirmed, live: the new CSP/security headers are actually
  present on a real HTTP response (`content-security-policy`, `strict-transport-security`, `x-content-type-
  options`, and the rate-limiter's `ratelimit-*` headers all observed directly); no CSP violation in the
  console after login; the phone canvas still renders and the live-video connection still starts under the
  new strict policy; dark mode (moved out of an inline script specifically because of the new CSP) still
  resolves correctly on load.
- Read `P4_DEVICE_PUSH_RESEARCH.md` and `P6_BUG_HUNT.md` in full and checked their claims against the actual
  new test files, not just their prose.

**Everything claimed fixed is confirmed fixed, well-reasoned, and still passing for real.** One real bug was
found and fixed during the P6 bug-hunting pass itself (an unbounded ban-reason field) — exactly the kind of
thing this project's own method is supposed to keep catching, and it did.

**Verdict, updated: closer, still not production-ready.** The security/performance/code-quality items that
were fixable without an owner decision are now fixed and verified. The two blockers that were never about
code — **nothing is deployed anywhere** (§12) and **the real Brevo credential still hasn't arrived** (§9) —
are unchanged. §4 (getting a file onto the actual phone) now has real code — see the 2026-09-27 P4 build
update below — but per that build's own explicit instruction, it is not claimed working until confirmed on
real hardware.

---

## Summary table

| # | Parameter | Rating | Change | One line |
|---|---|---|---|---|
| 1 | Authentication & session security | **9/10** | ↑ from 8 | Real throttling + secure cookies + TOTP, now with a real, verified CSRF defense (Origin/Referer, not a token — see §1 for why that's the right call here) |
| 2 | Authorization / RBAC | 8/10 | — | Same two-system gap as before; P6 additionally *proved* (not just reasoned about) that the device-lease race resolves to exactly one winner |
| 3 | File upload security | **9/10** | ↑ from 8 | Extension + declared MIME + magic/container signature are enforced before commit; full malware scanning remains an infrastructure/vendor decision |
| 4 | Media transfer to the physical phone | **5/10 (code)** | ↑ from 2 | P4 build (2026-09-27): token issuance/consumption route pair, a `filePushSkill.js` (same contract every other skill uses), and an orchestrator all built and unit/integration-tested — but **unverified on real hardware**, per §16 |
| 5 | Live screen streaming performance | **8/10 (code)** | ↑ from 5 | WDA's frame rate/quality/scale are now tuned with sensible, overridable defaults; perceptual improvement still unproven until real hardware (§16) confirms it |
| 6 | Device input/control responsiveness | 7/10 | — | Unchanged — still bound by WDA/XCUITest's own per-action latency, which no code change here affects |
| 7 | Network security headers | **9/10** | ↑ from 4 | `helmet()` + a deliberately custom CSP now in the app itself, independently confirmed live over real HTTP headers in a real browser — applies regardless of hosting choice now |
| 8 | General API rate limiting / abuse protection | **8/10** | ↑ from 5 | `express-rate-limit`, keyed by operator so a shared office IP can't collaterally throttle coworkers; confirmed live (`ratelimit-*` headers observed on a real response) |
| 9 | Email automation | 6/10 | — | Still blocked only on the real Brevo credential, which still has not reached this project |
| 10 | Database & data durability | **9/10** | ↑ from 8 | P6 additionally proved real fail-closed behavior against a live, connection-severed PostgreSQL — not just "should work," empirically shown |
| 11 | Backup & disaster recovery | 1/10 | — | Still nothing to back up — unchanged, correctly, until §12 |
| 12 | Deployment / infrastructure | **0/10** | — | Still nothing deployed anywhere. Still the root blocker for §4, §9, §11, and proving §5/§7/§10 live |
| 13 | Observability & monitoring | 2/10 | — | Unchanged |
| 14 | Dependency & supply-chain security | 10/10 | — | Re-confirmed clean just now, including the two new dependencies |
| 15 | Test coverage & regression discipline | 9/10 | — | Unchanged rating; the discipline that earned it keeps being demonstrated (another real bug caught in P6) |
| 16 | Real-hardware verification | 1/10 | — | Still unchanged, and still the single most important caveat — see below |

---

## What changed since the first pass (details)

### 1. Authentication & session security — 9/10

`app.use("/api", ...)` (`index.js`) now rejects any state-changing request (`POST`/`PUT`/`PATCH`/`DELETE`)
carrying a session cookie whose `Origin` (or, absent that, `Referer`) doesn't match the request's own host —
verified directly: the comparison is against `${req.protocol}://${req.get("host")}`, which correctly reflects
the real public host once `trust proxy` is set (already gated on `deployment.trustProxy`, unchanged from
before). A request with no session yet (login, signup, the loopback bootstrap route) or no Origin/Referer at
all (every non-browser client, the site-agent path, the M04 cloud API's own bearer-token auth) is deliberately
exempt — correctly scoped, since CSRF is a browser-session-cookie threat model specifically. This is a real,
well-reasoned alternative to a token (OWASP's own documented alternative), not a shortcut — the code comment
explaining *why* a token was skipped here is accurate and the reasoning holds up. One tiny residual: a browser
or corporate proxy that stripped both `Origin` and `Referer` from a same-origin request would fall through to
"allowed" — vanishingly rare in practice (`Origin` is sent by every modern browser on state-changing requests
regardless of same/cross-origin), noted for completeness, not treated as a real gap.

### 3. File upload security — 9/10

`fileStore.js` first checks the extension and declared MIME type, then inspects up to 4096 bytes from the
completed hidden staging file. The detected JPEG/PNG/GIF/WebP/HEIF/ISO-BMFF/QuickTime/WebM/MP3/WAV/AAC
signature must match the extension before the same-directory rename commits it. Unknown, truncated, or
mismatched bytes receive `MEDIA_CONTENT_REJECTED`; the quota reservation and staging file are removed and a
previous valid file at that name remains unchanged. Regression coverage includes an `video/mp4` + `.mp4`
upload containing script text, so spoofing both client-controlled metadata fields no longer passes. This is
still a bounded type check rather than a malware service or a full codec parser, and `res.download()` keeps
served media attachment-only; choosing an external scanning/quarantine service remains an infrastructure and
privacy decision, so this is rated 9 rather than 10.

### 5. Live screen streaming performance — 8/10 for the code; §16 still gates the real-world claim

`wdaProcessManager.js` now sets `MJPEG_SERVER_FRAMERATE=20`, `MJPEG_SERVER_SCREENSHOT_QUALITY=30`,
`MJPEG_SCALING_FACTOR=50` by default, each overridable via `WDA_MJPEG_*` env vars — confirmed these are real
WebDriverAgent-recognized variables, correctly plumbed through `processSupervisor.js`'s `start()`/restart path
(verified the restart timer also carries `entry.env` forward, so a crash-restart doesn't silently lose the
tuning). This is exactly the fix the first pass recommended, done correctly. **Rated 8, not higher, because
it has never been run against real WebDriverAgent on a real phone** — the actual perceptual improvement this
is supposed to deliver is still an open question until §16.

**2026-09-27 update (third pass):** added the one remaining §7 polish item this re-verification named — a
`report-uri` CSP directive plus a matching `/api/csp-report` route (`index.js`) that logs violation reports
via the existing audit log (`type: "csp_violation"`), so a future accidental policy mismatch surfaces on its
own rather than needing a manual browser console check. Two new regression tests
(`server/test/integration/cspReporting.test.js`): the header really carries the directive, and a real posted
report is accepted and logged; a malformed report body still gets a clean, non-500 response. Nothing else in
this document changed — §9/§4/§12/§16 remain exactly as this pass described, still owner/hardware-gated.

**2026-09-28 hardening:** the unauthenticated reporting route is independently
rate-limited and retains only bounded diagnostic fields. URL query/fragment data
and browser-provided script samples are discarded rather than written to the
audit log.

### 7. Network security headers — 9/10

Verified **live**, not just by reading code: opened the real demo server in a real browser, logged in, and
read the actual HTTP response headers — `content-security-policy`, `strict-transport-security`,
`x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: SAMEORIGIN` all present
on a real response, confirmed independent of the Caddy path entirely (this was a direct `localhost:4173`
request, no proxy in front of it). The CSP is deliberately custom (`default-src 'self'`, `img-src` extended
for `data:`/`blob:` to allow the canvas-rendered phone frames, `frame-ancestors 'none'`) rather than left at
`helmet()`'s defaults — confirmed no console CSP violations after login, and confirmed the one thing this
policy broke (an inline dark-mode script in `index.html`'s `<head>`) was properly fixed by extracting it to
its own file (`theme-bootstrap.js`) rather than by weakening the policy back to `unsafe-inline`. This now
applies regardless of the still-open hosting decision, which was the whole point of flagging it. Not a 10
only because a `report-uri`/`report-to` CSP violation-reporting endpoint (so a future accidental policy
mismatch surfaces on its own rather than needing a manual browser check like this one) is a reasonable next
layer of polish, not because anything here is wrong.

### 8. General API rate limiting — 8/10

`express-rate-limit` mounted on `/api`, keyed by `req.session?.operator?.username || req.ip` — correctly
avoids the shared-office-IP problem this fleet's topology actually has (one office/NAT IP per Mac-mini site).
Confirmed live: the real response captured during this re-verification carried
`ratelimit-limit: 300`, `ratelimit-remaining: 297`, `ratelimit-policy: 300;w=60` — a real, working limiter,
not configured-but-unmounted. Not a 10 because the limit is a single global default for now (300/min);
tuning per-route (uploads vs. ordinary reads) is a reasonable future refinement, not a current defect.

### 10. Database & data durability — 9/10

The new `postgresConnectionLoss.test.js` (P6) proved, against a real severed PostgreSQL connection
(`pg_terminate_backend`, not stopping the whole database), that a burst of concurrent requests all get a
real, bounded HTTP response — no hang, no leaked stack trace, and normal service resumes once the pool
reconnects — with **no code change required**, because `db/pool.js`'s error handler (already added in the
first P1 pass) already covered this. This is real, additional proof of something the first pass could only
assert in principle. Still not a 10 because the live proof so far is against a *local, disposable* database
(same honest caveat the first pass already carried) — the real deployment's actual database still needs its
own confirmation once §12 exists.

### 6. §4 device-push research — a real path was researched, confirmed by the owner, and is now built (2026-09-27)

`P4_DEVICE_PUSH_RESEARCH.md` is accurate, technically sound research: direct Photos-library push is
correctly identified as blocked by Apple's own design without a jailbreak (AFC2 does not exist on a
non-jailbroken device); `com.apple.mobile.house_arrest` ("House Arrest") is correctly identified as the real,
current, no-jailbreak mechanism — but it only reaches an app's own sandboxed Documents folder, and only for
an app that opted in via `UIFileSharingEnabled`, which cannot be assumed for an arbitrary destination app. The
recommendation actually built (driving Safari to a one-time download link, which iOS hands to the Files app
on its own — general-purpose, no target-app opt-in needed) is the one `P4_DEVICE_PUSH_BUILD.md` confirmed and
this pass implemented:

- `filePushLinkStore.js`: short-lived (10 min), single-use, hashed tokens bound to one `(deviceId, filename)`
  pair — this project's existing token conventions, not a new scheme.
- `platformSkills/filePushSkill.js`: the same `detectState`/`availableActions`/`execute`/`verify`/`recover`
  contract every other skill in this app uses, so "uncertain state escalates to a human, never guesses" holds
  here too. Deliberately not run through `assertPlatformSkill()`/`executeSkillAction()` (those are wired to
  the social-research action catalog); a small dedicated orchestrator (`filePushOrchestrator.js`) drives it.
- Three new routes in `index.js` (`POST .../push-link`, `GET /d/:token`, `POST .../push`), additive only,
  gated on the same `ACCESS_MEDIA`/`canAccessDevice` checks the existing upload/download routes already use,
  plus a requirement that the device already be in `HUMAN` controller mode (re-checked on every poll, not just
  once — CLAUDE.md §4's single-input-owner invariant).
- 23 new unit tests + 1 new integration test, all passing; full suite still green (see the build's own report
  in `P4_DEVICE_PUSH_BUILD.md` for the exact numbers). **Unverified on real hardware** — the UI-text patterns
  the skill uses to recognize Safari's address bar / download banners / error pages are a best-effort guess at
  real iOS accessibility labels, which genuinely vary by iOS version; nothing about that can be proven without
  an actual iPhone. Marked `PASS WITH KNOWN LIMITATIONS`, exactly as the build handout required.

## 16. Real-hardware verification — 1/10 (unchanged, and this is the load-bearing caveat)

Repeating this deliberately: **nothing in this document — not the WDA tuning, not the security headers, not
the rate limiter, not the file-type check — has been run against a real Mac mini or a real iPhone.** Every
"fixed" and "verified" claim above means verified against real software (a real browser, a real database, a
real HTTP server) — genuinely meaningful, and a large step up from a mock — but it is not the same claim as
real hardware. Treat every item above as "correct in software, still to be reconfirmed on the actual fleet."

---

## Priority-ordered action list for the coding agent (updated)

1. ~~§5, §7, §3, §8, §1~~ **Done and independently re-verified this pass.** No further action needed on these
   until real hardware (§16) is reachable to confirm §5's actual perceptual effect.
2. **§9 — finish email** the moment the real Brevo credential arrives. Still blocked on the owner, not on
   code — nothing to build in the meantime.
3. ~~§4~~ **Built 2026-09-27** (owner confirmed the researched mechanism; see the P4 build update above). What
   remains for §4 specifically is real-hardware confirmation, folded into §16 below — not further coding.
4. **§12 — get a real server deployed** (see `PHASE1_TEAM_ROLLOUT_HANDOUT.md`). This remains the single
   biggest unblock: it's what lets §4, §9, §11 become provable, and lets §5/§7/§10/§16 be reconfirmed against
   the real thing instead of a local stand-in.
5. **§16 — the moment real hardware is reachable, re-verify everything above against it**, starting with §5's
   actual perceptual video improvement and §4's device-push mechanism specifically — those two carry the
   least confidence of everything marked "done" until that happens.

## Rules (unchanged — repeated because this document may be read on its own)

- Never commit or push without the owner explicitly asking in that session.
- Never fabricate a real-hardware, real-deployment, or real-delivery claim — say plainly what has and hasn't
  actually been verified.
- Real secrets are environment variables, never committed, never logged, never pasted into a document in
  this repository.
- No big-bang cutover — every change here is additive/behind a flag or a default-on-but-reversible tuning
  value until proven, same as the productionization work already done.

## Report template (use after fixing each numbered item)

```text
Item fixed:
Files changed:
Security impact:
Tests added:
Tests run (paste the real summary line):
Real hardware involved (yes/no, and what was actually confirmed):
Known limitations:
Status: PASS | PASS WITH KNOWN LIMITATIONS | BLOCKED | FAIL
Next item:
```
