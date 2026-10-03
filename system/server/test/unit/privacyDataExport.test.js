import test from "node:test";
import assert from "node:assert/strict";
import { createPrivacyDataExport } from "../../src/privacyDataExport.js";

test("privacy export includes only the account's records and strips secrets and third-party detail", () => {
  const exported = createPrivacyDataExport({
    username: "va-one",
    generatedAt: "2026-09-30T12:00:00.000Z",
    account: {
      username: "va-one", email: "va.one@example.com", role: "va", active: true,
      passwordHash: "must-not-export", twoFactorSecret: "must-not-export",
      recoveryCodeDigests: ["must-not-export"],
    },
    assignments: [
      { id: "mine", assignee: "va-one", createdBy: "manager", instructions: "My work", status: "assigned", history: [{ actor: "manager" }] },
      { id: "other", assignee: "va-two", createdBy: "va-one", instructions: "Their work", status: "assigned" },
    ],
    tasks: [
      { id: "task-mine", createdBy: "va-one", goal: "My goal", checkpoints: [{ secret: "screen" }], state: "QUEUED" },
      { id: "task-other", createdBy: "va-two", goal: "Other goal", state: "QUEUED" },
    ],
    auditEvents: [
      { id: "audit-mine", operator: "va-one", at: "2026-09-30T11:00:00.000Z", type: "action", deviceId: "phone-1", detail: { typedText: "private-payload" } },
      { id: "audit-other", operator: "va-two", at: "2026-09-30T11:00:00.000Z", type: "action" },
    ],
    privacyRequests: [{ id: "request-1", source: "self_service", status: "account_locked", lookupDigest: "must-not-export" }],
  });

  assert.equal(exported.account.email, "va.one@example.com");
  assert.deepEqual(exported.assignments, [{ id: "mine", instructions: "My work", status: "assigned" }]);
  assert.deepEqual(exported.tasks, [{ id: "task-mine", goal: "My goal", state: "QUEUED" }]);
  assert.deepEqual(exported.auditEvents, [{ id: "audit-mine", at: "2026-09-30T11:00:00.000Z", type: "action", deviceId: "phone-1" }]);
  assert.deepEqual(exported.privacyRequests, [{ id: "request-1", source: "self_service", status: "account_locked" }]);
  const serialized = JSON.stringify(exported);
  for (const secret of ["must-not-export", "typedText", "private-payload", "va-two", "Their work", "screen"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not cross the export boundary`);
  }
});

test("privacy export rejects a mismatched account and malformed collections", () => {
  assert.throws(() => createPrivacyDataExport({ username: "va-one", account: { username: "va-two" } }), /account not found/);
  assert.throws(() => createPrivacyDataExport({ username: "va-one", account: { username: "va-one" }, tasks: {} }), /tasks must be an array/);
});

test("privacy export bounds every collection and reports truncation", () => {
  const assignments = Array.from({ length: 1001 }, (_, index) => ({
    id: `assignment-${index}`, assignee: "va-one", instructions: "work", status: "assigned",
  }));
  const exported = createPrivacyDataExport({
    username: "va-one",
    account: { username: "va-one" },
    assignments,
  });
  assert.equal(exported.assignments.length, 1000);
  assert.equal(exported.coverage.limitPerCategory, 1000);
  assert.equal(exported.coverage.truncated.assignments, true);
  assert.equal(exported.coverage.truncated.tasks, false);
});
