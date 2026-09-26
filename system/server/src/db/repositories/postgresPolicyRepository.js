// M05: PostgreSQL-backed adapter satisfying the exact same policy
// repository contract (persistence/policyRepository.js) as
// filePolicyRepository.js (which wraps the in-memory PolicyStore) — same 4
// methods, same synchronous contract. Unlike every other M05 domain, this
// adapter is NOT a thin query-per-call wrapper: `effective()`/`describe()`
// are read inline from actionPolicy.js's validateAction() gate, which is
// never awaited, so this adapter keeps a synchronously-readable in-memory
// cache (src/syncCache.js) loaded from Postgres at construction and kept
// current on every local write. `set()`/`clear()` update that cache
// immediately (so a read on the very next line already sees the change)
// and persist to Postgres in the background — a write failure is reported,
// never thrown back into the synchronous call, matching syncCache's own
// contract. Every row is scoped to the install's single default
// organization (see db/defaultOrganization.js and the owner decision it
// documents).

import { ACTIONS, POLICY_VALUES } from "../../actionPolicy.js";
import { assertPolicyRepository } from "../../persistence/policyRepository.js";
import { createSyncCache } from "../../syncCache.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

const ACTION_SET = new Set(ACTIONS);
const VALUE_SET = new Set(Object.values(POLICY_VALUES));
const SEPARATOR = "\u0000";

function cacheKey(accountId, action) {
  return `${accountId}${SEPARATOR}${action}`;
}

export async function createPostgresPolicyRepository(pool, {
  now = () => new Date().toISOString(),
  refreshIntervalMs = 0,
} = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  function withOrg(fn) {
    return withTransaction(pool, fn, { organizationId });
  }

  async function loadSnapshot() {
    return withOrg(async (client) => {
      const result = await client.query(
        "SELECT account_id, action, value, changed_by, changed_at FROM automation.account_policies WHERE organization_id = $1",
        [organizationId],
      );
      const entries = result.rows.map((row) => [
        cacheKey(row.account_id, row.action),
        { value: row.value, by: row.changed_by, at: row.changed_at instanceof Date ? row.changed_at.toISOString() : row.changed_at },
      ]);
      return new Map(entries);
    });
  }

  async function persistEntry(key, entry) {
    const [accountId, action] = key.split(SEPARATOR);
    await withOrg(async (client) => {
      if (entry === undefined) {
        await client.query(
          "DELETE FROM automation.account_policies WHERE organization_id = $1 AND account_id = $2 AND action = $3",
          [organizationId, accountId, action],
        );
        return;
      }
      await client.query(
        `INSERT INTO automation.account_policies (organization_id, account_id, action, value, changed_by, changed_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (organization_id, account_id, action)
         DO UPDATE SET value = $4, changed_by = $5, changed_at = $6`,
        [organizationId, accountId, action, entry.value, entry.by, entry.at],
      );
    });
  }

  const cache = await createSyncCache({ load: loadSnapshot, persist: persistEntry, refreshIntervalMs });

  return assertPolicyRepository({
    set(accountId, action, value, by = null) {
      if (!ACTION_SET.has(action)) throw new Error(`unknown action "${action}"`);
      if (!VALUE_SET.has(value)) throw new Error(`policy must be one of ${[...VALUE_SET].join(", ")}`);
      const entry = { value, by, at: now() };
      cache.set(cacheKey(accountId, action), entry);
      return entry;
    },

    clear(accountId, action) {
      const key = cacheKey(accountId, action);
      if (cache.has(key)) cache.delete(key);
    },

    effective(basePolicies) {
      const merged = new Map();
      for (const [accountId, base] of basePolicies ?? []) merged.set(accountId, { ...base });
      for (const [key, entry] of cache.entries()) {
        const [accountId, action] = key.split(SEPARATOR);
        if (!VALUE_SET.has(entry?.value) || !ACTION_SET.has(action)) continue;
        const target = merged.get(accountId) ?? Object.create(null);
        target[action] = entry.value;
        merged.set(accountId, target);
      }
      return merged;
    },

    describe(accountId, basePolicies) {
      const base = basePolicies?.get(accountId) ?? {};
      return ACTIONS.map((action) => {
        const entry = cache.get(cacheKey(accountId, action));
        return {
          action,
          policy: entry?.value ?? base[action] ?? POLICY_VALUES.DISABLED,
          source: entry ? "runtime" : base[action] ? "config" : "default",
          changedBy: entry?.by ?? null,
        };
      });
    },

    // Not part of the policy repository contract (only set/clear/effective/
    // describe are required) — exposed so a caller that wants to force this
    // process to pick up another instance's write sooner than
    // `refreshIntervalMs` can, and so tests can prove the eventual-
    // consistency boundary explicitly rather than only via a timer.
    refresh: cache.refresh,
  });
}
