import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignment-post-commit-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "assignment-post-commit-test-secret";
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";

const auth = await import("../../src/authStore.js");
auth.createOperatorAccount({
  username: "assignment-manager", password: "assignment-manager-password-123", role: "manager",
  teamId: "assignment-team", allowedDevices: [], allowedResearchWorkspaces: [], twoFactorRequired: false,
});
auth.createOperatorAccount({
  username: "assignment-worker", password: "assignment-worker-password-123", role: "va",
  teamId: "assignment-team", allowedDevices: [], allowedResearchWorkspaces: [], twoFactorRequired: false,
});

const { server, auditLog, assignmentStore } = await import("../../src/index.js");

async function request(baseUrl, url, { cookie, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test("committed assignment mutations and expiry remain successful when audit storage fails", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalAuditWrite = auditLog.logEvent;
  try {
    const login = await request(baseUrl, "/api/login", {
      method: "POST", body: { username: "assignment-manager", password: "assignment-manager-password-123" },
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    auditLog.logEvent = () => { throw new Error("injected assignment audit failure"); };

    const created = await request(baseUrl, "/api/assignments", {
      cookie, method: "POST", body: { assignee: "assignment-worker", instructions: "Inspect the assigned queue." },
    });
    assert.equal(created.status, 201, "a durable assignment must not be reported as failed");
    assert.equal(assignmentStore.list().length, 1);

    const progressed = await request(baseUrl, `/api/assignments/${created.body.assignment.id}`, {
      cookie, method: "PATCH", body: { status: "in_progress" },
    });
    assert.equal(progressed.status, 200, "a durable assignment transition must not be reported as failed");
    assert.equal(assignmentStore.get(created.body.assignment.id).status, "in_progress");

    const now = Date.now();
    const scheduled = await request(baseUrl, "/api/assignments", {
      cookie, method: "POST", body: {
        assignee: "assignment-worker",
        instructions: "Expire this short acceptance window.",
        startAt: new Date(now + 100).toISOString(),
        endAt: new Date(now + 300).toISOString(),
      },
    });
    assert.equal(scheduled.status, 201);
    await new Promise(resolve => setTimeout(resolve, 400));
    const listed = await request(baseUrl, "/api/assignments", { cookie });
    assert.equal(listed.status, 200, "expiry audit failure must not hide the committed terminal state");
    assert.equal(assignmentStore.get(scheduled.body.assignment.id).status, "expired");
  } finally {
    auditLog.logEvent = originalAuditWrite;
    server.close();
  }
});
