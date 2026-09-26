import test from "node:test";
import assert from "node:assert/strict";
import { assertResearchRunRepository } from "../../src/persistence/researchRunRepository.js";
import { createFileResearchRunRepository } from "../../src/persistence/fileResearchRunRepository.js";
import * as researchStore from "../../src/researchStore.js";

test("research run repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertResearchRunRepository(null), /must be an object/);
  assert.throws(() => assertResearchRunRepository({}), /requires listRuns/);
  assert.throws(
    () => assertResearchRunRepository({ listRuns() {}, getRun() {}, createRun() {}, appendCandidate() {},
      locateCandidate() {}, recordPlatformAction() {}, finalizeRun() {} }),
    /requires setCandidateStatus/,
  );
});

test("file research run adapter delegates to the real researchStore.js functions by default", () => {
  const repository = createFileResearchRunRepository();
  assertResearchRunRepository(repository);
  // No behavior change: without overrides, every method IS the real
  // researchStore.js export, not a copy or a wrapper around it.
  assert.equal(repository.listRuns, researchStore.listRuns);
  assert.equal(repository.getRun, researchStore.getRun);
  assert.equal(repository.createRun, researchStore.createRun);
  assert.equal(repository.appendCandidate, researchStore.appendCandidate);
  assert.equal(repository.locateCandidate, researchStore.locateCandidate);
  assert.equal(repository.recordPlatformAction, researchStore.recordPlatformAction);
  assert.equal(repository.finalizeRun, researchStore.finalizeRun);
  assert.equal(repository.setCandidateStatus, researchStore.setCandidateStatus);
});

test("file research run adapter accepts injected overrides for tests", () => {
  const calls = [];
  const repository = createFileResearchRunRepository({
    listRuns: (workspaceId, account) => { calls.push(["listRuns", workspaceId, account]); return ["run-1"]; },
    createRun: (workspaceId, account, input) => { calls.push(["createRun", workspaceId, account, input]); return { id: "run-1" }; },
  });
  assert.deepEqual(repository.listRuns("client-a", "account-1"), ["run-1"]);
  assert.deepEqual(repository.createRun("client-a", "account-1", { platform: "reddit" }), { id: "run-1" });
  assert.deepEqual(calls, [
    ["listRuns", "client-a", "account-1"],
    ["createRun", "client-a", "account-1", { platform: "reddit" }],
  ]);
  // Non-overridden methods still fall through to the real implementation.
  assert.equal(repository.getRun, researchStore.getRun);
});
