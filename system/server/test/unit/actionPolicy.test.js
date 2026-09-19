import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMENT_ACTIONS, MS8_READ_ONLY_ACTIONS, PLATFORM_VISIBLE_ACTIONS, POLICY_VALUES, parseActionPolicies, validateAction } from "../../src/actionPolicy.js";

const accounts = new Map([["account-a", "client-a"]]);
const decision = (action) => ({ screen_state: "feed", goal_progress: "working", action, target: null, reason: "next step", confidence: 0.9 });
function validate(action, value, overrides = {}) {
  const policies = new Map([["account-a", Object.assign(Object.create(null), { [action]: value })]]);
  return validateAction({ decision: decision(action), workspaceId: "client-a", accountId: "account-a",
    accountWorkspaces: accounts, accountPolicies: policies, ...overrides });
}

for (const action of MS8_READ_ONLY_ACTIONS) {
  test(`${action}: all three policy outcomes are enforced`, () => {
    assert.equal(validate(action, POLICY_VALUES.ALLOW_AUTONOMOUS).outcome, "ALLOWED");
    assert.equal(validate(action, POLICY_VALUES.REQUIRE_APPROVAL).outcome, "REQUIRES_APPROVAL");
    assert.equal(validate(action, POLICY_VALUES.DISABLED).outcome, "DENIED");
  });
}

const visible = (action, extra = {}) => ({ ...decision(action), target: "https://x.example/p/1", ...extra });
const comment = { text: "Lovely harbour sunrise", source: "generated" };
function validateVisible(action, value, { approvals = null, hasResearchRecord, extra = {} } = {}) {
  const policies = new Map([["account-a", Object.assign(Object.create(null), { [action]: value })]]);
  return validateAction({ decision: visible(action, extra), workspaceId: "client-a", accountId: "account-a",
    accountWorkspaces: accounts, accountPolicies: policies, approvals, hasResearchRecord });
}

test("every platform-visible action is DISABLED unless its own policy says otherwise", () => {
  for (const action of PLATFORM_VISIBLE_ACTIONS) {
    const extra = COMMENT_ACTIONS.includes(action) ? { comment } : {};
    assert.equal(validateAction({ decision: visible(action, extra), workspaceId: "client-a", accountId: "account-a",
      accountWorkspaces: accounts, accountPolicies: new Map() }).outcome, "DENIED", `${action} with no policy`);
    assert.equal(validateVisible(action, POLICY_VALUES.DISABLED, { extra }).outcome, "DENIED", `${action} disabled`);
    assert.equal(validateVisible(action, POLICY_VALUES.ALLOW_AUTONOMOUS, { extra }).outcome, "ALLOWED", `${action} allowed`);
    assert.equal(validateVisible(action, POLICY_VALUES.REQUIRE_APPROVAL, { extra }).outcome, "REQUIRES_APPROVAL", `${action} needs approval`);
  }
});

test("one action's policy never enables another (allowing like does not allow comments)", () => {
  const policies = new Map([["account-a", Object.assign(Object.create(null), { like: POLICY_VALUES.ALLOW_AUTONOMOUS })]]);
  const result = validateAction({ decision: visible("comment_generated", { comment }), workspaceId: "client-a", accountId: "account-a",
    accountWorkspaces: accounts, accountPolicies: policies });
  assert.equal(result.outcome, "DENIED");
});

test("a platform action is refused until the content has a research record (record before acting)", () => {
  const blocked = validateVisible("platform_save", POLICY_VALUES.ALLOW_AUTONOMOUS, { hasResearchRecord: () => false });
  assert.equal(blocked.outcome, "DENIED");
  assert.match(blocked.reason, /research record/);
  const untargeted = validateAction({ decision: decision("like"), workspaceId: "client-a", accountId: "account-a", accountWorkspaces: accounts,
    accountPolicies: new Map([["account-a", { like: POLICY_VALUES.ALLOW_AUTONOMOUS }]]) });
  assert.match(untargeted.reason, /needs a target/);
  assert.equal(validateVisible("platform_save", POLICY_VALUES.ALLOW_AUTONOMOUS, { hasResearchRecord: target => target === "https://x.example/p/1" }).outcome, "ALLOWED");
});

test("a comment action needs its text; observation actions need no target or record", () => {
  // The schema rejects a comment action with no comment before the validator even runs.
  assert.throws(() => validateVisible("comment_generated", POLICY_VALUES.ALLOW_AUTONOMOUS), /requires a "comment"/);
  assert.equal(validate("observe", POLICY_VALUES.ALLOW_AUTONOMOUS, { hasResearchRecord: () => false }).outcome, "ALLOWED");
});

test("REQUIRE_APPROVAL becomes ALLOWED only for an approval of exactly this action, target and wording", () => {
  const seen = [];
  const approvals = { findApproved: subject => { seen.push(subject); return subject.commentText === comment.text ? { id: "apr-1" } : null; } };
  const allowed = validateVisible("comment_generated", POLICY_VALUES.REQUIRE_APPROVAL, { approvals, extra: { comment } });
  assert.equal(allowed.outcome, "ALLOWED");
  assert.equal(allowed.approvalId, "apr-1");
  assert.deepEqual(seen[0], { workspaceId: "client-a", accountId: "account-a", action: "comment_generated", target: "https://x.example/p/1", commentText: comment.text });
  const changed = validateVisible("comment_generated", POLICY_VALUES.REQUIRE_APPROVAL, { approvals, extra: { comment: { ...comment, text: "Something else" } } });
  assert.equal(changed.outcome, "REQUIRES_APPROVAL", "a different wording is not covered by the approval");
  assert.equal(validateVisible("comment_generated", POLICY_VALUES.DISABLED, { approvals, extra: { comment } }).outcome, "DENIED", "an approval cannot override DISABLED");
});

test("missing policy, wrong workspace and task-level restrictions fail closed", () => {
  assert.equal(validateAction({ decision: decision("observe"), workspaceId: "client-a", accountId: "account-a",
    accountWorkspaces: accounts, accountPolicies: new Map() }).outcome, "DENIED");
  assert.equal(validate("observe", POLICY_VALUES.ALLOW_AUTONOMOUS, { workspaceId: "client-b" }).outcome, "DENIED");
  assert.equal(validate("observe", POLICY_VALUES.ALLOW_AUTONOMOUS, { allowedActions: ["copy_link"] }).outcome, "DENIED");
});

test("malformed decisions are rejected before policy evaluation", () => {
  assert.throws(() => validateAction({ decision: { action: "observe" } }), /missing required string field/);
  const unknown = validateAction({ decision: decision("invented_action"), workspaceId: "client-a", accountId: "account-a",
    accountWorkspaces: accounts, accountPolicies: new Map() });
  assert.equal(unknown.outcome, "DENIED");
  assert.equal(unknown.reason, "unknown action");
});

test("policy configuration rejects unknown actions and invalid values", () => {
  assert.throws(() => parseActionPolicies({ accounts: [{ id: "a", actionPolicy: { magic: "ALLOW_AUTONOMOUS" } }] }), /unknown action/);
  assert.throws(() => parseActionPolicies({ accounts: [{ id: "a", actionPolicy: { observe: "YES" } }] }), /invalid policy value/);
  const parsed = parseActionPolicies({ accounts: [{ id: "a", actionPolicy: { observe: "ALLOW_AUTONOMOUS" } }] });
  assert.equal(parsed.get("a").observe, "ALLOW_AUTONOMOUS");
});

test("the decision schema demands the exact comment for comment actions and forbids it elsewhere", () => {
  const ok = { ...decision("comment_generated"), target: "https://x.example/p/1", comment: { text: "Lovely harbour", source: "generated" } };
  assert.doesNotThrow(() => validateAction({ decision: ok, workspaceId: "client-a", accountId: "account-a", accountWorkspaces: accounts, accountPolicies: new Map() }));
  const bad = (change, pattern) => assert.throws(() => validateAction({ decision: { ...ok, ...change }, workspaceId: "client-a", accountId: "account-a", accountWorkspaces: accounts, accountPolicies: new Map() }), pattern);
  bad({ comment: undefined }, /requires a "comment"/);
  bad({ comment: { text: "", source: "generated" } }, /non-empty/);
  bad({ comment: { text: "hi", source: "magic" } }, /"preset" or "generated"/);
  bad({ comment: { text: "hi", source: "preset", template_id: "" } }, /template_id/);
  bad({ action: "like" }, /only valid for comment/);
});
