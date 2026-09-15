import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function element() { return { children: [], append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); }, addEventListener(name, fn) { this[name] = fn; }, set innerHTML(value) { this.children = []; } }; }

test("assignment choices use server eligibility and retain a stale target as disabled", () => {
  const select = { value: "outside", options: [], replaceChildren(...items) { this.options = [...items]; }, append(item) { this.options.push(item); } };
  const deviceSelect = { value: "", options: [], replaceChildren(...items) { this.options = [...items]; }, append(item) { this.options.push(item); } };
  const context = vm.createContext({
    assignmentAssigneeEl: select, assignmentDeviceEl: deviceSelect,
    lastPeople: [
      { username: "same-team", role: "va", canAssign: true },
      { username: "outside", role: "va", canAssign: false },
    ],
    lastDevices: [], currentOperator: { allowedDevices: [] },
    displayRole: role => role,
    document: { createElement: tag => ({ tag, value: "", textContent: "", disabled: false }) },
    Option: function Option(text, value, defaultSelected = false, selected = false) {
      return { text, value, defaultSelected, selected, disabled: false };
    },
  });
  vm.runInContext(section("function populateAssignmentForm(", "function assignmentNextStatuses"), context);
  vm.runInContext("populateAssignmentForm({ unavailableAssignee: 'outside' })", context);
  assert.deepEqual(select.options.map(option => option.value), ["same-team", "outside"]);
  assert.equal(select.options[1].disabled, true);
  assert.equal(select.options[1].selected, true);
});
test("out-of-order file lists and detached delete buttons cannot target another device", async () => {
  const pending = [], deletes = [];
  const context = vm.createContext({ currentDeviceId: "a", mediaDeviceId: "a", fileRequestGeneration: 0, signedOut: false,
    fileListEl: element(), filesHintEl: {}, lastDevices: [
      { id: "a", mediaActions: { download: true, delete: true } },
      { id: "b", mediaActions: { download: true, delete: true } },
    ], window: { confirm: () => true }, RequestFailure: Error,
    document: { createElement: element, createTextNode: value => value },
    requestJson: async (url, options) => { const response = await context.fetch(url, options); return { response, body: await response.json() }; },
    fetch: (url, options) => options ? (deletes.push(url), Promise.resolve({})) : new Promise(resolve => pending.push({ url, resolve })) });
  vm.runInContext(section("async function refreshFiles()", 'uploadFormEl.addEventListener("submit"'), context);
  const first = vm.runInContext("refreshFiles()", context);
  context.currentDeviceId = "b";
  context.mediaDeviceId = "b";
  const second = vm.runInContext("refreshFiles()", context);
  pending[1].resolve({ json: async () => ({ files: [{ name: "b.txt", size: 1 }] }) });
  await second;
  const row = context.fileListEl.children[0];
  pending[0].resolve({ json: async () => ({ files: [{ name: "a.txt", size: 1 }] }) });
  await first;
  assert.equal(context.fileListEl.children[0], row);
  assert.equal(row.children[0].href, "/api/devices/b/files/b.txt");
  context.currentDeviceId = "c";
  context.mediaDeviceId = "c";
  await row.children[2].click();
  assert.deepEqual(deletes, []);
  const third = vm.runInContext("refreshFiles()", context);
  context.signedOut = true; context.fileRequestGeneration++;
  pending[2].resolve({ json: async () => ({ files: [{ name: "stale.txt", size: 1 }] }) });
  await third;
  assert.equal(context.fileListEl.children[0], row);
});

test("failed file deletion confirms its target, keeps the row, and restores retry", async () => {
  let prompt;
  const button = { disabled: false, isConnected: true };
  const context = vm.createContext({
    currentDeviceId: "a", mediaDeviceId: "a", signedOut: false,
    lastDevices: [{ id: "a", label: "Audit iPhone 1" }],
    filesHintEl: {}, RequestFailure: Error,
    window: { confirm(value) { prompt = value; return true; } },
    requestJson: async () => { throw new Error("Phone Farm could not be reached."); },
  });
  vm.runInContext(section("async function deleteFile(name, deviceId, button = null)", "function formatSize(bytes)"), context);
  context.button = button;
  await vm.runInContext("deleteFile('brief.pdf', 'a', button)", context);
  assert.match(prompt, /brief\.pdf.*Audit iPhone 1.*cannot be undone/);
  assert.equal(button.disabled, false);
  assert.match(context.filesHintEl.textContent, /brief\.pdf was not deleted/);
});

test("failed server logout clears local state and leaves a persistent retry warning", async () => {
  let profile = "authenticated";
  let loginShown = 0;
  let pending = false;
  let liveViewStops = 0;
  const context = vm.createContext({
    signedOut: false, fileRequestGeneration: 0, currentDeviceId: "a", pendingDeviceId: "a",
    watchedDeviceId: "a", pendingWatchDeviceId: "a", pendingAiWorkspaceExitDeviceId: "a",
    lastDevices: [{ id: "a" }], watchRefreshTimerId: 1,
    clearTimeout() {}, clearAiWorkspace() {}, setBusy() {}, stopLiveView() { liveViewStops++; },
    screenEl: { replaceChildren() {} }, fileListEl: { replaceChildren() {} },
    deviceControlBarEl: {}, uploadFormEl: {}, releaseButtonEl: {},
    setOperatorProfile(value) { profile = value; }, showLogin() { loginShown++; },
    logoutRetryButtonEl: { hidden: true, disabled: false }, loginErrorEl: {},
    rememberPendingLogout(value) { pending = value; },
    requestJson: async () => { throw new Error("offline"); },
  });
  vm.runInContext(section("function clearLocalAuthenticatedState()", "function setOperatorProfile(profile)"), context);
  vm.runInContext("clearLocalAuthenticatedState()", context);
  const confirmed = await vm.runInContext("confirmServerLogout()", context);
  assert.equal(confirmed, false);
  assert.equal(profile, null);
  assert.equal(loginShown, 1);
  assert.equal(context.signedOut, true);
  assert.equal(context.currentDeviceId, null);
  assert.equal(liveViewStops, 1, "sign-out must stop screenshot polling immediately");
  assert.equal(pending, true);
  assert.equal(context.logoutRetryButtonEl.hidden, false);
  assert.match(context.loginErrorEl.textContent, /server could not confirm session revocation/);
});

test("releasing a device stops live polling before clearing the control view", () => {
  let releaseHandler;
  let liveViewStops = 0;
  const sent = [];
  const context = vm.createContext({
    currentDeviceId: "wda-1", mediaDeviceId: "wda-1", pendingDeviceId: null,
    pendingAiWorkspaceExitDeviceId: null, fileRequestGeneration: 0,
    stopLiveView() { liveViewStops++; },
    screenEl: { innerHTML: "frame" }, hintEl: {}, uploadFormEl: {}, deviceControlBarEl: {},
    swipeControlsEl: {}, homeButtonEl: {}, refreshScreenButtonEl: {}, typeFormEl: {}, releaseButtonEl: {
      hidden: false,
      addEventListener(name, handler) { if (name === "click") releaseHandler = handler; },
    },
    watchControlsEl: {}, filesPanelEl: {}, fileListEl: { innerHTML: "file" }, filesHintEl: {},
    clearAiWorkspace() {}, setBusy() {}, showFleetView() {}, selectErrorEl: {}, detailMessageEl: {},
    safeSend(message) { sent.push(message); return true; },
  });
  vm.runInContext(section("function deselect(message)", "function renderFrame(frame)"), context);
  releaseHandler();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "release_device");
  assert.equal(sent[0].deviceId, "wda-1");
  assert.equal(liveViewStops, 1);
  assert.equal(context.currentDeviceId, null);
});
test("task status ignores historical and queued entries", async () => {
  const context = vm.createContext({ requestJson: async () => ({ body: { tasks: [
    { id: "active", state: "RUNNING", deviceSelector: { deviceId: "a" } },
    { id: "old", state: "CANCELLED", deviceSelector: { deviceId: "a" } },
    { id: "queued", state: "QUEUED", deviceSelector: { deviceId: "a" } }] } }) });
  vm.runInContext(section("async function fetchActiveTasksByDevice()", "async function fetchLastActionByDevice()"), context);
  assert.equal((await vm.runInContext("fetchActiveTasksByDevice()", context)).get("a").id, "active");
});

test("phone-state copy is role-safe and uses explicit disabled labels", () => {
  const context = vm.createContext({
    currentOperator: { role: "va" },
    UI_CAPABILITIES: { CONTROL_DEVICE: "device:control" },
    can: () => true,
  });
  vm.runInContext(section("function phoneStatePresentation(device)", "function renderDeviceCard"), context);
  const ai = vm.runInContext("phoneStatePresentation({ assignedToViewer: true, controllerMode: 'AI_RUNNING', status: 'in-use' })", context);
  assert.equal(ai.label, "AI in control");
  assert.match(ai.message, /Contact your manager or use another assigned phone/);
  context.currentOperator.role = "editor";
  context.can = () => false;
  const readOnly = vm.runInContext("phoneStatePresentation({ assignedToViewer: true, controllerMode: 'HUMAN', status: 'idle' })", context);
  assert.equal(readOnly.label, "View only");
  const notAssigned = vm.runInContext("phoneStatePresentation({ assignedToViewer: false, controllerMode: 'HUMAN', status: 'idle' })", context);
  assert.equal(notAssigned.label, "Not assigned");
  assert.match(notAssigned.message, /not available to your account/);
});

test("AI workspace controls follow the current task state", () => {
  const commands = ["status", "pause", "resume", "stop", "human"].map(command => ({
    dataset: { aiCommand: command }, hidden: false, disabled: false,
  }));
  const submit = {};
  const context = vm.createContext({
    aiWorkspaceCommandPending: false,
    aiChatInputEl: { value: "status", disabled: false },
    aiChatFormEl: { querySelector: () => submit },
    document: { querySelectorAll(selector) { return selector === "[data-ai-command]" ? commands : []; } },
  });
  vm.runInContext(section("function syncAiWorkspaceControls(device, task)", "function appendAiChatMessage"), context);
  vm.runInContext("syncAiWorkspaceControls({ controllerMode: 'AI_IDLE' }, null)", context);
  assert.equal(commands.find(button => button.dataset.aiCommand === "pause").hidden, true);
  assert.equal(commands.find(button => button.dataset.aiCommand === "resume").hidden, true);
  assert.equal(commands.find(button => button.dataset.aiCommand === "stop").hidden, true);
  assert.equal(commands.find(button => button.dataset.aiCommand === "human").hidden, false);
  vm.runInContext("syncAiWorkspaceControls({ controllerMode: 'AI_RUNNING' }, { state: 'RUNNING' })", context);
  assert.equal(commands.find(button => button.dataset.aiCommand === "pause").hidden, false);
  assert.equal(commands.find(button => button.dataset.aiCommand === "resume").hidden, true);
  assert.equal(commands.find(button => button.dataset.aiCommand === "stop").hidden, false);
  vm.runInContext("syncAiWorkspaceControls({ controllerMode: 'AI_PAUSED' }, { state: 'PAUSED' })", context);
  assert.equal(commands.find(button => button.dataset.aiCommand === "pause").hidden, true);
  assert.equal(commands.find(button => button.dataset.aiCommand === "resume").hidden, false);
});
for (const protocol of ["https:", "http:"]) test(`WebSocket URL follows ${protocol}`, () => {
  let url;
  const context = vm.createContext({ location: { protocol, host: "phones.example:8443" },
    setConnectionState() {},
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
      detailMessageEl: {}, nextActionRequestId: () => 1, liveViewController: { supersedePendingFrame() {} },
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
    selectErrorEl: {}, detailMessageEl: {}, hintEl: {}, nextActionRequestId: () => 1, showDetailView() {}, stopLiveView() {}, setBusy(value) { context.busy = value; }, safeSend: msg => (sent.push(msg), true),
    liveViewController: { supersedePendingFrame() {} },
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
    busy: false,
    watchedDeviceId: null, pendingWatchDeviceId: null, watchRefreshTimerId: null, watchControlsEl: {}, filesPanelEl: {},
    fleetGroupsEl: {}, selectErrorEl: {}, connectionStatusEl: {}, deselect() {}, setOperatorProfile() {}, showLogin() { login++; },
    setConnectionState() {}, clearAiWorkspace() {}, markPresenceUnavailable() {},
    setTimeout(fn) { reconnect = fn; }, clearTimeout() {}, fetch: async () => ({ status: 401 }),
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
    watchedDeviceId: null, pendingWatchDeviceId: null,
    hintEl: {}, releaseButtonEl: { hidden: false }, setBusy(value) { busy = value; }, deselect() { assert.fail("must keep ownership visible"); },
    setConnectionState() {},
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

test("an unwatchable fleet summary cannot request a live screen", () => {
  const sent = [];
  const context = vm.createContext({
    pendingWatchDeviceId: null, watchedDeviceId: null,
    UI_CAPABILITIES: { MONITOR_DEVICE: "device:monitor" }, can: () => true,
    selectErrorEl: {}, detailMessageEl: {}, hintEl: {}, filesPanelEl: {}, showDetailView() {}, clearAiWorkspace() {}, stopLiveView() {},
    safeSend: message => (sent.push(message), true),
  });
  vm.runInContext(section("function requestDeviceOpen(device)", "// Stops whatever AI control"), context);
  assert.equal(vm.runInContext("requestDeviceWatch({ id: 'mock-1', canWatch: false, watchReason: 'Outside team.' })", context), false);
  assert.deepEqual(sent, []);
  assert.equal(context.selectErrorEl.textContent, "Outside team.");
  assert.equal(vm.runInContext("requestDeviceWatch({ id: 'mock-1', canWatch: true })", context), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "watch_device");
  assert.equal(sent[0].deviceId, "mock-1");
});

test("revoked device errors clear the stale control view", () => {
  const handlers = {};
  let deselected;
  const context = vm.createContext({ location: { protocol: "http:", host: "localhost" }, currentDeviceId: "a", pendingDeviceId: null,
    selectErrorEl: {}, deselect(message) { deselected = message; },
    setConnectionState() {},
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
  let resolveRequest;
  let rendered = 0;
  const context = vm.createContext({
    operatorProfileGeneration: 7,
    UI_CAPABILITIES: { MANAGE_USERS: "users:manage" },
    allowed: true,
    can() { return context.allowed; },
    profileRequestActive(generation) {
      return generation === context.operatorProfileGeneration && context.allowed;
    },
    requestJson() { return new Promise(resolve => { resolveRequest = resolve; }); },
    renderUsers() { rendered++; },
    usersListEl: { replaceChildren() { assert.fail("stale error UI must also be ignored"); } },
    usersEmptyEl: {},
  });
  vm.runInContext(section("async function refreshUsers()", "userCreateAllDevicesEl.addEventListener"), context);
  const pending = vm.runInContext("refreshUsers()", context);
  context.operatorProfileGeneration++;
  context.allowed = false;
  resolveRequest({ body: { users: [{ username: "private" }] } });
  await pending;
  assert.equal(rendered, 0);
});
