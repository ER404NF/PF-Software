function proxyTestFields(body = {}) {
  return {
    protocol: body.protocol,
    host: body.host,
    port: body.port,
    username: body.username,
    password: body.password,
    country: body.country,
  };
}

function sendExpectedError(res, error) {
  if (!Number.isInteger(error?.status)) return false;
  res.status(error.status).json({ error: error.message });
  return true;
}

function sendProxyTestFailure(res, error) {
  const diagnostic = error?.diagnostic;
  return res.status(error?.status || 502).json({
    error: diagnostic?.name || "Proxy test failed",
    code: diagnostic?.code || "P111",
    diagnostic: diagnostic || null,
  });
}

export function registerProxyPoolRoutes({
  app,
  requireCapability,
  capabilities,
  authorizeCurrentOperator,
  knownDevice,
  canAccessDevice,
  proxyPoolRepository,
  proxyCredentialEncryptionKey,
  decryptProxyPassword,
  publicProxy,
  publicNetworkConfig,
  testProxy,
  getProxyPool,
  refreshProxyPoolCache,
  setDeviceProxyEnabled,
  configPath,
  deviceNetwork,
  recordAudit,
  broadcastDeviceList,
  poolProxyForDevice,
  networkRoutingOrchestrator,
  invalidateNetworkVerification = () => {},
  now = () => new Date(),
}) {
  app.patch("/api/admin/devices/:deviceId/proxy", requireCapability(capabilities.MANAGE_PROXY), (req, res, next) => {
    try {
      if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
      if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
        return res.status(403).json({ error: "not authorized for this device" });
      }
      if (networkRoutingOrchestrator?.getRoute(req.params.deviceId)) {
        return res.status(409).json({ error: "Stop the active route before changing this phone's proxy setting." });
      }
      const network = setDeviceProxyEnabled({ configPath, deviceId: req.params.deviceId, enabled: req.body?.enabled });
      deviceNetwork.set(req.params.deviceId, network);
      invalidateNetworkVerification(req.params.deviceId);
      recordAudit({
        operator: req.currentOperator.username,
        type: "proxy_setting_changed",
        deviceId: req.params.deviceId,
        detail: { enabled: network.enabled, networkEgress: network.egress },
      }, "Proxy setting audit write");
      broadcastDeviceList();
      return res.json({ network: publicNetworkConfig(network) });
    } catch (error) {
      if (sendExpectedError(res, error)) return undefined;
      return next(error);
    }
  });

  app.get("/api/admin/proxies", requireCapability(capabilities.VIEW_PROXY_POOL), (_req, res) => {
    res.json({ proxies: getProxyPool() });
  });

  app.post("/api/admin/proxies", requireCapability(capabilities.MANAGE_PROXY), (req, res, next) => {
    if (!proxyCredentialEncryptionKey) {
      return res.status(503).json({ error: "the proxy pool is unavailable until TWO_FACTOR_MASTER_KEY (or PROXY_CREDENTIAL_ENCRYPTION_KEY) is configured" });
    }
    try {
      const record = proxyPoolRepository.create({
        provider: req.body?.provider,
        protocol: req.body?.protocol,
        host: req.body?.host,
        port: req.body?.port,
        username: req.body?.username,
        password: req.body?.password,
        country: req.body?.country,
        label: req.body?.label,
      }, proxyCredentialEncryptionKey);
      refreshProxyPoolCache();
      recordAudit({
        operator: req.currentOperator.username,
        type: "proxy_pool_created",
        detail: { proxyId: record.id, provider: record.provider, country: record.country },
      }, "Proxy pool creation audit write");
      return res.status(201).json({ proxy: publicProxy(record) });
    } catch (error) {
      if (sendExpectedError(res, error)) return undefined;
      return next(error);
    }
  });

  app.post("/api/admin/proxies/test", requireCapability(capabilities.MANAGE_PROXY), async (req, res, next) => {
    try {
      await authorizeCurrentOperator(req, [capabilities.MANAGE_PROXY]);
      const result = await testProxy(proxyTestFields(req.body));
      await authorizeCurrentOperator(req, [capabilities.MANAGE_PROXY]);
      return res.json({ result });
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) return res.status(error.status).json({ error: error.message });
      if (!error?.diagnostic && !error?.status) return next(error);
      return sendProxyTestFailure(res, error);
    }
  });

  app.post("/api/admin/proxies/:proxyId/test", requireCapability(capabilities.MANAGE_PROXY), async (req, res, next) => {
    if (!proxyCredentialEncryptionKey) {
      return res.status(503).json({ error: "proxy testing is unavailable until the credential encryption key is configured" });
    }
    let record;
    try {
      record = proxyPoolRepository.get(req.params.proxyId);
    } catch (error) {
      return next(error);
    }
    if (!record) return res.status(404).json({ error: "unknown proxy" });
    try {
      await authorizeCurrentOperator(req, [capabilities.MANAGE_PROXY]);
      const result = await testProxy({
        protocol: record.protocol,
        host: record.host,
        port: record.port,
        username: record.username,
        password: decryptProxyPassword(record, proxyCredentialEncryptionKey),
        country: record.country,
      });
      const currentAtCommit = await authorizeCurrentOperator(req, [capabilities.MANAGE_PROXY]);
      proxyPoolRepository.updateHealth(record.id, result);
      refreshProxyPoolCache();
      recordAudit({
        operator: currentAtCommit.username,
        type: "proxy_test_succeeded",
        detail: { proxyId: record.id, publicIpv4: result.publicIpv4, country: result.country, latencyMs: result.latencyMs },
      }, "Proxy health-success audit write");
      return res.json({ result, proxy: publicProxy(proxyPoolRepository.get(record.id)) });
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) return res.status(error.status).json({ error: error.message });
      if (!error?.diagnostic && !error?.status) return next(error);
      let currentAtCommit;
      try {
        currentAtCommit = await authorizeCurrentOperator(req, [capabilities.MANAGE_PROXY]);
      } catch (authorizationError) {
        return res.status(authorizationError.status || 403).json({ error: authorizationError.message });
      }
      try {
        const diagnostic = error?.diagnostic;
        proxyPoolRepository.updateHealth(record.id, {
          status: "failed",
          checkedAt: now().toISOString(),
          errorCode: diagnostic?.code || "P111",
          errorName: diagnostic?.name || "Proxy test failed",
        });
        refreshProxyPoolCache();
        recordAudit({
          operator: currentAtCommit.username,
          type: "proxy_test_failed",
          detail: { proxyId: record.id, errorCode: diagnostic?.code || "P111" },
        }, "Proxy health-failure audit write");
        return sendProxyTestFailure(res, error);
      } catch (commitError) {
        if (sendExpectedError(res, commitError)) return undefined;
        return next(commitError);
      }
    }
  });

  app.delete("/api/admin/proxies/:proxyId", requireCapability(capabilities.MANAGE_PROXY), (req, res, next) => {
    try {
      const deleted = proxyPoolRepository.remove(req.params.proxyId);
      if (!deleted) return res.status(404).json({ error: "unknown proxy" });
      refreshProxyPoolCache();
      recordAudit({
        operator: req.currentOperator.username,
        type: "proxy_pool_deleted",
        detail: { proxyId: req.params.proxyId },
      }, "Proxy pool deletion audit write");
      return res.json({ ok: true });
    } catch (error) {
      if (sendExpectedError(res, error)) return undefined;
      return next(error);
    }
  });

  app.patch("/api/admin/devices/:deviceId/proxy-assignment", requireCapability(capabilities.ASSIGN_PROXY), (req, res, next) => {
    if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
    if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
      return res.status(403).json({ error: "not authorized for this device" });
    }
    if (networkRoutingOrchestrator?.getRoute(req.params.deviceId)) {
      return res.status(409).json({ error: "Stop the active route before changing this phone's proxy assignment." });
    }
    const proxyId = req.body?.proxyId;
    if (proxyId !== null && typeof proxyId !== "string") {
      return res.status(400).json({ error: "proxyId must be a string or null" });
    }
    try {
      proxyPoolRepository.assignToDevice({ deviceId: req.params.deviceId, proxyId });
      invalidateNetworkVerification(req.params.deviceId);
      refreshProxyPoolCache();
      recordAudit({
        operator: req.currentOperator.username,
        type: "proxy_pool_assignment_changed",
        deviceId: req.params.deviceId,
        detail: { proxyId },
      }, "Proxy pool assignment audit write");
      broadcastDeviceList();
      return res.json({ proxy: poolProxyForDevice(req.params.deviceId) });
    } catch (error) {
      if (sendExpectedError(res, error)) return undefined;
      return next(error);
    }
  });
}
