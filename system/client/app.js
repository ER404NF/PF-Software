const loginFormEl = document.getElementById("login-form");
const loginUsernameEl = document.getElementById("login-username");
const loginPasswordEl = document.getElementById("login-password");
const loginErrorEl = document.getElementById("login-error");
const logoutRetryButtonEl = document.getElementById("logout-retry-button");
const signupFormEl = document.getElementById("signup-form");
const signupFullNameEl = document.getElementById("signup-full-name");
const signupEmailEl = document.getElementById("signup-email");
const signupUsernameEl = document.getElementById("signup-username");
const signupPasswordEl = document.getElementById("signup-password");
const signupPasswordConfirmationEl = document.getElementById("signup-password-confirmation");
const signupMessageEl = document.getElementById("signup-message");
const twoFactorFormEl = document.getElementById("two-factor-form");
const twoFactorHeadingEl = document.getElementById("two-factor-heading");
const twoFactorIntroEl = document.getElementById("two-factor-intro");
const twoFactorSetupEl = document.getElementById("two-factor-setup");
const twoFactorSecretEl = document.getElementById("two-factor-secret");
const twoFactorCodeEl = document.getElementById("two-factor-code");
const twoFactorMessageEl = document.getElementById("two-factor-message");
const recoveryCodesEl = document.getElementById("recovery-codes");
const recoveryFormEl = document.getElementById("recovery-form");
const recoveryIdentifierEl = document.getElementById("recovery-identifier");
const recoveryTokenEl = document.getElementById("recovery-token");
const recoveryNewPasswordEl = document.getElementById("recovery-new-password");
const recoveryNewPasswordConfirmationEl = document.getElementById("recovery-new-password-confirmation");
const completeRecoveryButtonEl = document.getElementById("complete-recovery-button");
const recoveryMessageEl = document.getElementById("recovery-message");
const logoutButtonEl = document.getElementById("logout-button");
const whoamiEl = document.getElementById("whoami");
const roleBadgeEl = document.getElementById("role-badge");
const adminNavEl = document.getElementById("admin-nav");
const fleetNavButtonEl = document.getElementById("fleet-nav-button");
const assignmentsNavButtonEl = document.getElementById("assignments-nav-button");
const adminNavButtonEl = document.getElementById("admin-nav-button");
const appEl = document.getElementById("app");
const connectionStatusEl = document.getElementById("connection-status");
const themeToggleEl = document.getElementById("theme-toggle");
const themeToggleLabelEl = document.getElementById("theme-toggle-label");
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
const assignmentRecurrenceEl = document.getElementById("assignment-recurrence");
const assignmentExclusiveEl = document.getElementById("assignment-exclusive");
const assignmentInstructionsEl = document.getElementById("assignment-instructions");
const assignmentsMessageEl = document.getElementById("assignments-message");
const assignmentsListEl = document.getElementById("assignments-list");
const assignmentsEmptyEl = document.getElementById("assignments-empty");
const assignmentsHeadingEl = document.getElementById("assignments-heading");
const assignmentsDescriptionEl = document.getElementById("assignments-description");
const backToFleetButtonEl = document.getElementById("back-to-fleet-button");
const detailTitleEl = document.getElementById("detail-title");
const detailAccessNoteEl = document.getElementById("detail-access-note");
const detailMessageEl = document.getElementById("detail-message");
const detailDeviceFactsEl = document.getElementById("detail-device-facts");
const detailAiStatusEl = document.getElementById("detail-ai-status");
const screenWrapEl = document.getElementById("screen-wrap");
const screenPanelEl = document.getElementById("screen-panel");
const screenEl = document.getElementById("screen");
const hintEl = document.getElementById("hint");
const filesHintEl = document.getElementById("files-hint");
const fileListEl = document.getElementById("file-list");
const uploadFormEl = document.getElementById("upload-form");
const uploadInputEl = document.getElementById("upload-input");
const deviceControlBarEl = document.getElementById("device-control-bar");
const streamStatusEl = document.getElementById("stream-status");
const streamRetryButtonEl = document.getElementById("stream-retry-button");
const keyboardButtonEl = document.getElementById("keyboard-button");
const phoneFrameEl = document.getElementById("phone-frame");
const phoneHomeButtonEl = document.getElementById("phone-home-button");
const touchDotEl = document.getElementById("touch-dot");
const keyboardCaptureEl = document.getElementById("keyboard-capture");
const stageOverlayEl = document.getElementById("stage-overlay");
const liveViewControlsEl = document.getElementById("live-view-controls");
const liveViewToggleEl = document.getElementById("live-view-toggle");
const liveViewStatusEl = document.getElementById("live-view-status");
const releaseButtonEl = document.getElementById("release-button");
const watchControlsEl = document.getElementById("watch-controls");
const watchRefreshButtonEl = document.getElementById("watch-refresh-button");
const watchStopButtonEl = document.getElementById("watch-stop-button");
const filesPanelEl = document.getElementById("files-panel");
const aiChatPanelEl = document.getElementById("ai-chat-panel");
const aiChatTitleEl = document.getElementById("ai-chat-title");
const aiChatMessagesEl = document.getElementById("ai-chat-messages");
const aiChatFormEl = document.getElementById("ai-chat-form");
const aiChatInputEl = document.getElementById("ai-chat-input");
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
const userCreateFullNameEl = document.getElementById("user-create-full-name");
const userCreateEmailEl = document.getElementById("user-create-email");
const userCreateUsernameEl = document.getElementById("user-create-username");
const userCreatePasswordEl = document.getElementById("user-create-password");
const userCreateRoleEl = document.getElementById("user-create-role");
const userCreateDevicesEl = document.getElementById("user-create-devices");
const userCreateResearchEl = document.getElementById("user-create-research");
const userCreateTeamEl = document.getElementById("user-create-team");
const userCreateAllDevicesEl = document.getElementById("user-create-all-devices");
const usersMessageEl = document.getElementById("users-message");
const usersListEl = document.getElementById("users-list");
const usersEmptyEl = document.getElementById("users-empty");
const auditRefreshButtonEl = document.getElementById("audit-refresh-button");
const auditBodyEl = document.getElementById("audit-body");
const auditEmptyEl = document.getElementById("audit-empty");
const sitesPanelEl = document.getElementById("sites-panel");
const sitesRefreshButtonEl = document.getElementById("sites-refresh-button");
const siteCreateFormEl = document.getElementById("site-create-form");
const siteNameEl = document.getElementById("site-name");
const siteTimezoneEl = document.getElementById("site-timezone");
const siteTimezonesEl = document.getElementById("site-timezones");
const siteTokenRevealEl = document.getElementById("site-token-reveal");
const siteTokenCommandEl = document.getElementById("site-token-command");
const siteTokenCopyButtonEl = document.getElementById("site-token-copy-button");
const siteTokenDismissButtonEl = document.getElementById("site-token-dismiss-button");
const sitesMessageEl = document.getElementById("sites-message");
const sitesListEl = document.getElementById("sites-list");
const sitesEmptyEl = document.getElementById("sites-empty");
const proxyPoolPanelEl = document.getElementById("proxy-pool-panel");
const proxyPoolRefreshButtonEl = document.getElementById("proxy-pool-refresh-button");
const proxyPoolCreateFormEl = document.getElementById("proxy-pool-create-form");
const proxyPoolProviderEl = document.getElementById("proxy-pool-provider");
const proxyPoolProtocolEl = document.getElementById("proxy-pool-protocol");
const proxyPoolHostEl = document.getElementById("proxy-pool-host");
const proxyPoolPortEl = document.getElementById("proxy-pool-port");
const proxyPoolUsernameEl = document.getElementById("proxy-pool-username");
const proxyPoolPasswordEl = document.getElementById("proxy-pool-password");
const proxyPoolCountryEl = document.getElementById("proxy-pool-country");
const proxyPoolLabelEl = document.getElementById("proxy-pool-label");
const proxyPoolMessageEl = document.getElementById("proxy-pool-message");
const proxyPoolListEl = document.getElementById("proxy-pool-list");
const proxyPoolEmptyEl = document.getElementById("proxy-pool-empty");

// currentDeviceId is only ever set once the server has confirmed a
// selection (a "frame" arrives for it) — never optimistically. Otherwise a
// failed attempt to switch to someone else's device would incorrectly wipe
// out an already-working session that the server never actually released.
let currentDeviceId = null;
let mediaDeviceId = null;
let fileRequestGeneration = 0;
let pendingDeviceId = null;
let watchedDeviceId = null;
let pendingWatchDeviceId = null;
let watchRefreshTimerId = null;
let pendingAiWorkspaceExitDeviceId = null;
let aiWorkspaceCommandPending = false;

// Safe profile returned by /api/me or /api/login. Role controls management
// surfaces; allowedDevices remains a separate server-enforced device RBAC
// concern. Never infer admin from allowedDevices === null.
let currentOperator = null;
let operatorProfileGeneration = 0;

const ROLE_LABELS = Object.freeze({
  admin: "Admin",
  manager: "Manager",
  va: "VA",
  content_creator: "Content Creator",
  editor: "Editor",
});

function displayRole(role) {
  return ROLE_LABELS[role] || String(role || "VA").replaceAll("_", " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

class RequestFailure extends Error {
  constructor(message, { kind, status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RequestFailure";
    this.kind = kind || "unknown";
    this.status = status;
  }
}

async function requestJson(url, options = {}, {
  timeoutMs = 10000,
  expectJson = true,
  uncertain = false,
} = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const message = timedOut
        ? "Phone Farm did not respond in time. Your change was not confirmed. Try again."
        : uncertain
          ? "Connection was lost while sending the action. It may have reached the phone. Wait for the screen to refresh before trying again."
          : "Phone Farm could not be reached. Your change was not confirmed. Check the connection and try again.";
      throw new RequestFailure(message, { kind: timedOut ? "timeout" : "network", cause: error });
    }

    let body = null;
    if (expectJson) {
      try {
        body = await response.json();
      } catch (error) {
        if (response.ok) {
          throw new RequestFailure("Phone Farm returned an invalid response. Your change was not confirmed. Refresh and try again.", {
            kind: "invalid-response", status: response.status, cause: error,
          });
        }
        body = {};
      }
    }
    if (!response.ok) {
      throw new RequestFailure(body?.error || `Phone Farm rejected the request (HTTP ${response.status}).`, {
        kind: "http", status: response.status,
      });
    }
    return { response, body };
  } finally {
    clearTimeout(timeoutId);
  }
}
window.phoneFarmRequestJson = requestJson;

function showSurfaceMessage(element, message) {
  if (element) element.textContent = message || "";
}

const LOGOUT_PENDING_KEY = "phone-farm-logout-pending";

function hasPendingLogout() {
  try { return localStorage.getItem(LOGOUT_PENDING_KEY) === "1"; } catch { return false; }
}

function rememberPendingLogout(value) {
  try {
    if (value) localStorage.setItem(LOGOUT_PENDING_KEY, "1");
    else localStorage.removeItem(LOGOUT_PENDING_KEY);
  } catch { /* The login screen still remains fail-closed for this page. */ }
}

function applyTheme(theme, { persist = true } = {}) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  themeToggleEl.setAttribute("aria-pressed", String(nextTheme === "dark"));
  themeToggleEl.setAttribute("aria-label", `Use ${nextTheme === "dark" ? "light" : "dark"} mode`);
  themeToggleLabelEl.textContent = nextTheme === "dark" ? "Light" : "Dark";
  if (persist) {
    try { localStorage.setItem("phone-farm-theme", nextTheme); } catch { /* Storage may be unavailable. */ }
  }
}

applyTheme(document.documentElement.dataset.theme, { persist: false });
themeToggleEl.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

const UI_CAPABILITIES = Object.freeze({
  CONTROL_DEVICE: "device:control",
  MANAGE_QUEUE: "queue:manage",
  MANAGE_AI_CONTROLLER: "ai-controller:manage",
  VIEW_AUDIT: "audit:view-sensitive",
  VIEW_ASSIGNMENTS: "assignments:view",
  MANAGE_ASSIGNMENTS: "assignments:manage",
  MANAGE_USERS: "users:manage",
  MANAGE_TEAM_MEMBERS: "team-members:manage",
  MANAGE_PROXY: "proxy:manage",
  VIEW_PROXY_POOL: "proxy:view-pool",
  ASSIGN_PROXY: "proxy:assign",
  MANAGE_DEVICES: "device:provision",
  MANAGE_ROUTING: "routing:manage",
  RUN_NETWORK_CHECK: "network-health:verify",
  MONITOR_DEVICE: "device:monitor",
  VIEW_PEOPLE: "people:view",
  MANAGE_SITES: "sites:manage",
});

function can(capability) {
  return currentOperator?.capabilities?.includes(capability) === true;
}
// Read-only accessors for the separate review panel (review.js); the server re-checks every request.
window.phoneFarmCan = can;
window.phoneFarmUsername = () => currentOperator?.username ?? null;

function canManageOperations() {
  return can(UI_CAPABILITIES.MANAGE_QUEUE);
}

function canManagePeople() {
  return can(UI_CAPABILITIES.MANAGE_USERS) || can(UI_CAPABILITIES.MANAGE_TEAM_MEMBERS);
}

function profileRequestActive(generation, capability = null) {
  const authorized = Array.isArray(capability) ? capability.some(can) : (!capability || can(capability));
  return generation === operatorProfileGeneration && authorized;
}


// Most recent device_list, kept around so the detail view (e.g. its title,
// its AI-status pane) can be re-rendered for the currently-open device
// without waiting for the next broadcast — e.g. right after confirmSelection.
let lastDevices = [];
let lastTasksByDevice = new Map();

// 'fleet' | 'detail' | 'assignments' | 'admin'. Purely a client-side view switch, not a route — no
// server/protocol involvement. Navigating to detail view IS optimistic
// (unlike currentDeviceId above): it happens the instant a card is clicked,
// showing a loading hint while the real select_device/takeover round trip
// is in flight, and bounces back to fleet on failure. That's safe to do
// optimistically because — unlike currentDeviceId — getting it wrong just
// means a brief visual flash, never a corrupted idea of which device this
// connection actually controls.
let currentView = "fleet";

function liveViewEligible(deviceId) {
  const device = lastDevices.find(candidate => candidate.id === deviceId);
  return currentView === "detail"
    && currentDeviceId === deviceId
    && pendingDeviceId === null
    && can(UI_CAPABILITIES.CONTROL_DEVICE)
    && device?.controllerMode === "HUMAN"
    && device?.monitor?.adapter === "wda";
}

const liveViewController = new window.LiveViewController({
  intervalMs: 1000,
  requestTimeoutMs: 10000,
  maxFailures: 3,
  isEligible: liveViewEligible,
  isHidden: () => document.hidden,
  isInputPending: () => busy,
  sendRequest: message => safeSend(message, { statusEl: detailMessageEl }),
  onStatus(label, state) {
    liveViewStatusEl.textContent = label;
    liveViewStatusEl.dataset.state = state;
    liveViewStatusEl.hidden = !label;
  },
  onFatalError(message) {
    liveViewToggleEl.checked = false;
    detailMessageEl.textContent = message;
  },
});

// ---- live video and the phone-shaped control surface ----------------------------
// Video arrives as binary WebSocket frames and is drawn by PhoneStage; the operator
// drives the phone with the mouse and keyboard directly on that picture. Phones
// without a video port fall back to screenshots (see stream_unsupported below).
let streamActive = false;
let streamState = null; // { deviceId, streamId, mode }
let streamRetryTimerId = null;
let screenshotFallback = false;
let streamPausedForVisibility = false;

const phoneStage = new window.PhoneStage({
  screenEl,
  frameEl: phoneFrameEl,
  homeButtonEl: phoneHomeButtonEl,
  dotEl: touchDotEl,
  keyboardEl: keyboardCaptureEl,
  send: message => sendStageInput(message),
  onStatus(kind) {
    if (kind === "fps" && streamActive && streamStatusEl.dataset.state === "live") setStreamStatus("live", streamLabel());
    if (kind === "decode-error") setStreamStatus("off", "Cannot display this phone's video", { retry: true });
  },
});

// An operator input from the stage. Returns the request id (the stage tracks it
// until the phone acknowledges) or null when it could not be sent. Without live
// video the classic flow applies: one action at a time, then a fresh screenshot.
function sendStageInput(message) {
  if (!currentDeviceId || pendingDeviceId) return null;
  const requestId = nextActionRequestId();
  if (!streamActive) {
    setBusy(true);
    liveViewController.supersedePendingFrame();
  }
  const sent = safeSend({ ...message, deviceId: currentDeviceId, requestId }, { uncertain: true, statusEl: detailMessageEl });
  if (!sent) {
    if (!streamActive) setBusy(false);
    return null;
  }
  return requestId;
}

function setStreamStatus(state, label, { retry = false } = {}) {
  streamStatusEl.dataset.state = state;
  streamStatusEl.textContent = label;
  streamRetryButtonEl.hidden = !retry;
}

function streamLabel() {
  const mode = streamState?.mode === "watch" ? "Watching live" : "Live";
  return phoneStage.fps > 0 ? `${mode} · ${phoneStage.fps} fps` : mode;
}

function requestStream(deviceId = currentDeviceId || watchedDeviceId) {
  clearTimeout(streamRetryTimerId);
  streamRetryTimerId = null;
  if (!deviceId) return false;
  if (document.hidden) {
    // A hidden tab must not pull video (mobile data), but it must remember to start it when the
    // tab comes back — e.g. a phone that reconnected and re-selected the device while locked.
    streamPausedForVisibility = true;
    return false;
  }
  screenshotFallback = false;
  setStreamStatus("connecting", "Connecting video…");
  return safeSend({ type: "start_stream", deviceId }, { statusEl: detailMessageEl });
}

function scheduleStreamRetry(delayMs = 1500) {
  clearTimeout(streamRetryTimerId);
  streamRetryTimerId = setTimeout(() => {
    streamRetryTimerId = null;
    if (currentDeviceId || watchedDeviceId) requestStream();
  }, delayMs);
}

function resetStreamState() {
  clearTimeout(streamRetryTimerId);
  streamRetryTimerId = null;
  streamActive = false;
  streamState = null;
  screenshotFallback = false;
  streamPausedForVisibility = false;
  stageOverlayEl.textContent = "";
  streamRetryButtonEl.hidden = true;
  keyboardButtonEl.hidden = true;
  phoneStage.setMode("idle");
  phoneStage.clear();
}

function handleStreamMessage(msg) {
  if (msg.deviceId !== (currentDeviceId || watchedDeviceId)) return;
  if (msg.type === "stream_started") {
    streamState = { deviceId: msg.deviceId, streamId: msg.streamId, mode: msg.mode };
    streamActive = true;
    screenshotFallback = false;
    phoneStage.setStream(msg.streamId);
    stopLiveView(); // video replaces screenshot polling
    syncLiveViewControls();
    setStreamStatus("connecting", "Connecting video…");
    if (!phoneStage.hasPicture) stageOverlayEl.textContent = "Waiting for the phone's video…";
  } else if (msg.type === "stream_state" && msg.streamId === streamState?.streamId) {
    if (msg.state === "live") {
      stageOverlayEl.textContent = "";
      setStreamStatus("live", streamLabel());
    } else if (msg.state === "closed") {
      streamActive = false;
      setStreamStatus("reconnecting", "Video restarting…");
      scheduleStreamRetry(500);
    } else {
      setStreamStatus(msg.state === "reconnecting" ? "reconnecting" : "connecting", msg.state === "reconnecting" ? "Reconnecting video…" : "Connecting video…");
    }
  } else if (msg.type === "stream_stopped") {
    streamActive = false;
    streamState = null;
    setStreamStatus("off", "Video stopped", { retry: true });
    scheduleStreamRetry();
  } else if (msg.type === "stream_unsupported") {
    streamActive = false;
    streamState = null;
    screenshotFallback = true;
    stageOverlayEl.textContent = "";
    setStreamStatus("polling", "Screenshot mode · this phone has no live video port");
    if (currentDeviceId) {
      syncLiveViewControls();
      liveViewToggleEl.checked = true;
      liveViewController.start(currentDeviceId);
    }
  }
}

function stopLiveView(options) {
  liveViewController.stop(options);
  liveViewToggleEl.checked = false;
}

function syncLiveViewControls(device = lastDevices.find(candidate => candidate.id === currentDeviceId)) {
  const available = currentView === "detail"
    && currentDeviceId !== null
    && device?.id === currentDeviceId
    && device?.controllerMode === "HUMAN"
    && device?.monitor?.adapter === "wda"
    && can(UI_CAPABILITIES.CONTROL_DEVICE);
  liveViewControlsEl.hidden = !(available && screenshotFallback);
  if (!available && liveViewController.isActiveFor(currentDeviceId)) stopLiveView();
}

function updateTopNav() {
  fleetNavButtonEl.classList.toggle("active", currentView === "fleet" || currentView === "detail");
  assignmentsNavButtonEl.classList.toggle("active", currentView === "assignments");
  adminNavButtonEl.classList.toggle("active", currentView === "admin");
}

function showFleetView() {
  stopLiveView();
  if (streamActive) {
    // Leaving the phone view: stop paying for video. Selecting the phone again restarts it.
    streamActive = false;
    streamState = null;
    safeSend({ type: "stop_stream" });
  }
  if (!currentDeviceId) {
    mediaDeviceId = null;
    fileRequestGeneration++;
    fileListEl.replaceChildren();
  }
  screenPanelEl.hidden = false;
  detailViewEl.classList.remove("media-workspace");
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
  detailMessageEl.textContent = "";
  renderDeviceFacts(device);
  syncLiveViewControls(device);
}

function showAdminView() {
  if (!canManageOperations()) return;
  stopLiveView();
  if (watchedDeviceId || pendingWatchDeviceId) stopWatching("Live watching ended.", { notifyServer: true });
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
  stopLiveView();
  if (watchedDeviceId || pendingWatchDeviceId) stopWatching("Live watching ended.", { notifyServer: true });
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
let actionRequestId = 0;

function nextActionRequestId() {
  actionRequestId = actionRequestId >= Number.MAX_SAFE_INTEGER - 1 ? 1 : actionRequestId + 1;
  return actionRequestId;
}

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
  phoneHomeButtonEl.disabled = value || phoneStage.mode !== "control";

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

function safeSend(msg, { uncertain = false, statusEl = null } = {}) {
  const messageEl = statusEl || (currentView === "detail" ? detailMessageEl : selectErrorEl);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showSurfaceMessage(messageEl, uncertain
      ? "Connection was lost while sending the action. It may have reached the phone. Wait for the screen to refresh before trying again."
      : "Phone Farm is reconnecting. The action was not sent. Wait until the connection is online and try again.");
    return false;
  }
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    showSurfaceMessage(messageEl, uncertain
      ? "Connection was lost while sending the action. It may have reached the phone. Wait for the screen to refresh before trying again."
      : "Phone Farm could not send the action. Wait until the connection is online and try again.");
    return false;
  }
}

function setConnectionState(state, label) {
  connectionStatusEl.hidden = false;
  connectionStatusEl.className = `connection-state ${state}`;
  connectionStatusEl.textContent = label;
}

function showAuthForm(form) {
  for (const candidate of [loginFormEl, signupFormEl, twoFactorFormEl, recoveryFormEl]) {
    candidate.hidden = candidate !== form;
  }
  appEl.hidden = true;
}

function showLogin() {
  showAuthForm(loginFormEl);
}

function showApp() {
  for (const form of [loginFormEl, signupFormEl, twoFactorFormEl, recoveryFormEl]) form.hidden = true;
  appEl.hidden = false;
  showFleetView();
}

function clearLocalAuthenticatedState() {
  stopLiveView();
  signedOut = true;
  fileRequestGeneration++;
  currentDeviceId = null;
  mediaDeviceId = null;
  pendingDeviceId = null;
  watchedDeviceId = null;
  pendingWatchDeviceId = null;
  pendingAiWorkspaceExitDeviceId = null;
  lastDevices = [];
  clearTimeout(watchRefreshTimerId);
  watchRefreshTimerId = null;
  clearAiWorkspace();
  resetStreamState();
  clearSitesView();
  fileListEl.replaceChildren();
  deviceControlBarEl.hidden = true;
  uploadFormEl.hidden = true;
  releaseButtonEl.hidden = true;
  setBusy(false);
  setOperatorProfile(null);
  showLogin();
}

async function confirmServerLogout() {
  logoutRetryButtonEl.disabled = true;
  try {
    await requestJson("/api/logout", { method: "POST" });
    rememberPendingLogout(false);
    logoutRetryButtonEl.hidden = true;
    loginErrorEl.textContent = "Session revocation confirmed. Sign in when you are ready.";
    return true;
  } catch {
    rememberPendingLogout(true);
    logoutRetryButtonEl.hidden = false;
    loginErrorEl.textContent = "You are signed out on this screen, but the server could not confirm session revocation. Close this browser and try again when Phone Farm is online.";
    return false;
  } finally {
    logoutRetryButtonEl.disabled = false;
  }
}

function setOperatorProfile(profile) {
  operatorProfileGeneration++;
  window.dispatchEvent(new Event("operator-profile-changed"));
  currentOperator = profile?.username ? {
    username: profile.username,
    role: typeof profile.role === "string" ? profile.role : "va",
    allowedDevices: profile.allowedDevices ?? null,
    capabilities: Array.isArray(profile.capabilities) ? profile.capabilities.filter(value => typeof value === "string") : [],
    fullName: typeof profile.fullName === "string" ? profile.fullName : null,
    teamId: typeof profile.teamId === "string" ? profile.teamId : null,
  } : null;

  whoamiEl.textContent = currentOperator ? `Signed in as ${currentOperator.username}` : "";
  roleBadgeEl.textContent = currentOperator ? displayRole(currentOperator.role) : "";
  roleBadgeEl.hidden = !currentOperator;
  const isVa = currentOperator?.role === "va";
  fleetHeadingEl.textContent = isVa ? "VA Fleet" : "Fleet";
  fleetDescriptionEl.textContent = isVa
    ? "View fleet status and open your assigned phones."
    : can(UI_CAPABILITIES.CONTROL_DEVICE)
      ? "View fleet status and open available phones."
      : "View fleet status and device availability.";
  adminNavEl.hidden = !currentOperator;
  assignmentsNavButtonEl.hidden = !can(UI_CAPABILITIES.VIEW_ASSIGNMENTS);
  adminNavButtonEl.hidden = !canManageOperations();
  document.getElementById("audit-panel").hidden = !can(UI_CAPABILITIES.VIEW_AUDIT);
  usersPanelEl.hidden = !canManagePeople();
  userCreateFormEl.hidden = !can(UI_CAPABILITIES.MANAGE_USERS);
  proxyPoolPanelEl.hidden = !can(UI_CAPABILITIES.VIEW_PROXY_POOL);
  proxyPoolCreateFormEl.hidden = !can(UI_CAPABILITIES.MANAGE_PROXY);
  sitesPanelEl.hidden = !can(UI_CAPABILITIES.MANAGE_SITES);
  if (!can(UI_CAPABILITIES.MANAGE_SITES)) clearSitesView();
  assignmentCreateFormEl.hidden = !can(UI_CAPABILITIES.MANAGE_ASSIGNMENTS);
  const managesAssignments = can(UI_CAPABILITIES.MANAGE_ASSIGNMENTS);
  assignmentsHeadingEl.textContent = isVa ? "My to-do list" : managesAssignments ? "Team tasks" : "My assignments";
  assignmentsDescriptionEl.textContent = isVa
    ? "Start and complete the work assigned to you. Repeating tasks return on their next schedule."
    : managesAssignments
      ? "Assign once, daily, or weekly work and review your team's progress."
      : "Review the work assigned to you and its history.";
  assignmentsEmptyEl.textContent = isVa ? "No tasks are assigned to you." : managesAssignments
    ? "No assignments are visible to you." : "No assignments are assigned to you.";
  peopleSidebarEl.hidden = !currentOperator;
  if (!currentOperator) renderPeople([]);

  // Never leave a privileged surface visible after logout or a role change.
  if ((!canManageOperations() && currentView === "admin")
    || (!can(UI_CAPABILITIES.VIEW_ASSIGNMENTS) && currentView === "assignments")) showFleetView();
  if (!can(UI_CAPABILITIES.MONITOR_DEVICE) && (watchedDeviceId || pendingWatchDeviceId)) {
    stopWatching("Live watching is no longer permitted for this role.");
  }
  if (!can(UI_CAPABILITIES.CONTROL_DEVICE)) stopLiveView();
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
  clearSitesView();

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
  if (!can(UI_CAPABILITIES.MANAGE_USERS) && !can(UI_CAPABILITIES.MANAGE_TEAM_MEMBERS)) {
    userCreateFormEl.reset();
    usersListEl.replaceChildren();
    usersMessageEl.textContent = "";
    usersEmptyEl.hidden = false;
    usersEmptyEl.textContent = "User management is not available for this role.";
  }
  // Re-fetched below under the new capability set, not merely hidden —
  // stale lease/exclusivity data must not survive a demotion.
  lastProxyPool = [];
  proxyPoolLoaded = false;
  if (!can(UI_CAPABILITIES.VIEW_PROXY_POOL)) {
    proxyPoolCreateFormEl.reset();
    proxyPoolListEl.replaceChildren();
    proxyPoolMessageEl.textContent = "";
    proxyPoolEmptyEl.hidden = false;
    proxyPoolEmptyEl.textContent = "The proxy pool is not available for this role.";
  } else {
    void refreshProxyPool();
  }
}

// Every route below this needs a session; a WS connection needs one too
// (index.js rejects the upgrade otherwise) — check once on load so a
// returning operator with a still-valid session skips the login form.
async function checkSession() {
  if (hasPendingLogout()) {
    clearLocalAuthenticatedState();
    loginErrorEl.textContent = "Finishing the previous sign-out…";
    await confirmServerLogout();
    return;
  }
  try {
    const { body } = await requestJson("/api/me");
    setOperatorProfile(body);
    showApp();
    connect();
  } catch (error) {
    if (error.kind === "http" && error.status === 401) {
      try {
        const { body } = await requestJson("/api/2fa/recovery-receipt");
        showRecoveryCodes(body);
        return;
      } catch { /* No pending enrollment receipt; show normal sign-in. */ }
    }
    // A network-level failure (offline, DNS hiccup) — fall back to the login
    // screen rather than leaving the page in whichever state the raw HTML
    // happened to default to, with no indication anything went wrong.
    showLogin();
    if (error.kind !== "http" || error.status !== 401) loginErrorEl.textContent = error.message;
  }
}

let twoFactorMode = "verify";
let twoFactorCompletionProfile = null;

function showRecoveryCodes(body) {
  twoFactorMode = "setup";
  twoFactorCompletionProfile = body.operator;
  twoFactorSetupEl.hidden = true;
  twoFactorCodeEl.required = false;
  twoFactorCodeEl.parentElement.hidden = true;
  recoveryCodesEl.querySelector("pre").textContent = body.recoveryCodes.join("\n");
  recoveryCodesEl.hidden = false;
  twoFactorIntroEl.textContent = "Store these one-time codes somewhere safe. They will not be shown after acknowledgement.";
  twoFactorFormEl.querySelector("button[type=submit]").textContent = "I saved the codes — continue";
  showAuthForm(twoFactorFormEl);
}

async function beginTwoFactorSetup() {
  const { body } = await requestJson("/api/2fa/setup", { method: "POST" });
  twoFactorMode = "setup";
  twoFactorCompletionProfile = null;
  twoFactorHeadingEl.textContent = "Protect your account";
  twoFactorIntroEl.textContent = "Add this key to an authenticator app, then enter its six-digit code.";
  twoFactorSetupEl.hidden = false;
  twoFactorSecretEl.textContent = body.secret;
  recoveryCodesEl.hidden = true;
  twoFactorCodeEl.required = true;
  twoFactorCodeEl.parentElement.hidden = false;
  twoFactorCodeEl.value = "";
  twoFactorFormEl.querySelector("button[type=submit]").textContent = "Enable 2FA";
  showAuthForm(twoFactorFormEl);
}

function beginTwoFactorVerification() {
  twoFactorMode = "verify";
  twoFactorCompletionProfile = null;
  twoFactorHeadingEl.textContent = "Two-factor authentication";
  twoFactorIntroEl.textContent = "Enter the six-digit code from your authenticator or a one-time recovery code.";
  twoFactorSetupEl.hidden = true;
  recoveryCodesEl.hidden = true;
  twoFactorCodeEl.required = true;
  twoFactorCodeEl.parentElement.hidden = false;
  twoFactorCodeEl.value = "";
  twoFactorFormEl.querySelector("button[type=submit]").textContent = "Verify and continue";
  showAuthForm(twoFactorFormEl);
}

loginFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginErrorEl.textContent = "";
  const username = loginUsernameEl.value;
  const submit = loginFormEl.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const { response, body } = await requestJson("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: loginPasswordEl.value }),
    });
    if (response.status === 202) {
      loginPasswordEl.value = "";
      if (body.requiresTwoFactorSetup) await beginTwoFactorSetup();
      else beginTwoFactorVerification();
      return;
    }
    loginPasswordEl.value = "";
    signedOut = false;
    rememberPendingLogout(false);
    logoutRetryButtonEl.hidden = true;
    setOperatorProfile(body);
    showApp();
    connect();
  } catch (error) {
    loginErrorEl.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

document.getElementById("show-signup-button").addEventListener("click", () => {
  signupMessageEl.textContent = "";
  showAuthForm(signupFormEl);
});
document.getElementById("show-recovery-button").addEventListener("click", () => {
  recoveryMessageEl.textContent = "";
  showAuthForm(recoveryFormEl);
});
for (const button of document.querySelectorAll("[data-show-login]")) button.addEventListener("click", showLogin);

signupFormEl.addEventListener("submit", async event => {
  event.preventDefault();
  signupMessageEl.textContent = "";
  const submit = signupFormEl.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const { body } = await requestJson("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: signupFullNameEl.value,
        email: signupEmailEl.value,
        username: signupUsernameEl.value,
        password: signupPasswordEl.value,
        passwordConfirmation: signupPasswordConfirmationEl.value,
      }),
    });
    signupFormEl.reset();
    signupMessageEl.textContent = body.message;
  } catch (error) {
    signupMessageEl.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

twoFactorFormEl.addEventListener("submit", async event => {
  event.preventDefault();
  if (twoFactorCompletionProfile) {
    const submit = twoFactorFormEl.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const { body: profile } = await requestJson("/api/2fa/acknowledge-recovery", { method: "POST" });
      twoFactorCompletionProfile = null;
      signedOut = false;
      rememberPendingLogout(false);
      logoutRetryButtonEl.hidden = true;
      setOperatorProfile(profile);
      showApp();
      connect();
    } catch (error) {
      twoFactorMessageEl.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
    return;
  }
  twoFactorMessageEl.textContent = "";
  const submit = twoFactorFormEl.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const { body } = await requestJson(twoFactorMode === "setup" ? "/api/2fa/confirm" : "/api/2fa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: twoFactorCodeEl.value }),
    });
    if (twoFactorMode === "setup") {
      showRecoveryCodes(body);
    } else {
      signedOut = false;
      rememberPendingLogout(false);
      logoutRetryButtonEl.hidden = true;
      setOperatorProfile(body);
      showApp();
      connect();
    }
  } catch (error) {
    twoFactorMessageEl.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

recoveryFormEl.addEventListener("submit", async event => {
  event.preventDefault();
  recoveryMessageEl.textContent = "";
  const submit = recoveryFormEl.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const { body } = await requestJson("/api/recovery/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: recoveryIdentifierEl.value }),
    });
    recoveryMessageEl.textContent = body.message || "Recovery request completed.";
  } catch (error) {
    recoveryMessageEl.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

completeRecoveryButtonEl.addEventListener("click", async () => {
  recoveryMessageEl.textContent = "";
  completeRecoveryButtonEl.disabled = true;
  try {
    await requestJson("/api/recovery/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: recoveryTokenEl.value,
        password: recoveryNewPasswordEl.value,
        passwordConfirmation: recoveryNewPasswordConfirmationEl.value,
      }),
    });
    recoveryFormEl.reset();
    recoveryMessageEl.textContent = "Password changed. Sign in and enroll your authenticator again.";
  } catch (error) {
    recoveryMessageEl.textContent = error.message;
  } finally {
    completeRecoveryButtonEl.disabled = false;
  }
});

logoutButtonEl.addEventListener("click", async () => {
  rememberPendingLogout(true);
  if (ws) ws.close();
  clearLocalAuthenticatedState();
  await confirmServerLogout();
});

logoutRetryButtonEl.addEventListener("click", () => void confirmServerLogout());

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
let peopleLastUpdatedAt = null;

function renderPeople(people, { fresh = true, updatedAt = new Date() } = {}) {
  lastPeople = people;
  if (fresh) peopleLastUpdatedAt = updatedAt;
  peopleListEl.replaceChildren();
  const onlineCount = fresh ? people.filter(person => person.online).length : 0;
  peopleSummaryEl.textContent = fresh
    ? `${onlineCount} online · ${people.length} staff`
    : `Presence unavailable while reconnecting.${peopleLastUpdatedAt ? ` Last updated ${peopleLastUpdatedAt.toLocaleTimeString()}.` : ""}`;
  for (const person of people) {
    const item = document.createElement("li");
    const online = fresh && person.online;
    item.className = `person-row ${online ? "online" : "offline"}${fresh ? "" : " stale"}`;

    const dot = document.createElement("span");
    dot.className = "presence-dot";
    dot.setAttribute("aria-label", fresh ? (online ? "Online" : "Offline") : "Presence unavailable");

    const details = document.createElement("div");
    details.className = "person-details";
    const name = document.createElement("strong");
    name.textContent = person.username;
    const meta = document.createElement("span");
    const sessions = person.activeSessions > 1 ? ` · ${person.activeSessions} sessions` : "";
    meta.textContent = `${displayRole(person.role)} · ${fresh ? formatLastSeen(person.lastSeenAt) : "Status unavailable"}${fresh ? sessions : ""}`;
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

function markPresenceUnavailable() {
  renderPeople(lastPeople, { fresh: false });
  peopleErrorEl.textContent = peopleLastUpdatedAt
    ? `Presence unavailable while reconnecting. Last updated ${peopleLastUpdatedAt.toLocaleTimeString()}.`
    : "Presence unavailable while reconnecting.";
}

async function refreshPeople() {
  const generation = operatorProfileGeneration;
  peopleErrorEl.textContent = "";
  try {
    const { body } = await requestJson("/api/people");
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_PEOPLE)) return;
    renderPeople(Array.isArray(body.people) ? body.people : [], { fresh: true });
    if (can(UI_CAPABILITIES.MANAGE_ASSIGNMENTS)) populateAssignmentForm();
  } catch (error) {
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_PEOPLE)) return;
    peopleErrorEl.textContent = error.message;
  }
}

peopleRefreshButtonEl.addEventListener("click", refreshPeople);

function populateAssignmentForm({ unavailableAssignee = null } = {}) {
  const selectedAssignee = assignmentAssigneeEl.value;
  assignmentAssigneeEl.replaceChildren();
  for (const person of lastPeople) {
    if (person.canAssign !== true) continue;
    const option = document.createElement("option");
    option.value = person.username;
    option.textContent = `${person.username} (${displayRole(person.role)})`;
    assignmentAssigneeEl.append(option);
  }
  if (unavailableAssignee && ![...assignmentAssigneeEl.options].some(option => option.value === unavailableAssignee)) {
    const unavailable = new Option(`${unavailableAssignee} (no longer eligible)`, unavailableAssignee, true, true);
    unavailable.disabled = true;
    assignmentAssigneeEl.append(unavailable);
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

function assignmentRecurrenceLabel(assignment) {
  if (assignment.recurrence === "daily") return "Every day";
  if (assignment.recurrence === "weekly") return "Every week";
  return "Once";
}

function setAssignmentCardPending(card, value) {
  if (!card) return;
  card.setAttribute("aria-busy", String(value));
  for (const control of card.querySelectorAll("button, input, select")) control.disabled = value;
}

function showAssignmentError(messageEl, message, retry) {
  messageEl.replaceChildren(document.createTextNode(`${message} `));
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Retry";
    button.addEventListener("click", retry);
    messageEl.append(button);
  }
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
    const recurrence = document.createElement("span");
    recurrence.className = `assignment-recurrence ${assignment.recurrence || "once"}`;
    recurrence.textContent = assignmentRecurrenceLabel(assignment);
    const badges = document.createElement("div");
    badges.className = "assignment-card-badges";
    badges.append(recurrence, status);
    heading.append(title, badges);

    const meta = document.createElement("p");
    meta.textContent = `Assigned to ${assignment.assignee} by ${assignment.createdBy}`
      + (assignment.deviceId ? ` · Phone ${assignment.deviceId}` : "")
      + (assignment.accountId ? ` · Account ${assignment.accountId}` : "")
      + ` · ${assignmentWindow(assignment)}`
      + ((assignment.occurrence ?? 1) > 1 ? ` · Occurrence ${assignment.occurrence}` : "");
    const cardMessage = document.createElement("p");
    cardMessage.className = "assignment-card-message";
    cardMessage.setAttribute("role", "alert");
    cardMessage.setAttribute("aria-live", "assertive");
    card.append(heading, meta, cardMessage);

    const controls = document.createElement("div");
    controls.className = "assignment-controls";
    const actions = document.createElement("div");
    actions.className = "assignment-actions";
    const nextStatuses = assignmentNextStatuses(assignment);
    const mayManage = can(UI_CAPABILITIES.MANAGE_ASSIGNMENTS);
    const mayProgressOwnTask = assignment.canProgress === true;
    if (nextStatuses.length && (mayManage || mayProgressOwnTask)) {
      for (const nextStatus of nextStatuses.filter(value => mayManage || value !== "cancelled")) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = nextStatus === "in_progress" ? "Start" : nextStatus === "completed" ? "Complete" : "Cancel";
        button.addEventListener("click", () => {
          if (nextStatus === "cancelled"
            && !window.confirm(`Cancel this assignment for ${assignment.assignee}? Completed work and history will remain visible.`)) return;
          void updateAssignment(assignment.id, { status: nextStatus }, { card, messageEl: cardMessage });
        });
        actions.append(button);
      }
    }
    if (nextStatuses.length && mayManage) {
      const manage = document.createElement("details");
      manage.className = "assignment-manage";
      const manageSummary = document.createElement("summary");
      manageSummary.textContent = "Manage assignment";
      const manageGrid = document.createElement("div");
      manageGrid.className = "assignment-manage-grid";

      const reassign = document.createElement("select");
      reassign.setAttribute("aria-label", `Reassign ${assignment.instructions}`);
      for (const option of assignmentAssigneeEl.options) reassign.append(option.cloneNode(true));
      reassign.value = assignment.assignee;
      const reassignField = document.createElement("label");
      reassignField.textContent = "Assignee";
      reassignField.append(reassign);
      const saveAssignee = document.createElement("button");
      saveAssignee.type = "button";
      saveAssignee.textContent = "Save assignee";
      saveAssignee.addEventListener("click", async () => {
        const requestedAssignee = reassign.value;
        if (!requestedAssignee || requestedAssignee === assignment.assignee) {
          showAssignmentError(cardMessage, "Choose a different assignee before saving.");
          return;
        }
        const updated = await updateAssignment(assignment.id, { assignee: requestedAssignee }, {
          card,
          messageEl: cardMessage,
          onFailure: () => { reassign.value = assignment.assignee; },
        });
        if (!updated) reassign.value = assignment.assignee;
      });

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
      const startField = document.createElement("label");
      startField.textContent = "Starts";
      startField.append(scheduleStart);
      const endField = document.createElement("label");
      endField.textContent = "Ends";
      endField.append(scheduleEnd);
      const exclusiveField = document.createElement("label");
      exclusiveField.className = "assignment-manage-checkbox";
      exclusiveField.append(scheduleExclusive, "Exclusive time slot");
      const reschedule = document.createElement("button");
      reschedule.type = "button";
      reschedule.textContent = "Update schedule";
      reschedule.addEventListener("click", () => updateAssignment(assignment.id, {
        startAt: localInputToIso(scheduleStart.value),
        endAt: localInputToIso(scheduleEnd.value),
        exclusive: scheduleExclusive.checked,
      }, { card, messageEl: cardMessage }));
      manageGrid.append(reassignField, saveAssignee, startField, endField, exclusiveField, reschedule);
      manage.append(manageSummary, manageGrid);
      controls.append(manage);
    }
    if (actions.childElementCount) controls.prepend(actions);
    if (controls.childElementCount) card.append(controls);

    const history = document.createElement("details");
    history.className = "assignment-history";
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
    const { body } = await requestJson("/api/assignments");
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_ASSIGNMENTS)) return;
    renderAssignments(Array.isArray(body.assignments) ? body.assignments : []);
  } catch (error) {
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_ASSIGNMENTS)) return;
    assignmentsMessageEl.textContent = error.message;
  }
}

async function updateAssignment(id, change, {
  card = null,
  messageEl = assignmentsMessageEl,
  onFailure = null,
} = {}) {
  showSurfaceMessage(messageEl, "");
  setAssignmentCardPending(card, true);
  try {
    await requestJson(`/api/assignments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    await refreshAssignments();
    return true;
  } catch (error) {
    onFailure?.();
    const retry = () => void updateAssignment(id, change, { card, messageEl, onFailure });
    showAssignmentError(messageEl, `${error.message} The assignment was not changed.`, retry);
    return false;
  } finally {
    setAssignmentCardPending(card, false);
  }
}

assignmentsRefreshButtonEl.addEventListener("click", refreshAssignments);
assignmentCreateFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  assignmentsMessageEl.textContent = "";
  const submit = assignmentCreateFormEl.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await requestJson("/api/assignments", {
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
        recurrence: assignmentRecurrenceEl.value,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      }),
    });
    assignmentInstructionsEl.value = "";
    assignmentAccountEl.value = "";
    assignmentStartEl.value = "";
    assignmentEndEl.value = "";
    assignmentRecurrenceEl.value = "once";
    await refreshAssignments();
  } catch (error) {
    if (error.kind === "http" && error.status === 403) {
      const unavailableAssignee = assignmentAssigneeEl.value;
      await refreshPeople();
      populateAssignmentForm({ unavailableAssignee });
      assignmentsMessageEl.textContent = `${error.message} Eligibility changed; the form was preserved and choices were refreshed.`;
    } else {
      assignmentsMessageEl.textContent = `${error.message} The assignment was not created.`;
    }
  } finally {
    submit.disabled = false;
  }
});

backToFleetButtonEl.addEventListener("click", () => {
  if (watchedDeviceId || pendingWatchDeviceId) {
    stopWatching("Live watching ended.", { notifyServer: true });
    return;
  }
  showFleetView();
});

fleetNavButtonEl.addEventListener("click", () => {
  if (watchedDeviceId || pendingWatchDeviceId) stopWatching("Live watching ended.", { notifyServer: true });
  else showFleetView();
});
assignmentsNavButtonEl.addEventListener("click", () => showAssignmentsView());
adminNavButtonEl.addEventListener("click", () => showAdminView());

function connect() {
  setConnectionState("loading", "Connecting");
  ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    setConnectionState("online", "Online");
    void refreshPeople();
  });

  ws.addEventListener("message", (event) => {
    // Binary messages are live video frames; everything else is JSON.
    if (typeof event.data !== "string") {
      phoneStage.handleBinary(event.data);
      return;
    }
    const msg = JSON.parse(event.data);
    if (msg.type === "operator_profile") {
      applyLiveOperatorProfile(msg.operator);
    }
    if (msg.type === "device_list") {
      renderFleetSafely(msg.devices);
      populateAssignmentForm();
      if (currentView === "assignments" && can(UI_CAPABILITIES.VIEW_ASSIGNMENTS)) void refreshAssignments();
    }
    if (msg.type === "presence_list") {
      peopleErrorEl.textContent = "";
      renderPeople(Array.isArray(msg.people) ? msg.people : [], { fresh: true });
      populateAssignmentForm();
    }

    if (msg.type === "frame") {
      if (msg.deviceId === pendingDeviceId) confirmSelection(pendingDeviceId);
      if (msg.deviceId === currentDeviceId && !pendingDeviceId) {
        renderFrame(msg);
        setBusy(false);
        phoneStage.settleAll();
      }
    }

    if (msg.type === "stream_started" || msg.type === "stream_state" || msg.type === "stream_stopped"
      || msg.type === "stream_unsupported") {
      handleStreamMessage(msg);
    }

    if (msg.type === "action_ack" && msg.deviceId === currentDeviceId) {
      phoneStage.actionSettled(msg.requestId);
    }

    if (msg.type === "live_frame") {
      if (liveViewController.acceptFrame(msg)) renderFrame(msg);
    }

    if (msg.type === "live_frame_error") {
      liveViewController.acceptError(msg);
    }

    if (msg.type === "live_frame_delayed") {
      liveViewController.acceptDelayed(msg);
    }

    if (msg.type === "watch_started" && msg.deviceId === pendingWatchDeviceId) {
      confirmWatch(msg.deviceId, msg.operator);
    }

    if (msg.type === "watch_frame" && msg.deviceId === watchedDeviceId) {
      renderFrame(msg);
      const watchedSummary = lastDevices.find(device => device.id === watchedDeviceId);
      hintEl.textContent = watchedSummary?.controllerMode !== "HUMAN"
        ? "AI-controlled phone · screen read-only"
        : msg.operator ? `Watching ${msg.operator} · read-only` : "Read-only live view";
      if (!streamActive) scheduleWatchRefresh(); // with live video there is nothing to poll
    }

    if (msg.type === "watch_stopped" && msg.deviceId === watchedDeviceId) {
      const returnedToHuman = pendingAiWorkspaceExitDeviceId === msg.deviceId;
      pendingAiWorkspaceExitDeviceId = null;
      const message = returnedToHuman ? "Device returned to Human mode." : msg.message || "The live session ended.";
      stopWatching(message);
      selectErrorEl.textContent = message;
    }

    if (msg.type === "error") {
      if (msg.code === "device_access_revoked") {
        deselect(msg.message || "Your access to this phone was revoked.");
        selectErrorEl.textContent = msg.message || "Your access to this phone was revoked.";
      } else if (msg.deviceId === pendingWatchDeviceId) {
        pendingWatchDeviceId = null;
        filesPanelEl.hidden = false;
        clearAiWorkspace();
        resetStreamState();
        showFleetView();
        selectErrorEl.textContent = msg.message;
      } else if (msg.deviceId === watchedDeviceId) {
        if (msg.code === "watch_denied" || msg.code === "watch_start_failed") stopWatching(msg.message || "Live watching ended.");
        else {
          hintEl.textContent = msg.message;
          if (msg.code === "watch_refresh_failed") scheduleWatchRefresh();
        }
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
        phoneStage.settleAll();
      } else {
        // Neither pending nor current — e.g. a fleet-card AI control
        // button failing for a device this connection never selected in the
        // first place (RBAC denial, unknown device id). Without this branch
        // the error was silently dropped: nothing here ever matched it, so
        // clicking a high-priority safety control that failed gave zero
        // visible feedback.
        showSurfaceMessage(currentView === "detail" ? detailMessageEl : selectErrorEl, msg.message);
      }
    }
  });

  ws.addEventListener("close", (event) => {
    const actionWasPending = busy;
    resetStreamState();
    pendingDeviceId = null;
    pendingWatchDeviceId = null;
    watchedDeviceId = null;
    clearTimeout(watchRefreshTimerId);
    watchRefreshTimerId = null;
    watchControlsEl.hidden = true;
    filesPanelEl.hidden = false;
    clearAiWorkspace();
    fleetGroupsEl.innerHTML = "";
    selectErrorEl.textContent = "";
    if (signedOut) return; // don't fight an intentional sign-out
    markPresenceUnavailable();
    if (event.code === 1008) {
      signedOut = true;
      deselect("Session expired. Sign in again.");
      setOperatorProfile(null);
      showLogin();
      return;
    }
    setConnectionState("loading", "Reconnecting");
    deselect(actionWasPending
      ? "Connection was lost while sending the action. It may have reached the phone. Wait for the screen to refresh before trying again."
      : "Disconnected — reconnecting…");
    if (actionWasPending) selectErrorEl.textContent = "Connection was lost while sending the action. It may have reached the phone. Wait for the screen to refresh before trying again.";
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
  // Lazy, once-per-login load: the picker needs the full pool (to compute
  // exclusivity across devices), not just what device_list carries for one
  // device. refreshProxyPool() itself re-invokes this function once loaded.
  if (can(UI_CAPABILITIES.VIEW_PROXY_POOL) && !proxyPoolLoaded) void refreshProxyPool();
  if (watchedDeviceId) {
    const watchedSummary = devices.find(device => device.id === watchedDeviceId);
    if (!watchedSummary || !watchedSummary.canWatch) {
      const reason = watchedSummary?.watchReason || "This live screen is no longer available.";
      stopWatching(reason);
      selectErrorEl.textContent = reason;
    }
  }
  if (currentDeviceId) {
    const selectedSummary = devices.find(device => device.id === currentDeviceId);
    if (!selectedSummary || !selectedSummary.canOpen) {
      const reason = selectedSummary?.openReason || "This phone is no longer available in the fleet.";
      deselect(reason);
      selectErrorEl.textContent = reason;
    }
  }
  if (currentDeviceId) syncLiveViewControls(devices.find(device => device.id === currentDeviceId));
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
  lastTasksByDevice = tasksByDevice;
  renderFleetSummary(devices);
  renderFleet(devices, tasksByDevice, lastActionByDevice);
  const detailDeviceId = currentDeviceId || watchedDeviceId;
  if (currentView === "detail" && detailDeviceId) {
    renderDeviceFacts(devices.find(device => device.id === detailDeviceId));
    renderDetailAiStatus(detailDeviceId, tasksByDevice.get(detailDeviceId), lastActionByDevice.get(detailDeviceId));
    if (watchedDeviceId === detailDeviceId) {
      syncAiWorkspaceControls(devices.find(device => device.id === detailDeviceId), tasksByDevice.get(detailDeviceId));
    }
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
    ["Available to you", devices.filter(device => device.canOpen).length],
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
    const { body } = await requestJson("/api/queue");
    for (const t of Array.isArray(body.tasks) ? body.tasks : []) {
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
    const { body } = await requestJson("/api/audit?limit=50");
    // Newest-first (auditLog.js) — the first hit per device is its most
    // recent event, so later duplicates for the same device are ignored.
    for (const e of Array.isArray(body.events) ? body.events : []) {
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
    const columnCount = Math.min(groupDevices.length, 4);
    grid.style.setProperty("--fleet-columns", String(columnCount));
    grid.style.setProperty("--fleet-width", `${columnCount * 290 + Math.max(0, columnCount - 1) * 18}px`);
    grid.classList.toggle("single-device", groupDevices.length === 1);
    for (const d of groupDevices) {
      grid.appendChild(renderDeviceCard(d, tasksByDevice.get(d.id), lastActionByDevice.get(d.id)));
    }
    section.appendChild(grid);

    fleetGroupsEl.appendChild(section);
  }
}

function isProxyEgress(egress) {
  return ["commercial-proxy", "self-hosted-proxy", "vlan-proxy"].includes(egress);
}

function buildProxySwitch(device) {
  const wrap = document.createElement("div");
  wrap.className = "proxy-switch-row";
  wrap.title = "Changes the stored proxy assignment. The configured gateway or provider must apply it to phone traffic.";

  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "Proxy routing";
  const detail = document.createElement("span");
  detail.textContent = "Control-plane assignment";
  copy.append(title, detail);

  const label = document.createElement("label");
  label.className = "proxy-switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.role = "switch";
  input.checked = device.network?.enabled !== false;
  input.setAttribute("aria-label", `Proxy routing for ${device.label}`);
  const track = document.createElement("span");
  track.className = "proxy-switch-track";
  const state = document.createElement("span");
  state.className = "proxy-switch-state";
  state.textContent = input.checked ? "On" : "Off";
  label.append(input, track, state);

  input.addEventListener("change", async () => {
    const requested = input.checked;
    input.disabled = true;
    state.textContent = "Saving";
    selectErrorEl.textContent = "";
    try {
      await requestJson(`/api/admin/devices/${encodeURIComponent(device.id)}/proxy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: requested }),
      });
      state.textContent = requested ? "On" : "Off";
      selectErrorEl.textContent = `Proxy routing ${requested ? "enabled" : "disabled"} for ${device.label}.`;
    } catch (error) {
      input.checked = !requested;
      state.textContent = input.checked ? "On" : "Off";
      selectErrorEl.textContent = error.message;
    } finally {
      input.disabled = false;
    }
  });

  wrap.append(copy, label);
  return wrap;
}

function buildNetworkCheckButton(device, statusEl = selectErrorEl) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "network-check-button";
  button.textContent = "Run network check";
  button.addEventListener("click", async () => {
    button.disabled = true;
    statusEl.textContent = `Checking ${device.label} network…`;
    try {
      const { body } = await requestJson(`/api/devices/${encodeURIComponent(device.id)}/network-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }, { timeoutMs: 30_000, uncertain: true });
      statusEl.textContent = body?.ok
        ? `${device.label} network verified.`
        : `${device.label} network check completed with a warning.`;
    } catch (error) {
      statusEl.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function buildRetryProvisioningButton(device) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "network-check-button";
  button.textContent = "Retry automatic setup";
  button.addEventListener("click", async () => {
    button.disabled = true;
    selectErrorEl.textContent = `Retrying setup for ${device.label}…`;
    try {
      await requestJson(`/api/admin/devices/${encodeURIComponent(device.id)}/retry-provisioning`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      selectErrorEl.textContent = `Retrying automatic setup for ${device.label}.`;
    } catch (error) {
      selectErrorEl.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

// Phase B assignment control on the fleet card ("the hover button on each
// phone should let admins/managers choose the proxies"). A <select> rather
// than a literal CSS-hover popover — same information, keyboard-accessible,
// and consistent with every other card control (buildProxySwitch etc.)
// being an always-present element rather than a hover-only affordance.
// Options are every pool proxy not currently leased to a DIFFERENT device
// (Architecture guide §4.6 exclusivity), built from the separately-fetched
// lastProxyPool — device.poolProxy alone only tells us this device's own
// assignment, not the pool-wide lease state needed to grey out the rest.
function buildProxyPoolPicker(device) {
  const wrap = document.createElement("label");
  wrap.className = "proxy-pool-picker";
  wrap.textContent = "Proxy: ";

  const select = document.createElement("select");
  select.setAttribute("aria-label", `Assign a pool proxy to ${device.label}`);
  const none = new Option("— None —", "");
  none.selected = !device.poolProxy;
  select.appendChild(none);
  for (const proxy of lastProxyPool) {
    if (proxy.leasedToDeviceId && proxy.leasedToDeviceId !== device.id) continue; // leased elsewhere — not selectable here
    const option = new Option(`${proxy.flag ? `${proxy.flag} ` : ""}${proxy.country} · ${proxy.provider} · ${proxy.label}`, proxy.id);
    option.selected = proxy.id === device.poolProxy?.id;
    select.appendChild(option);
  }

  select.addEventListener("change", async () => {
    const requested = select.value || null;
    select.disabled = true;
    selectErrorEl.textContent = "";
    try {
      await requestJson(`/api/admin/devices/${encodeURIComponent(device.id)}/proxy-assignment`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: requested }),
      });
      selectErrorEl.textContent = requested ? `Proxy assigned to ${device.label}.` : `Proxy released from ${device.label}.`;
      await refreshProxyPool(); // re-renders the fleet, restoring select.disabled
    } catch (error) {
      selectErrorEl.textContent = error.message;
      select.disabled = false;
      select.value = device.poolProxy?.id || "";
    }
  });

  wrap.appendChild(select);
  return wrap;
}

// Phase B part 2: network enrollment -> IP discovery -> start/stop routing.
// Tracks which devices this browser tab has started (but not yet
// confirmed) enrollment for — the server's own before-snapshot is
// similarly ephemeral (in-memory, not persisted; see index.js's comment),
// so losing this on reload just means clicking "Start" again, which is
// safe and idempotent.
const enrollmentPendingDeviceIds = new Set();

// One state machine, one primary button — matches the server's own
// sequencing (enrollment -> discovery -> routing) instead of showing up to
// four buttons at once. `device.usbNetwork`/`device.routing` are both
// null for any viewer without MANAGE_ROUTING (server-scoped, not a client
// check) and also simply absent until AUTO_ROUTE_PROXY_TUNNELS is enabled.
// tun_error/pf_syntax_error (setup-time failures) and route_lost (a
// regression after a previous success — see networkRoutingOrchestrator.js's
// health check) all fall through to offering a retry ("Start routing")
// rather than showing a stuck disabled button.
const ROUTING_TERMINAL_ERROR_STATES = new Set(["tun_error", "pf_syntax_error", "route_lost"]);

function networkRoutingNextAction(device) {
  const routingState = device.routing?.state;
  if (routingState === "routed") return { label: "Stop routing", action: "stop-routing", kind: "stop" };
  if (routingState && !ROUTING_TERMINAL_ERROR_STATES.has(routingState)) {
    return { label: "Routing…", action: null, disabled: true };
  }
  if (device.usbNetwork?.usbIp) return { label: "Start routing", action: "start-routing" };
  if (device.usbNetwork?.usbIface) return { label: "Discover IP", action: "discover-ip" };
  if (enrollmentPendingDeviceIds.has(device.id)) return { label: "Confirm enrollment", action: "network-enrollment/confirm" };
  return { label: "Start network enrollment", action: "network-enrollment/start" };
}

function networkRoutingStatusText(device) {
  const parts = [];
  // Informational only — the auto-enrollment background loop (when
  // enabled) drives usbNetwork/routing on its own; the manual buttons
  // below remain available as a fallback/override regardless, e.g. if
  // auto-enrollment is stuck ambiguous on a device.
  if (device.autoEnrollment?.state) parts.push(`Auto: ${device.autoEnrollment.state.replaceAll("_", " ")}`);
  if (device.autoEnrollment?.note) parts.push(device.autoEnrollment.note);
  if (device.usbNetwork?.usbIface) parts.push(`Enrolled: ${device.usbNetwork.usbIface}`);
  if (device.usbNetwork?.usbIp) parts.push(`IP: ${device.usbNetwork.usbIp}`);
  if (device.routing?.state) parts.push(`Routing: ${device.routing.state.replaceAll("_", " ")}`);
  if (device.routing?.lastError) parts.push(`Error: ${device.routing.lastError}`);
  return parts.length ? parts.join(" · ") : "Not enrolled";
}

async function triggerRoutingAction(device, action, button) {
  button.disabled = true;
  selectErrorEl.textContent = "";
  try {
    const { body } = await requestJson(`/api/admin/devices/${encodeURIComponent(device.id)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (action === "network-enrollment/start") {
      enrollmentPendingDeviceIds.add(device.id);
      selectErrorEl.textContent = `Now enable Internet Sharing for ${device.label} in System Preferences, then click Confirm enrollment.`;
    } else {
      if (action === "network-enrollment/confirm") enrollmentPendingDeviceIds.delete(device.id);
      selectErrorEl.textContent = body?.network?.usbIp
        ? `${device.label}: IP discovered (${body.network.usbIp}).`
        : body?.network?.usbIface
          ? `${device.label}: enrolled as ${body.network.usbIface}.`
          : body?.routing?.state
            ? `${device.label}: ${body.routing.state.replaceAll("_", " ")}.`
            : `${device.label}: done.`;
    }
    broadcastLocalFleetRefresh();
  } catch (error) {
    selectErrorEl.textContent = error.message;
    button.disabled = false;
  }
}

function buildNetworkRoutingPanel(device) {
  const wrap = document.createElement("div");
  wrap.className = "network-routing-panel";

  const status = document.createElement("span");
  status.className = "network-routing-status";
  status.textContent = networkRoutingStatusText(device);
  wrap.appendChild(status);

  const next = networkRoutingNextAction(device);
  const button = document.createElement("button");
  button.type = "button";
  button.className = next.kind === "stop" ? "network-check-button stop" : "network-check-button";
  button.textContent = next.label;
  button.disabled = Boolean(next.disabled);
  if (next.action) {
    button.addEventListener("click", () => triggerRoutingAction(device, next.action, button));
  }
  wrap.appendChild(button);

  // Escape hatch: once enrolled, the primary button progresses on to
  // "Discover IP"/"Start routing"/"Stop routing" and never comes back to
  // "Start network enrollment" — but the persisted usbIface can go stale
  // (the phone moved to a different USB port). This offers a way back in
  // without disrupting the normal progressive-disclosure flow above.
  // Hidden once routing is actually active — the server refuses to change
  // network identity until routing is stopped, so this would just 409.
  if (device.usbNetwork?.usbIface && next.action !== "network-enrollment/start" && next.kind !== "stop") {
    const reEnroll = document.createElement("button");
    reEnroll.type = "button";
    reEnroll.className = "network-check-button secondary";
    reEnroll.textContent = "Re-enroll network";
    reEnroll.title = "Use this if the phone moved to a different USB port.";
    reEnroll.addEventListener("click", () => triggerRoutingAction(device, "network-enrollment/start", reEnroll));
    wrap.appendChild(reEnroll);
  }

  return wrap;
}

// network-enrollment/start has no persisted, summary()-visible side effect
// (only the ephemeral before-snapshot, tracked purely client-side via
// enrollmentPendingDeviceIds), so it never triggers a server broadcast —
// this local re-render is the only thing that updates its button label.
// confirm/discover-ip/start-routing/stop-routing all DO call
// broadcastDeviceList() server-side; calling this here too for those is
// harmless (renderFleetSafely is idempotent) and keeps this browser's own
// panel responsive immediately, without waiting on the real broadcast that
// follows shortly after.
function broadcastLocalFleetRefresh() {
  if (lastDevices.length) void renderFleetSafely(lastDevices);
}

function renderDeviceFacts(device) {
  detailDeviceFactsEl.replaceChildren();
  detailAccessNoteEl.textContent = "";
  if (!device) return;
  const isAiWorkspace = (watchedDeviceId === device.id || pendingWatchDeviceId === device.id)
    && device.controllerMode !== "HUMAN";
  detailAccessNoteEl.textContent = watchedDeviceId === device.id || pendingWatchDeviceId === device.id
    ? isAiWorkspace
      ? "AI workspace — the phone screen is read-only. Use the device commands beside it."
      : `Read-only live view${device.currentOperator ? ` of ${device.currentOperator}` : ""}. Phone controls and files are unavailable.`
    : currentOperator?.role === "va" && device.assignedToViewer
      ? "Assigned device — you may operate this phone. Fleet settings are read-only."
      : device.openReason || "Fleet settings are read-only.";
  const primaryFacts = [
    ["Phone", device.id],
    ["State", device.status],
    ["Controller", device.controllerMode || "HUMAN"],
    ["Current operator", device.currentOperator || (device.controllerMode !== "HUMAN" ? "AI controller" : "None")],
    ["Your access", device.assignedToViewer ? "Assigned to you" : "Not assigned to you"],
    ["Last seen", device.lastSeenAt ? formatLastSeen(device.lastSeenAt) : "No successful check"],
  ];
  const secondaryFacts = [
    ["Host", device.hostLabel || "this-mac"],
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
    ["Live monitor", device.monitor
      ? `${device.monitor.environmentLabel}: ${device.monitor.available ? "Available" : "Unavailable"}`
        + (device.monitor.adapter === "wda"
          ? ` · Physical acceptance ${device.monitor.physicallyValidated ? "validated" : "pending"}` : "")
      : "Unavailable"],
  ];
  if (device.assignment) {
    primaryFacts.push(
      ["Assigned user", device.assignment.assignee],
      ["Assignment window", assignmentWindow(device.assignment)]);
  }
  if (Array.isArray(device.authorizedOperators) && device.authorizedOperators.length) {
    secondaryFacts.unshift(["Authorized staff", device.authorizedOperators
      .map(operator => `${operator.username} (${displayRole(operator.role)})`).join(", ")]);
  }
  const appendFact = (container, [label, value]) => {
    const item = document.createElement("div");
    item.className = "device-fact";
    const name = document.createElement("span");
    name.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(name, content);
    container.append(item);
  };
  const primary = document.createElement("div");
  primary.className = "device-facts-primary";
  for (const fact of primaryFacts) appendFact(primary, fact);
  const secondary = document.createElement("details");
  secondary.className = "device-facts-secondary";
  const summary = document.createElement("summary");
  summary.textContent = "Network and access details";
  const secondaryGrid = document.createElement("div");
  secondaryGrid.className = "device-facts-secondary-grid";
  for (const fact of secondaryFacts) appendFact(secondaryGrid, fact);
  secondary.append(summary, secondaryGrid);
  if (can(UI_CAPABILITIES.RUN_NETWORK_CHECK) && device.assignedToViewer) {
    const actions = document.createElement("div");
    actions.className = "device-fact-actions";
    actions.append(buildNetworkCheckButton(device, detailMessageEl));
    secondary.append(actions);
  }
  detailDeviceFactsEl.append(primary, secondary);
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

function phoneStatePresentation(device) {
  const isAiMode = device.controllerMode && device.controllerMode !== "HUMAN";
  const role = currentOperator?.role;
  const readOnly = !can(UI_CAPABILITIES.CONTROL_DEVICE);
  if (!device.assignedToViewer) return {
    label: "Not assigned",
    message: role === "va"
      ? "This phone is not assigned to you. Contact your manager if you need access."
      : readOnly
        ? "This phone is not available to your account."
        : "This phone is outside your current device access. Review the user's grant before changing it.",
  };
  if (device.accessState === "wda_unconfigured") return {
    label: "Not ready",
    message: role === "va"
      ? "This phone is connected but not ready. Contact your manager."
      : readOnly
        ? "This phone is connected but not ready."
        : "This phone is connected but not ready. Configure its WDA tunnel before opening it.",
  };
  if (device.accessState === "wda_provisioning") return {
    label: "Setting up",
    message: role === "va"
      ? "This phone is being set up automatically. Try again shortly."
      : device.discoveryStateMessage || "Setting up WDA and the device tunnel automatically.",
  };
  if (device.accessState === "wda_user_action_required") return {
    label: "Needs action on phone",
    message: role === "va"
      ? "This phone needs an action on the device itself. Contact your manager."
      : device.discoveryStateMessage || "This phone needs a manual action before it can come online.",
  };
  if (device.accessState === "wda_provisioning_error") return {
    label: "Setup failed",
    message: role === "va"
      ? "Automatic setup failed for this phone. Contact your manager."
      : device.discoveryStateMessage || "Automatic setup failed for this phone. An admin can retry.",
  };
  if (device.accessState === "disconnected") return {
    label: "Unplugged",
    message: device.discoveryStateMessage || "Unplugged. Reconnect the cable to resume automatic setup.",
  };
  if (isAiMode) {
    if (role === "va") return {
      label: "AI in control",
      message: "This phone is currently controlled by AI. Contact your manager or use another assigned phone.",
    };
    if (readOnly) return {
      label: "AI in control",
      message: "This phone is controlled by AI. You can view its status, but you cannot control it.",
    };
    return {
      label: "AI in control",
      message: "This phone is controlled by AI. Open the AI workspace or return it to Human mode.",
    };
  }
  if (device.status === "offline") return {
    label: "Offline",
    message: role === "va"
      ? "This phone is offline. Try another assigned phone. Contact your manager if this phone is required."
      : readOnly
        ? "This phone is offline."
        : "This phone is offline. Check its Mac, USB connection, WDA, and last health error.",
  };
  if (device.status === "in-use" && !device.canOpen) return {
    label: "In use",
    message: role === "va"
      ? "This phone is already in use. Choose another assigned phone or contact your manager."
      : readOnly
        ? "This phone is currently in use."
        : "This phone is already in use. Review the current owner before taking over.",
  };
  if (readOnly) return {
    label: "View only",
    message: "You can view this phone's status, but you cannot control it.",
  };
  return {
    label: device.canOpen ? "Open device" : "Unavailable",
    message: device.openReason || "This phone cannot be opened.",
  };
}

function renderDeviceCard(d, task, lastAction) {
  const isAiMode = d.controllerMode && d.controllerMode !== "HUMAN";
  const isMine = d.id === currentDeviceId;
  const isWatched = d.id === watchedDeviceId;
  const canManageAi = can(UI_CAPABILITIES.MANAGE_AI_CONTROLLER);

  const card = document.createElement("article");
  card.className = `device-card ${cardStatusClass(d)}${isMine ? " mine" : ""}${isWatched ? " watched" : ""}${isAiMode && !canManageAi ? " ai-locked" : ""}${d.canOpen || d.canWatch || d.mediaActions?.list ? " openable" : " restricted"}`;
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
  } else if (isWatched) {
    const badge = document.createElement("span");
    badge.className = "mine-badge";
    badge.textContent = "Watching live";
    body.appendChild(badge);
  }

  card.appendChild(body);

  const access = document.createElement("div");
  access.className = `device-access ${d.assignedToViewer ? "assigned" : "unassigned"}`;
  const accessLabel = document.createElement("strong");
  accessLabel.textContent = d.assignedToViewer ? "Assigned to you" : "Not assigned to you";
  const accessReason = document.createElement("span");
  const presentation = phoneStatePresentation(d);
  accessReason.textContent = d.canOpen ? "Available to open." : presentation.message;
  access.append(accessLabel, accessReason);
  card.appendChild(access);

  const networkState = document.createElement("div");
  networkState.className = "device-safe-status";
  const proxyDisabled = isProxyEgress(d.network?.egress) && d.network?.enabled === false;
  const egress = proxyDisabled ? "Proxy disabled"
    : d.network?.providerLabel || d.network?.gatewayLabel || d.network?.egress || "No egress assigned";
  const verification = d.networkMismatch ? "Network mismatch"
    : d.networkVerified ? "Network verified" : "Network not verified";
  networkState.textContent = `${egress} · ${verification} · ${formatLastSeen(d.lastSeenAt)}`;
  card.appendChild(networkState);

  if (can(UI_CAPABILITIES.MANAGE_PROXY) && isProxyEgress(d.network?.egress)) {
    card.appendChild(buildProxySwitch(d));
  }
  if (can(UI_CAPABILITIES.RUN_NETWORK_CHECK) && d.assignedToViewer) {
    card.appendChild(buildNetworkCheckButton(d));
  }
  if (can(UI_CAPABILITIES.MANAGE_DEVICES)
    && (d.accessState === "wda_user_action_required" || d.accessState === "wda_provisioning_error")) {
    card.appendChild(buildRetryProvisioningButton(d));
  }
  if (can(UI_CAPABILITIES.ASSIGN_PROXY)) {
    card.appendChild(buildProxyPoolPicker(d));
  }
  if (can(UI_CAPABILITIES.MANAGE_ROUTING)) {
    card.appendChild(buildNetworkRoutingPanel(d));
  }

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
  }

  if (!isAiMode || !d.canWatch) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "open-device-button";
    open.textContent = presentation.label;
    open.disabled = !d.canOpen;
    open.addEventListener("click", () => requestDeviceOpen(d));
    card.appendChild(open);
  }

  if (d.canWatch) {
    const watch = document.createElement("button");
    watch.type = "button";
    watch.className = "watch-device-button";
    watch.textContent = isAiMode ? "Open AI workspace" : `Watch ${d.currentOperator || "VA"} live`;
    watch.addEventListener("click", () => requestDeviceWatch(d));
    card.appendChild(watch);
  }

  if (d.mediaActions?.list) {
    const files = document.createElement("button");
    files.type = "button";
    files.className = "open-device-button";
    files.textContent = "Open files";
    files.addEventListener("click", () => openMediaWorkspace(d));
    card.appendChild(files);
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
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await onClick();
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

function buildControllerModeSwitch(device, statusEl = null) {
  const isAiMode = (device.controllerMode || "HUMAN") !== "HUMAN";
  const humanBusy = !isAiMode && device.status !== "idle";
  const row = document.createElement("div");
  row.className = "controller-mode-row";

  const copy = document.createElement("div");
  copy.className = "controller-mode-copy";
  const heading = document.createElement("strong");
  heading.textContent = "Controller";
  const state = document.createElement("span");
  state.textContent = isAiMode ? "AI mode" : humanBusy ? "Human mode · phone in use" : "Human mode";
  copy.append(heading, state);

  const label = document.createElement("label");
  label.className = "controller-mode-switch";
  const humanLabel = document.createElement("span");
  humanLabel.textContent = "Human";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = isAiMode;
  input.disabled = humanBusy;
  input.setAttribute("role", "switch");
  input.setAttribute("aria-label", `AI controller for ${device.label}`);
  if (humanBusy) input.title = "Release the phone before switching it to AI mode.";
  const track = document.createElement("span");
  track.className = "controller-mode-track";
  track.setAttribute("aria-hidden", "true");
  const aiLabel = document.createElement("span");
  aiLabel.textContent = "AI";
  label.append(humanLabel, input, track, aiLabel);

  input.addEventListener("click", event => event.stopPropagation());
  input.addEventListener("change", async event => {
    event.stopPropagation();
    const requestedAi = input.checked;
    input.disabled = true;
    state.textContent = `Switching to ${requestedAi ? "AI" : "Human"}…`;
    const result = await runAdminCommand(`/mode ${requestedAi ? "ai" : "human"} ${device.id}`, { statusEl });
    if (!result?.ok) {
      input.checked = !requestedAi;
      state.textContent = isAiMode ? "AI mode" : humanBusy ? "Human mode · phone in use" : "Human mode";
      input.disabled = humanBusy;
      return;
    }
    input.disabled = false;
  });

  row.append(copy, label);
  return row;
}

async function runAdminCommand(text, { showOutput = false, deviceId = null, statusEl = null, requestId = null } = {}) {
  if (!canManageOperations()) return null;
  const generation = operatorProfileGeneration;
  const stableRequestId = requestId || (globalThis.crypto?.randomUUID?.()
    ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const payload = deviceId ? { text, deviceId, requestId: stableRequestId } : { text, requestId: stableRequestId };
  const messageEl = statusEl || (currentView === "detail" ? detailMessageEl : selectErrorEl);
  try {
    const { body } = await requestJson("/api/queue/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, { uncertain: true });
    if (!profileRequestActive(generation, UI_CAPABILITIES.MANAGE_QUEUE)) return null;
    if (showOutput) commandOutputEl.textContent = formatCommandResult(body);
    else showSurfaceMessage(messageEl, "Command completed successfully.");
    if (currentView === "admin") void refreshAdminView();
    return { ok: true, body };
  } catch (error) {
    if (!profileRequestActive(generation, UI_CAPABILITIES.MANAGE_QUEUE)) return null;
    if (["network", "timeout", "invalid-response"].includes(error.kind)) {
      try {
        const { body: queue } = await requestJson("/api/queue");
        const task = queue.tasks?.find(candidate => candidate.clientRequestId === stableRequestId);
        if (task) {
          const body = { task, recoveredAfterUncertainResponse: true };
          if (showOutput) commandOutputEl.textContent = `${formatCommandResult(body)}\nRecovered after the command response was lost.`;
          else showSurfaceMessage(messageEl, "Command was saved; its response was lost, so the queue was checked before continuing.");
          if (currentView === "admin") void refreshAdminView();
          return { ok: true, body };
        }
      } catch { /* Keep the original uncertainty error when reconciliation also fails. */ }
    }
    const body = { error: error.message };
    if (showOutput) commandOutputEl.textContent = formatCommandResult(body);
    else showSurfaceMessage(messageEl, error.message);
    if (currentView === "admin") void refreshAdminView();
    return { ok: false, body, error };
  }
}

function clearAiWorkspace() {
  detailViewEl.classList.remove("ai-workspace");
  aiChatPanelEl.hidden = true;
  aiChatMessagesEl.replaceChildren();
  aiChatInputEl.value = "";
  aiWorkspaceCommandPending = false;
}

function syncAiWorkspaceControls(device, task) {
  const state = task?.state;
  const visibility = {
    status: Boolean(device),
    pause: state === "RUNNING",
    resume: state === "PAUSED",
    stop: state === "RUNNING" || state === "PAUSED",
    human: Boolean(device) && !["HUMAN", "HANDOFF"].includes(device.controllerMode),
  };
  for (const button of document.querySelectorAll("[data-ai-command]")) {
    button.hidden = !visibility[button.dataset.aiCommand];
    button.disabled = aiWorkspaceCommandPending;
  }
  for (const button of document.querySelectorAll("[data-ai-prefill]")) button.disabled = aiWorkspaceCommandPending;
  aiChatInputEl.disabled = aiWorkspaceCommandPending;
  aiChatFormEl.querySelector('button[type="submit"]').disabled = aiWorkspaceCommandPending || !aiChatInputEl.value.trim();
}

function appendAiChatMessage(kind, text) {
  const message = document.createElement("p");
  message.className = `ai-chat-message ${kind}`;
  message.textContent = text;
  aiChatMessagesEl.appendChild(message);
  aiChatMessagesEl.scrollTop = aiChatMessagesEl.scrollHeight;
  return message;
}

function aiWorkspaceStatus(device) {
  const networkState = device.networkMismatch ? "network mismatch"
    : device.networkVerified ? "network verified" : "network not verified";
  return `${device.label}: ${device.status} · ${device.controllerMode} · ${networkState}.`;
}

async function runAiWorkspaceCommand(rawText) {
  let inputText = String(rawText || "").trim().replace(/^\/\s+/, "/");
  if (/^cresearch\s+/i.test(inputText)) inputText = `/${inputText}`;
  const text = inputText.toLowerCase();
  const deviceId = watchedDeviceId;
  const device = lastDevices.find(candidate => candidate.id === deviceId);
  if (aiWorkspaceCommandPending || !text || !deviceId || !device || device.controllerMode === "HUMAN"
    || !can(UI_CAPABILITIES.MANAGE_AI_CONTROLLER)) return false;

  appendAiChatMessage("operator", inputText);
  if (text === "status") {
    appendAiChatMessage("system", aiWorkspaceStatus(device));
    return true;
  }

  if (text === "help" || text === "/help") {
    appendAiChatMessage("system", "Use /cresearch <platform> [account] <minutes> <goal>, /time <start>-<end> <goal>, /device health, /pause, /resume, /stop, or /mode human.");
    return true;
  }

  const commands = new Map([
    ["pause", `/pause ${deviceId}`],
    ["/pause", `/pause ${deviceId}`],
    ["resume", `/resume ${deviceId}`],
    ["/resume", `/resume ${deviceId}`],
    ["stop", `/stop ${deviceId}`],
    ["stop task", `/stop ${deviceId}`],
    ["/stop", `/stop ${deviceId}`],
    ["human", `/mode human ${deviceId}`],
    ["return to human", `/mode human ${deviceId}`],
    ["/mode human", `/mode human ${deviceId}`],
    ["/device health", `/device health ${deviceId}`],
  ]);
  const isTaskCommand = text === "/cresearch" || text.startsWith("/cresearch ")
    || text === "/time" || text.startsWith("/time ")
    || text === "/queue add /cresearch" || text.startsWith("/queue add /cresearch ")
    || text === "/queue add /time" || text.startsWith("/queue add /time ");
  const command = commands.get(text) || (isTaskCommand ? inputText : null);
  if (!command) {
    appendAiChatMessage("system", "Use /cresearch, /time, /device health, /pause, /resume, /stop, or /mode human. Commands are limited to this phone.");
    return false;
  }

  const generation = operatorProfileGeneration;
  if (command === `/mode human ${deviceId}`) pendingAiWorkspaceExitDeviceId = deviceId;
  const pendingMessage = appendAiChatMessage("system", "Sending command…");
  aiWorkspaceCommandPending = true;
  syncAiWorkspaceControls(device, lastTasksByDevice.get(deviceId));
  try {
    const result = await runAdminCommand(command, { deviceId, statusEl: detailMessageEl });
    if (!result?.ok && pendingAiWorkspaceExitDeviceId === deviceId) pendingAiWorkspaceExitDeviceId = null;
    if (result?.error?.kind === "http") {
      lastTasksByDevice = await fetchActiveTasksByDevice();
      syncAiWorkspaceControls(lastDevices.find(candidate => candidate.id === deviceId), lastTasksByDevice.get(deviceId));
    }
    if (generation !== operatorProfileGeneration || watchedDeviceId !== deviceId
      || !can(UI_CAPABILITIES.MANAGE_AI_CONTROLLER)) return Boolean(result?.ok);
    pendingMessage.remove();
    const staleTask = !result?.ok && /no (?:running|paused) task|not (?:running|paused)/i.test(result?.body?.error || "");
    appendAiChatMessage("system", staleTask
      ? "This task is no longer running. The current phone status has been refreshed."
      : result ? formatCommandResult(result.body) : "Your access changed before the command completed.");
    return Boolean(result?.ok);
  } finally {
    aiWorkspaceCommandPending = false;
    if (watchedDeviceId === deviceId) {
      syncAiWorkspaceControls(lastDevices.find(candidate => candidate.id === deviceId), lastTasksByDevice.get(deviceId));
    }
  }
}

function buildFleetAiControls(device, task, { statusEl = null } = {}) {
  if (!can(UI_CAPABILITIES.MANAGE_AI_CONTROLLER)) return null;
  const mode = device.controllerMode || "HUMAN";
  const wrap = document.createElement("div");
  wrap.className = "ai-controls";
  wrap.appendChild(buildControllerModeSwitch(device, statusEl));

  if (mode === "HUMAN") {
    return wrap;
  }

  const taskControls = document.createElement("div");
  taskControls.className = "ai-task-controls";
  const taskState = task?.state;
  if (taskState === "RUNNING") {
    taskControls.appendChild(buildControlButton("Pause", () => runAdminCommand(`/pause ${device.id}`, { statusEl })));
  }
  if (taskState === "PAUSED") {
    taskControls.appendChild(buildControlButton("Resume", () => runAdminCommand(`/resume ${device.id}`, { statusEl })));
  }
  if (taskState === "RUNNING" || taskState === "PAUSED") {
    taskControls.appendChild(buildControlButton("Stop task", () => runAdminCommand(`/stop ${device.id}`, { statusEl })));
  }

  taskControls.appendChild(buildControlButton(
    "Emergency stop",
    () => safeSend({ type: "emergency_stop", deviceId: device.id }),
    "danger"
  ));
  wrap.appendChild(taskControls);
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
  const controls = buildFleetAiControls(device, task, { statusEl: detailMessageEl });
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
  stopLiveView();
  pendingDeviceId = id;
  setBusy(true);
  selectErrorEl.textContent = "";
  showDetailView(id);
  if (!currentDeviceId) hintEl.textContent = "Loading…";
  if (!safeSend({ type: "select_device", deviceId: id }, { statusEl: detailMessageEl })) {
    pendingDeviceId = null;
    setBusy(false);
  }
}

function openMediaWorkspace(device) {
  if (!device?.mediaActions?.list) {
    selectErrorEl.textContent = "Media access is not permitted for this phone.";
    return false;
  }
  fileRequestGeneration++;
  stopLiveView();
  mediaDeviceId = device.id;
  pendingDeviceId = null;
  pendingWatchDeviceId = null;
  showDetailView(device.id);
  detailViewEl.classList.add("media-workspace");
  detailAccessNoteEl.textContent = "Device media workspace — no screen input or live-monitor lease is active.";
  screenPanelEl.hidden = true;
  aiChatPanelEl.hidden = true;
  filesPanelEl.hidden = false;
  uploadFormEl.hidden = device.mediaActions.upload !== true;
  releaseButtonEl.hidden = true;
  fileListEl.replaceChildren();
  filesHintEl.textContent = "Loading files…";
  void refreshFiles();
  return true;
}

function requestDeviceOpen(device) {
  if (!device?.canOpen) {
    selectErrorEl.textContent = device?.openReason || "This phone cannot be opened.";
    return false;
  }
  selectDevice(device.id);
  return true;
}

function requestDeviceWatch(device) {
  if (!device?.canWatch || !can(UI_CAPABILITIES.MONITOR_DEVICE)) {
    selectErrorEl.textContent = device?.watchReason || "This live screen cannot be watched.";
    return false;
  }
  stopLiveView();
  pendingWatchDeviceId = device.id;
  watchedDeviceId = null;
  selectErrorEl.textContent = "";
  showDetailView(device.id);
  hintEl.textContent = "Loading read-only live screen…";
  filesPanelEl.hidden = true;
  clearAiWorkspace();
  if (!safeSend({ type: "watch_device", deviceId: device.id }, { statusEl: detailMessageEl })) {
    pendingWatchDeviceId = null;
    return false;
  }
  return true;
}

// Stops whatever AI control a device has and claims it, in one step
// (Architecture Baseline.md §4's "Switch to Human VA Mode"). The server
// replies the same way select_device does (a frame for pendingDeviceId), so
// confirmSelection below handles both identically.
function takeOverDevice(id) {
  if (!can(UI_CAPABILITIES.MANAGE_AI_CONTROLLER)) return;
  stopLiveView();
  pendingDeviceId = id;
  setBusy(true);
  selectErrorEl.textContent = "";
  showDetailView(id);
  if (!currentDeviceId) hintEl.textContent = "Taking over…";
  if (!safeSend({ type: "takeover", deviceId: id }, { statusEl: detailMessageEl })) {
    pendingDeviceId = null;
    setBusy(false);
  }
}

// The server confirmed this selection (a frame arrived for it) — now it's
// safe to treat it as the active device. The view is already showing detail
// (selectDevice/takeOverDevice navigated there optimistically); this just
// populates it and refreshes the fleet render so the "you're controlling
// this" badge shows up on the right card.
function confirmSelection(id) {
  fileRequestGeneration++;
  fileListEl.innerHTML = "";
  watchedDeviceId = null;
  pendingWatchDeviceId = null;
  currentDeviceId = id;
  mediaDeviceId = id;
  pendingDeviceId = null;
  selectErrorEl.textContent = "";
  // Only navigate to detail view if the operator hasn't already explicitly
  // clicked back to fleet in the narrow window between the click and this
  // confirmation — without this check, a fast "← Fleet" click right after
  // selecting a device would get silently overridden the instant the server
  // responded, yanking the operator back into a view they just left.
  if (currentView === "detail") showDetailView(id);
  uploadFormEl.hidden = false;
  deviceControlBarEl.hidden = false;
  releaseButtonEl.hidden = false;
  phoneStage.setMode("control");
  keyboardButtonEl.hidden = false; // shown only on touch screens (CSS hides it for a mouse)
  syncLiveViewControls(lastDevices.find(device => device.id === id));
  if (currentView === "detail") requestStream(id);
  watchControlsEl.hidden = true;
  filesPanelEl.hidden = false;
  clearAiWorkspace();
  filesHintEl.textContent = "";
  setBusy(false);
  refreshFiles();
  if (lastDevices.length) renderFleetSafely(lastDevices);
}

function confirmWatch(id, operatorName = null) {
  stopLiveView();
  fileRequestGeneration++;
  currentDeviceId = null;
  mediaDeviceId = null;
  pendingDeviceId = null;
  watchedDeviceId = id;
  pendingWatchDeviceId = null;
  uploadFormEl.hidden = true;
  deviceControlBarEl.hidden = false; // carries the video status; there are no controls to show
  releaseButtonEl.hidden = true;
  phoneStage.setMode("watch");
  keyboardButtonEl.hidden = true;
  watchControlsEl.hidden = false;
  filesPanelEl.hidden = true;
  showDetailView(id);
  const device = lastDevices.find(candidate => candidate.id === id);
  const isAiWorkspace = device?.controllerMode !== "HUMAN"
    && can(UI_CAPABILITIES.MANAGE_AI_CONTROLLER);
  if (isAiWorkspace) {
    detailViewEl.classList.add("ai-workspace");
    aiChatPanelEl.hidden = false;
    aiChatTitleEl.textContent = `${device.label} commands`;
    aiChatMessagesEl.replaceChildren();
    appendAiChatMessage("system", "AI controls this phone. The live screen is view-only; send a device command here.");
    detailAccessNoteEl.textContent = "AI workspace — the phone screen is read-only. Use the device commands beside it.";
    syncAiWorkspaceControls(device, lastTasksByDevice.get(id));
  } else {
    clearAiWorkspace();
    detailAccessNoteEl.textContent = `Read-only live view${operatorName ? ` of ${operatorName}` : ""}. Phone controls and files are unavailable.`;
  }
  hintEl.textContent = "Waiting for the next screen update…";
  requestStream(id);
  if (lastDevices.length) renderFleetSafely(lastDevices);
}

function scheduleWatchRefresh() {
  clearTimeout(watchRefreshTimerId);
  if (!watchedDeviceId) return;
  watchRefreshTimerId = setTimeout(() => {
    if (watchedDeviceId) safeSend({ type: "refresh_watch", deviceId: watchedDeviceId });
  }, 2000);
}

function stopWatching(message = "Live watching ended.", { notifyServer = false } = {}) {
  const deviceId = watchedDeviceId || pendingWatchDeviceId;
  if (notifyServer && deviceId) safeSend({ type: "stop_watching", deviceId });
  watchedDeviceId = null;
  pendingWatchDeviceId = null;
  pendingAiWorkspaceExitDeviceId = null;
  clearTimeout(watchRefreshTimerId);
  watchRefreshTimerId = null;
  resetStreamState();
  watchControlsEl.hidden = true;
  filesPanelEl.hidden = false;
  clearAiWorkspace();
  hintEl.textContent = message;
  showFleetView();
}

// The device we were actually using failed mid-session (not a rejected new
// selection attempt — see the "error" handler above for that case), or the
// operator explicitly released it. Stop pretending this client still
// controls it, and there's nothing left to show in detail view for it.
function deselect(message) {
  stopLiveView();
  fileRequestGeneration++;
  currentDeviceId = null;
  mediaDeviceId = null;
  pendingDeviceId = null;
  pendingAiWorkspaceExitDeviceId = null;
  resetStreamState();
  hintEl.textContent = message;
  uploadFormEl.hidden = true;
  deviceControlBarEl.hidden = true;
  releaseButtonEl.hidden = true;
  watchControlsEl.hidden = true;
  filesPanelEl.hidden = false;
  clearAiWorkspace();
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
  if (!safeSend({ type: "release_device", deviceId: currentDeviceId }, { statusEl: detailMessageEl })) return;
  deselect("Select a device to begin.");
  selectErrorEl.textContent = "Release requested. The fleet will refresh when the server confirms it.";
});

function renderFrame(frame) {
  // Once live video is flowing it is always newer than a screenshot that was
  // requested before the stream started.
  if (streamActive && phoneStage.streamFrames > 0) return;
  phoneStage.showLegacyFrame(frame);
  hintEl.textContent = "";
}

liveViewToggleEl.addEventListener("change", () => {
  detailMessageEl.textContent = "";
  if (!liveViewToggleEl.checked) {
    stopLiveView();
    return;
  }
  if (!liveViewController.start(currentDeviceId)) {
    liveViewToggleEl.checked = false;
    detailMessageEl.textContent = "Live view is available only while controlling a real WDA device.";
  }
});

// Video is the biggest data cost for a remote operator on mobile data, so it stops
// while the tab is hidden and resumes when it comes back.
document.addEventListener("visibilitychange", () => {
  liveViewController.visibilityChanged();
  const deviceId = currentDeviceId || watchedDeviceId;
  if (!deviceId) return;
  if (document.hidden) {
    if (streamActive) {
      streamPausedForVisibility = true;
      streamActive = false;
      safeSend({ type: "stop_stream" });
    }
  } else if (streamPausedForVisibility) {
    streamPausedForVisibility = false;
    requestStream(deviceId);
  }
});

streamRetryButtonEl.addEventListener("click", () => requestStream());
keyboardButtonEl.addEventListener("click", () => phoneStage.focusKeyboard());

async function refreshFiles() {
  if (!mediaDeviceId) return;
  const deviceId = mediaDeviceId;
  const generation = ++fileRequestGeneration;
  try {
    const { body } = await requestJson(`/api/devices/${encodeURIComponent(deviceId)}/files`);
    if (generation !== fileRequestGeneration || deviceId !== mediaDeviceId || signedOut) return;
    renderFileList(Array.isArray(body.files) ? body.files : [], deviceId);
  } catch (error) {
    if (generation !== fileRequestGeneration || deviceId !== mediaDeviceId || signedOut) return;
    filesHintEl.textContent = `${error.message} Files were not refreshed.`;
  }
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
    const mediaActions = lastDevices.find(device => device.id === deviceId)?.mediaActions;
    if (mediaActions?.download) link.href = `/api/devices/${deviceId}/files/${encodeURIComponent(f.name)}`;
    link.textContent = f.name;
    if (mediaActions?.download) link.download = f.name;

    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatSize(f.size);

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.title = `Delete ${f.name}`;
    del.hidden = mediaActions?.delete !== true;
    if (!del.hidden) del.addEventListener("click", () => deleteFile(f.name, deviceId, del));

    li.append(link, size, del);
    fileListEl.appendChild(li);
  }
}

async function deleteFile(name, deviceId, button = null) {
  if (deviceId !== mediaDeviceId || signedOut) return;
  const phone = lastDevices.find(device => device.id === deviceId)?.label || deviceId;
  if (!window.confirm(`Delete “${name}” from ${phone}? This cannot be undone.`)) return;
  if (button) button.disabled = true;
  filesHintEl.textContent = `Deleting ${name}…`;
  try {
    const { body } = await requestJson(`/api/devices/${encodeURIComponent(deviceId)}/files/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (body?.ok !== true) throw new RequestFailure(`${name} was not deleted. Check your connection and try again.`, { kind: "http" });
    if (deviceId === mediaDeviceId && !signedOut) await refreshFiles();
  } catch (error) {
    if (deviceId === mediaDeviceId && !signedOut) {
      filesHintEl.textContent = `${name} was not deleted. ${error.message} Try again.`;
    }
  } finally {
    if (button?.isConnected && deviceId === mediaDeviceId && !signedOut) button.disabled = false;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

uploadFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = uploadInputEl.files[0];
  if (!file) {
    filesHintEl.textContent = "Choose a file first.";
    return;
  }
  if (!mediaDeviceId) {
    filesHintEl.textContent = "Open a phone's media workspace before uploading a file.";
    return;
  }
  const deviceId = mediaDeviceId;
  const submit = uploadFormEl.querySelector('button[type="submit"]');
  submit.disabled = true;
  const body = new FormData();
  body.append("file", file);
  try {
    await requestJson(`/api/devices/${encodeURIComponent(deviceId)}/files`, { method: "POST", body });
    if (deviceId === mediaDeviceId && !signedOut) {
      uploadInputEl.value = "";
      await refreshFiles();
    }
  } catch (error) {
    if (deviceId === mediaDeviceId && !signedOut) filesHintEl.textContent = `${error.message} The file was not uploaded.`;
  } finally {
    if (deviceId === mediaDeviceId && !signedOut) submit.disabled = !uploadInputEl.files[0];
  }
});

uploadInputEl.addEventListener("change", () => {
  uploadFormEl.querySelector('button[type="submit"]').disabled = !uploadInputEl.files[0];
  if (uploadInputEl.files[0] && filesHintEl.textContent === "Choose a file first.") filesHintEl.textContent = "";
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
    const { body } = await requestJson("/api/queue");
    if (!profileRequestActive(generation, UI_CAPABILITIES.MANAGE_QUEUE)) return;

    queueStateEl.textContent = body.paused ? "Queue paused" : "Queue running";
    queueBodyEl.innerHTML = "";
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    queueEmptyEl.hidden = tasks.length !== 0;
    queueEmptyEl.textContent = "No tasks are currently in the queue.";

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
    const { body } = await requestJson("/api/audit?limit=200");
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_AUDIT)) return;

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

function sameStringList(left, right) {
  return JSON.stringify([...(left || [])].sort()) === JSON.stringify([...(right || [])].sort());
}

function describeUserChanges(user, change) {
  const changes = [];
  const add = (label, before, after) => {
    if (before !== after) changes.push(`${label}: ${before || "None"} → ${after || "None"}`);
  };
  add("Full name", user.fullName || "", change.fullName ?? user.fullName ?? "");
  add("Gmail", user.email || "", change.email ?? user.email ?? "");
  add("Team", user.teamId || "", change.teamId);
  add("Role", displayRole(user.role), displayRole(change.role));
  add("Status", user.active ? "Active" : "Inactive", change.active ? "Active" : "Inactive");
  if ((user.allowedDevices === null) !== (change.allowedDevices === null)
    || (Array.isArray(user.allowedDevices) && Array.isArray(change.allowedDevices)
      && !sameStringList(user.allowedDevices, change.allowedDevices))) {
    changes.push(`Device access: ${user.allowedDevices === null ? "All devices" : user.allowedDevices.join(", ") || "None"} → ${change.allowedDevices === null ? "All devices" : change.allowedDevices.join(", ") || "None"}`);
  }
  if (!sameStringList(user.allowedResearchWorkspaces, change.allowedResearchWorkspaces)) {
    changes.push(`Research access: ${(user.allowedResearchWorkspaces || []).join(", ") || "None"} → ${change.allowedResearchWorkspaces.join(", ") || "None"}`);
  }
  if (change.password) changes.push("Password: replace current password and sign out existing sessions");
  return changes;
}

// Compact per-user action menu: Kick (sign out + deactivate) and Change role.
// Click-to-open rather than a literal CSS :hover popover — same "opens
// beside the row" affordance as buildProxyPoolPicker's picker, but
// keyboard-reachable (that function's own comment explains why this
// codebase avoids hover-only controls). Visibility matches the existing
// edit form's gate; the server is the real enforcement boundary (an
// unauthorized attempt is force-signed-out and flagged, not just 403'd —
// see index.js's flagSelfEscalationIfTargeted).
function buildUserActionsMenu(user) {
  const wrap = document.createElement("div");
  wrap.className = "user-actions-menu";
  wrap.hidden = !can(UI_CAPABILITIES.MANAGE_USERS);

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "user-actions-trigger";
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", `Actions for ${user.username}`);
  trigger.textContent = "⋮";

  const actionsPanel = document.createElement("div");
  actionsPanel.className = "user-actions-panel";
  actionsPanel.hidden = true;

  const kickButton = document.createElement("button");
  kickButton.type = "button";
  kickButton.className = "danger";
  kickButton.textContent = "Kick";
  kickButton.addEventListener("click", async () => {
    if (kickButton.disabled) return;
    if (!window.confirm(`Kick ${user.username}? They'll be signed out everywhere and won't be able to sign back in until reactivated.`)) return;
    kickButton.disabled = true;
    usersMessageEl.textContent = "";
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(user.username)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      usersMessageEl.textContent = `${user.username} kicked — signed out and deactivated.`;
      await refreshUsers();
    } catch (error) {
      usersMessageEl.textContent = error.message;
    } finally {
      kickButton.disabled = false;
    }
  });

  const changeRoleButton = document.createElement("button");
  changeRoleButton.type = "button";
  changeRoleButton.textContent = "Change role";

  const rolePanel = document.createElement("div");
  rolePanel.className = "role-panel";
  rolePanel.hidden = true;

  const roleList = document.createElement("div");
  roleList.className = "role-list";

  const confirmView = document.createElement("div");
  confirmView.className = "role-confirm";
  confirmView.hidden = true;

  async function applyRole(role) {
    usersMessageEl.textContent = "";
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(user.username)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      usersMessageEl.textContent = `${user.username} is now ${displayRole(role)}.`;
      rolePanel.hidden = true;
      actionsPanel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      await refreshUsers();
    } catch (error) {
      usersMessageEl.textContent = error.message;
    }
  }

  for (const [value, label] of USER_ROLES) {
    const roleButton = document.createElement("button");
    roleButton.type = "button";
    roleButton.className = "role-option";
    roleButton.textContent = label;
    roleButton.disabled = value === user.role;
    if (value === user.role) roleButton.setAttribute("aria-current", "true");
    roleButton.addEventListener("click", () => {
      if (value === "admin") {
        confirmView.replaceChildren();
        const prompt = document.createElement("p");
        prompt.textContent = `Are you sure you want to assign admin role to ${user.username}?`;
        const yes = document.createElement("button");
        yes.type = "button";
        yes.textContent = "Yes";
        yes.addEventListener("click", () => applyRole("admin"));
        const no = document.createElement("button");
        no.type = "button";
        no.textContent = "No";
        no.addEventListener("click", () => {
          confirmView.hidden = true;
          roleList.hidden = false;
        });
        confirmView.append(prompt, yes, no);
        roleList.hidden = true;
        confirmView.hidden = false;
      } else {
        applyRole(value);
      }
    });
    roleList.append(roleButton);
  }

  rolePanel.append(roleList, confirmView);

  changeRoleButton.addEventListener("click", () => {
    const opening = rolePanel.hidden;
    rolePanel.hidden = !opening;
    if (opening) {
      roleList.hidden = false;
      confirmView.hidden = true;
    }
  });

  actionsPanel.append(kickButton, changeRoleButton, rolePanel);

  trigger.addEventListener("click", () => {
    const opening = actionsPanel.hidden;
    actionsPanel.hidden = !opening;
    trigger.setAttribute("aria-expanded", String(opening));
    if (!opening) {
      rolePanel.hidden = true;
      confirmView.hidden = true;
      roleList.hidden = false;
    }
  });

  wrap.append(trigger, actionsPanel);
  return wrap;
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
    const accountStatus = user.accountStatus || (user.active ? "approved" : "inactive");
    state.className = `user-state ${accountStatus}`;
    state.textContent = accountStatus.replaceAll("_", " ");
    heading.append(username, state);

    const identity = document.createElement("p");
    identity.className = "user-identity";
    identity.textContent = [user.fullName, user.email, user.teamId ? `Team ${user.teamId}` : "No team assigned"]
      .filter(Boolean).join(" · ");

    const presence = document.createElement("p");
    presence.className = "user-presence";
    const live = user.presence?.online ? "Online" : "Offline";
    const sessions = Number(user.presence?.activeSessions) || 0;
    const phones = Array.isArray(user.presence?.currentPhones)
      ? user.presence.currentPhones.map(phone => phone.label).join(", ") : "";
    presence.textContent = `${live} · ${sessions} active session${sessions === 1 ? "" : "s"}`
      + (phones ? ` · Using ${phones}` : "")
      + (!user.presence?.online && user.presence?.lastSeenAt ? ` · ${formatLastSeen(user.presence.lastSeenAt)}` : "");

    let securityFlag = null;
    if (user.securityFlagReason) {
      securityFlag = document.createElement("p");
      securityFlag.className = "user-security-flag";
      securityFlag.textContent = `Auto-kicked ${formatDate(user.securityFlaggedAt)} — ${user.securityFlagReason}`;
    }

    const actionsMenu = buildUserActionsMenu(user);

    const form = document.createElement("form");
    form.className = "user-form user-edit-form";
    form.hidden = !can(UI_CAPABILITIES.MANAGE_USERS);
    const fullName = document.createElement("input");
    fullName.value = user.fullName || "";
    fullName.maxLength = 150;
    const email = document.createElement("input");
    email.type = "email";
    email.value = user.email || "";
    email.placeholder = "name@gmail.com";
    const teamId = document.createElement("input");
    teamId.value = user.teamId || "";
    teamId.placeholder = "No team";
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
      labeledControl("Full name", fullName),
      labeledControl("Gmail address", email),
      labeledControl("Team ID", teamId),
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
        teamId: teamId.value,
        role: role.value,
        active: active.checked,
        allowedDevices: allDevices.checked ? null : parseIdList(deviceIds.value),
        allowedResearchWorkspaces: parseIdList(research.value),
      };
      if (fullName.value) change.fullName = fullName.value;
      if (email.value) change.email = email.value;
      if (password.value) change.password = password.value;
      const changeList = describeUserChanges(user, change);
      if (changeList.length === 0) {
        usersMessageEl.textContent = `No changes to save for ${user.username}.`;
        save.disabled = false;
        return;
      }
      if (!window.confirm(`Save changes for ${user.username}?\n\n${changeList.join("\n")}`)) {
        save.disabled = false;
        return;
      }
      try {
        await requestJson(`/api/admin/users/${encodeURIComponent(user.username)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(change),
        });
        usersMessageEl.textContent = `${user.username} updated.`;
        await refreshUsers();
      } catch (error) {
        usersMessageEl.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });

    revoke.addEventListener("click", async () => {
      if (revoke.disabled || !window.confirm(`Sign out all sessions for ${user.username}? They will need to sign in again on every device.`)) return;
      usersMessageEl.textContent = "";
      revoke.disabled = true;
      try {
        await requestJson(`/api/admin/users/${encodeURIComponent(user.username)}/revoke-sessions`, { method: "POST" });
        usersMessageEl.textContent = `${user.username} sessions signed out.`;
        await refreshUsers();
      } catch (error) {
        usersMessageEl.textContent = error.message;
      } finally {
        revoke.disabled = false;
      }
    });
    const resetTwoFactor = document.createElement("button");
    resetTwoFactor.type = "button";
    resetTwoFactor.textContent = "Reset 2FA";
    resetTwoFactor.addEventListener("click", async () => {
      if (resetTwoFactor.disabled || !window.confirm(`Reset two-factor authentication for ${user.username}? Their current authenticator will stop working.`)) return;
      resetTwoFactor.disabled = true;
      usersMessageEl.textContent = "";
      try {
        await requestJson(`/api/admin/users/${encodeURIComponent(user.username)}/2fa/reset`, { method: "POST" });
        usersMessageEl.textContent = `${user.username} must enroll 2FA again at next sign-in.`;
        await refreshUsers();
      } catch (error) {
        usersMessageEl.textContent = error.message;
      } finally {
        resetTwoFactor.disabled = false;
      }
    });
    if (can(UI_CAPABILITIES.MANAGE_USERS)) form.append(resetTwoFactor);

    const accountActions = document.createElement("div");
    accountActions.className = "user-account-actions";
    const renameInput = document.createElement("input");
    renameInput.value = user.username;
    renameInput.maxLength = 100;
    renameInput.setAttribute("aria-label", `New username for ${user.username}`);
    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.textContent = "Change username";
    renameButton.addEventListener("click", async () => {
      renameButton.disabled = true;
      usersMessageEl.textContent = "";
      try {
        const { body } = await requestJson(`/api/admin/users/${encodeURIComponent(user.username)}/rename`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: renameInput.value }),
        });
        usersMessageEl.textContent = `${user.username} renamed to ${body.operator.username}.`;
        await refreshUsers();
      } catch (error) {
        usersMessageEl.textContent = error.message;
      } finally {
        renameButton.disabled = false;
      }
    });
    if (user.canRename !== false) accountActions.append(renameInput, renameButton);

    async function reviewAccount(status, button) {
      if (button.disabled) return;
      if (status === "rejected"
        && !window.confirm(`Reject ${user.username}? Their sessions will end and they will lose Phone Farm access.`)) return;
      button.disabled = true;
      usersMessageEl.textContent = "";
      try {
        const { body } = await requestJson(`/api/admin/users/${encodeURIComponent(user.username)}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        const delivery = body.notification?.deliveryState === "queued"
          ? " The email notification is queued."
          : " The notification is waiting for company email configuration.";
        usersMessageEl.textContent = `${body.operator.username} ${status}.${delivery}`;
        await refreshUsers();
      } catch (error) {
        usersMessageEl.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }

    if (user.canReview !== false && accountStatus !== "approved") {
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = "Accept account";
      approve.addEventListener("click", () => reviewAccount("approved", approve));
      accountActions.append(approve);
    }
    if (user.canReview !== false && accountStatus !== "rejected") {
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "danger";
      reject.textContent = "Reject account";
      reject.addEventListener("click", () => reviewAccount("rejected", reject));
      accountActions.append(reject);
    }
    if (user.actionReason) {
      const actionReason = document.createElement("p");
      actionReason.className = "user-action-note";
      actionReason.textContent = user.actionReason;
      accountActions.append(actionReason);
    }

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

    card.append(heading, ...(securityFlag ? [securityFlag] : []), identity, presence, actionsMenu, accountActions, form, activity);
    usersListEl.append(card);
  }
}

// Phase B shared proxy pool (Architecture guide §4.6). `lastProxyPool`
// backs both this admin list and buildProxyPoolPicker() on every fleet
// card — a device's own `poolProxy` field (in `device_list`) only carries
// its own assignment, not which OTHER proxies are free, so the picker
// needs this separately-fetched full list to compute exclusivity.
let lastProxyPool = [];
let proxyPoolLoaded = false;

function renderProxyPool(proxies) {
  lastProxyPool = proxies;
  proxyPoolListEl.replaceChildren();
  proxyPoolEmptyEl.hidden = proxies.length !== 0;
  const mayManage = can(UI_CAPABILITIES.MANAGE_PROXY);
  for (const proxy of proxies) {
    const card = document.createElement("article");
    card.className = "user-card";

    const heading = document.createElement("div");
    heading.className = "user-card-heading";
    const label = document.createElement("strong");
    label.textContent = `${proxy.flag ? `${proxy.flag} ` : ""}${proxy.label}`;
    const state = document.createElement("span");
    state.className = `user-state ${proxy.leasedToDeviceId ? "approved" : "inactive"}`;
    state.textContent = proxy.leasedToDeviceId ? `Assigned to ${proxy.leasedToDeviceId}` : "Available";
    heading.append(label, state);

    const identity = document.createElement("p");
    identity.className = "user-identity";
    identity.textContent = [proxy.provider, proxy.protocol, proxy.country].filter(Boolean).join(" · ");

    card.append(heading, identity);

    if (mayManage) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";
      deleteButton.disabled = Boolean(proxy.leasedToDeviceId);
      deleteButton.title = proxy.leasedToDeviceId ? "Release it from its assigned device first." : "";
      deleteButton.addEventListener("click", async () => {
        deleteButton.disabled = true;
        try {
          await requestJson(`/api/admin/proxies/${encodeURIComponent(proxy.id)}`, { method: "DELETE" });
          await refreshProxyPool();
        } catch (error) {
          proxyPoolMessageEl.textContent = error.message;
          deleteButton.disabled = Boolean(proxy.leasedToDeviceId);
        }
      });
      card.appendChild(deleteButton);
    }
    proxyPoolListEl.appendChild(card);
  }
}

async function refreshProxyPool() {
  if (!can(UI_CAPABILITIES.VIEW_PROXY_POOL)) return;
  const generation = operatorProfileGeneration;
  try {
    const { body } = await requestJson("/api/admin/proxies");
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_PROXY_POOL)) return;
    renderProxyPool(Array.isArray(body.proxies) ? body.proxies : []);
    proxyPoolLoaded = true;
    // Pickers on every fleet card read lastProxyPool directly — refresh
    // them now rather than waiting for the next unrelated device_list.
    if (lastDevices.length) void renderFleetSafely(lastDevices);
  } catch (error) {
    if (!profileRequestActive(generation, UI_CAPABILITIES.VIEW_PROXY_POOL)) return;
    proxyPoolListEl.replaceChildren();
    proxyPoolEmptyEl.hidden = false;
    proxyPoolEmptyEl.textContent = `Could not load the proxy pool: ${error.message}`;
  }
}

proxyPoolCreateFormEl.addEventListener("submit", async event => {
  event.preventDefault();
  proxyPoolMessageEl.textContent = "";
  const submit = proxyPoolCreateFormEl.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const { body } = await requestJson("/api/admin/proxies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: proxyPoolProviderEl.value,
        protocol: proxyPoolProtocolEl.value,
        host: proxyPoolHostEl.value,
        port: Number(proxyPoolPortEl.value),
        username: proxyPoolUsernameEl.value,
        password: proxyPoolPasswordEl.value,
        country: proxyPoolCountryEl.value,
        label: proxyPoolLabelEl.value,
      }),
    });
    proxyPoolMessageEl.textContent = `${body.proxy.label} added.`;
    proxyPoolCreateFormEl.reset();
    await refreshProxyPool();
  } catch (error) {
    proxyPoolMessageEl.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

proxyPoolRefreshButtonEl.addEventListener("click", refreshProxyPool);

// ---- Sites: other locations that link their phones to this hub ---------------------
function clearSitesView() {
  sitesListEl.replaceChildren();
  siteTokenCommandEl.textContent = ""; // never leave a token on screen after a role change or sign-out
  siteTokenRevealEl.hidden = true;
  sitesMessageEl.textContent = "";
}

function showSiteToken(body) {
  const siteId = body.site.id;
  siteTokenCommandEl.textContent = [
    `HUB_URL=${body.hubUrl}`,
    `SITE_ID=${siteId}`,
    `SITE_TOKEN=${body.token}`,
    "npm run agent",
  ].join("\n");
  siteTokenRevealEl.hidden = false;
}

function formatSiteSeen(site) {
  if (site.online) return "connected now";
  return site.lastSeenAt ? `last seen ${formatLastSeen(site.lastSeenAt)}` : "never connected";
}

function renderSites(sites) {
  sitesListEl.replaceChildren();
  sitesEmptyEl.hidden = sites.length !== 0;
  for (const site of sites) {
    const card = document.createElement("article");
    card.className = "user-card";

    const heading = document.createElement("div");
    heading.className = "user-card-heading";
    const name = document.createElement("strong");
    name.textContent = site.name;
    const state = document.createElement("span");
    state.className = `user-state ${site.online ? "approved" : "inactive"}`;
    state.textContent = site.online ? "Online" : "Offline";
    heading.append(name, state);

    const identity = document.createElement("p");
    identity.className = "user-identity";
    identity.textContent = [
      site.id,
      site.timeZone,
      `${site.deviceCount} phone${site.deviceCount === 1 ? "" : "s"}`,
      formatSiteSeen(site),
    ].join(" · ");

    const actions = document.createElement("div");
    const rotate = document.createElement("button");
    rotate.type = "button";
    rotate.textContent = "New token";
    rotate.title = "Issues a new token and disconnects the site until it uses the new one.";
    rotate.addEventListener("click", async () => {
      if (!window.confirm(`Issue a new token for ${site.name}? The site will be disconnected until you give it the new token.`)) return;
      rotate.disabled = true;
      try {
        const { body } = await requestJson(`/api/admin/sites/${encodeURIComponent(site.id)}/rotate-token`, { method: "POST" });
        showSiteToken(body);
        sitesMessageEl.textContent = `New token issued for ${site.name}.`;
        await refreshSites();
      } catch (error) {
        sitesMessageEl.textContent = error.message;
        rotate.disabled = false;
      }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete ${site.name}? Its phones leave the fleet and the site is disconnected. This cannot be undone.`)) return;
      remove.disabled = true;
      try {
        await requestJson(`/api/admin/sites/${encodeURIComponent(site.id)}`, { method: "DELETE" });
        sitesMessageEl.textContent = `${site.name} deleted.`;
        await refreshSites();
      } catch (error) {
        sitesMessageEl.textContent = error.message;
        remove.disabled = false;
      }
    });
    actions.append(rotate, remove);
    card.append(heading, identity, actions);
    sitesListEl.appendChild(card);
  }
}

async function refreshSites() {
  if (!can(UI_CAPABILITIES.MANAGE_SITES)) return;
  const generation = operatorProfileGeneration;
  try {
    const { body } = await requestJson("/api/admin/sites");
    if (!profileRequestActive(generation, UI_CAPABILITIES.MANAGE_SITES)) return;
    if (siteTimezonesEl.childElementCount === 0 && typeof Intl.supportedValuesOf === "function") {
      for (const zone of Intl.supportedValuesOf("timeZone")) {
        const option = document.createElement("option");
        option.value = zone;
        siteTimezonesEl.appendChild(option);
      }
    }
    siteTimezoneEl.placeholder = body.defaultTimeZone || "America/Los_Angeles";
    renderSites(Array.isArray(body.sites) ? body.sites : []);
  } catch (error) {
    if (!profileRequestActive(generation, UI_CAPABILITIES.MANAGE_SITES)) return;
    sitesListEl.replaceChildren();
    sitesMessageEl.textContent = `Could not load sites: ${error.message}`;
  }
}

siteCreateFormEl.addEventListener("submit", async event => {
  event.preventDefault();
  sitesMessageEl.textContent = "";
  const submit = siteCreateFormEl.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const { body } = await requestJson("/api/admin/sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: siteNameEl.value, timeZone: siteTimezoneEl.value.trim() || undefined }),
    });
    showSiteToken(body);
    sitesMessageEl.textContent = `${body.site.name} added. Give the values below to the person setting up that location.`;
    siteCreateFormEl.reset();
    await refreshSites();
  } catch (error) {
    sitesMessageEl.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

siteTokenCopyButtonEl.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(siteTokenCommandEl.textContent);
    sitesMessageEl.textContent = "Copied.";
  } catch {
    sitesMessageEl.textContent = "Could not copy automatically. Select the text and copy it.";
  }
});
siteTokenDismissButtonEl.addEventListener("click", () => {
  siteTokenCommandEl.textContent = "";
  siteTokenRevealEl.hidden = true;
});
sitesRefreshButtonEl.addEventListener("click", refreshSites);

async function refreshUsers() {
  if (!can(UI_CAPABILITIES.MANAGE_USERS) && !can(UI_CAPABILITIES.MANAGE_TEAM_MEMBERS)) return;
  const generation = operatorProfileGeneration;
  const userCapabilities = [UI_CAPABILITIES.MANAGE_USERS, UI_CAPABILITIES.MANAGE_TEAM_MEMBERS];
  try {
    const { body } = await requestJson("/api/admin/users");
    if (!profileRequestActive(generation, userCapabilities)) return;
    renderUsers(Array.isArray(body.users) ? body.users : []);
  } catch (error) {
    if (!profileRequestActive(generation, userCapabilities)) return;
    usersListEl.replaceChildren();
    usersEmptyEl.hidden = false;
    usersEmptyEl.textContent = `Could not load users: ${error.message}`;
  }
}

userCreateAllDevicesEl.addEventListener("change", () => {
  syncAllDevicesControl(userCreateRoleEl, userCreateAllDevicesEl, userCreateDevicesEl);
});

watchRefreshButtonEl.addEventListener("click", () => {
  if (!watchedDeviceId) return;
  clearTimeout(watchRefreshTimerId);
  hintEl.textContent = "Refreshing live screen…";
  safeSend({ type: "refresh_watch", deviceId: watchedDeviceId });
});

watchStopButtonEl.addEventListener("click", () => {
  stopWatching("Live watching ended.", { notifyServer: true });
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
    const { body } = await requestJson("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: userCreateFullNameEl.value,
        email: userCreateEmailEl.value,
        username: userCreateUsernameEl.value,
        password: userCreatePasswordEl.value,
        role: userCreateRoleEl.value,
        active: true,
        allowedDevices: userCreateAllDevicesEl.checked ? null : parseIdList(userCreateDevicesEl.value),
        allowedResearchWorkspaces: parseIdList(userCreateResearchEl.value),
        teamId: userCreateTeamEl.value,
      }),
    });
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
    canManagePeople() ? refreshUsers() : Promise.resolve(),
    can(UI_CAPABILITIES.VIEW_PROXY_POOL) ? refreshProxyPool() : Promise.resolve(),
    can(UI_CAPABILITIES.MANAGE_SITES) ? refreshSites() : Promise.resolve(),
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
  if (!text) {
    commandOutputEl.textContent = "Enter a command to run.";
    return;
  }
  if (!canManageOperations()) return;
  const submit = commandFormEl.querySelector('button[type="submit"]');
  submit.disabled = true;
  commandInputEl.disabled = true;
  commandOutputEl.textContent = "Running…";
  try {
    const result = await runAdminCommand(text, { showOutput: true });
    if (result?.ok) commandInputEl.value = "";
  } finally {
    submit.disabled = false;
    commandInputEl.disabled = false;
  }
});

aiChatFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = aiChatInputEl.value;
  if (!text.trim()) {
    appendAiChatMessage("system", "Enter a command to send.");
    return;
  }
  const completed = await runAiWorkspaceCommand(text);
  if (completed && !aiChatPanelEl.hidden) {
    aiChatInputEl.value = "";
    syncAiWorkspaceControls(lastDevices.find(device => device.id === watchedDeviceId), lastTasksByDevice.get(watchedDeviceId));
    aiChatInputEl.focus();
  }
});

aiChatInputEl.addEventListener("input", () => {
  syncAiWorkspaceControls(lastDevices.find(device => device.id === watchedDeviceId), lastTasksByDevice.get(watchedDeviceId));
});

for (const suggestion of document.querySelectorAll("[data-ai-command]")) {
  suggestion.addEventListener("click", () => void runAiWorkspaceCommand(suggestion.dataset.aiCommand));
}

for (const suggestion of document.querySelectorAll("[data-ai-prefill]")) {
  suggestion.addEventListener("click", () => {
    aiChatInputEl.value = suggestion.dataset.aiPrefill;
    aiChatInputEl.focus();
  });
}

queueRefreshButtonEl.addEventListener("click", refreshQueueViewer);
auditRefreshButtonEl.addEventListener("click", refreshAuditViewer);
adminRefreshButtonEl.addEventListener("click", refreshAdminView);

// Installable web app: lets a remote operator add Phone Farm to a phone, tablet or
// desktop and open its shell offline (see sw.js). Needs HTTPS or localhost; on plain
// http the browser simply refuses, which is fine.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
