import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNotificationRepository } from "../../src/persistence/notificationRepository.js";
import { createFileNotificationRepository } from "../../src/persistence/fileNotificationRepository.js";

test("notification repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertNotificationRepository(null), /must be an object/);
  assert.throws(() => assertNotificationRepository({}), /requires queue/);
  assert.throws(
    () => assertNotificationRepository({ queue() {}, list() {}, deliveryContent() {}, markCommitted() {},
      markAborted() {}, markSent() {}, markFailed() {} }),
    /requires canSecureRecovery/,
  );
});

test("file notification adapter satisfies the contract and preserves store behavior", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-notification-adapter-"));
  const storePath = path.join(directory, "notifications.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = createFileNotificationRepository({ storePath, companyEmail: "hello@example.com" });
  assertNotificationRepository(repository);

  const queued = repository.queue({ to: "va@example.com", fullName: "VA One", username: "va1", status: "approved" });
  assert.equal(queued.deliveryState, "queued");
  assert.equal(repository.list().length, 1);
  assert.equal(repository.canSecureRecovery(), false);

  const sent = repository.markSent(queued.id);
  assert.equal(sent.deliveryState, "sent");
  const content = repository.deliveryContent(queued.id);
  assert.match(content.body, /VA One/);
});

test("file notification adapter can wrap an already-constructed store for injection", async () => {
  const { createAccountNotificationStore } = await import("../../src/accountNotificationStore.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-notification-inject-"));
  try {
    const store = createAccountNotificationStore({ storePath: path.join(directory, "notifications.json") });
    const repository = createFileNotificationRepository(store);
    assertNotificationRepository(repository);
    repository.queue({ to: "va@example.com", fullName: "VA Two", username: "va2", status: "rejected" });
    assert.equal(repository.list().length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
