import { test } from "node:test";
import assert from "node:assert/strict";
import { networkAccessDecision, networkVerificationMaxAge } from "../../src/networkPolicy.js";

const now = new Date("2026-09-13T12:00:00.000Z");
const failClosed = { egress: "commercial-proxy", enabled: true, failPolicy: "fail-closed" };

test("fail-closed network policy blocks missing, failed, mismatched, stale, and disabled verification", () => {
  assert.equal(networkAccessDecision({ network: failClosed, status: {}, now }).state, "network_not_verified");
  assert.equal(networkAccessDecision({ network: failClosed,
    status: { networkCheckedAt: now.toISOString(), networkVerified: false }, now }).state, "network_verification_failed");
  assert.equal(networkAccessDecision({ network: failClosed,
    status: { networkCheckedAt: now.toISOString(), networkVerified: false, networkMismatch: true }, now }).state, "network_mismatch");
  assert.equal(networkAccessDecision({ network: failClosed,
    status: { networkCheckedAt: "2026-09-13T11:44:59.999Z", networkVerified: true }, now }).state, "network_verification_stale");
  assert.equal(networkAccessDecision({ network: { ...failClosed, enabled: false },
    status: { networkCheckedAt: now.toISOString(), networkVerified: true }, now }).state, "proxy_disabled");
  for (const decision of [
    networkAccessDecision({ network: failClosed, status: {}, now }),
    networkAccessDecision({ network: failClosed, status: { networkCheckedAt: now.toISOString(), networkVerified: false }, now }),
    networkAccessDecision({ network: { ...failClosed, enabled: false }, status: {}, now }),
  ]) assert.equal(decision.allowed, false);
});

test("fresh passing verification restores fail-closed eligibility and fail-open remains visibly degraded", () => {
  const passing = networkAccessDecision({ network: failClosed,
    status: { networkCheckedAt: now.toISOString(), networkVerified: true }, now });
  assert.deepEqual(passing, { allowed: true, state: "network_verified", reason: null });

  const degraded = networkAccessDecision({ network: { ...failClosed, failPolicy: "fail-open" }, status: {}, now });
  assert.equal(degraded.allowed, true);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.state, "network_not_verified");
});

test("network verification freshness configuration is bounded", () => {
  assert.equal(networkVerificationMaxAge(undefined), 15 * 60 * 1000);
  assert.equal(networkVerificationMaxAge("60000"), 60000);
  for (const value of ["999", "86400001", "not-a-number", "1.5"]) {
    assert.throws(() => networkVerificationMaxAge(value), /NETWORK_VERIFICATION_MAX_AGE_MS/);
  }
});
