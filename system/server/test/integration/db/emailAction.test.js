// Real-PostgreSQL functional test for the M04 part 5 email verification /
// password reset layer. Skips without TEST_DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { withTransaction } from "../../../src/db/transaction.js";
import { createUserRepository } from "../../../src/db/repositories/userRepository.js";
import { createEmailActionTokenRepository } from "../../../src/db/repositories/emailActionTokenRepository.js";
import { createIdentitySessionRepository } from "../../../src/db/repositories/identitySessionRepository.js";
import { createIdentitySessionService } from "../../../src/services/identitySessionService.js";
import { createEmailActionService } from "../../../src/services/emailActionService.js";
import { hashPassword, verifyPassword } from "../../../src/authStore.js";

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

test("email verification and password reset (real PostgreSQL)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const userRepository = createUserRepository(pool);
  const emailActionTokenRepository = createEmailActionTokenRepository(pool);
  const sessionRepository = createIdentitySessionRepository(pool);
  const sessionService = createIdentitySessionService({ repository: sessionRepository });
  const service = createEmailActionService({
    pool, withTransaction, emailActionTokenRepository, userRepository, sessionRepository, hashPassword,
  });

  const unique = crypto.randomBytes(4).toString("hex");
  const user = await userRepository.createWithPrimaryEmail({
    email: `verify-${unique}@example.com`,
    passwordHash: hashPassword("original passphrase"),
  });

  await t.test("email verification marks the real primary email row verified", async () => {
    let primary = await userRepository.getPrimaryEmail(user.id);
    assert.equal(primary.verified_at, null);

    const { token } = await service.issueEmailVerificationToken(user.id);
    await service.confirmEmailVerification(token);

    primary = await userRepository.getPrimaryEmail(user.id);
    assert.notEqual(primary.verified_at, null);
  });

  await t.test("password reset updates the real stored hash and revokes real sessions", async () => {
    const { token: sessionToken } = await sessionService.issueSession({ userId: user.id });
    assert.notEqual(await sessionService.verifySession(sessionToken), null);

    const { token: resetToken } = await service.issuePasswordResetToken(user.id);
    await service.resetPassword({ token: resetToken, newPassword: "a brand new passphrase" });

    const stored = await userRepository.getById(user.id);
    assert.equal(verifyPassword("a brand new passphrase", stored.password_hash), true);
    assert.equal(verifyPassword("original passphrase", stored.password_hash), false);
    assert.equal(await sessionService.verifySession(sessionToken), null, "the reset must have revoked the existing session");
  });

  await t.test("requesting a second reset token invalidates the first, against the real database", async () => {
    const { token: firstToken } = await service.issuePasswordResetToken(user.id);
    await service.issuePasswordResetToken(user.id);
    assert.equal(await service.resetPassword({ token: firstToken, newPassword: "should not apply" }), null);
  });
});
