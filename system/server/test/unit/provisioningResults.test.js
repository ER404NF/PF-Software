import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LifecycleError, lifecycleErrorBody, lifecycleSuccess, registerResult, resultCodes, resultMessage, resultStatus,
} from "../../src/provisioningResults.js";
import { assertPlainOperatorText, plainTextProblems } from "../helpers/plainText.js";

const SAMPLE = { program: "proxy-tool", pid: 4121, port: 8101 };

test("every result has an HTTP status and a plain message", () => {
  for (const code of resultCodes()) {
    assert.ok(Number.isInteger(resultStatus(code)), code);
    assertPlainOperatorText(resultMessage(code, SAMPLE), code);
  }
});

test("the distinct outcomes carry the right statuses", () => {
  assert.equal(resultStatus("started"), 200);
  assert.equal(resultStatus("device_unknown"), 404);
  assert.equal(resultStatus("device_not_attached"), 409);
  assert.equal(resultStatus("port_held_by_other_program"), 409);
  assert.equal(resultStatus("port_held_by_unidentified_program"), 409);
  assert.equal(resultStatus("old_process_would_not_stop"), 409);
  assert.equal(resultStatus("shutting_down"), 503);
});

test("a port held by another program names the program, the process number and the port", () => {
  const message = resultMessage("port_held_by_other_program", SAMPLE);
  assert.match(message, /proxy-tool/);
  assert.match(message, /process 4121/);
  assert.match(message, /port 8101/);
  assert.match(message, /will not stop other programs/);
});

test("phone_in_use names the phone and the person using it", () => {
  assert.equal(
    resultMessage("phone_in_use", { phoneLabel: "Studio iPhone", operatorLabel: "Valerie Assistant" }),
    "Studio iPhone is in use by Valerie Assistant. Ask them to release it before stopping or restarting its control service.",
  );
});

test("an unidentified holder is described honestly, without inventing a name", () => {
  const message = resultMessage("port_held_by_unidentified_program", SAMPLE);
  assert.match(message, /could not tell which one/);
  assert.doesNotMatch(message, /proxy-tool|4121/);
});

test("a LifecycleError carries code, status and message, and maps to a route body", () => {
  const error = new LifecycleError("old_process_would_not_stop");
  assert.equal(error.code, "old_process_would_not_stop");
  assert.equal(error.status, 409);
  assert.deepEqual(lifecycleErrorBody(error), { ok: false, error: error.message, code: "old_process_would_not_stop" });
  assert.throws(() => new LifecycleError("nope"), /unknown provisioning result/);
});

test("success is a value, never an error", () => {
  assert.deepEqual(lifecycleSuccess(), { ok: true, code: "started", message: "Phone control is starting." });
});

test("a code cannot be silently redefined", () => {
  assert.throws(() => registerResult("started", { status: 200, message: () => "x" }), /already defined/);
});

test("the plain-text helper rejects developer wording", () => {
  assert.deepEqual(plainTextProblems("Bodun could not stop its old connection process."), []);
  assert.ok(plainTextProblems("See system/server/src/deviceProvisioner.js").length > 0);
  assert.ok(plainTextProblems("_onProcessExit failed").length > 0);
  assert.ok(plainTextProblems("PF-Software could not start").length > 0);
  assert.ok(plainTextProblems("I205").length > 0);
  assert.ok(plainTextProblems("Fixed in ADR-007").length > 0);
  assert.ok(plainTextProblems("").length > 0);
  assert.deepEqual(plainTextProblems("Open System Settings → General → Sharing → Internet Sharing."), []);
});
