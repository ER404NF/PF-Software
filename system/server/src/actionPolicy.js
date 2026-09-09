import { assertValidStructuredDecision } from "./modelProvider.js";

export const POLICY_VALUES = Object.freeze({
  ALLOW_AUTONOMOUS: "ALLOW_AUTONOMOUS",
  REQUIRE_APPROVAL: "REQUIRE_APPROVAL",
  DISABLED: "DISABLED",
});

export const ACTIONS = Object.freeze([
  "observe", "open_feed", "search", "open_post", "open_profile", "open_thread", "scroll_next",
  "scroll_previous", "open_comments", "capture", "capture_screenshot", "copy_link", "extract_visible",
  "platform_save", "platform_unsave", "like", "unlike", "upvote", "downvote", "clear_vote", "repost",
  "undo_repost", "comment_preset", "comment_generated", "reply_preset", "reply_generated",
]);

// MS8 deliberately permits only observation/navigation actions. A future
// config cannot accidentally promote MS9/MS10 actions before their execution,
// verification, audit and approval paths exist.
export const MS8_READ_ONLY_ACTIONS = Object.freeze([
  "observe", "open_feed", "search", "open_post", "open_profile", "open_thread", "scroll_next",
  "scroll_previous", "open_comments", "capture", "capture_screenshot", "copy_link", "extract_visible",
]);

const ACTION_SET = new Set(ACTIONS);
const MS8_READ_ONLY_ACTION_SET = new Set(MS8_READ_ONLY_ACTIONS);
const POLICY_SET = new Set(Object.values(POLICY_VALUES));

export function parseActionPolicies(config) {
  const policies = new Map();
  for (const account of config?.accounts || []) {
    const parsed = Object.create(null);
    for (const [action, value] of Object.entries(account.actionPolicy || {})) {
      if (!ACTION_SET.has(action)) throw new Error(`unknown action policy key "${action}" for account "${account.id}"`);
      if (!POLICY_SET.has(value)) throw new Error(`invalid policy value "${value}" for ${account.id}.${action}`);
      parsed[action] = value;
    }
    policies.set(account.id, parsed);
  }
  return policies;
}

export function validateAction({
  decision,
  workspaceId,
  accountId,
  accountWorkspaces,
  accountPolicies,
  allowedActions = [],
} = {}) {
  assertValidStructuredDecision(decision, "action validator");
  const action = decision.action;
  const configuredWorkspace = accountWorkspaces?.get(accountId);
  if (!configuredWorkspace || configuredWorkspace !== workspaceId) {
    return { outcome: "DENIED", action, policy: POLICY_VALUES.DISABLED, reason: "account does not belong to this workspace" };
  }
  if (!ACTION_SET.has(action)) {
    return { outcome: "DENIED", action, policy: POLICY_VALUES.DISABLED, reason: "unknown action" };
  }
  if (!MS8_READ_ONLY_ACTION_SET.has(action)) {
    return { outcome: "DENIED", action, policy: POLICY_VALUES.DISABLED, reason: "action is not enabled in read-only research mode" };
  }
  if (!Array.isArray(allowedActions)) {
    return { outcome: "DENIED", action, policy: POLICY_VALUES.DISABLED, reason: "task action allow-list is malformed" };
  }
  if (allowedActions.length && !allowedActions.includes(action)) {
    return { outcome: "DENIED", action, policy: POLICY_VALUES.DISABLED, reason: "task does not allow this action" };
  }

  const policy = accountPolicies?.get(accountId)?.[action] ?? POLICY_VALUES.DISABLED;
  if (policy === POLICY_VALUES.ALLOW_AUTONOMOUS) return { outcome: "ALLOWED", action, policy, reason: null };
  if (policy === POLICY_VALUES.REQUIRE_APPROVAL) {
    return { outcome: "REQUIRES_APPROVAL", action, policy, reason: "explicit approval is required before execution" };
  }
  return { outcome: "DENIED", action, policy: POLICY_VALUES.DISABLED, reason: "action is disabled or has no configured policy" };
}
