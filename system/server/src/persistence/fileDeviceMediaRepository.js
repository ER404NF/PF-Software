import { ensureDeviceDir, listFiles, resolveFile, deleteFile } from "../fileStore.js";
import { assertDeviceMediaRepository } from "./deviceMediaRepository.js";

// Adapts the existing fileStore.js functions (fixed MEDIA_ROOT from
// FILE_STORE_DIR/default) to the device media repository port. No storage
// format or behavior changes: every method delegates unchanged, with
// injectable overrides for tests.
export function createFileDeviceMediaRepository(overrides = {}) {
  return assertDeviceMediaRepository({
    ensureDeviceDir: overrides.ensureDeviceDir ?? ensureDeviceDir,
    listFiles: overrides.listFiles ?? listFiles,
    resolveFile: overrides.resolveFile ?? resolveFile,
    deleteFile: overrides.deleteFile ?? deleteFile,
  });
}
