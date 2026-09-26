import { assertAuditEventRepository } from "../persistence/auditEventRepository.js";

const DEFAULT_AUDIT_LIMIT = 200;
const MAX_AUDIT_SCAN = 1000;

export function createAuditService({ repository, canAccessDevice }) {
  assertAuditEventRepository(repository);
  if (typeof canAccessDevice !== "function") {
    throw new TypeError("audit service requires canAccessDevice()");
  }

  return {
    // Preserve the established auditLog surface so existing domain modules can
    // move behind this service without a flag-day call-site rewrite.
    logEvent(event) {
      return repository.logEvent(event);
    },

    listEvents(filters) {
      return repository.listEvents(filters);
    },

    listAuthorizedEvents(viewer, { operator: operatorFilter, deviceId, limit = DEFAULT_AUDIT_LIMIT } = {}) {
      const boundedLimit = Math.min(Number(limit) || DEFAULT_AUDIT_LIMIT, MAX_AUDIT_SCAN);
      return repository.listEvents({
        operator: typeof operatorFilter === "string" ? operatorFilter : undefined,
        deviceId: typeof deviceId === "string" ? deviceId : undefined,
        limit: MAX_AUDIT_SCAN,
      }).filter(event => !event.deviceId || canAccessDevice(viewer, event.deviceId)).slice(0, boundedLimit);
    },
  };
}
