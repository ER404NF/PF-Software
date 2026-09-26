import test from "node:test";
import assert from "node:assert/strict";
import { assertPolicyRepository } from "../../src/persistence/policyRepository.js";
import { createFilePolicyRepository } from "../../src/persistence/filePolicyRepository.js";
import { POLICY_VALUES } from "../../src/actionPolicy.js";

test("policy repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertPolicyRepository(null), /must be an object/);
  assert.throws(() => assertPolicyRepository({}), /requires set/);
  assert.throws(() => assertPolicyRepository({ set() {}, clear() {}, effective() {} }), /requires describe/);
});

test("file policy adapter satisfies the contract and preserves store behavior", () => {
  const repository = createFilePolicyRepository({ now: () => "2026-09-26T00:00:00.000Z" });
  assertPolicyRepository(repository);

  const entry = repository.set("acct-1", "like", POLICY_VALUES.ALLOW_AUTONOMOUS, "admin1");
  assert.equal(entry.value, POLICY_VALUES.ALLOW_AUTONOMOUS);
  assert.equal(entry.by, "admin1");

  const effective = repository.effective(new Map());
  assert.equal(effective.get("acct-1").like, POLICY_VALUES.ALLOW_AUTONOMOUS);

  const described = repository.describe("acct-1", new Map());
  const likeEntry = described.find((item) => item.action === "like");
  assert.equal(likeEntry.policy, POLICY_VALUES.ALLOW_AUTONOMOUS);
  assert.equal(likeEntry.source, "runtime");

  repository.clear("acct-1", "like");
  assert.equal(repository.describe("acct-1", new Map()).find((item) => item.action === "like").source, "default");
});

test("file policy adapter can wrap an already-constructed store for injection", async () => {
  const { PolicyStore } = await import("../../src/policyStore.js");
  const store = new PolicyStore();
  const repository = createFilePolicyRepository(store);
  assertPolicyRepository(repository);
  repository.set("acct-2", "comment_preset", POLICY_VALUES.REQUIRE_APPROVAL, "admin2");
  assert.equal(store.overrides["acct-2"].comment_preset.value, POLICY_VALUES.REQUIRE_APPROVAL);
});
