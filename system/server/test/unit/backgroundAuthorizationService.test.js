import test from "node:test";
import assert from "node:assert/strict";
import { assertBackgroundAuthorizationRepository } from "../../src/persistence/backgroundAuthorizationRepository.js";
import { createFileBackgroundAuthorizationRepository } from "../../src/persistence/fileBackgroundAuthorizationRepository.js";
import { createBackgroundAuthorizationService } from "../../src/services/backgroundAuthorizationService.js";

test("background authorization repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertBackgroundAuthorizationRepository(null), /must be an object/);
  assert.throws(() => assertBackgroundAuthorizationRepository({}), /requires getOperatorByUsername/);
  assert.throws(
    () => assertBackgroundAuthorizationRepository({ getOperatorByUsername() {} }),
    /requires canAccessDevice/,
  );
  assert.throws(
    () => assertBackgroundAuthorizationRepository({ getOperatorByUsername() {}, canAccessDevice() {} }),
    /requires researchWorkspaceFor/,
  );
});

test("file background authorization adapter delegates to the injected legacy implementation unchanged", () => {
  const calls = [];
  const repository = createFileBackgroundAuthorizationRepository({
    operatorByUsername(username) { calls.push(["operatorByUsername", username]); return { username }; },
    canAccessDevice(operator, deviceId) { calls.push(["canAccessDevice", operator, deviceId]); return deviceId === "device-1"; },
    researchWorkspaceFor(operator, accountId) { calls.push(["researchWorkspaceFor", operator, accountId]); return accountId === "account-a" ? "client-a" : null; },
  });

  assert.deepEqual(repository.getOperatorByUsername("va-1"), { username: "va-1" });
  assert.equal(repository.canAccessDevice({ username: "va-1" }, "device-1"), true);
  assert.equal(repository.canAccessDevice({ username: "va-1" }, "device-2"), false);
  assert.equal(repository.researchWorkspaceFor({ username: "va-1" }, "account-a"), "client-a");
  assert.equal(repository.researchWorkspaceFor({ username: "va-1" }, "account-b"), null);
  assert.deepEqual(calls, [
    ["operatorByUsername", "va-1"],
    ["canAccessDevice", { username: "va-1" }, "device-1"],
    ["canAccessDevice", { username: "va-1" }, "device-2"],
    ["researchWorkspaceFor", { username: "va-1" }, "account-a"],
    ["researchWorkspaceFor", { username: "va-1" }, "account-b"],
  ]);
});

test("background authorization service requires a valid repository", () => {
  assert.throws(() => createBackgroundAuthorizationService({ repository: null }), /must be an object/);
});

test("background authorization service is a thin pass-through with one named boundary", () => {
  const operator = { username: "va-1", role: "va", allowedDevices: ["device-1"] };
  const repository = createFileBackgroundAuthorizationRepository({
    operatorByUsername: (username) => (username === "va-1" ? operator : null),
    canAccessDevice: (op, deviceId) => op?.allowedDevices?.includes(deviceId) ?? false,
    researchWorkspaceFor: (op, accountId) => (op === operator && accountId === "account-a" ? "client-a" : null),
  });
  const service = createBackgroundAuthorizationService({ repository });

  assert.equal(service.operatorForUsername("va-1"), operator);
  assert.equal(service.operatorForUsername("unknown"), null);
  assert.equal(service.canAccessDevice(operator, "device-1"), true);
  assert.equal(service.canAccessDevice(operator, "device-2"), false);
  assert.equal(service.researchWorkspaceFor(operator, "account-a"), "client-a");
  assert.equal(service.researchWorkspaceFor(operator, "account-b"), null);
});
