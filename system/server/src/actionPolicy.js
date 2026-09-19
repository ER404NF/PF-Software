import { assertValidStructuredDecision } from "./modelProvider.js";
import {
  ACTIONS, READ_ONLY_ACTIONS, MARKER_ACTIONS, REACTION_ACTIONS, COMMENT_ACTIONS,
  PLATFORM_VISIBLE_ACTIONS, isCommentAction, isPlatformVisible,
} from "./actionCatalog.js";

export const POLICY_VALUES = Object.freeze({
  ALLOW_AUTONOMOUS: "ALLOW_AUTONOMOUS",
  REQUIRE_APPROVAL: "REQUIRE_APPROVAL",
  DISABLED: "DISABLED",
});

export { ACTIONS, MARKER_ACTIONS, REACTION_ACTIONS, COMMENT_ACTIONS, PLATFORM_VISIBLE_ACTIONS };

// Kept for callers that mean "the actions that touch nothing on the platform".
export const MS8_READ_ONLY_ACTIONS = READ_ONLY_ACTIONS;

const ACTION_SET = new Set(ACTIONS);
const READ_ONLY_SET = new Set(READ_ONLY_ACTIONS);
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

// The single gate every action passes before it can reach the Device API.
//
//  - the account must belong to the workspace;
//  - the action must be known and allowed by the task;
//  - anything visible on the platform needs (a) a research record for the content it
//    is about, made BEFORE acting ("a platform action is never the only memory of why
//    content was selected") and (b) for comments, the exact text;
//  - the account's policy for that action decides: ALLOW_AUTONOMOUS, DISABLED (the
//    default for anything unset), or REQUIRE_APPROVAL, which only becomes allowed when
//    a human has approved exactly this action, target and wording.
export function validateAction({
  decision,
  workspaceId,
  accountId,
  accountWorkspaces,
  accountPolicies,
  allowedActions = [],
  hasResearchRecord = () => true,
  approvals = null,
} = {}) {
  assertValidStructuredDecision(decision, "action validator");
  const action = decision.action;
  const deny = (reason, code = "DENIED") => ({ outcome: "DENIED", action, policy: POLICY_VALUES.DISABLED, reason, code });
  const configuredWorkspace = accountWorkspaces?.get(accountId);
  if (!configuredWorkspace || configuredWorkspace !== workspaceId) return deny("account does not belong to this workspace");
  if (!ACTION_SET.has(action)) return deny("unknown action");
  if (!Array.isArray(allowedActions)) return deny("task action allow-list is malformed");
  if (allowedActions.length && !allowedActions.includes(action)) return deny("task does not allow this action");

  const visible = isPlatformVisible(action);
  if (visible) {
    if (typeof decision.target !== "string" || !decision.target.trim()) return deny("the action needs a target identifying the content");
    if (!hasResearchRecord(decision.target)) return deny("no research record exists for this content yet; record it before acting on it", "NO_RECORD");
    if (isCommentAction(action) && !decision.comment?.text) return deny("a comment action needs the comment text");
  }

  const policy = accountPolicies?.get(accountId)?.[action] ?? POLICY_VALUES.DISABLED;
  if (policy === POLICY_VALUES.ALLOW_AUTONOMOUS) return { outcome: "ALLOWED", action, policy, reason: null, platformVisible: visible };
  if (policy === POLICY_VALUES.REQUIRE_APPROVAL) {
    const approved = visible && approvals?.findApproved?.({
      workspaceId, accountId, action, target: decision.target, commentText: decision.comment?.text ?? null,
    });
    if (approved) return { outcome: "ALLOWED", action, policy, reason: null, platformVisible: true, approvalId: approved.id };
    return { outcome: "REQUIRES_APPROVAL", action, policy, reason: "explicit approval is required before execution", platformVisible: visible };
  }
  return deny("action is disabled or has no configured policy");
}

export { READ_ONLY_SET };
