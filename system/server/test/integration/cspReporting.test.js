// Production-readiness audit §7, independent re-verification pass's one
// remaining suggested polish item: a CSP violation-reporting endpoint, so a
// future accidental policy mismatch surfaces on its own rather than needing
// someone to notice it via a manual browser console check.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-csp-report-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "csp-report-test-secret";
process.env.TWO_FACTOR_MASTER_KEY = "csp-report-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";
process.env.CSP_REPORT_RATE_LIMIT_MAX = "2";

const { server, auditLog } = await import("../../src/index.js");

test("the CSP declares a report-uri, and a real violation report posted there is accepted and logged", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(`${baseUrl}/`);
    assert.match(page.headers.get("content-security-policy") || "", /report-uri \/api\/csp-report/);

    const report = {
      "csp-report": {
        "document-uri": `${baseUrl}/?session=must-not-be-logged#private`,
        "violated-directive": "script-src-elem",
        "blocked-uri": "https://evil.example/inject.js?token=must-not-be-logged",
        "script-sample": "private inline content must not be logged",
      },
    };
    const response = await fetch(`${baseUrl}/api/csp-report`, {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify(report),
    });
    assert.equal(response.status, 204);

    const events = auditLog.listEvents({ limit: 10 });
    const logged = events.find(event => event.type === "csp_violation");
    assert.ok(logged, "expected the violation to be recorded in the audit log");
    // Audit data keeps the actionable origin while stripping the path and
    // query, which may contain tokens or other private page information.
    assert.equal(logged.detail.blockedUri, "https://evil.example");
    assert.equal(logged.detail.documentUri, baseUrl);
    assert.equal(JSON.stringify(logged).includes("must-not-be-logged"), false);
    assert.equal(JSON.stringify(logged).includes("private inline content"), false);
  } finally {
    server.close();
  }
});

test("a malformed CSP report body is still answered cleanly, never a 500", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${baseUrl}/api/csp-report`, {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: "not json at all",
    });
    assert.ok(response.status < 500, `expected a clean response, got ${response.status}`);
  } finally {
    server.close();
  }
});

test("unauthenticated CSP report writes are rate limited", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/csp-report`, {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify({ "csp-report": { "violated-directive": "script-src" } }),
    });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "RATE_LIMITED");
  } finally {
    server.close();
  }
});
