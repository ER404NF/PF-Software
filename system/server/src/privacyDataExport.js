const ACCOUNT_FIELDS = Object.freeze([
  "username", "email", "fullName", "role", "teamId", "allowedDevices",
  "allowedResearchWorkspaces", "active", "accountStatus", "twoFactorRequired",
  "twoFactorEnabled", "isMainHost", "securityFlagReason", "securityFlaggedAt",
  "bannedReason", "bannedAt", "privacyDeletionState",
  "privacyDeletionRequestedAt",
]);
const MAX_ITEMS_PER_CATEGORY = 1000;

function select(source, fields) {
  if (!source || typeof source !== "object") return {};
  return Object.fromEntries(fields.filter(field => source[field] !== undefined)
    .map(field => [field, structuredClone(source[field])]));
}

function personalAssignment(assignment, username) {
  if (assignment?.assignee !== username) return null;
  return select(assignment, [
    "id", "instructions", "deviceId", "accountId", "startAt", "endAt",
    "exclusive", "recurrence", "timezone", "occurrence", "status",
    "createdAt", "updatedAt", "lastCompletedAt",
  ]);
}

function personalTask(task, username) {
  if (task?.createdBy !== username) return null;
  return select(task, [
    "id", "kind", "goal", "deviceSelector", "accountSelector", "criteria",
    "allowedActions", "requiredActions", "earliestStart", "latestEnd",
    "maxDurationSec", "priority", "dependencies", "retryPolicy", "retryCount",
    "retryNotBefore", "allowOverrun", "clientRequestId", "createdAt", "updatedAt",
    "state",
  ]);
}

function personalAuditMetadata(event, username) {
  if (event?.operator !== username) return null;
  // Audit detail can reference another operator, private typed content, or a
  // shared account. Export the caller's activity metadata without copying
  // that unclassified payload across the privacy boundary.
  return select(event, ["id", "at", "type", "deviceId"]);
}

export function createPrivacyDataExport({
  username,
  account,
  assignments = [],
  tasks = [],
  auditEvents = [],
  privacyRequests = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  if (typeof username !== "string" || !username) throw new TypeError("privacy export requires username");
  if (!account || account.username !== username) throw new Error("privacy export account not found");
  for (const [name, value] of Object.entries({ assignments, tasks, auditEvents, privacyRequests })) {
    if (!Array.isArray(value)) throw new TypeError(`privacy export ${name} must be an array`);
  }
  if (!Number.isFinite(Date.parse(generatedAt))) throw new TypeError("privacy export generatedAt is invalid");

  const personalAssignments = assignments.map(item => personalAssignment(item, username)).filter(Boolean);
  const personalTasks = tasks.map(item => personalTask(item, username)).filter(Boolean);
  const personalAuditEvents = auditEvents.map(item => personalAuditMetadata(item, username)).filter(Boolean);
  const personalPrivacyRequests = privacyRequests.map(item => select(item,
    ["id", "source", "status", "createdAt", "updatedAt", "identityVerifiedAt"]));
  return {
    schemaVersion: 1,
    generatedAt,
    account: select(account, ACCOUNT_FIELDS),
    assignments: personalAssignments.slice(0, MAX_ITEMS_PER_CATEGORY),
    tasks: personalTasks.slice(0, MAX_ITEMS_PER_CATEGORY),
    auditEvents: personalAuditEvents.slice(0, MAX_ITEMS_PER_CATEGORY),
    privacyRequests: personalPrivacyRequests.slice(0, MAX_ITEMS_PER_CATEGORY),
    coverage: {
      limitPerCategory: MAX_ITEMS_PER_CATEGORY,
      truncated: {
        assignments: personalAssignments.length > MAX_ITEMS_PER_CATEGORY,
        tasks: personalTasks.length > MAX_ITEMS_PER_CATEGORY,
        auditEvents: personalAuditEvents.length > MAX_ITEMS_PER_CATEGORY,
        privacyRequests: personalPrivacyRequests.length > MAX_ITEMS_PER_CATEGORY,
      },
      included: [
        "account_profile",
        "assignments_as_assignee",
        "tasks_created_by_account",
        "audit_event_metadata",
        "privacy_request_status",
      ],
      notIncluded: [
        "shared media and research evidence that do not yet record an account owner",
        "audit detail payloads that can contain third-party or private operational data",
        "task execution results and evidence references that can contain shared platform data",
      ],
    },
  };
}
