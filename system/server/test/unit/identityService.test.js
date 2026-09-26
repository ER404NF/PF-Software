import test from "node:test";
import assert from "node:assert/strict";
import { assertOperatorIdentityRepository } from "../../src/persistence/operatorIdentityRepository.js";
import { createFileOperatorIdentityRepository } from "../../src/persistence/fileOperatorIdentityRepository.js";
import { createIdentityService } from "../../src/services/identityService.js";

function record(overrides = {}) {
  return {
    username: "admin",
    passwordHash: "stored-hash",
    active: true,
    accountStatus: "approved",
    authVersion: 3,
    ...overrides,
  };
}

function serviceWith(operator = record()) {
  const registry = new Map(operator ? [[operator.username, operator]] : []);
  const noOp = () => null;
  return createIdentityService({
    repository: createFileOperatorIdentityRepository({
      registry,
      completeEmailRecovery: noOp,
      configureOperatorTwoFactor: noOp,
      createEmailRecoveryToken: noOp,
      createSignupAccount: noOp,
      prunePendingSignupAccounts: noOp,
      verifyOperatorSecondFactor: noOp,
    }),
    verifyPassword: (password, hash) => password === "correct" && hash === "stored-hash",
  });
}

test("operator identity repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertOperatorIdentityRepository(null), /must be an object/);
  assert.throws(() => assertOperatorIdentityRepository({}), /requires getIdentityRecord/);
  assert.throws(() => assertOperatorIdentityRepository({ getIdentityRecord() {} }), /requires createSignupAccount/);
});

test("file identity adapter is async-first and supports an injected registry", async () => {
  const operator = record();
  const calls = [];
  const repository = createFileOperatorIdentityRepository({
    registry: new Map([[operator.username, operator]]),
    createSignupAccount(input) { calls.push(["signup", input]); return input; },
    prunePendingSignupAccounts(options) { calls.push(["prune", options]); return { atCapacity: false }; },
    configureOperatorTwoFactor(...args) { calls.push(["configure", ...args]); return { username: args[0] }; },
    verifyOperatorSecondFactor(...args) { calls.push(["verify", ...args]); return { method: "authenticator" }; },
    createEmailRecoveryToken(identifier) { calls.push(["recovery", identifier]); return { token: "token" }; },
    completeEmailRecovery(...args) { calls.push(["complete", ...args]); return { username: "admin" }; },
  });

  assert.equal(await repository.getIdentityRecord("admin"), operator);
  assert.equal(await repository.getIdentityRecord("missing"), null);
  assert.equal(await repository.getIdentityRecord(null), null);
  assert.deepEqual(await repository.createSignupAccount({ username: "va" }), { username: "va" });
  assert.deepEqual(await repository.prunePendingSignupAccounts({ maxPending: 5 }), { atCapacity: false });
  assert.deepEqual(await repository.configureTwoFactor("admin", "secret", ["digest"]), { username: "admin" });
  assert.deepEqual(await repository.verifySecondFactor("admin", "123456", "key"), { method: "authenticator" });
  assert.deepEqual(await repository.createEmailRecoveryToken("admin"), { token: "token" });
  assert.deepEqual(await repository.completeEmailRecovery("token", "password", "password"), { username: "admin" });
  assert.equal(calls.length, 6);
});

test("identity service requires a password verifier", () => {
  assert.throws(() => createIdentityService({ repository: {
    getIdentityRecord: async () => null,
    createSignupAccount: async () => null,
    prunePendingSignupAccounts: async () => null,
    configureTwoFactor: async () => null,
    verifySecondFactor: async () => null,
    createEmailRecoveryToken: async () => null,
    completeEmailRecovery: async () => null,
  } }), /requires verifyPassword/);
});

test("identity service keeps authentication mutations asynchronous", async () => {
  const calls = [];
  const repository = {
    getIdentityRecord: async () => null,
    createSignupAccount: async input => { calls.push("signup"); return input; },
    prunePendingSignupAccounts: async options => { calls.push("prune"); return options; },
    configureTwoFactor: async username => { calls.push("configure"); return username; },
    verifySecondFactor: async username => { calls.push("verify"); return username; },
    createEmailRecoveryToken: async identifier => { calls.push("recovery"); return identifier; },
    completeEmailRecovery: async token => { calls.push("complete"); return token; },
  };
  const service = createIdentityService({ repository, verifyPassword: () => false });

  assert.deepEqual(await service.createSignupAccount({ username: "va" }), { username: "va" });
  assert.deepEqual(await service.prunePendingSignupAccounts({ maxPending: 5 }), { maxPending: 5 });
  assert.equal(await service.configureTwoFactor("admin", "secret", []), "admin");
  assert.equal(await service.verifySecondFactor("admin", "123456", "key"), "admin");
  assert.equal(await service.createEmailRecoveryToken("admin"), "admin");
  assert.equal(await service.completeEmailRecovery("token", "password", "password"), "token");
  assert.deepEqual(calls, ["signup", "prune", "configure", "verify", "recovery", "complete"]);
});

test("password authentication preserves valid pending and rejected identities", async () => {
  const pending = record({ accountStatus: "pending" });
  const service = serviceWith(pending);

  assert.equal(await service.authenticatePassword("admin", "wrong"), null);
  assert.equal(await service.authenticatePassword("missing", "correct"), null);
  assert.equal(await service.authenticatePassword("admin", "correct"), pending);

  const rejected = record({ accountStatus: "rejected" });
  assert.equal(await serviceWith(rejected).authenticatePassword("admin", "correct"), rejected);
});

test("session resolution fails closed on state or version changes", async () => {
  assert.equal(await serviceWith(null).resolveSessionPrincipal({ username: "admin", authVersion: 3 }), null);
  assert.equal(await serviceWith(record({ active: false })).resolveSessionPrincipal({ username: "admin", authVersion: 3 }), null);
  assert.equal(await serviceWith(record({ accountStatus: "pending" })).resolveSessionPrincipal({ username: "admin", authVersion: 3 }), null);
  assert.equal(await serviceWith(record({ accountStatus: "rejected" })).resolveSessionPrincipal({ username: "admin", authVersion: 3 }), null);
  assert.equal(await serviceWith().resolveSessionPrincipal({ username: "admin", authVersion: 2 }), null);

  const approved = record();
  assert.equal(await serviceWith(approved).resolveSessionPrincipal({ username: "admin", authVersion: 3 }), approved);
});

test("pending authentication enforces expiry, account state, and version", async () => {
  const service = serviceWith();
  const valid = { username: "admin", authVersion: 3, expiresAt: "2026-09-25T12:05:00.000Z" };

  assert.equal(await service.resolvePendingAuthentication(valid, { now: Date.parse("2026-09-25T12:00:00.000Z") }).then(Boolean), true);
  assert.equal(await service.resolvePendingAuthentication(valid, { now: Date.parse("2026-09-25T12:05:00.000Z") }), null);
  assert.equal(await service.resolvePendingAuthentication({ ...valid, authVersion: 2 }, { now: Date.parse("2026-09-25T12:00:00.000Z") }), null);
  assert.equal(await serviceWith(record({ active: false })).resolvePendingAuthentication(valid, { now: Date.parse("2026-09-25T12:00:00.000Z") }), null);
});
