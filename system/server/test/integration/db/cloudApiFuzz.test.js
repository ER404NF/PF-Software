// Real end-to-end fuzz pass for Phase 1 tasks P2 step 5 / P6 step 1
// (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md): every cloud-facing
// route, mounted for real inside the actual system/server/src/index.js
// (CLOUD_API_ENABLED=true), hit with malformed JSON, null, oversized bodies,
// wrong types, and prototype-pollution shapes. Every one must answer with a
// clean 4xx, never a 500 — matching the exact method that already found the
// installer's server-exits-silently bug and requestErrors.test.js's
// INVALID_JSON/PAYLOAD_TOO_LARGE fix in this same codebase. Skips without
// TEST_DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  test("cloud API routes reject hostile input cleanly (real database, real HTTP)", {
    skip: "TEST_DATABASE_URL is not set — this test only runs against a real PostgreSQL instance (see .github/workflows/db-migrations.yml)",
  }, () => {});
} else {
  const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const systemRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const migrationsDir = path.join(serverRoot, "migrations");
  const migrateBin = path.join(systemRoot, "node_modules", "node-pg-migrate", "bin", "node-pg-migrate.js");
  await execFileAsync(process.execPath, [migrateBin, "up", "--migrations-dir", migrationsDir], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-cloud-api-fuzz-"));
  process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
  process.env.FILE_STORE_DIR = path.join(root, "files");
  process.env.SESSION_STORE_DIR = path.join(root, "sessions");
  process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
  process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
  process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
  process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
  process.env.RESEARCH_STORE_DIR = path.join(root, "research");
  process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
  process.env.SESSION_SECRET = "cloud-api-fuzz-test-secret";
  process.env.TWO_FACTOR_MASTER_KEY = "cloud-api-fuzz-test-two-factor-key-123456";
  process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
  process.env.AUTO_DISCOVER_IOS_DEVICES = "false";
  process.env.CLOUD_API_ENABLED = "true";
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  const { server } = await import("../../../src/index.js");

  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  test("cloud API routes reject hostile input cleanly (real database, real HTTP)", async (t) => {
    t.after(() => new Promise((resolve) => server.close(resolve)));

    // Every JSON-bodied route this API exposes, with a representative valid-shaped Bearer token so
    // routes gated by authenticate() at least reach their own body handling rather than short-circuiting
    // on missing auth (which requestErrors.test.js-style fuzzing of anonymous access already covers via
    // the authorization matrix in cloudApi.test.js).
    const jsonRoutes = [
      "/api/cloud/signup",
      "/api/cloud/signup-from-invitation",
      "/api/cloud/login",
      "/api/cloud/organizations/00000000-0000-0000-0000-000000000000/invitations",
      "/api/cloud/invitations/accept",
      "/api/cloud/organizations/00000000-0000-0000-0000-000000000000/members/00000000-0000-0000-0000-000000000000",
      "/api/cloud/me/mfa/confirm",
      "/api/cloud/password-reset/request",
      "/api/cloud/password-reset/confirm",
      "/api/cloud/email-verification/confirm",
    ];

    const authHeader = { authorization: "Bearer pfu_this-is-not-a-real-token-but-has-a-plausible-shape" };

    async function send(route, method, body, extraHeaders = {}) {
      return fetch(`${baseUrl}${route}`, {
        method,
        headers: { "content-type": "application/json", ...authHeader, ...extraHeaders },
        body,
      });
    }

    // /password-reset/request is deliberately, correctly uniform: it returns
    // 202 regardless of whether the input was semantically well-formed, or
    // an unregistered email — never confirming or denying account existence
    // to an unauthenticated caller (see its own comment in createCloudApi.js).
    // That uniformity only applies once the request has actually reached
    // the route's own logic: unparseable JSON (malformed/null) and oversized
    // bodies are rejected by body-parser/Express itself, before any route
    // handler runs, and that rejection is (correctly) the same for every
    // route regardless of its own semantics — so only the "well-formed JSON,
    // wrong shape" cases below get this route's special-cased expectation.
    function assertCleanStatus(response, route, { allowUniform204x = false } = {}) {
      if (allowUniform204x && route === "/api/cloud/password-reset/request") {
        assert.equal(response.status, 202, `expected the uniform 202 for ${route}, got ${response.status}`);
      } else {
        assert.ok(response.status >= 400 && response.status < 500, `expected 4xx for ${route}, got ${response.status}`);
      }
    }

    for (const route of jsonRoutes) {
      const method = route.includes("/members/") ? "PATCH" : "POST";

      await t.test(`${method} ${route}: malformed JSON is a clean, non-500 response`, async () => {
        const response = await send(route, method, '{"a":');
        assertCleanStatus(response, route);
        const body = await response.json().catch(() => null);
        assert.ok(body && typeof body.error === "string", "the error response must still be valid, readable JSON");
      });

      await t.test(`${method} ${route}: a bare null body is a clean, non-500 response`, async () => {
        const response = await send(route, method, "null");
        assertCleanStatus(response, route);
      });

      await t.test(`${method} ${route}: a bare array body (wrong top-level type) is a clean, non-500 response`, async () => {
        const response = await send(route, method, "[1,2,3]");
        assertCleanStatus(response, route, { allowUniform204x: true });
      });

      await t.test(`${method} ${route}: wrong-typed fields (numbers/objects instead of strings) are a clean, non-500 response`, async () => {
        const response = await send(route, method, JSON.stringify({
          email: 12345, password: { nested: true }, token: [1, 2, 3], slug: null, roleKey: 42, status: {},
        }));
        assertCleanStatus(response, route, { allowUniform204x: true });
      });

      await t.test(`${method} ${route}: a prototype-pollution-shaped body is a clean, non-500 response, and pollutes nothing`, async () => {
        const response = await send(route, method, JSON.stringify({
          email: "x@example.com", password: "irrelevant-password-value",
          __proto__: { polluted: true }, constructor: { prototype: { polluted: true } },
        }));
        assertCleanStatus(response, route, { allowUniform204x: true });
        assert.equal({}.polluted, undefined, "the request body must never reach Object.prototype");
      });

      await t.test(`${method} ${route}: an oversized body is rejected cleanly, never a 500`, async () => {
        const response = await send(route, method, JSON.stringify({ email: "A".repeat(2_000_000) }));
        assertCleanStatus(response, route);
      });
    }

    await t.test("GET /api/cloud/me and GET /api/cloud/organizations/:id/members tolerate a hostile Authorization header, never a 500", async () => {
      // A very long token and a SQL-injection-shaped string — values an HTTP
      // client can actually transmit as a header. Raw control characters or
      // a UTF-16 surrogate half are deliberately NOT used here: fetch()'s
      // own Headers validation refuses to send either (a real HTTP client
      // can't put them in a header value either, since HTTP headers are
      // octet sequences, not arbitrary JS strings) — confirmed directly
      // rather than assumed, after the first version of this test failed
      // on exactly that unsendable-input mistake.
      const hostileTokens = [
        `pfu_${"A".repeat(10_000)}`,
        "' OR '1'='1",
        "not-even-close-to-a-real-token-but-plausible-shape",
      ];
      for (const route of ["/api/cloud/me", "/api/cloud/organizations/00000000-0000-0000-0000-000000000000/members"]) {
        for (const token of hostileTokens) {
          const response = await fetch(`${baseUrl}${route}`, { headers: { authorization: `Bearer ${token}` } });
          assert.ok(response.status >= 400 && response.status < 500, `expected 4xx for ${route} with a hostile token, got ${response.status}`);
        }
      }
    });
  });
}
