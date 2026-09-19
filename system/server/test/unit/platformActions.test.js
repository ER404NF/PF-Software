import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstagramSkill } from "../../src/platformSkills/instagramSkill.js";
import { createRedditSkill } from "../../src/platformSkills/redditSkill.js";
import { createXSkill } from "../../src/platformSkills/xSkill.js";
import { withPlatformActions, readToggleState } from "../../src/platformSkills/toggleActions.js";
import { assertPlatformSkill, assertPlatformSkillContract, executeSkillAction } from "../../src/platformSkill.js";

// A post screen whose accessibility tree reacts to taps, the way the real app's does.
class PostScreen {
  constructor({ controls, marker = "Post details", takes = () => true, feed = false, comments = false }) {
    this.controls = controls.map((control, index) => ({ ...control, on: Boolean(control.on), y: 20 + index * 24 }));
    this.marker = marker;
    this.takes = takes;
    this.feed = feed;
    this.commentBox = comments ? { text: "", posted: [] } : null;
    this.taps = [];
    this.typed = [];
    this.presses = 0;
    this.focus = null;
  }

  tree() {
    const elements = [{ type: "staticText", label: this.marker, frame: { x: 0, y: 0, width: 100, height: 10 } }];
    for (const control of this.controls) {
      elements.push({ type: "button", label: control.on ? control.onLabel : control.offLabel, frame: { x: 10, y: control.y, width: 20, height: 16 } });
      if (this.feed) elements.push({ type: "button", label: control.offLabel, frame: { x: 60, y: control.y, width: 20, height: 16 } }); // a second post's button
    }
    if (this.commentBox) {
      elements.push({ type: "textField", label: "Add a comment", frame: { x: 10, y: 150, width: 60, height: 16 } });
      elements.push({ type: "button", label: "Post", frame: { x: 75, y: 150, width: 20, height: 16 } });
      for (const posted of this.commentBox.posted) elements.push({ type: "staticText", label: posted, frame: { x: 10, y: 170, width: 80, height: 10 } });
    }
    return { screen: "post", viewport: { x: 0, y: 0, width: 100, height: 200 }, elements };
  }

  observe() { return { source: "ui_tree", ui_tree: this.tree() }; }

  async tap(x, y) {
    this.taps.push([x, y]);
    const px = x * 100;
    const py = y * 200;
    for (const control of this.controls) {
      if (px >= 10 && px <= 30 && py >= control.y && py <= control.y + 16) {
        this.presses += 1;
        if (this.takes(this.presses)) control.on = !control.on;
        return;
      }
    }
    if (this.commentBox && py >= 150 && py <= 166) {
      if (px < 70) this.focus = "comment";
      else if (this.focus === "comment" && this.commentBox.text) { this.commentBox.posted.push(this.commentBox.text); this.commentBox.text = ""; }
    }
  }

  async typeText(text) { this.typed.push(text); if (this.focus === "comment") this.commentBox.text += text; }
  async pressHome() {}
}

const save = { offLabel: "Save", onLabel: "Remove from saved", on: false };
const like = { offLabel: "Like", onLabel: "Unlike", on: false };

async function run(skill, sim, action, { comment = null, canExecute = () => true } = {}) {
  const decision = { screen_state: "post", goal_progress: "working", action, target: "https://www.instagram.com/p/AAA/", reason: "r", confidence: 0.9, ...(comment ? { comment } : {}) };
  return executeSkillAction({
    skill, decision, observation: sim.observe(), policyResult: { outcome: "ALLOWED", action },
    canExecute, observeAfter: async () => sim.observe(), context: { device: sim },
  });
}

const instagram = () => withPlatformActions(createInstagramSkill({ appVersion: "test" }));

test("wrapped skills stay valid platform skills and declare exactly the actions their platform has", async () => {
  for (const [skill, expected, missing] of [
    [instagram(), ["platform_save", "platform_unsave", "like", "unlike", "repost", "undo_repost", "comment_preset", "comment_generated"], ["upvote", "downvote"]],
    [withPlatformActions(createRedditSkill({ appVersion: "t" })), ["platform_save", "upvote", "downvote", "clear_vote", "comment_generated"], ["like", "repost"]],
    [withPlatformActions(createXSkill({ appVersion: "t" })), ["platform_save", "like", "repost", "undo_repost", "comment_generated"], ["upvote", "clear_vote"]],
  ]) {
    assertPlatformSkill(skill);
    for (const action of expected) assert.ok(skill.supportedActions.includes(action), `${skill.platform} supports ${action}`);
    for (const action of missing) assert.equal(skill.supportedActions.includes(action), false, `${skill.platform} has no ${action}`);
    assert.equal(skill.supportedActions.includes("reply_generated"), false, "replies are not supported yet");
    await assertPlatformSkillContract(skill);
  }
});

test("platform actions are offered only when one post is on screen, never in a feed of many", async () => {
  const skill = instagram();
  const post = new PostScreen({ controls: [save, like] });
  assert.ok((await skill.availableActions("post", post.observe())).includes("platform_save"));
  assert.equal((await skill.availableActions("feed", post.observe())).includes("platform_save"), false);
  assert.equal((await skill.availableActions("springboard", post.observe())).includes("like"), false);
  assert.equal((await skill.availableActions("comments", post.observe())).includes("comment_generated"), true);
  assert.equal((await skill.availableActions("comments", post.observe())).includes("like"), false);
});

test("Save when not yet saved: one press, verified, and the account ends saved", async () => {
  const sim = new PostScreen({ controls: [{ ...save }, { ...like }] });
  const result = await run(instagram(), sim, "platform_save");
  assert.equal(result.outcome, "VERIFIED");
  assert.equal(result.execution.outcome, "VERIFIED");
  assert.equal(sim.presses, 1);
  assert.equal(readToggleState("instagram", "save", sim.observe()), "on");
});

test("re-running the identical task is a NOOP: the second Save presses nothing", async () => {
  const sim = new PostScreen({ controls: [{ ...save }] });
  await run(instagram(), sim, "platform_save");
  const again = await run(instagram(), sim, "platform_save");
  assert.equal(again.outcome, "VERIFIED");
  assert.equal(again.execution.outcome, "NOOP");
  assert.equal(sim.presses, 1, "still exactly one press in total");
});

test("Unsave and Unlike work, and an already-unsaved post is left alone", async () => {
  const sim = new PostScreen({ controls: [{ ...save, on: true }, { ...like, on: true }] });
  assert.equal((await run(instagram(), sim, "platform_unsave")).execution.outcome, "VERIFIED");
  assert.equal((await run(instagram(), sim, "unlike")).execution.outcome, "VERIFIED");
  assert.equal((await run(instagram(), sim, "platform_unsave")).execution.outcome, "NOOP");
  assert.equal(sim.presses, 2);
});

test("a press that did not register is retried once, and a stubborn control ends as a failed verification", async () => {
  const flaky = new PostScreen({ controls: [{ ...save }], takes: press => press >= 2 });
  const recovered = await run(instagram(), flaky, "platform_save");
  assert.equal(recovered.outcome, "VERIFIED");
  assert.equal(flaky.presses, 2);

  const stuck = new PostScreen({ controls: [{ ...save }], takes: () => false });
  const failed = await run(instagram(), stuck, "platform_save");
  assert.equal(failed.outcome, "FAILED_VERIFICATION");
  assert.equal(stuck.presses, 2, "bounded, not an endless loop");
});

test("if the state cannot be read (several posts on screen) NOTHING is pressed and a human is asked", async () => {
  const sim = new PostScreen({ controls: [{ ...save }], feed: true });
  const result = await run(instagram(), sim, "platform_save");
  assert.equal(result.outcome, "NEEDS_HUMAN");
  assert.equal(sim.presses, 0);
  assert.match(result.reason, /state could not be read|person should check/);
});

test("Reddit votes: upvote, downvote and clear_vote", async () => {
  const skill = withPlatformActions(createRedditSkill({ appVersion: "t" }));
  const up = { offLabel: "Upvote", onLabel: "Upvoted", on: false };
  const down = { offLabel: "Downvote", onLabel: "Downvoted", on: false };
  const sim = new PostScreen({ controls: [up, down], marker: "Post details" });
  assert.equal((await run(skill, sim, "upvote")).execution.outcome, "VERIFIED");
  assert.equal(readToggleState("reddit", "vote_up", sim.observe()), "on");
  assert.equal((await run(skill, sim, "clear_vote")).execution.outcome, "VERIFIED");
  assert.equal(readToggleState("reddit", "vote_up", sim.observe()), "off");
  assert.equal((await run(skill, sim, "clear_vote")).execution.outcome, "NOOP", "no vote to clear");
});

test("a label like 'Like 1,234' still reads as the Like control, but 'Liked' and 'Unlike' never do", () => {
  const observe = label => ({ ui_tree: { screen: "post", viewport: { x: 0, y: 0, width: 100, height: 100 }, elements: [{ type: "button", label, frame: { x: 1, y: 1, width: 5, height: 5 } }] } });
  assert.equal(readToggleState("instagram", "like", observe("Like 1,234 likes")), "off");
  assert.equal(readToggleState("instagram", "like", observe("Liked")), "on");
  assert.equal(readToggleState("instagram", "like", observe("Unlike")), "on");
  assert.equal(readToggleState("instagram", "like", observe("Likewise")), "unknown");
});

test("a comment is typed exactly and posted once, and the post is checked afterwards", async () => {
  const sim = new PostScreen({ controls: [{ ...like }], comments: true });
  const result = await run(instagram(), sim, "comment_generated", { comment: { text: "Lovely harbour sunrise!", source: "generated" } });
  assert.equal(result.outcome, "VERIFIED", JSON.stringify({ result, taps: sim.taps, tree: sim.tree().elements.map(e => e.label) }));
  assert.deepEqual(sim.typed, ["Lovely harbour sunrise!"]);
  assert.deepEqual(sim.commentBox.posted, ["Lovely harbour sunrise!"]);
});

test("if a comment cannot be confirmed on screen it is NOT retried; a human checks the post", async () => {
  const sim = new PostScreen({ controls: [{ ...like }], comments: true });
  sim.tap = async function tap(x, y) { // the send press silently does nothing visible
    this.taps.push([x, y]);
    if (y * 200 >= 150 && x * 100 < 70) this.focus = "comment";
  };
  const result = await run(instagram(), sim, "comment_generated", { comment: { text: "Lovely harbour sunrise!", source: "generated" } });
  assert.equal(result.outcome, "NEEDS_HUMAN");
  assert.match(result.reason, /could not be confirmed/);
  assert.equal(sim.typed.length, 1, "typed once");
});

test("authorization withdrawn mid-toggle stops further presses", async () => {
  const sim = new PostScreen({ controls: [{ ...save }], takes: () => false });
  let calls = 0;
  const result = await run(instagram(), sim, "platform_save", { canExecute: () => (calls += 1) <= 2 });
  assert.notEqual(result.outcome, "VERIFIED", JSON.stringify(result));
  assert.ok(sim.presses <= 1, JSON.stringify({ presses: sim.presses, result }));
});
