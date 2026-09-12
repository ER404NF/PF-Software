import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function element() { return { children: [], append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); }, addEventListener(name, fn) { this[name] = fn; }, set innerHTML(value) { this.children = []; } }; }
test("out-of-order file lists and detached delete buttons cannot target another device", async () => {
  const pending = [], deletes = [];
  const context = vm.createContext({ currentDeviceId: "a", fileRequestGeneration: 0, signedOut: false,
    fileListEl: element(), filesHintEl: {}, document: { createElement: element },
    fetch: (url, options) => options ? (deletes.push(url), Promise.resolve({})) : new Promise(resolve => pending.push({ url, resolve })) });
  vm.runInContext(section("async function refreshFiles()", 'uploadFormEl.addEventListener("submit"'), context);
  const first = vm.runInContext("refreshFiles()", context);
  context.currentDeviceId = "b";
  const second = vm.runInContext("refreshFiles()", context);
  pending[1].resolve({ json: async () => ({ files: [{ name: "b.txt", size: 1 }] }) });
  await second;
  const row = context.fileListEl.children[0];
  pending[0].resolve({ json: async () => ({ files: [{ name: "a.txt", size: 1 }] }) });
  await first;
  assert.equal(context.fileListEl.children[0], row);
  assert.equal(row.children[0].href, "/api/devices/b/files/b.txt");
  context.currentDeviceId = "c";
  await row.children[2].click();
  assert.deepEqual(deletes, []);
  const third = vm.runInContext("refreshFiles()", context);
  context.signedOut = true; context.fileRequestGeneration++;
  pending[2].resolve({ json: async () => ({ files: [{ name: "stale.txt", size: 1 }] }) });
  await third;
  assert.equal(context.fileListEl.children[0], row);
});
test("task status ignores historical and queued entries", async () => {
  const context = vm.createContext({ fetch: async () => ({ json: async () => ({ tasks: [
    { id: "active", state: "RUNNING", deviceSelector: { deviceId: "a" } },
    { id: "old", state: "CANCELLED", deviceSelector: { deviceId: "a" } },
    { id: "queued", state: "QUEUED", deviceSelector: { deviceId: "a" } }] }) }) });
  vm.runInContext(section("async function fetchActiveTasksByDevice()", "async function fetchLastActionByDevice()"), context);
  assert.equal((await vm.runInContext("fetchActiveTasksByDevice()", context)).get("a").id, "active");
});
for (const protocol of ["https:", "http:"]) test(`WebSocket URL follows ${protocol}`, () => {
  let url;
  const context = vm.createContext({ location: { protocol, host: "phones.example:8443" },
    WebSocket: class { constructor(value) { url = value; } addEventListener() {} } });
  vm.runInContext(section("function connect()", "checkSession();"), context);
  vm.runInContext("connect()", context);
  assert.equal(url, `${protocol === "https:" ? "wss:" : "ws:"}//phones.example:8443`);
});
test("tap mapping uses the uncropped image rectangle in either orientation", () => {
  const css = fs.readFileSync(new URL("../../../client/style.css", import.meta.url), "utf8");
  assert.match(css, /#screen img\s*\{[^}]*height: auto;[^}]*object-fit: contain;/);
  for (const [width, height] of [[300, 300 * 844 / 390], [300, 300 * 390 / 844]]) {
    let handler, sent;
    const context = vm.createContext({ currentDeviceId: "a", pendingDeviceId: null, busy: false,
      screenEl: { querySelector: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20, width, height }) }),
        addEventListener: (_, fn) => { handler = fn; } }, setBusy() {}, safeSend: value => { sent = value; } });
    vm.runInContext(section('screenEl.addEventListener("click"', 'swipeControlsEl.addEventListener'), context);
    handler({ clientX: 10 + width / 2, clientY: 20 + height / 10 });
    assert.equal(sent.x, 0.5); assert.ok(Math.abs(sent.y - 0.1) < 1e-10);
  }
});

test("pending device switches disable old-screen input and scope later taps", () => {
  let click;
  const sent = [];
  const context = vm.createContext({ currentDeviceId: "a", pendingDeviceId: null, busy: false,
    UI_CAPABILITIES: { CONTROL_DEVICE: "device:control" }, can: () => true,
    selectErrorEl: {}, hintEl: {}, showDetailView() {}, setBusy(value) { context.busy = value; }, safeSend: msg => sent.push(msg),
    screenEl: { addEventListener: (_, fn) => { click = fn; }, querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }) } });
  vm.runInContext(section("function selectDevice(id)", "// The server confirmed this selection"), context);
  vm.runInContext(section('screenEl.addEventListener("click"', 'swipeControlsEl.addEventListener'), context);
  vm.runInContext('selectDevice("b")', context);
  context.busy = false; // even a stale frame cannot bypass the pending gate
  click({ clientX: 10, clientY: 10 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "select_device");
  context.currentDeviceId = "b"; context.pendingDeviceId = null;
  click({ clientX: 10, clientY: 10 });
  assert.equal(sent[1].deviceId, "b");
});
for (const code of [1008, 1006]) test(`expired session returns to login after close ${code}`, async () => {
  const handlers = {};
  let login = 0, reconnect;
  const context = vm.createContext({ location: { protocol: "http:", host: "localhost" }, signedOut: false,
    fleetGroupsEl: {}, selectErrorEl: {}, connectionStatusEl: {}, deselect() {}, setOperatorProfile() {}, showLogin() { login++; },
    setTimeout(fn) { reconnect = fn; }, fetch: async () => ({ status: 401 }),
    WebSocket: class { addEventListener(name, fn) { handlers[name] = fn; } } });
  vm.runInContext(section("function connect()", "checkSession();"), context);
  vm.runInContext("connect()", context);
  handlers.close({ code });
  if (code === 1006) await reconnect();
  else assert.equal(reconnect, undefined);
  assert.equal(login, 1);
  assert.equal(context.signedOut, true);
});

test("transient device error keeps selection and Release available", () => {
  const handlers = {}; let busy;
  const context = vm.createContext({ location: { protocol: "http:", host: "localhost" }, currentDeviceId: "a", pendingDeviceId: null,
    hintEl: {}, releaseButtonEl: { hidden: false }, setBusy(value) { busy = value; }, deselect() { assert.fail("must keep ownership visible"); },
    WebSocket: class { addEventListener(name, fn) { handlers[name] = fn; } } });
  vm.runInContext(section("function connect()", "checkSession();"), context); vm.runInContext("connect()", context);
  handlers.message({ data: JSON.stringify({ type: "error", deviceId: "a", message: "temporary timeout" }) });
  assert.equal(context.currentDeviceId, "a"); assert.equal(context.releaseButtonEl.hidden, false);
  assert.equal(context.hintEl.textContent, "temporary timeout"); assert.equal(busy, false);
});

test("an unopenable fleet summary cannot send select_device", () => {
  const selected = [];
  const context = vm.createContext({ selectErrorEl: {}, selectDevice: id => selected.push(id) });
  vm.runInContext(section("function requestDeviceOpen(device)", "// Stops whatever AI control"), context);
  assert.equal(vm.runInContext("requestDeviceOpen({ id: 'mock-2', canOpen: false, openReason: 'Not assigned.' })", context), false);
  assert.deepEqual(selected, []);
  assert.equal(context.selectErrorEl.textContent, "Not assigned.");
  assert.equal(vm.runInContext("requestDeviceOpen({ id: 'mock-1', canOpen: true })", context), true);
  assert.deepEqual(selected, ["mock-1"]);
});

test("revoked device errors clear the stale control view", () => {
  const handlers = {};
  let deselected;
  const context = vm.createContext({ location: { protocol: "http:", host: "localhost" }, currentDeviceId: "a", pendingDeviceId: null,
    selectErrorEl: {}, deselect(message) { deselected = message; },
    WebSocket: class { addEventListener(name, fn) { handlers[name] = fn; } } });
  vm.runInContext(section("function connect()", "checkSession();"), context);
  vm.runInContext("connect()", context);
  handlers.message({ data: JSON.stringify({ type: "error", code: "device_access_revoked", deviceId: "a", message: "Access revoked." }) });
  assert.equal(deselected, "Access revoked.");
  assert.equal(context.selectErrorEl.textContent, "Access revoked.");
});

test("live role updates clear privileged DOM before safe data is reloaded", () => {
  const cleared = () => ({ children: ["sensitive"], replaceChildren() { this.children = []; } });
  let renderedAssignments = null;
  let assignmentRefreshes = 0;
  const context = vm.createContext({
    currentOperator: { username: "operator", role: "admin", capabilities: ["queue:manage", "users:manage"] },
    lastDevices: [{ authorizedOperators: ["private"] }], renderToken: 4,
    UI_CAPABILITIES: {
      VIEW_ASSIGNMENTS: "assignments:view", MANAGE_ASSIGNMENTS: "assignments:manage",
      VIEW_AUDIT: "audit:view-sensitive", MANAGE_USERS: "users:manage",
    },
    setOperatorProfile(profile) { context.currentOperator = profile; },
    can(capability) { return context.currentOperator.capabilities.includes(capability); },
    canManageOperations() { return context.can("queue:manage"); },
    renderAssignments(value) { renderedAssignments = value; },
    refreshAssignments() { assignmentRefreshes++; return Promise.resolve(); },
    fleetGroupsEl: cleared(), fleetSummaryEl: {}, fleetAccessMessageEl: {}, fleetEmptyEl: {},
    detailDeviceFactsEl: cleared(), detailAiStatusEl: cleared(), assignmentsMessageEl: {},
    assignmentInstructionsEl: { value: "private task" }, assignmentAccountEl: { value: "private-account" },
    assignmentStartEl: { value: "start" }, assignmentEndEl: { value: "end" },
    commandInputEl: { value: "/audit" }, commandOutputEl: { textContent: "private output" },
    queueBodyEl: cleared(), queueStateEl: { textContent: "Running" }, queueEmptyEl: {},
    auditBodyEl: cleared(), auditEmptyEl: {},
    userCreateFormEl: { resetCalled: false, reset() { this.resetCalled = true; } },
    usersListEl: cleared(), usersMessageEl: { textContent: "private" }, usersEmptyEl: {},
  });
  vm.runInContext(section("function applyLiveOperatorProfile(profile)", "// Every route below"), context);
  vm.runInContext(`applyLiveOperatorProfile({ username: "operator", role: "va", allowedDevices: [],
    capabilities: ["assignments:view", "device:control"] })`, context);

  assert.equal(context.currentOperator.role, "va");
  assert.equal(context.lastDevices.length, 0);
  assert.equal(context.renderToken, 5);
  assert.equal(renderedAssignments.length, 0);
  assert.equal(assignmentRefreshes, 1);
  assert.equal(context.commandOutputEl.textContent, "");
  assert.deepEqual(context.queueBodyEl.children, []);
  assert.deepEqual(context.auditBodyEl.children, []);
  assert.deepEqual(context.usersListEl.children, []);
  assert.equal(context.userCreateFormEl.resetCalled, true);
  assert.equal(context.assignmentInstructionsEl.value, "");
});

test("a privileged response already in flight cannot repopulate UI after demotion", async () => {
  let resolveFetch;
  let rendered = 0;
  const context = vm.createContext({
    operatorProfileGeneration: 7,
    UI_CAPABILITIES: { MANAGE_USERS: "users:manage" },
    allowed: true,
    can() { return context.allowed; },
    profileRequestActive(generation) {
      return generation === context.operatorProfileGeneration && context.allowed;
    },
    fetch() { return new Promise(resolve => { resolveFetch = resolve; }); },
    renderUsers() { rendered++; },
    usersListEl: { replaceChildren() { assert.fail("stale error UI must also be ignored"); } },
    usersEmptyEl: {},
  });
  vm.runInContext(section("async function refreshUsers()", "userCreateAllDevicesEl.addEventListener"), context);
  const pending = vm.runInContext("refreshUsers()", context);
  context.operatorProfileGeneration++;
  context.allowed = false;
  resolveFetch({ ok: true, json: async () => ({ users: [{ username: "private" }] }) });
  await pending;
  assert.equal(rendered, 0);
});
