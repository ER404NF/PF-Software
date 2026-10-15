import fs from "fs";
import path from "path";
import crypto from "crypto";

// Exported so the Postgres notification repository (M05) can encrypt/decrypt
// recovery bodies identically, without duplicating AES-GCM handling.
export function encryptNotificationBody(body, encryptionKey) {
  if (typeof encryptionKey !== "string" || !encryptionKey) return null;
  const key = crypto.createHash("sha256").update(encryptionKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptNotificationBody(payload, encryptionKey) {
  if (!payload || payload.algorithm !== "aes-256-gcm" || typeof encryptionKey !== "string" || !encryptionKey) {
    throw new Error("secure account notification storage is not configured");
  }
  const key = crypto.createHash("sha256").update(encryptionKey).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function createAccountNotificationStore({ storePath, companyEmail = null, encryptionKey = null } = {}) {
  if (typeof storePath !== "string" || !storePath) throw new Error("notification store path is required");

  function encryptBody(body) {
    return encryptNotificationBody(body, encryptionKey);
  }

  function decryptBody(payload) {
    return decryptNotificationBody(payload, encryptionKey);
  }

  function read() {
    if (!fs.existsSync(storePath)) return [];
    const value = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return Array.isArray(value?.notifications) ? value.notifications : [];
  }

  function write(notifications) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, notifications }, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, storePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function safeItem(item) {
    const { securePayload: omittedSecurePayload, body: omittedBody, claimToken: omittedClaimToken, ...safe } = item;
    return { ...safe };
  }

  function contentFor(item) {
    const body = item.securePayload ? decryptBody(item.securePayload) : item.body;
    const { securePayload, claimToken, ...metadata } = item;
    return { ...metadata, body };
  }

  function queue({
    to, fullName, username, status = null, recoveryToken = null, holdForCommit = false,
    kind: explicitKind = null, subject: explicitSubject = null, body: explicitBody = null,
    sensitive = false, idempotencyKey = null,
  }) {
    const accepted = status === "approved";
    const rejected = status === "rejected";
    const recovery = status === "recovery";
    const received = status === "received";
    if (!explicitKind && !accepted && !rejected && !recovery && !received) throw new Error("unsupported account notification status");
    if (explicitKind && (!explicitSubject || typeof explicitBody !== "string")) throw new Error("custom notification requires subject and body");
    const subject = explicitSubject || (recovery ? "Phone Farm account recovery"
      : received ? "Your Phone Farm application was received"
      : accepted ? "Your Phone Farm account was accepted" : "Your Phone Farm account application was not accepted");
    const body = explicitBody || (recovery
      ? `Hello ${fullName}, use this one-time recovery token within 30 minutes: ${recoveryToken}`
      : received
        ? `Hello ${fullName}, we've received your application (${username}) to join Phone Farm. Your onboarding is being reviewed, and you'll be notified as soon as a decision is made.`
        : accepted
          ? `Hello ${fullName}, your Phone Farm account (${username}) was accepted. You can now sign in and complete two-factor setup.`
          : `Hello ${fullName}, your Phone Farm account application (${username}) was not accepted.`);
    const notifications = read();
    if (idempotencyKey) {
      const existingIndex = notifications.findIndex(item => item?.idempotencyKey === idempotencyKey);
      if (existingIndex >= 0) {
        const existing = notifications[existingIndex];
        if (holdForCommit && existing.deliveryState === "aborted_account_change") {
          notifications[existingIndex] = { ...existing, deliveryState: "pending_account_commit" };
          write(notifications);
          return safeItem(notifications[existingIndex]);
        }
        return safeItem(existing);
      }
    }
    const mustEncrypt = recovery || sensitive;
    const securePayload = mustEncrypt ? encryptBody(body) : null;
    if (mustEncrypt && !securePayload) throw new Error(recovery
      ? "secure recovery notification storage is not configured"
      : "secure notification storage is not configured");
    const item = {
      id: crypto.randomUUID(),
      to,
      from: companyEmail,
      subject,
      ...(!mustEncrypt ? { body } : { securePayload }),
      kind: explicitKind || (recovery ? "account_recovery" : `account_${status}`),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      deliveryState: holdForCommit ? "pending_account_commit"
        : companyEmail ? "queued" : "awaiting_sender_configuration",
      attemptCount: 0,
      attemptCycleCount: 0,
      manualRetryCount: 0,
      nextAttemptAt: null,
      createdAt: new Date().toISOString(),
    };
    write([...notifications, item]);
    return safeItem(item);
  }

  function list() {
    return read().map(safeItem).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function deliveryContent(id) {
    const item = read().find(candidate => candidate?.id === id);
    if (!item) return null;
    return contentFor(item);
  }

  function setCommitState(id, committed) {
    const notifications = read();
    const index = notifications.findIndex(item => item?.id === id);
    if (index < 0) return null;
    if (notifications[index].deliveryState !== "pending_account_commit") return safeItem(notifications[index]);
    const next = { ...notifications[index], deliveryState: committed
      ? companyEmail ? "queued" : "awaiting_sender_configuration"
      : "aborted_account_change" };
    notifications[index] = next;
    write(notifications);
    return safeItem(next);
  }

  // Only advances a "queued" item — a sender racing a status this store has
  // since moved past (e.g. it was already marked sent by a retry) leaves it
  // alone rather than clobbering a later, more-accurate state.
  function setDeliveryOutcome(id, state) {
    const notifications = read();
    const index = notifications.findIndex(item => item?.id === id);
    if (index < 0) return null;
    if (!["queued", "retrying"].includes(notifications[index].deliveryState)) return safeItem(notifications[index]);
    const { claimToken, leaseUntil, ...current } = notifications[index];
    const next = { ...current, deliveryState: state };
    notifications[index] = next;
    write(notifications);
    return safeItem(next);
  }

  // Synchronous read/claim/write makes claims atomic inside the single relay
  // process. The lease lets a later process recover a notification after a
  // crash, while the random token prevents a stale worker from completing a
  // newer attempt.
  function claimNext({ now = new Date(), maxAttempts = 5, leaseMs = 60_000, id = null } = {}) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const notifications = read();
    const index = notifications.findIndex(item => {
      if (id && item?.id !== id) return false;
      const attempts = Number.isSafeInteger(item.attemptCount) ? item.attemptCount : 0;
      const cycleAttempts = Number.isSafeInteger(item.attemptCycleCount) ? item.attemptCycleCount : attempts;
      if (cycleAttempts >= maxAttempts || ["sent", "permanently_failed", "aborted_account_change", "pending_account_commit"].includes(item.deliveryState)) return false;
      if (item.deliveryState === "queued") return true;
      if (item.deliveryState === "awaiting_sender_configuration") return Boolean(companyEmail);
      if (["failed", "retry_scheduled"].includes(item.deliveryState)) {
        // Records written by the previous implementation have neither an
        // attempt count nor a deadline. Reconcile them immediately after the
        // upgrade instead of stranding them forever.
        return !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= nowMs;
      }
      return ["retrying", "sending"].includes(item.deliveryState) && Date.parse(item.leaseUntil || "") <= nowMs;
    });
    if (index < 0) return null;
    const claimToken = crypto.randomUUID();
    const current = notifications[index];
    const next = {
      ...current,
      from: current.from || companyEmail,
      deliveryState: "sending",
      attemptCount: (Number.isSafeInteger(current.attemptCount) ? current.attemptCount : 0) + 1,
      attemptCycleCount: (Number.isSafeInteger(current.attemptCycleCount)
        ? current.attemptCycleCount
        : (Number.isSafeInteger(current.attemptCount) ? current.attemptCount : 0)) + 1,
      lastAttemptAt: new Date(nowMs).toISOString(),
      leaseUntil: new Date(nowMs + leaseMs).toISOString(),
      nextAttemptAt: null,
      claimToken,
    };
    notifications[index] = next;
    write(notifications);
    return { ...contentFor(next), claimToken };
  }

  function completeClaim(id, claimToken, { sent, nextAttemptAt = null, permanent = false, failureCategory = null } = {}) {
    const notifications = read();
    const index = notifications.findIndex(item => item?.id === id);
    if (index < 0) return null;
    const current = notifications[index];
    if (!["retrying", "sending"].includes(current.deliveryState) || current.claimToken !== claimToken) return safeItem(current);
    const { claimToken: omittedClaim, leaseUntil, ...rest } = current;
    const next = sent
      ? { ...rest, deliveryState: "sent", sentAt: new Date().toISOString(), nextAttemptAt: null }
      : {
        ...rest,
        deliveryState: permanent ? "permanently_failed" : "retry_scheduled",
        nextAttemptAt: permanent ? null : nextAttemptAt,
        ...(permanent ? { retryExhaustedAt: new Date().toISOString(), permanentFailureAt: new Date().toISOString() } : {}),
        ...(failureCategory ? { lastFailureCategory: failureCategory } : {}),
      };
    notifications[index] = next;
    write(notifications);
    return safeItem(next);
  }

  function retryEligible({ id = null } = {}) {
    const notifications = read();
    let changed = 0;
    const next = notifications.map(item => {
      if (id && item?.id !== id) return item;
      if (!["retry_scheduled", "permanently_failed", "failed", "awaiting_sender_configuration", "needs_reconciliation"].includes(item?.deliveryState)) return item;
      changed += 1;
      const { claimToken, leaseUntil, ...rest } = item;
      return {
        ...rest,
        deliveryState: companyEmail ? "queued" : "awaiting_sender_configuration",
        attemptCycleCount: 0,
        manualRetryCount: (Number.isSafeInteger(item.manualRetryCount) ? item.manualRetryCount : 0) + 1,
        lastManualRetryAt: new Date().toISOString(),
        nextAttemptAt: null,
      };
    });
    if (changed) write(next);
    return changed;
  }

  return {
    queue,
    list,
    deliveryContent,
    markCommitted: id => setCommitState(id, true),
    markAborted: id => setCommitState(id, false),
    markSent: id => setDeliveryOutcome(id, "sent"),
    markFailed: id => setDeliveryOutcome(id, "failed"),
    claimNext,
    completeClaim,
    retryEligible,
    canSecureRecovery: () => typeof encryptionKey === "string" && Boolean(encryptionKey),
  };
}
