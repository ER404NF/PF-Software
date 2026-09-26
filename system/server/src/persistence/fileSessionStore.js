import { FileSessionStore } from "../fileSessionStore.js";
import { assertSessionStore } from "./sessionStore.js";

// Compatibility adapter for the current owner-only per-session files and
// revocation tombstones. A future database-backed adapter must satisfy the
// same express-session callback contract before the composition root changes.
export function createFileSessionStore(directory, options) {
  return assertSessionStore(new FileSessionStore(directory, options));
}
