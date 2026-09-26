import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertTaskQueueSnapshotRepository } from "../../src/persistence/taskQueueSnapshotRepository.js";
import { createFileTaskQueueSnapshotRepository } from "../../src/persistence/fileTaskQueueSnapshotRepository.js";
import { TASK_STATES, createTaskSpec } from "../../src/taskSpec.js";

function task(overrides = {}) {
  return { ...createTaskSpec({ goal: "check device health" }), ...overrides };
}

test("task queue snapshot repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertTaskQueueSnapshotRepository(null), /must be an object/);
  assert.throws(() => assertTaskQueueSnapshotRepository({}), /requires load/);
  assert.throws(() => assertTaskQueueSnapshotRepository({ load() {} }), /requires save/);
});

test("file adapter requires a storePath", () => {
  assert.throws(() => createFileTaskQueueSnapshotRepository(), /requires a storePath/);
  assert.throws(() => createFileTaskQueueSnapshotRepository(""), /requires a storePath/);
});

test("file adapter round-trips a snapshot and reports an empty one when the file does not exist yet", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-queue-snapshot-"));
  const storePath = path.join(directory, "tasks.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = createFileTaskQueueSnapshotRepository(storePath);
  assertTaskQueueSnapshotRepository(repository);

  assert.deepEqual(repository.load(), { tasks: [], paused: false, humanHolds: new Set() });

  const fixture = task();
  repository.save([fixture], true, new Set(["device-1"]));

  const reloaded = repository.load();
  assert.deepEqual(reloaded.tasks, [fixture]);
  assert.equal(reloaded.paused, true);
  assert.deepEqual([...reloaded.humanHolds], ["device-1"]);

  const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(onDisk.version, 2);
});

test("file adapter recovers a task that was RUNNING when the process died, per its retry policy", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-queue-snapshot-recover-"));
  const storePath = path.join(directory, "tasks.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(storePath, JSON.stringify({
    version: 2, paused: false, humanHolds: [],
    tasks: [task({ state: TASK_STATES.RUNNING, retryPolicy: { maxRetries: 1, backoffMs: 0 },
      deviceSelector: { deviceId: "device-1" } })],
  }));

  const repository = createFileTaskQueueSnapshotRepository(storePath);
  const { tasks } = repository.load();
  assert.equal(tasks[0].state, TASK_STATES.QUEUED, "requeued because retryCount (1) is within maxRetries");
  assert.equal(tasks[0].retryCount, 1);
  assert.equal(tasks[0].result.outcome, "interrupted_by_restart");

  // The recovery write is persisted, not just held in memory.
  const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(onDisk.tasks[0].state, TASK_STATES.QUEUED);
});

test("file adapter migrates a legacy bare-array snapshot on load", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-queue-snapshot-legacy-"));
  const storePath = path.join(directory, "tasks.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacyTask = task();
  delete legacyTask.kind; // legacy array snapshots predate the kind/maxDurationSec fields
  delete legacyTask.maxDurationSec;
  fs.writeFileSync(storePath, JSON.stringify([legacyTask]));

  const repository = createFileTaskQueueSnapshotRepository(storePath);
  const { tasks, paused, humanHolds } = repository.load();
  assert.equal(tasks[0].kind, "generic", "legacy snapshots default to kind: generic");
  assert.equal(paused, false);
  assert.deepEqual([...humanHolds], []);

  const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(onDisk.version, 2, "the migrated shape is persisted, not just returned in memory");
});
