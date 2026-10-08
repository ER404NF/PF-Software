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

const DEFAULT_TIMEOUTS = Object.freeze({ connection: 10_000, greeting: 10_000, socket: 20_000, overall: 30_000 });
const MAX_TIMEOUT_MS = 120_000;

function boundedTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_TIMEOUT_MS) : fallback;
}

export function createMailSender({ host, port, user, pass, from: configuredFrom, secure = false, timeouts = {} } = {}) {
  const missing = [
    ...(!host ? ["SMTP_HOST"] : []), ...(!port ? ["SMTP_PORT"] : []),
    ...(!user ? ["SMTP_USER"] : []), ...(!pass ? ["SMTP_PASS"] : []),
    ...(!configuredFrom ? ["COMPANY_FROM_EMAIL"] : []),
  ];
  const configured = missing.length === 0;
  const resolvedTimeouts = {
    connection: boundedTimeout(timeouts.connection, DEFAULT_TIMEOUTS.connection),
    greeting: boundedTimeout(timeouts.greeting, DEFAULT_TIMEOUTS.greeting),
    socket: boundedTimeout(timeouts.socket, DEFAULT_TIMEOUTS.socket),
    overall: boundedTimeout(timeouts.overall, DEFAULT_TIMEOUTS.overall),
  };
  const transporter = configured
    ? nodemailer.createTransport({
      host, port: Number(port), secure: Boolean(secure), auth: { user, pass },
      connectionTimeout: resolvedTimeouts.connection,
      greetingTimeout: resolvedTimeouts.greeting,
      socketTimeout: resolvedTimeouts.socket,
    })
    : null;

  async function send({ to, from: messageFrom, subject, body }) {
    if (!transporter) throw new Error("SMTP is not configured");
    if (typeof to !== "string" || !to) throw new Error("a recipient address is required");
    let timer;
    try {
      await Promise.race([
        transporter.sendMail({ to, from: messageFrom || configuredFrom, subject, text: body }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            // Abort the transport before making this item retryable. Without
            // closing the socket, a late send could complete after the lease
            // has been released and a retry could duplicate it.
            try { transporter.close?.(); } catch { /* the safe timeout still wins */ }
            reject(Object.assign(new Error("Email delivery timed out."), { code: "MAIL_SEND_TIMEOUT" }));
          }, resolvedTimeouts.overall);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      // Transport exceptions may contain connection URLs or authentication
      // details. Callers only receive a stable category and may log it safely.
      const safe = new Error(error?.code === "MAIL_SEND_TIMEOUT" ? "Email delivery timed out." : "Email delivery failed.");
      safe.code = error?.code === "MAIL_SEND_TIMEOUT" ? "MAIL_SEND_TIMEOUT" : "MAIL_SEND_FAILED";
      throw safe;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isConfigured: () => configured,
    configurationStatus: () => ({ configured, missing: [...missing] }),
    send,
  };
}
