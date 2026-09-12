import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPlatformSkillContract, executeSkillAction } from "../../src/platformSkill.js";
import { createInstagramSkill } from "../../src/platformSkills/instagramSkill.js";
import { createRedditSkill } from "../../src/platformSkills/redditSkill.js";
import { createXSkill } from "../../src/platformSkills/xSkill.js";
import { buildPlatformSkills } from "../../src/platformSkillRegistry.js";
import { MockDevice } from "../../src/mockDevice.js";
import { findAccessibleElement, includesAny, uiText } from "../../src/platformSkills/accessibilityTree.js";

const fixtures = [
  [createInstagramSkill, "instagram", "<XCUIElementTypeApplication name=\"Instagram\" x=\"0\" y=\"0\" width=\"375\" height=\"812\"><XCUIElementTypeButton label=\"Home\" x=\"0\" y=\"760\" width=\"60\" height=\"52\"/><XCUIElementTypeCell label=\"Reel by creator\" x=\"0\" y=\"80\" width=\"375\" height=\"650\"/></XCUIElementTypeApplication>"],
  [createRedditSkill, "reddit", "<XCUIElementTypeApplication name=\"Reddit\" x=\"0\" y=\"0\" width=\"375\" height=\"812\"><XCUIElementTypeButton label=\"Home\" x=\"0\" y=\"760\" width=\"60\" height=\"52\"/><XCUIElementTypeCell label=\"Post in subreddit\" x=\"0\" y=\"80\" width=\"375\" height=\"300\"/></XCUIElementTypeApplication>"],
  [createXSkill, "x", "<XCUIElementTypeApplication name=\"X\" x=\"0\" y=\"0\" width=\"375\" height=\"812\"><XCUIElementTypeButton label=\"Home\" x=\"0\" y=\"760\" width=\"60\" height=\"52\"/><XCUIElementTypeCell label=\"Post views likes\" x=\"0\" y=\"80\" width=\"375\" height=\"300\"/></XCUIElementTypeApplication>"],
];

for (const [builder, platform, tree] of fixtures) {
  test(`${platform} skill detects its fixture and passes the shared contract`, async () => {
    const skill = builder({ appVersion: "fixture-1" });
    assert.equal(await skill.detectState({ ui_tree: tree }), platform === "instagram" ? "reel" : "post");
    assert.equal((await assertPlatformSkillContract(skill)).state, "unknown");
  });
}

test("all profiles hand challenge screens to the passive-only state", async () => {
  for (const [builder] of fixtures) {
    const skill = builder({ appVersion: "fixture-1" });
    assert.equal(await skill.detectState({ ui_tree: "<XCUIElementTypeStaticText label=\"Enter security code to verify your identity\"/>" }),
      "security_challenge");
    assert.deepEqual(await skill.availableActions("security_challenge"),
      ["observe", "capture", "capture_screenshot", "extract_visible"]);
  }
});

test("Instagram opens from the mock springboard and verifies against a fresh tree", async () => {
  const device = new MockDevice("mock-1", "Mock");
  const skill = createInstagramSkill({ appVersion: "fixture-1" });
  const before = { source: "ui_tree", ui_tree: await device.getUiTree() };
  const result = await executeSkillAction({
    skill,
    decision: { screen_state: "springboard", goal_progress: "starting", action: "open_feed",
      target: "instagram", reason: "open app", confidence: 0.99 },
    observation: before,
    policyResult: { outcome: "ALLOWED", action: "open_feed" },
    canExecute: () => true,
    observeAfter: async () => ({ source: "ui_tree", ui_tree: await device.getUiTree() }),
    context: { device },
  });
  assert.equal(result.outcome, "VERIFIED");
  assert.equal(device.openApp, "instagram");
});

test("the X alias matches a standalone token, not XCUIElementType names", () => {
  const withoutX = '<XCUIElementTypeApplication name="SpringBoard" x="0" y="0" width="375" height="812">'
    + '<XCUIElementTypeButton label="Instagram" x="20" y="80" width="60" height="60"/>'
    + "</XCUIElementTypeApplication>";
  const withX = '<XCUIElementTypeApplication name="SpringBoard" x="0" y="0" width="375" height="812">'
    + '<XCUIElementTypeButton label="X" x="200" y="80" width="60" height="60"/>'
    + "</XCUIElementTypeApplication>";
  assert.equal(includesAny(uiText(withoutX), ["x"]), false);
  assert.equal(findAccessibleElement(withoutX, ["x"]), null);
  assert.equal(includesAny(uiText(withX), ["x"]), true);
  assert.equal(findAccessibleElement(withX, ["x"]).raw.label, "X");
});

for (const [builder, platform] of [
  [createRedditSkill, "reddit"],
  [createXSkill, "x"],
]) {
  test(`${platform} opens the correct springboard icon and verifies the new feed`, async () => {
    const iconX = platform === "reddit" ? 60 : 250;
    let opened = false;
    let tapped = null;
    const beforeTree = {
      screen: "home", viewport: { x: 0, y: 0, width: 375, height: 812 }, elements: [
        { type: "button", label: platform === "reddit" ? "Reddit" : "X",
          frame: { x: iconX, y: 100, width: 60, height: 60 } },
      ],
    };
    const device = { id: "fixture-device", async tap(x, y) { tapped = { x, y }; opened = true; } };
    const skill = builder({ appVersion: "fixture-1" });
    const result = await executeSkillAction({
      skill,
      decision: { screen_state: "springboard", goal_progress: "starting", action: "open_feed",
        target: platform, reason: "open app", confidence: 0.99 },
      observation: { source: "ui_tree", ui_tree: beforeTree },
      policyResult: { outcome: "ALLOWED", action: "open_feed" },
      canExecute: () => true,
      observeAfter: async () => ({ source: "ui_tree", ui_tree: opened
        ? { screen: "app", app: platform, viewport: { width: 375, height: 812 },
          elements: [{ type: "text", label: platform === "reddit" ? "Reddit Home" : "Home Timeline" }] }
        : beforeTree }),
      context: { device },
    });
    assert.equal(result.outcome, "VERIFIED");
    assert.ok(Math.abs(tapped.x - (iconX + 30) / 375) < 0.000001);
    assert.ok(Math.abs(tapped.y - 130 / 812) < 0.000001);
  });
}

test("scroll verification observes the mock device change", async () => {
  const device = new MockDevice("mock-1", "Mock");
  device.tap(70 / 375, 120 / 667);
  const skill = createInstagramSkill({ appVersion: "fixture-1" });
  const before = { source: "ui_tree", ui_tree: await device.getUiTree() };
  const result = await executeSkillAction({
    skill,
    decision: { screen_state: "feed", goal_progress: "working", action: "scroll_next",
      target: "feed", reason: "continue", confidence: 0.9 },
    observation: before,
    policyResult: { outcome: "ALLOWED", action: "scroll_next" },
    canExecute: () => true,
    observeAfter: async () => ({ source: "ui_tree", ui_tree: await device.getUiTree() }),
    context: { device },
  });
  assert.equal(result.outcome, "VERIFIED");
  assert.equal(device.lastSwipe, "up");
});

test("skill registry requires explicit app versions and rejects duplicates", () => {
  const skills = buildPlatformSkills({ skills: [
    { platform: "instagram", appVersion: "1" }, { platform: "reddit", appVersion: "2", enabled: false },
  ] });
  assert.equal(skills.get("instagram").appVersion, "1");
  assert.equal(skills.has("reddit"), false);
  assert.throws(() => buildPlatformSkills({ skills: [{ platform: "instagram" }] }), /appVersion/);
  assert.throws(() => buildPlatformSkills({ skills: [
    { platform: "x", appVersion: "1" }, { platform: "x", appVersion: "2" },
  ] }), /duplicate/);
  assert.throws(() => buildPlatformSkills({ skills: [{ platform: "tiktok", appVersion: "1" }] }), /unsupported/);
});

test("model target text cannot redirect read-only navigation to Like", async () => {
  const skill = createInstagramSkill({ appVersion: "fixture" });
  const tree = { viewport: { width: 100, height: 100 }, elements: [
    { label: "Like", frame: { x: 10, y: 10, width: 10, height: 10 } },
    { label: "Profile", frame: { x: 70, y: 70, width: 10, height: 10 } }] };
  let point;
  await skill.execute({ action: "open_profile", target: "Like" }, { state: "feed", observation: { ui_tree: tree }, device: { async tap(x, y) { point = { x, y }; } } });
  assert.ok(point.x > 0.5 && point.y > 0.5);
});
