import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertAssignmentRepository } from "../../src/persistence/assignmentRepository.js";
import { createFileAssignmentRepository } from "../../src/persistence/fileAssignmentRepository.js";

test("assignment repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertAssignmentRepository(null), /must be an object/);
  assert.throws(() => assertAssignmentRepository({}), /requires list/);
  assert.throws(
    () => assertAssignmentRepository({ list() {}, get() {}, create() {}, setStatus() {}, reassign() {},
      renamePrincipal() {}, reschedule() {} }),
    /requires expireDue/,
  );
});

test("file assignment adapter satisfies the contract and preserves store behavior", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignment-adapter-"));
  const storePath = path.join(directory, "assignments.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const repository = createFileAssignmentRepository({ storePath, now: () => new Date(clock), id: () => "assignment-1" });
  assertAssignmentRepository(repository);

  const created = repository.create({ instructions: "Check device health", assignee: "va-1", createdBy: "manager-1" });
  assert.equal(created.id, "assignment-1");
  assert.equal(created.status, "assigned");
  assert.deepEqual(repository.list().map((entry) => entry.id), ["assignment-1"]);
  assert.equal(repository.get("assignment-1")?.assignee, "va-1");

  clock += 60_000;
  const inProgress = repository.setStatus("assignment-1", "in_progress", "va-1");
  assert.equal(inProgress.status, "in_progress");

  clock += 60_000;
  const reassigned = repository.reassign("assignment-1", "va-2", "manager-1");
  assert.equal(reassigned.assignee, "va-2");
  assert.equal(reassigned.status, "assigned");

  const renamed = repository.renamePrincipal("va-2", "va-2-renamed", "manager-1");
  assert.equal(renamed.length, 1);
  assert.equal(repository.get("assignment-1").assignee, "va-2-renamed");

  clock += 60_000;
  const rescheduled = repository.reschedule("assignment-1", { startAt: null, endAt: null, exclusive: true }, "manager-1");
  assert.equal(rescheduled.startAt, null);

  const expired = repository.expireDue(new Date(clock + 10_000));
  assert.deepEqual(expired, []); // no schedule set, so nothing is due

  // Persisted to the real file, so a fresh adapter over the same path sees prior writes.
  const reopened = createFileAssignmentRepository({ storePath, now: () => new Date(clock) });
  assert.deepEqual(reopened.list().map((entry) => entry.id), ["assignment-1"]);
});

test("file assignment adapter can wrap an already-constructed store for injection", async () => {
  const { createAssignmentStore } = await import("../../src/assignmentStore.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignment-inject-"));
  try {
    const store = createAssignmentStore({ storePath: path.join(directory, "assignments.json") });
    const repository = createFileAssignmentRepository(store);
    assertAssignmentRepository(repository);
    repository.create({ instructions: "Injected task", assignee: "va-1", createdBy: "manager-1" });
    assert.equal(repository.list().length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
