// One-time data migration (Phase 1 rollout, PHASE1_TEAM_ROLLOUT_HANDOUT.md
// task P3, research domain): walks the existing file-backed research
// storage tree (RESEARCH_ROOT/<workspaceId>/<account>.json — one file per
// workspace/account, see researchStore.js's own accountFile()) and writes
// each account's {runs, candidateIndex} into automation.research_accounts,
// preserving every field exactly, including the cross-run dedup index.
//
// Unlike every other domain in this file, research data isn't one flat
// file — it's a directory tree, so this script enumerates workspace
// subdirectories and account files itself rather than being handed a
// single path. Reuses readAccount() (researchStore.js) for the read side
// and encodeIndexKeys() (postgresResearchRunRepository.js) for the exact
// same NUL-byte-safe key encoding the real adapter uses, rather than
// duplicating either.
//
// Safe to re-run: each account is upserted by (organization, workspace,
// account) (ON CONFLICT DO UPDATE).
//
// Usage:
//   DATABASE_URL=postgres://... node server/scripts/migrate-research-to-postgres.js [path/to/research-root]
// Defaults to RESEARCH_STORE_DIR / storage/research, matching index.js's own default.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeAccountId } from "../src/researchStore.js";
import { encodeIndexKeys } from "../src/db/repositories/postgresResearchRunRepository.js";
import { createPool } from "../src/db/pool.js";
import { withTransaction } from "../src/db/transaction.js";
import { ensureDefaultOrganization } from "../src/db/defaultOrganization.js";
import { isDirectExecution } from "../src/directExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Enumerates every (workspaceId, account) pair that actually has a file on
// disk — researchStore.js itself has no "list every account" function
// (every other operation already knows which account it wants), so this is
// the one piece of genuinely new directory-walking logic in this script.
function discoverAccountFiles(researchRoot) {
  if (!fs.existsSync(researchRoot)) return [];
  const pairs = [];
  for (const workspaceId of fs.readdirSync(researchRoot)) {
    if (!safeAccountId(workspaceId)) continue;
    const workspaceDir = path.join(researchRoot, workspaceId);
    if (!fs.statSync(workspaceDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(workspaceDir)) {
      if (!entry.endsWith(".json")) continue;
      const account = entry.slice(0, -".json".length);
      if (safeAccountId(account)) pairs.push({ workspaceId, account, file: path.join(workspaceDir, entry) });
    }
  }
  return pairs;
}

// Reads one account file directly by its already-discovered path, rather
// than calling researchStore.js's own readAccount(workspaceId, account) —
// that function re-derives the path from its own module-level RESEARCH_ROOT
// constant (bound to RESEARCH_STORE_DIR at import time), which would only
// coincidentally match a `researchRoot` explicitly passed into this
// function. Reading by the exact path this script already found sidesteps
// that mismatch entirely rather than relying on the two staying in sync.
// Mirrors readAccount()'s own null-prototype hardening exactly.
function readAccountFile(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    runs: data.runs || [],
    candidateIndex: {
      byContentId: Object.assign(Object.create(null), data.candidateIndex?.byContentId || {}),
      byUrl: Object.assign(Object.create(null), data.candidateIndex?.byUrl || {}),
    },
  };
}

export async function migrateResearchToPostgres(pool, researchRoot) {
  const pairs = discoverAccountFiles(researchRoot);

  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  let totalRuns = 0;
  const migrated = [];
  await withTransaction(pool, async (client) => {
    for (const { workspaceId, account, file } of pairs) {
      const data = readAccountFile(file);
      totalRuns += data.runs.length;
      const payload = { runs: data.runs, candidateIndex: encodeIndexKeys(data.candidateIndex) };
      await client.query(
        `INSERT INTO automation.research_accounts (organization_id, workspace_id, account, payload, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (organization_id, workspace_id, account) DO UPDATE SET payload = $4, updated_at = now()`,
        [organizationId, workspaceId, account, JSON.stringify(payload)],
      );
      migrated.push(`${workspaceId}/${account}`);
    }
  }, { organizationId });

  const afterResult = await withTransaction(
    pool,
    (client) => client.query("SELECT count(*)::int AS n FROM automation.research_accounts WHERE organization_id = $1", [organizationId]),
    { organizationId },
  );

  return { accountsFound: pairs.length, totalRuns, migratedAccounts: migrated, afterCount: afterResult.rows[0].n, organizationId };
}

async function main() {
  const researchRoot = process.argv[2] || process.env.RESEARCH_STORE_DIR
    || path.join(__dirname, "../../storage/research");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (this migration writes to the real database, not a mock).");
    process.exit(1);
  }
  console.log(`Scanning research accounts under ${researchRoot}...`);
  const pool = createPool();
  try {
    const { accountsFound, totalRuns, migratedAccounts, afterCount, organizationId } = await migrateResearchToPostgres(pool, researchRoot);
    console.log(`Research accounts found in files: ${accountsFound} (${totalRuns} total runs across all of them)`);
    console.log(`Research accounts upserted into Postgres (organization ${organizationId}): ${migratedAccounts.length}`);
    console.log(`Research accounts now in Postgres for this organization: ${afterCount}`);
    if (afterCount < accountsFound) {
      console.error(`WARNING: fewer accounts in Postgres (${afterCount}) than found in files (${accountsFound}) — investigate before cutting over.`);
      process.exitCode = 1;
    } else {
      console.log("Account counts reconcile. Safe to proceed with the cutover step once you have watched this run correctly.");
    }
  } finally {
    await pool.end();
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
}
