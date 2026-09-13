import fs from "fs";
import path from "path";
import crypto from "crypto";

export function createAccountNotificationStore({ storePath, companyEmail = null } = {}) {
  if (typeof storePath !== "string" || !storePath) throw new Error("notification store path is required");

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

  function queue({ to, fullName, username, status, recoveryToken = null }) {
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
    const item = {
      id: crypto.randomUUID(),
      to,
      from: companyEmail,
      subject,
      body,
      kind: recovery ? "account_recovery" : `account_${status}`,
      deliveryState: companyEmail ? "queued" : "awaiting_sender_configuration",
      createdAt: new Date().toISOString(),
    };
    write([...notifications, item]);
    return { ...item };
  }

  function list() {
    return read().map(item => ({ ...item })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return { queue, list };
}
