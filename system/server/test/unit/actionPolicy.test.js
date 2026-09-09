import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, MS8_READ_ONLY_ACTIONS, POLICY_VALUES, parseActionPolicies, validateAction } from "../../src/actionPolicy.js";

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

test("every known platform-visible action remains denied during read-only MS8 even if config says allow", () => {
  for (const action of ACTIONS.filter((item) => !MS8_READ_ONLY_ACTIONS.includes(item))) {
    const result = validate(action, POLICY_VALUES.ALLOW_AUTONOMOUS);
    assert.equal(result.outcome, "DENIED", action);
    assert.match(result.reason, /read-only research mode/);
  }
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
