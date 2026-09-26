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
    const { securePayload: omittedSecurePayload, ...safe } = item;
    return { ...safe };
  }

  function queue({ to, fullName, username, status, recoveryToken = null, holdForCommit = false }) {
    const accepted = status === "approved";
    const rejected = status === "rejected";
    const recovery = status === "recovery";
    if (!accepted && !rejected && !recovery) throw new Error("unsupported account notification status");
    const subject = recovery ? "Phone Farm account recovery"
      : accepted ? "Your Phone Farm account was accepted" : "Your Phone Farm account application was not accepted";
    const body = recovery
      ? `Hello ${fullName}, use this one-time recovery token within 30 minutes: ${recoveryToken}`
      : accepted
        ? `Hello ${fullName}, your Phone Farm account (${username}) was accepted. You can now sign in and complete two-factor setup.`
        : `Hello ${fullName}, your Phone Farm account application (${username}) was not accepted.`;
    const notifications = read();
    const securePayload = recovery ? encryptBody(body) : null;
    if (recovery && !securePayload) throw new Error("secure recovery notification storage is not configured");
    const item = {
      id: crypto.randomUUID(),
      to,
      from: companyEmail,
      subject,
      ...(!recovery ? { body } : { securePayload }),
      kind: recovery ? "account_recovery" : `account_${status}`,
      deliveryState: holdForCommit ? "pending_account_commit"
        : companyEmail ? "queued" : "awaiting_sender_configuration",
      createdAt: new Date().toISOString(),
    };
    write([...notifications, item]);
    return safeItem(item);
  }

  function list() {
    return read().map(item => ({ ...item })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function deliveryContent(id) {
    const item = read().find(candidate => candidate?.id === id);
    if (!item) return null;
    const body = item.kind === "account_recovery" ? decryptBody(item.securePayload) : item.body;
    const { securePayload, ...metadata } = item;
    return { ...metadata, body };
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
    if (notifications[index].deliveryState !== "queued") return safeItem(notifications[index]);
    const next = { ...notifications[index], deliveryState: state };
    notifications[index] = next;
    write(notifications);
    return safeItem(next);
  }

  return {
    queue,
    list,
    deliveryContent,
    markCommitted: id => setCommitState(id, true),
    markAborted: id => setCommitState(id, false),
    markSent: id => setDeliveryOutcome(id, "sent"),
    markFailed: id => setDeliveryOutcome(id, "failed"),
    canSecureRecovery: () => typeof encryptionKey === "string" && Boolean(encryptionKey),
  };
}
