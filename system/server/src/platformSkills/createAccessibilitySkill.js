import { MS8_READ_ONLY_ACTIONS } from "../actionPolicy.js";
import { findAccessibleElement, includesAny, normalizedCenter, normalizeUiText, observationTree, uiText } from "./accessibilityTree.js";

const PASSIVE_ACTIONS = new Set(["observe", "capture", "capture_screenshot", "extract_visible"]);
const CHALLENGE_PATTERNS = ["captcha", "security challenge", "security code", "two factor", "verification code",
  "verify it is you", "verify your identity", "suspicious login", "account recovery", "challenge required"];

function fingerprint(observation) {
  const tree = observationTree(observation);
  return typeof tree === "string" ? tree : JSON.stringify(tree);
}

export function createAccessibilitySkill({ name, platform, appVersion, appAliases, stateRules, actionTargets }) {
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
      if (state === "security_challenge") return [...PASSIVE_ACTIONS];
      if (state === "springboard") return ["observe", "open_feed", "capture", "capture_screenshot", "extract_visible"];
      if (state === "unknown") return ["observe", "capture", "capture_screenshot", "extract_visible"];
      return [...this.supportedActions];
    },

    async execute(decision, context) {
      const device = context?.device;
      if (!device) throw new Error(`${platform} skill requires a device`);
      if (PASSIVE_ACTIONS.has(decision.action)) return { kind: "observation", state: context.state };
      if (decision.action === "scroll_next" || decision.action === "scroll_previous") {
        const direction = decision.action === "scroll_next" ? "up" : "down";
        await device.swipe(direction);
        return { kind: "swipe", direction };
      }

      const tree = observationTree(context.observation);
      const targetText = normalizeUiText(decision.target);
      const genericTargets = new Set(["", "feed", "current", "current post", "current thread", "screen"]);
      const patterns = [
        ...(targetText && !genericTargets.has(targetText) ? [targetText] : []),
        ...(context.state === "springboard" && decision.action === "open_feed" ? appAliases : []),
        ...(actionTargets[decision.action] ?? []),
      ];
      const element = findAccessibleElement(tree, patterns);
      if (!element) throw new Error(`${platform} ${decision.action} target was not accessible`);
      const point = normalizedCenter(tree, element);
      await device.tap(point.x, point.y);
      return { kind: "tap", targetText: element.text, ...point };
    },

    async verify(decision, observationAfter, context) {
      if (PASSIVE_ACTIONS.has(decision.action)) return true;
      const afterState = await this.detectState(observationAfter);
      if (afterState === "security_challenge") return false;
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
      return expected.includes(afterState)
        || (context.state === "springboard" && decision.action === "open_feed" && afterState !== "springboard" && afterState !== "unknown");
    },

    async recover(error, context) {
      if (typeof context?.device?.pressHome !== "function") return { recovered: false, reason: error.message };
      await context.device.pressHome();
      return { recovered: true, destination: "springboard", reason: error.message };
    },
  };
  return skill;
}

export { CHALLENGE_PATTERNS };
