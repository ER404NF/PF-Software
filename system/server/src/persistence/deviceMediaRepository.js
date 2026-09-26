// Persistence port for per-device file storage (fileStore.js's MEDIA_ROOT
// tree — content moving on/off a phone). Path-safety validators
// (safeFilename, safeDeviceId, deviceDir) and the cross-tree isolation
// assertion stay as direct fileStore.js imports; they are pure checks, not
// storage operations.

export const DEVICE_MEDIA_REPOSITORY_METHODS = Object.freeze([
  "ensureDeviceDir",
  "listFiles",
  "resolveFile",
  "deleteFile",
]);

export function assertDeviceMediaRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("device media repository must be an object");
  }
  for (const method of DEVICE_MEDIA_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`device media repository requires ${method}()`);
    }
  }
  return repository;
}
