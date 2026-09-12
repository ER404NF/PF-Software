// Explicit feature capabilities. Device and research-workspace grants remain
// separate authorization boundaries and must still be checked at the action.

export const OPERATOR_ROLES = Object.freeze({
  ADMIN: "admin",
  MANAGER: "manager",
  VA: "va",
  CONTENT_CREATOR: "content_creator",
  EDITOR: "editor",
});

export const CAPABILITIES = Object.freeze({
  VIEW_FLEET: "fleet:view",
  VIEW_PEOPLE: "people:view",
  CONTROL_DEVICE: "device:control",
  ACCESS_MEDIA: "media:access",
  VIEW_RESEARCH: "research:view",
  OPERATE_RESEARCH: "research:operate",
  REVIEW_RESEARCH: "research:review",
  VIEW_ASSIGNMENTS: "assignments:view",
  MANAGE_ASSIGNMENTS: "assignments:manage",
  MANAGE_QUEUE: "queue:manage",
  MANAGE_GLOBAL_QUEUE: "queue:manage-global",
  MANAGE_AI_CONTROLLER: "ai-controller:manage",
  VIEW_NETWORK_HEALTH: "network-health:view",
  RUN_NETWORK_CHECK: "network-health:verify",
  VIEW_AUDIT: "audit:view-sensitive",
  MANAGE_MODELS: "models:manage",
  MANAGE_USERS: "users:manage",
  MANAGE_ACCESS: "access:manage",
  MANAGE_PROXY: "proxy:manage",
  MANAGE_SECURITY: "security:manage",
  MONITOR_DEVICE: "device:monitor",
});

const lowerOperational = [
  CAPABILITIES.VIEW_FLEET,
  CAPABILITIES.VIEW_PEOPLE,
  CAPABILITIES.VIEW_ASSIGNMENTS,
  CAPABILITIES.VIEW_NETWORK_HEALTH,
];

export const ROLE_CAPABILITIES = Object.freeze({
  [OPERATOR_ROLES.ADMIN]: Object.freeze(Object.values(CAPABILITIES)),
  [OPERATOR_ROLES.MANAGER]: Object.freeze([
    ...lowerOperational,
    CAPABILITIES.CONTROL_DEVICE,
    CAPABILITIES.ACCESS_MEDIA,
    CAPABILITIES.VIEW_RESEARCH,
    CAPABILITIES.OPERATE_RESEARCH,
    CAPABILITIES.REVIEW_RESEARCH,
    CAPABILITIES.MANAGE_ASSIGNMENTS,
    CAPABILITIES.MANAGE_QUEUE,
    CAPABILITIES.MANAGE_AI_CONTROLLER,
    CAPABILITIES.RUN_NETWORK_CHECK,
    CAPABILITIES.MONITOR_DEVICE,
  ]),
  [OPERATOR_ROLES.VA]: Object.freeze([
    ...lowerOperational,
    CAPABILITIES.CONTROL_DEVICE,
    CAPABILITIES.ACCESS_MEDIA,
    CAPABILITIES.VIEW_RESEARCH,
    CAPABILITIES.OPERATE_RESEARCH,
    CAPABILITIES.REVIEW_RESEARCH,
  ]),
  [OPERATOR_ROLES.CONTENT_CREATOR]: Object.freeze([
    ...lowerOperational,
    CAPABILITIES.ACCESS_MEDIA,
    CAPABILITIES.VIEW_RESEARCH,
    CAPABILITIES.OPERATE_RESEARCH,
    CAPABILITIES.REVIEW_RESEARCH,
  ]),
  [OPERATOR_ROLES.EDITOR]: Object.freeze([
    ...lowerOperational,
    CAPABILITIES.ACCESS_MEDIA,
    CAPABILITIES.VIEW_RESEARCH,
    CAPABILITIES.REVIEW_RESEARCH,
  ]),
});

const knownRoles = new Set(Object.values(OPERATOR_ROLES));
const knownCapabilities = new Set(Object.values(CAPABILITIES));

export function normalizeRole(role) {
  return knownRoles.has(role) ? role : OPERATOR_ROLES.VA;
}

export function capabilitiesForRole(role) {
  return [...ROLE_CAPABILITIES[normalizeRole(role)]];
}

export function hasCapability(operator, capability) {
  return Boolean(operator) && knownCapabilities.has(capability)
    && ROLE_CAPABILITIES[normalizeRole(operator.role)].includes(capability);
}
