import { test } from "node:test";
import assert from "node:assert/strict";
import { routingHttpFailure } from "../../src/routingHttpError.js";

test("routing HTTP failures do not expose command stderr or host paths", () => {
  const failure = routingHttpFailure(
    new Error("pfctl failed at /private/etc/pf.conf with PRIVATE_MARKER"),
    { code: "F202" },
  );

  assert.deepEqual(failure, {
    status: 502,
    body: { error: "PF rules could not be loaded", code: "F202" },
  });
  assert.doesNotMatch(JSON.stringify(failure), /private|pf\.conf|PRIVATE_MARKER/);
});

test("explicit internal authorization and conflict errors remain actionable", () => {
  const error = Object.assign(new Error("not authorized for this device"), {
    status: 403,
    expose: true,
    code: "AUTHORIZATION_REQUIRED",
  });

  assert.deepEqual(routingHttpFailure(error, { code: "T202" }), {
    status: 403,
    body: { error: "not authorized for this device", code: "AUTHORIZATION_REQUIRED" },
  });
});

test("status and code fields alone cannot opt an arbitrary failure into disclosure", () => {
  const error = Object.assign(new Error("upstream returned PRIVATE_RESPONSE_BODY"), {
    status: 409,
    code: "UPSTREAM_CONFLICT",
  });

  const failure = routingHttpFailure(error, { code: "T202" });
  assert.equal(failure.status, 502);
  assert.deepEqual(failure.body, { error: "Proxy tunnel failed to start", code: "T202" });
});
