import test from "node:test";
import assert from "node:assert/strict";
import { createIdentitySessionRepository } from "../../../src/db/repositories/identitySessionRepository.js";
import { createIdentitySessionService } from "../../../src/services/identitySessionService.js";

function fakePool(rowsByCall = []) {
  const calls = [];
  let index = 0;
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      const rows = rowsByCall[index] ?? [];
      index += 1;
      return { rows, rowCount: rows.length };
    },
  };
}

test("identitySessionRepository requires a queryable pool", () => {
  assert.throws(() => createIdentitySessionRepository(null), TypeError);
});

test("identitySessionRepository.create inserts the hashed token, never a raw one", async () => {
  const pool = fakePool([[{ id: "session-1", token_hash: "abc" }]]);
  const repository = createIdentitySessionRepository(pool);
  await repository.create({ userId: "user-1", tokenHash: "abc", expiresAt: new Date("2026-01-01") });
  assert.match(pool.calls[0].text, /INSERT INTO identity\.sessions/);
  assert.deepEqual(pool.calls[0].params, ["user-1", "abc", new Date("2026-01-01"), null, null, null]);
});

test("identitySessionService requires a repository", () => {
  assert.throws(() => createIdentitySessionService({}), TypeError);
});

function fakeRepository() {
  const sessions = new Map();
  let nextId = 1;
  return {
    sessions,
    async create({ userId, tokenHash, expiresAt, ip, userAgent, deviceLabel }) {
      const id = `session-${nextId++}`;
      const row = { id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, ip, user_agent: userAgent,
        device_label: deviceLabel, revoked_at: null, last_seen_at: null, created_at: new Date() };
      sessions.set(id, row);
      return row;
    },
    async getByTokenHash(tokenHash) {
      return [...sessions.values()].find((row) => row.token_hash === tokenHash) ?? null;
    },
    async touch(id, at) {
      const row = sessions.get(id);
      if (row) row.last_seen_at = at;
    },
    async revoke(id) {
      const row = sessions.get(id);
      if (row && !row.revoked_at) row.revoked_at = new Date();
      return row ?? null;
    },
    async revokeAllForUser(userId) {
      let count = 0;
      for (const row of sessions.values()) {
        if (row.user_id === userId && !row.revoked_at) { row.revoked_at = new Date(); count += 1; }
      }
      return count;
    },
    async listActiveForUser(userId) {
      return [...sessions.values()].filter((row) => row.user_id === userId && !row.revoked_at && row.expires_at > new Date());
    },
  };
}

test("issueSession returns a token once and only stores its hash", async () => {
  const repository = fakeRepository();
  const service = createIdentitySessionService({ repository });
  const { token, session } = await service.issueSession({ userId: "user-1" });
  assert.match(token, /^pfu_/);
  assert.notEqual(session.token_hash, token, "the stored hash must not equal the raw token");
  assert.equal(session.token_hash.length, 64, "sha256 hex digest is 64 characters");
});

test("verifySession accepts a fresh, unrevoked token and rejects everything else", async () => {
  const repository = fakeRepository();
  const service = createIdentitySessionService({ repository });
  const { token, session } = await service.issueSession({ userId: "user-1" });

  assert.equal((await service.verifySession(token))?.id, session.id);
  assert.equal(await service.verifySession("pfu_wrong-token-entirely"), null);
  assert.equal(await service.verifySession("not-even-the-right-prefix"), null);

  await service.revokeSession(session.id);
  assert.equal(await service.verifySession(token), null, "a revoked session must not verify");
});

test("verifySession rejects an expired session even if it was never revoked", async () => {
  const repository = fakeRepository();
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const service = createIdentitySessionService({ repository, now: () => clock });
  const { token } = await service.issueSession({ userId: "user-1", ttlMs: 1000 });

  assert.notEqual(await service.verifySession(token), null);
  clock = new Date(clock.getTime() + 2000);
  assert.equal(await service.verifySession(token), null);
});

test("revokeAllSessionsForUser revokes every active session for that user only", async () => {
  const repository = fakeRepository();
  const service = createIdentitySessionService({ repository });
  const a = await service.issueSession({ userId: "user-1" });
  const b = await service.issueSession({ userId: "user-1" });
  const other = await service.issueSession({ userId: "user-2" });

  const count = await service.revokeAllSessionsForUser("user-1");
  assert.equal(count, 2);
  assert.equal(await service.verifySession(a.token), null);
  assert.equal(await service.verifySession(b.token), null);
  assert.notEqual(await service.verifySession(other.token), null, "another user's session must be untouched");
});

test("listActiveSessions excludes revoked and expired sessions", async () => {
  // The fake repository's active-filter checks the real wall clock (as the
  // real PostgreSQL repository's `expires_at > now()` does at the database
  // level, independent of any injected service clock) — so this test uses
  // the service's default real clock too, and a genuinely-already-elapsed
  // ttlMs, rather than an injected fake `now` that would desync from it.
  const repository = fakeRepository();
  const service = createIdentitySessionService({ repository });
  const active = await service.issueSession({ userId: "user-1" });
  const alreadyExpired = await service.issueSession({ userId: "user-1", ttlMs: -1000 });
  const revoked = await service.issueSession({ userId: "user-1" });
  await service.revokeSession(revoked.session.id);

  const listed = await service.listActiveSessions("user-1");
  assert.deepEqual(listed.map((s) => s.id).sort(), [active.session.id].sort());
  assert.ok(!listed.some((s) => s.id === alreadyExpired.session.id));
  assert.ok(!listed.some((s) => s.id === revoked.session.id));
});
