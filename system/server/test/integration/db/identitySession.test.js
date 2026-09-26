// Real-PostgreSQL functional test for the M04 part 2 session
// issuance/verification/revocation layer. Skips without TEST_DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createIdentitySessionRepository } from "../../../src/db/repositories/identitySessionRepository.js";
import { createIdentitySessionService } from "../../../src/services/identitySessionService.js";
import { createUserRepository } from "../../../src/db/repositories/userRepository.js";
import { hashPassword } from "../../../src/authStore.js";

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

test("identity session service (real PostgreSQL)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const userRepository = createUserRepository(pool);
  const sessionRepository = createIdentitySessionRepository(pool);
  const service = createIdentitySessionService({ repository: sessionRepository });

  const unique = crypto.randomBytes(4).toString("hex");
  const user = await userRepository.createWithPrimaryEmail({
    email: `session-user-${unique}@example.com`,
    passwordHash: hashPassword("does not matter for this test"),
  });

  await t.test("issued session persists, verifies, and its raw token is never stored", async () => {
    const { token, session } = await service.issueSession({ userId: user.id, ip: "203.0.113.1", userAgent: "test-agent" });
    const stored = await sessionRepository.getById(session.id);
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.ip, "203.0.113.1");

    const verified = await service.verifySession(token);
    assert.equal(verified.id, session.id);
  });

  await t.test("revoking a session makes it fail to verify without deleting the row", async () => {
    const { token, session } = await service.issueSession({ userId: user.id });
    await service.revokeSession(session.id);
    assert.equal(await service.verifySession(token), null);
    const stored = await sessionRepository.getById(session.id);
    assert.notEqual(stored, null, "the row must still exist for audit purposes");
    assert.notEqual(stored.revoked_at, null);
  });

  await t.test("revokeAllSessionsForUser revokes every active session for that user, real rows included", async () => {
    const a = await service.issueSession({ userId: user.id });
    const b = await service.issueSession({ userId: user.id });
    const count = await service.revokeAllSessionsForUser(user.id);
    assert.ok(count >= 2);
    assert.equal(await service.verifySession(a.token), null);
    assert.equal(await service.verifySession(b.token), null);
  });

  await t.test("a session cannot be forged by guessing another session's id", async () => {
    const { session } = await service.issueSession({ userId: user.id });
    // Verifying requires the actual token, not the (non-secret) session id.
    assert.equal(await service.verifySession(session.id), null);
  });
});
