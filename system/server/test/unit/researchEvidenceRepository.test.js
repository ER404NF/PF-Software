import test from "node:test";
import assert from "node:assert/strict";
import { assertResearchEvidenceRepository } from "../../src/persistence/researchEvidenceRepository.js";
import { createFileResearchEvidenceRepository } from "../../src/persistence/fileResearchEvidenceRepository.js";
import * as researchEvidenceStore from "../../src/researchEvidenceStore.js";

test("research evidence repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertResearchEvidenceRepository(null), /must be an object/);
  assert.throws(() => assertResearchEvidenceRepository({}), /requires save/);
  assert.throws(() => assertResearchEvidenceRepository({ save() {} }), /requires resolve/);
});

test("file research evidence adapter delegates to the real researchEvidenceStore.js functions by default", () => {
  const repository = createFileResearchEvidenceRepository();
  assertResearchEvidenceRepository(repository);
  assert.equal(repository.save, researchEvidenceStore.saveResearchEvidence);
  assert.equal(repository.resolve, researchEvidenceStore.resolveResearchEvidence);
});

test("file research evidence adapter accepts injected overrides for tests", () => {
  const calls = [];
  const repository = createFileResearchEvidenceRepository({
    save: (workspaceId, accountId, frame) => { calls.push(["save", workspaceId, accountId, frame]); return { id: "evidence-1" }; },
  });
  assert.deepEqual(repository.save("client-a", "account-1", { mime: "image/png" }), { id: "evidence-1" });
  assert.deepEqual(calls, [["save", "client-a", "account-1", { mime: "image/png" }]]);
  assert.equal(repository.resolve, researchEvidenceStore.resolveResearchEvidence);
});
