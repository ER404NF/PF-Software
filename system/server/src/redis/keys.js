// Redis key-schema helper (M06), enforcing
// docs/productionization/adrs/ADR-0003-redis-ephemeral.md's key registry:
// every tenant-sensitive key is prefixed with the organization id
// (`pf:org:{organizationId}:...`) so a bug in one call site can never write
// into another tenant's namespace — the same class of guarantee PostgreSQL
// RLS gives at the database layer, expressed as a naming convention here
// since Redis has no row-level security equivalent to enforce it for us.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*$/;

// ADR-0003: "No raw secrets or unbounded payloads in Redis." A generous but
// real ceiling — presence/rate-limit/cache entries are small structured
// data, never file contents or credentials.
export const MAX_VALUE_BYTES = 16 * 1024;

export class RedisKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RedisKeyError";
  }
}

// Builds a tenant-scoped key: pf:org:{organizationId}:{...segments}.
// organizationId must look like a UUID (this repo's identity.organizations
// primary key shape) so a malformed or attacker-influenced value can never
// collide with another tenant's namespace.
export function orgKey(organizationId, ...segments) {
  if (typeof organizationId !== "string" || !UUID_RE.test(organizationId)) {
    throw new RedisKeyError("organizationId must be a UUID");
  }
  if (!segments.length) throw new RedisKeyError("at least one key segment is required");
  for (const segment of segments) {
    if (typeof segment !== "string" || !KEY_SEGMENT_RE.test(segment)) {
      throw new RedisKeyError(`invalid key segment "${segment}"`);
    }
  }
  return ["pf", "org", organizationId, ...segments].join(":");
}

// Call before writing any value through this layer. Throws rather than
// silently truncating — a caller that would overflow the limit has a bug
// worth surfacing (e.g. accidentally caching a whole payload instead of a
// reference to it), not a size to quietly clip.
export function assertBoundedPayload(value) {
  const size = Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  if (size > MAX_VALUE_BYTES) {
    throw new RedisKeyError(`value is ${size} bytes, over the ${MAX_VALUE_BYTES}-byte Redis payload limit`);
  }
}
