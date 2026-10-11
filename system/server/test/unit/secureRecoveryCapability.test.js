import { test } from "node:test";
import assert from "node:assert/strict";
import { secureRecoveryCapability, canUseSecureEmailRecovery } from "../../src/secureRecoveryCapability.js";

test("secure recovery requires both real delivery configuration and encrypted notification storage", () => {
  assert.deepEqual(secureRecoveryCapability({ smtpConfigured: true, encryptionConfigured: true }),
    { configured: true, missing: [] });
  assert.equal(secureRecoveryCapability({ smtpConfigured: false, encryptionConfigured: true }).configured, false);
  assert.equal(secureRecoveryCapability({ smtpConfigured: true, encryptionConfigured: false }).configured, false);
  assert.equal(canUseSecureEmailRecovery({ email: "user@example.test", smtpConfigured: true, encryptionConfigured: true }), true);
  assert.equal(canUseSecureEmailRecovery({ email: null, smtpConfigured: true, encryptionConfigured: true }), false);
});

test("environment discovery lists capability names without exposing configured values", () => {
  const status = secureRecoveryCapability({ environment: {} });
  assert.equal(status.configured, false);
  assert.ok(status.missing.includes("SMTP_HOST"));
  assert.ok(status.missing.includes("notification_encryption"));
  assert.equal(JSON.stringify(status).includes("password"), false);
});

test("environment discovery rejects invalid SMTP ports", () => {
  const environment = {
    SMTP_HOST: "smtp.example.test", SMTP_PORT: "70000", SMTP_USER: "user", SMTP_PASS: "pass",
    COMPANY_FROM_EMAIL: "from@example.test", ACCOUNT_NOTIFICATION_ENCRYPTION_KEY: "key",
  };
  const status = secureRecoveryCapability({ environment });
  assert.equal(status.configured, false);
  assert.deepEqual(status.missing, ["SMTP_PORT"]);
});
