import test from "node:test";
import assert from "node:assert/strict";
import { assertOperatorAccountRepository } from "../../src/persistence/operatorAccountRepository.js";
import { createFileOperatorAccountRepository } from "../../src/persistence/fileOperatorAccountRepository.js";
import { createOperatorAccountService } from "../../src/services/operatorAccountService.js";

function fakeLegacyStore() {
  const accounts = [{ username: "admin", role: "admin" }];
  const calls = [];
  return {
    accounts,
    calls,
    listOperatorAccounts() { calls.push(["list"]); return accounts; },
    getOperatorRecentLoginIps(username) { calls.push(["recent-ips", username]); return ["192.0.2.10"]; },
    createOperatorAccount(input) { calls.push(["create", input]); return { ...input }; },
    updateOperatorAccount(username, patch) { calls.push(["update", username, patch]); return { operator: { username, ...patch } }; },
    setOperatorAccountStatus(username, status) { calls.push(["status", username, status]); return { username, accountStatus: status }; },
    renameOperatorAccount(username, nextUsername) { calls.push(["rename", username, nextUsername]); return { username: nextUsername }; },
    invalidateOperatorSessions(username) { calls.push(["invalidate", username]); return { username }; },
    resetOperatorSecondFactor(username) { calls.push(["reset-2fa", username]); return { username }; },
    validateOperatorDeletionRequest(username, password) { calls.push(["validate-deletion", username, password]); return { username }; },
    requestOperatorDeletion(username, password) { calls.push(["request-deletion", username, password]); return { username, active: false }; },
    finalizeOperatorPrivacyDeletion(username, tombstone, requestId) {
      calls.push(["finalize-deletion", username, tombstone, requestId]);
      return { username: tombstone, active: false, privacyDeletionState: "completed", privacyDeletionRequestId: requestId };
    },
  };
}

test("operator account repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertOperatorAccountRepository(null), /must be an object/);
  assert.throws(() => assertOperatorAccountRepository({ getAccount() {} }), /requires getRecentLoginIps/);
});

test("file account adapter is async-first while preserving legacy results", async () => {
  const legacy = fakeLegacyStore();
  const repository = createFileOperatorAccountRepository(legacy);

  assert.deepEqual(await repository.getAccount("admin"), { username: "admin", role: "admin" });
  assert.equal(await repository.getAccount("missing"), null);
  assert.deepEqual(await repository.getRecentLoginIps("admin"), ["192.0.2.10"]);
  assert.deepEqual(await repository.createAccount({ username: "va1" }), { username: "va1" });
  assert.deepEqual(await repository.updateAccount("va1", { active: false }),
    { operator: { username: "va1", active: false } });
  assert.deepEqual(await repository.setAccountStatus("va1", "approved"),
    { username: "va1", accountStatus: "approved" });
  assert.deepEqual(await repository.renameAccount("va1", "va2"), { username: "va2" });
  assert.deepEqual(await repository.invalidateSessions("va2"), { username: "va2" });
  assert.deepEqual(await repository.resetSecondFactor("va2"), { username: "va2" });
  assert.deepEqual(await repository.validateDeletion("va2", "current-password"), { username: "va2" });
  assert.deepEqual(await repository.requestDeletion("va2", "current-password"), { username: "va2", active: false });
  const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.deepEqual(await repository.finalizePrivacyDeletion("va2", "deleted-aaaaaaaaaaaaaaaaaaaaaaaa", requestId),
    { username: "deleted-aaaaaaaaaaaaaaaaaaaaaaaa", active: false, privacyDeletionState: "completed",
      privacyDeletionRequestId: requestId });
});

test("account service supplies asynchronous reads and existence checks", async () => {
  const repository = createFileOperatorAccountRepository(fakeLegacyStore());
  const service = createOperatorAccountService({ repository });

  assert.equal(await service.usernameExists("admin"), true);
  assert.equal(await service.usernameExists("missing"), false);
  assert.deepEqual(await service.listAccounts(), [{ username: "admin", role: "admin" }]);
  assert.deepEqual(await service.getRecentLoginIps("admin"), ["192.0.2.10"]);
});

test("account service preserves repository errors for route-level status handling", async () => {
  const legacy = fakeLegacyStore();
  const conflict = Object.assign(new Error("username already exists"), { status: 409 });
  legacy.renameOperatorAccount = () => { throw conflict; };
  const service = createOperatorAccountService({ repository: createFileOperatorAccountRepository(legacy) });

  await assert.rejects(service.renameAccount("admin", "taken"), error => error === conflict);
});

test("file account mutations authorize immediately before the legacy durable write", async () => {
  const legacy = fakeLegacyStore();
  const repository = createFileOperatorAccountRepository(legacy);
  const denied = Object.assign(new Error("authorization revoked"), { status: 403 });
  let authorizationChecks = 0;
  await assert.rejects(
    repository.updateAccount("admin", { fullName: "Must Not Commit" }, {
      authorize: async () => { authorizationChecks += 1; throw denied; },
    }),
    error => error === denied,
  );
  assert.equal(authorizationChecks, 1);
  assert.equal(legacy.calls.some(call => call[0] === "update"), false);

  await assert.rejects(
    repository.requestDeletion("admin", "current-password", {
      authorize: async () => { throw denied; },
    }),
    error => error === denied,
  );
  assert.equal(legacy.calls.some(call => call[0] === "request-deletion"), false);

  await assert.rejects(
    repository.finalizePrivacyDeletion("admin", "deleted-aaaaaaaaaaaaaaaaaaaaaaaa",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { authorize: async () => { throw denied; } }),
    error => error === denied,
  );
  assert.equal(legacy.calls.some(call => call[0] === "finalize-deletion"), false);
});
