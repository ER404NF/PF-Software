# Phase 1 Rollout — Coding Agent Handout

**Repository:** `ER404NF/PF-Software`
**Purpose:** hand this document to a coding agent (this one, or a fresh session) so it knows exactly what to
build next, in what order, and how to prove each piece actually works before moving on. This is a living
document — the agent that finishes a task here updates §1 and §4 in place before stopping, the same way the
individual `P*_*.md` reports already do.

**This is Phase 1, not the commercial SaaS plan.** `PF_SOFTWARE_PRODUCTIONIZATION_MASTER_PROMPT.md` and
`PF_SOFTWARE_DATABASE_LOGICAL_PHYSICAL_SCHEMA.md` (owner's Downloads folder) describe a much larger,
sellable multi-tenant product — other companies signing up, billing, native mobile apps. That is **Phase 2**,
deliberately deferred. Phase 1 is: get *this* team running reliably on a real database, real login, and real
automated email. Do not start Phase 2 work (billing, public signup, per-tenant enforcement beyond one default
organization, mobile apps, a public marketing site) unless the owner explicitly asks for it.

---

## 0. Real-world shape you are building for

**Device hosts (fixed locations, will not move):**
- **1 Mac mini in Italy** — 2 iPhones attached.
- **2 Mac minis in Romania** — 3–6 iPhones attached between them.

**The hub (server + database) is a separate machine from all three Mac minis** — a cloud host, not
co-located with any device. **As of this handout, no hub exists anywhere. This is the single biggest blocker
to everything else below.** The owner has not committed to a provider; Railway has been mentioned as a
candidate but nothing has been signed up for. Do not assume a hosting choice has been made.

**No Mac mini is "the main one" that others connect through.** Every Mac mini is an independent site, exactly
like the existing multi-site design already in this repo (`system/server/src/siteAgent.js`, `agentMain.js`):
each runs its own site agent and dials **out** to the one central hub. None of them needs inbound access, and
none of them needs another Mac mini to be reachable — a Mac mini failing or rebooting must never affect the
other two.

(Separately, the app has since gained an *account* role called `host` — see §1 — which is about who can
promote/ban which operators, and is unrelated to "which Mac mini" anything. Don't confuse the two uses of
the word.)

**VAs are distributed globally** and sign in over the internet to the one hub address; they never reach a
Mac mini directly. Fleet total is small (5–8 devices across 3 hosts, one hub process) — do not introduce
infrastructure a fleet this size doesn't justify (a message queue, multiple hub instances, per-region
databases).

**Email provider: Brevo**, chosen by the owner. **2026-09-27 update: P2b is done — real credentials were
provided, wired, and real delivery proved** (see §4 P2b below for the full report). Brevo speaks plain SMTP
(`smtp-relay.brevo.com`, port `587`, STARTTLS — i.e. `SMTP_SECURE=false`), which is exactly what the existing
`mailSender.js` already expects; no new integration code was needed, only the real `SMTP_USER`/`SMTP_PASS`
values (Brevo calls these your SMTP login and your SMTP key, found under Brevo's own Settings → SMTP & API,
not your regular account password) and a
sender address verified in Brevo (`COMPANY_FROM_EMAIL`).

## 1. What already exists — verified by actually running it, not just reading docs. Do not redo any of this.

Read, in order, before touching anything: `docs/productionization/README.md` (the milestone table — the
running source of truth), then `P1_REAL_DATABASE_VERIFICATION.md`, `P2_REAL_LOGIN_MOUNTED.md`,
`P3_DOMAIN_CUTOVER.md`, and `docs/CODING_ROADMAP_STATUS.md`'s latest entries.

**Done, real, and tested against a live database (currently sitting uncommitted on the development
machine — see §2 first bullet):**
- **P1 — the database layer, proven against a real PostgreSQL 16 and a real Redis-compatible server**, not
  mocks. Found and fixed 7 real bugs, including a systemic one where every row-level-security policy in the
  schema could throw a raw database error instead of failing closed, under ordinary pooled-connection reuse.
  All 18 migrations apply and roll back cleanly.
- **P2 — real login actually mounted into the running server** (`system/server/src/index.js`, behind
  `CLOUD_API_ENABLED=true`), proven with real HTTP requests: invite → accept → log in → set up an
  authenticator app → confirm the code → log out. The pre-existing file-based login is untouched and still
  the only thing active by default. Found and fixed 3 more real bugs this way, including the new login system
  and the old one colliding over an internal name for "the current session."
- **P3 — a tested migration script for 9 of the app's data types** (sites, task assignments, per-account
  policies, the task queue, approvals, intervention records, the proxy pool, the audit log, research
  records) that copies them from plain files into the database without loss, safe to run more than once.
  **None of these 9 have actually been switched over yet** — the running app still uses the file versions for
  all of them, on purpose, until there's a real deployment to watch each one on before committing to it.
  Two data types — the device list itself, and the "who's controlling this phone right now" lock — don't
  have a database version yet at all; that's a known, already-documented gap, not an oversight.
- **P4 — a decision, not a build:** at this fleet's size (one hub process, 5–8 devices), a second moving part
  for coordination isn't needed yet. Revisit only if the hub is ever run as more than one process at once.
- **A separate, unrelated, also-finished feature: self-service sign-up, a `host` account role, and a ban
  system.** Built on the *existing* file-based login (not the new database one) — a person can request
  access and an admin sees them waiting; kicking someone (reversible) and banning someone (for something like
  stealing information, not reversible without the owner's say-so) are now two different actions; and there's
  a new `host` role that sits above `admin` — an `admin` can promote people up to `manager`, a `host` can
  promote people up to `admin`, and only the actual owner (set once, from a terminal command, never through
  the web app) can create another `host`. Useful for having one senior person per physical location without
  handing them the power to create another owner. Fully tested; not yet committed.

**Also done since this handout was written:**
- **P2b's code-wiring (steps 3 and 4) — confirmed already complete, not redone.** Checked rather than
  assumed: `emailActionService.js` is already wired into real routes (`createCloudApi.js`'s `/signup`,
  invite, `/password-reset/request`, `/password-reset/confirm`, `/email-verification/confirm`), and
  `index.js`'s real mount already passes the real `mailSender`/`COMPANY_FROM_EMAIL` through
  (`system/server/src/index.js`'s `CLOUD_API_ENABLED` block). The existing file-based self-service flow's
  emails (received/accepted/rejected) already go through the same `mailSender.js`, confirmed working this
  same session. **What's left of P2b is exactly steps 1, 2, 5, and 6 — the real credential and the real
  delivery proof — nothing else.**
- **P6 — a dedicated bug-hunting pass**, done for every item doable without a real deployment: extended
  fuzz coverage to routes P2's pass missed, and to this session's own new admin routes (found and fixed one
  real bug — an unbounded ban-reason field); proved fail-closed/recovery behavior against a real local
  Postgres by severing its connections mid-request; proved two genuine concurrency races
  (simultaneous device-lease claims, simultaneous invitation acceptances) each resolve to exactly one
  winner; proved one site agent disconnecting doesn't affect a second, independent one. Full write-up:
  [P6_BUG_HUNT.md](P6_BUG_HUNT.md). Two of its sub-items still need the real deployment P5 will produce.

**Not done — the actual remaining work, in §4.**

## 2. Safety rules that override everything else here

- **Nothing described in §1 has been committed to git.** It exists only as changes on the development
  machine's working copy. Do not commit or push any of it, or anything you do next, without the owner
  explicitly asking in that session — this applies to routine work, not just risky changes. If asked to
  commit, prefer separate commits for unrelated work (the P1–P3 database work and the host-role/ban feature
  touch almost entirely different files and are not one change).
- **A Mac mini in this fleet may be shared with a client's separate, unrelated node** (a prior instance of
  this warning referred to a Mac mini shared with a client's "XYZ" node). Before touching *any* physical Mac
  mini's configuration, network settings, or `devices.config.json`, confirm with the owner whether that
  specific machine is exclusively PF-Software's or shared — and if shared, never touch the other party's
  phones, accounts, or processes, even in a test.
- **Never fabricate a real-hardware, real-deployment, or real-email-delivery claim.** A test that mocks
  something is not proof the real thing works. Say plainly what has and hasn't been verified against the
  real thing, the way §1's own sources already do.
- **Real secrets** (Brevo SMTP login/key, database URL, Redis URL, session secrets) are environment
  variables, set on whatever host actually runs the app, never committed, never logged, and never pasted
  into a document in this repository — including this one. Follow the existing pattern in
  `deploy/hub/.env.example` (a template with no real values).
- **User-visible text stays in plain language.** Invite emails, error messages, UI labels: no `M0x`,
  `ADR-00xx`, `P1`/`P2`/etc. task labels, or internal jargon. That vocabulary is for this document and the
  `docs/productionization/` reports, never for anything a VA or the owner reads in the product itself.
- **No big-bang cutover.** Every domain moves from files to Postgres behind a flag, is proven equivalent, and
  only then becomes authoritative. If a step here seems to suggest otherwise, this rule wins.

## 3. Explicitly out of scope for Phase 1

Do not build these unless the owner asks:
- Public/self-serve *organization* signup (as opposed to the existing single-organization VA request-access
  flow, which is already built and in scope), other organizations, billing/entitlements, a public marketing
  website.
- Native iOS/Android apps.
- WebAuthn, hard account/organization deletion, a platform-admin role above organizations.
- A database version of the device list or the device control-lock, unless a real design pass happens first
  (see §1's P3 note).
- One Mac mini acting as a fallback/local hub for the others.
- Any of Milestones M07 and up from the original master prompt beyond what §4 below names.

## 4. Ordered task list — what's actually left

Each task ends with a required proof step. Do not mark a task done without it. After each task, write a short
report using the template in §6, add it to `docs/productionization/`, and update §1/this list to match —
keep that folder as the running source of truth.

### P2b — Wire Brevo in for real and prove delivery — **DONE, 2026-09-27 (confirmed by the owner)**

All six steps complete. Full report, including a real false-positive this process caught and corrected —
worth reading in full, not skimming to the green checkmark:

1. ~~Get the real credential~~ — **done.** The owner pasted the real Brevo SMTP login and key in chat.
2. ~~Set the real env vars~~ — **done**, for each proof run, process-environment only, in a throwaway scratch
   script deleted immediately after each run — never written to a file in this repo. **Whoever sets up the
   real host (P5) needs to set these same four values there too** — they do not carry over automatically.
3. ~~Wire `emailActionService.js` into real routes~~ — confirmed already done (see prior entry below).
4. ~~Wire the invite email for both flows~~ — confirmed already done (see prior entry below).
5. **Real delivery proof, attempted three times before it was actually real:**
   - **Attempt 1** (IP not yet authorized in Brevo): every send failed outright with
     `535 5.7.1 Unauthorized IP address` — a real Brevo account-level IP-allowlist control, correctly reported
     as such rather than worked around. The owner authorized the IP in Brevo's dashboard.
   - **Attempt 2** (`COMPANY_FROM_EMAIL` set to the raw SMTP login, `bb46b8001@smtp-brevo.com`): every send
     reported success at the code layer — no transport error from `mailSender`/nodemailer, and the "accepted"
     email's own API response explicitly said `"deliveryState":"sent"`. **This was reported as proof of
     delivery, and that was premature** — the owner checked their inbox and Brevo's own Activity Log and found
     nothing had actually arrived; every entry showed *both* "Sent" and "Error." Brevo had accepted the SMTP
     transaction, then rejected the message at a later delivery stage because
     `bb46b8001@smtp-brevo.com` (an SMTP login identifier, not a real mailbox) was never a verified sender —
     Brevo's own error detail, once the owner clicked into a log entry, said exactly this: *"Sending has been
     rejected because the sender you used ... is not valid. Validate your sender or authenticate your
     domain."* **The real lesson:** `mailSender.js` reporting `"sent"` only means the SMTP server *accepted*
     the message — that is not the same claim as real delivery, and this handout's own "never fabricate a
     real-delivery claim" rule should have meant checking the provider's own delivery status before reporting
     success, not just the absence of a transport-level error. Corrected immediately once the owner reported
     nothing arrived, not defended.
   - **Fix:** the owner added and verified a real address they control (`404.design00@gmail.com`) as a single
     sender in Brevo (Senders/Domains page → add sender → click the confirmation email Brevo sends to that
     address).
   - **Attempt 3** (`COMPANY_FROM_EMAIL` = the newly-verified `404.design00@gmail.com`, recipient
     `yfy264417@gmail.com` at the owner's request): all four sends (invite, password-reset, received,
     accepted) again reported `"sent"` with no transport error — **and this time the owner independently
     confirmed real delivery** by checking the actual inbox. This is the first attempt where "sent" and
     "actually arrived" are both true, confirmed by the person who can see the inbox, not just server logs.
6. **Proof requirement met, for real this time:** four real emails, sent through the real Brevo relay, to a
   real inbox, with the owner confirming actual arrival — not just a code-level success signal.

**For the real deployment (P5) and going forward:** use `COMPANY_FROM_EMAIL=404.design00@gmail.com` (verified
in Brevo) or a properly domain-authenticated sender if one gets set up later — never the raw SMTP login
address again, that is what caused attempt 2's silent failure. The real host will also need its own IP
authorized in Brevo separately (see §5) — authorizing this dev machine's IP does not cover it.

### P5 — Get a real hub deployed (the actual blocker for everything else)

This needs an owner decision before any deployment-specific code is written:
- **Hosting provider.** Ask directly: Railway, or something else? Nothing has been signed up for yet. If
  Railway: it runs this Node/WebSocket server directly, offers managed Postgres and Redis with ready-made
  connection strings, and terminates HTTPS itself on a provided or custom domain — **the existing
  `deploy/hub/` Docker Compose + Caddy setup was written for a bare VPS and does not apply as-is**: skip
  Caddy, bind to the `PORT` Railway injects, use Railway's Postgres/Redis connection strings. If a plain VPS
  instead, `deploy/hub/` is the right unmodified starting point. Don't build both; confirm first.
- A domain name, if the chosen host needs one for a custom address.

Once available:
1. Deploy the hub; confirm the public HTTPS address actually works, not just that the process started.
2. Set the real Brevo credentials there too; redo P2b's delivery proof against the real deployment, not just
   a local run.
3. Point all **three** Mac minis (Italy, and both in Romania) at the hub as three separate sites. None talks
   to another — each dials the hub directly.
4. **Extend** `docs/MAC_INSTALLER_ACCEPTANCE.md`'s checklist to cover *three real hosts running at once*: all
   three online simultaneously; a VA on a device in Italy while another VA is on a device in Romania at the
   same time; one site's network dropping and reconnecting without affecting the other two; any single Mac
   mini rebooting while the other two keep serving their own devices uninterrupted.
5. Turn on automatic Postgres backups from day one — a setting to switch on with the chosen provider, not
   code to write; confirm it's actually enabled, don't assume a default.
6. Run an actual restore drill: restore the backup into a separate, throwaway database, point a throwaway
   copy of the app at it, confirm it boots with the data intact. Record how long this took.
7. Set up an outside uptime check hitting `/healthz` that alerts the owner if the hub goes down.
8. **Now, and only now**, revisit P3's 9 migrated domains: flip each one's cutover flag on the real
   deployment, one at a time, watch it run correctly for a while, then remove that domain's file-store
   fallback. This is the step P3 deliberately deferred waiting for exactly this environment.
9. **Proof required:** a working `https://` URL; all three Mac minis confirmed connected at once with the
   extended three-host checklist passed; a completed backup-and-restore drill with a measured time; a
   confirmed test alert from the uptime check; each cut-over domain's before/after behavior confirmed
   identical on the real deployment.

### P6 — A dedicated bug-hunting pass before calling any of this done

**Done — every item doable without a real deployment; full write-up in
[P6_BUG_HUNT.md](P6_BUG_HUNT.md).** One real bug found and fixed (an unbounded ban-reason field). Items 2
and 4 below were proven against a real local Postgres and two real (test-harness) site agents respectively;
their "on the real deployment" / "real Mac mini" confirmation still needs P5.

Apply the same method that already found real bugs in every task so far in this project: reproduce the
failure for real before touching code, isolate to the actual root cause, fix that, add a regression test,
re-run everything.

Specifically for this phase:
1. ~~Fuzz any route not already covered by P2's fuzzing pass~~ — **done.**
2. ~~Kill the connection to Postgres briefly...~~ — **done against a real local Postgres**; the real
   deployment's own confirmation still needs P5.
3. ~~Simulate two people racing the same action at once...~~ — **done**, both scenarios (device lease,
   invitation acceptance), against real WebSocket connections and a real database.
4. ~~Kill one Mac mini's connection to the hub mid-session...~~ — **done against two real, independent
   test-harness site agents**; confirming this against the three *real* Mac minis still needs P5.
5. **Proof required:** a findings list in the reproduce → root cause → fix → regression-test format, even if
   empty (say so explicitly).

## 5. Owner decisions this handout does not make for you

- **Hub hosting provider** — still genuinely undecided. Ask before any of P5's deployment-specific work.
- ~~The real Brevo credential~~ — **resolved 2026-09-27.** Provided, wired, and real delivery proved (see P2b).
  Remember: the real host (once P5 exists) needs the same four env vars set there too, and its own IP
  authorized in Brevo's dashboard — Brevo's IP-authorization check is per-IP, so authorizing this dev
  machine's IP does not cover the eventual production host.

## 6. Report template (use after every task in §4)

```text
Task:
Files changed:
Database migrations:
Security impact:
Tests added:
Tests run (paste the real summary line):
Manual/real-service tests performed:
Real hardware / real device involved:
Known limitations:
Rollback plan:
Status: PASS | PASS WITH KNOWN LIMITATIONS | BLOCKED | FAIL
Next task:
```

## 7. First action

1. Run `cd system && npm test` and `cd desktop && npm test`. As of this handout: server suite passes with 30
   tests correctly skipped (no local database running in that environment) unless `TEST_DATABASE_URL`/
   `TEST_REDIS_URL` are set, in which case all of them should run and pass; desktop suite 159/159. Confirm
   this is still true, or note what changed.
2. Ask the owner for the two things in §5 before going further than P2b step 1 / before starting P5 at all.
3. If the Brevo credential is provided, do P2b now — it needs no deployment to prove locally.
4. Do not start P5's deployment-specific steps, or P3's cutover step, until the hosting decision is made.
5. Stop and report using §6's template at the end of each task before moving to the next one.
