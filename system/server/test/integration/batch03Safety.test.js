import { test, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as lease from "../../src/deviceLease.js";
import { createTaskQueue } from "../../src/taskQueue.js";
import { executeSkillAction } from "../../src/platformSkill.js";
import { runResearchStep } from "../../src/researchWorker.js";
import { createInstagramSkill } from "../../src/platformSkills/instagramSkill.js";
import { findAccessibleElement, normalizedCenter } from "../../src/platformSkills/accessibilityTree.js";
import { captureObservation } from "../../src/observationPackage.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-batch03-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => lease.reset());
const tree = { name: "Instagram home", x: 0, y: 0, width: 100, height: 200, children: [] };
const skill = createInstagramSkill({ appVersion: "fixture" });
const decision = action => ({ action, target: null, confidence: 1, screen_state: "feed", goal_progress: "working", reason: "fixture" });
test("comments navigation ignores publishing controls", async () => {
  const ui_tree = { ...tree, children: [{ label: "Post comment", x: 10, y: 10, width: 20, height: 20 }, { label: "View comments", x: 60, y: 80, width: 20, height: 20 }] };
  let tapped;
  const result = await skill.execute(decision("open_comments"), { state: "comments", observation: { ui_tree }, device: { async tap(x, y) { tapped = { x, y }; } } });
  assert.equal(result.targetText, "view comments");
  assert.deepEqual(tapped, { x: 0.7, y: 0.45 });
  await assert.rejects(skill.execute(decision("open_comments"), { state: "comments", observation: { ui_tree: { ...tree, children: [ui_tree.children[0]] } }, device: { async tap() { assert.fail("must not publish"); } } }), /not accessible/);
});
test("scroll content bounds cannot change screen normalization", () => {
  const ui_tree = { ...tree, children: [{ label: "Profile", x: 40, y: 90, width: 20, height: 20 }, { label: "Scroll", x: 0, y: 0, width: 100, height: 2000 }] };
  assert.deepEqual(normalizedCenter(ui_tree, findAccessibleElement(ui_tree, ["profile"])), { x: 0.5, y: 0.5 });
  assert.throws(() => normalizedCenter(ui_tree, { frame: { x: 1, y: 300, width: 10, height: 10 } }), /outside/);
  assert.throws(() => normalizedCenter({ children: ui_tree.children }, findAccessibleElement(ui_tree, ["profile"])), /viewport/);
});
test("hidden ancestors and disabled JSON controls are ineligible", () => {
  const profile = (x, extra = {}) => ({ label: "Profile", x, y: 10, width: 10, height: 10, ...extra });
  const ui_tree = { ...tree, children: [profile(1, { visible: false }), profile(2, { enabled: "false" }),
    { visible: false, children: [profile(3)] }, profile(70)] };
  assert.equal(findAccessibleElement(ui_tree, ["profile"]).frame.x, 70);
});
test("hidden, disabled, zero-size, and offscreen XML ancestors make descendants ineligible", () => {
  const xml = '<XCUIElementTypeApplication name="Instagram" x="0" y="0" width="100" height="200">'
    + '<XCUIElementTypeOther visible="false" x="0" y="0" width="50" height="50"><XCUIElementTypeButton label="Profile" x="1" y="1" width="10" height="10"/></XCUIElementTypeOther>'
    + '<XCUIElementTypeOther enabled="false" x="0" y="0" width="50" height="50"><XCUIElementTypeButton label="Profile" x="2" y="2" width="10" height="10"/></XCUIElementTypeOther>'
    + '<XCUIElementTypeOther x="0" y="0" width="0" height="50"><XCUIElementTypeButton label="Profile" x="3" y="3" width="10" height="10"/></XCUIElementTypeOther>'
    + '<XCUIElementTypeOther x="150" y="0" width="20" height="20"><XCUIElementTypeButton label="Profile" x="151" y="1" width="10" height="10"/></XCUIElementTypeOther>'
    + '<XCUIElementTypeOther x="60" y="60" width="30" height="30"><XCUIElementTypeButton label="Profile" x="70" y="70" width="10" height="10"/></XCUIElementTypeOther>'
    + '</XCUIElementTypeApplication>';
  const target = findAccessibleElement(xml, ["profile"]);
  assert.equal(target.frame.x, 70);
  assert.deepEqual(normalizedCenter(xml, target), { x: 0.75, y: 0.375 });
});
test("post-action challenge pauses the real worker without Home recovery", async () => {
  let homes = 0, scrolled = false;
  const device = { id: "d", status: "idle", async getUiTree() { return scrolled ? { ...tree, name: "Enter security code to verify your identity" } : tree; },
    async swipe() { scrolled = true; }, async pressHome() { homes++; } };
  const queue = createTaskQueue({ devices: new Map([["d", device]]), deviceLease: lease, storePath: path.join(root, "challenge.json") });
  const task = queue.addTask({ goal: "inspect" });
  const result = await runResearchStep({ task, device, skill, taskQueue: queue, deviceLease: lease,
    provider: { async observeAndPlan() { return decision("scroll_next"); } }, canAccessAccount: () => true,
    accountId: "a", workspaceId: "w", accountWorkspaces: new Map([["a", "w"]]), accountPolicies: new Map([["a", { scroll_next: "ALLOW_AUTONOMOUS" }]]) });
  assert.equal(result.outcome, "NEEDS_HUMAN");
  assert.equal(task.state, "NEEDS_HUMAN");
  assert.equal(homes, 0);
});
test("authorization revoked during render prevents evidence and verification reads", async () => {
  let allowed = true, saved = 0, reads = 0;
  const result = await executeSkillAction({ skill, decision: decision("capture_screenshot"), observation: { ui_tree: tree },
    policyResult: { outcome: "ALLOWED", action: "capture_screenshot" }, canExecute: () => allowed,
    context: { device: { async render() { allowed = false; return { kind: "image", mime: "image/png", data: "eA==" }; } },
      saveScreenshot() { saved++; return { ref: "fixture", bytes: 1 }; } }, observeAfter: async () => { reads++; return { ui_tree: tree }; } });
  assert.notEqual(result.outcome, "VERIFIED"); assert.equal(saved, 0); assert.equal(reads, 0);
});
test("revocation during failed tree capture prevents screenshot fallback", async () => {
  let allowed = true, renders = 0;
  await assert.rejects(captureObservation({ id: "d", async getUiTree() { allowed = false; throw new Error("unavailable"); }, async render() { renders++; } },
    { goal: "inspect", canObserve: () => allowed }), /revoked/);
  assert.equal(renders, 0);
});
test("failed stop persistence revokes input and blocks redispatch", () => {
  const storePath = path.join(root, "stop.json");
  const queue = createTaskQueue({ devices: new Map([["d", { id: "d", status: "idle" }]]), deviceLease: lease, storePath });
  const task = queue.addTask({ goal: "first" });
  const second = queue.addTask({ goal: "second" });
  const original = fs.writeFileSync;
  const patch = mock.method(fs, "writeFileSync", (file, ...args) => {
    if (String(file).startsWith(storePath + ".")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return original(file, ...args);
  });
  try { assert.throws(() => queue.stopDevice("d"), /disk full/); } finally { patch.mock.restore(); }
  assert.equal(task.state, "CANCELLED"); assert.equal(lease.canAiAct("d"), false); assert.equal(lease.getMode("d"), "ERROR");
  queue.tick(); assert.equal(second.state, "QUEUED");
  assert.equal(JSON.parse(fs.readFileSync(storePath)).tasks[0].state, "RUNNING", "failed write must not be reported as durable");
});
test("emergency stop revokes immediately but blocks every new owner until drain", async () => {
  lease.switchToAI("d"); lease.applyEvent("d", "START_TASK");
  let finish; lease.registerPendingAiAction("d", new Promise(resolve => { finish = resolve; }));
  assert.equal(lease.emergencyStop("d"), "HUMAN");
  assert.equal(lease.canAiAct("d"), false); assert.equal(lease.canHumanSelect("d"), false);
  assert.throws(() => lease.switchToAI("d"), /draining/);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(lease.canHumanSelect("d"), true);
});
