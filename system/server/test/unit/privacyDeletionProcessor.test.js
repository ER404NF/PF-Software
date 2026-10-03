import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrivacyRequestStore } from "../../src/privacyRequestStore.js";
import { createPrivacyDeletionProcessor, PRIVACY_DELETION_CATEGORIES } from "../../src/privacyDeletionProcessor.js";

const policy = { version: 1, enabled: true, categories: {
  access: "revoke", account: "anonymize", assignments: "anonymize_owned", tasks: "anonymize_owned",
  media: "delete_owned", shared_records: "retain", audit: "retain",
} };

function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-privacy-processor-"));
  const storePath = path.join(root, "requests.json");
  const store = createPrivacyRequestStore({ storePath });
  const request = store.createVerified({ lookupDigest: digest("owner"), accountUsername: "owner" });
  store.markAccountLocked(request.id);
  return { root, storePath, store, request };
}

function operations({ fail = null, calls = [], planCalls = [], records = null } = {}) {
  return Object.fromEntries(PRIVACY_DELETION_CATEGORIES.map(category => [category, {
    async plan({ username }) {
      planCalls.push(category);
      assert.equal(username, "owner");
      if (category === "media" && records) return { delete_owned: records.filter(item => item.owner === username).length };
      if (category === "shared_records" && records) return { retained_shared: records.filter(item => item.shared).length };
      return { matched: 1 };
    },
    async apply({ username }) {
      calls.push(category);
      if (category === fail) throw new Error("private filesystem detail must not persist");
      if (category === "media" && records) {
        const owned = records.filter(item => item.owner === username && !item.shared);
        for (const item of owned) item.deleted = true;
        return { deleted_owned: owned.length };
      }
      if (category === "shared_records" && records) return { retained_shared: records.filter(item => item.shared).length };
      return { processed: 1 };
    },
  }]));
}

test("privacy deletion is policy gated and dry-run plans contain only counts", async () => {
  const f = fixture();
  try {
    const disabled = createPrivacyDeletionProcessor({ requestStore: f.store, policy: null, operations: operations() });
    await assert.rejects(disabled.plan(f.request.id), error => error.code === "policy_missing");
    assert.equal(f.store.getForProcessing(f.request.id).status, "account_locked");

    const processor = createPrivacyDeletionProcessor({ requestStore: f.store, policy, operations: operations() });
    const result = await processor.process(f.request.id, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.categories.media, { matched: 1 });
    assert.equal(JSON.stringify(result).includes("owner"), false);
    assert.equal(f.store.getForProcessing(f.request.id).status, "account_locked");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("cleanup revokes access first, isolates account-owned media, retains shared and foreign records, and completes exactly", async () => {
  const f = fixture();
  const calls = [];
  const records = [
    { id: "owned", owner: "owner", shared: false },
    { id: "shared", owner: "owner", shared: true },
    { id: "foreign", owner: "other", shared: false },
  ];
  try {
    const processor = createPrivacyDeletionProcessor({ requestStore: f.store, policy, operations: operations({ calls, records }) });
    const result = await processor.process(f.request.id);
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, PRIVACY_DELETION_CATEGORIES);
    assert.equal(records[0].deleted, true);
    assert.equal(records[1].deleted, undefined);
    assert.equal(records[2].deleted, undefined);
    const stored = f.store.getForProcessing(f.request.id);
    assert.equal(stored.status, "completed");
    assert.ok(stored.completedAt);
    assert.deepEqual(Object.keys(stored.progress), PRIVACY_DELETION_CATEGORIES);
    assert.equal((await processor.process(f.request.id)).status, "completed");
    assert.equal(calls.length, PRIVACY_DELETION_CATEGORIES.length);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("partial and audit failures are bounded, durable, and retry only unfinished categories", async () => {
  const f = fixture();
  const firstCalls = [];
  try {
    const failing = createPrivacyDeletionProcessor({ requestStore: f.store, policy,
      operations: operations({ fail: "media", calls: firstCalls }) });
    assert.deepEqual(await failing.process(f.request.id), {
      requestId: f.request.id, status: "retryable_failed", failureCode: "media_cleanup_failed",
    });
    let stored = createPrivacyRequestStore({ storePath: f.storePath }).getForProcessing(f.request.id);
    assert.equal(stored.failureCode, "media_cleanup_failed");
    assert.equal(JSON.stringify(stored).includes("filesystem"), false);
    assert.deepEqual(Object.keys(stored.progress), ["access", "account", "assignments", "tasks"]);

    const retryCalls = [];
    const retry = createPrivacyDeletionProcessor({ requestStore: createPrivacyRequestStore({ storePath: f.storePath }),
      policy, operations: operations({ fail: "audit", calls: retryCalls }) });
    assert.equal((await retry.process(f.request.id)).failureCode, "audit_write_failed");
    assert.deepEqual(retryCalls, ["media", "shared_records", "audit"]);
    stored = f.store.getForProcessing(f.request.id);
    assert.equal(stored.status, "retryable_failed");
    assert.equal(Object.hasOwn(stored.progress, "audit"), false);

    const finalCalls = [];
    const final = createPrivacyDeletionProcessor({ requestStore: f.store, policy, operations: operations({ calls: finalCalls }) });
    assert.equal((await final.process(f.request.id)).status, "completed");
    assert.deepEqual(finalCalls, ["audit"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("restart recovery releases an interrupted claim and concurrent processing has one winner", async () => {
  const f = fixture();
  try {
    const claim = f.store.claimProcessing(f.request.id, `deleted-${f.request.id.replaceAll("-", "").slice(0, 24)}`);
    assert.ok(claim.processingToken);
    const restarted = createPrivacyRequestStore({ storePath: f.storePath });
    assert.equal(restarted.recoverInterrupted().some(item => item.id === f.request.id), true);
    assert.equal(restarted.getForProcessing(f.request.id).failureCode, "processing_interrupted");

    const calls = [];
    const processor = createPrivacyDeletionProcessor({ requestStore: restarted, policy, operations: operations({ calls }) });
    const results = await Promise.all([processor.process(f.request.id), processor.process(f.request.id)]);
    assert.equal(results.filter(item => item.status === "completed").length, 1);
    assert.equal(results.filter(item => item.status === "processing" && item.claimed === false).length, 1);
    assert.equal(results.filter(item => item.claimed === true).length, 1);
    assert.equal(calls.length, PRIVACY_DELETION_CATEGORIES.length);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("processing reauthorizes after planning and before every destructive category", async () => {
  const f = fixture();
  const calls = [];
  const planCalls = [];
  try {
    const processor = createPrivacyDeletionProcessor({ requestStore: f.store, policy,
      operations: operations({ calls, planCalls }) });
    let checks = 0;
    await assert.rejects(processor.process(f.request.id, {
      authorize: async () => {
        checks += 1;
        const error = new Error("administrator access revoked");
        error.status = 403;
        throw error;
      },
    }), /access revoked/);
    assert.equal(checks, 1);
    assert.deepEqual(planCalls, [], "revoked administrators must not enumerate private records");
    assert.deepEqual(calls, []);
    assert.equal(f.store.getForProcessing(f.request.id).status, "account_locked");

    const result = await processor.process(f.request.id, {
      authorize: async () => {
        checks += 1;
        if (checks === 5) throw new Error("administrator access revoked during processing");
      },
    });
    assert.deepEqual(result, { requestId: f.request.id, status: "retryable_failed", failureCode: "authorization_revoked" });
    assert.deepEqual(calls, ["access"]);
    assert.deepEqual(Object.keys(f.store.getForProcessing(f.request.id).progress), ["access"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("an unsupported audit anonymization policy fails before planning or mutation", async () => {
  const f = fixture();
  const calls = [];
  const planCalls = [];
  try {
    const unsupported = structuredClone(policy);
    unsupported.categories.audit = "anonymize_actor";
    const processor = createPrivacyDeletionProcessor({ requestStore: f.store, policy: unsupported,
      operations: operations({ calls, planCalls }) });
    await assert.rejects(processor.process(f.request.id, { authorize: async () => {} }),
      error => error.code === "policy_missing");
    assert.deepEqual(planCalls, []);
    assert.deepEqual(calls, []);
    assert.equal(f.store.getForProcessing(f.request.id).status, "account_locked");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("tombstone collision fails before a claim or destructive mutation", async () => {
  const f = fixture();
  const calls = [];
  try {
    const collision = Object.assign(new Error("private collision detail"), {
      code: "tombstone_collision", status: 409,
    });
    const processor = createPrivacyDeletionProcessor({ requestStore: f.store, policy,
      operations: operations({ calls }), resolveTombstone: async () => { throw collision; } });
    await assert.rejects(processor.process(f.request.id, { authorize: async () => {} }), error => error === collision);
    assert.deepEqual(calls, []);
    assert.equal(f.store.getForProcessing(f.request.id).status, "account_locked");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("restart resumes with one tombstone after account anonymization and before completion", async () => {
  const f = fixture();
  const tombstone = `deleted-${f.request.id.replaceAll("-", "").slice(0, 24)}`;
  let accountUsername = "owner";
  const firstCalls = [];
  try {
    const firstOperations = operations({ calls: firstCalls, fail: "assignments" });
    firstOperations.account.apply = async ({ username, tombstone: appliedTombstone }) => {
      assert.equal(username, "owner");
      assert.equal(appliedTombstone, tombstone);
      accountUsername = appliedTombstone;
      firstCalls.push("account");
      return { processed: 1 };
    };
    const first = createPrivacyDeletionProcessor({ requestStore: f.store, policy, operations: firstOperations });
    assert.equal((await first.process(f.request.id)).failureCode, "assignment_cleanup_failed");
    assert.equal(accountUsername, tombstone);

    const restartedStore = createPrivacyRequestStore({ storePath: f.storePath });
    const retryCalls = [];
    const retryOperations = operations({ calls: retryCalls });
    retryOperations.account.apply = async () => { throw new Error("completed account category must not rerun"); };
    const restarted = createPrivacyDeletionProcessor({ requestStore: restartedStore, policy, operations: retryOperations });
    assert.equal((await restarted.process(f.request.id)).status, "completed");
    assert.equal(restartedStore.getForProcessing(f.request.id).tombstone, tombstone);
    assert.equal(retryCalls.includes("account"), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
