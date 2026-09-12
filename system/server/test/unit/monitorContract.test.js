import { test } from "node:test";
import assert from "node:assert/strict";
import { MONITOR_UNAVAILABLE, monitorState } from "../../src/monitorContract.js";

test("pre-hardware monitor contract is explicitly read-only, unavailable, and lease-independent", () => {
  assert.deepEqual(monitorState(), {
    available: false,
    state: "unavailable",
    readOnly: true,
    claimsInputLease: false,
    refreshIntervalMs: null,
    activeViewers: 0,
    privacyPolicy: "required-before-production",
    reason: "Physical iPhone and WebDriverAgent passive-capture validation is required.",
  });
  assert.equal(Object.isFrozen(MONITOR_UNAVAILABLE), true);
  assert.notEqual(monitorState(), monitorState());
});
