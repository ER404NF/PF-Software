import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createAccountNotificationStore } from "../../src/accountNotificationStore.js";

test("account notifications persist approval, rejection, and recovery messages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-notifications-"));
  const storePath = path.join(root, "accounts.json");
  try {
    const store = createAccountNotificationStore({ storePath, companyEmail: "accounts@example.test" });
    const accepted = store.queue({ to: "person@gmail.com", fullName: "Test Person", username: "person", status: "approved" });
    store.queue({ to: "other@gmail.com", fullName: "Other Person", username: "other", status: "rejected" });
    store.queue({ to: "person@gmail.com", fullName: "Test Person", username: "person", status: "recovery", recoveryToken: "secret-token" });
    assert.equal(accepted.deliveryState, "queued");
    assert.equal(accepted.from, "accounts@example.test");
    const saved = store.list();
    assert.equal(saved.length, 3);
    assert.deepEqual(new Set(saved.map(item => item.kind)), new Set(["account_approved", "account_rejected", "account_recovery"]));
    assert.match(saved.find(item => item.kind === "account_recovery").body, /secret-token/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("notifications wait when the company sender is not configured", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-notifications-"));
  try {
    const store = createAccountNotificationStore({ storePath: path.join(root, "accounts.json") });
    const item = store.queue({ to: "person@gmail.com", fullName: "Test Person", username: "person", status: "approved" });
    assert.equal(item.deliveryState, "awaiting_sender_configuration");
    assert.equal(item.from, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
