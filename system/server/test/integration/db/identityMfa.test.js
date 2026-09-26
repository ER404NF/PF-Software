// Real-PostgreSQL functional test for the M04 part 4 MFA/recovery-code
// layer, using the REAL twoFactor.js crypto (not fakes) so the actual
// encrypt/decrypt/TOTP round trip through real storage is what's verified,
// not just the service's composition logic (already covered in the unit
// test). Skips without TEST_DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createUserRepository } from "../../../src/db/repositories/userRepository.js";
import { createIdentityMfaRepository } from "../../../src/db/repositories/identityMfaRepository.js";
import { createIdentityMfaService } from "../../../src/services/identityMfaService.js";
import { hashPassword } from "../../../src/authStore.js";
import {
  generateTotpSecret, verifyTotp, encryptTotpSecret, decryptTotpSecret,
  generateRecoveryCodes, recoveryCodeDigest, verifyRecoveryCode, otpauthUri, totpCode,
} from "../../../src/twoFactor.js";

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — this test only runs against a real PostgreSQL instance (see .github/workflows/db-migrations.yml)";

const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));
const systemRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const migrationsDir = path.join(serverRoot, "migrations");
const migrateBin = path.join(systemRoot, "node_modules", "node-pg-migrate", "bin", "node-pg-migrate.js");

async function runMigrationsUp(databaseUrl) {
  await execFileAsync(process.execPath, [migrateBin, "up", "--migrations-dir", migrationsDir], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

const MASTER_KEY = "test-master-key-at-least-32-characters-long";

test("identity MFA service with real crypto (real PostgreSQL)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const userRepository = createUserRepository(pool);
  const mfaRepository = createIdentityMfaRepository(pool);
  const service = createIdentityMfaService({
    repository: mfaRepository, masterKey: MASTER_KEY, generateTotpSecret, verifyTotp, encryptTotpSecret,
    decryptTotpSecret, generateRecoveryCodes, recoveryCodeDigest, verifyRecoveryCode, otpauthUri,
  });

  const unique = crypto.randomBytes(4).toString("hex");
  const user = await userRepository.createWithPrimaryEmail({
    email: `mfa-user-${unique}@example.com`,
    passwordHash: hashPassword("does not matter for this test"),
  });

  await t.test("enrollment persists only the encrypted secret; a real generated code confirms it", async () => {
    const { methodId, secret } = await service.enrollTotp({ userId: user.id, email: `mfa-user-${unique}@example.com` });
    const stored = await mfaRepository.getById(methodId);
    assert.notEqual(stored.secret_ref, secret);
    assert.equal(decryptTotpSecret(stored.secret_ref, MASTER_KEY), secret, "the encrypted secret must decrypt back correctly");

    const code = totpCode(secret);
    const confirmed = await service.confirmTotp({ methodId, code });
    assert.equal(confirmed.recoveryCodes.length, 10);

    assert.equal(await service.verifyLogin({ userId: user.id, code }), methodId);
  });

  await t.test("a stale/wrong TOTP code is rejected against the real database", async () => {
    const { methodId, secret } = await service.enrollTotp({ userId: user.id, email: `mfa-user-${unique}@example.com` });
    await service.confirmTotp({ methodId, code: totpCode(secret) });
    assert.equal(await service.verifyLogin({ userId: user.id, code: "000000" }), null);
  });

  await t.test("a real recovery code round-trips through hashed storage and is single-use", async () => {
    const { methodId, secret } = await service.enrollTotp({ userId: user.id, email: `mfa-user-${unique}@example.com` });
    const { recoveryCodes } = await service.confirmTotp({ methodId, code: totpCode(secret) });
    const code = recoveryCodes[0];

    const stored = await mfaRepository.listUnconsumedRecoveryCodes(user.id);
    assert.ok(stored.every((row) => row.code_hash !== code), "recovery codes must never be stored in plaintext");

    assert.equal(await service.consumeRecoveryCode({ userId: user.id, code }), true);
    assert.equal(await service.consumeRecoveryCode({ userId: user.id, code }), false, "reused code must fail against the real database");
  });
});
