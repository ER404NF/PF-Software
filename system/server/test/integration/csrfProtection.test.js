// Production-readiness audit §1: sameSite: "lax" already blocked the classic
// cross-site <form> POST vector, but wasn't the same guarantee as an
// explicit CSRF defense. Proof required: a forged cross-origin POST
// (correct session cookie, wrong Origin) is rejected once the check exists.
//
// See index.js's Origin/Referer verification middleware for why this uses
// Origin checking rather than a token: a token would require retrofitting
// ~20 existing test files' hand-rolled fetch() helpers for no gain in this
// app's actual threat model (CSRF is a browser-only attack; Node's fetch()
// never sets Origin for same-process calls, matching how every other test
// in this suite already behaves without needing any change here).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-csrf-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "csrf-test-secret";
process.env.TWO_FACTOR_MASTER_KEY = "csrf-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";

const auth = await import("../../src/authStore.js");
auth.createOperatorAccount({
  username: "csrf-admin", password: "csrf-admin-password-123", role: "admin",
  allowedDevices: null, allowedResearchWorkspaces: [],
});

const { server } = await import("../../src/index.js");

test("a forged cross-origin POST riding a real session cookie is rejected; a same-origin one still works", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const loginResponse = await fetch(`${baseUrl}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "csrf-admin", password: "csrf-admin-password-123" }),
    });
    assert.equal(loginResponse.status, 200, await loginResponse.text());
    const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

    // A forged request: the correct session cookie (as a real victim's
    // browser would automatically attach), but an Origin the real app would
    // never send — exactly what a hostile third-party page's own forged
    // <form>/fetch POST to this endpoint would look like server-side.
    const forged = await fetch(`${baseUrl}/api/admin/users/csrf-admin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "https://attacker.example" },
      body: JSON.stringify({ fullName: "Forged Name" }),
    });
    assert.equal(forged.status, 403);
    assert.equal((await forged.json()).code, "CSRF_REJECTED");

    // The exact same request, with no Origin at all (matching how every
    // legitimate non-browser API caller and this whole test suite already
    // behaves) or a same-origin one, must still work normally.
    const legitimate = await fetch(`${baseUrl}/api/admin/users/csrf-admin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ fullName: "Real Change" }),
    });
    assert.equal(legitimate.status, 200, await legitimate.text());

    const sameOrigin = await fetch(`${baseUrl}/api/admin/users/csrf-admin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: baseUrl },
      body: JSON.stringify({ fullName: "Same Origin Change" }),
    });
    assert.equal(sameOrigin.status, 200, await sameOrigin.text());
  } finally {
    server.close();
  }
});

test("a forged cross-origin request with no session cookie at all still just gets the normal 401, not a CSRF-specific leak", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${baseUrl}/api/admin/users/csrf-admin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ fullName: "Nope" }),
    });
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});
