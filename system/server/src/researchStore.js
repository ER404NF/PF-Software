// Storage for AI research findings (the /cresearch command's output — see
// docs/COMMAND_QUEUE_SPEC.md). One JSON file per workspace/account,
// holding a list of research "runs"; each run holds the
// AI's overview plus the reference candidates it found. Image bytes live in
// researchEvidenceStore; candidates carry protected evidence references.
//
// A VA reviews a run's candidates afterward and marks each one "confirmed"
// or "removed" — this is the private, reversible review step that replaced
// the original repost-then-undo design (see chat: repost is public the
// whole time it's live; this never is).

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { validResearchId } from "./researchId.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RESEARCH_ROOT = process.env.RESEARCH_STORE_DIR
  ? path.resolve(process.env.RESEARCH_STORE_DIR)
  : path.join(__dirname, "../../storage/research");

function safeAccountId(id) {
  return validResearchId(id) ? id : null;
}

function accountFile(workspaceId, account) {
  const safe = safeAccountId(account);
  if (!safe || !safeAccountId(workspaceId)) return null;
  return path.join(RESEARCH_ROOT, workspaceId, `${safe}.json`);
}

function readAccount(workspaceId, account) {
  const file = accountFile(workspaceId, account);
  if (!file || !fs.existsSync(file)) return { runs: [], candidateIndex: { byContentId: {}, byUrl: {} } };
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    runs: data.runs || [],
    // Older files predate cross-run dedup and simply won't have this key —
    // default to empty tables rather than treating that as an error.
    candidateIndex: {
      // These keys originate in platform data. Null-prototype dictionaries
      // make values such as "__proto__" and "toString" ordinary keys rather
      // than prototype access or mutation.
      byContentId: Object.assign(Object.create(null), data.candidateIndex?.byContentId || {}),
      byUrl: Object.assign(Object.create(null), data.candidateIndex?.byUrl || {}),
    },
  };
}

const replaceWaitArray = new Int32Array(new SharedArrayBuffer(4));
function replaceFileSync(temporary, file) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      // NTFS can briefly reject replacement while another read has the old
      // destination open. This store is synchronous already; a short bounded
      // wait preserves the old complete file and retries the atomic rename.
      if (!["EPERM", "EBUSY"].includes(error?.code) || attempt >= 10) throw error;
      Atomics.wait(replaceWaitArray, 0, 0, 5 * (attempt + 1));
    }
  }
}

function writeAccount(workspaceId, account, data) {
  const file = accountFile(workspaceId, account);
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: "wx" });
    replaceFileSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}

function text(value) { return typeof value === "string" ? value : null; }
function webUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}
function strings(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string" && item.trim()))] : [];
}

// Selection records describe observations; accepting an action record here
// does not execute or authorize any platform action.
// One platform-visible action mirrored into the research record (MS9.3/MS10). `text`
// is a comment exactly as it was sent.
function normalizePlatformAction(action) {
  return {
    action: action.action,
    status: text(action.status),
    text: text(action.text),
    observed_at: text(action.observed_at),
    task_id: text(action.task_id),
    approval_id: text(action.approval_id),
    source: text(action.source),
  };
}

function samePlatformAction(a, b) {
  return a.action === b.action && (a.text ?? null) === (b.text ?? null) && (a.task_id ?? null) === (b.task_id ?? null)
    && (a.status ?? null) === (b.status ?? null);
}

function candidateRecord(input, context) {
  const c = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const canonicalUrl = webUrl(c.canonical_url ?? c.url);
  return {
    id: `cand-${crypto.randomUUID()}`,
    platform: context.platform,
    platform_content_id: text(c.platform_content_id),
    canonical_url: canonicalUrl,
    url: canonicalUrl,
    source_handle: text(c.source_handle ?? c.sourceHandle),
    sourceHandle: text(c.source_handle ?? c.sourceHandle),
    niche: text(c.niche),
    metrics: c.metrics && typeof c.metrics === "object" && !Array.isArray(c.metrics) ? c.metrics : {},
    device_id: text(c.device_id),
    platform_account_id: context.account,
    workspaceId: context.workspaceId,
    first_seen_at: context.now,
    last_seen_at: context.now,
    evidence_refs: strings(c.evidence_refs),
    text_extract: text(c.text_extract),
    ai_summary: text(c.ai_summary),
    selection_reason: text(c.selection_reason),
    score: typeof c.score === "number" && Number.isFinite(c.score) ? c.score : null,
    tags: strings(c.tags),
    platform_actions: Array.isArray(c.platform_actions) ? c.platform_actions
      .filter((action) => action && typeof action === "object" && typeof action.action === "string")
      .map(normalizePlatformAction) : [],
    task_id: text(c.task_id),
    run_id: context.runId,
    // Set from candidateIndex in createRun when this identity was already
    // observed in a prior run; null for a genuinely first-time candidate.
    duplicate_of_run: null,
    status: "pending",
    review_state: "pending",
  };
}

// Cross-run dedup index: persisted alongside `runs` in each account's JSON
// file so the same real-world post isn't re-treated as a fresh "pending"
// candidate (and a VA's earlier review lost) just because a later run
// observes it again. Two lookup tables over the same logical entries — kept
// in sync on every write — so a match on either identifier carries the
// prior review_state/first_seen_at forward, mirroring the OR-based identity
// check the in-run merge above already uses (platform_content_id, else
// canonical_url).
function findIndexEntry(index, c) {
  const contentKey = c.platform_content_id ? `${c.platform}\u0000${c.platform_content_id}` : null;
  if (contentKey && index.byContentId[contentKey]) return index.byContentId[contentKey];
  if (c.canonical_url && index.byUrl[c.canonical_url]) return index.byUrl[c.canonical_url];
  return null;
}
function upsertIndexEntry(index, entry) {
  const prior = findIndexEntry(index, entry);
  entry = { ...prior, ...entry,
    platform_content_id: entry.platform_content_id ?? prior?.platform_content_id ?? null,
    canonical_url: entry.canonical_url ?? prior?.canonical_url ?? null };
  // JSON persistence duplicates objects. Repoint every known alias, rather
  // than relying on in-memory object identity to propagate a human review.
  for (const table of [index.byContentId, index.byUrl]) {
    for (const [key, value] of Object.entries(table)) {
      if ((entry.platform_content_id && value.platform === entry.platform && value.platform_content_id === entry.platform_content_id)
        || (entry.canonical_url && value.canonical_url === entry.canonical_url)) table[key] = entry;
    }
  }
  if (entry.platform_content_id) index.byContentId[`${entry.platform}\u0000${entry.platform_content_id}`] = entry;
  if (entry.canonical_url) index.byUrl[entry.canonical_url] = entry;
}

function mergeCandidate(duplicate, candidate) {
  duplicate.evidence_refs = [...new Set([...duplicate.evidence_refs, ...candidate.evidence_refs])];
  duplicate.tags = [...new Set([...duplicate.tags, ...candidate.tags])];
  for (const action of candidate.platform_actions) {
    if (!duplicate.platform_actions.some(existing => samePlatformAction(existing, action))) duplicate.platform_actions.push(action);
  }
  duplicate.last_seen_at = candidate.last_seen_at;
  if (Object.keys(candidate.metrics).length) duplicate.metrics = { ...candidate.metrics };
  for (const field of ["platform_content_id", "canonical_url", "url", "source_handle", "sourceHandle",
    "niche", "device_id", "text_extract", "ai_summary", "selection_reason", "score", "task_id"]) {
    if (duplicate[field] === null && candidate[field] !== null) duplicate[field] = candidate[field];
  }
  return duplicate;
}

function indexCandidate(index, candidate, runId, now) {
  const existing = findIndexEntry(index, candidate);
  // Observations may arrive for an older run after a newer human review.
  // Only setCandidateStatus can change an established shared decision.
  if (existing) {
    candidate.review_state = existing.review_state;
    candidate.status = existing.status;
  }
  upsertIndexEntry(index, {
    review_state: candidate.review_state,
    status: candidate.status,
    first_seen_at: existing ? existing.first_seen_at : candidate.first_seen_at,
    last_seen_at: now,
    runId,
    candidateId: candidate.id,
    platform: candidate.platform,
    platform_content_id: candidate.platform_content_id,
    canonical_url: candidate.canonical_url,
  });
}

export function listRuns(workspaceId, account) {
  if (!accountFile(workspaceId, account)) return null;
  return readAccount(workspaceId, account).runs;
}

export function getRun(workspaceId, account, runId) {
  if (!accountFile(workspaceId, account)) return null;
  return readAccount(workspaceId, account).runs.find((r) => r.id === runId) || null;
}

// candidates: [{ url, sourceHandle, niche, metrics }] — metrics is a free-form
// object since platforms differ (views/likes/comments vs. upvotes/comments).
export function createRun(workspaceId, account, { platform, timeWindow, overview, candidates }) {
  if (!accountFile(workspaceId, account)) return null;
  const data = readAccount(workspaceId, account);
  const now = new Date().toISOString();
  const run = {
    id: `run-${crypto.randomUUID()}`,
    account,
    workspaceId,
    platform,
    timeWindow,
    overview,
    createdAt: now,
    candidates: [],
  };
  const seenIds = new Map();
  const seenUrls = new Map();
  for (const input of candidates || []) {
    const c = candidateRecord(input, { platform, account, workspaceId, now, runId: run.id });
    const duplicate = (c.platform_content_id && seenIds.get(c.platform_content_id))
      || (c.canonical_url && seenUrls.get(c.canonical_url));
    if (duplicate) {
      mergeCandidate(duplicate, c);
      if (c.platform_content_id) seenIds.set(c.platform_content_id, duplicate);
      if (c.canonical_url) seenUrls.set(c.canonical_url, duplicate);
      continue;
    }
    // Cross-run: has this identity already been observed (and possibly
    // reviewed) in an earlier run for this account? If so this is a new
    // observation of an existing candidate, not a new candidate — carry its
    // review decision and original first-seen time forward instead of
    // resetting both to "a fresh pending item."
    const priorEntry = findIndexEntry(data.candidateIndex, c);
    if (priorEntry) {
      c.review_state = priorEntry.review_state;
      c.status = priorEntry.status;
      c.first_seen_at = priorEntry.first_seen_at;
      c.duplicate_of_run = priorEntry.runId !== run.id ? priorEntry.runId : null;
    }
    if (c.platform_content_id) seenIds.set(c.platform_content_id, c);
    if (c.canonical_url) seenUrls.set(c.canonical_url, c);
    run.candidates.push(c);
  }
  for (const c of run.candidates) {
    indexCandidate(data.candidateIndex, c, run.id, now);
  }
  data.runs.push(run);
  writeAccount(workspaceId, account, data);
  return run;
}

export function appendCandidate(workspaceId, account, runId, input) {
  if (!accountFile(workspaceId, account)) return null;
  const data = readAccount(workspaceId, account);
  const run = data.runs.find((candidateRun) => candidateRun.id === runId);
  if (!run) return null;
  const now = new Date().toISOString();
  const candidate = candidateRecord(input, { platform: run.platform, account, workspaceId, now, runId });
  const duplicate = run.candidates.find((existing) =>
    (candidate.platform_content_id && existing.platform_content_id === candidate.platform_content_id)
    || (candidate.canonical_url && existing.canonical_url === candidate.canonical_url));
  const recorded = duplicate ? mergeCandidate(duplicate, candidate) : candidate;
  if (!duplicate) {
    const priorEntry = findIndexEntry(data.candidateIndex, candidate);
    if (priorEntry) {
      candidate.review_state = priorEntry.review_state;
      candidate.status = priorEntry.status;
      candidate.first_seen_at = priorEntry.first_seen_at;
      candidate.duplicate_of_run = priorEntry.runId !== runId ? priorEntry.runId : null;
    }
    run.candidates.push(candidate);
  }
  indexCandidate(data.candidateIndex, recorded, runId, now);
  writeAccount(workspaceId, account, data);
  return recorded;
}

// Finds the record for a piece of content by its platform id or canonical URL, in this
// account's runs (the cross-run index says which run holds it). Returns null if the
// content was never recorded.
export function locateCandidate(workspaceId, account, target) {
  if (typeof target !== "string" || !target.trim() || !accountFile(workspaceId, account)) return null;
  const key = target.trim();
  const data = readAccount(workspaceId, account);
  const hit = candidate => candidate.canonical_url === key || candidate.url === key || candidate.platform_content_id === key;
  for (const run of [...data.runs].reverse()) {
    const candidate = run.candidates.find(hit);
    if (candidate) return { runId: run.id, candidate };
  }
  return null;
}

// Mirrors a platform-visible action into its candidate's platform_actions[]. Idempotent:
// recording the same action for the same task twice adds nothing, and a NOOP ("already
// saved") is recorded once, not every time the task re-runs.
export function recordPlatformAction(workspaceId, account, runId, candidateId, entry) {
  if (!accountFile(workspaceId, account)) return null;
  const data = readAccount(workspaceId, account);
  const run = data.runs.find(item => item.id === runId);
  const candidate = run?.candidates.find(item => item.id === candidateId);
  if (!candidate) return null;
  const action = normalizePlatformAction({ observed_at: new Date().toISOString(), ...entry });
  const repeat = candidate.platform_actions.find(existing => samePlatformAction(existing, action)
    || (action.status === "NOOP" && existing.action === action.action && ["VERIFIED", "NOOP"].includes(existing.status)));
  if (repeat) return { candidate, action: repeat, added: false };
  candidate.platform_actions.push(action);
  writeAccount(workspaceId, account, data);
  return { candidate, action, added: true };
}

export function finalizeRun(workspaceId, account, runId, { overview, outcome = "SUCCEEDED", session = null } = {}) {
  if (!accountFile(workspaceId, account)) return null;
  if (typeof overview !== "string" || !overview.trim()) return null;
  const data = readAccount(workspaceId, account);
  const run = data.runs.find((entry) => entry.id === runId);
  if (!run) return null;
  run.overview = overview.trim();
  run.outcome = outcome;
  run.completedAt = new Date().toISOString();
  if (session && typeof session === "object") run.session = session; // the MS11 session report
  writeAccount(workspaceId, account, data);
  return run;
}

// The VA's review action: confirm a good match, or remove one the AI got
// wrong. Never anything platform-visible — this only touches our own record.
export function setCandidateStatus(workspaceId, account, runId, candidateId, status) {
  if (!["confirmed", "removed"].includes(status)) return null;
  if (!accountFile(workspaceId, account)) return null;
  const data = readAccount(workspaceId, account);
  const run = data.runs.find((r) => r.id === runId);
  if (!run) return null;
  const candidate = run.candidates.find((c) => c.id === candidateId);
  if (!candidate) return null;
  candidate.status = status;
  candidate.review_state = status;
  // Keep the cross-run index in sync so a later run recognizes this exact
  // identity as already-reviewed instead of resurfacing it as "pending" —
  // see candidateIndex's design note above createRun. Backfills an entry if
  // one doesn't exist yet (e.g. a candidate created before this index existed).
  const existing = findIndexEntry(data.candidateIndex, candidate);
  upsertIndexEntry(data.candidateIndex, {
    review_state: status,
    status,
    first_seen_at: existing ? existing.first_seen_at : candidate.first_seen_at,
    last_seen_at: existing ? existing.last_seen_at : candidate.last_seen_at,
    runId: existing ? existing.runId : run.id,
    candidateId: existing ? existing.candidateId : candidate.id,
    platform: candidate.platform,
    platform_content_id: candidate.platform_content_id,
    canonical_url: candidate.canonical_url,
  });
  writeAccount(workspaceId, account, data);
  return candidate;
}

export { safeAccountId };
