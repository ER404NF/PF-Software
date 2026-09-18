// Proves the real gap this session closed: accountNotificationStore.js
// already built and queued acceptance/rejection email content, but nothing
// ever sent it. This file configures SMTP_* + COMPANY_FROM_EMAIL, mocks
// nodemailer's transport (no real network mail), and confirms an approval
// actually calls sendMail and the notification's deliveryState ends at
// "sent" — and that a send failure ends at "failed" without breaking the
// approval itself.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import nodemailer from "nodemailer";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-email-delivery-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "email-delivery-test-secret";
process.env.TWO_FACTOR_MASTER_KEY = "email-delivery-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";
process.env.COMPANY_FROM_EMAIL = "noreply@example.com";
process.env.SMTP_HOST = "smtp.example.com";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "outbox@example.com";
process.env.SMTP_PASS = "smtp-test-password";

const sentMail = [];
let nextShouldFail = false;
mock.method(nodemailer, "createTransport", () => ({
  sendMail: async (options) => {
    if (nextShouldFail) { nextShouldFail = false; throw new Error("injected SMTP failure"); }
    sentMail.push(options);
  },
}));

const auth = await import("../../src/authStore.js");
auth.createOperatorAccount({
  username: "admin-test", password: "admin-password-123", role: "admin",
  allowedDevices: null, allowedResearchWorkspaces: [], twoFactorRequired: false,
});

const { server } = await import("../../src/index.js");

async function request(baseUrl, url, { cookie, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function login(baseUrl, username, password) {
  const response = await request(baseUrl, "/api/login", { method: "POST", body: { username, password } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.headers.get("set-cookie").split(";")[0];
}

test("approving a pending signup actually sends the acceptance email via SMTP", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const adminCookie = await login(baseUrl, "admin-test", "admin-password-123");

    const signup = await request(baseUrl, "/api/signup", {
      method: "POST",
      body: {
        fullName: "Real Delivery",
        email: "real.delivery@gmail.com",
        username: "real-delivery",
        password: "real-delivery-password-123",
        passwordConfirmation: "real-delivery-password-123",
      },
    });
    assert.equal(signup.status, 201);

    const approved = await request(baseUrl, "/api/admin/users/real-delivery/status", {
      cookie: adminCookie, method: "PATCH", body: { status: "approved" },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.notification.deliveryState, "sent");
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0].to, "realdelivery@gmail.com");
    assert.equal(sentMail[0].from, "noreply@example.com");
    assert.match(sentMail[0].subject, /accepted/i);
    assert.match(sentMail[0].text, /Real Delivery/);

    // A send failure must not break the approval itself — the account is
    // already approved either way; only the notification outcome differs.
    const secondSignup = await request(baseUrl, "/api/signup", {
      method: "POST",
      body: {
        fullName: "Flaky Delivery",
        email: "flaky.delivery@gmail.com",
        username: "flaky-delivery",
        password: "flaky-delivery-password-123",
        passwordConfirmation: "flaky-delivery-password-123",
      },
    });
    assert.equal(secondSignup.status, 201);
    nextShouldFail = true;
    const rejected = await request(baseUrl, "/api/admin/users/flaky-delivery/status", {
      cookie: adminCookie, method: "PATCH", body: { status: "rejected" },
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.operator.accountStatus, "rejected");
    assert.equal(rejected.body.notification.deliveryState, "failed");
  } finally {
    server.close();
  }
});
