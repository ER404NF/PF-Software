import test from "node:test";
import assert from "node:assert/strict";
import { registerAuditPeopleRoutes } from "../../src/routes/auditPeopleRoutes.js";

function fixture() {
  const routes = new Map();
  const capabilities = {
    VIEW_AUDIT: "audit:view",
    VIEW_PEOPLE: "people:view",
    MANAGE_ASSIGNMENTS: "assignments:manage",
  };
  const requireCapability = capability => `require:${capability}`;
  const app = {
    get(path, ...handlers) { routes.set(path, handlers); },
  };
  const auditCalls = [];
  const viewer = { username: "manager", allowedDevices: ["phone-a"] };
  const dependencies = {
    app,
    requireCapability,
    capabilities,
    auditLog: {
      listAuthorizedEvents(operator, filters) {
        auditCalls.push({ operator, filters });
        return [{ id: "event-1" }];
      },
    },
    listAssignments: () => [
      { id: "visible", assignee: "va-1", deviceId: "phone-a", status: "assigned", startAt: null, endAt: null },
      { id: "hidden", assignee: "va-2", deviceId: "phone-b", status: "in_progress" },
    ],
    listPeople: () => [
      { username: "va-1", currentDeviceIds: ["phone-a", "phone-b"] },
      { username: "va-2", currentDeviceIds: ["phone-b"] },
    ],
    deviceLabelFor: id => id === "phone-a" ? "Phone A" : id,
    canViewAssignment: (assignment, current) => current === viewer && assignment.id === "visible",
    hasCapability: (current, capability) => current === viewer && capability === capabilities.MANAGE_ASSIGNMENTS,
    canManagePerson: (current, username) => current === viewer && username === "va-1",
    canAccessDevice: (current, deviceId) => current === viewer && deviceId === "phone-a",
  };
  return { routes, capabilities, viewer, auditCalls, dependencies };
}

test("registerAuditPeopleRoutes preserves capability middleware and audit filtering", () => {
  const { routes, capabilities, viewer, auditCalls, dependencies } = fixture();
  const { authorizedAuditEvents } = registerAuditPeopleRoutes(dependencies);

  assert.equal(routes.get("/api/audit")[0], `require:${capabilities.VIEW_AUDIT}`);
  assert.equal(routes.get("/api/people")[0], `require:${capabilities.VIEW_PEOPLE}`);
  assert.deepEqual(authorizedAuditEvents(viewer, { operator: "va-1", deviceId: "phone-a", limit: 4 }), [
    { id: "event-1" },
  ]);
  assert.deepEqual(auditCalls, [{
    operator: viewer,
    filters: { operator: "va-1", deviceId: "phone-a", limit: 4 },
  }]);
});

test("publicPeople keeps assignment and device metadata inside the viewer's grants", () => {
  const { viewer, dependencies } = fixture();
  const { publicPeople } = registerAuditPeopleRoutes(dependencies);

  assert.deepEqual(publicPeople(viewer), [
    {
      username: "va-1",
      currentDeviceIds: ["phone-a"],
      currentPhones: [{ id: "phone-a", label: "Phone A" }],
      canAssign: true,
      assignment: {
        id: "visible",
        deviceId: "phone-a",
        status: "assigned",
        startAt: null,
        endAt: null,
      },
    },
    {
      username: "va-2",
      currentDeviceIds: [],
      currentPhones: [],
      canAssign: false,
      assignment: null,
    },
  ]);
});

test("publicPeople fails closed without a viewer", () => {
  const { dependencies } = fixture();
  const { publicPeople } = registerAuditPeopleRoutes(dependencies);

  assert.deepEqual(publicPeople(null).map(person => ({
    username: person.username,
    currentDeviceIds: person.currentDeviceIds,
    currentPhones: person.currentPhones,
    assignment: person.assignment,
    canAssign: person.canAssign,
  })), [
    { username: "va-1", currentDeviceIds: [], currentPhones: [], assignment: null, canAssign: false },
    { username: "va-2", currentDeviceIds: [], currentPhones: [], assignment: null, canAssign: false },
  ]);
});
