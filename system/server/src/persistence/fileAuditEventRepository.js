import { createAuditLog } from "../auditLog.js";
import { assertAuditEventRepository } from "./auditEventRepository.js";

// Compatibility adapter for the existing append-only JSONL audit store.
// Keeping file construction here gives a future PostgreSQL adapter one
// composition-root switch without changing routes, workers, or schedulers.
export function createFileAuditEventRepository(filePath) {
  return assertAuditEventRepository(createAuditLog(filePath));
}
