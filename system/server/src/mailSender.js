// Actually sends the notifications accountNotificationStore.js already
// queues (acceptance/rejection/recovery emails) — that store only ever
// built content and marked it "queued"; nothing read the queue and sent
// real mail until now. SMTP via nodemailer, not a hand-rolled client:
// STARTTLS/auth-mechanism negotiation is exactly the kind of protocol
// detail not worth re-implementing.
//
// Config is env-var only, matching every other external integration in
// this codebase (AUTO_ROUTE_PROXY_TUNNELS, COMPANY_FROM_EMAIL, ...) —
// missing config means isConfigured() is false and callers skip sending
// with a logged reason, never a hard startup crash.

import nodemailer from "nodemailer";

export function createMailSender({ host, port, user, pass, secure = false } = {}) {
  const configured = Boolean(host && port && user && pass);
  const transporter = configured
    ? nodemailer.createTransport({ host, port: Number(port), secure: Boolean(secure), auth: { user, pass } })
    : null;

  async function send({ to, from, subject, body }) {
    if (!transporter) throw new Error("SMTP is not configured");
    if (typeof to !== "string" || !to) throw new Error("a recipient address is required");
    await transporter.sendMail({ to, from: from || user, subject, text: body });
  }

  return {
    isConfigured: () => configured,
    send,
  };
}
