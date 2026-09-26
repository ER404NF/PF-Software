# Phase 1 Rollout — Coding Agent Handout

**Repository:** `ER404NF/PF-Software`
**Purpose:** hand this document to a coding agent (this one, or a fresh session) so it knows exactly what to
build next, in what order, and how to prove each piece actually works before moving on.

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
co-located with any device. The owner is leaning toward **Railway** but hasn't committed; treat the exact
provider as open (see §5) and keep the app itself provider-agnostic (plain environment variables for every
connection string/secret — never hard-code a Railway-specific API).

**Topology: no Mac mini is "the main one" that others connect through.** Every Mac mini is an independent
site, exactly like the existing multi-site design already in this repo (`system/server/src/siteAgent.js`,
`agentMain.js`): each runs its own site agent and dials **out** to the one central hub. None of them needs
inbound access, and none of them needs another Mac mini to be reachable — a Mac mini failing or rebooting
must never affect the other two. If the owner later wants one Mac mini to double as a local fallback should
the hosted hub go down, treat that as a separate, later decision — it is not required for Phase 1 and adds
real complexity (no managed backups, reachability depends on that office/home network staying up).

**VAs are distributed globally** and sign in over the internet to the one hub address; they never reach a
Mac mini directly. Fleet total is small (5–8 devices across 3 hosts, one hub process) — do not introduce
infrastructure a fleet this size doesn't justify (a message queue, multiple hub instances, per-region
databases).

## 1. Read this first — do not redo it

Before writing anything, read, in order:
1. `docs/productionization/README.md` — the milestone table and ADR register. It is the source of truth for
   what is *actually* done vs. planned; do not trust anything in this handout that turns out to contradict it.
2. `docs/productionization/M00_BASELINE.md` through `M06_REDIS_FOUNDATION.md`.
3. `docs/productionization/DATABASE_GAP_ANALYSIS.md`.

As of this handout, verified by actually running the code (not just reading the docs):
- The identity/organization system, 18 Postgres migrations, and the database repositories **exist as real,
  tested code** but are **not wired into the running server** — `system/server/src/index.js` still only
  imports the file-backed stores in `system/server/src/persistence/`.
- The 18 database/Redis integration tests **skip** on a machine with no `TEST_DATABASE_URL`/`TEST_REDIS_URL`
  set — they have only ever run inside GitHub Actions' throwaway service containers, never against a database
  that stays up, never restored from a backup.
- Server suite: 1293 passed / 0 failed / 19 skipped (the skips above). Desktop suite: 159 passed / 0 failed.
  Confirm this is still true before you change anything; if it isn't, that's a regression to fix first.
- One product decision is already recorded and must not be re-litigated: the existing single-tenant
  deployment maps onto **one auto-created default organization** (see `M05_DURABLE_DOMAIN_MIGRATION.md`,
  "Owner decision this milestone depends on").
- A shared email-sending module, `system/server/src/mailSender.js`, **already exists** — plain SMTP via
  nodemailer, configured entirely by `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE`
  env vars, with `COMPANY_FROM_EMAIL` as the sender address. It already sends account-notification email
  (acceptance/rejection/recovery) when configured, and logs a clear warning and queues instead of sending
  when it isn't. The newer email-verification/password-reset service
  (`system/server/src/services/emailActionService.js`) was **deliberately written to reuse this same
  module** rather than build a second one — its own file header says so. **Do not build a second email
  system.** See §4 P2b.

## 2. Safety rules that override everything else here

- **Never commit or push without the owner explicitly asking in that session.** Working-tree changes are
  fine; `git commit`/`git push` are not yours to decide.
- **A Mac mini in this fleet may be shared with a client's separate, unrelated node** (a prior instance of
  this warning referred to a Mac mini shared with a client's "XYZ" node). Before touching *any* physical Mac
  mini's configuration, network settings, or `devices.config.json`, confirm with the owner whether that
  specific machine is exclusively PF-Software's or shared — and if shared, never touch the other party's
  phones, accounts, or processes, even in a test.
- **Never fabricate a real-hardware or production-database claim.** A test that mocks the database is not
  proof the database layer works. Say plainly what has and hasn't been verified against the real thing, the
  same way `M00_BASELINE.md` and the mac-installer docs already do.
- **Real secrets** (Postgres URL, Redis URL, SMTP credentials, session secrets) are environment variables,
  never committed, never logged. Follow the existing pattern in `deploy/hub/.env.example`.
- **User-visible text stays in plain language.** Invite emails, error messages, UI labels: no `M0x`,
  `ADR-00xx`, milestone numbers, or internal jargon. That vocabulary is for this document and the
  `docs/productionization/` reports, never for anything a VA or the owner reads in the product itself.
- **No big-bang cutover.** Every domain moves from files to Postgres behind a flag, is proven equivalent, and
  only then becomes authoritative — exactly the migration principle already written into the master prompt
  and `M05_DURABLE_DOMAIN_MIGRATION.md`. If a step here seems to suggest otherwise, the safety rule wins.

## 3. Explicitly out of scope for Phase 1

Do not build these unless the owner asks:
- Public/self-serve signup, other organizations, billing/entitlements, a public marketing website.
- Native iOS/Android apps.
- WebAuthn, hard account/organization deletion, a platform-admin role above organizations.
- Redis-backed coordination (see §4 task P4 — likely not needed yet at this scale).
- One Mac mini acting as a fallback/local hub for the others (see §0).
- Any of Milestones M07 and up from the original master prompt beyond what §4 below names.

## 4. Ordered task list

Each task ends with a required proof step. Do not mark a task done without it. After each task, write a short
report using the template in §7 and append it to the relevant `docs/productionization/M0x_*.md` file (or a new
one if none fits) — keep that folder as the running source of truth, the same way it already is.

### P1 — Prove the database foundation against a real database

1. Bring up a real, disposable PostgreSQL and Redis for development (a `docker-compose.dev.yml` if one
   doesn't already exist is the easiest path — this machine does not need Docker installed forever, just for
   this verification and ongoing local dev).
2. `npm run migrate up` against it from a clean state.
3. Set `TEST_DATABASE_URL` / `TEST_REDIS_URL` and re-run the full server suite. The 19 previously-skipped
   tests must now **execute and pass**, not skip.
4. Run the migration round trip the CI workflow already does: migrate up, run the tenant-isolation test for
   real, migrate down, migrate up again — must be clean.
5. Whatever breaks here that didn't break against a mock is real — use the debugging method in §6, fix the
   root cause, add a regression test, don't just patch around the symptom.
6. **Proof required:** paste the full test run showing 0 skipped, 0 failed, and the round-trip log.

### P2 — Wire real login into the running app (single organization, invite-only)

1. On startup, ensure the one default organization exists (create it if missing) — do not build an
   organization-creation flow; there is exactly one.
2. Mount the identity/cloud API into `system/server/src/index.js` behind an explicit environment flag,
   *alongside* the existing file-backed operator login — do not remove the old path yet.
3. Build exactly the flows a real rollout needs: an admin invites a VA by email; the VA accepts the invite and
   sets a password; login; logout; TOTP two-factor setup and verification. No public "create an account"
   route should exist.
4. Run the master prompt's authorization matrix (anonymous / wrong organization / wrong role / correct role /
   disabled user / expired session / revoked session) against **every** protected route this API exposes —
   `M04_ORGANIZATION_IDENTITY.md` already proved the pattern on two routes; finish the rest. Mechanical, not
   optional.
5. Fuzz every new route the same way the earlier installer-debugging session fuzzed HTTP routes and WebSocket
   messages in this exact repository: malformed JSON, `null`, oversized bodies, wrong types,
   prototype-pollution shapes. Every route must answer with a clean 400/401/403, never a 500.
6. Decide (and write down) how this new identity layer relates to the existing 5-role
   `system/server/src/roleCapabilities.js` model used by the live device-control screens. Recommended default
   unless the owner says otherwise: keep device-control authorization exactly as it is today; the new identity
   system only replaces account lifecycle (signup-from-invite, login, sessions, MFA) sitting in front of it.
7. **Proof required:** an invite, real login, and a live two-factor setup completed end to end — not a log
   line claiming it worked.

### P2b — Wire the automated emailing system in for real (do this as part of P2, not separately)

There is already exactly **one** email-sending module to use: `mailSender.js` (plain SMTP via nodemailer).
Do not add a second SDK/provider-specific client. The work here is entirely about *using* what exists, plus
one small extension:

1. **Wire `emailActionService.js` into real routes.** Its own header already says it is meant to call
   `mailSender.send(...)` for delivery — right now nothing does. Add the two routes/flows: request a
   password reset (issue token → send email with a reset link → user follows link → confirm with a new
   password) and email verification (issue token on signup-from-invite → send email → confirm). Reuse
   `accountNotificationStore.js`'s existing pattern for building message content ("queued" when SMTP isn't
   configured, real send when it is) rather than inventing a new content/templating approach.
2. **Add the invite email itself.** An admin inviting a VA (P2 step 3) must send a real email containing the
   accept-invite link, through the same `mailSender`. Check whether `invitationService.js` already calls it;
   if not, wire it the same way.
3. **Every email Phase 1 needs, all through this one module:**
   - invite a VA to the organization;
   - verify email address;
   - reset password;
   - two-factor recovery / account-notification emails already partially wired (acceptance/rejection/
     recovery per `accountNotificationStore.js`) — confirm these still work once the identity system is
     mounted, don't let P2 silently break them.
   - *Not* required for Phase 1 unless the owner asks: marketing email, digest/summary email, device-offline
     alert email (that's a monitoring concern, see P5 step 7, not an account-lifecycle email).
4. **Get real SMTP credentials from a transactional email provider** (see §5 — this is one of the two owner
   decisions) and set `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE`/`COMPANY_FROM_EMAIL` for
   real, in whatever environment-variable mechanism the chosen host uses (e.g. Railway's project variables).
   Do not commit these values anywhere, including into `deploy/hub/.env.example` (that file stays a template
   with no real values).
5. **Prove delivery for real**, not just `mailSender.isConfigured() === true`: send an actual invite to a
   real inbox, accept it, request a real password reset, receive that email too. A provider dashboard showing
   "delivered" plus the email actually arriving (check spam folder too — if it lands there, the sender
   domain needs SPF/DKIM set up with the provider, not a code fix) both count as proof.
6. **Proof required:** two real emails (an invite and a password reset) received in a real inbox during this
   task, plus a note confirming the pre-existing account-notification emails still send correctly afterward.

### P3 — Move durable data off files, one domain at a time

Order (already established in `M05_DURABLE_DOMAIN_MIGRATION.md`): sites → devices/hosts → assignments →
leases → platform accounts/policies → task queue/runs/checkpoints → approvals/interventions → research →
proxy pool → audit.

For each domain:
1. The Postgres adapter already exists — confirm it against the real database from P1.
2. Write a one-time migration that reads the current file store and writes it into Postgres, recording
   before/after row counts.
3. Run the domain's existing test suite against the real database, not the file store.
4. Cut `index.js` over to the Postgres adapter for that domain behind the same flag as P2; keep the file
   store readable as a fallback until you've watched it run correctly for a while, then remove it.
5. **Proof required per domain:** before/after row counts matching, the domain's tests green against real
   Postgres, and the app behaving identically after a restart with only Postgres backing that domain.

### P4 — Redis: decide, don't assume

At 5–8 devices across three hosts behind one hub process, Redis is very likely not required yet — use a
Postgres-level lock (e.g. `SELECT ... FOR UPDATE` or an advisory lock) for the device-lease race instead of
adding a second moving part. Only build out `M06_REDIS_FOUNDATION.md`'s remaining scope (presence, distributed
locks, rate limits) if the owner decides they want more than one hub process running (e.g. for zero-downtime
deploys) sooner than that. **Proof required:** a one-paragraph decision note either way, before doing (or
explicitly skipping) more Redis work.

### P5 — Deploy the real hub and connect all three real device hosts

This task needs two things only the owner can provide — ask, don't guess:
- **A hosting choice and, if it needs one, a domain name.** The owner is leaning toward **Railway**: it can
  run this Node/WebSocket server directly, offers managed Postgres and Redis add-ons with ready-made
  connection strings, and terminates HTTPS itself on a provided or custom domain — so **the existing
  `deploy/hub/` Docker Compose + Caddy setup, written for a bare VPS, does not apply as-is on Railway**: skip
  Caddy (Railway's own edge handles TLS), bind the app to the `PORT` Railway injects, and use Railway's
  Postgres/Redis plugin connection strings instead of the compose file's own containers. If the owner instead
  picks a plain VPS, the existing `deploy/hub/` files are the right starting point unmodified. Confirm which
  one before doing deployment-specific work — don't build both.
- **A transactional email provider account and API/SMTP credentials** — see P2b and §5.

Once available:
1. Deploy the hub (adapted to whichever host was chosen, per above); confirm the public HTTPS address
   actually works, not just that the process started.
2. Set the real SMTP credentials as environment secrets on that host; confirm a real email is delivered
   (P2b's proof, redone against the real deployment, not just a local run).
3. Point all **three** Mac minis (Italy, and both in Romania) at the hub as three separate sites, using the
   already-built site-agent protocol. None of them talks to another — each dials the hub directly.
4. **Extend** `docs/MAC_INSTALLER_ACCEPTANCE.md`'s checklist to cover *three real hosts running at once*, not
   one: all three sites online simultaneously; a VA controlling a device on the Italy host while another VA
   controls a device on one of the Romania hosts at the same time; one site's network dropping and
   reconnecting without affecting the other two; any single Mac mini rebooting while the other two keep
   serving their own devices without interruption.
5. Turn on automatic Postgres backups from day one — not a later task. (A managed Postgres add-on, Railway's
   included or otherwise, typically has this as a setting to switch on, not code to write — confirm it's
   actually enabled, don't assume a default.)
6. Actually run a restore drill: restore the backup into a separate, throwaway database; point a throwaway
   copy of the app at it; confirm it boots and the data is intact. Record how long this took — that is your
   real recovery time, not an estimate.
7. Set up an outside uptime check hitting `/healthz` that alerts the owner if the hub goes down. VAs across
   time zones will notice before you do otherwise.
8. **Proof required:** a working `https://` URL; all three Mac minis confirmed connected at once with the
   extended three-host acceptance checklist passed; a completed backup-and-restore drill with a measured
   time; a confirmed test alert from the uptime check.

### P6 — A dedicated bug-hunting pass before calling any of this done

Apply the same method that already found and fixed a real bug in this exact codebase earlier (a symlink path
comparison that made the packaged server exit silently, and a CRLF-vs-LF test that only failed on Windows):
reproduce the failure for real before touching code, isolate to the actual root cause, fix that, add a
regression test, then re-run everything.

Specifically for this phase:
1. Fuzz every new cloud-facing route (already started in P2) — confirm nothing returns a 500.
2. Kill the connection to Postgres briefly while the app is running and confirm it fails closed with a clear
   error, never silently loses or corrupts a write.
3. Simulate two people racing the same action at once — two VAs claiming the same device lease on the same
   or different Mac minis, two acceptances of the same invitation — confirm exactly one wins and the other
   gets a clear, safe rejection, never a duplicate account or a corrupted lease.
4. Kill one Mac mini's connection to the hub mid-session and confirm the other two hosts and their VAs are
   completely unaffected (this is the concrete test of §0's "no host depends on another").
5. **Proof required:** a findings list in the reproduce → root cause → fix → regression-test format, even if
   the list is empty (say so explicitly, don't omit the section).

## 5. Owner decisions this handout does not make for you

- **Hub hosting provider.** Leaning Railway; not committed. Ask before starting P5's deployment-specific
  steps, since the deployment approach genuinely differs by provider (see P5).
- **Email provider.** Needs SMTP credentials specifically (the existing `mailSender.js` speaks plain SMTP,
  not any provider's proprietary HTTP API) — any transactional provider offering SMTP works (most do). Ask
  which one before P2b step 4; don't sign up for one on the owner's behalf.

## 6. How to test and hunt bugs (method, not just a checklist)

- **Reproduce before you fix.** If something only fails in CI or only fails against a real database, recreate
  that exact condition locally (a real Postgres, a real symlink, a real CRLF checkout, a real network drop)
  before writing a fix. A fix that only "should" work is not a fix.
- **Fuzz first when there's no reported symptom yet.** List every route/message type, send each a handful of
  hostile inputs (malformed JSON, `null`, oversized, wrong types), and treat any 5xx or hang as a real bug to
  chase down — this exact technique already found the installer's server-exits-silently bug in this project.
- **A class of bug shows up as the same failure in several places.** If you find one route mishandling bad
  input, check whether every other route shares the same code path before declaring victory.
- **Run the full suite after every change**, not just the file you touched: `cd system && npm test` and
  `cd desktop && npm test`. Both must stay green; note any pre-existing skip and why.
- **Never report PASS when a required test was skipped.** Use the exact status vocabulary the master prompt
  already defines: `PASS`, `PASS WITH KNOWN LIMITATIONS`, `BLOCKED`, `FAIL`.

## 7. Report template (use after every task in §4)

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

## 8. First action

1. Run `cd system && npm test` and `cd desktop && npm test`. Confirm the counts in §1 (or note what changed).
2. Confirm whether a local Postgres/Redis is already available; if not, that is the very first thing to set
   up (P1, step 1).
3. Start P1. Do not skip ahead to P5 (real deployment) before P1–P4 are proven locally — a hub deployed on top
   of an unverified database layer just moves the same unverified risk onto real accounts.
4. Stop and report using §7's template at the end of each task before moving to the next one.
