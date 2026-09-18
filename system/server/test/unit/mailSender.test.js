import { test, mock } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { createMailSender } from "../../src/mailSender.js";

test("createMailSender reports unconfigured when any SMTP field is missing", () => {
  for (const config of [
    {}, { host: "smtp.example.com" },
    { host: "smtp.example.com", port: 587, user: "a" },
  ]) {
    assert.equal(createMailSender(config).isConfigured(), false);
  }
});

test("send() throws instead of silently no-op'ing when unconfigured", async () => {
  const sender = createMailSender({});
  await assert.rejects(() => sender.send({ to: "a@example.com", subject: "s", body: "b" }), /not configured/);
});

test("a configured sender calls nodemailer's sendMail with the expected envelope", async () => {
  const calls = [];
  const createTransport = mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (options) => { calls.push(options); },
  }));
  try {
    const sender = createMailSender({ host: "smtp.example.com", port: 587, user: "outbox@example.com", pass: "secret", secure: false });
    assert.equal(sender.isConfigured(), true);
    await sender.send({ to: "person@example.com", from: "custom@example.com", subject: "Hello", body: "World" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { to: "person@example.com", from: "custom@example.com", subject: "Hello", text: "World" });
  } finally {
    createTransport.mock.restore();
  }
});

test("a missing `from` falls back to the configured SMTP user", async () => {
  const calls = [];
  mock.method(nodemailer, "createTransport", () => ({ sendMail: async (options) => { calls.push(options); } }));
  try {
    const sender = createMailSender({ host: "smtp.example.com", port: 587, user: "outbox@example.com", pass: "secret" });
    await sender.send({ to: "person@example.com", subject: "Hello", body: "World" });
    assert.equal(calls[0].from, "outbox@example.com");
  } finally {
    mock.restoreAll();
  }
});

test("send() rejects a missing recipient instead of calling sendMail", async () => {
  mock.method(nodemailer, "createTransport", () => ({ sendMail: async () => { throw new Error("should not be called"); } }));
  try {
    const sender = createMailSender({ host: "smtp.example.com", port: 587, user: "outbox@example.com", pass: "secret" });
    await assert.rejects(() => sender.send({ subject: "Hello", body: "World" }), /recipient/);
  } finally {
    mock.restoreAll();
  }
});
