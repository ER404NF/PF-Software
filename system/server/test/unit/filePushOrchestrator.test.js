import { test } from "node:test";
import assert from "node:assert/strict";
import { pushFileToDevice } from "../../src/filePushOrchestrator.js";
import { SafariFixture } from "./filePushSkill.test.js";

const TEST_URL = "https://hub.example/d/pfl_test-token";
const fastSleep = () => Promise.resolve();

test("a full successful run: springboard -> Safari -> address bar -> navigate -> downloading -> downloaded", async () => {
  const device = new SafariFixture();
  const result = await pushFileToDevice({ device, url: TEST_URL, sleep: fastSleep });
  assert.equal(result.outcome, "SUCCESS");
  assert.equal(result.state, "download_complete");
  assert.equal(device.typed.at(-1), `${TEST_URL}\n`);
});

test("an instant download (no separate downloading phase) still succeeds", async () => {
  const device = new SafariFixture({ instantDownload: true });
  const result = await pushFileToDevice({ device, url: TEST_URL, sleep: fastSleep });
  assert.equal(result.outcome, "SUCCESS");
});

test("a Safari download confirmation is explicitly accepted before polling completion", async () => {
  const device = new SafariFixture({ requireDownloadConfirmation: true });
  const result = await pushFileToDevice({ device, url: TEST_URL, sleep: fastSleep });
  assert.equal(result.outcome, "SUCCESS");
  assert.equal(result.state, "download_complete");
  assert.ok(device.taps.length >= 2, "opening Safari and confirming the download both require a tap");
});

test("the device already showing an error before anything runs is a clean FAILED, not a crash", async () => {
  const device = new SafariFixture();
  device.forceError();
  const result = await pushFileToDevice({ device, url: TEST_URL, sleep: fastSleep });
  assert.equal(result.outcome, "FAILED");
  assert.equal(result.state, "error");
});

test("an error page appearing right after navigating escalates to NEEDS_HUMAN, not a silent failure", async () => {
  const device = new SafariFixture();
  const originalTypeText = device.typeText.bind(device);
  device.typeText = async (text) => {
    await originalTypeText(text);
    if (device.phase === "downloading" || device.phase === "downloaded") device.forceError();
  };
  const result = await pushFileToDevice({ device, url: TEST_URL, sleep: fastSleep });
  assert.equal(result.outcome, "NEEDS_HUMAN");
});

test("a download that never completes within the step budget is a clean TIMED_OUT, not an infinite loop", async () => {
  const device = new SafariFixture();
  // Sabotage: typing never actually reaches "downloading" (stays stuck at
  // "address_bar" forever), simulating a page that never responds.
  device.typeText = async () => {};
  const result = await pushFileToDevice({ device, url: TEST_URL, maxSteps: 3, sleep: fastSleep });
  assert.equal(result.outcome, "TIMED_OUT");
});

test("authorization revoked before the run even starts is a clean BLOCKED, never a device action", async () => {
  const device = new SafariFixture();
  const result = await pushFileToDevice({ device, url: TEST_URL, sleep: fastSleep, canExecute: () => false });
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(device.taps.length, 0, "no tap should ever reach the device once authorization is already revoked");
});

test("authorization revoked partway through stops the run at the next check, not mid-action", async () => {
  const device = new SafariFixture();
  let checks = 0;
  const result = await pushFileToDevice({
    device, url: TEST_URL, sleep: fastSleep,
    canExecute: () => { checks += 1; return checks <= 1; }, // allowed once, then revoked
  });
  assert.equal(result.outcome, "BLOCKED");
});

test("an asynchronous authorization check is awaited before device input", async () => {
  const device = new SafariFixture();
  let checks = 0;
  const result = await pushFileToDevice({
    device, url: TEST_URL, sleep: fastSleep,
    canExecute: async () => { checks += 1; return checks === 1; },
  });
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(device.taps.length, 0, "revocation after observation must stop the first tap");
});

test("a stuck-in-download-forever state that never errors and never completes still times out (never hangs)", async () => {
  const device = new SafariFixture({ autoCompleteDownloadAfterTicks: null }); // never auto-completes
  const originalTypeText = device.typeText.bind(device);
  device.typeText = async (text) => { await originalTypeText(text); device.phase = "downloading"; };
  const result = await pushFileToDevice({ device, url: TEST_URL, maxSteps: 4, sleep: fastSleep });
  assert.equal(result.outcome, "TIMED_OUT");
});

test("a failed file-push action does not return private device exception details", async () => {
  const device = new SafariFixture();
  const skill = {
    async detectState() { return "springboard"; },
    async availableActions() { return ["open_safari"]; },
    async execute() { throw new Error("PRIVATE_WDA_RESPONSE_BODY"); },
    async recover() { return { recovered: false }; },
  };
  const result = await pushFileToDevice({ device, url: TEST_URL, skill, sleep: fastSleep });
  assert.equal(result.outcome, "FAILED");
  assert.equal(result.reason, "device file-push action failed (Error)");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_WDA_RESPONSE_BODY/);
});
