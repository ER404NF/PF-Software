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
    if (nextShouldFail) {
      nextShouldFail = false;
      throw new Error("SMTP auth failed for smtp://outbox@example.com:sensitive-password@smtp.example.com");
    }
    sentMail.push(options);
  },
}));

const auth = await import("../../src/authStore.js");
auth.createOperatorAccount({
  username: "admin-test", password: "admin-password-123", role: "admin",
  allowedDevices: null, allowedResearchWorkspaces: [], twoFactorRequired: false,
});
auth.createOperatorAccount({
  username: "recovery-target", password: "recovery-target-password-123", role: "va",
  fullName: "Recovery Target", email: "recovery.target@gmail.com",
  allowedDevices: [], allowedResearchWorkspaces: [], twoFactorRequired: false,
});

const { server, accountNotificationStore, auditLog } = await import("../../src/index.js");

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

test("signup/review notifications send when available and post-commit failures never misreport account state", async () => {
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

    // Signup itself now fires a "received" email before any admin action —
    // confirm it landed before asserting on the approval's own email.
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0].to, "realdelivery@gmail.com");
    assert.match(sentMail[0].subject, /received/i);
    assert.match(sentMail[0].text, /Real Delivery/);

    const approved = await request(baseUrl, "/api/admin/users/real-delivery/status", {
      cookie: adminCookie, method: "PATCH", body: { status: "approved" },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.notification.deliveryState, "sent");
    assert.equal(sentMail.length, 2);
    const acceptedMail = sentMail.find(mail => /accepted/i.test(mail.subject));
    assert.ok(acceptedMail, "expected an acceptance email to have been sent");
    assert.equal(acceptedMail.to, "realdelivery@gmail.com");
    assert.equal(acceptedMail.from, "noreply@example.com");
    assert.match(acceptedMail.text, /Real Delivery/);

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
    const originalConsoleError = console.error;
    const deliveryErrors = [];
    console.error = (...values) => { deliveryErrors.push(values.map(String).join(" ")); };
    let rejected;
    try {
      rejected = await request(baseUrl, "/api/admin/users/flaky-delivery/status", {
        cookie: adminCookie, method: "PATCH", body: { status: "rejected" },
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.operator.accountStatus, "rejected");
    assert.equal(rejected.body.notification.deliveryState, "failed");
    assert.ok(deliveryErrors.some(message => message.includes("Account notification email send failed")));
    assert.equal(deliveryErrors.some(message => /sensitive-password|outbox@example\.com|smtp\.example\.com/.test(message)), false,
      "SMTP credentials and endpoints must not be copied from transport errors into logs");

    const failureStateSignup = await request(baseUrl, "/api/signup", {
      method: "POST",
      body: {
        fullName: "Failure State",
        email: "failure.state@gmail.com",
        username: "failure-state",
        password: "failure-state-password-123",
        passwordConfirmation: "failure-state-password-123",
      },
    });
    assert.equal(failureStateSignup.status, 201);
    const originalMarkFailed = accountNotificationStore.markFailed;
    accountNotificationStore.markFailed = () => {
      throw new Error("failed to write C:/sensitive/outbox/account-notifications.json");
    };
    nextShouldFail = true;
    try {
      const committedWithUnrecordedDeliveryFailure = await request(baseUrl, "/api/admin/users/failure-state/status", {
        cookie: adminCookie, method: "PATCH", body: { status: "rejected" },
      });
      assert.equal(committedWithUnrecordedDeliveryFailure.status, 200);
      assert.equal(committedWithUnrecordedDeliveryFailure.body.operator.accountStatus, "rejected");
      assert.equal(committedWithUnrecordedDeliveryFailure.body.notification.deliveryState, "pending_reconciliation");
    } finally {
      accountNotificationStore.markFailed = originalMarkFailed;
    }

    // Account creation is the authoritative commit. A later outbox write
    // failure must not turn that completed mutation into a misleading 500
    // that invites a duplicate retry.
    const originalQueue = accountNotificationStore.queue;
    accountNotificationStore.queue = () => { throw new Error("injected outbox disk failure"); };
    try {
      const committedWithoutOutbox = await request(baseUrl, "/api/signup", {
        method: "POST",
        body: {
          fullName: "Outbox Failure",
          email: "outbox.failure@gmail.com",
          username: "outbox-failure",
          password: "outbox-failure-password-123",
          passwordConfirmation: "outbox-failure-password-123",
        },
      });
      assert.equal(committedWithoutOutbox.status, 201);
      assert.equal(committedWithoutOutbox.body.operator.username, "outbox-failure");
      assert.equal(auth.listOperatorAccounts().some(account => account.username === "outbox-failure"), true);
    } finally {
      accountNotificationStore.queue = originalQueue;
    }

    const originalAuditWrite = auditLog.logEvent;
    auditLog.logEvent = () => { throw new Error("injected audit disk failure"); };
    try {
      const committedWithoutAudit = await request(baseUrl, "/api/signup", {
        method: "POST",
        body: {
          fullName: "Audit Failure",
          email: "audit.failure@gmail.com",
          username: "audit-failure",
          password: "audit-failure-password-123",
          passwordConfirmation: "audit-failure-password-123",
        },
      });
      assert.equal(committedWithoutAudit.status, 201);
      assert.equal(auth.listOperatorAccounts().some(account => account.username === "audit-failure"), true);
    } finally {
      auditLog.logEvent = originalAuditWrite;
    }

    auditLog.logEvent = () => { throw new Error("injected login audit failure"); };
    try {
      const loginWithDegradedAudit = await request(baseUrl, "/api/login", {
        method: "POST",
        body: { username: "admin-test", password: "admin-password-123" },
      });
      assert.equal(loginWithDegradedAudit.status, 200,
        "best-effort login audit failure must not produce an ambiguous failed login");
    } finally {
      auditLog.logEvent = originalAuditWrite;
    }

    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (targetPath, ...args) => {
      if (String(targetPath).includes(".operators.json.") && String(targetPath).endsWith(".tmp")) {
        throw new Error("injected login-IP persistence failure");
      }
      return originalWriteFileSync(targetPath, ...args);
    };
    try {
      const loginWithDegradedIpHistory = await request(baseUrl, "/api/login", {
        method: "POST",
        body: { username: "admin-test", password: "admin-password-123" },
      });
      assert.equal(loginWithDegradedIpHistory.status, 200,
        "best-effort login-IP persistence must not produce an ambiguous failed login");
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    const sentBeforeRecovery = sentMail.length;
    accountNotificationStore.queue = () => { throw new Error("injected recovery outbox failure"); };
    try {
      const failedOutboxRequest = await request(baseUrl, "/api/recovery/request", {
        method: "POST", body: { identifier: "recovery-target" },
      });
      assert.equal(failedOutboxRequest.status, 200,
        "recovery remains enumeration-safe when its outbox is temporarily unavailable");
    } finally {
      accountNotificationStore.queue = originalQueue;
    }
    const retriedRecovery = await request(baseUrl, "/api/recovery/request", {
      method: "POST", body: { identifier: "recovery-target" },
    });
    assert.equal(retriedRecovery.status, 200);
    assert.equal(sentMail.length, sentBeforeRecovery + 1,
      "a failed outbox write must roll back that exact token so a retry can deliver a fresh one");

    const recoveryMail = sentMail.at(-1);
    const recoveryToken = recoveryMail.text.match(/: ([A-Za-z0-9_-]+)$/)?.[1];
    assert.ok(recoveryToken, "the delivered recovery message must contain its one-time token");
    const oldRecoverySession = await login(baseUrl, "recovery-target", "recovery-target-password-123");
    auditLog.logEvent = () => { throw new Error("injected recovery-completion audit failure"); };
    try {
      const completedWithDegradedAudit = await request(baseUrl, "/api/recovery/complete", {
        method: "POST",
        body: {
          token: recoveryToken,
          password: "recovery-target-new-password-123",
          passwordConfirmation: "recovery-target-new-password-123",
        },
      });
      assert.equal(completedWithDegradedAudit.status, 200,
        "a completed password reset must not be reported as failed because its audit sink is down");
    } finally {
      auditLog.logEvent = originalAuditWrite;
    }
    const staleSession = await request(baseUrl, "/api/me", { cookie: oldRecoverySession });
    assert.equal(staleSession.status, 401, "password recovery must revoke existing sessions even if audit fails");
  } finally {
    server.close();
  }
});
