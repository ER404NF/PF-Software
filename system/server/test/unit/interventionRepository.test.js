import test from "node:test";
import assert from "node:assert/strict";
import { assertInterventionRepository } from "../../src/persistence/interventionRepository.js";
import { createFileInterventionRepository } from "../../src/persistence/fileInterventionRepository.js";
import { INTERVENTION_STATES } from "../../src/interventionQueue.js";

test("intervention repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertInterventionRepository(null), /must be an object/);
  assert.throws(() => assertInterventionRepository({}), /requires open/);
  assert.throws(
    () => assertInterventionRepository({ open() {}, claim() {}, resolve() {}, resolveForTask() {}, list() {} }),
    /requires counts/,
  );
});

test("file intervention adapter satisfies the contract and preserves InterventionQueue behavior", () => {
  const repository = createFileInterventionRepository({ filePath: null, now: () => 5000 });
  assertInterventionRepository(repository);

  const opened = repository.open({ taskId: "task-1", workspaceId: "client-a", reason: "captcha detected" });
  assert.equal(opened.state, INTERVENTION_STATES.OPEN);
  assert.equal(repository.list({ workspaceId: "client-a" }).length, 1);
  assert.deepEqual(repository.counts(), { OPEN: 1, CLAIMED: 0, RESOLVED: 0 });

  const claimed = repository.claim(opened.id, "manager-1");
  assert.equal(claimed.state, INTERVENTION_STATES.CLAIMED);

  const resolved = repository.resolve(opened.id, { by: "manager-1", resolution: "handled" });
  assert.equal(resolved.state, INTERVENTION_STATES.RESOLVED);
  assert.deepEqual(repository.counts(), { OPEN: 0, CLAIMED: 0, RESOLVED: 1 });
});

test("file intervention adapter's resolveForTask closes every open item for a task", () => {
  const repository = createFileInterventionRepository({ filePath: null, now: () => 5000 });
  repository.open({ taskId: "task-1", kind: "low_confidence", reason: "low confidence" });
  repository.open({ taskId: "task-1", kind: "challenge", reason: "captcha" });
  const closed = repository.resolveForTask("task-1", { by: "system", resolution: "task moved on" });
  assert.equal(closed, 2);
  assert.deepEqual(repository.counts(), { OPEN: 0, CLAIMED: 0, RESOLVED: 2 });
});

test("file intervention adapter can wrap an already-constructed queue for injection", async () => {
  const { InterventionQueue } = await import("../../src/interventionQueue.js");
  const queue = new InterventionQueue({ filePath: null });
  const repository = createFileInterventionRepository(queue);
  assertInterventionRepository(repository);
  repository.open({ taskId: "task-2", reason: "unconfirmed action" });
  assert.equal(repository.list().length, 1);
});
