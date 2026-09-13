import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decryptTotpSecret, encryptTotpSecret, generateRecoveryCodes, generateTotpSecret,
  recoveryCodeDigest, totpCode, verifyRecoveryCode, verifyTotp,
} from "../../src/twoFactor.js";

test("TOTP matches the RFC test secret and accepts only the configured time window", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(secret, { at: 59_000 }), "287082");
  assert.equal(verifyTotp(secret, "287082", { at: 59_000, window: 0 }), true);
  assert.equal(verifyTotp(secret, "287082", { at: 120_000, window: 0 }), false);
  assert.equal(verifyTotp(secret, "not-code", { at: 59_000 }), false);
});

test("TOTP secrets are encrypted at rest and reject the wrong master key", () => {
  const secret = generateTotpSecret();
  const encrypted = encryptTotpSecret(secret, "test-master-key-with-at-least-thirty-two-characters");
  assert.notEqual(encrypted, secret);
  assert.equal(decryptTotpSecret(encrypted, "test-master-key-with-at-least-thirty-two-characters"), secret);
  assert.throws(() => decryptTotpSecret(encrypted, "different-master-key-with-thirty-two-characters"));
  assert.throws(() => encryptTotpSecret(secret, "too short"), /TWO_FACTOR_MASTER_KEY/);
});

test("recovery codes are unique, stored as digests, and consumed by index", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  const digests = codes.map(recoveryCodeDigest);
  assert.equal(digests.some(value => codes.includes(value)), false);
  assert.equal(verifyRecoveryCode(codes[4].toLowerCase(), digests), 4);
  assert.equal(verifyRecoveryCode("FFFF-FFFF-FFFF", digests), -1);
});
