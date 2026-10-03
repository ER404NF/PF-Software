import fs from "fs";
import path from "path";
import { safeFilename, stagedMediaContentReason } from "../fileStore.js";

export function registerMediaRoutes({
  app,
  upload,
  mediaQuota,
  deviceMediaRepository,
  hasCapability,
  accessMediaCapability,
  knownDevice,
  canAccessDevice,
  currentStoredOperator,
  auditLog,
  recordAudit = event => auditLog.logEvent(event),
  withNetworkEgress,
}) {
  const authorizeMedia = (operator, deviceId) => {
    if (!hasCapability(operator, accessMediaCapability)) {
      return { status: 403, error: "media access is not permitted for this role" };
    }
    if (!knownDevice(deviceId)) return { status: 404, error: "unknown device" };
    if (!canAccessDevice(operator, deviceId)) return { status: 403, error: "not authorized for this device" };
    return null;
  };

  app.get("/api/devices/:deviceId/files", (req, res) => {
    const denied = authorizeMedia(req.currentOperator, req.params.deviceId);
    if (denied) return res.status(denied.status).json({ error: denied.error });
    res.json({ files: deviceMediaRepository.listFiles(req.params.deviceId) });
  });

  app.post("/api/devices/:deviceId/files", (req, res, next) => {
    const denied = authorizeMedia(req.currentOperator, req.params.deviceId);
    if (denied) return res.status(denied.status).json({ error: denied.error });
    next();
  }, upload.single("file"), async (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: "no file, or invalid filename" });
    const name = safeFilename(req.file.originalname);
    const discardStagedUpload = () => {
      mediaQuota.abort(req.file.quotaReservation);
      fs.rmSync(req.file.path, { force: true });
    };
    try {
      if (!name) throw new Error("invalid filename");
      const current = await currentStoredOperator(req);
      if (!current) {
        discardStagedUpload();
        return res.status(401).json({ error: "not logged in" });
      }
      if (authorizeMedia(current, req.params.deviceId)) {
        discardStagedUpload();
        return res.status(403).json({ error: "media access is no longer permitted for this device" });
      }
      req.currentOperator = current;
      const contentReason = stagedMediaContentReason(req.file.path, name);
      if (contentReason) {
        const error = new Error(contentReason);
        error.code = "MEDIA_CONTENT_REJECTED";
        throw error;
      }
      // Same-directory rename commits only a fully validated multipart upload.
      // A failed replacement preserves the old file; never unlink it first.
      fs.renameSync(req.file.path, path.join(req.file.destination, name));
      mediaQuota.commit(req.file.quotaReservation);
    } catch (error) {
      discardStagedUpload();
      return next(error);
    }
    recordAudit({
      operator: req.currentOperator.username,
      type: "file_uploaded",
      deviceId: req.params.deviceId,
      detail: withNetworkEgress(req.params.deviceId, { name, size: req.file.size }),
    });
    res.json({ ok: true, name, size: req.file.size });
  });

  app.get("/api/devices/:deviceId/files/:filename", (req, res) => {
    const denied = authorizeMedia(req.currentOperator, req.params.deviceId);
    if (denied) return res.status(denied.status).end();
    const full = deviceMediaRepository.resolveFile(req.params.deviceId, req.params.filename);
    if (!full) return res.status(404).end();
    recordAudit({
      operator: req.currentOperator.username,
      type: "file_downloaded",
      deviceId: req.params.deviceId,
      detail: withNetworkEgress(req.params.deviceId, { name: req.params.filename }),
    });
    res.download(full);
  });

  app.delete("/api/devices/:deviceId/files/:filename", (req, res) => {
    const denied = authorizeMedia(req.currentOperator, req.params.deviceId);
    if (denied) return res.status(denied.status).end();
    const deleted = deviceMediaRepository.deleteFile(req.params.deviceId, req.params.filename);
    recordAudit({
      operator: req.currentOperator.username,
      type: "file_deleted",
      deviceId: req.params.deviceId,
      detail: withNetworkEgress(req.params.deviceId, { name: req.params.filename, deleted }),
    });
    res.json({ ok: deleted });
  });
}
