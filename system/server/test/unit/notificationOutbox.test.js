import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createAccountNotificationStore } from "../../src/accountNotificationStore.js";
import { createNotificationOutbox } from "../../src/notificationOutbox.js";

function setup({ companyEmail = "noreply@example.com" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-outbox-"));
  const storePath = path.join(root, "notifications.json");
  const store = createAccountNotificationStore({ storePath, companyEmail, encryptionKey: "test-key" });
  return { root, storePath, store };
}

test("a queued notification is delivered after SMTP becomes available", async t => {
  const { root, storePath, store } = setup({ companyEmail: null });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const item = store.queue({ to: "person@example.com", fullName: "Person", username: "person", status: "approved" });
  assert.equal(item.deliveryState, "awaiting_sender_configuration");

  const restartedStore = createAccountNotificationStore({ storePath, companyEmail: "noreply@example.com", encryptionKey: "test-key" });
  const sent = [];
  const outbox = createNotificationOutbox({
    store: restartedStore,
    mailSender: { isConfigured: () => true, send: async message => { sent.push(message); } },
  });
  await outbox.drain();

  assert.equal(sent.length, 1);
  assert.equal(restartedStore.list()[0].deliveryState, "sent");
});

test("a failed record from the previous implementation is reconciled immediately", async t => {
  const { root, store } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const item = store.queue({ to: "person@example.com", fullName: "Person", username: "person", status: "approved" });
  store.markFailed(item.id);
  let sends = 0;
  const outbox = createNotificationOutbox({
    store,
    mailSender: { isConfigured: () => true, send: async () => { sends += 1; } },
  });

  await outbox.drain();
  assert.equal(sends, 1);
  assert.equal(store.list()[0].deliveryState, "sent");
});

test("failed delivery observes exponential backoff and stops at the configured limit", async t => {
  const { root, store } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = new Date("2026-01-01T00:00:00.000Z");
  let attempts = 0;
  store.queue({ to: "person@example.com", fullName: "Person", username: "person", status: "approved" });
  const outbox = createNotificationOutbox({
    store, now: () => clock, maxAttempts: 2, baseDelayMs: 1_000,
    mailSender: { isConfigured: () => true, send: async () => { attempts += 1; throw new Error("secret transport failure"); } },
  });

  await outbox.drain();
  assert.equal(attempts, 1);
  assert.equal(store.list()[0].nextAttemptAt, "2026-01-01T00:00:01.000Z");
  await outbox.drain();
  assert.equal(attempts, 1, "retry is not attempted before its durable deadline");
  clock = new Date("2026-01-01T00:00:01.000Z");
  await outbox.drain();
  assert.equal(attempts, 2);
  assert.equal(store.list()[0].deliveryState, "permanently_failed");
  assert.equal(store.list()[0].nextAttemptAt, null, "the permanent failure is no longer eligible");
  assert.ok(store.list()[0].retryExhaustedAt);
  clock = new Date("2026-01-02T00:00:00.000Z");
  await outbox.drain();
  assert.equal(attempts, 2);
});

test("manual retry grants an exhausted message one new bounded attempt cycle and preserves history", async t => {
  const { root, store } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = new Date("2026-01-01T00:00:00.000Z");
  let shouldFail = true;
  let sends = 0;
  const item = store.queue({ to: "person@example.com", fullName: "Person", username: "person", status: "approved" });
  const outbox = createNotificationOutbox({
    store, now: () => clock, maxAttempts: 1,
    mailSender: { isConfigured: () => true, send: async () => { sends += 1; if (shouldFail) throw new Error("temporary"); } },
  });
  await outbox.drain();
  assert.equal(store.list()[0].deliveryState, "permanently_failed");
  assert.equal(store.claimNext({ id: item.id, maxAttempts: 1 }), null, "automatic retry remains exhausted");

  assert.equal(store.retryEligible({ id: item.id }), 1);
  const reset = store.list()[0];
  assert.equal(reset.attemptCount, 1, "cumulative attempt history is retained");
  assert.equal(reset.attemptCycleCount, 0);
  assert.equal(reset.manualRetryCount, 1);
  assert.ok(reset.retryExhaustedAt, "the earlier exhausted cycle remains auditable");
  shouldFail = false;
  clock = new Date("2026-01-01T00:01:00.000Z");
  await outbox.drain();
  assert.equal(sends, 2);
  assert.equal(store.list()[0].deliveryState, "sent");
  assert.equal(store.list()[0].attemptCount, 2);
});

test("concurrent workers cannot send the same durable notification twice", async t => {
  const { root, store } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.queue({ to: "person@example.com", fullName: "Person", username: "person", status: "approved" });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let sends = 0;
  const mailSender = { isConfigured: () => true, send: async () => { sends += 1; await blocked; } };
  const first = createNotificationOutbox({ store, mailSender });
  const second = createNotificationOutbox({ store, mailSender });

  const firstDrain = first.drain();
  await new Promise(resolve => setImmediate(resolve));
  await second.drain();
  assert.equal(sends, 1);
  release();
  await firstDrain;
  assert.equal(store.list()[0].deliveryState, "sent");
});

test("recovery content and claim tokens never appear in public outbox state", async t => {
  const { root, store } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.queue({
    to: "person@example.com", fullName: "Person", username: "person", status: "recovery",
    recoveryToken: "private-recovery-token",
  });
  const claim = store.claimNext();
  const publicState = JSON.stringify(store.list());
  assert.doesNotMatch(publicState, /private-recovery-token|securePayload|claimToken|ciphertext|body/);
  assert.match(claim.body, /private-recovery-token/);
});

test("an expired claim is recovered, documenting the accepted-before-completion at-least-once boundary", async t => {
  const { root, store } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const item = store.queue({ to: "person@example.com", fullName: "Person", username: "person", status: "approved" });
  const first = store.claimNext({ now: new Date("2026-01-01T00:00:00Z"), leaseMs: 1_000 });
  // If SMTP accepted this first attempt and the worker died before calling
  // completeClaim(), storage cannot distinguish that from a crash before the
  // send. Reclaiming is therefore deliberately at-least-once; provider-side
  // idempotency is required where a provider offers it.
  const second = store.claimNext({ now: new Date("2026-01-01T00:00:02Z"), leaseMs: 1_000 });
  assert.notEqual(first.claimToken, second.claimToken);
  assert.equal(second.attemptCount, 2);
  const stale = store.completeClaim(item.id, first.claimToken, { sent: true });
  assert.equal(stale.deliveryState, "sending");
  const current = store.completeClaim(item.id, second.claimToken, { sent: true });
  assert.equal(current.deliveryState, "sent");
});

test("restart preserves queued notifications and idempotency prevents duplicate lifecycle mail", async t => {
  const { root, storePath, store } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { to: "person@example.com", fullName: "Person", username: "person", status: "approved", idempotencyKey: "account_approved:person:1" };
  const first = store.queue(input);
  const second = store.queue(input);
  assert.equal(first.id, second.id);
  const restarted = createAccountNotificationStore({ storePath, companyEmail: "noreply@example.com", encryptionKey: "test-key" });
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.list()[0].deliveryState, "queued");
});

test("verification bodies are encrypted at rest and omitted from public state", async t => {
  const { root, storePath, store } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.queue({
    to: "person@example.com", kind: "email_verification", subject: "Verify", body: "secret-token-value",
    sensitive: true, idempotencyKey: "email_verification:record-1",
  });
  const raw = fs.readFileSync(storePath, "utf8");
  assert.doesNotMatch(raw, /secret-token-value/);
  assert.doesNotMatch(JSON.stringify(store.list()), /body|securePayload|ciphertext|claimToken/);
  assert.match(store.claimNext().body, /secret-token-value/);
});
