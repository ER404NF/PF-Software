// Platform-visible actions for the accessibility-based skills (roadmap MS9/MS10):
// private saves/bookmarks, likes, votes, reposts, and comments.
//
// IMPORTANT: the control labels below are what these apps' accessibility trees are
// expected to expose. They have NOT been checked against a real installed app
// version; the supervised real-device gate in the roadmap exists for exactly that.
// Until then the safe failure mode is built in: if a control cannot be found or its
// state cannot be read unambiguously, the action is refused (AMBIGUOUS) and a human
// is asked, never guessed at.
//
// Toggles go through stateToggle.js (read state -> act only if different -> verify ->
// retry only when positively unchanged). A comment is NOT a toggle and is never
// retried blindly: posting twice would be visible to everyone.

import { COMMENT_ACTIONS, TOGGLE_ACTIONS } from "../actionCatalog.js";
import { idempotentToggle, TOGGLE_OUTCOMES } from "../stateToggle.js";
import { normalizedCenter, normalizeUiText, observationTree, uiElements, uiText } from "./accessibilityTree.js";

// label of the control as shown when the thing is NOT active (off) / IS active (on)
export const TOGGLE_CONTROLS = Object.freeze({
  instagram: {
    save: { off: ["save"], on: ["remove from saved", "unsave", "saved"] },
    like: { off: ["like"], on: ["unlike", "liked"] },
    repost: { off: ["repost"], on: ["undo repost", "remove repost", "reposted"] },
  },
  reddit: {
    save: { off: ["save"], on: ["unsave", "saved", "remove from saved"] },
    vote_up: { off: ["upvote"], on: ["upvoted", "remove upvote"] },
    vote_down: { off: ["downvote"], on: ["downvoted", "remove downvote"] },
  },
  x: {
    save: { off: ["bookmark"], on: ["bookmarked", "remove bookmark"] },
    like: { off: ["like"], on: ["liked", "unlike"] },
    repost: { off: ["repost"], on: ["reposted", "undo repost"] },
  },
});

export const COMMENT_CONTROLS = Object.freeze({
  instagram: { field: ["add a comment", "add comment"], send: ["post"] },
  reddit: { field: ["add a comment", "join the conversation"], send: ["comment"] },
  x: { field: ["post your reply", "reply"], send: ["reply", "post"] },
});

// A single post is on screen in these states, so a control's state is unambiguous.
// (In a feed several posts each have their own Like button: never act there.)
const DETAIL_STATES = new Set(["post", "reel", "thread"]);
const COMMENT_STATES = new Set(["post", "reel", "thread", "comments"]);

function labelOf(element) {
  const raw = element.raw ?? {};
  return normalizeUiText(raw.label ?? raw.name ?? raw.identifier ?? raw.text ?? "");
}

// "like" matches "like" and "like 1 234", never "liked" or "unlike".
function labelMatches(label, patterns) {
  return patterns.some(pattern => {
    const needle = normalizeUiText(pattern);
    return needle && (label === needle || label.startsWith(`${needle} `));
  });
}

// Only things that can be pressed count as controls: a screen title such as "Post details"
// must never be mistaken for the "Post" button.
function isPressable(element) {
  const kind = normalizeUiText(element.raw?.type ?? element.raw?.role ?? "");
  return /button|switch|toggle|link|cell/.test(kind);
}

function findControls(tree, patterns) {
  return uiElements(tree).filter(element => element.frame && isPressable(element) && labelMatches(labelOf(element), patterns));
}

function findControl(tree, patterns) {
  return findControls(tree, patterns)[0] ?? null;
}

function familyControls(platform, family) {
  return TOGGLE_CONTROLS[platform]?.[family] ?? null;
}

// Which control to press to get from the current state to `desired`.
function controlFor(platform, family, which, tree) {
  if (family === "vote") {
    const up = familyControls(platform, "vote_up");
    const down = familyControls(platform, "vote_down");
    for (const controls of [up, down]) {
      const found = controls && findControl(tree, controls[which]);
      if (found) return found;
    }
    return null;
  }
  const controls = familyControls(platform, family);
  return controls ? findControl(tree, controls[which]) : null;
}

function countControls(platform, family, which, tree) {
  const families = family === "vote" ? ["vote_up", "vote_down"] : [family];
  return families.reduce((total, name) => {
    const controls = familyControls(platform, name);
    return total + (controls ? findControls(tree, controls[which]).length : 0);
  }, 0);
}

// "on" / "off" only when the answer is unambiguous. Exactly one matching control must be
// on screen: two identical Save buttons (two posts visible) or none at all (control not
// visible) is "unknown", and unknown means nothing gets pressed.
export function readToggleState(platform, family, observation) {
  const tree = observationTree(observation);
  if (!tree) return "unknown";
  if (family === "vote") {
    // Clearing a vote: "on" while exactly one of up/down is active, "off" while neither is.
    const active = countControls(platform, "vote", "on", tree);
    if (active === 1) return "on";
    const idle = countControls(platform, "vote", "off", tree);
    const available = ["vote_up", "vote_down"].filter(name => familyControls(platform, name)).length;
    return active === 0 && idle === available ? "off" : "unknown";
  }
  const on = countControls(platform, family, "on", tree);
  const off = countControls(platform, family, "off", tree);
  if (on + off !== 1) return "unknown";
  return on === 1 ? "on" : "off";
}

function supportedToggleActions(platform) {
  const has = family => Boolean(familyControls(platform, family));
  return Object.entries(TOGGLE_ACTIONS).filter(([, spec]) => (spec.family === "vote" ? has("vote_up") || has("vote_down") : has(spec.family)))
    .map(([action]) => action);
}

export function withPlatformActions(base) {
  const platform = base.platform;
  const toggleActions = supportedToggleActions(platform);
  const commentControls = COMMENT_CONTROLS[platform] ?? null;
  const commentActions = commentControls ? COMMENT_ACTIONS.filter(action => action.startsWith("comment_")) : [];
  if (!toggleActions.length && !commentActions.length) return base;
  const extra = new Set([...toggleActions, ...commentActions]);

  return {
    ...base,
    supportedActions: [...base.supportedActions, ...extra],

    async detectState(observation) {
      return base.detectState(observation);
    },

    async availableActions(state, observation) {
      const available = await base.availableActions(state, observation);
      const added = [];
      if (DETAIL_STATES.has(state)) added.push(...toggleActions);
      if (COMMENT_STATES.has(state)) added.push(...commentActions);
      return [...available, ...added];
    },

    async execute(decision, context) {
      if (!extra.has(decision.action)) return base.execute(decision, context);
      const device = context?.device;
      if (!device) throw new Error(`${platform} skill requires a device`);
      if (typeof context.canExecute !== "function") throw new Error("authorization check is required");

      if (TOGGLE_ACTIONS[decision.action]) {
        const { family, desired } = TOGGLE_ACTIONS[decision.action];
        if (typeof context.reobserve !== "function") throw new Error("a fresh observation is required to verify a toggle");
        let latest = context.observation;
        const result = await idempotentToggle({
          desired,
          observation: latest,
          readState: observation => readToggleState(platform, family, observation),
          reobserve: async () => { latest = await context.reobserve(); return latest; },
          canContinue: context.canExecute,
          act: async () => {
            const tree = observationTree(latest);
            // Press the control that is shown in the state we are LEAVING.
            const element = controlFor(platform, family, desired === "on" ? "off" : "on", tree);
            if (!element) throw new Error(`${platform} ${family} control was not accessible`);
            const point = normalizedCenter(tree, element);
            await device.tap(point.x, point.y);
          },
        });
        return { kind: "toggle", family, desired, ...result };
      }

      // Comment: open the field, type exactly the approved text, press send. Never repeated.
      const text = decision.comment?.text;
      if (typeof text !== "string" || !text.trim()) throw new Error("comment text is required");
      let tree = observationTree(context.observation);
      const field = uiElements(tree).find(element => element.frame && labelMatches(labelOf(element), commentControls.field));
      if (!field) throw new Error(`${platform} comment field was not accessible`);
      let point = normalizedCenter(tree, field);
      await device.tap(point.x, point.y);
      if (!context.canExecute()) throw new Error("authorization was revoked before typing");
      await device.typeText(text);
      const typed = await context.reobserve();
      if (!context.canExecute()) throw new Error("authorization was revoked before sending");
      tree = observationTree(typed);
      const send = findControl(tree, commentControls.send);
      if (!send) throw new Error(`${platform} comment send control was not accessible`);
      point = normalizedCenter(tree, send);
      await device.tap(point.x, point.y);
      return { kind: "comment", text };
    },

    async verify(decision, observationAfter, context) {
      if (!extra.has(decision.action)) return base.verify(decision, observationAfter, context);
      const afterState = await base.detectState(observationAfter);
      if (afterState === "security_challenge") return { outcome: "NEEDS_HUMAN", reason: "security challenge appeared after input" };
      const execution = context.execution ?? {};
      if (execution.kind === "toggle") {
        if ([TOGGLE_OUTCOMES.VERIFIED, TOGGLE_OUTCOMES.NOOP].includes(execution.outcome)) return true;
        if (execution.outcome === TOGGLE_OUTCOMES.AMBIGUOUS) {
          return { outcome: "NEEDS_HUMAN", reason: execution.reason || "the control's state could not be read; a person should check it" };
        }
        return false;
      }
      if (execution.kind === "comment") {
        const seen = normalizeUiText(uiText(observationTree(observationAfter)));
        const probe = normalizeUiText(execution.text).slice(0, 40);
        return probe.length > 0 && seen.includes(probe)
          ? true
          : { outcome: "NEEDS_HUMAN", reason: "the comment could not be confirmed on screen; check the post before anything is retried" };
      }
      return false;
    },

    async recover(error, context) {
      return base.recover(error, context);
    },
  };
}
