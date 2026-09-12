const loginFormEl = document.getElementById("login-form");
const loginUsernameEl = document.getElementById("login-username");
const loginPasswordEl = document.getElementById("login-password");
const loginErrorEl = document.getElementById("login-error");
const logoutButtonEl = document.getElementById("logout-button");
const whoamiEl = document.getElementById("whoami");
const roleBadgeEl = document.getElementById("role-badge");
const adminNavEl = document.getElementById("admin-nav");
const fleetNavButtonEl = document.getElementById("fleet-nav-button");
const assignmentsNavButtonEl = document.getElementById("assignments-nav-button");
const adminNavButtonEl = document.getElementById("admin-nav-button");
const appEl = document.getElementById("app");
const connectionStatusEl = document.getElementById("connection-status");
const peopleSidebarEl = document.getElementById("people-sidebar");
const peopleListEl = document.getElementById("people-list");
const peopleSummaryEl = document.getElementById("people-summary");
const peopleErrorEl = document.getElementById("people-error");
const peopleRefreshButtonEl = document.getElementById("people-refresh-button");
const fleetViewEl = document.getElementById("fleet-view");
const fleetHeadingEl = document.getElementById("fleet-heading");
const fleetDescriptionEl = document.getElementById("fleet-description");
const fleetAccessMessageEl = document.getElementById("fleet-access-message");
const fleetSummaryEl = document.getElementById("fleet-summary");
const fleetStatusFilterEl = document.getElementById("fleet-status-filter");
const fleetEmptyEl = document.getElementById("fleet-empty");
const fleetGroupsEl = document.getElementById("fleet-groups");
const selectErrorEl = document.getElementById("select-error");
const detailViewEl = document.getElementById("detail-view");
const assignmentsViewEl = document.getElementById("assignments-view");
const assignmentsRefreshButtonEl = document.getElementById("assignments-refresh-button");
const assignmentCreateFormEl = document.getElementById("assignment-create-form");
const assignmentAssigneeEl = document.getElementById("assignment-assignee");
const assignmentDeviceEl = document.getElementById("assignment-device");
const assignmentAccountEl = document.getElementById("assignment-account");
const assignmentStartEl = document.getElementById("assignment-start");
const assignmentEndEl = document.getElementById("assignment-end");
const assignmentExclusiveEl = document.getElementById("assignment-exclusive");
const assignmentInstructionsEl = document.getElementById("assignment-instructions");
const assignmentsMessageEl = document.getElementById("assignments-message");
const assignmentsListEl = document.getElementById("assignments-list");
const assignmentsEmptyEl = document.getElementById("assignments-empty");
const backToFleetButtonEl = document.getElementById("back-to-fleet-button");
const detailTitleEl = document.getElementById("detail-title");
const detailAccessNoteEl = document.getElementById("detail-access-note");
const detailDeviceFactsEl = document.getElementById("detail-device-facts");
const detailAiStatusEl = document.getElementById("detail-ai-status");
const screenWrapEl = document.getElementById("screen-wrap");
const screenEl = document.getElementById("screen");
const hintEl = document.getElementById("hint");
const filesHintEl = document.getElementById("files-hint");
const fileListEl = document.getElementById("file-list");
const uploadFormEl = document.getElementById("upload-form");
const uploadInputEl = document.getElementById("upload-input");
const swipeControlsEl = document.getElementById("swipe-controls");
const homeButtonEl = document.getElementById("home-button");
const typeFormEl = document.getElementById("type-form");
const typeInputEl = document.getElementById("type-input");
const releaseButtonEl = document.getElementById("release-button");
const adminViewEl = document.getElementById("admin-view");
const adminRefreshButtonEl = document.getElementById("admin-refresh-button");
const commandFormEl = document.getElementById("command-form");
const commandInputEl = document.getElementById("command-input");
const commandOutputEl = document.getElementById("command-output");
const queueRefreshButtonEl = document.getElementById("queue-refresh-button");
const queueStateEl = document.getElementById("queue-state");
const queueBodyEl = document.getElementById("queue-body");
const queueEmptyEl = document.getElementById("queue-empty");
const usersPanelEl = document.getElementById("users-panel");
const usersRefreshButtonEl = document.getElementById("users-refresh-button");
const userCreateFormEl = document.getElementById("user-create-form");
const userCreateUsernameEl = document.getElementById("user-create-username");
const userCreatePasswordEl = document.getElementById("user-create-password");
const userCreateRoleEl = document.getElementById("user-create-role");
const userCreateDevicesEl = document.getElementById("user-create-devices");
const userCreateResearchEl = document.getElementById("user-create-research");
const userCreateAllDevicesEl = document.getElementById("user-create-all-devices");
const usersMessageEl = document.getElementById("users-message");
const usersListEl = document.getElementById("users-list");
const usersEmptyEl = document.getElementById("users-empty");
const auditRefreshButtonEl = document.getElementById("audit-refresh-button");
const auditBodyEl = document.getElementById("audit-body");
const auditEmptyEl = document.getElementById("audit-empty");

// currentDeviceId is only ever set once the server has confirmed a
// selection (a "frame" arrives for it) — never optimistically. Otherwise a
// failed attempt to switch to someone else's device would incorrectly wipe
// out an already-working session that the server never actually released.
let currentDeviceId = null;
let fileRequestGeneration = 0;
let pendingDeviceId = null;

// Safe profile returned by /api/me or /api/login. Role controls management
// surfaces; allowedDevices remains a separate server-enforced device RBAC
// concern. Never infer admin from allowedDevices === null.
let currentOperator = null;
let operatorProfileGeneration = 0;

const UI_CAPABILITIES = Object.freeze({
  CONTROL_DEVICE: "device:control",
  MANAGE_QUEUE: "queue:manage",
  MANAGE_AI_CONTROLLER: "ai-controller:manage",
  VIEW_AUDIT: "audit:view-sensitive",
  VIEW_ASSIGNMENTS: "assignments:view",
  MANAGE_ASSIGNMENTS: "assignments:manage",
  MANAGE_USERS: "users:manage",
  VIEW_PEOPLE: "people:view",
});

function can(capability) {
  return currentOperator?.capabilities?.includes(capability) === true;
}

function canManageOperations() {
  return can(UI_CAPABILITIES.MANAGE_QUEUE);
}

function profileRequestActive(generation, capability = null) {
  return generation === operatorProfileGeneration && (!capability || can(capability));
}


// Most recent device_list, kept around so the detail view (e.g. its title,
// its AI-status pane) can be re-rendered for the currently-open device
// without waiting for the next broadcast — e.g. right after confirmSelection.
let lastDevices = [];

// 'fleet' | 'detail' | 'assignments' | 'admin'. Purely a client-side view switch, not a route — no
// server/protocol involvement. Navigating to detail view IS optimistic
// (unlike currentDeviceId above): it happens the instant a card is clicked,
// showing a loading hint while the real select_device/takeover round trip
// is in flight, and bounces back to fleet on failure. That's safe to do
// optimistically because — unlike currentDeviceId — getting it wrong just
// means a brief visual flash, never a corrupted idea of which device this
// connection actually controls.
let currentView = "fleet";

function updateTopNav() {
  fleetNavButtonEl.classList.toggle("active", currentView === "fleet" || currentView === "detail");
  assignmentsNavButtonEl.classList.toggle("active", currentView === "assignments");
  adminNavButtonEl.classList.toggle("active", currentView === "admin");
}

function showFleetView() {
  currentView = "fleet";
  fleetViewEl.hidden = false;
  detailViewEl.hidden = true;
  assignmentsViewEl.hidden = true;
  adminViewEl.hidden = true;
  updateTopNav();
}

function showDetailView(deviceId) {
  currentView = "detail";
  fleetViewEl.hidden = true;
  detailViewEl.hidden = false;
  assignmentsViewEl.hidden = true;
  adminViewEl.hidden = true;
  updateTopNav();
  const device = lastDevices.find((d) => d.id === deviceId);
  detailTitleEl.textContent = device ? device.label : "";
  renderDeviceFacts(device);
}

function showAdminView() {
  if (!canManageOperations()) return;
  currentView = "admin";
  fleetViewEl.hidden = true;
  detailViewEl.hidden = true;
  assignmentsViewEl.hidden = true;
  adminViewEl.hidden = false;
  updateTopNav();
  refreshAdminView();
}

function showAssignmentsView() {
  if (!can(UI_CAPABILITIES.VIEW_ASSIGNMENTS)) return;
  currentView = "assignments";
  fleetViewEl.hidden = true;
  detailViewEl.hidden = true;
  adminViewEl.hidden = true;
  assignmentsViewEl.hidden = false;
  updateTopNav();
  populateAssignmentForm();
  void refreshAssignments();
}

// True while a tap/swipe/type_text is in flight. Against a real device this
// round trip is a genuine network+phone action, not instant — without this,
// clicking again mid-flight has no feedback and (before the server-side fix)
// could race with the pending action. Interaction is disabled while busy;
// any frame or error clears it, since either means the action resolved.
let busy = false;
let busyTimeoutId = null;

// Safety net: if the server ever silently drops a message instead of
// responding (validation failures return early with no frame/error — this
// actually happened with type_text over the length cap, permanently
// disabling the UI since nothing ever arrived to clear busy), this
// guarantees the controls always recover instead of staying stuck forever.
// A real device response should arrive well under this; if it doesn't, the
// server-side action queue still processes things in order regardless, so
// unsticking the UI early here is a minor cosmetic risk, not a correctness one.
const BUSY_TIMEOUT_MS = 10000;

function setBusy(value, { timedOut = false } = {}) {
  busy = value;
  screenWrapEl.classList.toggle("busy", value);
  for (const btn of swipeControlsEl.querySelectorAll("button")) btn.disabled = value;
  homeButtonEl.disabled = value;
  typeInputEl.disabled = value;
  typeFormEl.querySelector("button").disabled = value;

  clearTimeout(busyTimeoutId);
  if (value) {
    // A new action is starting — clear any stale "no response" message from
    // a previous one before it, so it doesn't linger under a fresh attempt.
    hintEl.textContent = "";
    busyTimeoutId = setTimeout(() => setBusy(false, { timedOut: true }), BUSY_TIMEOUT_MS);
  } else if (timedOut && currentDeviceId) {
    // Distinguishes "the safety net fired" from "a real response arrived" —
    // without this, hitting the timeout looked identical to success, with no
    // indication anything actually went wrong.
    hintEl.textContent = "No response from the device — you can try again.";
  }
}

// Without this, a dropped connection (server restart, network blip) left the
// VA staring at a frozen screen with zero indication anything was wrong —
// the client only ever listened for "message" and had no idea the socket
// had closed. A reconnect is a brand-new server-side session (the old
// connection's device, if any, is already released via the server's own
// close handler), so this resets local state rather than pretending to
// resume a session the server no longer has any record of.
let ws;

// Set only by an explicit sign-out. Distinguishes "the socket dropped, try
// again" from "the operator signed out on purpose" — without it, signing out
// would just trigger the same auto-reconnect as a network blip, immediately
// re-opening a connection that's correctly no longer authenticated.
let signedOut = false;

function safeSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function showLogin() {
  loginFormEl.hidden = false;
  appEl.hidden = true;
}

function showApp() {
  loginFormEl.hidden = true;
  appEl.hidden = false;
  showFleetView();
}

function setOperatorProfile(profile) {
  operatorProfileGeneration++;
  window.dispatchEvent(new Event("operator-profile-changed"));
  currentOperator = profile?.username ? {
    username: profile.username,
    role: typeof profile.role === "string" ? profile.role : "va",
    allowedDevices: profile.allowedDevices ?? null,
    capabilities: Array.isArray(profile.capabilities) ? profile.capabilities.filter(value => typeof value === "string") : [],
  } : null;

  whoamiEl.textContent = currentOperator ? `Signed in as ${currentOperator.username}` : "";
  roleBadgeEl.textContent = currentOperator ? currentOperator.role.toUpperCase() : "";
  roleBadgeEl.hidden = !currentOperator;
  const isVa = currentOperator?.role === "va";
  fleetHeadingEl.textContent = isVa ? "VA Fleet" : "Fleet";
  fleetDescriptionEl.textContent = isVa
    ? "View fleet status and open your assigned phones."
    : "View fleet status and open available phones.";
  adminNavEl.hidden = !currentOperator;
  assignmentsNavButtonEl.hidden = !can(UI_CAPABILITIES.VIEW_ASSIGNMENTS);
  adminNavButtonEl.hidden = !canManageOperations();
  document.getElementById("audit-panel").hidden = !can(UI_CAPABILITIES.VIEW_AUDIT);
  usersPanelEl.hidden = !can(UI_CAPABILITIES.MANAGE_USERS);
  assignmentCreateFormEl.hidden = !can(UI_CAPABILITIES.MANAGE_ASSIGNMENTS);
  peopleSidebarEl.hidden = !currentOperator;
  if (!currentOperator) renderPeople([]);

  // Never leave a privileged surface visible after logout or a role change.
  if ((!canManageOperations() && currentView === "admin")
    || (!can(UI_CAPABILITIES.VIEW_ASSIGNMENTS) && currentView === "assignments")) showFleetView();
}

function applyLiveOperatorProfile(profile) {
  if (!profile?.username || profile.username !== currentOperator?.username) return;
  setOperatorProfile(profile);

  // The profile message is sent before the matching fleet broadcast. Remove
  // summaries and management data rendered under the old capability set so a
  // demoted operator cannot keep reading stale privileged DOM while the safe
  // viewer-specific responses are in flight.
  lastDevices = [];
  renderToken++;
  fleetGroupsEl.replaceChildren();
  fleetSummaryEl.textContent = "Refreshing fleet access…";
  fleetAccessMessageEl.hidden = true;
  fleetEmptyEl.hidden = false;
  fleetEmptyEl.textContent = "Refreshing fleet access…";
  detailDeviceFactsEl.replaceChildren();
  detailAiStatusEl.replaceChildren();

  renderAssignments([]);
  assignmentsMessageEl.textContent = "";
  if (can(UI_CAPABILITIES.VIEW_ASSIGNMENTS)) void refreshAssignments();

  if (!can(UI_CAPABILITIES.MANAGE_ASSIGNMENTS)) {
    assignmentInstructionsEl.value = "";
    assignmentAccountEl.value = "";
    assignmentStartEl.value = "";
    assignmentEndEl.value = "";
  }
  if (!canManageOperations()) {
    commandInputEl.value = "";
    commandOutputEl.textContent = "";
    queueBodyEl.replaceChildren();
    queueStateEl.textContent = "";
    queueEmptyEl.hidden = false;
    queueEmptyEl.textContent = "Queue access is not available for this role.";
  }
  if (!can(UI_CAPABILITIES.VIEW_AUDIT)) {
    auditBodyEl.replaceChildren();
    auditEmptyEl.hidden = false;
    auditEmptyEl.textContent = "Audit access is not available for this role.";
  }
  if (!can(UI_CAPABILITIES.MANAGE_USERS)) {
    userCreateFormEl.reset();
    usersListEl.replaceChildren();
    usersMessageEl.textContent = "";
    usersEmptyEl.hidden = false;
    usersEmptyEl.textContent = "User management is not available for this role.";
  }
}

// Every route below this needs a session; a WS connection needs one too
// (index.js rejects the upgrade otherwise) — check once on load so a
// returning operator with a still-valid session skips the login form.
async function checkSession() {
  try {
    const res = await fetch("/api/me");
    const body = await res.json().catch(() => null);
    if (res.ok) {
      setOperatorProfile(body);
      showApp();
      connect();
    } else {
      showLogin();
    }
  } catch {
    // A network-level failure (offline, DNS hiccup) — fall back to the login
    // screen rather than leaving the page in whichever state the raw HTML
    // happened to default to, with no indication anything went wrong.
    showLogin();
  }
}

loginFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginErrorEl.textContent = "";
  const username = loginUsernameEl.value;
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: loginPasswordEl.value }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: "Sign-in failed." }));
    loginErrorEl.textContent = error;
    return;
  }
  // Reading the body isn't for its content (we don't need it) — fetch()'s
  // promise resolves as soon as headers arrive, but this server delays
  // finishing the response body until the session is actually written to
  // disk (see fileSessionStore.js). Without awaiting the body too, connect()
  // below can race that write and have its very first WS upgrade rejected.
  const profile = await res.json();
  loginPasswordEl.value = "";
  signedOut = false;
  setOperatorProfile(profile);
  showApp();
  connect();
});

logoutButtonEl.addEventListener("click", async () => {
  signedOut = true;
  fileRequestGeneration++;
  if (ws) ws.close();
  await fetch("/api/logout", { method: "POST" });
  setOperatorProfile(null);
  showLogin();
});

function formatLastSeen(value) {
  if (!value) return "Never seen";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Last seen unavailable";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "Active now";
  if (seconds < 60) return `Seen ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Seen ${minutes}m ago`;
  return `Seen ${Math.round(minutes / 60)}h ago`;
}

let lastPeople = [];

function renderPeople(people) {
  lastPeople = people;
  peopleListEl.replaceChildren();
  const onlineCount = people.filter(person => person.online).length;
  peopleSummaryEl.textContent = `${onlineCount} online · ${people.length} staff`;
  for (const person of people) {
    const item = document.createElement("li");
    item.className = `person-row ${person.online ? "online" : "offline"}`;

    const dot = document.createElement("span");
    dot.className = "presence-dot";
    dot.setAttribute("aria-label", person.online ? "Online" : "Offline");

    const details = document.createElement("div");
    details.className = "person-details";
    const name = document.createElement("strong");
    name.textContent = person.username;
    const meta = document.createElement("span");
    const sessions = person.activeSessions > 1 ? ` · ${person.activeSessions} sessions` : "";
    meta.textContent = `${String(person.role || "va").replaceAll("_", " ")} · ${formatLastSeen(person.lastSeenAt)}${sessions}`;
    details.append(name, meta);

    if (Array.isArray(person.currentPhones) && person.currentPhones.length) {
      const activity = document.createElement("span");
      activity.className = "person-activity";
      activity.textContent = `On ${person.currentPhones.map(phone => phone.label).join(", ")}`;
      details.append(activity);
    }
    if (person.assignment) {
      const assignment = document.createElement("span");
      assignment.className = "person-assignment";
      assignment.textContent = `${person.assignment.status.replaceAll("_", " ")}`
        + (person.assignment.deviceId ? ` · ${person.assignment.deviceId}` : "")
        + (person.assignment.startAt && person.assignment.endAt
          ? ` · ${formatDate(person.assignment.startAt)} → ${formatDate(person.assignment.endAt)}` : "");
      details.append(assignment);
    }

    item.append(dot, details);
    peopleListEl.append(item);
  }
}

async function refreshPeople() {
  const generation = operatorProfileGeneration;
  peopleErrorEl.textContent = "";
  try {
    const response = await fetch("/api/people");
    const body = await response.json().catch(() => ({}));
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_PEOPLE)) return;
    if (!response.ok) throw new Error(body.error || "Could not load staff presence");
    renderPeople(Array.isArray(body.people) ? body.people : []);
  } catch (error) {
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_PEOPLE)) return;
    peopleErrorEl.textContent = error.message;
  }
}

peopleRefreshButtonEl.addEventListener("click", refreshPeople);

function populateAssignmentForm() {
  const selectedAssignee = assignmentAssigneeEl.value;
  assignmentAssigneeEl.replaceChildren();
  for (const person of lastPeople) {
    const canTarget = currentOperator?.role === "admin"
      || person.username === currentOperator?.username
      || !["admin", "manager"].includes(person.role);
    if (!canTarget) continue;
    const option = document.createElement("option");
    option.value = person.username;
    option.textContent = `${person.username} (${String(person.role).replaceAll("_", " ")})`;
    assignmentAssigneeEl.append(option);
  }
  if ([...assignmentAssigneeEl.options].some(option => option.value === selectedAssignee)) {
    assignmentAssigneeEl.value = selectedAssignee;
  }

  const selectedDevice = assignmentDeviceEl.value;
  assignmentDeviceEl.replaceChildren(new Option("No phone", ""));
  const allowed = currentOperator?.allowedDevices;
  for (const device of lastDevices.filter(item => !Array.isArray(allowed) || allowed.includes(item.id))) {
    assignmentDeviceEl.append(new Option(device.label, device.id));
  }
  assignmentDeviceEl.value = [...assignmentDeviceEl.options].some(option => option.value === selectedDevice) ? selectedDevice : "";
}

function assignmentNextStatuses(assignment) {
  if (assignment.status === "assigned") {
    const opensLater = assignment.startAt && Date.parse(assignment.startAt) > Date.now();
    return opensLater ? ["cancelled"] : ["in_progress", "cancelled"];
  }
  if (assignment.status === "in_progress") return ["completed", "cancelled"];
  return [];
}

function localInputToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isoToLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function assignmentWindow(assignment) {
  if (!assignment.startAt || !assignment.endAt) return "Unscheduled";
  return `${formatDate(assignment.startAt)} → ${formatDate(assignment.endAt)}${assignment.exclusive === false ? " · shared" : " · exclusive"}`;
}

function renderAssignments(assignments) {
  assignmentsListEl.replaceChildren();
  assignmentsEmptyEl.hidden = assignments.length > 0;
  for (const assignment of assignments) {
    const card = document.createElement("article");
    card.className = "assignment-card";
    const heading = document.createElement("div");
    heading.className = "assignment-card-heading";
    const title = document.createElement("strong");
    title.textContent = assignment.instructions;
    const status = document.createElement("span");
    status.className = `assignment-status ${assignment.status}`;
    status.textContent = assignment.status.replaceAll("_", " ");
    heading.append(title, status);

    const meta = document.createElement("p");
    meta.textContent = `Assigned to ${assignment.assignee} by ${assignment.createdBy}`
      + (assignment.deviceId ? ` · Phone ${assignment.deviceId}` : "")
      + (assignment.accountId ? ` · Account ${assignment.accountId}` : "")
      + ` · ${assignmentWindow(assignment)}`;
    card.append(heading, meta);

    const controls = document.createElement("div");
    controls.className = "assignment-controls";
    const nextStatuses = assignmentNextStatuses(assignment);
    if (nextStatuses.length && can(UI_CAPABILITIES.MANAGE_ASSIGNMENTS)) {
      for (const nextStatus of nextStatuses) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = nextStatus === "in_progress" ? "Start" : nextStatus === "completed" ? "Complete" : "Cancel";
        button.addEventListener("click", () => updateAssignment(assignment.id, { status: nextStatus }));
        controls.append(button);
      }
    }
    if (nextStatuses.length && can(UI_CAPABILITIES.MANAGE_ASSIGNMENTS)) {
      const reassign = document.createElement("select");
      reassign.setAttribute("aria-label", `Reassign ${assignment.instructions}`);
      reassign.append(new Option("Reassign…", ""));
      for (const option of assignmentAssigneeEl.options) reassign.append(option.cloneNode(true));
      reassign.addEventListener("change", () => {
        if (reassign.value) void updateAssignment(assignment.id, { assignee: reassign.value });
      });
      controls.append(reassign);

      const scheduleStart = document.createElement("input");
      scheduleStart.type = "datetime-local";
      scheduleStart.value = isoToLocalInput(assignment.startAt);
      scheduleStart.setAttribute("aria-label", `Start time for ${assignment.instructions}`);
      const scheduleEnd = document.createElement("input");
      scheduleEnd.type = "datetime-local";
      scheduleEnd.value = isoToLocalInput(assignment.endAt);
      scheduleEnd.setAttribute("aria-label", `End time for ${assignment.instructions}`);
      const scheduleExclusive = document.createElement("input");
      scheduleExclusive.type = "checkbox";
      scheduleExclusive.checked = assignment.exclusive !== false;
      scheduleExclusive.setAttribute("aria-label", `Exclusive schedule for ${assignment.instructions}`);
      const reschedule = document.createElement("button");
      reschedule.type = "button";
      reschedule.textContent = "Update schedule";
      reschedule.addEventListener("click", () => updateAssignment(assignment.id, {
        startAt: localInputToIso(scheduleStart.value),
        endAt: localInputToIso(scheduleEnd.value),
        exclusive: scheduleExclusive.checked,
      }));
      controls.append(scheduleStart, scheduleEnd, scheduleExclusive, reschedule);
    }
    card.append(controls);

    const history = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `History (${assignment.history.length})`;
    const list = document.createElement("ol");
    for (const event of assignment.history) {
      const item = document.createElement("li");
      item.textContent = `${new Date(event.at).toLocaleString()} · ${event.actor} · ${event.action.replaceAll("_", " ")}`;
      list.append(item);
    }
    history.append(summary, list);
    card.append(history);
    assignmentsListEl.append(card);
  }
}

async function refreshAssignments() {
  const generation = operatorProfileGeneration;
  assignmentsMessageEl.textContent = "";
  try {
    const response = await fetch("/api/assignments");
    const body = await response.json().catch(() => ({}));
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_ASSIGNMENTS)) return;
    if (!response.ok) throw new Error(body.error || "Could not load assignments");
    renderAssignments(Array.isArray(body.assignments) ? body.assignments : []);
  } catch (error) {
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_ASSIGNMENTS)) return;
    assignmentsMessageEl.textContent = error.message;
  }
}

async function updateAssignment(id, change) {
  assignmentsMessageEl.textContent = "";
  const response = await fetch(`/api/assignments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) assignmentsMessageEl.textContent = body.error || "Could not update assignment";
  await refreshAssignments();
}

assignmentsRefreshButtonEl.addEventListener("click", refreshAssignments);
assignmentCreateFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  assignmentsMessageEl.textContent = "";
  const response = await fetch("/api/assignments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assignee: assignmentAssigneeEl.value,
      instructions: assignmentInstructionsEl.value,
      deviceId: assignmentDeviceEl.value || null,
      accountId: assignmentAccountEl.value.trim() || null,
      startAt: localInputToIso(assignmentStartEl.value),
      endAt: localInputToIso(assignmentEndEl.value),
      exclusive: assignmentExclusiveEl.checked,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    assignmentsMessageEl.textContent = body.error || "Could not create assignment";
    return;
  }
  assignmentInstructionsEl.value = "";
  assignmentAccountEl.value = "";
  assignmentStartEl.value = "";
  assignmentEndEl.value = "";
  await refreshAssignments();
});

backToFleetButtonEl.addEventListener("click", () => {
  showFleetView();
});

fleetNavButtonEl.addEventListener("click", () => showFleetView());
assignmentsNavButtonEl.addEventListener("click", () => showAssignmentsView());
adminNavButtonEl.addEventListener("click", () => showAdminView());

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);

  ws.addEventListener("open", () => {
    connectionStatusEl.hidden = true;
    void refreshPeople();
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "operator_profile") {
      applyLiveOperatorProfile(msg.operator);
    }
    if (msg.type === "device_list") {
      renderFleetSafely(msg.devices);
      populateAssignmentForm();
    }
    if (msg.type === "presence_list") {
      renderPeople(Array.isArray(msg.people) ? msg.people : []);
      populateAssignmentForm();
    }

    if (msg.type === "frame") {
      if (msg.deviceId === pendingDeviceId) confirmSelection(pendingDeviceId);
      if (msg.deviceId === currentDeviceId && !pendingDeviceId) {
        renderFrame(msg);
        setBusy(false);
      }
    }

    if (msg.type === "error") {
      if (msg.code === "device_access_revoked") {
        deselect(msg.message || "Your access to this phone was revoked.");
        selectErrorEl.textContent = msg.message || "Your access to this phone was revoked.";
      } else if (msg.deviceId === pendingDeviceId) {
        // A selection attempt failed — surface it without touching whatever
        // device (if any) is already confirmed and working, and bounce back
        // from the optimistic detail-view navigation selectDevice/
        // takeOverDevice already did.
        pendingDeviceId = null;
        setBusy(false);
        selectErrorEl.textContent = msg.message;
        if (!currentDeviceId) showFleetView();
      } else if (msg.deviceId === currentDeviceId) {
        // Device errors do not revoke the server-side claim. Keep retry and
        // Release available instead of abandoning an owned device locally.
        hintEl.textContent = msg.message;
        setBusy(false);
      } else {
        // Neither pending nor current — e.g. a fleet-card AI control
        // button failing for a device this connection never selected in the
        // first place (RBAC denial, unknown device id). Without this branch
        // the error was silently dropped: nothing here ever matched it, so
        // clicking a high-priority safety control that failed gave zero
        // visible feedback.
        selectErrorEl.textContent = msg.message;
      }
    }
  });

  ws.addEventListener("close", (event) => {
    pendingDeviceId = null;
    fleetGroupsEl.innerHTML = "";
    selectErrorEl.textContent = "";
    if (signedOut) return; // don't fight an intentional sign-out
    if (event.code === 1008) {
      signedOut = true;
      deselect("Session expired. Sign in again.");
      setOperatorProfile(null);
      showLogin();
      return;
    }
    connectionStatusEl.hidden = false;
    deselect("Disconnected — reconnecting…");
    setTimeout(async () => {
      if (signedOut) return;
      try {
        const response = await fetch("/api/me");
        if (response.status === 401) {
          signedOut = true;
          setOperatorProfile(null);
          showLogin();
          return;
        }
      } catch { /* A network outage may recover on the next connection. */ }
      if (!signedOut) connect();
    }, 2000);
  });
}

checkSession();

// Guards against out-of-order rendering: device_list broadcasts to every
// connected client on nearly every action, so a burst of them can fire
// renderFleet faster than its own /api/queue + /api/audit lookups resolve.
// Without this, an older render's async work could finish after and
// overwrite a newer one's, occasionally flashing stale AI-status data.
let renderToken = 0;

async function renderFleetSafely(devices) {
  lastDevices = devices;
  if (currentDeviceId) {
    const selectedSummary = devices.find(device => device.id === currentDeviceId);
    if (!selectedSummary || !selectedSummary.canOpen) {
      const reason = selectedSummary?.openReason || "This phone is no longer available in the fleet.";
      deselect(reason);
      selectErrorEl.textContent = reason;
    }
  }
  const token = ++renderToken;
  const aiDevices = devices.filter((d) => d.controllerMode && d.controllerMode !== "HUMAN");
  // Queue and sensitive audit access are separate capabilities. An operations
  // user can see scoped tasks without gaining access to the global audit log.
  const [tasksByDevice, lastActionByDevice] = canManageOperations() && aiDevices.length
    ? await Promise.all([
      fetchActiveTasksByDevice(),
      can(UI_CAPABILITIES.VIEW_AUDIT) ? fetchLastActionByDevice() : Promise.resolve(new Map()),
    ])
    : [new Map(), new Map()];
  if (token !== renderToken) return; // a newer device_list has already re-rendered
  renderFleetSummary(devices);
  renderFleet(devices, tasksByDevice, lastActionByDevice);
  if (currentView === "detail" && currentDeviceId) {
    renderDeviceFacts(devices.find(device => device.id === currentDeviceId));
    renderDetailAiStatus(currentDeviceId, tasksByDevice.get(currentDeviceId), lastActionByDevice.get(currentDeviceId));
  }
}

function renderFleetSummary(devices) {
  const assignedCount = devices.filter(device => device.assignedToViewer).length;
  const openableCount = devices.filter(device => device.canOpen).length;
  fleetAccessMessageEl.hidden = currentOperator?.role !== "va" || openableCount > 0;
  if (!fleetAccessMessageEl.hidden) {
    fleetAccessMessageEl.textContent = assignedCount === 0
      ? "You can view the fleet, but no phones are assigned to you."
      : "Your assigned phones are currently offline, in use, or controlled by AI.";
  }
  const counts = [
    ["Total", devices.length],
    ["Available", devices.filter(device => device.status === "idle" && device.controllerMode === "HUMAN").length],
    ["In use", devices.filter(device => device.status === "in-use").length],
    ["Offline", devices.filter(device => device.status === "offline").length],
    ["AI", devices.filter(device => device.controllerMode !== "HUMAN").length],
  ];
  fleetSummaryEl.replaceChildren();
  for (const [label, value] of counts) {
    const card = document.createElement("span");
    const count = document.createElement("strong");
    count.textContent = value;
    card.append(count, document.createTextNode(label));
    fleetSummaryEl.append(card);
  }
}

function fleetMatchesFilter(device) {
  const filter = fleetStatusFilterEl.value;
  if (filter === "all") return true;
  if (filter === "ai") return device.controllerMode !== "HUMAN";
  return device.status === filter;
}

fleetStatusFilterEl.addEventListener("change", () => {
  void renderFleetSafely(lastDevices);
});

async function fetchActiveTasksByDevice() {
  const map = new Map();
  try {
    const res = await fetch("/api/queue");
    const { tasks } = await res.json();
    for (const t of tasks) {
      const id = t.deviceSelector?.deviceId;
      if (id && ["RUNNING", "PAUSED"].includes(t.state)) map.set(id, t);
    }
  } catch {
    // Best-effort — the status pane just shows less detail, never blocks
    // the device list itself from rendering.
  }
  return map;
}

async function fetchLastActionByDevice() {
  const map = new Map();
  try {
    const res = await fetch("/api/audit?limit=50");
    const { events } = await res.json();
    // Newest-first (auditLog.js) — the first hit per device is its most
    // recent event, so later duplicates for the same device are ignored.
    for (const e of events) {
      if (e.deviceId && !map.has(e.deviceId)) map.set(e.deviceId, e);
    }
  } catch {
    // Same best-effort reasoning as fetchActiveTasksByDevice above.
  }
  return map;
}

// Groups the flat device list into labeled sections by hostLabel (index.js's
// deviceHost map — "which physical Mac this device lives on"). Today every
// device in this repo's own devices.config.json resolves to the same
// implicit group ("this-mac"), since one Phone Farm server only ever manages
// its own local devices — there's no multi-host aggregation here. Grouping
// still renders correctly (one section) and is ready for a real multi-host
// fleet without needing rework later.
function groupByHost(devices) {
  const groups = new Map();
  for (const d of devices) {
    const key = d.hostLabel || "this-mac";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  return groups;
}

function renderFleet(devices, tasksByDevice, lastActionByDevice) {
  fleetGroupsEl.innerHTML = "";
  const visibleDevices = devices.filter(fleetMatchesFilter);
  fleetEmptyEl.hidden = visibleDevices.length > 0;
  for (const [hostLabel, groupDevices] of groupByHost(visibleDevices)) {
    const section = document.createElement("section");
    section.className = "fleet-group";

    const heading = document.createElement("h2");
    heading.className = "fleet-group-heading";
    heading.textContent = hostLabel;
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "fleet-grid";
    for (const d of groupDevices) {
      grid.appendChild(renderDeviceCard(d, tasksByDevice.get(d.id), lastActionByDevice.get(d.id)));
    }
    section.appendChild(grid);

    fleetGroupsEl.appendChild(section);
  }
}

function renderDeviceFacts(device) {
  detailDeviceFactsEl.replaceChildren();
  detailAccessNoteEl.textContent = "";
  if (!device) return;
  detailAccessNoteEl.textContent = currentOperator?.role === "va" && device.assignedToViewer
    ? "Assigned device — you may operate this phone. Fleet settings are read-only."
    : device.openReason || "Fleet settings are read-only.";
  const facts = [
    ["Phone", device.id],
    ["Host", device.hostLabel || "this-mac"],
    ["State", device.status],
    ["Controller", device.controllerMode || "HUMAN"],
    ["Current operator", device.currentOperator || (device.controllerMode !== "HUMAN" ? "AI controller" : "None")],
    ["Your access", device.assignedToViewer ? "Assigned to you" : "Not assigned to you"],
    ["Last seen", device.lastSeenAt ? formatLastSeen(device.lastSeenAt) : "No successful check"],
    ["Failures", String(device.consecutiveFailures || 0)],
    ["Network", device.network?.egress || "Not assigned"],
    ["Provider / gateway", device.network?.providerLabel || device.network?.gatewayLabel || "Not configured"],
    ["Configured region", device.network?.configuredRegion || "Not configured"],
    ["Expected IPv4", device.network?.expectedPublicIpv4 || "Not configured"],
    ["IPv6 policy", device.network?.expectedIpv6Policy || "Unspecified"],
    ["Observed IPv4", device.networkObservedIp || "Not checked"],
    ["Observed IPv6", device.networkObservedIpv6 || "None observed"],
    ["Observed region", device.networkObservedRegion || "Not checked"],
    ["DNS", device.networkDnsStatus || "Not checked"],
    ["Proxy health", device.networkProxyHealthy === null ? "Not checked" : device.networkProxyHealthy ? "Healthy" : "Unhealthy"],
    ["Fail policy", device.network?.failPolicy || "Not configured"],
    ["Bandwidth", Number.isFinite(device.networkBandwidthMbps) ? `${device.networkBandwidthMbps} Mbps` : "Not checked"],
    ["Last verification", device.networkCheckedAt ? formatDate(device.networkCheckedAt) : "Never"],
    ["Isolation", device.networkMismatch ? "Mismatch" : device.networkVerified ? "Verified" : "Not verified"],
    ["Monitor", device.monitor?.available ? "Available" : device.monitor?.reason || "Unavailable"],
  ];
  if (device.assignment) {
    facts.splice(6, 0,
      ["Assigned user", device.assignment.assignee],
      ["Assignment window", assignmentWindow(device.assignment)]);
  }
  if (Array.isArray(device.authorizedOperators) && device.authorizedOperators.length) {
    facts.splice(6, 0, ["Authorized staff", device.authorizedOperators
      .map(operator => `${operator.username} (${operator.role.replaceAll("_", " ")})`).join(", ")]);
  }
  for (const [label, value] of facts) {
    const item = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(name, content);
    detailDeviceFactsEl.append(item);
  }
}

// "warning" is a rendering-layer read of two already-existing fields
// (status, consecutiveFailures) — the protocol itself still only has three
// raw states (idle/in-use/offline). A device that's had recent trouble but
// hasn't crossed the offline threshold yet is worth calling out without
// waiting for it to fail outright.
function cardStatusClass(d) {
  if (d.status === "offline") return "offline";
  if (d.consecutiveFailures > 0) return "warning";
  return d.status; // "idle" | "in-use"
}

function renderDeviceCard(d, task, lastAction) {
  const isAiMode = d.controllerMode && d.controllerMode !== "HUMAN";
  const isMine = d.id === currentDeviceId;
  const canManageAi = can(UI_CAPABILITIES.MANAGE_AI_CONTROLLER);

  const card = document.createElement("article");
  card.className = `device-card ${cardStatusClass(d)}${isMine ? " mine" : ""}${isAiMode && !canManageAi ? " ai-locked" : ""}${d.canOpen ? " openable" : " restricted"}`;
  if (d.lastSeenAt) card.title = `Last responded: ${new Date(d.lastSeenAt).toLocaleString()}`;

  const body = document.createElement("div");
  body.className = "device-card-body";

  const dot = document.createElement("span");
  dot.className = "status-dot";
  body.appendChild(dot);

  const info = document.createElement("div");
  info.className = "device-card-info";

  const labelRow = document.createElement("div");
  labelRow.className = "device-card-label";
  labelRow.textContent = d.label;
  info.appendChild(labelRow);

  const metaRow = document.createElement("div");
  metaRow.className = "device-card-meta";
  const metaParts = [d.status, d.id, d.hostLabel || "this-mac"];
  const health = healthSuffix(d);
  if (health) metaParts.push(health.trim());
  metaRow.textContent = metaParts.join(" · ");
  info.appendChild(metaRow);

  // Controller mode is operational status, not a privileged queue detail.
  // VAs may see that a device is AI-controlled so the disabled claim makes
  // sense; only admins see the task/audit internals and management controls.
  if (isAiMode) {
    const pill = document.createElement("span");
    pill.className = "mode-pill";
    pill.textContent = d.controllerMode;
    info.appendChild(pill);
  }

  body.appendChild(info);

  if (isMine) {
    const badge = document.createElement("span");
    badge.className = "mine-badge";
    badge.textContent = "You're controlling this";
    body.appendChild(badge);
  }

  card.appendChild(body);

  const access = document.createElement("div");
  access.className = `device-access ${d.assignedToViewer ? "assigned" : "unassigned"}`;
  const accessLabel = document.createElement("strong");
  accessLabel.textContent = d.assignedToViewer ? "Assigned to you" : "Not assigned to you";
  const accessReason = document.createElement("span");
  accessReason.textContent = d.openReason || (d.canOpen ? "Available to open." : "This phone cannot be opened.");
  access.append(accessLabel, accessReason);
  card.appendChild(access);

  const networkState = document.createElement("div");
  networkState.className = "device-safe-status";
  const egress = d.network?.providerLabel || d.network?.gatewayLabel || d.network?.egress || "No egress assigned";
  const verification = d.networkMismatch ? "Network mismatch"
    : d.networkVerified ? "Network verified" : "Network not verified";
  networkState.textContent = `${egress} · ${verification} · ${formatLastSeen(d.lastSeenAt)}`;
  card.appendChild(networkState);

  if (d.currentOperator || d.assignment) {
    const context = document.createElement("div");
    context.className = "device-card-context";
    const controller = d.currentOperator ? `Controlled by ${d.currentOperator}` : "No active human controller";
    const assigned = d.assignment
      ? `Assigned to ${d.assignment.assignee} · ${assignmentWindow(d.assignment)}`
      : "No assignment";
    context.textContent = `${controller} · ${assigned}`;
    card.appendChild(context);
  }

  if (canManageAi && isAiMode) {
    card.appendChild(buildAiStatusRows(task, lastAction, { includeMode: false }));
  } else if (!canManageAi && isAiMode) {
    const locked = document.createElement("div");
    locked.className = "ai-locked-note";
    locked.textContent = "AI-controlled — an operations handoff is required.";
    card.appendChild(locked);
  }

  if (d.assignedToViewer && !isAiMode) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "open-device-button";
    open.textContent = d.canOpen ? "Open device" : d.accessState === "in_use" ? "In use" : "Open device";
    open.disabled = !d.canOpen;
    open.addEventListener("click", () => requestDeviceOpen(d));
    card.appendChild(open);
  }

  if (canManageAi) {
    const controls = buildFleetAiControls(d, task);
    if (controls) card.appendChild(controls);
  }

  return card;
}

// Shared by the fleet card (glanceable, no takeover required) and the
// detail view's AI-status pane — same fields, same layout, so a fix or a
// new field (e.g. a future confidence/retry-count from Architecture
// Baseline.md §15) only needs to be added once.
function buildAiStatusRows(task, lastAction, { includeMode, mode } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "ai-status";

  const addRow = (label, value) => {
    const row = document.createElement("div");
    row.className = "ai-status-row";
    const labelEl = document.createElement("span");
    labelEl.className = "ai-status-label";
    labelEl.textContent = `${label}: `;
    row.append(labelEl, document.createTextNode(value));
    wrap.appendChild(row);
  };

  if (includeMode) addRow("Mode", mode);
  if (task) {
    addRow("Task", task.goal);
    addRow("State", `${task.state} (${task.priority})`);
  } else {
    addRow("Task", "none queued");
  }
  if (lastAction) {
    addRow("Last action", `${lastAction.type} — ${new Date(lastAction.at).toLocaleTimeString()}`);
  }

  return wrap;
}

// Shared by the fleet card's compact button and the detail view's full one
// — same control, same wiring (MS6.3.2: sends emergency_stop directly, not
// routed through the command console's text parser, so it still works even
// if that parser or the queue engine is somehow stuck), just sized
// differently for the two contexts.
function buildControlButton(label, onClick, className = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `ai-control-button${className ? ` ${className}` : ""}`;
  btn.textContent = label;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

async function runAdminCommand(text, { showOutput = false } = {}) {
  if (!canManageOperations()) return null;
  const generation = operatorProfileGeneration;
  const res = await fetch("/api/queue/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!profileRequestActive(generation, UI_CAPABILITIES.MANAGE_QUEUE)) return null;
  if (showOutput) commandOutputEl.textContent = formatCommandResult(body);
  if (!res.ok && !showOutput) selectErrorEl.textContent = body.error || `Command failed (HTTP ${res.status}).`;
  if (currentView === "admin") refreshAdminView();
  return { ok: res.ok, body };
}

function buildFleetAiControls(device, task) {
  if (!can(UI_CAPABILITIES.MANAGE_AI_CONTROLLER)) return null;
  const mode = device.controllerMode || "HUMAN";
  const wrap = document.createElement("div");
  wrap.className = "ai-controls";

  if (mode === "HUMAN") {
    if (device.status !== "idle") return null;
    wrap.appendChild(buildControlButton("Switch to AI", () => safeSend({ type: "switch_to_ai", deviceId: device.id })));
    return wrap;
  }

  if (mode === "AI_RUNNING") {
    wrap.appendChild(buildControlButton("Pause", () => runAdminCommand(`/pause ${device.id}`)));
  }
  if (mode === "AI_PAUSED") {
    wrap.appendChild(buildControlButton("Resume", () => runAdminCommand(`/resume ${device.id}`)));
  }
  if (mode === "AI_RUNNING" || mode === "AI_PAUSED") {
    wrap.appendChild(buildControlButton("Stop task", () => runAdminCommand(`/stop ${device.id}`)));
  }

  wrap.appendChild(buildControlButton("Take over", () => takeOverDevice(device.id)));
  wrap.appendChild(buildControlButton(
    "Emergency stop",
    () => safeSend({ type: "emergency_stop", deviceId: device.id }),
    "danger"
  ));
  return wrap;
}

// MS6.3.1's read-only status pane, now rendered into the detail view for
// the device currently open there — what an AI worker is doing, visible to
// a human operator without them taking control of it. No task running yet
// means only mode + last action are known — that's still worth showing,
// since MS8's real worker doesn't exist yet and every AI-mode device today
// got there via a manual /mode or switch_to_ai, not a task.
function renderDetailAiStatus(deviceId, task, lastAction) {
  const device = lastDevices.find((d) => d.id === deviceId);
  const isAiMode = device?.controllerMode && device.controllerMode !== "HUMAN";
  detailAiStatusEl.innerHTML = "";
  if (!can(UI_CAPABILITIES.MANAGE_AI_CONTROLLER) || !isAiMode) return;

  const wrap = buildAiStatusRows(task, lastAction, { includeMode: true, mode: device.controllerMode });
  const controls = buildFleetAiControls(device, task);
  if (controls) wrap.appendChild(controls);
  detailAiStatusEl.appendChild(wrap);
}

// Only worth mentioning when there's something to say — a healthy device
// with no failures doesn't need "0 failed attempts" cluttering every row.
function healthSuffix(d) {
  if (d.consecutiveFailures > 0) return ` (${d.consecutiveFailures} failed attempt${d.consecutiveFailures === 1 ? "" : "s"})`;
  return "";
}

function selectDevice(id) {
  if (!can(UI_CAPABILITIES.CONTROL_DEVICE)) return;
  pendingDeviceId = id;
  setBusy(true);
  selectErrorEl.textContent = "";
  showDetailView(id);
  if (!currentDeviceId) hintEl.textContent = "Loading…";
  safeSend({ type: "select_device", deviceId: id });
}

function requestDeviceOpen(device) {
  if (!device?.canOpen) {
    selectErrorEl.textContent = device?.openReason || "This phone cannot be opened.";
    return false;
  }
  selectDevice(device.id);
  return true;
}

// Stops whatever AI control a device has and claims it, in one step
// (Architecture Baseline.md §4's "Switch to Human VA Mode"). The server
// replies the same way select_device does (a frame for pendingDeviceId), so
// confirmSelection below handles both identically.
function takeOverDevice(id) {
  if (!can(UI_CAPABILITIES.MANAGE_AI_CONTROLLER)) return;
  pendingDeviceId = id;
  setBusy(true);
  selectErrorEl.textContent = "";
  showDetailView(id);
  if (!currentDeviceId) hintEl.textContent = "Taking over…";
  safeSend({ type: "takeover", deviceId: id });
}

// The server confirmed this selection (a frame arrived for it) — now it's
// safe to treat it as the active device. The view is already showing detail
// (selectDevice/takeOverDevice navigated there optimistically); this just
// populates it and refreshes the fleet render so the "you're controlling
// this" badge shows up on the right card.
function confirmSelection(id) {
  fileRequestGeneration++;
  fileListEl.innerHTML = "";
  currentDeviceId = id;
  pendingDeviceId = null;
  selectErrorEl.textContent = "";
  // Only navigate to detail view if the operator hasn't already explicitly
  // clicked back to fleet in the narrow window between the click and this
  // confirmation — without this check, a fast "← Fleet" click right after
  // selecting a device would get silently overridden the instant the server
  // responded, yanking the operator back into a view they just left.
  if (currentView === "detail") showDetailView(id);
  uploadFormEl.hidden = false;
  swipeControlsEl.hidden = false;
  homeButtonEl.hidden = false;
  typeFormEl.hidden = false;
  releaseButtonEl.hidden = false;
  filesHintEl.textContent = "";
  setBusy(false);
  refreshFiles();
  if (lastDevices.length) renderFleetSafely(lastDevices);
}

// The device we were actually using failed mid-session (not a rejected new
// selection attempt — see the "error" handler above for that case), or the
// operator explicitly released it. Stop pretending this client still
// controls it, and there's nothing left to show in detail view for it.
function deselect(message) {
  fileRequestGeneration++;
  currentDeviceId = null;
  pendingDeviceId = null;
  screenEl.innerHTML = "";
  hintEl.textContent = message;
  uploadFormEl.hidden = true;
  swipeControlsEl.hidden = true;
  homeButtonEl.hidden = true;
  typeFormEl.hidden = true;
  releaseButtonEl.hidden = true;
  fileListEl.innerHTML = "";
  filesHintEl.textContent = "";
  setBusy(false);
  showFleetView();
}

// A VA finishing a task should be able to free the device for someone else
// without switching to a different one or closing the tab. The server never
// sends a direct reply to release_device (only a device_list broadcast to
// everyone), so this cleans up locally right away rather than waiting for a
// response that isn't coming.
releaseButtonEl.addEventListener("click", () => {
  if (!currentDeviceId) return;
  safeSend({ type: "release_device", deviceId: currentDeviceId });
  deselect("Select a device to begin.");
});

function renderFrame(frame) {
  if (frame.kind === "image") {
    screenEl.innerHTML = `<img src="data:${frame.mime};base64,${frame.data}" alt="" />`;
  } else {
    screenEl.innerHTML = frame.data;
  }
  hintEl.textContent = "";
}

screenEl.addEventListener("click", (e) => {
  if (!currentDeviceId || pendingDeviceId || busy) return;
  const image = screenEl.querySelector("img, svg");
  if (!image) return;
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  setBusy(true);
  safeSend({ type: "tap", deviceId: currentDeviceId, x, y });
});

swipeControlsEl.addEventListener("click", (e) => {
  const direction = e.target.dataset.direction;
  if (!direction || !currentDeviceId || pendingDeviceId || busy) return;
  setBusy(true);
  safeSend({ type: "swipe", deviceId: currentDeviceId, direction });
});

homeButtonEl.addEventListener("click", () => {
  if (!currentDeviceId || pendingDeviceId || busy) return;
  setBusy(true);
  safeSend({ type: "home", deviceId: currentDeviceId });
});

typeFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = typeInputEl.value;
  if (!text || !currentDeviceId || pendingDeviceId || busy) return;
  setBusy(true);
  safeSend({ type: "type_text", deviceId: currentDeviceId, text });
  typeInputEl.value = "";
});

async function refreshFiles() {
  if (!currentDeviceId) return;
  const deviceId = currentDeviceId;
  const generation = ++fileRequestGeneration;
  const res = await fetch(`/api/devices/${deviceId}/files`);
  const { files } = await res.json();
  if (generation !== fileRequestGeneration || deviceId !== currentDeviceId || signedOut) return;
  renderFileList(files, deviceId);
}

function renderFileList(files, deviceId) {
  fileListEl.innerHTML = "";
  if (files.length === 0) {
    filesHintEl.textContent = "No files yet.";
  } else {
    filesHintEl.textContent = "";
  }
  for (const f of files) {
    const li = document.createElement("li");

    const link = document.createElement("a");
    link.href = `/api/devices/${deviceId}/files/${encodeURIComponent(f.name)}`;
    link.textContent = f.name;
    link.download = f.name;

    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatSize(f.size);

    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", () => deleteFile(f.name, deviceId));

    li.append(link, size, del);
    fileListEl.appendChild(li);
  }
}

async function deleteFile(name, deviceId) {
  if (deviceId !== currentDeviceId || signedOut) return;
  await fetch(`/api/devices/${deviceId}/files/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (deviceId === currentDeviceId) refreshFiles();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

uploadFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = uploadInputEl.files[0];
  if (!file || !currentDeviceId) return;
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`/api/devices/${currentDeviceId}/files`, { method: "POST", body });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: `upload failed (HTTP ${res.status})` }));
    filesHintEl.textContent = error;
    return;
  }
  uploadInputEl.value = "";
  refreshFiles();
});


// ---------- Admin/dev workspace ----------

function shortId(id) {
  if (!id) return "—";
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatAccount(selector) {
  if (!selector || Object.keys(selector).length === 0) return "—";
  if (selector.accountId) return selector.accountId;
  if (selector.platform) return selector.platform;
  return Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(", ");
}

function formatWindow(task) {
  if (!task.earliestStart && !task.latestEnd) return "Any time";
  const start = task.earliestStart ? formatDate(task.earliestStart) : "now";
  const end = task.latestEnd ? formatDate(task.latestEnd) : "open";
  return `${start} → ${end}`;
}

function formatAuditDetail(detail) {
  if (!detail || typeof detail !== "object") return detail ? String(detail) : "—";
  const entries = Object.entries(detail);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => {
    const rendered = value && typeof value === "object" ? JSON.stringify(value) : String(value);
    return `${key}=${rendered}`;
  }).join(" · ");
}

function addCell(row, text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text ?? "—";
  if (className) cell.className = className;
  row.appendChild(cell);
  return cell;
}

async function refreshQueueViewer() {
  if (!canManageOperations()) return;
  const generation = operatorProfileGeneration;
  queueStateEl.textContent = "Loading…";
  try {
    const res = await fetch("/api/queue");
    const body = await res.json().catch(() => ({}));
    if (!profileRequestActive(generation, UI_CAPABILITIES.MANAGE_QUEUE)) return;
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    queueStateEl.textContent = body.paused ? "Queue paused" : "Queue running";
    queueBodyEl.innerHTML = "";
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    queueEmptyEl.hidden = tasks.length !== 0;

    for (const task of tasks) {
      const row = document.createElement("tr");
      row.title = task.id;
      addCell(row, shortId(task.id), "mono");
      addCell(row, task.goal || "—", "goal-cell");
      addCell(row, task.deviceSelector?.deviceId || "—", "mono");
      addCell(row, formatAccount(task.accountSelector));
      addCell(row, task.state || "—");
      addCell(row, task.priority || "—");
      addCell(row, formatWindow(task), "window-cell");
      queueBodyEl.appendChild(row);
    }
  } catch (err) {
    if (!profileRequestActive(generation, UI_CAPABILITIES.MANAGE_QUEUE)) return;
    queueBodyEl.innerHTML = "";
    queueEmptyEl.hidden = false;
    queueEmptyEl.textContent = `Could not load queue: ${err.message}`;
    queueStateEl.textContent = "Unavailable";
  }
}

async function refreshAuditViewer() {
  if (!can(UI_CAPABILITIES.VIEW_AUDIT)) return;
  const generation = operatorProfileGeneration;
  try {
    const res = await fetch("/api/audit?limit=200");
    const body = await res.json().catch(() => ({}));
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_AUDIT)) return;
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    auditBodyEl.innerHTML = "";
    const events = Array.isArray(body.events) ? body.events : [];
    auditEmptyEl.hidden = events.length !== 0;
    auditEmptyEl.textContent = "No audit events.";

    for (const event of events) {
      const row = document.createElement("tr");
      addCell(row, formatDate(event.at), "time-cell");
      addCell(row, event.operator || "—");
      addCell(row, event.type || "—", "event-cell");
      addCell(row, event.deviceId || "—", "mono");
      addCell(row, formatAuditDetail(event.detail), "detail-cell");
      auditBodyEl.appendChild(row);
    }
  } catch (err) {
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_AUDIT)) return;
    auditBodyEl.innerHTML = "";
    auditEmptyEl.hidden = false;
    auditEmptyEl.textContent = `Could not load audit log: ${err.message}`;
  }
}

const USER_ROLES = Object.freeze([
  ["va", "VA"],
  ["content_creator", "Content creator"],
  ["editor", "Editor"],
  ["manager", "Manager"],
  ["admin", "Admin"],
]);

function parseIdList(value) {
  return [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];
}

function roleSelect(selected) {
  const select = document.createElement("select");
  for (const [value, label] of USER_ROLES) select.append(new Option(label, value, false, value === selected));
  return select;
}

function labeledControl(text, control) {
  const label = document.createElement("label");
  label.append(document.createTextNode(text), control);
  return label;
}

function syncAllDevicesControl(roleControl, allDevicesControl, deviceIdsControl) {
  const isVa = roleControl.value === "va";
  if (isVa) allDevicesControl.checked = false;
  allDevicesControl.disabled = isVa;
  deviceIdsControl.disabled = allDevicesControl.checked;
}

function renderUsers(users) {
  usersListEl.replaceChildren();
  usersEmptyEl.hidden = users.length !== 0;
  for (const user of users) {
    const card = document.createElement("article");
    card.className = "user-card";

    const heading = document.createElement("div");
    heading.className = "user-card-heading";
    const username = document.createElement("strong");
    username.textContent = user.username;
    const state = document.createElement("span");
    state.className = `user-state ${user.active ? "active" : "inactive"}`;
    state.textContent = user.active ? "Active" : "Inactive";
    heading.append(username, state);

    const presence = document.createElement("p");
    presence.className = "user-presence";
    const live = user.presence?.online ? "Online" : "Offline";
    const sessions = Number(user.presence?.activeSessions) || 0;
    const phones = Array.isArray(user.presence?.currentPhones)
      ? user.presence.currentPhones.map(phone => phone.label).join(", ") : "";
    presence.textContent = `${live} · ${sessions} active session${sessions === 1 ? "" : "s"}`
      + (phones ? ` · Using ${phones}` : "")
      + (!user.presence?.online && user.presence?.lastSeenAt ? ` · ${formatLastSeen(user.presence.lastSeenAt)}` : "");

    const form = document.createElement("form");
    form.className = "user-form user-edit-form";
    const role = roleSelect(user.role);
    const active = document.createElement("input");
    active.type = "checkbox";
    active.checked = user.active === true;
    const activeLabel = labeledControl("Active", active);
    activeLabel.className = "user-checkbox";

    const allDevices = document.createElement("input");
    allDevices.type = "checkbox";
    allDevices.checked = user.allowedDevices === null;
    const allDevicesLabel = labeledControl("All devices", allDevices);
    allDevicesLabel.className = "user-checkbox";
    const deviceIds = document.createElement("input");
    deviceIds.value = Array.isArray(user.allowedDevices) ? user.allowedDevices.join(", ") : "";
    deviceIds.placeholder = "No devices";
    allDevices.addEventListener("change", () => syncAllDevicesControl(role, allDevices, deviceIds));
    role.addEventListener("change", () => syncAllDevicesControl(role, allDevices, deviceIds));
    syncAllDevicesControl(role, allDevices, deviceIds);

    const research = document.createElement("input");
    research.value = Array.isArray(user.allowedResearchWorkspaces) ? user.allowedResearchWorkspaces.join(", ") : "";
    research.placeholder = "No research workspaces";
    const password = document.createElement("input");
    password.type = "password";
    password.minLength = 12;
    password.maxLength = 512;
    password.autocomplete = "new-password";
    password.placeholder = "Leave blank to keep password";
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save";
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "danger";
    revoke.textContent = "Sign out all sessions";

    form.append(
      labeledControl("Role", role),
      activeLabel,
      labeledControl("Device IDs", deviceIds),
      allDevicesLabel,
      labeledControl("Research workspaces", research),
      labeledControl("Reset password", password),
      save,
      revoke,
    );
    form.addEventListener("submit", async event => {
      event.preventDefault();
      usersMessageEl.textContent = "";
      save.disabled = true;
      const change = {
        role: role.value,
        active: active.checked,
        allowedDevices: allDevices.checked ? null : parseIdList(deviceIds.value),
        allowedResearchWorkspaces: parseIdList(research.value),
      };
      if (password.value) change.password = password.value;
      try {
        const response = await fetch(`/api/admin/users/${encodeURIComponent(user.username)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(change),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not update user");
        usersMessageEl.textContent = `${user.username} updated.`;
        await refreshUsers();
      } catch (error) {
        usersMessageEl.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });

    revoke.addEventListener("click", async () => {
      usersMessageEl.textContent = "";
      revoke.disabled = true;
      try {
        const response = await fetch(`/api/admin/users/${encodeURIComponent(user.username)}/revoke-sessions`, { method: "POST" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not sign out sessions");
        usersMessageEl.textContent = `${user.username} sessions signed out.`;
        await refreshUsers();
      } catch (error) {
        usersMessageEl.textContent = error.message;
      } finally {
        revoke.disabled = false;
      }
    });

    const activity = document.createElement("details");
    const activitySummary = document.createElement("summary");
    const assignments = Array.isArray(user.assignments) ? user.assignments : [];
    const recentAudit = Array.isArray(user.recentAudit) ? user.recentAudit : [];
    activitySummary.textContent = `${assignments.length} assignment${assignments.length === 1 ? "" : "s"} · ${recentAudit.length} recent audit event${recentAudit.length === 1 ? "" : "s"}`;
    const assignmentList = document.createElement("ul");
    for (const assignment of assignments.slice(0, 10)) {
      const item = document.createElement("li");
      item.textContent = `${assignment.status.replaceAll("_", " ")} · ${assignment.instructions}`
        + (assignment.deviceId ? ` · ${assignment.deviceId}` : "")
        + (assignment.startAt || assignment.endAt ? ` · ${formatDate(assignment.startAt)} → ${formatDate(assignment.endAt)}` : "");
      assignmentList.append(item);
    }
    const auditList = document.createElement("ul");
    for (const event of recentAudit) {
      const item = document.createElement("li");
      item.textContent = `${formatDate(event.at)} · ${event.type}` + (event.deviceId ? ` · ${event.deviceId}` : "");
      auditList.append(item);
    }
    activity.append(activitySummary);
    if (assignments.length) activity.append(assignmentList);
    if (recentAudit.length) activity.append(auditList);

    card.append(heading, presence, form, activity);
    usersListEl.append(card);
  }
}

async function refreshUsers() {
  if (!can(UI_CAPABILITIES.MANAGE_USERS)) return;
  const generation = operatorProfileGeneration;
  try {
    const response = await fetch("/api/admin/users");
    const body = await response.json().catch(() => ({}));
    if (!profileRequestActive(generation, UI_CAPABILITIES.MANAGE_USERS)) return;
    if (!response.ok) throw new Error(body.error || "Could not load users");
    renderUsers(Array.isArray(body.users) ? body.users : []);
  } catch (error) {
    if (!profileRequestActive(generation, UI_CAPABILITIES.MANAGE_USERS)) return;
    usersListEl.replaceChildren();
    usersEmptyEl.hidden = false;
    usersEmptyEl.textContent = `Could not load users: ${error.message}`;
  }
}

userCreateAllDevicesEl.addEventListener("change", () => {
  syncAllDevicesControl(userCreateRoleEl, userCreateAllDevicesEl, userCreateDevicesEl);
});
userCreateRoleEl.addEventListener("change", () => {
  syncAllDevicesControl(userCreateRoleEl, userCreateAllDevicesEl, userCreateDevicesEl);
});
syncAllDevicesControl(userCreateRoleEl, userCreateAllDevicesEl, userCreateDevicesEl);

userCreateFormEl.addEventListener("submit", async event => {
  event.preventDefault();
  usersMessageEl.textContent = "";
  const submit = userCreateFormEl.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: userCreateUsernameEl.value,
        password: userCreatePasswordEl.value,
        role: userCreateRoleEl.value,
        active: true,
        allowedDevices: userCreateAllDevicesEl.checked ? null : parseIdList(userCreateDevicesEl.value),
        allowedResearchWorkspaces: parseIdList(userCreateResearchEl.value),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not create user");
    usersMessageEl.textContent = `${body.operator.username} created.`;
    userCreateFormEl.reset();
    syncAllDevicesControl(userCreateRoleEl, userCreateAllDevicesEl, userCreateDevicesEl);
    await refreshUsers();
  } catch (error) {
    usersMessageEl.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

usersRefreshButtonEl.addEventListener("click", refreshUsers);

async function refreshAdminView() {
  if (!canManageOperations()) return;
  await Promise.all([
    refreshQueueViewer(),
    can(UI_CAPABILITIES.VIEW_AUDIT) ? refreshAuditViewer() : Promise.resolve(),
    can(UI_CAPABILITIES.MANAGE_USERS) ? refreshUsers() : Promise.resolve(),
  ]);
}

function formatCommandResult(body) {
  if (!body || typeof body !== "object") return "No response.";
  if (body.error) return `Error: ${body.error}`;
  if (body.proposed) {
    return [`Proposed goal: ${body.proposed.goal}`, body.note || ""].filter(Boolean).join("\n");
  }
  if (body.task) {
    const task = body.task;
    return [
      `Task: ${task.id || "—"}`,
      `Goal: ${task.goal || "—"}`,
      `State: ${task.state || "—"}`,
      `Priority: ${task.priority || "—"}`,
      `Device: ${task.deviceSelector?.deviceId || "—"}`,
      `Window: ${formatWindow(task)}`,
    ].join("\n");
  }
  if (Array.isArray(body.tasks)) {
    if (body.tasks.length === 0) return "Queue is empty.";
    return [`${body.tasks.length} task(s):`, ...body.tasks.map((t) =>
      `${shortId(t.id)}  ${t.state}  ${t.priority}  ${t.deviceSelector?.deviceId || "—"}  ${t.goal}`
    )].join("\n");
  }
  if (Array.isArray(body.events)) {
    if (body.events.length === 0) return "No audit events.";
    return [`${body.events.length} audit event(s):`, ...body.events.slice(0, 30).map((e) =>
      `${formatDate(e.at)}  ${e.operator || "—"}  ${e.type || "—"}  ${e.deviceId || "—"}`
    )].join("\n");
  }
  if (body.health) {
    const items = Array.isArray(body.health) ? body.health : [body.health];
    return items.map((d) =>
      `${d.id}: ${d.status} · ${d.controllerMode}${d.consecutiveFailures ? ` · failures=${d.consecutiveFailures}` : ""}`
    ).join("\n");
  }
  if (body.controllerMode) return `Controller mode: ${body.controllerMode}`;
  if (body.ok) return "Command completed successfully.";
  return Object.entries(body).map(([key, value]) =>
    `${key}: ${value && typeof value === "object" ? JSON.stringify(value) : value}`
  ).join("\n");
}

commandFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = commandInputEl.value.trim();
  if (!text || !canManageOperations()) return;
  commandOutputEl.textContent = "Running…";
  const result = await runAdminCommand(text, { showOutput: true });
  if (result?.ok) commandInputEl.value = "";
});

queueRefreshButtonEl.addEventListener("click", refreshQueueViewer);
auditRefreshButtonEl.addEventListener("click", refreshAuditViewer);
adminRefreshButtonEl.addEventListener("click", refreshAdminView);
