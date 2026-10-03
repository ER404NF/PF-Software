import test from "node:test";
import assert from "node:assert/strict";
import { createCloudApi } from "../../src/cloudApi/createCloudApi.js";

function cloudApi(mailSender) {
  return createCloudApi({
    pool: {},
    withTransaction: async () => null,
    organizationRepository: {},
    userRepository: {},
    membershipRepository: {},
    roleRepository: {},
    organizationIdentityService: {
      createOrganizationWithOwner: async ({ ownerDisplayName }) => ({
        organization: { id: "org-1", slug: "private-org", display_name: "Private Org" },
        user: { id: "user-1", display_name: ownerDisplayName, status: "active" },
        membership: { id: "membership-1" },
      }),
    },
    identitySessionService: {},
    invitationService: {},
    identityMfaService: {},
    emailActionService: { issueEmailVerificationToken: async () => ({ token: "private-token" }) },
    verifyPassword: () => false,
    hashPassword: value => value,
    validatePassword() {},
    mailSender,
    companyEmail: "sender@example.com",
  });
}

async function postSignup(app) {
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "private-org", displayName: "Private Org", ownerEmail: "private.owner@example.com",
        ownerPassword: "private-password", ownerDisplayName: "Private Owner",
      }),
    });
    assert.equal(response.status, 201);
    await response.json();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("cloud notification failures do not log recipients, subjects, tokens, or transport messages", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.map(String).join(" "));
  try {
    await postSignup(cloudApi({
      isConfigured: () => true,
      send: async () => { throw new Error("smtp://user:password@smtp.example.com private-token"); },
    }));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, ["Cloud API notification send failed: Error"]);
});

test("an unconfigured cloud mailer logs no recipient or subject metadata", async () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (...values) => messages.push(values.map(String).join(" "));
  try {
    await postSignup(cloudApi({ isConfigured: () => false }));
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(messages, ["Cloud API: SMTP is not configured — notification not sent"]);
  assert.equal(messages.some(message => /private|example\.com|Verify/.test(message)), false);
});
