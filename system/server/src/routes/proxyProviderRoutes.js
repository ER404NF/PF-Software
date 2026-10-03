import { createHash } from "node:crypto";

function leaseIdForDevice(deviceId) {
  return `device-${createHash("sha256").update(deviceId).digest("hex").slice(0, 32)}`;
}

function authorizationError(message, status, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function mutationFailure(res, error, next) {
  if (error?.status) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code || (error.status === 401 ? "AUTHENTICATION_REQUIRED" : "PROXY_PROVIDER_ERROR"),
    });
  }
  return next(error);
}

export function registerProxyProviderRoutes({
  app,
  registry,
  requireCapability,
  capabilities,
  currentStoredOperator,
  hasCapability,
  canAccessDevice,
  knownDevice,
  auditLog,
  recordAudit = event => auditLog.logEvent(event),
}) {
  const leaseByDevice = new Map();
  const mutationByDevice = new Map();

  async function withDeviceMutation(deviceId, operation) {
    const previous = mutationByDevice.get(deviceId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    mutationByDevice.set(deviceId, current);
    try {
      return await current;
    } finally {
      if (mutationByDevice.get(deviceId) === current) mutationByDevice.delete(deviceId);
    }
  }

  async function authorizeDeviceMutation(req, deviceId) {
    const current = await currentStoredOperator(req);
    if (!current) throw authorizationError("authentication required", 401);
    if (!hasCapability(current, capabilities.ASSIGN_PROXY) || !canAccessDevice(current, deviceId)) {
      throw authorizationError("proxy provider control is not permitted for this device", 403);
    }
    return current;
  }

  async function authorizeAdminMutation(req) {
    const current = await currentStoredOperator(req);
    if (!current) throw authorizationError("authentication required", 401);
    if (!hasCapability(current, capabilities.MANAGE_PROXY)) {
      throw authorizationError("proxy provider administration is not permitted", 403);
    }
    return current;
  }

  async function authorizeInventoryRead(req) {
    const current = await currentStoredOperator(req);
    if (!current) throw authorizationError("authentication required", 401);
    if (!hasCapability(current, capabilities.VIEW_PROXY_POOL)) {
      throw authorizationError("proxy provider inventory is not permitted", 403);
    }
    return current;
  }

  async function findAuthoritativeLeaseProvider(leaseId) {
    let owner = null;
    for (const provider of registry.values()) {
      const lease = await provider.getLease({ leaseId });
      if (!lease) continue;
      if (owner) {
        throw authorizationError("conflicting provider leases require administrator reconciliation", 409,
          "PROXY_PROVIDER_LEASE_CONFLICT");
      }
      owner = { providerId: provider.id, lease };
    }
    return owner;
  }

  // Provider control-plane inventory is separate from the credential pool.
  // These endpoints expose only bounded metadata; they never return credentials
  // and never claim that changing provider state changed a phone's route.
  app.get("/api/admin/proxy-providers", requireCapability(capabilities.VIEW_PROXY_POOL), async (req, res, next) => {
    try {
      const providers = await Promise.all([...registry.values()].map(async provider => {
        try {
          return {
            id: provider.id,
            label: provider.label,
            supportsRotation: provider.supportsRotation,
            exits: await provider.listExits(),
            error: null,
          };
        } catch {
          return {
            id: provider.id,
            label: provider.label,
            supportsRotation: provider.supportsRotation,
            exits: [],
            error: { code: "PROXY_PROVIDER_UNAVAILABLE", message: "Provider inventory is temporarily unavailable." },
          };
        }
      }));
      await authorizeInventoryRead(req);
      res.json({ providers });
    } catch (error) {
      mutationFailure(res, error, next);
    }
  });

  app.patch("/api/admin/proxy-providers/:providerId/exits/:exitId", requireCapability(capabilities.MANAGE_PROXY), async (req, res, next) => {
    const provider = registry.get(req.params.providerId);
    if (!provider) return res.status(404).json({ error: "unknown proxy provider", code: "PROXY_PROVIDER_NOT_FOUND" });
    try {
      await authorizeAdminMutation(req);
      let currentAtCommit = null;
      const exit = await provider.setExitEnabled({
        exitId: req.params.exitId,
        enabled: req.body?.enabled,
        authorize: async () => {
          currentAtCommit = await authorizeAdminMutation(req);
          return currentAtCommit;
        },
      });
      if (!currentAtCommit) throw new Error("proxy provider did not perform its required commit authorization");
      recordAudit({
        operator: currentAtCommit.username,
        type: "proxy_provider_exit_changed",
        detail: { providerId: provider.id, exitId: exit.id, enabled: exit.enabled },
      }, "Proxy-provider exit audit write");
      res.json({ exit, routingApplied: false, routingVerified: false });
    } catch (error) {
      mutationFailure(res, error, next);
    }
  });

  app.post("/api/admin/proxy-providers/:providerId/devices/:deviceId/lease", requireCapability(capabilities.ASSIGN_PROXY), async (req, res, next) => {
    const { deviceId, providerId } = req.params;
    if (!knownDevice(deviceId)) return res.status(404).json({ error: "unknown device" });
    const provider = registry.get(providerId);
    if (!provider) return res.status(404).json({ error: "unknown proxy provider", code: "PROXY_PROVIDER_NOT_FOUND" });
    const leaseId = leaseIdForDevice(deviceId);
    try {
      const result = await withDeviceMutation(deviceId, async () => {
        const authoritative = await findAuthoritativeLeaseProvider(leaseId);
        const currentProviderId = authoritative?.providerId ?? null;
        if (currentProviderId && currentProviderId !== providerId) {
          throw authorizationError("release this device's current provider lease first", 409, "PROXY_PROVIDER_LEASE_CONFLICT");
        }
        await authorizeDeviceMutation(req, deviceId);
        let currentAtCommit = null;
        const exit = await provider.leaseExit({
          leaseId,
          region: req.body?.region ?? null,
          authorize: async () => {
            currentAtCommit = await authorizeDeviceMutation(req, deviceId);
            return currentAtCommit;
          },
        });
        if (!currentAtCommit) {
          await provider.releaseExit({ leaseId }).catch(() => {});
          throw new Error("proxy provider did not perform its required commit authorization");
        }
        leaseByDevice.set(deviceId, providerId);
        return { current: currentAtCommit, exit };
      });
      recordAudit({ operator: result.current.username, type: "proxy_provider_exit_leased", deviceId,
        detail: { providerId, exitId: result.exit.id, region: result.exit.region } },
      "Proxy-provider lease audit write");
      res.json({ providerId, exit: result.exit, routingApplied: false, routingVerified: false });
    } catch (error) {
      mutationFailure(res, error, next);
    }
  });

  app.post("/api/admin/proxy-providers/:providerId/devices/:deviceId/rotate", requireCapability(capabilities.ASSIGN_PROXY), async (req, res, next) => {
    const { deviceId, providerId } = req.params;
    if (!knownDevice(deviceId)) return res.status(404).json({ error: "unknown device" });
    const provider = registry.get(providerId);
    if (!provider) return res.status(404).json({ error: "unknown proxy provider", code: "PROXY_PROVIDER_NOT_FOUND" });
    const leaseId = leaseIdForDevice(deviceId);
    try {
      const result = await withDeviceMutation(deviceId, async () => {
        const authoritative = await findAuthoritativeLeaseProvider(leaseId);
        if (authoritative?.providerId !== providerId) {
          throw authorizationError("this device has no lease from that provider", 409, "PROXY_PROVIDER_LEASE_REQUIRED");
        }
        await authorizeDeviceMutation(req, deviceId);
        let currentAtCommit = null;
        const exit = await provider.rotateExit({
          leaseId,
          region: req.body?.region ?? null,
          authorize: async () => {
            currentAtCommit = await authorizeDeviceMutation(req, deviceId);
            return currentAtCommit;
          },
        });
        if (!currentAtCommit) {
          await provider.releaseExit({ leaseId }).catch(() => {});
          leaseByDevice.delete(deviceId);
          throw new Error("proxy provider did not perform its required commit authorization");
        }
        return { current: currentAtCommit, exit };
      });
      recordAudit({ operator: result.current.username, type: "proxy_provider_exit_rotated", deviceId,
        detail: { providerId, exitId: result.exit.id, region: result.exit.region } },
      "Proxy-provider rotation audit write");
      res.json({ providerId, exit: result.exit, routingApplied: false, routingVerified: false });
    } catch (error) {
      mutationFailure(res, error, next);
    }
  });

  app.delete("/api/admin/proxy-providers/:providerId/devices/:deviceId/lease", requireCapability(capabilities.ASSIGN_PROXY), async (req, res, next) => {
    const { deviceId, providerId } = req.params;
    if (!knownDevice(deviceId)) return res.status(404).json({ error: "unknown device" });
    const provider = registry.get(providerId);
    if (!provider) return res.status(404).json({ error: "unknown proxy provider", code: "PROXY_PROVIDER_NOT_FOUND" });
    try {
      const current = await withDeviceMutation(deviceId, async () => {
        const leaseId = leaseIdForDevice(deviceId);
        const authoritative = await findAuthoritativeLeaseProvider(leaseId);
        if (authoritative?.providerId !== providerId) {
          throw authorizationError("this device has no lease from that provider", 409, "PROXY_PROVIDER_LEASE_REQUIRED");
        }
        await authorizeDeviceMutation(req, deviceId);
        let currentAtCommit = null;
        await provider.releaseExit({
          leaseId,
          authorize: async () => {
            currentAtCommit = await authorizeDeviceMutation(req, deviceId);
            return currentAtCommit;
          },
        });
        if (!currentAtCommit) throw new Error("proxy provider did not perform its required commit authorization");
        leaseByDevice.delete(deviceId);
        return currentAtCommit;
      });
      recordAudit(
        { operator: current.username, type: "proxy_provider_exit_released", deviceId, detail: { providerId } },
        "Proxy-provider release audit write",
      );
      res.json({ released: true, routingApplied: false, routingVerified: false });
    } catch (error) {
      mutationFailure(res, error, next);
    }
  });

  return { leaseByDevice };
}
