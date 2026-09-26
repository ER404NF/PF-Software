import test from "node:test";
import assert from "node:assert/strict";
import { orgKey, assertBoundedPayload, RedisKeyError, MAX_VALUE_BYTES } from "../../src/redis/keys.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

test("orgKey() builds the ADR-0003 tenant-scoped key format", () => {
  assert.equal(orgKey(ORG_ID, "presence", "session-1"), `pf:org:${ORG_ID}:presence:session-1`);
});

test("orgKey() rejects a non-UUID organizationId", () => {
  assert.throws(() => orgKey("not-a-uuid", "presence"), RedisKeyError);
  assert.throws(() => orgKey("not-a-uuid", "presence"), /organizationId must be a UUID/);
});

test("orgKey() requires at least one segment", () => {
  assert.throws(() => orgKey(ORG_ID), /at least one key segment is required/);
});

test("orgKey() rejects a segment with characters that could break the key format", () => {
  assert.throws(() => orgKey(ORG_ID, "pre:sence"), /invalid key segment/);
  assert.throws(() => orgKey(ORG_ID, ""), /invalid key segment/);
  assert.throws(() => orgKey(ORG_ID, "UPPER"), /invalid key segment/);
});

test("assertBoundedPayload() accepts a value at or under the limit", () => {
  assert.doesNotThrow(() => assertBoundedPayload("x".repeat(MAX_VALUE_BYTES)));
  assert.doesNotThrow(() => assertBoundedPayload({ a: 1 }));
});

test("assertBoundedPayload() rejects a value over the limit", () => {
  assert.throws(() => assertBoundedPayload("x".repeat(MAX_VALUE_BYTES + 1)), /over the .*-byte Redis payload limit/);
});
