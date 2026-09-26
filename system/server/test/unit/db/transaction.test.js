import test from "node:test";
import assert from "node:assert/strict";
import { withTransaction, TenantContextError } from "../../../src/db/transaction.js";

function fakePool() {
  const calls = [];
  let released = false;
  const client = {
    query: async (text, params) => { calls.push([text, params]); },
    release: () => { released = true; },
  };
  return { pool: { connect: async () => client }, calls, isReleased: () => released };
}

test("withTransaction requires a function", async () => {
  const { pool } = fakePool();
  await assert.rejects(() => withTransaction(pool, null), TypeError);
});

test("withTransaction rejects a non-UUID organizationId without opening a connection", async () => {
  const { pool } = fakePool();
  await assert.rejects(
    () => withTransaction(pool, async () => {}, { organizationId: "not-a-uuid" }),
    TenantContextError,
  );
});

test("withTransaction runs BEGIN, the callback, then COMMIT, and always releases the client", async () => {
  const { pool, calls, isReleased } = fakePool();
  const result = await withTransaction(pool, async (client) => {
    calls.push(["callback", client]);
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(calls[0][0], "BEGIN");
  assert.equal(calls.at(-1)[0], "COMMIT");
  assert.equal(isReleased(), true);
});

test("withTransaction sets the tenant GUC via parameterized set_config, never string interpolation", async () => {
  const { pool, calls } = fakePool();
  const organizationId = "11111111-1111-1111-1111-111111111111";
  await withTransaction(pool, async () => {}, { organizationId });
  const setConfigCall = calls.find(([text]) => text.includes("set_config"));
  assert.ok(setConfigCall, "expected a set_config call");
  assert.equal(setConfigCall[0], "SELECT set_config('app.current_organization_id', $1, true)");
  assert.deepEqual(setConfigCall[1], [organizationId]);
});

test("withTransaction sets both GUCs when both organizationId and userId are given", async () => {
  const { pool, calls } = fakePool();
  const organizationId = "11111111-1111-1111-1111-111111111111";
  const userId = "22222222-2222-2222-2222-222222222222";
  await withTransaction(pool, async () => {}, { organizationId, userId });
  const setConfigCalls = calls.filter(([text]) => text.includes("set_config"));
  assert.equal(setConfigCalls.length, 2);
  assert.ok(setConfigCalls.some(([text, params]) => text.includes("app.current_organization_id") && params[0] === organizationId));
  assert.ok(setConfigCalls.some(([text, params]) => text.includes("app.current_user_id") && params[0] === userId));
});

test("withTransaction rejects a non-UUID userId without opening a connection", async () => {
  const { pool } = fakePool();
  await assert.rejects(
    () => withTransaction(pool, async () => {}, { userId: "not-a-uuid" }),
    TenantContextError,
  );
});

test("withTransaction rolls back and re-throws when the callback fails, and still releases the client", async () => {
  const { pool, calls, isReleased } = fakePool();
  await assert.rejects(
    () => withTransaction(pool, async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.ok(calls.some(([text]) => text === "ROLLBACK"));
  assert.ok(!calls.some(([text]) => text === "COMMIT"));
  assert.equal(isReleased(), true);
});

test("withTransaction releases the client even when ROLLBACK itself fails", async () => {
  let released = false;
  const client = {
    query: async (text) => { if (text === "ROLLBACK") throw new Error("connection already closed"); },
    release: () => { released = true; },
  };
  const pool = { connect: async () => client };
  await assert.rejects(
    () => withTransaction(pool, async () => { throw new Error("original failure"); }),
    /original failure/,
  );
  assert.equal(released, true);
});
