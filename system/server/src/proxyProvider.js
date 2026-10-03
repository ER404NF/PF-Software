// Vendor-neutral boundary for commercial or self-hosted proxy control planes.
// No provider is configured by default. Supplying an operational provider makes
// inventory/lease controls available, but does not itself route phone traffic;
// the routing orchestrator must still apply and verify the network operation.

const HEALTH_STATES = new Set(["healthy", "degraded", "offline", "unknown"]);
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;

function providerError(message, status = 400, code = "PROXY_PROVIDER_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requireSafeId(value, field) {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
    throw providerError(`${field} requires a safe id`);
  }
  return value;
}

function normalizeRegion(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw providerError("region must be null or a non-empty string (max 100 characters)");
  }
  return value.trim();
}

export class ProxyProvider {
  constructor({ id, label, supportsRotation = false } = {}) {
    if (typeof id !== "string" || !SAFE_ID_RE.test(id)) throw new Error("proxy provider requires a safe id");
    if (typeof label !== "string" || !label.trim() || label.length > 100) throw new Error("proxy provider requires a label");
    if (typeof supportsRotation !== "boolean") throw new Error("supportsRotation must be a boolean");
    this.id = id;
    this.label = label.trim();
    this.supportsRotation = supportsRotation;
  }

  async listExits() {
    throw new Error("proxy exit inventory is not implemented for this provider");
  }

  async setExitEnabled() {
    throw new Error("proxy exit enable/disable is not implemented for this provider");
  }

  async getHealth() {
    throw new Error("proxy health is not implemented for this provider");
  }

  async rotateExit() {
    if (!this.supportsRotation) throw new Error("proxy exit rotation is not supported by this provider");
    throw new Error("proxy exit rotation is not implemented for this provider");
  }

  async leaseExit() {
    throw new Error("proxy exit leasing is not implemented for this provider");
  }

  async getLease() {
    throw new Error("proxy exit lease lookup is not implemented for this provider");
  }

  async releaseExit() {
    throw new Error("proxy exit leasing is not implemented for this provider");
  }
}

function normalizeExitDefinition(exit) {
  if (!exit || typeof exit !== "object") throw providerError("proxy exit must be an object");
  const id = requireSafeId(exit.id, "proxy exit");
  if (typeof exit.region !== "string" || !exit.region.trim() || exit.region.length > 100) {
    throw providerError("proxy exit requires a region (max 100 characters)");
  }
  if (!Number.isSafeInteger(exit.capacity) || exit.capacity < 1 || exit.capacity > 1_000_000) {
    throw providerError("proxy exit capacity must be an integer from 1 to 1000000");
  }
  return {
    id,
    region: exit.region.trim(),
    capacity: exit.capacity,
    enabled: exit.enabled !== false,
    health: normalizeProxyHealth({ ...(exit.health ?? {
      status: "unknown",
      checkedAt: new Date(0).toISOString(),
    }), region: exit.health?.region ?? exit.region.trim() }),
  };
}

// In-memory deterministic adapter used by local tests and development. It is
// intentionally not auto-registered in production and contains no credentials,
// sockets, or routing side effects. Its purpose is to exercise the complete
// vendor-neutral control contract before a real provider adapter is selected.
export class DeterministicProxyProvider extends ProxyProvider {
  constructor({ id = "local-deterministic", label = "Local deterministic provider", exits = [] } = {}) {
    super({ id, label, supportsRotation: true });
    this.exits = new Map();
    this.leases = new Map();
    for (const candidate of exits) {
      const exit = normalizeExitDefinition(candidate);
      if (this.exits.has(exit.id)) throw providerError(`duplicate proxy exit id: ${exit.id}`);
      this.exits.set(exit.id, exit);
    }
  }

  #leaseCount(exitId, exceptLeaseId = null) {
    let count = 0;
    for (const [leaseId, leasedExitId] of this.leases) {
      if (leaseId !== exceptLeaseId && leasedExitId === exitId) count += 1;
    }
    return count;
  }

  #publicExit(exit) {
    const activeLeases = this.#leaseCount(exit.id);
    return {
      id: exit.id,
      region: exit.region,
      enabled: exit.enabled,
      capacity: exit.capacity,
      activeLeases,
      availableCapacity: exit.enabled && exit.health.status === "healthy"
        ? Math.max(0, exit.capacity - activeLeases)
        : 0,
      health: { ...exit.health },
    };
  }

  async listExits() {
    return [...this.exits.values()].map(exit => this.#publicExit(exit))
      .sort((a, b) => a.region.localeCompare(b.region) || a.id.localeCompare(b.id));
  }

  async getHealth({ exitId } = {}) {
    const exit = this.exits.get(requireSafeId(exitId, "proxy exit"));
    if (!exit) throw providerError("unknown proxy exit", 404, "PROXY_EXIT_NOT_FOUND");
    return { ...exit.health };
  }

  async setExitHealth(exitId, health) {
    const exit = this.exits.get(requireSafeId(exitId, "proxy exit"));
    if (!exit) throw providerError("unknown proxy exit", 404, "PROXY_EXIT_NOT_FOUND");
    exit.health = normalizeProxyHealth({ ...health, region: health?.region ?? exit.region });
    return this.#publicExit(exit);
  }

  async setExitEnabled({ exitId, enabled, authorize = null } = {}) {
    const exit = this.exits.get(requireSafeId(exitId, "proxy exit"));
    if (!exit) throw providerError("unknown proxy exit", 404, "PROXY_EXIT_NOT_FOUND");
    if (typeof enabled !== "boolean") throw providerError("enabled must be a boolean");
    await authorize?.();
    exit.enabled = enabled;
    return this.#publicExit(exit);
  }

  #eligible({ region = null, excludeExitId = null, exceptLeaseId = null } = {}) {
    return [...this.exits.values()]
      .filter(exit => exit.id !== excludeExitId
        && exit.enabled
        && exit.health.status === "healthy"
        && (region === null || exit.region === region)
        && this.#leaseCount(exit.id, exceptLeaseId) < exit.capacity)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async leaseExit({ leaseId, region = null, authorize = null } = {}) {
    requireSafeId(leaseId, "proxy lease");
    const normalizedRegion = normalizeRegion(region);
    const currentExitId = this.leases.get(leaseId);
    if (currentExitId) return this.#publicExit(this.exits.get(currentExitId));
    const [selected] = this.#eligible({ region: normalizedRegion });
    if (!selected) throw providerError("no healthy enabled proxy exit has available capacity", 409, "PROXY_CAPACITY_UNAVAILABLE");
    await authorize?.();
    this.leases.set(leaseId, selected.id);
    return this.#publicExit(selected);
  }

  async getLease({ leaseId } = {}) {
    requireSafeId(leaseId, "proxy lease");
    const exitId = this.leases.get(leaseId);
    return exitId ? this.#publicExit(this.exits.get(exitId)) : null;
  }

  async releaseExit({ leaseId, authorize = null } = {}) {
    requireSafeId(leaseId, "proxy lease");
    await authorize?.();
    return this.leases.delete(leaseId);
  }

  async rotateExit({ leaseId, region = null, authorize = null } = {}) {
    requireSafeId(leaseId, "proxy lease");
    const normalizedRegion = normalizeRegion(region);
    const currentExitId = this.leases.get(leaseId);
    if (!currentExitId) throw providerError("unknown proxy lease", 404, "PROXY_LEASE_NOT_FOUND");
    const [selected] = this.#eligible({
      region: normalizedRegion,
      excludeExitId: currentExitId,
      exceptLeaseId: leaseId,
    });
    if (!selected) throw providerError("no alternate healthy enabled proxy exit has available capacity", 409, "PROXY_ROTATION_UNAVAILABLE");
    await authorize?.();
    this.leases.set(leaseId, selected.id);
    return this.#publicExit(selected);
  }
}

export function normalizeProxyHealth(value) {
  if (!value || typeof value !== "object" || !HEALTH_STATES.has(value.status)) {
    throw new Error("proxy health requires a known status");
  }
  const checkedAt = new Date(value.checkedAt);
  if (!Number.isFinite(checkedAt.getTime())) throw new Error("proxy health requires a valid checkedAt");
  return {
    status: value.status,
    checkedAt: checkedAt.toISOString(),
    region: typeof value.region === "string" && value.region.length <= 100 ? value.region : null,
    publicIpv4: typeof value.publicIpv4 === "string" && value.publicIpv4.length <= 45 ? value.publicIpv4 : null,
    latencyMs: Number.isFinite(value.latencyMs) && value.latencyMs >= 0 ? value.latencyMs : null,
  };
}

export function assertProxyProviderContract(provider) {
  if (!provider || typeof provider.id !== "string" || typeof provider.label !== "string"
    || typeof provider.supportsRotation !== "boolean" || typeof provider.listExits !== "function"
    || typeof provider.getHealth !== "function" || typeof provider.setExitEnabled !== "function"
    || typeof provider.rotateExit !== "function" || typeof provider.leaseExit !== "function"
    || typeof provider.getLease !== "function" || typeof provider.releaseExit !== "function") {
    throw new Error("invalid proxy provider contract");
  }
  return provider;
}
