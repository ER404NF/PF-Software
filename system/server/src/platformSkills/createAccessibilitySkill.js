import { validateImageFrame } from "../observationPackage.js";
import { MS8_READ_ONLY_ACTIONS } from "../actionPolicy.js";
import { findAccessibleElement, includesAny, normalizedCenter, normalizeUiText, observationTree, uiText } from "./accessibilityTree.js";

const PASSIVE_ACTIONS = new Set(["observe", "capture", "capture_screenshot", "extract_visible"]);
const DETAIL_NAVIGATION_ACTIONS = new Set(["open_post", "open_thread", "open_comments"]);
const CHALLENGE_PATTERNS = ["captcha", "security challenge", "security code", "two factor", "verification code",
  "verify it is you", "verify your identity", "suspicious login", "account recovery", "challenge required"];

function navigationControl(action, element, commentNavigationTerms) {
  const raw = element.raw;
  const label = normalizeUiText(raw.label ?? raw.name ?? raw.identifier ?? raw.text ?? "");
  const role = normalizeUiText(raw.type ?? raw.role ?? "");
  if (/application|window|scroll|textfield|text field/.test(role)) return false;
  if (/\b(send|submit|publish|delete|remove|like|unlike|follow|unfollow|repost|share|save|bookmark|upvote|downvote)\b/.test(label)
    || /^(post|add|write) (a )?comment/.test(label)) return false;
  if (action === "open_comments") {
    return commentNavigationTerms.some(term => label === term
      || new RegExp(`^(?:view|open|show|all) ${term}(?:\\b|$)`).test(label));
  }
  if (action === "open_post" || action === "open_thread") {
    return /^(?:(?:view|open|show) (?:post|thread)|reel(?:s| by| viewer|$)|(?:post|thread) (?:viewer|by|in|card))/.test(label);
  }
  return true;
}

function fingerprint(observation) {
  const tree = observationTree(observation);
  return typeof tree === "string" ? tree : JSON.stringify(tree);
}

export function createAccessibilitySkill({ name, platform, appVersion, appAliases, stateRules, actionTargets,
  commentNavigationTerms = ["comments"] }) {
  if (typeof appVersion !== "string" || !appVersion.trim()) throw new Error(`${platform} skill requires an appVersion`);
  const skill = {
    name,
    platform,
    skillVersion: "1.0.0",
    appVersion: appVersion.trim(),
    supportedActions: [...MS8_READ_ONLY_ACTIONS],

    async detectState(observation) {
      const tree = observationTree(observation);
      const text = uiText(tree);
      if (!text && observation?.source === "screenshot") {
        validateImageFrame(observation.screenshot);
        return "screenshot";
      }
      if (!text) throw new Error(`${platform} accessibility tree contained no readable elements`);
      if (includesAny(text, CHALLENGE_PATTERNS)) return "security_challenge";
      const jsonSpringboard = tree && typeof tree === "object" && normalizeUiText(tree.screen) === "home";
      if ((jsonSpringboard || includesAny(text, ["springboard"])) && includesAny(text, appAliases)) return "springboard";
      for (const rule of stateRules) {
        if (includesAny(text, rule.patterns)) return rule.state;
      }
      return "unknown";
    },

    async availableActions(state) {
      if (state === "screenshot") return [...PASSIVE_ACTIONS];
      if (state === "security_challenge") return [...PASSIVE_ACTIONS];
      if (state === "springboard") return ["observe", "open_feed", "capture", "capture_screenshot", "extract_visible"];
      if (state === "unknown") return ["observe", "capture", "capture_screenshot", "extract_visible"];
      return [...this.supportedActions];
    },

    async execute(decision, context) {
      const device = context?.device;
      if (!device) throw new Error(`${platform} skill requires a device`);
      if (["capture", "capture_screenshot"].includes(decision.action)) {
        const frame = validateImageFrame(await device.render());
        if (typeof context.canExecute !== "function" || !context.canExecute()) throw new Error("Screenshot authorization was revoked");
        if (typeof context.saveScreenshot !== "function") throw new Error("durable screenshot storage is unavailable");
        const evidence = context.saveScreenshot(frame);
        if (!evidence?.ref || !(evidence.bytes > 0)) throw new Error("screenshot evidence was not saved");
        return { kind: "screenshot", evidence };
      }
      if (PASSIVE_ACTIONS.has(decision.action)) return { kind: "observation", state: context.state };
      if (decision.action === "scroll_next" || decision.action === "scroll_previous") {
        const direction = decision.action === "scroll_next" ? "up" : "down";
        await device.swipe(direction);
        return { kind: "swipe", direction };
      }

      const tree = observationTree(context.observation);
      // Model text cannot expand the set of controls authorized for an
      // action. Select only the platform's action-specific navigation targets.
      const patterns = context.state === "springboard" && decision.action === "open_feed"
        ? appAliases : (actionTargets[decision.action] ?? []);
      const element = findAccessibleElement(tree, patterns,
        element => navigationControl(decision.action, element, commentNavigationTerms));
      if (!element) throw new Error(`${platform} ${decision.action} target was not accessible`);
      const point = normalizedCenter(tree, element);
      await device.tap(point.x, point.y);
      return { kind: "tap", targetText: element.text, ...point };
    },

    async verify(decision, observationAfter, context) {
      const afterState = await this.detectState(observationAfter);
      if (afterState === "security_challenge") return { outcome: "NEEDS_HUMAN", reason: "security challenge appeared after input" };
      if (["capture", "capture_screenshot"].includes(decision.action)) {
        return context.execution?.kind === "screenshot" && !!context.execution.evidence?.ref
          && context.execution.evidence.bytes > 0;
      }
      if (PASSIVE_ACTIONS.has(decision.action)) return true;
      if (decision.action === "scroll_next" || decision.action === "scroll_previous") {
        const direction = decision.action === "scroll_next" ? "up" : "down";
        return fingerprint(observationAfter) !== fingerprint(context.observationBefore)
          || includesAny(uiText(observationTree(observationAfter)), [`last swipe ${direction}`]);
      }
      if (decision.action === "copy_link") {
        return includesAny(uiText(observationTree(observationAfter)), ["copied", "link copied"]);
      }
      const expected = {
        open_feed: ["feed"], search: ["search"], open_post: ["post", "reel"],
        open_thread: ["post", "thread", "comments"], open_profile: ["profile"], open_comments: ["comments"],
      }[decision.action] ?? [];
      if (DETAIL_NAVIGATION_ACTIONS.has(decision.action)
        && fingerprint(observationAfter) === fingerprint(context.observationBefore)) return false;
      return expected.includes(afterState)
        || (context.state === "springboard" && decision.action === "open_feed" && afterState !== "springboard" && afterState !== "unknown");
    },

    async recover(error, context) {
      if (PASSIVE_ACTIONS.has(context?.decision?.action)) return { recovered: false, reason: error.message };
      if (typeof context?.device?.pressHome !== "function") return { recovered: false, reason: error.message };
      await context.device.pressHome();
      return { recovered: true, destination: "springboard", reason: error.message };
    },
  };
  return skill;
}

export { CHALLENGE_PATTERNS };
