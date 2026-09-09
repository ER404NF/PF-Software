const loginFormEl = document.getElementById("login-form");
const loginUsernameEl = document.getElementById("login-username");
const loginPasswordEl = document.getElementById("login-password");
const loginErrorEl = document.getElementById("login-error");
const logoutButtonEl = document.getElementById("logout-button");
const whoamiEl = document.getElementById("whoami");
const roleBadgeEl = document.getElementById("role-badge");
const adminNavEl = document.getElementById("admin-nav");
const fleetNavButtonEl = document.getElementById("fleet-nav-button");
const adminNavButtonEl = document.getElementById("admin-nav-button");
const appEl = document.getElementById("app");
const connectionStatusEl = document.getElementById("connection-status");
const fleetViewEl = document.getElementById("fleet-view");
const fleetGroupsEl = document.getElementById("fleet-groups");
const selectErrorEl = document.getElementById("select-error");
const detailViewEl = document.getElementById("detail-view");
const backToFleetButtonEl = document.getElementById("back-to-fleet-button");
const detailTitleEl = document.getElementById("detail-title");
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
const auditRefreshButtonEl = document.getElementById("audit-refresh-button");
const auditBodyEl = document.getElementById("audit-body");
const auditEmptyEl = document.getElementById("audit-empty");

// currentDeviceId is only ever set once the server has confirmed a
// selection (a "frame" arrives for it) — never optimistically. Otherwise a
// failed attempt to switch to someone else's device would incorrectly wipe
// out an already-working session that the server never actually released.
let currentDeviceId = null;
let pendingDeviceId = null;

// Safe profile returned by /api/me or /api/login. Role controls management
// surfaces; allowedDevices remains a separate server-enforced device RBAC
// concern. Never infer admin from allowedDevices === null.
let currentOperator = null;

function isAdmin() {
  return currentOperator?.role === "admin";
}


// Most recent device_list, kept around so the detail view (e.g. its title,
// its AI-status pane) can be re-rendered for the currently-open device
// without waiting for the next broadcast — e.g. right after confirmSelection.
let lastDevices = [];

// 'fleet' | 'detail' | 'admin'. Purely a client-side view switch, not a route — no
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
  adminNavButtonEl.classList.toggle("active", currentView === "admin");
}

function showFleetView() {
  currentView = "fleet";
  fleetViewEl.hidden = false;
  detailViewEl.hidden = true;
  adminViewEl.hidden = true;
  updateTopNav();
}

function showDetailView(deviceId) {
  currentView = "detail";
  fleetViewEl.hidden = true;
  detailViewEl.hidden = false;
  adminViewEl.hidden = true;
  updateTopNav();
  const device = lastDevices.find((d) => d.id === deviceId);
  detailTitleEl.textContent = device ? device.label : "";
}

function showAdminView() {
  if (!isAdmin()) return;
  currentView = "admin";
  fleetViewEl.hidden = true;
  detailViewEl.hidden = true;
  adminViewEl.hidden = false;
  updateTopNav();
  refreshAdminView();
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
  window.dispatchEvent(new Event("operator-profile-changed"));
  currentOperator = profile?.username ? {
    username: profile.username,
    role: profile.role === "admin" ? "admin" : "va",
    allowedDevices: profile.allowedDevices ?? null,
  } : null;

  whoamiEl.textContent = currentOperator ? `Signed in as ${currentOperator.username}` : "";
  roleBadgeEl.textContent = currentOperator ? currentOperator.role.toUpperCase() : "";
  roleBadgeEl.hidden = !currentOperator;
  adminNavEl.hidden = !isAdmin();

  // Never leave a privileged surface visible after logout or a role change.
  if (!isAdmin() && currentView === "admin") showFleetView();
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
  if (ws) ws.close();
  await fetch("/api/logout", { method: "POST" });
  setOperatorProfile(null);
  showLogin();
});

backToFleetButtonEl.addEventListener("click", () => {
  showFleetView();
});

fleetNavButtonEl.addEventListener("click", () => showFleetView());
adminNavButtonEl.addEventListener("click", () => showAdminView());

function connect() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.addEventListener("open", () => {
    connectionStatusEl.hidden = true;
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "device_list") renderFleetSafely(msg.devices);

    if (msg.type === "frame") {
      if (msg.deviceId === pendingDeviceId) confirmSelection(pendingDeviceId);
      if (msg.deviceId === currentDeviceId) {
        renderFrame(msg);
        setBusy(false);
      }
    }

    if (msg.type === "error") {
      if (msg.deviceId === pendingDeviceId) {
        // A selection attempt failed — surface it without touching whatever
        // device (if any) is already confirmed and working, and bounce back
        // from the optimistic detail-view navigation selectDevice/
        // takeOverDevice already did.
        pendingDeviceId = null;
        selectErrorEl.textContent = msg.message;
        if (!currentDeviceId) showFleetView();
      } else if (msg.deviceId === currentDeviceId) {
        deselect(msg.message);
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

  ws.addEventListener("close", () => {
    pendingDeviceId = null;
    fleetGroupsEl.innerHTML = "";
    selectErrorEl.textContent = "";
    if (signedOut) return; // don't fight an intentional sign-out
    connectionStatusEl.hidden = false;
    deselect("Disconnected — reconnecting…");
    setTimeout(connect, 2000);
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
  const token = ++renderToken;
  const aiDevices = devices.filter((d) => d.controllerMode && d.controllerMode !== "HUMAN");
  // Queue/audit are admin-only surfaces now. A VA never calls either endpoint
  // merely to render the fleet; it only sees the device's coarse controller
  // mode so it understands why an AI-controlled phone cannot be claimed.
  const [tasksByDevice, lastActionByDevice] = isAdmin() && aiDevices.length
    ? await Promise.all([fetchActiveTasksByDevice(), fetchLastActionByDevice()])
    : [new Map(), new Map()];
  if (token !== renderToken) return; // a newer device_list has already re-rendered
  renderFleet(devices, tasksByDevice, lastActionByDevice);
  if (currentView === "detail" && currentDeviceId) {
    renderDetailAiStatus(currentDeviceId, tasksByDevice.get(currentDeviceId), lastActionByDevice.get(currentDeviceId));
  }
}

async function fetchActiveTasksByDevice() {
  const map = new Map();
  try {
    const res = await fetch("/api/queue");
    const { tasks } = await res.json();
    for (const t of tasks) {
      const id = t.deviceSelector?.deviceId;
      if (id) map.set(id, t);
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
  for (const [hostLabel, groupDevices] of groupByHost(devices)) {
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
  const admin = isAdmin();

  const card = document.createElement("article");
  card.className = `device-card ${cardStatusClass(d)}${isMine ? " mine" : ""}${isAiMode && !admin ? " ai-locked" : ""}`;
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
  const metaParts = [d.status];
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

  if (admin && isAiMode) {
    card.appendChild(buildAiStatusRows(task, lastAction, { includeMode: false }));
  } else if (!admin && isAiMode) {
    const locked = document.createElement("div");
    locked.className = "ai-locked-note";
    locked.textContent = "AI-controlled — admin handoff required.";
    card.appendChild(locked);
  }

  card.addEventListener("click", () => {
    if (isAiMode) {
      if (admin) takeOverDevice(d.id);
      else selectErrorEl.textContent = `${d.label} is in AI mode. An admin must hand it back to Human mode first.`;
      return;
    }
    selectDevice(d.id);
  });

  if (admin) {
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
  if (!isAdmin()) return null;
  const res = await fetch("/api/queue/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (showOutput) commandOutputEl.textContent = formatCommandResult(body);
  if (!res.ok && !showOutput) selectErrorEl.textContent = body.error || `Command failed (HTTP ${res.status}).`;
  if (currentView === "admin") refreshAdminView();
  return { ok: res.ok, body };
}

function buildFleetAiControls(device, task) {
  if (!isAdmin()) return null;
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
  if (!isAdmin() || !isAiMode) return;

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
  pendingDeviceId = id;
  selectErrorEl.textContent = "";
  showDetailView(id);
  if (!currentDeviceId) hintEl.textContent = "Loading…";
  safeSend({ type: "select_device", deviceId: id });
}

// Stops whatever AI control a device has and claims it, in one step
// (Architecture Baseline.md §4's "Switch to Human VA Mode"). The server
// replies the same way select_device does (a frame for pendingDeviceId), so
// confirmSelection below handles both identically.
function takeOverDevice(id) {
  pendingDeviceId = id;
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
  currentDeviceId = null;
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
  safeSend({ type: "release_device" });
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
  if (!currentDeviceId || busy) return;
  const rect = screenEl.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  setBusy(true);
  safeSend({ type: "tap", x, y });
});

swipeControlsEl.addEventListener("click", (e) => {
  const direction = e.target.dataset.direction;
  if (!direction || !currentDeviceId || busy) return;
  setBusy(true);
  safeSend({ type: "swipe", direction });
});

homeButtonEl.addEventListener("click", () => {
  if (!currentDeviceId || busy) return;
  setBusy(true);
  safeSend({ type: "home" });
});

typeFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = typeInputEl.value;
  if (!text || !currentDeviceId || busy) return;
  setBusy(true);
  safeSend({ type: "type_text", text });
  typeInputEl.value = "";
});

async function refreshFiles() {
  if (!currentDeviceId) return;
  const res = await fetch(`/api/devices/${currentDeviceId}/files`);
  const { files } = await res.json();
  renderFileList(files);
}

function renderFileList(files) {
  fileListEl.innerHTML = "";
  if (files.length === 0) {
    filesHintEl.textContent = "No files yet.";
  } else {
    filesHintEl.textContent = "";
  }
  for (const f of files) {
    const li = document.createElement("li");

    const link = document.createElement("a");
    link.href = `/api/devices/${currentDeviceId}/files/${encodeURIComponent(f.name)}`;
    link.textContent = f.name;
    link.download = f.name;

    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatSize(f.size);

    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", () => deleteFile(f.name));

    li.append(link, size, del);
    fileListEl.appendChild(li);
  }
}

async function deleteFile(name) {
  await fetch(`/api/devices/${currentDeviceId}/files/${encodeURIComponent(name)}`, { method: "DELETE" });
  refreshFiles();
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
  if (!isAdmin()) return;
  queueStateEl.textContent = "Loading…";
  try {
    const res = await fetch("/api/queue");
    const body = await res.json().catch(() => ({}));
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
    queueBodyEl.innerHTML = "";
    queueEmptyEl.hidden = false;
    queueEmptyEl.textContent = `Could not load queue: ${err.message}`;
    queueStateEl.textContent = "Unavailable";
  }
}

async function refreshAuditViewer() {
  if (!isAdmin()) return;
  try {
    const res = await fetch("/api/audit?limit=200");
    const body = await res.json().catch(() => ({}));
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
    auditBodyEl.innerHTML = "";
    auditEmptyEl.hidden = false;
    auditEmptyEl.textContent = `Could not load audit log: ${err.message}`;
  }
}

async function refreshAdminView() {
  if (!isAdmin()) return;
  await Promise.all([refreshQueueViewer(), refreshAuditViewer()]);
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
  if (!text || !isAdmin()) return;
  commandOutputEl.textContent = "Running…";
  const result = await runAdminCommand(text, { showOutput: true });
  if (result?.ok) commandInputEl.value = "";
});

queueRefreshButtonEl.addEventListener("click", refreshQueueViewer);
auditRefreshButtonEl.addEventListener("click", refreshAuditViewer);
adminRefreshButtonEl.addEventListener("click", refreshAdminView);
