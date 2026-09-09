// Integration coverage for the AI command console (docs/COMMAND_QUEUE_SPEC.md)
// against the real HTTP endpoint, real auth/RBAC, and the real deviceLease
// singleton — the taskQueue engine's own logic is covered exhaustively in
// server/test/unit/taskQueue.test.js against a mock deviceLease; this file
// is about the wiring: command parsing -> execution -> HTTP -> real state.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_PASSWORD = "test-password";

const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-queuetest-"));
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(tmpStorageRoot, "model-selection.json");

const { server, wss, devices, deviceLease, taskQueue } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");
const { researchAccounts, researchAccountDefinitions } = await import("../../src/researchAccess.js");
const { providers } = await import("../../src/providerRegistry.js");
const { modelSelection } = await import("../../src/index.js");

let httpUrl;

async function loginCookie(username, password) {
  const res = await fetch(`${httpUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  await res.json(); // see client/app.js's login handler for why this matters
  return setCookie.split(";")[0];
}

async function command(cookie, text) {
  const res = await fetch(`${httpUrl}/api/queue/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, body: await res.json() };
}

let cookie;
let restrictedCookie;

before(async () => {
  operators.set("queue-test-va", {
    username: "queue-test-va",
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: null,
    allowedResearchWorkspaces: ["queue-test"],
    role: "admin",
  });
  operators.set("queue-test-restricted", {
    username: "queue-test-restricted",
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: ["mock-1"],
    allowedResearchWorkspaces: ["queue-test"],
    role: "admin",
  });
  for (const account of [
    { id: "queue-instagram", workspaceId: "queue-test", platform: "instagram" },
    { id: "queue-reddit", workspaceId: "queue-test", platform: "reddit" },
  ]) {
    researchAccounts.set(account.id, account.workspaceId);
    researchAccountDefinitions.set(account.id, Object.freeze(account));
  }
  providers.set("queue-model", { name: "queue-model", async observeAndPlan() { throw new Error("not invoked in command tests"); } });

  await new Promise((resolve) => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  cookie = await loginCookie("queue-test-va", TEST_PASSWORD);
  restrictedCookie = await loginCookie("queue-test-restricted", TEST_PASSWORD);
});

after(async () => {
  operators.delete("queue-test-va");
  operators.delete("queue-test-restricted");
  for (const id of ["queue-instagram", "queue-reddit", "queue-instagram-two"]) {
    researchAccounts.delete(id);
    researchAccountDefinitions.delete(id);
  }
  providers.delete("queue-model");
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  deviceLease.reset();
  for (const task of taskQueue.listTasks()) taskQueue.cancelTask(task.id);
  taskQueue.resumeQueue();
});

test("a bare-text command with no leading slash returns a proposal, not a queued task", async () => {
  const { status, body } = await command(cookie, "Research AI coding posts for a while");
  assert.equal(status, 200);
  assert.deepEqual(body.proposed, { goal: "Research AI coding posts for a while" });
  assert.equal(taskQueue.listTasks().length, 0);
});

test("/time queues a real task, visible via GET /api/queue", async () => {
  const { status, body } = await command(cookie, "/time 00:00-23:59 Research AI coding reels on Instagram");
  assert.equal(status, 200);
  assert.equal(body.task.goal, "Research AI coding reels on Instagram");

  const listRes = await fetch(`${httpUrl}/api/queue`, { headers: { Cookie: cookie } });
  const { tasks } = await listRes.json();
  assert.ok(tasks.some((t) => t.id === body.task.id));
});

test("a device-restricted admin's queued task cannot dispatch onto an unauthorized phone", async () => {
  const allowed = devices.get("mock-1");
  const unauthorized = devices.get("mock-2");
  allowed.status = "in-use";
  unauthorized.status = "idle";
  try {
    const { status, body } = await command(restrictedCookie, "/cresearch instagram 30 restricted dispatch check");
    assert.equal(status, 200);
    assert.deepEqual(body.task.deviceSelector.allowedDeviceIds, ["mock-1"]);
    assert.equal(body.task.state, "QUEUED", "must not spill onto mock-2 while mock-1 is unavailable");
    assert.equal(body.task.deviceSelector.deviceId, undefined);

    allowed.status = "idle";
    taskQueue.tick(new Date());
    const dispatched = taskQueue.getTask(body.task.id);
    assert.equal(dispatched.state, "RUNNING");
    assert.equal(dispatched.deviceSelector.deviceId, "mock-1");
  } finally {
    allowed.status = "idle";
    unauthorized.status = "idle";
  }
});

test("/cresearch queues a task with an accountSelector", async () => {
  const { body } = await command(cookie, "/cresearch instagram 30 Find strong AI coding reels");
  assert.equal(body.task.goal, "Find strong AI coding reels");
  assert.deepEqual(body.task.accountSelector, { platform: "instagram", accountId: "queue-instagram" });
});

test("/cresearch fails closed on ambiguous accounts and accepts an explicit account", async () => {
  const second = { id: "queue-instagram-two", workspaceId: "queue-test", platform: "instagram" };
  researchAccounts.set(second.id, second.workspaceId);
  researchAccountDefinitions.set(second.id, Object.freeze(second));
  try {
    const ambiguous = await command(cookie, "/cresearch instagram 30 Find strong AI coding reels");
    assert.equal(ambiguous.status, 400);
    assert.match(ambiguous.body.error, /multiple authorized instagram research accounts/);

    const explicit = await command(cookie, "/cresearch instagram queue-instagram-two 30 Find strong AI coding reels");
    assert.equal(explicit.status, 200);
    assert.deepEqual(explicit.body.task.accountSelector,
      { platform: "instagram", accountId: "queue-instagram-two" });
  } finally {
    researchAccounts.delete(second.id);
    researchAccountDefinitions.delete(second.id);
  }
});

test("/queue add re-parses its argument as a /time or /cresearch command", async () => {
  const timeAdd = await command(cookie, "/queue add /time 00:00-23:59 Do the thing");
  assert.equal(timeAdd.body.task.goal, "Do the thing");

  const cresearchAdd = await command(cookie, "/queue add /cresearch reddit 15 Do the other thing");
  assert.equal(cresearchAdd.body.task.goal, "Do the other thing");
  assert.deepEqual(cresearchAdd.body.task.accountSelector, { platform: "reddit", accountId: "queue-reddit" });
});

test("/queue add rejects a command that isn't /time or /cresearch", async () => {
  const { status, body } = await command(cookie, "/queue add /mode ai mock-1");
  assert.equal(status, 400);
  assert.match(body.error, /requires a \/time or \/cresearch/);
});

test("/model lists providers and enforces provider-scope authorization", async () => {
  const listed = await command(cookie, "/model list");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.configuredProviders.includes("queue-model"), true);

  assert.equal((await command(cookie, "/model set queue-model")).status, 200);
  assert.equal(modelSelection.resolve(), "queue-model");
  assert.equal((await command(restrictedCookie, "/model set queue-model workspace queue-test")).status, 200);
  assert.equal((await command(restrictedCookie, "/model set queue-model workspace other-client")).status, 400);
  assert.equal((await command(restrictedCookie, "/model set queue-model device mock-2")).status, 400);
  assert.equal((await command(cookie, "/model set missing")).status, 400);
});

test("/queue list, priority, move, and cancel operate on real queued tasks", async () => {
  const a = (await command(cookie, "/time 00:00-23:59 task a")).body.task;
  const b = (await command(cookie, "/time 00:00-23:59 task b")).body.task;

  const priorityRes = await command(cookie, `/queue priority ${a.id} urgent`);
  assert.equal(priorityRes.body.task.priority, "urgent");

  const moveRes = await command(cookie, `/queue move ${b.id} before ${a.id}`);
  assert.equal(moveRes.body.ok, true);

  const cancelRes = await command(cookie, `/queue cancel ${a.id}`);
  assert.equal(cancelRes.body.task.state, "CANCELLED");

  const listRes = await command(cookie, "/queue list");
  assert.ok(listRes.body.tasks.some((t) => t.id === b.id));
});

test("/queue pause stops new dispatches; /queue resume lets them proceed", async () => {
  await command(cookie, "/queue pause");
  const added = (await command(cookie, "/time 00:00-23:59 paused-queue task")).body.task;
  assert.equal(added.state, "QUEUED");

  await command(cookie, "/queue resume");
  taskQueue.tick(new Date());
  assert.equal(taskQueue.getTask(added.id).state, "RUNNING");
});

test("/mode ai, /pause, /resume, /stop, and /takeover drive a device through the real deviceLease", async () => {
  const modeRes = await command(cookie, "/mode ai mock-2");
  assert.equal(modeRes.status, 200);
  assert.equal(modeRes.body.controllerMode, "AI_IDLE");
  assert.equal(deviceLease.getMode("mock-2"), "AI_IDLE");

  // The command text syntax has no device-targeting form yet (COMMAND_QUEUE_
  // SPEC.md's /time doesn't show one either) — targeting a specific device is
  // exercised directly through the queue API, which /time and /cresearch
  // both go through underneath.
  const targeted = taskQueue.addTask({ goal: "run on mock-2", deviceSelector: { deviceId: "mock-2" } });
  assert.equal(taskQueue.getTask(targeted.id).state, "RUNNING");

  const pauseRes = await command(cookie, "/pause mock-2");
  assert.equal(pauseRes.body.task.state, "PAUSED");
  assert.equal(deviceLease.getMode("mock-2"), "AI_PAUSED");

  const resumeRes = await command(cookie, "/resume mock-2");
  assert.equal(resumeRes.body.task.state, "RUNNING");
  assert.equal(deviceLease.getMode("mock-2"), "AI_RUNNING");

  const stopRes = await command(cookie, "/stop mock-2");
  assert.equal(stopRes.body.task.state, "CANCELLED");
  assert.equal(deviceLease.getMode("mock-2"), "AI_IDLE");

  const takeoverRes = await command(cookie, "/takeover mock-2");
  assert.equal(takeoverRes.status, 200);
  assert.equal(deviceLease.getMode("mock-2"), "HUMAN");
});

test("/mode ai is rejected if the device is already claimed (not idle)", async () => {
  const target = devices.get("mock-1");
  target.status = "in-use";
  try {
    const { status, body } = await command(cookie, "/mode ai mock-1");
    assert.equal(status, 400);
    assert.match(body.error, /must be idle/);
  } finally {
    target.status = "idle";
  }
});

test("device-targeting commands are blocked by RBAC for a restricted operator", async () => {
  for (const text of ["/mode ai mock-2", "/pause mock-2", "/resume mock-2", "/stop mock-2", "/takeover mock-2"]) {
    const { status, body } = await command(restrictedCookie, text);
    assert.equal(status, 400, text);
    assert.match(body.error, /not authorized/, text);
  }
  // mock-1 is on the restricted operator's allow list, so the same shape of
  // command succeeds there — proves the block above is really RBAC, not a
  // blanket rejection of every device-targeting command for this operator.
  const { status } = await command(restrictedCookie, "/mode ai mock-1");
  assert.equal(status, 200);
  await command(restrictedCookie, "/takeover mock-1"); // clean up back to HUMAN
});

test("commands require authentication like every other route", async () => {
  const res = await fetch(`${httpUrl}/api/queue/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "/queue list" }),
  });
  assert.equal(res.status, 401);
});

test("a malformed command returns 400 with the parser's error message", async () => {
  const { status, body } = await command(cookie, "/time not-a-valid-range");
  assert.equal(status, 400);
  assert.ok(body.error);
});

test("/device health returns one device's live status, or every device's when no id is given", async () => {
  const one = await command(cookie, "/device health mock-1");
  assert.equal(one.status, 200);
  assert.equal(one.body.health.id, "mock-1");
  assert.ok("controllerMode" in one.body.health);

  const all = await command(cookie, "/device health");
  assert.equal(all.status, 200);
  assert.ok(all.body.health.some((d) => d.id === "mock-1"));
  assert.ok(all.body.health.some((d) => d.id === "mock-2"));
});

test("/device health on an unknown device is a 400, not a crash", async () => {
  const { status, body } = await command(cookie, "/device health does-not-exist");
  assert.equal(status, 400);
  assert.match(body.error, /unknown device/);
});

test("/device health is not RBAC-restricted, like the WS device list", async () => {
  // restrictedCookie's operator is only allowed mock-1, but health is
  // read-only oversight, not a control action — see the comment on the
  // device_health case in index.js's executeCommand.
  const { status, body } = await command(restrictedCookie, "/device health mock-2");
  assert.equal(status, 200);
  assert.equal(body.health.id, "mock-2");
});

test("/audit returns real events, filterable by device or operator", async () => {
  // Deterministically generate a known mock-1-tagged event rather than
  // relying on incidental audit history from earlier tests in this file.
  await command(cookie, "/mode ai mock-1");
  await command(cookie, "/takeover mock-1");

  const unfiltered = await command(cookie, "/audit");
  assert.equal(unfiltered.status, 200);
  assert.ok(unfiltered.body.events.length > 0);

  const byOperator = await command(cookie, "/audit operator queue-test-va");
  assert.ok(byOperator.body.events.length > 0);
  assert.ok(byOperator.body.events.every((e) => e.operator === "queue-test-va"));

  const byDevice = await command(cookie, "/audit device mock-1 5");
  assert.ok(byDevice.body.events.length > 0);
  assert.ok(byDevice.body.events.length <= 5);
  assert.ok(byDevice.body.events.every((e) => e.deviceId === "mock-1"));
});
