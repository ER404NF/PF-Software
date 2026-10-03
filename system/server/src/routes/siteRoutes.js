import { SiteError } from "../siteStore.js";

function respondWithSiteError(res, error, next) {
  if (error instanceof SiteError) {
    return res.status(error.code === "unknown_site" ? 404 : error.code === "duplicate_site" ? 409 : 400)
      .json({ error: error.message, code: error.code });
  }
  return next(error);
}

function authorizationError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function registerSiteRoutes({
  app,
  siteStore,
  siteLinkHub,
  requireCapability,
  manageSitesCapability,
  auditLog,
  recordAudit = event => auditLog.logEvent(event),
  hubOrigin,
  schedulingTimeZone,
  broadcastDeviceList,
  currentStoredOperator,
  hasCapability,
}) {
  const publicSite = site => ({ ...site, ...siteLinkHub.siteStatus(site.id) });

  async function authorizeMutation(req) {
    const current = await currentStoredOperator(req);
    if (!current) throw authorizationError("authentication required", 401, "AUTHENTICATION_REQUIRED");
    if (!hasCapability(current, manageSitesCapability)) {
      throw authorizationError("site management is not permitted", 403, "SITE_MANAGEMENT_FORBIDDEN");
    }
    return current;
  }

  function respondWithMutationError(res, error, next) {
    if (error?.status === 401 || error?.status === 403) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return respondWithSiteError(res, error, next);
  }

  app.get("/api/admin/sites", requireCapability(manageSitesCapability), async (req, res, next) => {
    try {
      const sites = await siteStore.list();
      await authorizeMutation(req);
      res.json({ sites: sites.map(publicSite), defaultTimeZone: schedulingTimeZone });
    } catch (error) {
      respondWithMutationError(res, error, next);
    }
  });

  app.post("/api/admin/sites", requireCapability(manageSitesCapability), async (req, res, next) => {
    try {
      let currentAtCommit = null;
      const { site, token } = await siteStore.create(
        { name: req.body?.name, timeZone: req.body?.timeZone || undefined },
        { authorize: async () => { currentAtCommit = await authorizeMutation(req); return currentAtCommit; } },
      );
      if (!currentAtCommit) throw new Error("site repository did not perform its required commit authorization");
      recordAudit({ operator: currentAtCommit.username, type: "site_created",
        detail: { siteId: site.id, name: site.name, timeZone: site.timeZone } });
      // The token is shown this once; only its hash is stored.
      res.status(201).json({ site: publicSite(site), token, hubUrl: hubOrigin(req) });
    } catch (error) {
      respondWithMutationError(res, error, next);
    }
  });

  app.patch("/api/admin/sites/:siteId", requireCapability(manageSitesCapability), async (req, res, next) => {
    try {
      let currentAtCommit = null;
      const site = await siteStore.update(
        req.params.siteId,
        { name: req.body?.name, timeZone: req.body?.timeZone },
        { authorize: async () => { currentAtCommit = await authorizeMutation(req); return currentAtCommit; } },
      );
      if (!currentAtCommit) throw new Error("site repository did not perform its required commit authorization");
      recordAudit({ operator: currentAtCommit.username, type: "site_updated",
        detail: { siteId: site.id, name: site.name, timeZone: site.timeZone } });
      broadcastDeviceList();
      res.json({ site: publicSite(site) });
    } catch (error) {
      respondWithMutationError(res, error, next);
    }
  });

  app.post("/api/admin/sites/:siteId/rotate-token", requireCapability(manageSitesCapability), async (req, res, next) => {
    try {
      let currentAtCommit = null;
      const { site, token } = await siteStore.rotate(req.params.siteId, {
        authorize: async () => { currentAtCommit = await authorizeMutation(req); return currentAtCommit; },
      });
      if (!currentAtCommit) throw new Error("site repository did not perform its required commit authorization");
      siteLinkHub.disconnect(site.id); // the agent holding the old token is cut off at once
      recordAudit({ operator: currentAtCommit.username, type: "site_token_rotated", detail: { siteId: site.id } });
      res.json({ site: publicSite(site), token, hubUrl: hubOrigin(req) });
    } catch (error) {
      respondWithMutationError(res, error, next);
    }
  });

  app.delete("/api/admin/sites/:siteId", requireCapability(manageSitesCapability), async (req, res, next) => {
    try {
      const site = await siteStore.get(req.params.siteId);
      if (!site) return res.status(404).json({ error: "Unknown site.", code: "unknown_site" });
      // Revoke the token before closing the socket. Otherwise the agent can reconnect
      // between close and durable removal and re-register removed phones.
      let currentAtCommit = null;
      await siteStore.remove(site.id, {
        authorize: async () => { currentAtCommit = await authorizeMutation(req); return currentAtCommit; },
      });
      if (!currentAtCommit) throw new Error("site repository did not perform its required commit authorization");
      siteLinkHub.removeSite(site.id);
      recordAudit({ operator: currentAtCommit.username, type: "site_removed",
        detail: { siteId: site.id, name: site.name } });
      res.json({ ok: true });
    } catch (error) {
      respondWithMutationError(res, error, next);
    }
  });
}
