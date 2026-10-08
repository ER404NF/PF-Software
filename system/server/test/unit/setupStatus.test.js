import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSetupStatus, setupCodes, SETUP_CODES } from "../../src/setupStatus.js";
import { assertPlainOperatorText } from "../helpers/plainText.js";

// One plain status for "automatic phone setup": running, checking its earlier phone connections, paused with a reason, or
// turned off. Every message is read by operators on the Fleet page, so none may carry a path, a process number or a program name.

test("every code builds a status with a state, a stable code and a plain message", () => {
  assert.deepEqual(setupCodes().sort(), [
    "setup_checking", "setup_off", "setup_paused_cannot_check", "setup_paused_earlier_session", "setup_paused_record_damaged", "setup_running",
  ]);
  for (const code of setupCodes()) {
    const status = buildSetupStatus(code);
    assert.equal(status.code, code);
    assert.ok(["running", "checking", "paused", "off"].includes(status.state), code);
    assert.equal(typeof status.message, "string");
    assert.ok(status.message.length > 20, code);
    assertPlainOperatorText(status.message, code);
  }
});

test("messages carry no file path, process number, program name or file name", () => {
  const banned = /[\\/]|\bpid\b|process\s*\d|\d{3,}|iproxy|xcodebuild|idevice|lsof|sysctl|usbmux|\.json|\.js\b|\.log\b|error code|ENOENT|EACCES/i;
  for (const code of setupCodes()) assert.doesNotMatch(buildSetupStatus(code).message, banned, code);
});

test("only the two reasons a check can clear are marked as changing by themselves", () => {
  const byItself = setupCodes().filter(code => buildSetupStatus(code).changesByItself).sort();
  assert.deepEqual(byItself, ["setup_paused_cannot_check", "setup_paused_earlier_session"]);
  assert.equal(buildSetupStatus("setup_paused_record_damaged").changesByItself, false);
});

test("a damaged-record message says what to do, and does not promise a menu action while the server runs", () => {
  const message = buildSetupStatus("setup_paused_record_damaged").message;
  assert.match(message, /Quit Bodun and open it again/);
  assert.match(message, /move the damaged record aside/);
});

test("the paused messages that re-check by themselves say so", () => {
  assert.match(buildSetupStatus("setup_paused_cannot_check").message, /30 seconds/);
  assert.match(buildSetupStatus("setup_paused_earlier_session").message, /30 seconds/);
});

test("an unknown code is refused and the table is frozen", () => {
  assert.throws(() => buildSetupStatus("nope"), /unknown automatic setup status/);
  assert.ok(Object.isFrozen(SETUP_CODES));
});
