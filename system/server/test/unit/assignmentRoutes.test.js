import test from "node:test";
import assert from "node:assert/strict";
import { createAssignmentAccess, registerAssignmentRoutes } from "../../src/routes/assignmentRoutes.js";

function createApp() {
  const routes = new Map();
  const add = method => (path, middleware, handler) => routes.set(`${method} ${path}`, { middleware, handler });
  return { app: { get: add("GET"), post: add("POST"), patch: add("PATCH") }, routes };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setup({ assignments = [], create = null } = {}) {
  const { app, routes } = createApp();
  const capabilities = { VIEW_ASSIGNMENTS: "assignments:view", MANAGE_ASSIGNMENTS: "assignments:manage" };
  const middlewareCalls = [];
  const requireCapability = capability => {
    middlewareCalls.push(capability);
    return { capability };
  };
  const operators = new Map([
    ["manager", { username: "manager", role: "manager", allowedDevices: ["device-a"] }],
    ["worker", { username: "worker", role: "va", allowedDevices: ["device-a"] }],
    ["outsider", { username: "outsider", role: "va", allowedDevices: ["device-b"] }],
  ]);
  const access = createAssignmentAccess({
    hasDevice: id => ["device-a", "device-b"].includes(id),
    hasResearchAccount: id => id === "account-a",
    canAccessDevice: (operator, id) => operator.allowedDevices.includes(id),
    researchWorkspaceFor: (operator, id) => id === "account-a" && operator.username !== "outsider",
    operatorForUsername: username => operators.get(username) ?? null,
    hasCapability: operator => operator.role === "manager",
    manageAssignmentsCapability: capabilities.MANAGE_ASSIGNMENTS,
    canManagePerson: (operator, username) => operator.role === "manager" && username !== "outsider",
    canSelfProgress: role => ["va", "content_creator", "editor"].includes(role),
  });
  const assignmentStore = {
    list: () => assignments,
    get: id => assignments.find(item => item.id === id) ?? null,
    create: create ?? (input => ({ id: "new", status: "assigned", occurrence: 1, ...input })),
    reassign() { throw new Error("not used"); },
    setStatus(id, status, actor) { return { ...this.get(id), status, history: [{ actor }] }; },
    reschedule() { throw new Error("not used"); },
  };
  registerAssignmentRoutes({
    app,
    requireCapability,
    capabilities,
    assignmentStatuses: ["assigned", "in_progress", "completed"],
    assignmentStore,
    access,
    expireAssignments() {},
    operatorForUsername: username => operators.get(username) ?? null,
    hasCapability: operator => operator.role === "manager",
    canManagePerson: (operator, username) => operator.role === "manager" && username !== "outsider",
    canSelfProgress: role => ["va", "content_creator", "editor"].includes(role),
    logAuditBestEffort() {},
    broadcastDeviceList() {},
    broadcastPresence() {},
  });
  return { routes, middlewareCalls };
}

test("assignment routes register exact capability middleware and scope list results", () => {
  const assignments = [
    { id: "visible", assignee: "worker", createdBy: "manager", deviceId: "device-a", accountId: null, status: "assigned" },
    { id: "foreign-device", assignee: "outsider", createdBy: "outsider", deviceId: "device-b", accountId: null, status: "assigned" },
  ];
  const { routes, middlewareCalls } = setup({ assignments });
  assert.deepEqual(middlewareCalls, ["assignments:view", "assignments:manage", "assignments:view"]);
  assert.deepEqual([...routes.keys()], ["GET /api/assignments", "POST /api/assignments", "PATCH /api/assignments/:assignmentId"]);
  const route = routes.get("GET /api/assignments");
  assert.equal(route.middleware.capability, "assignments:view");
  const res = response();
  route.handler({ currentOperator: { username: "manager", role: "manager", allowedDevices: ["device-a"] } }, res);
  assert.deepEqual(res.body.assignments.map(item => item.id), ["visible"]);
});

test("assignment creation preserves validation and propagates unknown store errors", () => {
  const overlap = setup({ create() { throw new Error("assignment overlaps existing work"); } });
  const route = overlap.routes.get("POST /api/assignments");
  const overlapResponse = response();
  route.handler({ currentOperator: { username: "manager", role: "manager", allowedDevices: ["device-a"] },
    body: { assignee: "worker", instructions: "Check phone", deviceId: "device-a" } }, overlapResponse, error => {
      assert.fail(`known overlap must not reach next: ${error.message}`);
    });
  assert.equal(overlapResponse.statusCode, 409);

  const failure = new Error("storage unavailable");
  const unknown = setup({ create() { throw failure; } });
  let propagated = null;
  unknown.routes.get("POST /api/assignments").handler({
    currentOperator: { username: "manager", role: "manager", allowedDevices: ["device-a"] },
    body: { assignee: "worker", instructions: "Check phone", deviceId: "device-a" },
  }, response(), error => { propagated = error; });
  assert.equal(propagated, failure);
});

test("worker status progress remains bounded to their own visible assignment", () => {
  const assignment = { id: "work", assignee: "worker", createdBy: "manager", deviceId: "device-a",
    accountId: null, status: "assigned" };
  const { routes } = setup({ assignments: [assignment] });
  const patch = routes.get("PATCH /api/assignments/:assignmentId");
  const res = response();
  patch.handler({ params: { assignmentId: "work" }, body: { status: "in_progress" },
    currentOperator: { username: "worker", role: "va", allowedDevices: ["device-a"] } }, res, assert.fail);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.assignment.status, "in_progress");
  assert.equal(res.body.assignment.canProgress, true);
});
