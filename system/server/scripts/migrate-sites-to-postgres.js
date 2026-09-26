// One-time data migration (Phase 1 rollout, PHASE1_TEAM_ROLLOUT_HANDOUT.md
// task P3, sites domain): reads the existing file-backed sites.json and
// writes each site into automation.fleet.sites, preserving every field
// exactly — including the token HASH (never the plaintext token, which
// neither store ever persists) — so an existing site agent's saved token
// keeps verifying successfully against the migrated row.
//
// Safe to re-run: each site is upserted by id (ON CONFLICT DO UPDATE),
// never duplicated. Does not touch or delete the source file — sites.json
// remains the fallback read path until index.js is actually cut over to
// the Postgres adapter for this domain, and for a real rollback path after.
//
// Usage:
//   DATABASE_URL=postgres://... node server/scripts/migrate-sites-to-postgres.js [path/to/sites.json]
// Defaults to SITE_STORE_PATH / storage/sites.json, matching index.js's own default.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SiteStore } from "../src/siteStore.js";
import { createPool } from "../src/db/pool.js";
import { withTransaction } from "../src/db/transaction.js";
import { ensureDefaultOrganization } from "../src/db/defaultOrganization.js";
import { isDirectExecution } from "../src/directExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrateSitesToPostgres(pool, filePath) {
  const store = new SiteStore(filePath); // reuses the file store's own loading/validation, not a hand-rolled JSON parse
  const beforeCount = store.list().length;

  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  const results = [];
  await withTransaction(pool, async (client) => {
    for (const publicSite of store.list()) {
      const raw = store.sites.get(publicSite.id); // the real record, including tokenHash (list() strips it)
      // rotated_at is NOT NULL in the schema (it doubles as "when the
      // current token was issued," defaulting to created_at at creation —
      // see fleet-sites.js's own column default and siteStore.js's create(),
      // which always sets rotatedAt: now at creation, never null). Coalesce
      // defensively rather than assume every possible file record is
      // perfectly well-formed; only last_seen_at is ever legitimately null.
      const rotatedAt = raw.rotatedAt ?? raw.createdAt;
      const result = await client.query(
        `INSERT INTO fleet.sites (id, organization_id, name, time_zone, token_hash, created_at, rotated_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           name = $3, time_zone = $4, token_hash = $5, created_at = $6, rotated_at = $7, last_seen_at = $8
         RETURNING id`,
        [raw.id, organizationId, raw.name, raw.timeZone, raw.tokenHash, raw.createdAt, rotatedAt, raw.lastSeenAt ?? null],
      );
      results.push(result.rows[0].id);
    }
  }, { organizationId });

  const afterResult = await withTransaction(
    pool,
    (client) => client.query("SELECT count(*)::int AS n FROM fleet.sites WHERE organization_id = $1", [organizationId]),
    { organizationId },
  );
  const afterCount = afterResult.rows[0].n;

  return { beforeCount, migratedIds: results, afterCount, organizationId };
}

async function main() {
  const filePath = process.argv[2] || process.env.SITE_STORE_PATH || path.join(__dirname, "../../storage/sites.json");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (this migration writes to the real database, not a mock).");
    process.exit(1);
  }
  console.log(`Reading sites from ${filePath}...`);
  const pool = createPool();
  try {
    const { beforeCount, migratedIds, afterCount, organizationId } = await migrateSitesToPostgres(pool, filePath);
    console.log(`Sites in file: ${beforeCount}`);
    console.log(`Sites upserted into Postgres (organization ${organizationId}): ${migratedIds.length}`);
    console.log(`Sites now in Postgres for this organization: ${afterCount}`);
    if (afterCount < beforeCount) {
      console.error(`WARNING: fewer rows in Postgres (${afterCount}) than in the file (${beforeCount}) — investigate before cutting over.`);
      process.exitCode = 1;
    } else {
      console.log("Row counts reconcile. Safe to proceed with the cutover step once you have watched this run correctly.");
    }
  } finally {
    await pool.end();
  }
}

// Only run as a CLI entry point — importable for tests without side effects.
if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
}
