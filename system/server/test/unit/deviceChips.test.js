import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
const { chipFor } = context.window.deviceCardModel;
const css = fs.readFileSync(new URL("../../../client/style.css", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");

// [kind, state, ctx, expected text, expected tone]
const TABLE = [
  ["Device", "CONNECTED", {}, "Connected", "healthy"],
  ["Device", "ATTACHED", {}, "Connected", "healthy"],
  ["Device", "DISCONNECTED", {}, "Unplugged", "error"],
  ["Device", "OFFLINE", {}, "Unplugged", "error"],
  ["Device", "UNKNOWN", {}, "Unchecked", "warning"],
  ["Control", "READY", {}, "Ready", "healthy"],
  ["Control", "DEGRADED", {}, "Checking", "warning"],
  ["Control", "DEGRADED", { endpoint: "UNKNOWN" }, "Checking", "warning"],
  ["Control", "DEGRADED", { endpoint: "RECOVERING" }, "Checking", "warning"],
  ["Control", "DEGRADED", { endpoint: "SUSPECT" }, "Slow", "warning"],
  ["Control", "DEGRADED", { endpoint: "DEGRADED" }, "Slow", "warning"],
  ["Control", "UNAVAILABLE", {}, "Unavailable", "error"],
  ["Control", "UNAVAILABLE", { recovery: "OPERATOR_STOPPED" }, "Off", "neutral"],
  ["WDA", "STOPPED", {}, "Stopped", "neutral"],
  ["WDA", "STOPPED", { endpoint: "FAILED" }, "Stopped", "neutral"],
  ["WDA", "STARTING", {}, "Starting", "warning"],
  ["WDA", "RESTARTING", {}, "Restarting", "warning"],
  ["WDA", "FAILED", {}, "Failed", "error"],
  ["WDA", "RUNNING", { endpoint: "HEALTHY" }, "Running", "healthy"],
  ["WDA", "RUNNING", { endpoint: "SUSPECT" }, "Checking", "warning"],
  ["WDA", "RUNNING", { endpoint: "DEGRADED" }, "Checking", "warning"],
  ["WDA", "RUNNING", { endpoint: "UNKNOWN" }, "Checking", "warning"],
  ["WDA", "RUNNING", { endpoint: "FAILED" }, "Not responding", "error"],
  ["WDA", "UNKNOWN", {}, "Unchecked", "warning"],
  ["iproxy", "RUNNING", {}, "Running", "healthy"],
  ["iproxy", "STOPPED", {}, "Stopped", "neutral"],
  ["iproxy", "STARTING", {}, "Starting", "warning"],
  ["iproxy", "RESTARTING", {}, "Restarting", "warning"],
  ["iproxy", "FAILED", {}, "Failed", "error"],
  ["iproxy", "FAILED", { recovery: "BLOCKED_PORT" }, "Blocked", "error"],
  ["iproxy", "FAILED", { recovery: "STOP_FAILED" }, "Won't stop", "error"],
  ["iproxy", "UNKNOWN", {}, "Unchecked", "warning"],
  ["Network", "PROTECTED", {}, "Protected", "healthy"],
  ["Network", "UNCONFIGURED", {}, "Not set", "neutral"],
  ["Network", "VERIFYING", {}, "Checking", "warning"],
  ["Network", "UNVERIFIED", {}, "Unchecked", "warning"],
  ["Network", "FAILED", {}, "Failed", "error"],
  ["Proxy", "HEALTHY", {}, "Healthy", "healthy"],
  ["Proxy", "FAILED", {}, "Failed", "error"],
  ["Proxy", "NOT CHECKED", {}, "Unchecked", "warning"],
];

for (const [kind, state, ctx, text, tone] of TABLE) {
  test(`${kind} ${state}${Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : ""} shows "${text}" in ${tone}`, () => {
    const chip = chipFor(kind, state, ctx);
    assert.equal(chip.text, text);
    assert.equal(chip.tone, tone);
    assert.ok(chip.title, "every chip has a hover title");
    assert.ok(chip.text.length <= 14, "labels are short enough not to wrap");
  });
}

test("the problem states from the review are no longer green or two-in-one", () => {
  assert.equal(chipFor("iproxy", "STOPPED").tone, "neutral");
  assert.equal(chipFor("Network", "UNCONFIGURED").tone, "neutral");
  assert.doesNotMatch(chipFor("WDA", "STOPPED", { endpoint: "FAILED" }).text, /\//);
});

test("chip text never wraps mid-word and the chip row is styled for the four tones", () => {
  assert.match(css, /\.component-health-row strong\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.component-health-row strong\s*\{[^}]*text-overflow:\s*ellipsis/);
  for (const tone of ["healthy", "warning", "error", "neutral"]) {
    assert.match(css, new RegExp(`\\.component-health-row strong\\[data-state="${tone}"\\]`));
  }
});

test("the card renders its chips through the model", () => {
  assert.match(app, /deviceCardModel\.chipFor\(label, stateValue, context\)/);
  assert.match(app, /value\.dataset\.state = chip\.tone;/);
});

const { deviceStateSummary } = context.window.deviceCardModel;
const phone = (extra = {}) => ({ status: "idle", accessState: "ready", componentHealth: {}, controllerMode: "HUMAN", consecutiveFailures: 0, ...extra });

test("one state per phone: the header, access box and footer all read the same summary", () => {
  assert.equal(deviceStateSummary(phone()).headline, "Ready");
  assert.equal(deviceStateSummary(phone({ status: "in-use" })).headline, "In use");
  // connected, but the control service is not answering: not "offline" next to a green "Connected" chip
  const quiet = deviceStateSummary(phone({ status: "offline", componentHealth: { deviceAttachment: "CONNECTED" } }));
  assert.equal(quiet.headline, "Not responding");
  assert.equal(quiet.attention, true);
  assert.equal(deviceStateSummary(phone({ componentHealth: { recovery: "BLOCKED_PORT" } })).headline, "Needs attention");
  assert.equal(deviceStateSummary(phone({ accessState: "disconnected" })).headline, "Unplugged");
  assert.equal(deviceStateSummary(phone({ accessState: "wda_stopped" })).tone, "neutral");
  assert.equal(deviceStateSummary(phone({ accessState: "wda_provisioning" })).tone, "warning");
  assert.equal(deviceStateSummary(phone({ consecutiveFailures: 2 })).headline, "Unstable");
});

test("the card keeps setup errors out of the access box and gives them their own block", () => {
  assert.match(app, /deviceCardModel\.deviceStateSummary\(d\)/);
  assert.match(app, /accessReason\.textContent = !d\.assignedToViewer \? presentation\.message/);
  assert.doesNotMatch(app, /accessReason\.textContent = d\.canOpen \? "Available to open\." : presentation\.message/);
  assert.match(app, /attention\.className = "device-attention"/);
  assert.match(app, /open\.textContent = d\.canOpen \? presentation\.label : "Can't open yet"/);
  assert.match(css, /\.device-attention \{/);
});

test("an offline phone no longer says 'phone in use' in the controller row", () => {
  assert.match(app, /device\.status === "in-use" \? "phone in use" : "phone not ready"/);
});

test("chip colours have a darker set for the light theme so amber and green stay readable", () => {
  for (const tone of ["healthy", "warning", "error", "neutral"]) {
    assert.match(css, new RegExp(String.raw`:root:not\(\[data-theme="dark"\]\) \.component-health-row strong\[data-state="${tone}"\] \{ color: #`));
  }
});
