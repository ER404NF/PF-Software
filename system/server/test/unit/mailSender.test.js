import { test, mock } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { createMailSender } from "../../src/mailSender.js";

test("createMailSender reports unconfigured when any SMTP field is missing", () => {
  for (const config of [
    {}, { host: "smtp.example.com" },
    { host: "smtp.example.com", port: 587, user: "a", pass: "p" },
  ]) {
    assert.equal(createMailSender(config).isConfigured(), false);
  }
});

test("whitespace-only SMTP and sender fields are unconfigured, matching recovery capability", () => {
  const sender = createMailSender({ host: " ", port: " ", user: " ", pass: " ", from: " " });
  assert.equal(sender.isConfigured(), false);
  assert.deepEqual(sender.configurationStatus().missing,
    ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "COMPANY_FROM_EMAIL"]);
});

test("an invalid SMTP port is unconfigured instead of advertising unusable recovery", () => {
  for (const port of ["not-a-port", "0", "65536", "1.5"]) {
    const sender = createMailSender({ host: "smtp.example.test", port, user: "user", pass: "pass", from: "from@example.test" });
    assert.equal(sender.isConfigured(), false, port);
    assert.deepEqual(sender.configurationStatus().missing, ["SMTP_PORT"], port);
  }
});

test("send() throws instead of silently no-op'ing when unconfigured", async () => {
  const sender = createMailSender({});
  await assert.rejects(() => sender.send({ to: "a@example.com", subject: "s", body: "b" }), /not configured/);
});

test("Brevo HTTPS transport is configured without SMTP and sends the expected safe payload", async () => {
  const calls = [];
  const sender = createMailSender({
    apiKey: "brevo-secret", from: "Phone Farm <noreply@example.com>",
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 201 }; },
  });
  assert.equal(sender.isConfigured(), true);
  assert.deepEqual(sender.configurationStatus(), { configured: true, missing: [] });
  await sender.send({ to: "person@example.com", subject: "Hello", body: "World" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(calls[0].options.headers["api-key"], "brevo-secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sender: { email: "noreply@example.com", name: "Phone Farm" },
    to: [{ email: "person@example.com" }], subject: "Hello", textContent: "World",
  });
});

test("Brevo HTTPS transport returns a stable error without exposing provider details", async () => {
  const sender = createMailSender({
    apiKey: "brevo-secret", from: "noreply@example.com",
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  await assert.rejects(
    () => sender.send({ to: "person@example.com", subject: "Hello", body: "private-token" }),
    error => error.code === "MAIL_SEND_FAILED" && !/brevo-secret|private-token|401/.test(error.message),
  );
});

test("a configured sender calls nodemailer's sendMail with the expected envelope", async () => {
  const calls = [];
  const createTransport = mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (options) => { calls.push(options); },
  }));
  try {
    const sender = createMailSender({ host: "smtp.example.com", port: 587, user: "outbox@example.com", pass: "secret", from: "noreply@example.com", secure: false });
    assert.equal(sender.isConfigured(), true);
    await sender.send({ to: "person@example.com", from: "custom@example.com", subject: "Hello", body: "World" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { to: "person@example.com", from: "custom@example.com", subject: "Hello", text: "World" });
    assert.deepEqual(createTransport.mock.calls[0].arguments[0], {
      host: "smtp.example.com", port: 587, secure: false,
      auth: { user: "outbox@example.com", pass: "secret" },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
  } finally {
    createTransport.mock.restore();
  }
});

test("a missing message `from` falls back to the verified company sender", async () => {
  const calls = [];
  mock.method(nodemailer, "createTransport", () => ({ sendMail: async (options) => { calls.push(options); } }));
  try {
    const sender = createMailSender({ host: "smtp.example.com", port: 587, user: "outbox@example.com", pass: "secret", from: "noreply@example.com" });
    await sender.send({ to: "person@example.com", subject: "Hello", body: "World" });
    assert.equal(calls[0].from, "noreply@example.com");
  } finally {
    mock.restoreAll();
  }
});

test("send() rejects a missing recipient instead of calling sendMail", async () => {
  mock.method(nodemailer, "createTransport", () => ({ sendMail: async () => { throw new Error("should not be called"); } }));
  try {
    const sender = createMailSender({ host: "smtp.example.com", port: 587, user: "outbox@example.com", pass: "secret", from: "noreply@example.com" });
    await assert.rejects(() => sender.send({ subject: "Hello", body: "World" }), /recipient/);
  } finally {
    mock.restoreAll();
  }
});

test("configuration status names missing settings without exposing configured values", () => {
  const status = createMailSender({ host: "smtp.private", port: 587, user: "secret-user", pass: "secret-pass" }).configurationStatus();
  assert.deepEqual(status, { configured: false, missing: ["COMPANY_FROM_EMAIL"] });
  assert.doesNotMatch(JSON.stringify(status), /smtp\.private|secret-user|secret-pass/);
});

test("overall SMTP timeout is bounded and returns only a safe error", async () => {
  let closed = false;
  mock.method(nodemailer, "createTransport", () => ({ sendMail: () => new Promise(() => {}), close: () => { closed = true; } }));
  try {
    const sender = createMailSender({
      host: "smtp.example.com", port: 587, user: "outbox@example.com", pass: "secret", from: "noreply@example.com",
      timeouts: { overall: 5 },
    });
    await assert.rejects(
      () => sender.send({ to: "person@example.com", subject: "Hello", body: "private-token" }),
      error => error.code === "MAIL_SEND_TIMEOUT" && !/secret|private-token|smtp\.example/.test(error.message),
    );
    assert.equal(closed, true, "the still-pending transport is aborted before the item becomes retryable");
  } finally {
    mock.restoreAll();
  }
});
