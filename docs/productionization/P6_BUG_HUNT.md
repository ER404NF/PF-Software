# P6 — A dedicated bug-hunting pass before calling any of this done

Status: **PASS WITH KNOWN LIMITATIONS** — every locally-doable item in the handout's P6 list was run for
real; one real bug found and fixed. Two sub-items (killing Postgres on the *real* deployment, and killing a
*real* Mac mini's connection) still need the real deployment P5 will produce — see "Known limitations."

Method, same as every other task in this project: reproduce the failure for real before touching code,
isolate to the actual root cause, fix that, add a regression test, re-run everything.

## 1. Fuzz any route not already covered by P2's fuzzing pass

**Gaps found and closed:**
- `cloudApiFuzz.test.js` (M04 cloud API) was missing `/logout` and `/me/mfa/enroll` from its hostile-input
  sweep. Added both.
- The legacy, file-backed `/api/admin/users*` routes (this session's own new work — a `banned` account
  status, a `reason` field, and role-assignment ceilings) had **no** hostile-input coverage at all, not even
  for the routes that predate this session. New file:
  `server/test/integration/adminUsersFuzz.test.js` (22 sub-tests) — malformed JSON/null/oversized/array
  bodies for every JSON-bodied admin route, hostile `role`/`status`/`reason` values, prototype-pollution
  payloads, and a direct check that `isMainHost` in a request body is silently ignored rather than granted.

**A real bug, found by this pass:** `authStore.js`'s `recordAccountBan()` had no length limit on the ban
`reason` field at all — unlike every other free-text field in that file (`fullName`, passwords, etc.), an
unbounded string would have been written straight into `operators.config.json`. Fixed with a
`BAN_REASON_MAX_LENGTH` (1000-character) cap, enforced the same way every other validation failure in that
file is (a thrown `accountError`, surfaced as a clean 400). A non-string reason (wrong shape, not just wrong
length) is deliberately *not* rejected — it's silently discarded so a malformed reason field can never block
the actual security action a host is trying to take. Both behaviors are covered by regression tests.

## 2. Kill the connection to Postgres briefly; confirm it fails closed

Ran against a real, disposable local PostgreSQL 16 (this project's standing no-Docker/no-admin-rights dev
database — see `P1_REAL_DATABASE_VERIFICATION.md`), not a mock. New file:
`server/test/integration/db/postgresConnectionLoss.test.js`.

Rather than stopping the shared Postgres *service* other test files in the same run depend on, the test
severs only the running server's own already-open connections at the SQL level
(`pg_terminate_backend`) — the same effect a database restart or a brief network blip has on an app's
existing connection pool, without taking the database itself down. A burst of 20 concurrent requests fired
at the same moment confirms: every one gets a real HTTP response (no hang, no dropped connection implying a
process crash), any that landed on a severed connection got a clean, bounded 5xx with no leaked stack trace,
and the exact same route recovers to normal behavior moments later once `pg.Pool` transparently reconnects.
No fix was needed here — `db/pool.js`'s existing `pool.on("error", ...)` handler (added in P1) already covers
exactly this.

**Known limitation:** this proves the *code's* fail-closed behavior against a real database. The handout's
own step 2 says "once it exists" for the real deployment — that specific confirmation (this same behavior,
observed against the actual production Postgres instance, not a local one) still needs P5.

## 3. Two people racing the same action at once

**Device lease race** (`server/test/integration/wsProtocol.test.js`, new test): two real WebSocket
connections, two real operator accounts, both send `select_device` for the same idle device with no
`await` between the sends — a genuine race, not the pre-existing sequential test (A selects and confirms,
*then* B tries) that this file already had. Ran 5 times back to back to build confidence against flakiness.
**Result: exactly one wins, the other gets a clean rejection, every time.** Reading `claimDevice()`
(`index.js`) explains why: the actual claim mutation (`humanOwners.set(...)`) happens in one synchronous
block with no `await` in between, and JS's run-to-completion semantics mean two connections' handlers can
never interleave inside that block — a second concurrent claim always observes the first one's mutation
already applied. No bug found; now empirically proven, not just reasoned about.

**Invitation acceptance race** (`server/test/integration/db/invitation.test.js`, new sub-test, real
PostgreSQL): two different users concurrently call `acceptInvitation()` with the same token. **Result:
exactly one succeeds, one membership exists (never zero, never two), and the loser gets a clear
"accepted or revoked by someone else concurrently" error.** This one *is* safe by real database
row-locking, not just JS semantics: `invitationRepository.markAccepted()` is a conditional
`UPDATE ... WHERE accepted_at IS NULL RETURNING *`, and Postgres's own row lock serializes the two
concurrent transactions. No bug found.

## 4. Kill one Mac mini's connection to the hub mid-session

New test (`server/test/integration/siteLink.test.js`): the only test in that file that runs **two** real,
independent site agents at once (every other test in the file uses exactly one) — matching the real fleet
shape (Italy + two in Romania, none talking to another). Site 1's agent is stopped mid-session while an
operator has an active control session open on site 2's phone. **Result: site 2 stays online, the
operator's already-open control session keeps working with zero interruption, and the fleet list correctly
shows site 1 (and only site 1) as offline.** No bug found.

**Known limitation:** this proves the *hub's* isolation logic against two real (test-harness) site agents.
The handout's own step 4 additionally wants this confirmed against the three *real* Mac minis once they're
actually pointed at a real deployed hub — that still needs P5.

## Report (per handout §6)

```text
Task: P6 — bug-hunting pass (steps 1 and 3 fully locally provable; steps 2 and 4 locally provable in
  substance, with the real-deployment confirmation still pending P5)
Files changed:
  - system/server/src/authStore.js (BAN_REASON_MAX_LENGTH cap on recordAccountBan — the one real bug found)
  - system/server/test/integration/db/cloudApiFuzz.test.js (added /logout, /me/mfa/enroll)
  - system/server/test/integration/adminUsersFuzz.test.js (new, 22 sub-tests)
  - system/server/test/integration/db/postgresConnectionLoss.test.js (new)
  - system/server/test/integration/wsProtocol.test.js (new concurrent device-claim race test)
  - system/server/test/integration/db/invitation.test.js (new concurrent invitation-acceptance race test)
  - system/server/test/integration/siteLink.test.js (new two-independent-sites test)
Database migrations: none.
Security impact: fixes an unbounded-length write path (ban reason) into operators.config.json; otherwise
  no behavior change, only new coverage of already-correct behavior.
Tests added: 1 (fuzz) + 22 (adminUsersFuzz) + 1 (Postgres connection loss) + 1 (device race) + 1 (invitation
  race) + 1 (two-site independence) = 27 new/extended sub-tests.
Tests run (paste the real summary line): Full suite: 167 files, 1597 tests, 1597 passed, 0 failed, 0
  skipped. (real PostgreSQL 16 + real Redis-compatible server)
Manual/real-service tests performed: real embedded PostgreSQL 16 (connection-severing, invitation race);
  real WebSocket connections over a real HTTP server (device-claim race, two-site independence). No mocks
  for any of the four P6 items.
Real hardware / real device involved: none — the fake WDA/mock device fixtures this project already uses
  throughout, not a real iPhone or Mac mini.
Known limitations: steps 2 and 4's "on the real deployment" / "real Mac mini" confirmation still needs P5
  (a real hub to deploy to and real Mac minis to point at it) — cannot be done before then.
Rollback plan: nothing to roll back — every change here is either a new test or a stricter (never looser)
  input validation.
Status: PASS WITH KNOWN LIMITATIONS
Next task: P2b step 5/6 (real Brevo credential + real delivery proof) or P5 (hosting decision) — both
  owner-gated, see §5.
```
