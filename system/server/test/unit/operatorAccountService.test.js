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
    createOperatorAccount(input) { calls.push(["create", input]); return { ...input }; },
    updateOperatorAccount(username, patch) { calls.push(["update", username, patch]); return { operator: { username, ...patch } }; },
    setOperatorAccountStatus(username, status) { calls.push(["status", username, status]); return { username, accountStatus: status }; },
    renameOperatorAccount(username, nextUsername) { calls.push(["rename", username, nextUsername]); return { username: nextUsername }; },
    invalidateOperatorSessions(username) { calls.push(["invalidate", username]); return { username }; },
    resetOperatorSecondFactor(username) { calls.push(["reset-2fa", username]); return { username }; },
  };
}

test("operator account repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertOperatorAccountRepository(null), /must be an object/);
  assert.throws(() => assertOperatorAccountRepository({ getAccount() {} }), /requires listAccounts/);
});

test("file account adapter is async-first while preserving legacy results", async () => {
  const legacy = fakeLegacyStore();
  const repository = createFileOperatorAccountRepository(legacy);

  assert.deepEqual(await repository.getAccount("admin"), { username: "admin", role: "admin" });
  assert.equal(await repository.getAccount("missing"), null);
  assert.deepEqual(await repository.createAccount({ username: "va1" }), { username: "va1" });
  assert.deepEqual(await repository.updateAccount("va1", { active: false }),
    { operator: { username: "va1", active: false } });
  assert.deepEqual(await repository.setAccountStatus("va1", "approved"),
    { username: "va1", accountStatus: "approved" });
  assert.deepEqual(await repository.renameAccount("va1", "va2"), { username: "va2" });
  assert.deepEqual(await repository.invalidateSessions("va2"), { username: "va2" });
  assert.deepEqual(await repository.resetSecondFactor("va2"), { username: "va2" });
});

test("account service supplies asynchronous reads and existence checks", async () => {
  const repository = createFileOperatorAccountRepository(fakeLegacyStore());
  const service = createOperatorAccountService({ repository });

  assert.equal(await service.usernameExists("admin"), true);
  assert.equal(await service.usernameExists("missing"), false);
  assert.deepEqual(await service.listAccounts(), [{ username: "admin", role: "admin" }]);
});

test("account service preserves repository errors for route-level status handling", async () => {
  const legacy = fakeLegacyStore();
  const conflict = Object.assign(new Error("username already exists"), { status: 409 });
  legacy.renameOperatorAccount = () => { throw conflict; };
  const service = createOperatorAccountService({ repository: createFileOperatorAccountRepository(legacy) });

  await assert.rejects(service.renameAccount("admin", "taken"), error => error === conflict);
});
