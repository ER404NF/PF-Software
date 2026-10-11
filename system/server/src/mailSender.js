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
import { smtpConfigurationStatus } from "./secureRecoveryCapability.js";

const DEFAULT_TIMEOUTS = Object.freeze({ connection: 10_000, greeting: 10_000, socket: 20_000, overall: 30_000 });
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

function boundedTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_TIMEOUT_MS) : fallback;
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function brevoSender(value) {
  const trimmed = value.trim();
  const named = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
  return named
    ? { email: named[2].trim(), ...(named[1].trim() ? { name: named[1].trim().replace(/^"|"$/g, "") } : {}) }
    : { email: trimmed };
}

export function createMailSender({
  host, port, user, pass, from: configuredFrom, secure = false, timeouts = {},
  apiKey = process.env.BREVO_API_KEY,
  apiUrl = process.env.BREVO_API_URL || DEFAULT_BREVO_API_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const configuration = smtpConfigurationStatus({
    SMTP_HOST: host, SMTP_PORT: String(port ?? ""), SMTP_USER: user,
    SMTP_PASS: pass, COMPANY_FROM_EMAIL: configuredFrom,
  });
  const apiConfigured = nonBlank(apiKey) && nonBlank(configuredFrom) && typeof fetchImpl === "function";
  const missing = apiConfigured ? [] : configuration.missing;
  const configured = apiConfigured || configuration.configured;
  const resolvedTimeouts = {
    connection: boundedTimeout(timeouts.connection, DEFAULT_TIMEOUTS.connection),
    greeting: boundedTimeout(timeouts.greeting, DEFAULT_TIMEOUTS.greeting),
    socket: boundedTimeout(timeouts.socket, DEFAULT_TIMEOUTS.socket),
    overall: boundedTimeout(timeouts.overall, DEFAULT_TIMEOUTS.overall),
  };
  const transporter = configuration.configured
    ? nodemailer.createTransport({
      host, port: Number(port), secure: Boolean(secure), auth: { user, pass },
      connectionTimeout: resolvedTimeouts.connection,
      greetingTimeout: resolvedTimeouts.greeting,
      socketTimeout: resolvedTimeouts.socket,
    })
    : null;

  async function send({ to, from: messageFrom, subject, body }) {
    if (!configured) throw new Error("Email delivery is not configured");
    if (typeof to !== "string" || !to) throw new Error("a recipient address is required");
    if (apiConfigured) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), resolvedTimeouts.overall);
      timer.unref?.();
      try {
        const response = await fetchImpl(apiUrl, {
          method: "POST",
          headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            sender: brevoSender(messageFrom || configuredFrom),
            to: [{ email: to }],
            subject,
            textContent: body,
          }),
          signal: controller.signal,
        });
        if (!response?.ok) throw Object.assign(new Error("Brevo rejected email delivery."), { code: "MAIL_SEND_FAILED" });
        return;
      } catch (error) {
        const timedOut = error?.name === "AbortError";
        const safe = new Error(timedOut ? "Email delivery timed out." : "Email delivery failed.");
        safe.code = timedOut ? "MAIL_SEND_TIMEOUT" : "MAIL_SEND_FAILED";
        throw safe;
      } finally {
        clearTimeout(timer);
      }
    }
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
