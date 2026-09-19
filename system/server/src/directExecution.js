// "Was this file started directly (node index.js), or only imported?" - decided without being fooled by symlinks.
//
// The obvious check, `import.meta.url === pathToFileURL(process.argv[1]).href`, is wrong whenever any folder on the
// path is a symlink: Node resolves symlinks for import.meta.url but leaves process.argv[1] as it was given. On macOS the
// temporary folder is /var/... while its real location is /private/var/..., so a server started from a temp folder (as the
// installer's own verification does) decided it was merely imported, skipped listen(), and exited with code 0.
// Both sides are therefore compared by real path.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isDirectExecution(metaUrl, argv1 = process.argv[1], { realpath = fs.realpathSync.native, platform = process.platform } = {}) {
  if (!metaUrl || !argv1) return false;
  let module;
  let entry;
  try {
    module = realpath(fileURLToPath(metaUrl));
    entry = realpath(path.resolve(argv1));
  } catch {
    return false; // a path that does not exist cannot be the file that is running
  }
  // Windows file names are case-insensitive.
  return platform === "win32" ? module.toLowerCase() === entry.toLowerCase() : module === entry;
}
