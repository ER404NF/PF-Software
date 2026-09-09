import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-research-unit-"));
process.env.RESEARCH_STORE_DIR = root;
const store = await import("../../src/researchStore.js");
const { safeAccountId } = store;
const createRun = (...args) => store.createRun("workspace-a", ...args);
const getRun = (...args) => store.getRun("workspace-a", ...args);
const listRuns = (...args) => store.listRuns("workspace-a", ...args);
const setCandidateStatus = (...args) => store.setCandidateStatus("workspace-a", ...args);
const appendCandidate = (...args) => store.appendCandidate("workspace-a", ...args);
const finalizeRun = (...args) => store.finalizeRun("workspace-a", ...args);

// Uses a dedicated, disposable account so this never touches a real
// account's research history. Cleaned up in `after` regardless of outcome.
const TEST_ACCOUNT = `test-account-${Date.now()}`;

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("safeAccountId accepts alphanumeric/dash/underscore ids", () => {
  assert.equal(safeAccountId("client-a"), "client-a");
});

test("safeAccountId rejects traversal and unsafe characters", () => {
  assert.equal(safeAccountId("../etc"), null);
  assert.equal(safeAccountId("client a"), null);
  assert.equal(safeAccountId(""), null);
});

test("listRuns returns null for an invalid account instead of an empty list", () => {
  assert.equal(listRuns("../etc"), null);
});

test("createRun stores candidates with a pending status", () => {
  const run = createRun(TEST_ACCOUNT, {
    platform: "instagram",
    timeWindow: "09:00-10:00",
    overview: "Test run",
    candidates: [{ url: "https://example.com/p/1", sourceHandle: "@x", niche: "ai" }],
  });
  assert.ok(run.id.startsWith("run-"));
  assert.equal(run.candidates.length, 1);
  assert.equal(run.candidates[0].status, "pending");
  assert.equal(run.candidates[0].url, "https://example.com/p/1");

  const fetched = getRun(TEST_ACCOUNT, run.id);
  assert.deepEqual(fetched, run);
  assert.deepEqual(listRuns(TEST_ACCOUNT).map((r) => r.id), [run.id]);
});

test("appendCandidate adds and merges durable discoveries into an existing run", () => {
  const run = createRun("append", { platform: "instagram", overview: "live", candidates: [] });
  const first = appendCandidate("append", run.id, { platform_content_id: "post-1",
    canonical_url: "https://example.com/post-1", evidence_refs: ["capture-1"], tags: ["hook"] });
  const merged = appendCandidate("append", run.id, { platform_content_id: "post-1",
    canonical_url: "https://example.com/post-1", evidence_refs: ["capture-2"], tags: ["format"] });
  assert.equal(first.id, merged.id);
  assert.deepEqual(merged.evidence_refs, ["capture-1", "capture-2"]);
  assert.deepEqual(merged.tags, ["hook", "format"]);
  assert.equal(getRun("append", run.id).candidates.length, 1);
  assert.equal(appendCandidate("append", "missing-run", { platform_content_id: "x" }), null);
});

test("finalizeRun replaces the provisional overview and records completion", () => {
  const run = createRun("finalize", { platform: "reddit", overview: "first finding", candidates: [] });
  const finalized = finalizeRun("finalize", run.id, { overview: "Three useful themes found", outcome: "SUCCEEDED" });
  assert.equal(finalized.overview, "Three useful themes found");
  assert.equal(finalized.outcome, "SUCCEEDED");
  assert.ok(Number.isFinite(new Date(finalized.completedAt).getTime()));
  assert.deepEqual(getRun("finalize", run.id), finalized);
  assert.equal(finalizeRun("finalize", "missing", { overview: "x" }), null);
  assert.equal(finalizeRun("finalize", run.id, { overview: " " }), null);
});

test("createRun tolerates a malformed candidate instead of throwing", () => {
  const run = createRun(TEST_ACCOUNT, {
    platform: "reddit",
    overview: "Malformed candidate test",
    candidates: [null, "not-an-object", { url: "https://example.com/p/2" }],
  });
  assert.equal(run.candidates.length, 3);
  for (const c of run.candidates) {
    assert.equal(c.status, "pending");
    assert.equal(typeof c.metrics, "object");
  }
});

test("setCandidateStatus only accepts confirmed/removed", () => {
  const run = createRun(TEST_ACCOUNT, {
    platform: "x",
    overview: "Status whitelist test",
    candidates: [{ url: "https://example.com/p/3" }],
  });
  const candidateId = run.candidates[0].id;

  assert.equal(setCandidateStatus(TEST_ACCOUNT, run.id, candidateId, "approved"), null);
  assert.equal(setCandidateStatus(TEST_ACCOUNT, run.id, candidateId, "pending"), null);

  const confirmed = setCandidateStatus(TEST_ACCOUNT, run.id, candidateId, "confirmed");
  assert.equal(confirmed.status, "confirmed");
});

test("setCandidateStatus returns null for an unknown run or candidate", () => {
  assert.equal(setCandidateStatus(TEST_ACCOUNT, "run-nope", "cand-nope", "confirmed"), null);
});

test("workspace storage isolates the same account ID and rejects unsafe workspace IDs", () => {
  const run = createRun("shared-id", { platform: "x", overview: "private", candidates: [{ url: "https://example.com" }] });
  assert.equal(run.workspaceId, "workspace-a");
  assert.deepEqual(store.listRuns("workspace-b", "shared-id"), []);
  assert.equal(store.getRun("workspace-b", "shared-id", run.id), null);
  assert.equal(store.setCandidateStatus("workspace-b", "shared-id", run.id, run.candidates[0].id, "removed"), null);
  assert.equal(store.listRuns("../escape", "shared-id"), null);
  assert.equal(store.createRun(null, "shared-id", {}), null);
});

test("legacy flat research files are never implicitly exposed", () => {
  fs.writeFileSync(path.join(root, "legacy.json"), JSON.stringify({ runs: [{ id: "private-old-run" }] }));
  assert.deepEqual(listRuns("legacy"), []);
  assert.ok(fs.existsSync(path.join(root, "legacy.json")));
});

test("failed replacement preserves the previous complete research file and cleans temporary output", () => {
  const run = createRun("atomic", { platform: "x", overview: "original", candidates: [{ url: "https://example.com/p" }] });
  const rename = mock.method(fs, "renameSync", () => { throw new Error("injected disk failure"); });
  try {
    assert.throws(() => setCandidateStatus("atomic", run.id, run.candidates[0].id, "removed"), /injected disk failure/);
  } finally { rename.mock.restore(); }
  assert.equal(getRun("atomic", run.id).candidates[0].status, "pending");
  assert.equal(fs.readdirSync(path.join(root, "workspace-a")).some((file) => file.endsWith(".tmp")), false);
});

test("atomic replacement retries transient Windows locks and eventually commits", () => {
  const run = createRun("atomic-retry", { platform: "x", overview: "original", candidates: [{ url: "https://example.com/retry" }] });
  const originalRename = fs.renameSync.bind(fs);
  let attempts = 0;
  const rename = mock.method(fs, "renameSync", (from, to) => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error("temporarily busy"), { code: "EBUSY" });
    return originalRename(from, to);
  });
  try {
    setCandidateStatus("atomic-retry", run.id, run.candidates[0].id, "confirmed");
  } finally { rename.mock.restore(); }
  assert.equal(attempts, 3);
  assert.equal(getRun("atomic-retry", run.id).candidates[0].review_state, "confirmed");
});

test("expanded candidates retain evidence and context, deduplicate within a run", () => {
  const payload = { platform: "instagram", overview: "research", candidates: [
    { url: "https://example.com/p#one", sourceHandle: "creator", evidence_refs: ["capture-1"], tags: ["hook"],
      platform_content_id: "post-1", ai_summary: "summary", selection_reason: "reason", score: 0.8,
      text_extract: "caption", device_id: "mock-1", task_id: "task-1", run_id: "forged", platform_account_id: "forged",
      platform_actions: [{ action: "save", status: "verified", observed_at: "2026-09-09T12:00:00Z" }] },
    { url: "https://example.com/p#two", evidence_refs: ["capture-2"], tags: ["hook", "format"] },
  ] };
  const run = createRun("expanded", payload);
  assert.equal(run.candidates.length, 1);
  const c = run.candidates[0];
  assert.deepEqual(c.evidence_refs, ["capture-1", "capture-2"]);
  assert.deepEqual(c.tags, ["hook", "format"]);
  assert.equal(c.run_id, run.id);
  assert.equal(c.platform_account_id, "expanded");
  assert.equal(c.ai_summary, "summary");
  assert.equal(c.platform_actions[0].action, "save");
  assert.equal(c.review_state, "pending");
  assert.equal(c.duplicate_of_run, null);
});

test("a later run re-observing the same post carries its review decision forward instead of resetting to pending", () => {
  const payload = { platform: "instagram", overview: "research",
    candidates: [{ url: "https://example.com/carry-forward", evidence_refs: ["capture-1"] }] };
  const first = createRun("carry-forward", payload);
  const c = first.candidates[0];
  assert.equal(setCandidateStatus("carry-forward", first.id, c.id, "confirmed").review_state, "confirmed");

  const second = createRun("carry-forward", payload);
  // A fresh row per run (its own audit-trail id), not a blocked/skipped
  // observation — but the review decision and original first-seen time are
  // inherited rather than reset, and it's marked as a repeat of the first run.
  assert.notEqual(second.candidates[0].id, c.id);
  assert.equal(second.candidates[0].review_state, "confirmed");
  assert.equal(second.candidates[0].status, "confirmed");
  assert.equal(second.candidates[0].first_seen_at, c.first_seen_at);
  assert.equal(second.candidates[0].duplicate_of_run, first.id);

  // A "removed" verdict is inherited too — not just "confirmed".
  const other = { platform: "x", overview: "research", candidates: [{ url: "https://example.com/removed-stays-removed" }] };
  const firstRemoved = createRun("carry-forward", other);
  setCandidateStatus("carry-forward", firstRemoved.id, firstRemoved.candidates[0].id, "removed");
  const secondRemoved = createRun("carry-forward", other);
  assert.equal(secondRemoved.candidates[0].review_state, "removed");
});

test("cross-run dedup also matches on platform_content_id when canonical_url differs between observations", () => {
  const account = "content-id-carry-forward";
  const first = createRun(account, { platform: "reddit", overview: "research",
    candidates: [{ url: "https://example.com/a", platform_content_id: "stable-id-1" }] });
  setCandidateStatus(account, first.id, first.candidates[0].id, "confirmed");

  // Same platform_content_id, but the URL moved/changed since the first observation.
  const second = createRun(account, { platform: "reddit", overview: "research",
    candidates: [{ url: "https://example.com/a-moved", platform_content_id: "stable-id-1" }] });
  assert.equal(second.candidates[0].review_state, "confirmed");
  assert.equal(second.candidates[0].duplicate_of_run, first.id);
});

test("cross-run content IDs are scoped by platform and prototype-like IDs are safe", () => {
  const account = "platform-scoped-content-id";
  const first = createRun(account, { platform: "instagram", overview: "one",
    candidates: [{ platform_content_id: "toString" }, { platform_content_id: "__proto__" }] });
  setCandidateStatus(account, first.id, first.candidates[0].id, "confirmed");
  setCandidateStatus(account, first.id, first.candidates[1].id, "removed");

  const otherPlatform = createRun(account, { platform: "reddit", overview: "two",
    candidates: [{ platform_content_id: "toString" }] });
  assert.equal(otherPlatform.candidates[0].review_state, "pending");

  const samePlatform = createRun(account, { platform: "instagram", overview: "three",
    candidates: [{ platform_content_id: "toString" }, { platform_content_id: "__proto__" }] });
  assert.equal(samePlatform.candidates[0].review_state, "confirmed");
  assert.equal(samePlatform.candidates[1].review_state, "removed");
});

test("storage uses the same canonical lowercase ID validation as authorization", () => {
  assert.equal(store.listRuns("Workspace-A", "valid"), null);
  assert.equal(store.listRuns("workspace-a", "Account-A"), null);
  assert.equal(store.listRuns("con", "valid"), null);
  assert.equal(store.listRuns("workspace-a", "nul"), null);
});

test("cross-run dedup index is additive: legacy files with no candidateIndex key still load and dedupe going forward", () => {
  const account = "legacy-shape";
  fs.writeFileSync(path.join(root, "workspace-a", `${account}.json`), JSON.stringify({ runs: [] }));
  const run = createRun(account, { platform: "x", overview: "research",
    candidates: [{ url: "https://example.com/legacy-file" }] });
  assert.equal(run.candidates.length, 1);
  assert.deepEqual(listRuns(account).map((r) => r.id), [run.id]);
});

test("unsafe links and malformed optional metadata never become trusted candidate fields", () => {
  const run = createRun("invalid-fields", { platform: "x", overview: "test", candidates: [{
    url: "javascript:alert(1)", tags: {}, evidence_refs: [null, "capture"], score: "high", platform_actions: [null, "like"],
  }] });
  assert.equal(run.candidates[0].canonical_url, null);
  assert.deepEqual(run.candidates[0].tags, []);
  assert.deepEqual(run.candidates[0].evidence_refs, ["capture"]);
  assert.deepEqual(run.candidates[0].platform_actions, []);
  assert.equal(run.candidates[0].score, null);
});
