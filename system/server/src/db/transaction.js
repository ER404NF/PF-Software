// Transaction helper implementing DATABASE_GAP_ANALYSIS.md §2's request
// transaction pattern (BEGIN; SET LOCAL app.current_organization_id; ...;
// COMMIT). Not wired into any route yet (M04+) — this exists so the
// boundary is in place and tested before any domain becomes
// database-authoritative.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  constructor(message) {
    super(message);
    this.name = "TenantContextError";
  }
}

// Runs `fn(client)` inside a transaction, rolling back on any thrown error
// (including one thrown by fn itself) and always releasing the client back
// to the pool. When organizationId/userId are given, each is set as a
// transaction-local GUC via set_config() (parameterized — never string-
// interpolated into SQL text) before fn runs, so every statement fn issues
// is subject to the RLS policies that read app.current_organization_id /
// app.current_user_id.
//
// A client-supplied organization id or user id is a selector, never proof
// of authorization (DATABASE_GAP_ANALYSIS.md §2 rule 3) — callers must have
// already verified the caller's own identity/membership before reaching
// this function. userId exists for the narrow "read my own records across
// every organization" case (see the membership-self-read-policy migration)
// — it is deliberately not a substitute for organizationId on writes.
export async function withTransaction(pool, fn, { organizationId = null, userId = null } = {}) {
  if (typeof fn !== "function") throw new TypeError("withTransaction requires a function");
  if (organizationId !== null && !UUID_RE.test(organizationId)) {
    throw new TenantContextError("organizationId must be a UUID or null");
  }
  if (userId !== null && !UUID_RE.test(userId)) {
    throw new TenantContextError("userId must be a UUID or null");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (organizationId !== null) {
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [organizationId]);
    }
    if (userId !== null) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Rollback failed after a transaction error:", rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}
