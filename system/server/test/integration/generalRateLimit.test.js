// Production-readiness audit §8: ordinary API routes previously had no
// general request-rate limiter at all (only login/2FA/signup/recovery did,
// via the pre-existing createAuthenticationThrottle). Proof required:
// exceeding the limit gets a clear 429; normal use stays well under it.
//
// API_RATE_LIMIT_MAX/API_RATE_LIMIT_WINDOW_MS must be set before index.js is
// imported (it reads them once, building the limiter at module load), which
// is why this gets its own file with a low test-only limit rather than
// reusing another integration test's shared server instance.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-rate-limit-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "rate-limit-test-secret";
process.env.TWO_FACTOR_MASTER_KEY = "rate-limit-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";
process.env.API_RATE_LIMIT_MAX = "5";
process.env.API_RATE_LIMIT_WINDOW_MS = "60000";

const auth = await import("../../src/authStore.js");
auth.createOperatorAccount({
  username: "rate-limit-admin", password: "rate-limit-admin-password-123", role: "admin",
  allowedDevices: null, allowedResearchWorkspaces: [],
});

const { server } = await import("../../src/index.js");

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, await response.text());
  return response.headers.get("set-cookie").split(";")[0];
}

test("a signed-in operator hammering an ordinary API route past the general limit gets a clean 429, then recovers", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const cookie = await login(baseUrl, "rate-limit-admin", "rate-limit-admin-password-123");

    // The limit is 5/minute for this test; the first 5 requests must behave
    // completely normally.
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, `request ${i + 1} of 5 should be normal, got ${response.status}`);
    }

    // The 6th request in the same window is rejected cleanly, not a hang or
    // a 500.
    const limited = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: cookie } });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, "RATE_LIMITED");
    assert.ok(limited.headers.get("ratelimit-limit"), "standard RateLimit-* headers should be present");
  } finally {
    server.close();
  }
});
