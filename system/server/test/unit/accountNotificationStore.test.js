import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { createAccountNotificationStore } from "../../src/accountNotificationStore.js";

test("account notifications persist approval, rejection, and recovery messages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-notifications-"));
  const storePath = path.join(root, "accounts.json");
  try {
    const recoveryToken = crypto.randomBytes(32).toString("base64url");
    const store = createAccountNotificationStore({
      storePath,
      companyEmail: "accounts@example.test",
      encryptionKey: crypto.randomBytes(32).toString("base64url"),
    });
    const accepted = store.queue({ to: "person@gmail.com", fullName: "Test Person", username: "person", status: "approved" });
    store.queue({ to: "other@gmail.com", fullName: "Other Person", username: "other", status: "rejected" });
    const recovery = store.queue({ to: "person@gmail.com", fullName: "Test Person", username: "person", status: "recovery", recoveryToken });
    assert.equal(accepted.deliveryState, "queued");
    assert.equal(accepted.from, "accounts@example.test");
    const saved = store.list();
    assert.equal(saved.length, 3);
    assert.deepEqual(new Set(saved.map(item => item.kind)), new Set(["account_approved", "account_rejected", "account_recovery"]));
    const persisted = fs.readFileSync(storePath, "utf8");
    assert.equal(persisted.includes(recoveryToken), false);
    assert.equal("body" in saved.find(item => item.kind === "account_recovery"), false);
    assert.equal(store.deliveryContent(recovery.id).body.endsWith(recoveryToken), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery notifications fail closed without an encryption key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-notifications-"));
  try {
    const store = createAccountNotificationStore({ storePath: path.join(root, "accounts.json") });
    const recoveryToken = crypto.randomBytes(32).toString("base64url");
    assert.equal(store.canSecureRecovery(), false);
    assert.throws(() => store.queue({
      to: "person@gmail.com",
      fullName: "Test Person",
      username: "person",
      status: "recovery",
      recoveryToken,
    }), /secure recovery notification storage/);
    assert.equal(fs.existsSync(path.join(root, "accounts.json")), false);
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

test("account review notifications remain held until their account commit is recorded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-notifications-"));
  try {
    const store = createAccountNotificationStore({ storePath: path.join(root, "accounts.json") });
    const committed = store.queue({ to: "person@gmail.com", fullName: "Test Person", username: "person",
      status: "approved", holdForCommit: true });
    const aborted = store.queue({ to: "other@gmail.com", fullName: "Other Person", username: "other",
      status: "rejected", holdForCommit: true });
    assert.equal(committed.deliveryState, "pending_account_commit");
    assert.equal(store.markCommitted(committed.id).deliveryState, "awaiting_sender_configuration");
    assert.equal(store.markAborted(aborted.id).deliveryState, "aborted_account_change");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
