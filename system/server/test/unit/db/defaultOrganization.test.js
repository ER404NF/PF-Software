import test from "node:test";
import assert from "node:assert/strict";
import { ensureDefaultOrganization, DEFAULT_ORGANIZATION_SLUG, DEFAULT_ORGANIZATION_DISPLAY_NAME } from "../../../src/db/defaultOrganization.js";

function fakePool(rows) {
  const calls = [];
  return { calls, query: async (text, params) => { calls.push({ text, params }); return { rows }; } };
}

test("ensureDefaultOrganization upserts on the well-known slug with ON CONFLICT, never a check-then-insert race", async () => {
  const pool = fakePool([{ id: "org-1", slug: DEFAULT_ORGANIZATION_SLUG }]);
  const org = await ensureDefaultOrganization(pool);
  assert.equal(org.id, "org-1");
  assert.match(pool.calls[0].text, /ON CONFLICT \(slug\) DO UPDATE/);
  assert.deepEqual(pool.calls[0].params, [DEFAULT_ORGANIZATION_SLUG, DEFAULT_ORGANIZATION_DISPLAY_NAME]);
});

test("ensureDefaultOrganization accepts an overridden slug/displayName", async () => {
  const pool = fakePool([{ id: "org-2", slug: "custom" }]);
  await ensureDefaultOrganization(pool, { slug: "custom", displayName: "Custom Org" });
  assert.deepEqual(pool.calls[0].params, ["custom", "Custom Org"]);
});
