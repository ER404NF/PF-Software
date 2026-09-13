import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorState } from "../../src/monitorContract.js";

test("unconfigured monitor contract is explicitly read-only, unavailable, and lease-independent", () => {
  assert.deepEqual(monitorState(), {
    available: false,
    state: "unavailable",
    readOnly: true,
    claimsInputLease: false,
    refreshIntervalMs: null,
    activeViewers: 0,
    adapter: "unconfigured",
    environmentLabel: "Detected iPhone without WDA",
    physicallyValidated: false,
    validationState: "not-applicable",
    reason: "Configure this detected iPhone's WDA tunnel before live monitoring.",
  });
  assert.notEqual(monitorState(), monitorState());
});

test("monitor contract separates adapter availability from physical acceptance", () => {
  const mock = monitorState({ adapter: "mock", physicallyValidated: true, activeViewers: 2 });
  assert.equal(mock.available, true);
  assert.equal(mock.physicallyValidated, false);
  assert.equal(mock.validationState, "not-applicable");
  assert.equal(mock.activeViewers, 2);

  const pendingWda = monitorState({ adapter: "wda" });
  assert.equal(pendingWda.available, true);
  assert.equal(pendingWda.physicallyValidated, false);
  assert.equal(pendingWda.validationState, "pending");
  assert.match(pendingWda.reason, /acceptance is still pending/);

  const acceptedWda = monitorState({ adapter: "wda", physicallyValidated: true });
  assert.equal(acceptedWda.physicallyValidated, true);
  assert.equal(acceptedWda.validationState, "validated");
});
