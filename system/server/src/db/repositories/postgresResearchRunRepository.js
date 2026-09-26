// M05: PostgreSQL-backed adapter satisfying the exact same research run
// repository contract (persistence/researchRunRepository.js) as
// fileResearchRunRepository.js (which wraps researchStore.js) — same 8
// methods, same return shapes. The cross-run dedup/merge logic
// (candidateRecord, findIndexEntry, upsertIndexEntry, mergeCandidate,
// indexCandidate, normalizePlatformAction, samePlatformAction) is imported
// directly from researchStore.js rather than duplicated: those functions
// are pure (data in, data out, no fs), so this adapter only replaces the
// storage half (readAccount/writeAccount's fs calls) with a Postgres row
// read/write, keeping the mutation logic itself identical to the file
// store's. Every row is scoped to the install's single default
// organization (see db/defaultOrganization.js and the owner decision it
// documents).

import crypto from "node:crypto";
import {
  safeAccountId, candidateRecord, findIndexEntry, upsertIndexEntry,
  mergeCandidate, indexCandidate, normalizePlatformAction, samePlatformAction,
} from "../../researchStore.js";
import { assertResearchRunRepository } from "../../persistence/researchRunRepository.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

function validKey(workspaceId, account) {
  return Boolean(safeAccountId(account) && safeAccountId(workspaceId));
}

// researchStore.js's findIndexEntry()/upsertIndexEntry() build byContentId
// keys as `${platform}\u0000${platformContentId}` — a NUL byte join that a
// JSON *file* stores without issue (fs just writes the escaped "\u0000"
// text), but PostgreSQL's text/jsonb types reject outright: an embedded NUL
// byte cannot be stored in a jsonb value at all ("unsupported Unicode
// escape sequence" / "\u0000 cannot be converted to text"). Rather than
// change the shared key format in researchStore.js itself (touching the
// file store's on-disk shape), this adapter base64-encodes every
// candidateIndex key at the Postgres storage boundary only, and decodes on
// load — the shared pure functions (findIndexEntry etc.) only ever see the
// original, un-encoded keys in memory.
// Exported so the P3 data migration (scripts/migrate-research-to-postgres.js)
// can build the exact same on-disk-to-Postgres payload shape directly,
// rather than duplicating this encoding a second time.
export function encodeIndexKeys(index) {
  const encodeTable = (table) => Object.fromEntries(
    Object.entries(table ?? {}).map(([key, value]) => [Buffer.from(key, "utf8").toString("base64"), value]),
  );
  return { byContentId: encodeTable(index.byContentId), byUrl: encodeTable(index.byUrl) };
}

function decodeIndexKeys(index) {
  const decodeTable = (table) => Object.assign(Object.create(null), Object.fromEntries(
    Object.entries(table ?? {}).map(([key, value]) => [Buffer.from(key, "base64").toString("utf8"), value]),
  ));
  return { byContentId: decodeTable(index.byContentId), byUrl: decodeTable(index.byUrl) };
}

export async function createPostgresResearchRunRepository(pool, { now = () => new Date().toISOString() } = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  function withOrg(fn) {
    return withTransaction(pool, fn, { organizationId });
  }

  async function loadData(client, workspaceId, account) {
    const result = await client.query(
      "SELECT payload FROM automation.research_accounts WHERE organization_id = $1 AND workspace_id = $2 AND account = $3",
      [organizationId, workspaceId, account],
    );
    if (result.rowCount === 0) {
      return { runs: [], candidateIndex: { byContentId: Object.create(null), byUrl: Object.create(null) } };
    }
    const stored = result.rows[0].payload;
    // decodeIndexKeys() already restores the null-prototype hardening
    // researchStore.js's readAccount() applies (these keys originate in
    // platform data, and a bare {} would let a value like "__proto__" reach
    // the prototype chain instead of staying an ordinary key).
    return {
      runs: stored.runs || [],
      candidateIndex: decodeIndexKeys(stored.candidateIndex || {}),
    };
  }

  async function saveData(client, workspaceId, account, data) {
    const payload = { runs: data.runs, candidateIndex: encodeIndexKeys(data.candidateIndex) };
    await client.query(
      `INSERT INTO automation.research_accounts (organization_id, workspace_id, account, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, workspace_id, account) DO UPDATE SET payload = $4, updated_at = $5`,
      [organizationId, workspaceId, account, JSON.stringify(payload), now()],
    );
  }

  return assertResearchRunRepository({
    async listRuns(workspaceId, account) {
      if (!validKey(workspaceId, account)) return null;
      return withOrg(async (client) => (await loadData(client, workspaceId, account)).runs);
    },

    async getRun(workspaceId, account, runId) {
      if (!validKey(workspaceId, account)) return null;
      return withOrg(async (client) => {
        const data = await loadData(client, workspaceId, account);
        return data.runs.find((r) => r.id === runId) || null;
      });
    },

    async createRun(workspaceId, account, { platform, timeWindow, overview, candidates }) {
      if (!validKey(workspaceId, account)) return null;
      return withOrg(async (client) => {
        const data = await loadData(client, workspaceId, account);
        const at = now();
        const run = {
          id: `run-${crypto.randomUUID()}`,
          account, workspaceId, platform, timeWindow, overview,
          createdAt: at,
          candidates: [],
        };
        const seenIds = new Map();
        const seenUrls = new Map();
        for (const input of candidates || []) {
          const c = candidateRecord(input, { platform, account, workspaceId, now: at, runId: run.id });
          const duplicate = (c.platform_content_id && seenIds.get(c.platform_content_id))
            || (c.canonical_url && seenUrls.get(c.canonical_url));
          if (duplicate) {
            mergeCandidate(duplicate, c);
            if (c.platform_content_id) seenIds.set(c.platform_content_id, duplicate);
            if (c.canonical_url) seenUrls.set(c.canonical_url, duplicate);
            continue;
          }
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
        for (const c of run.candidates) indexCandidate(data.candidateIndex, c, run.id, at);
        data.runs.push(run);
        await saveData(client, workspaceId, account, data);
        return run;
      });
    },

    async appendCandidate(workspaceId, account, runId, input) {
      if (!validKey(workspaceId, account)) return null;
      return withOrg(async (client) => {
        const data = await loadData(client, workspaceId, account);
        const run = data.runs.find((candidateRun) => candidateRun.id === runId);
        if (!run) return null;
        const at = now();
        const candidate = candidateRecord(input, { platform: run.platform, account, workspaceId, now: at, runId });
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
        indexCandidate(data.candidateIndex, recorded, runId, at);
        await saveData(client, workspaceId, account, data);
        return recorded;
      });
    },

    async locateCandidate(workspaceId, account, target) {
      if (typeof target !== "string" || !target.trim() || !validKey(workspaceId, account)) return null;
      const key = target.trim();
      return withOrg(async (client) => {
        const data = await loadData(client, workspaceId, account);
        const hit = (candidate) => candidate.canonical_url === key || candidate.url === key || candidate.platform_content_id === key;
        for (const run of [...data.runs].reverse()) {
          const candidate = run.candidates.find(hit);
          if (candidate) return { runId: run.id, candidate };
        }
        return null;
      });
    },

    async recordPlatformAction(workspaceId, account, runId, candidateId, entry) {
      if (!validKey(workspaceId, account)) return null;
      return withOrg(async (client) => {
        const data = await loadData(client, workspaceId, account);
        const run = data.runs.find((item) => item.id === runId);
        const candidate = run?.candidates.find((item) => item.id === candidateId);
        if (!candidate) return null;
        const action = normalizePlatformAction({ observed_at: now(), ...entry });
        const repeat = candidate.platform_actions.find((existing) => samePlatformAction(existing, action)
          || (action.status === "NOOP" && existing.action === action.action && ["VERIFIED", "NOOP"].includes(existing.status)));
        if (repeat) return { candidate, action: repeat, added: false };
        candidate.platform_actions.push(action);
        await saveData(client, workspaceId, account, data);
        return { candidate, action, added: true };
      });
    },

    async finalizeRun(workspaceId, account, runId, { overview, outcome = "SUCCEEDED", session = null } = {}) {
      if (!validKey(workspaceId, account)) return null;
      if (typeof overview !== "string" || !overview.trim()) return null;
      return withOrg(async (client) => {
        const data = await loadData(client, workspaceId, account);
        const run = data.runs.find((entry) => entry.id === runId);
        if (!run) return null;
        run.overview = overview.trim();
        run.outcome = outcome;
        run.completedAt = now();
        if (session && typeof session === "object") run.session = session;
        await saveData(client, workspaceId, account, data);
        return run;
      });
    },

    async setCandidateStatus(workspaceId, account, runId, candidateId, status) {
      if (!["confirmed", "removed"].includes(status)) return null;
      if (!validKey(workspaceId, account)) return null;
      return withOrg(async (client) => {
        const data = await loadData(client, workspaceId, account);
        const run = data.runs.find((r) => r.id === runId);
        if (!run) return null;
        const candidate = run.candidates.find((c) => c.id === candidateId);
        if (!candidate) return null;
        candidate.status = status;
        candidate.review_state = status;
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
        await saveData(client, workspaceId, account, data);
        return candidate;
      });
    },
  });
}
