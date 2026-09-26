// M05: PostgreSQL-backed adapter satisfying the exact same task queue
// snapshot repository contract (persistence/taskQueueSnapshotRepository.js)
// as fileTaskQueueSnapshotRepository.js — same two methods, same legacy-
// format migration and crash-recovery behavior on load (reusing
// normalizeQueueSnapshot() so that logic exists exactly once, not
// duplicated per storage backend). The snapshot is scoped to the install's
// single default organization (see db/defaultOrganization.js and the owner
// decision it documents).

import { assertTaskQueueSnapshotRepository, normalizeQueueSnapshot } from "../../persistence/taskQueueSnapshotRepository.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

export async function createPostgresTaskQueueSnapshotRepository(pool, { now = () => new Date() } = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  function withOrg(fn) {
    return withTransaction(pool, fn, { organizationId });
  }

  async function persist(client, tasks, paused, humanHolds) {
    const payload = { version: 2, paused, humanHolds: [...humanHolds], tasks };
    await client.query(
      `INSERT INTO automation.task_queue_snapshots (organization_id, payload, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id) DO UPDATE SET payload = $2, updated_at = $3`,
      [organizationId, JSON.stringify(payload), now()],
    );
  }

  return assertTaskQueueSnapshotRepository({
    async save(tasks, paused, humanHolds = new Set()) {
      return withOrg((client) => persist(client, tasks, paused, humanHolds));
    },

    async load() {
      return withOrg(async (client) => {
        const result = await client.query(
          "SELECT payload FROM automation.task_queue_snapshots WHERE organization_id = $1",
          [organizationId],
        );
        if (result.rowCount === 0) return { tasks: [], paused: false, humanHolds: new Set() };
        const { tasks, paused, humanHolds, changed } = normalizeQueueSnapshot(result.rows[0].payload);
        if (changed) await persist(client, tasks, paused, humanHolds);
        return { tasks, paused, humanHolds };
      });
    },
  });
}
