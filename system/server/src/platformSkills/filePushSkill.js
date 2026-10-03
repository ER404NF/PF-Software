// P4 build (docs/productionization/P4_DEVICE_PUSH_BUILD.md): drives the
// phone's own on-device Safari to a one-time download link (filePushLinkStore.js
// issues it, index.js's GET /d/:token serves it), which iOS hands to the
// Files app on its own — no AFC, no jailbreak, no target app needing to
// have opted into anything (see P4_DEVICE_PUSH_RESEARCH.md for why this is
// the real, general-purpose path and direct Photos-library push is not).
//
// Deliberately implements the SAME shape platformSkill.js's contract
// requires (detectState/availableActions/execute/verify/recover — the
// perceive -> plan -> validate -> act -> verify loop every other skill in
// this app already follows) for the same discipline (uncertain state
// escalates rather than guesses, verify() re-checks reality rather than
// trusting elapsed time) — but this is NOT run through
// assertPlatformSkill()/executeSkillAction(): those are wired to
// actionCatalog.js's fixed social-platform research action list
// (like/comment/save/etc.), and "push a file to this phone" isn't a
// content-research action at all. filePushOrchestrator.js drives this skill
// directly instead. supportedActions below is this skill's own action
// vocabulary, not a subset of actionCatalog.js's ACTIONS.
//
// KNOWN LIMITATION, stated plainly rather than glossed over: the UI-text
// patterns below (which label identifies the Safari icon, the address bar,
// a download-in-progress vs download-complete banner, an error page) are a
// best-effort guess at real iOS/Safari accessibility labels, which genuinely
// vary by iOS version — this is exactly the part
// PRODUCTION_READINESS_AUDIT.md §16/§4 says cannot be verified without a
// real iPhone. Every state/pattern here is easy to find and adjust in one
// place (the *_PATTERNS constants) once real-hardware testing reveals the
// actual labels.

import { findAccessibleElement, includesAny, normalizedCenter, normalizeUiText, observationTree, uiText } from "./accessibilityTree.js";
import { operationalErrorKind } from "../safeOperationalLog.js";

const SAFARI_APP_PATTERNS = ["safari"];
const ADDRESS_BAR_PATTERNS = ["address", "search or enter website name", "search or enter address"];
const DOWNLOAD_CONFIRMATION_PATTERNS = ["do you want to download", "download this file"];
const DOWNLOAD_BUTTON_PATTERNS = ["download"];
const DOWNLOAD_IN_PROGRESS_PATTERNS = ["downloading", "download in progress", "downloads button downloading"];
const DOWNLOAD_COMPLETE_PATTERNS = ["download complete", "downloaded", "open in files", "show in downloads", "saved to files"];
const ERROR_PATTERNS = [
  "cannot open the page", "safari cannot open the page", "no internet connection",
  "this link is no longer valid", "link expired", "the page could not be found", "not found",
];

const STATES = Object.freeze({
  SPRINGBOARD: "springboard",
  ADDRESS_BAR: "safari_address_bar",
  DOWNLOAD_CONFIRMATION: "download_confirmation",
  DOWNLOAD_IN_PROGRESS: "download_in_progress",
  DOWNLOAD_COMPLETE: "download_complete",
  ERROR: "error",
  UNKNOWN: "unknown",
});

const ACTIONS_BY_STATE = Object.freeze({
  [STATES.SPRINGBOARD]: ["open_safari"],
  [STATES.ADDRESS_BAR]: ["navigate_to_link"],
  [STATES.DOWNLOAD_CONFIRMATION]: ["confirm_download"],
  [STATES.DOWNLOAD_IN_PROGRESS]: ["wait_for_download"],
  [STATES.DOWNLOAD_COMPLETE]: ["confirm_downloaded"],
  [STATES.ERROR]: [],
  [STATES.UNKNOWN]: [],
});

export function createFilePushSkill({ appVersion = "unknown" } = {}) {
  return {
    name: "file-push",
    platform: "safari",
    skillVersion: "1.0.0",
    appVersion,
    // Not actionCatalog.js action names — see the module comment above.
    supportedActions: ["open_safari", "navigate_to_link", "confirm_download", "wait_for_download", "confirm_downloaded"],

    async detectState(observation) {
      const tree = observationTree(observation);
      const text = uiText(tree);
      if (!text) throw new Error("file-push skill: accessibility tree contained no readable elements");
      // Checked most-specific-first: a download banner can appear over any
      // screen, so it must win over a generic springboard/address-bar match.
      if (includesAny(text, ERROR_PATTERNS)) return STATES.ERROR;
      if (includesAny(text, DOWNLOAD_COMPLETE_PATTERNS)) return STATES.DOWNLOAD_COMPLETE;
      if (includesAny(text, DOWNLOAD_IN_PROGRESS_PATTERNS)) return STATES.DOWNLOAD_IN_PROGRESS;
      if (includesAny(text, DOWNLOAD_CONFIRMATION_PATTERNS)) return STATES.DOWNLOAD_CONFIRMATION;
      if (includesAny(text, ADDRESS_BAR_PATTERNS)) return STATES.ADDRESS_BAR;
      const jsonSpringboard = tree && typeof tree === "object" && normalizeUiText(tree.screen) === "home";
      if (jsonSpringboard || includesAny(text, ["springboard"])) return STATES.SPRINGBOARD;
      return STATES.UNKNOWN;
    },

    async availableActions(state) {
      return ACTIONS_BY_STATE[state] ?? [];
    },

    async execute(action, context) {
      const device = context?.device;
      if (!device) throw new Error("file-push skill requires a device");
      const authorize = typeof context?.authorize === "function" ? context.authorize : async () => {};
      if (action === "open_safari") {
        const tree = observationTree(context.observation);
        const element = findAccessibleElement(tree, SAFARI_APP_PATTERNS);
        if (!element) throw new Error("Safari icon was not accessible on the springboard");
        const point = normalizedCenter(tree, element);
        await authorize();
        await device.tap(point.x, point.y);
        return { kind: "tap", target: "safari", ...point };
      }
      if (action === "navigate_to_link") {
        if (typeof context.url !== "string" || !context.url) throw new Error("navigate_to_link requires a url");
        const tree = observationTree(context.observation);
        const element = findAccessibleElement(tree, ADDRESS_BAR_PATTERNS);
        if (!element) throw new Error("Safari's address bar was not accessible");
        const point = normalizedCenter(tree, element);
        await authorize();
        await device.tap(point.x, point.y);
        // No dedicated WDA "submit"/"press return" primitive exists in this
        // codebase (wdaDevice.js's typeText() sends literal characters) — a
        // trailing newline is XCUITest's own documented way to trigger the
        // keyboard's "Go" action for a text field. Unverified on a real
        // device; see the module comment.
        await authorize();
        await device.typeText(`${context.url}\n`);
        return { kind: "navigate", url: context.url };
      }
      if (action === "confirm_download") {
        const tree = observationTree(context.observation);
        const element = findAccessibleElement(tree, DOWNLOAD_BUTTON_PATTERNS, candidate => {
          const role = normalizeUiText(candidate.raw?.type ?? candidate.raw?.role);
          return role.includes("button") || candidate.text.includes("button");
        });
        if (!element) throw new Error("Safari's Download confirmation button was not accessible");
        const point = normalizedCenter(tree, element);
        await authorize();
        await device.tap(point.x, point.y);
        return { kind: "tap", target: "download_confirmation", ...point };
      }
      if (action === "wait_for_download") {
        // Purely passive — filePushOrchestrator.js's own loop is what
        // re-observes and re-checks state on a timer; this action has
        // nothing to do to the device itself.
        return { kind: "wait" };
      }
      if (action === "confirm_downloaded") {
        return { kind: "observation" };
      }
      throw new Error(`file-push skill does not support action "${action}"`);
    },

    async verify(action, observationAfter, context) {
      const afterState = await this.detectState(observationAfter);
      if (afterState === STATES.ERROR) return { outcome: "NEEDS_HUMAN", reason: "Safari reported an error after input" };
      if (action === "open_safari") return afterState === STATES.ADDRESS_BAR || afterState === STATES.DOWNLOAD_IN_PROGRESS;
      if (action === "navigate_to_link") {
        return afterState === STATES.DOWNLOAD_CONFIRMATION
          || afterState === STATES.DOWNLOAD_IN_PROGRESS || afterState === STATES.DOWNLOAD_COMPLETE;
      }
      if (action === "confirm_download") return afterState === STATES.DOWNLOAD_IN_PROGRESS || afterState === STATES.DOWNLOAD_COMPLETE;
      if (action === "wait_for_download") return afterState === STATES.DOWNLOAD_COMPLETE;
      if (action === "confirm_downloaded") return afterState === STATES.DOWNLOAD_COMPLETE;
      return false;
    },

    async recover(error, context) {
      const reason = `file-push recovery requested (${operationalErrorKind(error)})`;
      if (typeof context?.device?.pressHome !== "function") return { recovered: false, reason };
      await context.authorize?.();
      await context.device.pressHome();
      return { recovered: true, destination: STATES.SPRINGBOARD, reason };
    },
  };
}

export { STATES as FILE_PUSH_STATES };
