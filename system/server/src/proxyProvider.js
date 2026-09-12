// Vendor-neutral boundary for future commercial or self-hosted proxy control.
// No provider is configured by default, so the UI only reports the passive
// network contract and never presents rotation/enable controls that cannot run.

const HEALTH_STATES = new Set(["healthy", "degraded", "offline", "unknown"]);

export class ProxyProvider {
  constructor({ id, label, supportsRotation = false } = {}) {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(id)) throw new Error("proxy provider requires a safe id");
    if (typeof label !== "string" || !label.trim() || label.length > 100) throw new Error("proxy provider requires a label");
    if (typeof supportsRotation !== "boolean") throw new Error("supportsRotation must be a boolean");
    this.id = id;
    this.label = label.trim();
    this.supportsRotation = supportsRotation;
  }

  async getHealth() {
    throw new Error("proxy health is not implemented for this provider");
  }

  async rotateExit() {
    if (!this.supportsRotation) throw new Error("proxy exit rotation is not supported by this provider");
    throw new Error("proxy exit rotation is not implemented for this provider");
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
    || typeof provider.supportsRotation !== "boolean" || typeof provider.getHealth !== "function"
    || typeof provider.rotateExit !== "function") {
    throw new Error("invalid proxy provider contract");
  }
  return provider;
}
