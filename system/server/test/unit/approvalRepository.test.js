import test from "node:test";
import assert from "node:assert/strict";
import { assertApprovalRepository } from "../../src/persistence/approvalRepository.js";
import { createFileApprovalRepository } from "../../src/persistence/fileApprovalRepository.js";
import { APPROVAL_STATES } from "../../src/approvalStore.js";

test("approval repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertApprovalRepository(null), /must be an object/);
  assert.throws(() => assertApprovalRepository({}), /requires request/);
  assert.throws(
    () => assertApprovalRepository({ request() {}, decide() {}, findApproved() {}, consume() {}, get() {} }),
    /requires list/,
  );
});

test("file approval adapter satisfies the contract and preserves ApprovalStore behavior", () => {
  let clock = 1000;
  const repository = createFileApprovalRepository({ filePath: null, now: () => clock, ttlMs: 60_000 });
  assertApprovalRepository(repository);

  const requested = repository.request({ workspaceId: "client-a", accountId: "account-1", action: "comment",
    target: "post-1", commentText: "nice post" });
  assert.equal(requested.state, APPROVAL_STATES.PENDING);
  assert.equal(repository.get(requested.id)?.id, requested.id);
  assert.equal(repository.list({ workspaceId: "client-a" }).length, 1);

  const decided = repository.decide(requested.id, { decision: "approve", decidedBy: "manager-1" });
  assert.equal(decided.state, APPROVAL_STATES.APPROVED);
  assert.equal(repository.findApproved({ workspaceId: "client-a", accountId: "account-1", action: "comment",
    target: "post-1", commentText: "nice post" })?.id, requested.id);

  const consumed = repository.consume(requested.id);
  assert.equal(consumed.state, APPROVAL_STATES.CONSUMED);
});

test("file approval adapter can wrap an already-constructed store for injection", async () => {
  const { ApprovalStore } = await import("../../src/approvalStore.js");
  const store = new ApprovalStore({ filePath: null });
  const repository = createFileApprovalRepository(store);
  assertApprovalRepository(repository);
  const requested = repository.request({ workspaceId: "client-a", accountId: "account-1", action: "like", target: "post-2" });
  assert.equal(repository.get(requested.id)?.id, requested.id);
});
