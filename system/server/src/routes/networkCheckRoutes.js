// Network checks can change fail-closed queue/routing state, so this module
// accepts every authoritative owner explicitly instead of creating parallel
// caches. It also re-resolves the requester after each long-running probe
// before returning network details or writing requester-attributed audit data.
export function registerNetworkCheckRoutes({
  app,
  hasCapability,
  runNetworkCheckCapability,
  manageRoutingCapability,
  knownDevice,
  canAccessDevice,
  deviceNetwork,
  isProxyEgress,
  resolveNetworkCheckTarget,
  poolProxyForDevice,
  proxyCredentialEncryptionKey,
  proxyPoolRepository,
  testProxy,
  decryptProxyPassword,
  refreshProxyPoolCache,
  networkRoutingOrchestrator = null,
  getNetworkRoutingOrchestrator = () => networkRoutingOrchestrator,
  networkVerifier,
  networkDecision,
  taskQueue,
  wss,
  broadcastDeviceList,
  identityService,
  auditLog,
  recordAudit = event => auditLog.logEvent(event),
  publicNetworkConfig,
  withNetworkEgress,
}) {
  const routingOrchestrator = () => getNetworkRoutingOrchestrator?.() ?? null;
  const stopUnauthorizedNetworkWork = deviceId => {
    taskQueue.stopDevice(deviceId, "network_policy");
    for (const client of wss.clients) client.releaseUnauthorizedSelection?.("network_policy");
  };

  const resolveCurrentRequester = async req => {
    const current = await identityService.resolveSessionPrincipal(req.session?.operator);
    if (!current) return { status: 401, error: "authentication required" };
    if (!hasCapability(current, runNetworkCheckCapability)) {
      return { status: 403, error: "network verification is not permitted for this role" };
    }
    if (!canAccessDevice(current, req.params.deviceId)) {
      return { status: 403, error: "not authorized for this device" };
    }
    return { current };
  };

  // Production checks use the server-side configured URL. Tests may opt into
  // a disposable caller URL explicitly; arbitrary normal-mode targets would
  // turn this privileged feature into an SSRF path.
  app.post("/api/devices/:deviceId/network-check", async (req, res) => {
    if (!hasCapability(req.currentOperator, runNetworkCheckCapability)) {
      return res.status(403).json({ error: "network verification is not permitted for this role" });
    }
    if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
    if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
      return res.status(403).json({ error: "not authorized for this device" });
    }
    let requesterAtStart;
    try { requesterAtStart = await resolveCurrentRequester(req); }
    catch { return res.status(503).json({ error: "could not revalidate network-check authorization" }); }
    if (!requesterAtStart.current) return res.status(requesterAtStart.status).json({ error: requesterAtStart.error });
    const authorize = async () => {
      const requester = await resolveCurrentRequester(req);
      if (!requester.current) {
        const error = new Error(requester.error);
        error.status = requester.status;
        throw error;
      }
    };
    const configuredNetwork = deviceNetwork.get(req.params.deviceId);
    if (isProxyEgress(configuredNetwork?.egress) && configuredNetwork?.enabled === false) {
      return res.status(409).json({ error: "network verification is unavailable while this proxy assignment is disabled" });
    }

    let checkUrl;
    try {
      checkUrl = resolveNetworkCheckTarget({
        configuredUrl: configuredNetwork?.checkUrl,
        requestedUrl: req.body?.checkUrl,
      });
    } catch (error) {
      return res.status(error.status ?? 400).json({ error: error.message });
    }

    if (typeof checkUrl !== "string" || checkUrl.length === 0) {
      const assigned = poolProxyForDevice(req.params.deviceId);
      if (!assigned) {
        return res.status(409).json({
          error: "No automatic network verification path is available until a saved proxy is assigned to this phone.",
          code: "V201",
        });
      }
      if (!proxyCredentialEncryptionKey) {
        return res.status(503).json({
          error: "proxy verification is unavailable until the credential encryption key is configured",
          code: "V201",
        });
      }
      const record = proxyPoolRepository.get(assigned.id);
      if (!record) return res.status(409).json({ error: "the assigned proxy no longer exists", code: "V201" });
      const verificationGeneration = networkVerifier.getGeneration(req.params.deviceId);

      void (async () => {
        await authorize();
        const proxyResult = await testProxy({
          protocol: record.protocol,
          host: record.host,
          port: record.port,
          username: record.username,
          password: decryptProxyPassword(record, proxyCredentialEncryptionKey),
          country: record.country,
        });
        await authorize();
        proxyPoolRepository.updateHealth(record.id, proxyResult);
        refreshProxyPoolCache();
        await routingOrchestrator()?.checkHealth();
        await authorize();
        return networkVerifier.recordInfrastructureCheck(req.params.deviceId, {
          proxyResult,
          route: routingOrchestrator()?.getRoute(req.params.deviceId) ?? null,
          generation: verificationGeneration,
        });
      })().then(async result => {
        const access = networkDecision(req.params.deviceId);
        if (!access.allowed) stopUnauthorizedNetworkWork(req.params.deviceId);
        broadcastDeviceList();

        const requester = await resolveCurrentRequester(req);
        if (!requester.current) return res.status(requester.status).json({ error: requester.error });
        recordAudit({
          operator: requester.current.username,
          type: "network_check",
          deviceId: req.params.deviceId,
          detail: withNetworkEgress(req.params.deviceId, {
            proxyId: record.id, level: result.networkVerificationLevel, protected: false,
          }),
        });
        res.json({ network: { ...(publicNetworkConfig(configuredNetwork) ?? {}), ...result } });
      }).catch(error => {
        if ([401, 403].includes(error?.status)) return res.status(error.status).json({ error: error.message });
        console.error("Automatic proxy verification failed:", error?.code || error?.name || "Error");
        const diagnostic = error?.diagnostic;
        res.status(error?.status || 502).json({
          error: diagnostic?.name || "network verification failed",
          code: diagnostic?.code || "V201",
          diagnostic: diagnostic || null,
        });
      });
      return;
    }

    networkVerifier.checkDevice(req.params.deviceId, checkUrl, {
      authorize,
      proveCurrentRoute: isProxyEgress(configuredNetwork?.egress)
        ? () => routingOrchestrator()?.verifyCurrentRoute?.(req.params.deviceId) ?? false
        : null,
    })
      .then(async result => {
        await authorize();
        if (result.networkMismatch && isProxyEgress(configuredNetwork?.egress)) {
          await routingOrchestrator()?.quarantineRoute(req.params.deviceId, {
            code: result.networkLatestError?.code || "V204",
            why: result.networkMismatchReason || "End-to-end verification detected an unexpected route.",
          });
        }
        const access = networkDecision(req.params.deviceId);
        if (!access.allowed) stopUnauthorizedNetworkWork(req.params.deviceId);
        else taskQueue.tick(new Date());
        broadcastDeviceList();

        const requester = await resolveCurrentRequester(req);
        if (!requester.current) return res.status(requester.status).json({ error: requester.error });
        recordAudit({
          operator: requester.current.username,
          type: "network_check",
          deviceId: req.params.deviceId,
          detail: withNetworkEgress(req.params.deviceId, {
            observedIp: result.networkObservedIp,
            verified: result.networkVerified,
            mismatch: result.networkMismatch,
            mismatchReason: result.networkMismatchReason,
          }),
        });
        res.json({ network: { ...(publicNetworkConfig(configuredNetwork) ?? {}), ...result } });
      })
      .catch(error => {
        if ([401, 403].includes(error?.status)) return res.status(error.status).json({ error: error.message });
        console.error("Network verification failed:", error?.code || error?.name || "Error");
        res.status(502).json({ error: "network verification failed", code: "NETWORK_CHECK_FAILED" });
      });
  });

  app.post("/api/devices/:deviceId/network-attestation", async (req, res) => {
    if (!hasCapability(req.currentOperator, manageRoutingCapability)) {
      return res.status(403).json({ error: "phone network confirmation is not permitted for this role" });
    }
    if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
    if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
      return res.status(403).json({ error: "not authorized for this device" });
    }
    let currentAtCommit = null;
    const authorize = async () => {
      const current = await identityService.resolveSessionPrincipal(req.session?.operator);
      if (!current || !hasCapability(current, manageRoutingCapability)
        || !canAccessDevice(current, req.params.deviceId)) {
        const error = new Error("authorization changed while confirming the phone network");
        error.status = current ? 403 : 401;
        throw error;
      }
      currentAtCommit = current;
      return currentAtCommit;
    };
    try {
      await authorize();
      const configuredNetwork = deviceNetwork.get(req.params.deviceId);
      const result = await networkVerifier.recordDeviceEvidence(req.params.deviceId, req.body, {
        authorize,
        proveCurrentRoute: isProxyEgress(configuredNetwork?.egress)
          ? () => routingOrchestrator()?.verifyCurrentRoute?.(req.params.deviceId) ?? false
          : null,
      });
      if (!currentAtCommit) throw new Error("phone network confirmation authorization was not checked");
      taskQueue.tick(new Date());
      broadcastDeviceList();
      recordAudit({
        operator: currentAtCommit.username,
        type: "phone_network_attested",
        deviceId: req.params.deviceId,
        detail: withNetworkEgress(req.params.deviceId, {
          observedIp: result.networkObservedIp,
          ipv6Observed: Boolean(result.networkObservedIpv6),
          level: result.networkVerificationLevel,
        }),
      });
      res.json({ network: { ...(publicNetworkConfig(configuredNetwork) ?? {}), ...result } });
    } catch (error) {
      if ([400, 401, 403, 409].includes(error?.status)) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Phone network confirmation failed:", error?.code || error?.name || "Error");
      res.status(500).json({ error: "phone network confirmation failed" });
    }
  });
}
