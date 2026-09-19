import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommentLedger, checkComment, normalizeComment, similarity } from "../../src/commentGuard.js";
import { ApprovalStore, APPROVAL_STATES, ApprovalError, approvalFingerprint } from "../../src/approvalStore.js";
import { PolicyStore } from "../../src/policyStore.js";
import { TemplateLibrary } from "../../src/commentTemplates.js";
import { POLICY_VALUES } from "../../src/actionPolicy.js";

const tempFile = name => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-safety-")), name);
const clock = (start = 1_000_000_000) => { let now = start; return { now: () => now, advance: ms => { now += ms; } }; };
const base = { workspaceId: "ws", accountId: "acct", source: "generated", contentKey: "post-1",
  groundingText: "Sunrise over the harbour with fishing boats returning" };

// ---- comment guard -------------------------------------------------------------

test("normalisation ignores case, punctuation, accents and links", () => {
  assert.equal(normalizeComment("  Wow!!! Beautiful, sunrise… https://x.co/abc "), "wow beautiful sunrise");
  assert.equal(normalizeComment("Café  CRÈME"), "cafe creme");
});

test("similarity: identical = 1, unrelated = 0, small edits stay high", () => {
  assert.equal(similarity("love this sunrise over the harbour", "Love this sunrise over the harbour!"), 1);
  assert.equal(similarity("love this sunrise", "totally different words here"), 0);
  assert.ok(similarity("what a lovely sunrise over the harbour today", "what a lovely sunrise over the harbour") > 0.8);
});

test("a fresh, grounded comment passes", () => {
  const ledger = new CommentLedger();
  assert.deepEqual(checkComment({ ...base, ledger, text: "That harbour sunrise is stunning" }), { ok: true, reasons: [] });
});

test("an exact repeat by the same account is refused, even with different punctuation", () => {
  const ledger = new CommentLedger();
  ledger.record({ ...base, text: "That harbour sunrise is stunning", contentKey: "post-0", platform: "instagram" });
  const result = checkComment({ ...base, ledger, text: "that harbour sunrise is stunning!!!" });
  assert.ok(result.reasons.includes("duplicate_exact"));
});

test("a near-duplicate is refused; another account is unaffected", () => {
  const ledger = new CommentLedger();
  ledger.record({ ...base, text: "What a lovely sunrise over the harbour today", contentKey: "post-0", platform: "instagram" });
  assert.ok(checkComment({ ...base, ledger, text: "What a lovely sunrise over the harbour" }).reasons.includes("duplicate_near"));
  assert.equal(checkComment({ ...base, accountId: "someone-else", ledger, text: "What a lovely sunrise over the harbour today" }).ok, true);
});

test("the duplicate window ends: an old comment no longer blocks the same wording", () => {
  const time = clock();
  const ledger = new CommentLedger({ now: time.now });
  ledger.record({ ...base, text: "That harbour sunrise is stunning", contentKey: "old", platform: "instagram" });
  time.advance(8 * 24 * 3_600_000);
  assert.equal(checkComment({ ...base, ledger, text: "That harbour sunrise is stunning" }).ok, true);
});

test("one comment per piece of content", () => {
  const ledger = new CommentLedger();
  ledger.record({ ...base, text: "Nice boats", platform: "instagram" });
  assert.ok(checkComment({ ...base, ledger, text: "Gorgeous harbour light" }).reasons.includes("already_commented"));
});

test("hourly and daily caps apply per account", () => {
  const time = clock();
  const ledger = new CommentLedger({ now: time.now });
  for (let index = 0; index < 6; index += 1) ledger.record({ ...base, contentKey: `p${index}`, text: `unique words ${index} alpha beta gamma delta`, platform: "instagram" });
  const blocked = checkComment({ ...base, contentKey: "new", ledger, text: "harbour boats returning nicely" });
  assert.ok(blocked.reasons.includes("rate_limited"));
  time.advance(61 * 60_000);
  assert.equal(checkComment({ ...base, contentKey: "new", ledger, text: "harbour boats returning nicely" }).ok, true);
});

test("a generated comment must be about the content; a link that is not in the content is refused", () => {
  assert.ok(checkComment({ ...base, text: "Great content, keep it up my friend" }).reasons.includes("not_grounded"));
  assert.ok(checkComment({ ...base, text: "Harbour boats! see https://spam.example/x" }).reasons.includes("unexpected_link"));
  assert.equal(checkComment({ ...base, groundingText: "Recipe at https://ok.example/r for a fresh harbour salad", text: "Harbour salad recipe https://ok.example/r looks lovely" }).ok, true);
});

test("a preset must match an approved template exactly; empty or oversize text is refused", () => {
  const template = { id: "t1", text: "Thanks for sharing this!" };
  assert.equal(checkComment({ ...base, source: "preset", template, text: "thanks for sharing this" }).ok, true, "case and punctuation do not matter");
  assert.ok(checkComment({ ...base, source: "preset", template, text: "Thanks for sharing this, friend!" }).reasons.includes("unknown_template"));
  assert.ok(checkComment({ ...base, source: "preset", template: null, text: "Thanks for sharing this!" }).reasons.includes("unknown_template"));
  assert.deepEqual(checkComment({ ...base, text: "   " }).reasons, ["empty"]);
  assert.ok(checkComment({ ...base, text: "harbour ".repeat(100) }).reasons.includes("too_long"));
});

test("the ledger keeps the comment exactly as sent and survives a restart", () => {
  const file = tempFile("comments.json");
  new CommentLedger({ filePath: file }).record({ ...base, text: "  Exactly As Sent!!  ", platform: "instagram" });
  const reloaded = new CommentLedger({ filePath: file });
  assert.equal(reloaded.forAccount("ws", "acct")[0].text, "  Exactly As Sent!!  ");
});

// ---- approval gate ----------------------------------------------------------------

const ask = { workspaceId: "ws", accountId: "acct", action: "comment_generated", target: "https://x.example/p/1", commentText: "Lovely harbour sunrise", requestedBy: "va1" };

test("approval state machine: request -> approve -> consumed exactly once", () => {
  const time = clock();
  const store = new ApprovalStore({ now: time.now });
  const approval = store.request(ask);
  assert.equal(approval.state, APPROVAL_STATES.PENDING);
  assert.equal(store.findApproved(ask), null, "nothing runs while pending");
  store.decide(approval.id, { decision: "approve", decidedBy: "boss" });
  assert.equal(store.findApproved(ask).id, approval.id);
  assert.equal(store.consume(approval.id).state, APPROVAL_STATES.CONSUMED);
  assert.equal(store.findApproved(ask), null, "single use");
  assert.equal(store.consume(approval.id), null);
});

test("an approval covers exactly the approved wording, target and account", () => {
  const store = new ApprovalStore();
  const approval = store.request(ask);
  store.decide(approval.id, { decision: "approve", decidedBy: "boss" });
  for (const changed of [{ commentText: "Something else entirely" }, { target: "https://x.example/p/2" }, { accountId: "other" }, { action: "comment_preset" }]) {
    assert.equal(store.findApproved({ ...ask, ...changed }), null, JSON.stringify(changed));
  }
  assert.equal(store.findApproved({ ...ask, commentText: "lovely harbour SUNRISE!" }).id, approval.id, "trivial formatting is the same comment");
});

test("asking twice returns the same open request; rejected and decided requests cannot be re-decided", () => {
  const store = new ApprovalStore();
  const first = store.request(ask);
  assert.equal(store.request(ask).id, first.id);
  store.decide(first.id, { decision: "reject", decidedBy: "boss", reason: "off-brand" });
  assert.throws(() => store.decide(first.id, { decision: "approve", decidedBy: "boss" }), error => error instanceof ApprovalError && error.code === "not_pending");
  assert.notEqual(store.request(ask).id, first.id, "after a rejection a new request may be made");
  assert.throws(() => store.decide("apr-none", { decision: "approve" }), /Unknown/);
});

test("approvals expire, both before a decision and after one that was never used", () => {
  const time = clock();
  const store = new ApprovalStore({ now: time.now, ttlMs: 1000 });
  const pending = store.request(ask);
  time.advance(1500);
  assert.equal(store.get(pending.id).state, APPROVAL_STATES.EXPIRED);
  assert.throws(() => store.decide(pending.id, { decision: "approve" }), /expired/);

  const second = store.request(ask);
  store.decide(second.id, { decision: "approve", decidedBy: "boss" });
  time.advance(1500);
  assert.equal(store.findApproved(ask), null, "an unused approval does not stay valid forever");
});

test("approvals persist across a restart", () => {
  const file = tempFile("approvals.json");
  const first = new ApprovalStore({ filePath: file });
  const approval = first.request(ask);
  first.decide(approval.id, { decision: "approve", decidedBy: "boss" });
  assert.equal(new ApprovalStore({ filePath: file }).findApproved(ask).id, approval.id);
  assert.equal(approvalFingerprint(ask), approvalFingerprint({ ...ask, commentText: "LOVELY harbour sunrise!!" }));
});

// ---- policy overrides & templates -------------------------------------------------

test("runtime policy overrides layer on top of the configured policy, never the other way round", () => {
  const configured = new Map([["acct", { like: POLICY_VALUES.ALLOW_AUTONOMOUS, comment_generated: POLICY_VALUES.REQUIRE_APPROVAL }]]);
  const store = new PolicyStore({ now: () => "t" });
  store.set("acct", "like", POLICY_VALUES.DISABLED, "admin");
  const effective = store.effective(configured);
  assert.equal(effective.get("acct").like, POLICY_VALUES.DISABLED);
  assert.equal(effective.get("acct").comment_generated, POLICY_VALUES.REQUIRE_APPROVAL);
  assert.equal(configured.get("acct").like, POLICY_VALUES.ALLOW_AUTONOMOUS, "the configured map is untouched");
  const described = store.describe("acct", configured);
  assert.deepEqual(described.find(item => item.action === "like"), { action: "like", policy: "DISABLED", source: "runtime", changedBy: "admin" });
  assert.equal(described.find(item => item.action === "repost").policy, "DISABLED");
  store.clear("acct", "like");
  assert.equal(store.effective(configured).get("acct").like, POLICY_VALUES.ALLOW_AUTONOMOUS);
});

test("policy overrides reject unknown actions and values, and a corrupt file only ever restricts", () => {
  const store = new PolicyStore();
  assert.throws(() => store.set("acct", "launch_rocket", POLICY_VALUES.DISABLED), /unknown action/);
  assert.throws(() => store.set("acct", "like", "SOMETIMES"), /policy must be/);
  const file = tempFile("policy.json");
  fs.writeFileSync(file, JSON.stringify({ overrides: { acct: { like: { value: "GARBAGE" }, nonsense: { value: "ALLOW_AUTONOMOUS" } } } }));
  const effective = new PolicyStore({ filePath: file }).effective(new Map());
  assert.deepEqual({ ...effective.get("acct") }, {}, "garbage values are ignored, not obeyed");
});

test("template library: add/list/remove, per workspace, no links, no duplicates", () => {
  const library = new TemplateLibrary({ filePath: tempFile("templates.json") });
  const template = library.add({ workspaceId: "ws", text: "Thanks for sharing!", tags: ["Generic", "generic"], createdBy: "boss" });
  assert.deepEqual(template.tags, ["generic"]);
  assert.equal(library.list("ws").length, 1);
  assert.equal(library.list("other").length, 0, "no leakage across workspaces");
  assert.equal(library.get("other", template.id), null);
  assert.throws(() => library.add({ workspaceId: "ws", text: "thanks for sharing!" }), /already exists/);
  assert.throws(() => library.add({ workspaceId: "ws", text: "see https://x.example" }), /link/);
  assert.throws(() => library.add({ workspaceId: "ws", text: "" }), /1 to/);
  assert.equal(library.remove("other", template.id), false);
  assert.equal(library.remove("ws", template.id), true);
});
