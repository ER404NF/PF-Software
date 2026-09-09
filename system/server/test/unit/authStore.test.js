import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, authenticate, canAccessDevice, operators, normalizeRole, publicOperator, hasRole, filterValidResearchGrants } from "../../src/authStore.js";

test("hashPassword + verifyPassword round-trip correctly", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
});

test("verifyPassword rejects a wrong password", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("wrong password", hash), false);
});

test("verifyPassword rejects malformed stored hashes instead of throwing", () => {
  assert.equal(verifyPassword("anything", "not-a-valid-hash"), false);
  assert.equal(verifyPassword("anything", ""), false);
  assert.equal(verifyPassword("anything", undefined), false);
});

test("two hashes of the same password are not identical (salted)", () => {
  const a = hashPassword("same password");
  const b = hashPassword("same password");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("same password", a), true);
  assert.equal(verifyPassword("same password", b), true);
});

test("authenticate returns the operator on correct credentials, null otherwise", () => {
  operators.set("unit-test-op", {
    username: "unit-test-op",
    passwordHash: hashPassword("s3cret"),
    allowedDevices: ["mock-1"],
    role: "admin",
  });
  try {
    const ok = authenticate("unit-test-op", "s3cret");
    assert.deepEqual(ok, { username: "unit-test-op", allowedDevices: ["mock-1"], role: "admin" });

    assert.equal(authenticate("unit-test-op", "wrong"), null);
    assert.equal(authenticate("does-not-exist", "s3cret"), null);
  } finally {
    operators.delete("unit-test-op");
  }
});

test("canAccessDevice: null allowedDevices means every device is allowed", () => {
  const admin = { username: "admin", allowedDevices: null };
  assert.equal(canAccessDevice(admin, "mock-1"), true);
  assert.equal(canAccessDevice(admin, "anything"), true);
});

test("canAccessDevice: an allowedDevices array restricts to exactly those ids", () => {
  const restricted = { username: "va", allowedDevices: ["mock-1"] };
  assert.equal(canAccessDevice(restricted, "mock-1"), true);
  assert.equal(canAccessDevice(restricted, "mock-2"), false);
});

test("canAccessDevice: no operator at all is never allowed", () => {
  assert.equal(canAccessDevice(null, "mock-1"), false);
  assert.equal(canAccessDevice(undefined, "mock-1"), false);
});


test("normalizeRole defaults missing or unknown roles to va", () => {
  assert.equal(normalizeRole(undefined), "va");
  assert.equal(normalizeRole("typo"), "va");
  assert.equal(normalizeRole("admin"), "admin");
});

test("publicOperator returns only safe browser fields", () => {
  const safe = publicOperator({
    username: "admin",
    role: "admin",
    allowedDevices: ["mock-1"],
    passwordHash: "must-not-leak",
    anotherSecret: "also-private",
  });
  assert.deepEqual(safe, { username: "admin", role: "admin", allowedDevices: ["mock-1"] });
  assert.equal("passwordHash" in safe, false);
});

test("hasRole is explicit and legacy operators are not admins", () => {
  assert.equal(hasRole({ username: "a", role: "admin" }, "admin"), true);
  assert.equal(hasRole({ username: "v", role: "va" }, "admin"), false);
  assert.equal(hasRole({ username: "legacy" }, "admin"), false);
});

// Regression guard for a real bug: an operator config with an uppercase
// workspace grant like "Client-A" used to be accepted by a looser inline
// regex here, then permanently and silently fail to match the always-
// lowercase real workspace id at request time, denying access with no
// error or warning anywhere in the stack. filterValidResearchGrants now
// reuses researchId.js's canonical, lowercase-only validator (the same one
// research.config.json's own workspace ids are validated against), so a
// mismatch like this is dropped loudly (console.warn) at load time instead.
test("filterValidResearchGrants drops case-invalid workspace ids instead of silently keeping a grant that can never match", () => {
  const original = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    const result = filterValidResearchGrants("op1", ["client-a", "Client-B", "client_c", "UPPER", 42, null]);
    assert.deepEqual(result, ["client-a", "client_c"]);
    assert.equal(warnings.length, 4); // Client-B, UPPER, 42, null — each invalid entry warns once
  } finally {
    console.warn = original;
  }
});

test("filterValidResearchGrants treats a non-array grant list as empty, not an error", () => {
  assert.deepEqual(filterValidResearchGrants("op1", undefined), []);
  assert.deepEqual(filterValidResearchGrants("op1", null), []);
  assert.deepEqual(filterValidResearchGrants("op1", "client-a"), []);
});
