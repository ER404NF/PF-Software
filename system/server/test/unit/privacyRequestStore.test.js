import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrivacyRequestStore } from "../../src/privacyRequestStore.js";

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("privacy requests are durable, idempotent, and never expose their account lookup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-privacy-store-"));
  const storePath = path.join(root, "requests.json");
  let instant = new Date("2026-09-30T10:00:00.000Z");
  try {
    const store = createPrivacyRequestStore({ storePath, now: () => instant });
    const unknown = store.createPublic({ lookupDigest: digest("unknown@example.com"), accountUsername: null });
    assert.equal(unknown.status, "awaiting_identity_verification");
    assert.equal(Object.hasOwn(unknown, "accountUsername"), false);
    assert.equal(Object.hasOwn(unknown, "lookupDigest"), false);
    assert.equal(store.createPublic({ lookupDigest: digest("unknown@example.com"), accountUsername: null }).id, unknown.id);

    const publicKnown = store.createPublic({ lookupDigest: digest("va.one@gmail.com"), accountUsername: "va-one" });
    instant = new Date("2026-09-30T10:01:00.000Z");
    const verified = store.createVerified({ lookupDigest: digest("va-one"), accountUsername: "va-one" });
    assert.equal(verified.id, publicKnown.id);
    assert.equal(verified.status, "awaiting_account_lock");
    assert.equal(verified.identityVerifiedAt, instant.toISOString());

    const locked = store.markAccountLocked(verified.id);
    assert.equal(locked.status, "account_locked");
    const reloaded = createPrivacyRequestStore({ storePath }).list();
    assert.equal(reloaded.length, 2);
    assert.equal(reloaded.find(request => request.id === verified.id).accountUsername, "va-one");
    assert.match(fs.readFileSync(storePath, "utf8"), /"version": 1/);
    assert.equal(fs.readdirSync(root).some(name => name.endsWith(".tmp")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed account lock becomes retryable without changing an earlier completed request", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-privacy-failure-"));
  try {
    const store = createPrivacyRequestStore({ storePath: path.join(root, "requests.json") });
    const first = store.createVerified({ lookupDigest: digest("va-two"), accountUsername: "va-two" });
    assert.equal(store.markFailed(first.id).status, "failed");
    const retry = store.createVerified({ lookupDigest: digest("va-two"), accountUsername: "va-two" });
    assert.notEqual(retry.id, first.id);
    assert.equal(retry.status, "awaiting_account_lock");
    assert.throws(() => store.markFailed(retry.id, "PRIVATE DETAIL"), /failure code/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("oversized and malformed persisted privacy state fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-privacy-bounds-"));
  const storePath = path.join(root, "requests.json");
  try {
    const store = createPrivacyRequestStore({ storePath });
    fs.writeFileSync(storePath, "x".repeat(8 * 1024 * 1024 + 1));
    assert.throws(() => store.list(), /no larger than 8 MiB/);

    fs.writeFileSync(storePath, JSON.stringify({ version: 1, requests: [{ id: "bad" }] }));
    assert.throws(() => store.list(), /invalid record/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
