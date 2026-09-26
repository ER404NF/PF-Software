// M05, sixth domain: the task queue's durable snapshot
// (persistence/taskQueueSnapshotRepository.js). Unlike every prior M05
// domain, the snapshot is deliberately stored as a single opaque JSONB blob
// per organization, not normalized into per-task rows/columns — the port's
// own header comment is explicit that the queue's scheduling/eligibility/
// dispatch/retry/checkpoint mechanics (docs/COMMAND_QUEUE_SPEC.md §3,6-9,14)
// stay in taskQueue.js as domain logic, and only the snapshot read/write
// boundary is a persistence concern. Normalizing 13 task states and their
// fields into relational columns here would duplicate that domain logic in
// SQL for no parity benefit; a snapshot blob is the accurate schema for a
// snapshot.
//
// One row per organization (organization_id is the primary key) — there is
// exactly one task queue snapshot per install today.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE TABLE automation.task_queue_snapshots (
      organization_id uuid PRIMARY KEY REFERENCES identity.organizations(id),
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `);

  await pgm.db.query(`
    ALTER TABLE automation.task_queue_snapshots ENABLE ROW LEVEL SECURITY;
    ALTER TABLE automation.task_queue_snapshots FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_task_queue_snapshots ON automation.task_queue_snapshots
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP TABLE IF EXISTS automation.task_queue_snapshots");
}
