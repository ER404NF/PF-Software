import { pushFileToDevice } from "../filePushOrchestrator.js";

// Register the short-lived Safari download link and the bounded WDA-driven
// push flow. The composition root retains every authoritative dependency:
// media storage, link storage, identity lookup, device grants, and input mode.
export function registerFilePushRoutes({
  app,
  hasCapability,
  accessMediaCapability,
  knownDevice,
  canAccessDevice,
  deviceMediaRepository,
  filePushLinkStore,
  auditLog,
  hubOrigin,
  deviceLease,
  devices,
  currentStoredOperator,
  recordAudit = event => auditLog.logEvent(event),
}) {
  function issuePushLinkOrRespond(req, res) {
    if (!hasCapability(req.currentOperator, accessMediaCapability)) {
      res.status(403).json({ error: "media access is not permitted for this role" });
      return null;
    }
    if (!knownDevice(req.params.deviceId)) {
      res.status(404).json({ error: "unknown device" });
      return null;
    }
    if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
      res.status(403).json({ error: "not authorized for this device" });
      return null;
    }
    if (!deviceMediaRepository.resolveFile(req.params.deviceId, req.params.filename)) {
      res.status(404).json({ error: "unknown file" });
      return null;
    }
    const { token, expiresAt } = filePushLinkStore.issue({
      deviceId: req.params.deviceId,
      filename: req.params.filename,
      issuedBy: req.currentOperator.username,
    });
    recordAudit({
      operator: req.currentOperator.username,
      type: "file_push_link_issued",
      deviceId: req.params.deviceId,
      detail: { name: req.params.filename, expiresAt },
    }, "File-push link issuance audit write");
    return { url: `${hubOrigin(req)}/d/${token}`, expiresAt };
  }

  app.post("/api/devices/:deviceId/files/:filename/push-link", (req, res) => {
    const result = issuePushLinkOrRespond(req, res);
    if (result) res.json(result);
  });

  // Deliberately unauthenticated by operator session. The short-lived,
  // single-use token alone binds the exact device and filename, and is
  // consumed before file resolution so a network retry cannot replay it.
  app.get("/d/:token", (req, res) => {
    const consumed = filePushLinkStore.consume(req.params.token);
    if (!consumed) return res.status(404).end();
    const full = deviceMediaRepository.resolveFile(consumed.deviceId, consumed.filename);
    recordAudit({
      operator: "system",
      type: "file_push_link_consumed",
      deviceId: consumed.deviceId,
      detail: { name: consumed.filename, resolved: Boolean(full) },
    }, "File-push link consumption audit write");
    if (!full) return res.status(404).end();
    res.download(full);
  });

  app.post("/api/devices/:deviceId/files/:filename/push", async (req, res) => {
    // Check input mode only after authorization-visible fields pass, so the
    // response does not disclose an inaccessible device's controller mode.
    if (req.currentOperator && knownDevice(req.params.deviceId)
      && canAccessDevice(req.currentOperator, req.params.deviceId)
      && deviceLease.getMode(req.params.deviceId) !== "HUMAN") {
      return res.status(409).json({ error: "this device must be in Human VA mode before pushing a file to it" });
    }
    const issued = issuePushLinkOrRespond(req, res);
    if (!issued) return;
    const operator = req.currentOperator;
    const deviceId = req.params.deviceId;
    const result = await pushFileToDevice({
      device: devices.get(deviceId),
      url: issued.url,
      canExecute: async () => {
        const current = await currentStoredOperator(req);
        return Boolean(current
          && hasCapability(current, accessMediaCapability)
          && canAccessDevice(current, deviceId)
          && deviceLease.getMode(deviceId) === "HUMAN");
      },
    });
    recordAudit({
      operator: operator.username,
      type: "file_pushed_to_device",
      deviceId,
      detail: { name: req.params.filename, ...result },
    }, "Device file-push result audit write");
    res.json({ push: result });
  });
}
