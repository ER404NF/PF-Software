// One-time data migration (Phase 1 rollout, PHASE1_TEAM_ROLLOUT_HANDOUT.md
// task P3, task queue/runs/checkpoints domain): reads the existing
// file-backed queue snapshot and writes it into
// automation.task_queue_snapshots, preserving tasks/paused/humanHolds
// exactly.
//
// Unlike sites/assignments/policies, this domain's persistence port
// (persistence/taskQueueSnapshotRepository.js) already exposes exactly the
// two operations a migration needs — load() and save() — behind the same
// contract both the file and Postgres adapters satisfy, so this script is a
// thin read-from-one/write-to-the-other rather than a hand-rolled SQL
// INSERT: reusing createPostgresTaskQueueSnapshotRepository()'s own save()
// means the crash-recovery/legacy-migration normalization
// (normalizeQueueSnapshot(), shared by both adapters — see
// M05_DURABLE_DOMAIN_MIGRATION.md's task-queue-snapshot section) applies
// identically here, without this script needing its own copy of that logic.
//
// Safe to re-run: save() is an upsert (one row per organization).
//
// Usage:
//   DATABASE_URL=postgres://... node server/scripts/migrate-task-queue-to-postgres.js [path/to/tasks.json]
// Defaults to QUEUE_STORE_PATH / storage/queue/tasks.json, matching index.js's own default.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileTaskQueueSnapshotRepository } from "../src/persistence/fileTaskQueueSnapshotRepository.js";
import { createPostgresTaskQueueSnapshotRepository } from "../src/db/repositories/postgresTaskQueueSnapshotRepository.js";
import { createPool } from "../src/db/pool.js";
import { isDirectExecution } from "../src/directExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrateTaskQueueToPostgres(pool, filePath) {
  const fileRepository = createFileTaskQueueSnapshotRepository(filePath);
  const { tasks, paused, humanHolds } = fileRepository.load(); // also applies any pending crash-recovery, same as a normal boot would

  const postgresRepository = await createPostgresTaskQueueSnapshotRepository(pool);
  await postgresRepository.save(tasks, paused, humanHolds);

  const after = await postgresRepository.load();
  return { beforeCount: tasks.length, afterCount: after.tasks.length, paused, humanHoldCount: humanHolds.size };
}

async function main() {
  const filePath = process.argv[2] || process.env.QUEUE_STORE_PATH
    || path.join(__dirname, "../../storage/queue/tasks.json");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (this migration writes to the real database, not a mock).");
    process.exit(1);
  }
  console.log(`Reading the task queue snapshot from ${filePath}...`);
  const pool = createPool();
  try {
    const { beforeCount, afterCount, paused, humanHoldCount } = await migrateTaskQueueToPostgres(pool, filePath);
    console.log(`Tasks in file: ${beforeCount} (paused: ${paused}, human holds: ${humanHoldCount})`);
    console.log(`Tasks now in Postgres: ${afterCount}`);
    if (afterCount !== beforeCount) {
      console.error(`WARNING: task count mismatch (file ${beforeCount} vs Postgres ${afterCount}) — investigate before cutting over.`);
      process.exitCode = 1;
    } else {
      console.log("Row counts reconcile. Safe to proceed with the cutover step once you have watched this run correctly.");
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
