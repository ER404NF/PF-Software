// P4 build (docs/productionization/P4_DEVICE_PUSH_BUILD.md): route-level
// coverage for the token issuance/consumption mechanism the build spec calls
// out by name ("new route pair ... with real unit tests — expiry,
// single-use, wrong-device rejection, wrong-filename rejection, replay
// rejection" — filePushLinkStore.test.js already covers the store itself in
// isolation; this file covers the same guarantees through the real HTTP
// routes and real auth/capability checks). Also covers the trigger route's
// own auth boundary and its wiring straight through to a real (mock) device,
// deliberately NOT asserting SUCCESS from that last test — see its comment.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-file-push-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "file-push-routes-test-secret";
process.env.TWO_FACTOR_MASTER_KEY = "file-push-routes-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
process.env.FILE_PUSH_LINK_STORE_PATH = path.join(root, "file-push-links.json");
process.env.DEVICE_CONFIG_PATH = path.resolve("server/fixtures/network-devices.config.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";

const auth = await import("../../src/authStore.js");
auth.createOperatorAccount({
  username: "admin-test", password: "admin-password-123", role: "admin",
  allowedDevices: null, allowedResearchWorkspaces: [],
});
auth.createOperatorAccount({
  username: "other-device-va", password: "other-device-va-password", role: "va",
  allowedDevices: ["mock-2"], allowedResearchWorkspaces: [],
});
auth.createOperatorAccount({
  username: "file-push-manager", password: "file-push-manager-password", role: "manager",
  teamId: "push-team", allowedDevices: ["mock-1"], allowedResearchWorkspaces: [],
});

const { server, devices, auditLog } = await import("../../src/index.js");
const { ensureDeviceDir } = await import("../../src/fileStore.js");

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, await response.text());
  return response.headers.get("set-cookie").split(";")[0];
}

async function request(baseUrl, url, { cookie, method = "GET" } = {}) {
  const response = await fetch(`${baseUrl}${url}`, { method, headers: cookie ? { Cookie: cookie } : {} });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

test("file push: token issuance, consumption, and the trigger route's own auth boundary", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const adminCookie = await login(baseUrl, "admin-test", "admin-password-123");
    const otherDeviceCookie = await login(baseUrl, "other-device-va", "other-device-va-password");
    const managerCookie = await login(baseUrl, "file-push-manager", "file-push-manager-password");

    const dir = ensureDeviceDir("mock-1");
    fs.writeFileSync(path.join(dir, "clip.mp4"), "staged-file-bytes");

    // ---- issuance: auth boundary -------------------------------------------------
    const wrongDevice = await request(baseUrl, "/api/devices/mock-1/files/clip.mp4/push-link",
      { cookie: otherDeviceCookie, method: "POST" });
    assert.equal(wrongDevice.status, 403);

    const unknownFile = await request(baseUrl, "/api/devices/mock-1/files/does-not-exist.mp4/push-link",
      { cookie: adminCookie, method: "POST" });
    assert.equal(unknownFile.status, 404);

    const unknownDevice = await request(baseUrl, "/api/devices/no-such-device/files/clip.mp4/push-link",
      { cookie: adminCookie, method: "POST" });
    assert.equal(unknownDevice.status, 404);

    // ---- issuance: success ---------------------------------------------------------
    const issued = await request(baseUrl, "/api/devices/mock-1/files/clip.mp4/push-link",
      { cookie: adminCookie, method: "POST" });
    assert.equal(issued.status, 200);
    assert.match(issued.body.url, /\/d\/pfl_/);
    assert.ok(new Date(issued.body.expiresAt).getTime() > Date.now());

    // ---- consumption: success, exactly once ----------------------------------------
    const tokenPath = new URL(issued.body.url).pathname;
    const firstDownload = await fetch(`${baseUrl}${tokenPath}`);
    assert.equal(firstDownload.status, 200);
    assert.equal(await firstDownload.text(), "staged-file-bytes");

    const replay = await fetch(`${baseUrl}${tokenPath}`);
    assert.equal(replay.status, 404, "a consumed push-link token must never work twice");

    // Audit storage is secondary to the one-time link store. An outage must
    // not strand a committed token behind a false 500 or consume a token
    // without delivering the file bytes.
    const originalAuditWrite = auditLog.logEvent;
    try {
      auditLog.logEvent = () => { throw new Error("injected file-push audit failure"); };
      const issuedDuringOutage = await request(baseUrl, "/api/devices/mock-1/files/clip.mp4/push-link",
        { cookie: adminCookie, method: "POST" });
      assert.equal(issuedDuringOutage.status, 200, "committed link issuance must survive an audit outage");
      const outageTokenPath = new URL(issuedDuringOutage.body.url).pathname;
      const downloadDuringOutage = await fetch(`${baseUrl}${outageTokenPath}`);
      assert.equal(downloadDuringOutage.status, 200, "token consumption must still deliver the selected file");
      assert.equal(await downloadDuringOutage.text(), "staged-file-bytes");
    } finally {
      auditLog.logEvent = originalAuditWrite;
    }

    // ---- consumption: malformed / unknown tokens never leak which is which --------
    const malformed = await fetch(`${baseUrl}/d/not-a-real-token`);
    assert.equal(malformed.status, 404);
    const unknownToken = await fetch(`${baseUrl}/d/pfl_${"a".repeat(43)}`);
    assert.equal(unknownToken.status, 404);

    // ---- trigger route: same auth boundary as issuance -----------------------------
    const triggerWrongDevice = await request(baseUrl, "/api/devices/mock-1/files/clip.mp4/push",
      { cookie: otherDeviceCookie, method: "POST" });
    assert.equal(triggerWrongDevice.status, 403);

    const triggerUnknownFile = await request(baseUrl, "/api/devices/mock-1/files/does-not-exist.mp4/push",
      { cookie: adminCookie, method: "POST" });
    assert.equal(triggerUnknownFile.status, 404);

    // ---- trigger route: wired end-to-end against the real (mock) device -----------
    // mock-1 is a MockDevice (server/src/mockDevice.js), not a real
    // iPhone+Safari — its "home screen" has Instagram/Camera/Settings icons,
    // never a Safari icon, so filePushSkill.js's execute("open_safari") can
    // never find one and the skill's own recover() (pressHome) is the only
    // thing that ever runs, forever. The one thing this test can honestly
    // prove without real hardware is that the whole chain (route -> token
    // issuance -> pushFileToDevice -> filePushSkill -> the real MockDevice
    // adapter) executes cleanly end-to-end and reports a specific, well-formed
    // outcome — never a crash, a hang, or a silent 200 with no result. See
    // P4_DEVICE_PUSH_BUILD.md's own explicit "do not claim this works until
    // it's run on a real iPhone" instruction.
    const triggered = await request(baseUrl, "/api/devices/mock-1/files/clip.mp4/push",
      { cookie: adminCookie, method: "POST" });
    assert.equal(triggered.status, 200);
    assert.equal(triggered.body.push.outcome, "TIMED_OUT");
    assert.equal(triggered.body.push.state, "springboard");

    // Revoking the manager's device grant while an awaited observation is in
    // flight must stop before the next device input. This catches a stale
    // req.currentOperator capture in the route, not just the orchestrator's
    // own callback behavior.
    const device = devices.get("mock-1");
    const originalGetUiTree = device.getUiTree;
    const originalTap = device.tap;
    let observed;
    let releaseObservation;
    const observationStarted = new Promise(resolve => { observed = resolve; });
    const observationGate = new Promise(resolve => { releaseObservation = resolve; });
    let taps = 0;
    device.getUiTree = async () => {
      observed();
      await observationGate;
      return {
        screen: "home", viewport: { x: 0, y: 0, width: 100, height: 200 },
        elements: [{ type: "icon", label: "Safari", frame: { x: 10, y: 100, width: 20, height: 20 } }],
      };
    };
    device.tap = async () => { taps += 1; };
    try {
      const pendingPush = request(baseUrl, "/api/devices/mock-1/files/clip.mp4/push",
        { cookie: managerCookie, method: "POST" });
      await observationStarted;
      auth.updateOperatorAccount("file-push-manager", { allowedDevices: [] });
      releaseObservation();
      const blocked = await pendingPush;
      assert.equal(blocked.status, 200);
      assert.equal(blocked.body.push.outcome, "BLOCKED");
      assert.equal(taps, 0);
    } finally {
      device.getUiTree = originalGetUiTree;
      device.tap = originalTap;
      auth.updateOperatorAccount("file-push-manager", { allowedDevices: ["mock-1"] });
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
