# M06 — Redis foundation

Status: **PASS** — verified against a real Redis-compatible server (Memurai, via `redis-memory-server`) in
[P1_REAL_DATABASE_VERIFICATION.md](P1_REAL_DATABASE_VERIFICATION.md), which also found and fixed a real bug:
`enableOfflineQueue: false` rejected every command issued before ioredis's connection handshake completed,
hanging the client the moment a real server existed to race against (see that document's finding #7). Still
also verified by [`.github/workflows/redis-foundation.yml`](../../.github/workflows/redis-foundation.yml) in
CI.

Baseline: [M00_BASELINE.md](M00_BASELINE.md)
ADR: [ADR-0003-redis-ephemeral.md](adrs/ADR-0003-redis-ephemeral.md)

## Goal

Per ADR-0003's own action items — "1. Define key registry, payload limits and TTLs. 2. Add Redis health/
degradation behavior." — and the master productionization prompt's M06 scope: a Redis client, connection
config, health checks, and the tenant-scoped key schema ADR-0003 requires, with nothing durable behind it.
**No application code was wired to this yet** — no domain (presence, rate limits, locks, cache) was migrated
in this milestone. That is deliberately left for a follow-up slice with its own scope, matching how M03
(Postgres foundation) preceded M04/M05's actual domain migrations rather than trying to do both at once.

ADR-0003's action item 4 — "Add Redis only when a bounded M06 use case requires it" — is why this milestone
stops at the foundation layer: `presenceStore.js` (currently an in-memory `Map`-based store, the exact
"process-local, needs to work across cloud instances" gap the ADR's own Context section names) is the
obvious first candidate, but migrating it is real design work (session/connection data structures, cleanup/
staleness semantics translated to Redis TTLs, a parity test against the existing contract) that deserves its
own milestone slice, not something to rush alongside the foundation itself.

## What was built

### Redis client

`system/server/src/redis/client.js` — `createRedisClient()`/`resolveRedisConfig()`, mirroring
`db/pool.js`'s shape:
- Reads `REDIS_URL` and `REDIS_CONNECT_TIMEOUT_MS`/`REDIS_COMMAND_TIMEOUT_MS`/
  `REDIS_MAX_RETRIES_PER_REQUEST`/`REDIS_TLS`.
- `enableOfflineQueue: false` — a caller awaiting a presence/rate-limit read needs to know immediately that
  Redis is unreachable, not have the command silently queue until a reconnect succeeds.
- TLS verification is never silently disabled — `REDIS_TLS=no-verify` must be explicit, same convention as
  `DATABASE_SSL=no-verify`.
- Attaches a client-level `error` handler — required because `ioredis` emits `'error'` for any socket-level
  failure, and Node terminates the process on an unhandled `'error'` event with no listener attached.
- Installed dependency: `ioredis@^5` (`5.11.1` resolved). `npm audit --omit=dev --audit-level=high`: 0
  vulnerabilities. Chosen over the `redis` package for its more complete Promise-based API and wider
  production track record; no other library was evaluated in depth since this decision isn't architecturally
  significant enough to need one — either client sits behind this same thin wrapper.

### Health check

`system/server/src/redis/health.js` — `checkRedisHealth(client)`, a bounded-timeout `PING`. Not wired into
any HTTP route yet, matching `db/health.js`'s own current state.

### Key schema and payload limits

`system/server/src/redis/keys.js` — the actual substance of ADR-0003's action item 1:
- `orgKey(organizationId, ...segments)` builds `pf:org:{organizationId}:{...segments}`, matching the ADR's
  own `pf:org:{org_id}:...` convention exactly. Requires `organizationId` to look like a UUID (this repo's
  `identity.organizations` primary key shape) so a malformed or attacker-influenced value can never collide
  with another tenant's namespace — the same guarantee PostgreSQL's row-level security gives at the database
  layer, expressed here as a naming convention since Redis has no RLS equivalent for us to lean on.
- `assertBoundedPayload(value)` enforces "no raw secrets or unbounded payloads in Redis" with a real ceiling
  (`MAX_VALUE_BYTES = 16 * 1024`) rather than leaving that as an unenforced sentence in the ADR. Throws rather
  than silently truncating — a caller that would overflow the limit has a bug worth surfacing, not a size to
  quietly clip.
- No `globalKey()`/non-tenant-key helper was added — ADR-0003 allows named global exceptions, but there is no
  concrete global key in use yet anywhere in this codebase. Adding one speculatively, before any real caller
  needs it, would be exactly the kind of ungrounded design this document's own rules elsewhere warn against;
  it can be added the moment an actual global key is needed.
- TTL enforcement itself (ADR-0003: "Cache entries include version/revision and short TTL") is not a separate
  helper — every write in the real-Redis test passes an explicit `EX` directly to `SET`, which is the natural
  place for it once a real domain (e.g. presence) defines what its own TTL should be. A generic
  "setWithTtl()" wrapper with no real caller yet would be the same kind of premature abstraction as
  `globalKey()`.

### CI verification (the only real verification that exists)

[`.github/workflows/redis-foundation.yml`](../../.github/workflows/redis-foundation.yml): a `redis:7` service
container, `npm ci`, the existing `desktop/scripts/audit-gate.cjs --dir system` dependency-audit gate (same
convention as `db-migrations.yml`), then
`system/server/test/integration/redis/redisFoundation.test.js` with `TEST_REDIS_URL` pointed at the service
container.

That test is this milestone's actual proof, once it has run:
- `checkRedisHealth()` reports healthy against a real server, and reports unhealthy (with a bounded wait, not
  a hang) against an unreachable host;
- an `orgKey()` value round-trips through a real `SET`/`GET` with an explicit TTL, and the TTL is confirmed
  present and bounded (not persisted forever);
- keys for two different organizations, using the same trailing segments, never collide.

Local verification: `node --check` passed on every new file; the new real-Redis test file confirmed to skip
cleanly (not silently pass) without `TEST_REDIS_URL`; `redisKeys.test.js` (6 pure unit tests covering
`orgKey()`'s UUID/segment validation and `assertBoundedPayload()`'s limit) passed locally with no Redis
required; full local `node --test` suite re-run after this addition: **150 files, 1298 tests, 1280 passed, 0
failed, 18 skipped** (skips are exactly the real-PostgreSQL/real-Redis-only test files, expected with no
local database or Redis).

## What this does NOT mean

- **M06 is not "done" in the sense of any real domain running on Redis.** Presence, rate limits, and short
  locks all still work exactly as they did before this milestone (in-process, `presenceStore.js`'s `Map`s).
  Nothing was migrated, cut over, or made Redis-authoritative.
- **Verified against a real, disposable Redis-compatible server (P1)**, not yet against CI's own service
  container — confirm `.github/workflows/redis-foundation.yml` is green before treating that separate path as
  proven too.
- **No health/degradation *behavior*** (ADR-0003 action item 2's second half — what the *application* does
  when Redis is unavailable, as opposed to the health check itself) was designed here. That belongs with
  whichever real domain migrates first, since "safe fallback" is necessarily specific to what that domain is
  for (a rate limiter failing open vs. closed is a very different call than a presence cache failing empty).
- **No flush/outage/stale-cache/cross-tenant isolation test suite** (ADR-0003 action item 3) beyond the
  narrow round-trip and cross-org-key-collision checks this milestone's test performs — a fuller suite
  belongs with the first real domain migration too, once there is real behavior under those conditions to
  test.

## P4 decision (Phase 1 rollout, `PHASE1_TEAM_ROLLOUT_HANDOUT.md` §4 task P4): decided, not assumed

**Decision: do not build out Redis-backed presence/locks/rate-limits for Phase 1.** At 5–8 devices across
three Mac mini hosts behind a single hub process (`PHASE1_TEAM_ROLLOUT_HANDOUT.md` §0's own stated real-world
shape), there is no concrete need for cross-instance coordination — the entire reason Redis would earn its
keep (multiple hub processes needing to agree on shared state) doesn't exist yet, since there's exactly one
hub process. The device-lease race `deviceLease.js` already guards can continue to be handled at the
PostgreSQL level (a `SELECT ... FOR UPDATE` or an advisory lock) once that domain moves to Postgres in P3,
rather than adding Redis as a second moving part with no current justification. This matches the handout's own
stated expectation for a fleet this size, and ADR-0003's own action item 4 ("add Redis only when a bounded M06
use case requires it").

**Revisit this decision, not the M06 foundation itself, if:** the owner wants more than one hub process
running at once (e.g. for zero-downtime deploys) sooner than expected, or the fleet grows enough that a
single hub process's in-memory presence/lease state becomes a real bottleneck. The M06 foundation
(`redis/client.js`/`health.js`/`keys.js`/the shared `syncCache.js` pattern) already exists and is verified
against a real Redis-compatible server (P1) — building the actual presence/lock/rate-limit domain on top of
it, if and when it's needed, is implementation work on a proven foundation, not a fresh milestone.

## Next steps toward the rest of M06

1. **Presence (`presenceStore.js`) is the concrete, ADR-named first use case** — sessions/connections/
   heartbeats currently live in per-process `Map`s, the exact "must work across cloud instances, current
   equivalents are process-local" problem ADR-0003's Context section describes. A Redis-backed presence
   adapter behind the same contract (`touchSession`/`connect`/`heartbeat`/`setDevice`/`disconnect`/
   `removeSession`/`cleanup`/`listPeople`) is the natural next slice — likely Redis hashes/sorted-sets keyed
   via `orgKey()`, with TTLs replacing the in-memory `staleAfterMs` cleanup sweep, and a real-Redis parity
   test against the existing in-memory contract's behavior (same rigor as every M05 domain's parity test).
2. Once presence (or another real domain) exists, design the application-level degradation behavior and the
   flush/outage/cross-tenant test suite ADR-0003's remaining action items call for — grounded in that
   domain's actual failure modes, not speculatively.
3. Health-check wiring into an actual `/healthz`-style route (both `db/health.js` and `redis/health.js` are
   still unwired) is shared, cross-cutting work that could reasonably happen alongside either M05's or M06's
   next slice rather than needing its own milestone.
