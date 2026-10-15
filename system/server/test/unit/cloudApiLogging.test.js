import test from "node:test";
import assert from "node:assert/strict";
import { createCloudApi } from "../../src/cloudApi/createCloudApi.js";

function cloudApi(notificationRepository) {
  const repository = {
    ...notificationRepository,
    queueInTransaction: notificationRepository.queueInTransaction
      || ((item, client, options) => notificationRepository.queue(item, client, options)),
  };
  return createCloudApi({
    pool: {},
    withTransaction: async () => null,
    organizationRepository: {},
    userRepository: {},
    membershipRepository: {},
    roleRepository: {},
    organizationIdentityService: {
      createOrganizationWithOwner: async ({ ownerDisplayName, onCreated }) => {
        const client = { transaction: true };
        const organization = { id: "org-1", slug: "private-org", display_name: "Private Org" };
        const user = { id: "user-1", display_name: ownerDisplayName, status: "active" };
        const membership = { id: "membership-1" };
        const completion = await onCreated({ organization, user, membership, client });
        return { organization, user, membership, completion };
      },
    },
    identitySessionService: {},
    invitationService: {},
    identityMfaService: {},
    emailActionService: {
      issueEmailVerificationToken: async (_userId, onIssued, client) => {
        const token = "private-token";
        const record = { id: "token-record-1" };
        const notification = await onIssued({ token, record, client });
        return { token, record, notification };
      },
    },
    verifyPassword: () => false,
    hashPassword: value => value,
    validatePassword() {},
    notificationRepository: repository,
  });
}

async function postSignup(app, expectedStatus = 201) {
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
    assert.equal(response.status, expectedStatus);
    await response.json();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("cloud notification persistence failure rolls back the token transaction and logs no private data", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.map(String).join(" "));
  try {
    await postSignup(cloudApi({ queue: async () => { throw new Error("postgres://user:password@private private-token"); } }), 500);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, ["Cloud API request failed: Error"]);
});

test("a durable unconfigured notification is queued without logging recipient or subject metadata", async () => {
  const messages = [];
  const queued = [];
  const originalLog = console.log;
  console.log = (...values) => messages.push(values.map(String).join(" "));
  try {
    await postSignup(cloudApi({ queue: async item => { queued.push(item); return { id: "n-1", deliveryState: "awaiting_sender_configuration" }; } }));
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(messages, []);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "email_verification");
  assert.equal(queued[0].sensitive, true);
  assert.equal(queued[0].idempotencyKey, "email_verification:token-record-1");
  assert.equal(messages.some(message => /private|example\.com|Verify/.test(message)), false);
});
