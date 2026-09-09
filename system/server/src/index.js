import express from "express";
import session from "express-session";
import multer from "multer";
import { WebSocketServer } from "ws";
import { createServer, ServerResponse } from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { MockDevice } from "./mockDevice.js";
import { WdaDevice } from "./wdaDevice.js";
import { ensureDeviceDir, listFiles, resolveFile, deleteFile, safeFilename } from "./fileStore.js";
import { listRuns, getRun, createRun, setCandidateStatus } from "./researchStore.js";
import { authenticate, canAccessDevice, hasRole, publicOperator, resolveOperator, OPERATOR_ROLES } from "./authStore.js";
import { researchWorkspaceFor, researchAccounts, researchAccountDefinitions, researchActionPolicies } from "./researchAccess.js";
import { createAuditLog } from "./auditLog.js";
import { FileSessionStore } from "./fileSessionStore.js";
import * as deviceLease from "./deviceLease.js";
import { createTaskQueue } from "./taskQueue.js";
import { parseCommand } from "./commandParser.js";
import { loadDeviceNetworkMap } from "./deviceNetworkConfig.js";
import { createNetworkVerifier } from "./networkVerifier.js";
import { providers, defaultProviderName, getProvider } from "./providerRegistry.js";
import { getPlatformSkill } from "./platformSkillRegistry.js";
import { createResearchTaskRunner } from "./researchTaskRunner.js";
import { createModelSelection } from "./modelSelection.js";
import { resolveResearchEvidence } from "./researchEvidenceStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, "../../client");
const configPath = path.join(__dirname, "../../devices.config.json");

const app = express();
app.use(express.static(clientDir));
app.use(express.json());

// Env-overridable (not just a fixed path like fileStore.js/researchStore.js)
// so tests can point these at a disposable temp location instead of the real
// storage/ tree — see server/test/integration/persistence.test.js.
const sessionStoreDir = process.env.SESSION_STORE_DIR || path.join(__dirname, "../../storage/sessions");
const auditLogPath = process.env.AUDIT_LOG_PATH || path.join(__dirname, "../../storage/audit/events.log");
const auditLog = createAuditLog(auditLogPath);

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me";
if (!process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET not set — using an insecure default. Set it before running beyond local dev.");
}
const sessionParser = session({
  store: new FileSessionStore(sessionStoreDir),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // 24h, not a browser-session cookie: now that sessions survive a relay
  // restart, there's no reason to also force a re-login on every browser close.
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 },
});
app.use(sessionParser);

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string" || username.length > 100) {
    return res.status(400).json({ error: "username and password are required" });
  }
  const operator = authenticate(username, password);
  if (!operator) {
    auditLog.logEvent({ operator: username, type: "login_failed" });
    return res.status(401).json({ error: "invalid credentials" });
  }
  req.session.operator = operator;
  auditLog.logEvent({ operator: operator.username, type: "login_success" });
  res.json(publicOperator(operator));
});

app.post("/api/logout", (req, res) => {
  const username = req.session.operator?.username ?? null;
  req.session.destroy(() => {
    if (username) auditLog.logEvent({ operator: username, type: "logout" });
    res.json({ ok: true });
  });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json(publicOperator(req.currentOperator));
});

// Resolves `req.currentOperator` fresh from the live operator registry on
// every request, rather than trusting whatever authStore.authenticate()
// returned at login time and express-session cached from then on — real bug
// this fixes: a role/allowedDevices change (or an operator being removed
// entirely) previously never took effect for an already-open session until
// it happened to log out, since every downstream check read the stale
// req.session.operator snapshot directly. See resolveOperator's own comment
// in authStore.js. req.session.operator itself is left untouched (still
// fine for audit-log usernames, which don't change) — only the fields that
// drive authorization decisions need to be fresh.
function requireAuth(req, res, next) {
  if (!req.session?.operator) return res.status(401).json({ error: "not logged in" });
  const current = resolveOperator(req.session.operator);
  if (!current) return res.status(401).json({ error: "not logged in" }); // operator removed since login — fail closed, not stale-allow
  req.currentOperator = current;
  next();
}

// Feature-role authorization is separate from device RBAC. A route protected
// here may still perform canAccessDevice() checks when it acts on a specific
// phone. Missing/legacy roles normalize to VA in authStore.js, so old session
// data never gains admin rights by accident.
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session?.operator) return res.status(401).json({ error: "not logged in" });
    const current = resolveOperator(req.session.operator);
    if (!current) return res.status(401).json({ error: "not logged in" });
    req.currentOperator = current;
    if (!hasRole(current, role)) {
      auditLog.logEvent({
        operator: req.session.operator.username,
        type: "admin_access_denied",
        detail: { method: req.method, path: req.path },
      });
      return res.status(403).json({ error: `${role} role required` });
    }
    next();
  };
}

const requireAdmin = requireRole(OPERATOR_ROLES.ADMIN);

// Login/logout/me stay open; every device and research route below requires
// an authenticated session.
app.use("/api/devices", requireAuth);
app.use("/api/research", requireAuth);

// Raw audit history is an admin/dev oversight surface. VAs still generate
// audit events through normal device work but cannot read the global log.
app.get("/api/audit", requireAdmin, (req, res) => {
  const { operator, deviceId, limit } = req.query;
  res.json({
    events: auditLog.listEvents({
      operator: typeof operator === "string" ? operator : undefined,
      deviceId: typeof deviceId === "string" ? deviceId : undefined,
      limit: limit ? Math.min(Number(limit) || 200, 1000) : 200,
    }),
  });
});

const server = createServer(app);
// noServer: true — the upgrade is completed manually below, after checking
// the session, instead of ws accepting every upgrade unconditionally.
// Every legitimate message (a coordinate pair, a direction enum, ≤1000 chars
// of text) is under 1KB. Capping well above that but far below ws's 100MB
// default means one connection can't buffer/JSON.parse an oversized payload.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

// express-session's middleware works on any (req, res, next) triple, not
// just ones Express itself dispatches — reusing it here means the WS upgrade
// is authenticated with the exact same session store and cookie as the rest
// of the app, rather than a second, parallel auth mechanism.
server.on("upgrade", (request, socket, head) => {
  // A real (if disconnected) ServerResponse, not a bare {} — express-session
  // reads/writes several res methods (writeHead, getHeader, setHeader, end)
  // while parsing a request's session, and a plain object stub is missing
  // all of them. Not the cause of any bug found so far (the real one was a
  // client-side fetch/body-timing race — see the comment on client/app.js's
  // login handler), but there's no reason to hand a fragile stub to code
  // that expects a real response object when a real one costs nothing here.
  sessionParser(request, new ServerResponse(request), () => {
    if (!request.session?.operator) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });
});

// Bench devices, loaded from devices.config.json so plugging in real
// hardware is editing that file, not this one. Each entry becomes either a
// MockDevice or a WdaDevice — both expose the same
// {id, label, status, tap(), render()} contract, so nothing else here
// (or in the client) needs to know which kind of device it's talking to.
function loadDevices() {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : { devices: [] };
  const map = new Map();
  for (const d of raw.devices) {
    if (d.type === "wda") {
      map.set(d.id, new WdaDevice(d.id, d.label, { host: d.host, port: d.port, timeoutMs: d.timeoutMs }));
    } else {
      map.set(d.id, new MockDevice(d.id, d.label));
    }
  }
  return map;
}

const devices = loadDevices();

// Phase 0 of per-phone network isolation (source-material/Client Account
// Separation — Technical Reference (REDACTED).md §3.5) — see
// deviceNetworkConfig.js/networkVerifier.js for the full rationale. Kept as
// separate control-plane metadata alongside `devices`, not a field on the
// device objects themselves, for the same reason `deviceHealth` below is:
// the device adapter executes deterministic primitives and shouldn't also
// carry control-plane bookkeeping about its own network assignment.
const rawDeviceConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : { devices: [] };
const deviceNetwork = loadDeviceNetworkMap(rawDeviceConfig);
const networkVerifier = createNetworkVerifier({ deviceNetwork });

// Fleet UI grouping (client/app.js's fleet view) — deliberately named
// `hostLabel`, not `host`: WdaDevice already has a same-named `host`
// constructor option above (the network address to reach that device's
// forwarded WDA endpoint, e.g. "127.0.0.1") — reusing that name for "which
// physical Mac this device lives on" would have silently fed a grouping
// label into a real WDA connection address on a `wda`-type device. This
// server only ever manages its own local devices; a device with no
// `hostLabel` falls into one implicit group rather than failing to load —
// there's no multi-host aggregation here, just a rendering-layer grouping
// key ready for whenever there is one.
const DEFAULT_HOST_LABEL = "this-mac";
const deviceHost = new Map((rawDeviceConfig.devices ?? []).map((d) => [d.id, d.hostLabel || DEFAULT_HOST_LABEL]));

// Env-overridable like auditLogPath/sessionStoreDir above, for the same
// reason — tests need an isolated queue file, not the real one under
// storage/queue/.
const queueStorePath = process.env.QUEUE_STORE_PATH || path.join(__dirname, "../../storage/queue/tasks.json");
const taskQueue = createTaskQueue({ devices, deviceLease, auditLog, storePath: queueStorePath, dispatchOnCreate: false });
const modelSelectionStorePath = process.env.MODEL_SELECTION_STORE_PATH
  || path.join(__dirname, "../../storage/models/selection.json");
const modelSelection = createModelSelection({ providers, defaultProviderName, storePath: modelSelectionStorePath });
const researchTaskRunner = createResearchTaskRunner({
  taskQueue,
  devices,
  deviceLease,
  auditLog,
  accountWorkspaces: researchAccounts,
  accountPolicies: researchActionPolicies,
  providerForTask: (task, { workspaceId, deviceId }) => {
    const name = modelSelection.resolve({ taskId: task.id, workspaceId, deviceId });
    return name ? getProvider(name) : null;
  },
  skillForPlatform: (platform) => getPlatformSkill(platform),
  operatorForUsername: (username) => resolveOperator({ username }),
  workspaceForOperatorAccount: researchWorkspaceFor,
});
// Without this, a task dispatching or completing on its own — via the
// background queueTickTimer, or the MS8 research runner calling
// reportResult() — never reaches a connected browser client at all:
// broadcastDeviceList() (defined below) was only ever called from inside WS
// message handlers, so nothing told anyone watching the device list that a
// device's mode/task just changed unless that same client happened to also
// perform an unrelated WS action of their own afterward. This is what
// actually keeps MS6.3's AI-status pane live.
taskQueue.on("dispatched", () => broadcastDeviceList());
taskQueue.on("completed", () => broadcastDeviceList());

// Health is deliberately tracked here, not as a field on the device objects
// themselves — the device adapter executes deterministic primitives and
// shouldn't also own control-plane bookkeeping about its own reliability
// (see Architecture Baseline.md §2). Only updated as a byproduct of actual
// use: an idle device that nobody has selected gets no health signal at all
// until someone does.
const deviceHealth = new Map(); // deviceId -> { lastSeenAt, consecutiveFailures }
// A single blip (WiFi jitter, one slow response) shouldn't flip a device
// offline and alarm every other VA watching the device list — only a run of
// failures in a row means something is actually wrong.
const OFFLINE_AFTER_FAILURES = 3;

function getHealth(deviceId) {
  if (!deviceHealth.has(deviceId)) deviceHealth.set(deviceId, { lastSeenAt: null, consecutiveFailures: 0 });
  return deviceHealth.get(deviceId);
}

// Returns true if this success is a recovery (the device had been failing) —
// callers use that to decide whether to also flip status back from "offline".
function recordSuccess(deviceId) {
  const health = getHealth(deviceId);
  health.lastSeenAt = new Date().toISOString();
  const wasFailing = health.consecutiveFailures > 0;
  health.consecutiveFailures = 0;
  return wasFailing;
}

// Returns the new failure count so the caller can decide whether the
// OFFLINE_AFTER_FAILURES threshold has just been crossed.
function recordFailure(deviceId) {
  const health = getHealth(deviceId);
  health.consecutiveFailures += 1;
  return health.consecutiveFailures;
}

const summary = (d) => ({
  id: d.id,
  label: d.label,
  status: d.status,
  hostLabel: deviceHost.get(d.id) ?? DEFAULT_HOST_LABEL,
  ...getHealth(d.id),
  controllerMode: deviceLease.getMode(d.id),
  network: deviceNetwork.get(d.id) ?? null,
  ...networkVerifier.getStatus(d.id),
});
const knownDevice = (id) => devices.has(id);

// Stamps a device-scoped audit event's detail with which network egress the
// device was assigned to at the time — CLAUDE.md §8's "account/device
// context" field, applied here to Human VA Mode's own audit trail (that
// section is written for AI VA Mode's future research records, but the
// same device-context requirement is exactly as relevant to today's audit
// log). A device with no network assignment yet contributes nothing, rather
// than polluting every event with `networkEgress: null` before Phase 1-3
// hardware exists to assign anything.
function withNetworkEgress(deviceId, detail = {}) {
  const network = deviceNetwork.get(deviceId);
  return network ? { ...detail, networkEgress: network.egress } : detail;
}

// Releasing a device should never silently clear a real "offline" failure —
// only downgrade to "idle" from "in-use". Reselecting an offline device is
// still allowed elsewhere (that's the retry path); this just stops that
// status from being erased by an unrelated disconnect/switch/release.
function releaseDevice(device) {
  if (device.status !== "offline") device.status = "idle";
}

// Per-device file transfer (source clips in, exports out). Isolated by
// device id — see fileStore.js and README "Known gap" re: VA auth.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = ensureDeviceDir(req.params.deviceId);
      if (!dir) return cb(new Error("invalid device id"));
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safe = safeFilename(file.originalname);
      if (!safe) return cb(new Error("invalid filename"));
      cb(null, safe);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB — generous for source video
});

// requireAuth (above) already guarantees req.currentOperator exists here
// (freshly re-resolved from the live registry, not the stale session
// snapshot — see requireAuth's own comment); each check below only asks
// whether THAT operator may reach THIS device.
app.get("/api/devices/:deviceId/files", (req, res) => {
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  res.json({ files: listFiles(req.params.deviceId) });
});

app.post("/api/devices/:deviceId/files", (req, res, next) => {
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  next();
}, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file, or invalid filename" });
  auditLog.logEvent({
    operator: req.session.operator.username,
    type: "file_uploaded",
    deviceId: req.params.deviceId,
    detail: withNetworkEgress(req.params.deviceId, { name: req.file.filename, size: req.file.size }),
  });
  res.json({ ok: true, name: req.file.filename, size: req.file.size });
});

app.get("/api/devices/:deviceId/files/:filename", (req, res) => {
  if (!knownDevice(req.params.deviceId)) return res.status(404).end();
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) return res.status(403).end();
  const full = resolveFile(req.params.deviceId, req.params.filename);
  if (!full) return res.status(404).end();
  auditLog.logEvent({
    operator: req.session.operator.username,
    type: "file_downloaded",
    deviceId: req.params.deviceId,
    detail: withNetworkEgress(req.params.deviceId, { name: req.params.filename }),
  });
  res.download(full);
});

app.delete("/api/devices/:deviceId/files/:filename", (req, res) => {
  if (!knownDevice(req.params.deviceId)) return res.status(404).end();
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) return res.status(403).end();
  const deleted = deleteFile(req.params.deviceId, req.params.filename);
  auditLog.logEvent({
    operator: req.session.operator.username,
    type: "file_deleted",
    deviceId: req.params.deviceId,
    detail: withNetworkEgress(req.params.deviceId, { name: req.params.filename, deleted }),
  });
  res.json({ ok: deleted });
});

// Phase 0 network-isolation verification (networkVerifier.js). checkUrl is
// supplied by the caller rather than read from devices.config.json — no real
// per-device check endpoint exists until Phase 1-3 hardware (routers/SIMs,
// out of scope here) does, so there's nothing to default it to yet; this
// route exists so the mechanism is real and testable today, ready for
// whatever provisions that URL once the hardware does.
app.post("/api/devices/:deviceId/network-check", (req, res) => {
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  const { checkUrl } = req.body || {};
  if (typeof checkUrl !== "string" || checkUrl.length === 0) {
    return res.status(400).json({ error: "checkUrl is required" });
  }
  networkVerifier
    .checkDevice(req.params.deviceId, checkUrl)
    .then((result) => {
      auditLog.logEvent({
        operator: req.session.operator.username,
        type: "network_check",
        deviceId: req.params.deviceId,
        detail: withNetworkEgress(req.params.deviceId, {
          observedIp: result.networkObservedIp,
          verified: result.networkVerified,
          mismatch: result.networkMismatch,
          mismatchReason: result.networkMismatchReason,
        }),
      });
      broadcastDeviceList();
      res.json({ network: { ...(deviceNetwork.get(req.params.deviceId) ?? {}), ...result } });
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

// AI research findings (the /cresearch command's output). One account =
// one model's content research history. No screenshots — url + metadata,
// per direction. The candidate list is what a VA reviews afterward:
// PATCH a candidate to "confirmed" or "removed". Nothing here ever touches
// the platform itself — this is purely our own record of what was found.
app.get("/api/research", (req, res) => {
  const accounts = [...researchAccounts].filter(([id]) => researchWorkspaceFor(req.currentOperator, id))
    .map(([id, workspaceId]) => ({ id, workspaceId, platform: researchAccountDefinitions.get(id)?.platform ?? null }));
  res.json({ accounts });
});

app.use("/api/research/:account", (req, res, next) => {
  const workspaceId = researchWorkspaceFor(req.currentOperator, req.params.account);
  if (!workspaceId) {
    auditLog.logEvent({ operator: req.session.operator.username, type: "research_access_denied",
      detail: { account: req.params.account, method: req.method } });
    return res.status(403).json({ error: "not authorized for this research account" });
  }
  req.researchWorkspaceId = workspaceId;
  next();
});

app.get("/api/research/:account/evidence/:evidenceId", (req, res) => {
  const evidence = resolveResearchEvidence(req.researchWorkspaceId, req.params.account, req.params.evidenceId);
  if (!evidence) return res.status(404).json({ error: "evidence not found" });
  res.type(evidence.mime).sendFile(evidence.file);
});

app.get("/api/research/:account/runs", (req, res) => {
  const runs = listRuns(req.researchWorkspaceId, req.params.account);
  if (runs === null) return res.status(404).json({ error: "unknown account" });
  res.json({ runs });
});

app.get("/api/research/:account/runs/:runId", (req, res) => {
  const run = getRun(req.researchWorkspaceId, req.params.account, req.params.runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json({ run });
});

// No safeAccountId(req.params.account) check here: the app.use("/api/research/
// :account", ...) middleware above already runs first for every request under
// this prefix (Express's own matching order) and validates the account id via
// researchWorkspaceFor -> validResearchId, a strictly stricter (lowercase-only)
// pattern than safeAccountId's — an account that reaches this handler at all
// has already passed the tighter check, making a second, looser one here dead
// code that can never actually reject anything.
app.post("/api/research/:account/runs", (req, res) => {
  const { platform, timeWindow, overview, candidates } = req.body || {};
  if (typeof platform !== "string" || !platform.trim() || typeof overview !== "string" || !overview.trim()) {
    return res.status(400).json({ error: "platform and overview must be non-empty strings" });
  }
  if (candidates !== undefined && !Array.isArray(candidates)) {
    return res.status(400).json({ error: "candidates must be an array" });
  }
  const run = createRun(req.researchWorkspaceId, req.params.account, { platform, timeWindow, overview, candidates });
  auditLog.logEvent({ operator: req.session.operator.username, type: "research_run_created",
    detail: { workspaceId: req.researchWorkspaceId, account: req.params.account, runId: run.id } });
  res.json({ run });
});

app.patch("/api/research/:account/runs/:runId/candidates/:candidateId", (req, res) => {
  const status = req.body?.status;
  const candidate = setCandidateStatus(req.researchWorkspaceId, req.params.account, req.params.runId, req.params.candidateId, status);
  if (!candidate) return res.status(400).json({ error: "invalid status, or run/candidate not found" });
  auditLog.logEvent({
    operator: req.session.operator.username,
    type: "candidate_status_changed",
    detail: { workspaceId: req.researchWorkspaceId, account: req.params.account, runId: req.params.runId, candidateId: req.params.candidateId, status },
  });
  res.json({ candidate });
});

// AI command console (docs/COMMAND_QUEUE_SPEC.md) — the HTTP counterpart to
// the WS device-control protocol above. Stateless per request, unlike the WS
// protocol: every command that targets a device names it explicitly, since
// there's no live "currently selected device" tied to an HTTP request.
function deviceAccessError(deviceId, operator) {
  if (!deviceId) return "a device id is required";
  if (!devices.has(deviceId)) return "unknown device";
  if (!canAccessDevice(operator, deviceId)) return "not authorized for this device";
  return null;
}

function resolveResearchAccountSelector(selector, operator) {
  const platform = selector?.platform;
  const requestedId = selector?.accountId ?? null;
  const matches = [...researchAccountDefinitions.values()].filter((account) =>
    account.platform === platform && researchWorkspaceFor(operator, account.id));
  if (requestedId) {
    const selected = matches.find((account) => account.id === requestedId);
    if (!selected) return { error: `unknown, unauthorized, or platform-mismatched research account: ${requestedId}` };
    return { accountSelector: { platform, accountId: selected.id } };
  }
  if (matches.length === 0) return { error: `no authorized ${platform} research account is configured` };
  if (matches.length > 1) {
    return { error: `multiple authorized ${platform} research accounts are configured; use /cresearch ${platform} <account-id> <minutes> <goal>` };
  }
  return { accountSelector: { platform, accountId: matches[0].id } };
}

async function executeCommand(parsed, operator) {
  if (parsed.error) return { error: parsed.error };

  switch (parsed.type) {
    case "natural_language":
      // MS7.1.3: proposed only, never silently queued (COMMAND_QUEUE_SPEC.md
      // §12) — turning this into a real TaskSpec is the model layer's job
      // (docs/CODING_ROADMAP.md MS8), not this parser's.
      return {
        proposed: { goal: parsed.goal },
        note: "Natural-language goals are proposed only — use /time or /cresearch to actually queue a task.",
      };

    case "time":
    case "cresearch": {
      const resolvedAccount = parsed.type === "cresearch"
        ? resolveResearchAccountSelector(parsed.accountSelector, operator)
        : { accountSelector: parsed.accountSelector };
      if (resolvedAccount.error) return resolvedAccount;
      const task = taskQueue.addTask({
        kind: parsed.type === "cresearch" ? "research" : "generic",
        goal: parsed.goal,
        // A restricted admin may use the queue, but the scheduler must still
        // obey that operator's device allow-list. An unrestricted operator
        // leaves this selector open exactly as before.
        deviceSelector: operator.allowedDevices
          ? { allowedDeviceIds: [...operator.allowedDevices] }
          : {},
        accountSelector: resolvedAccount.accountSelector,
        earliestStart: parsed.earliestStart,
        latestEnd: parsed.latestEnd,
        createdBy: operator.username,
      });
      return { task };
    }

    case "queue_add": {
      const inner = parseCommand(parsed.commandText);
      if (inner.error) return { error: inner.error };
      if (inner.type !== "time" && inner.type !== "cresearch") {
        return { error: "/queue add requires a /time or /cresearch command" };
      }
      return executeCommand(inner, operator);
    }

    case "queue_list":
      return { tasks: taskQueue.listTasks() };

    case "queue_pause":
      taskQueue.pauseQueue();
      return { ok: true, paused: true };

    case "queue_resume":
      taskQueue.resumeQueue();
      return { ok: true, paused: false };

    case "queue_cancel": {
      const task = taskQueue.cancelTask(parsed.taskId);
      return task ? { task } : { error: "unknown task" };
    }

    case "queue_move": {
      const ok = taskQueue.moveTask(parsed.taskId, parsed.relation, parsed.targetId);
      return ok ? { ok: true } : { error: "unknown task id(s)" };
    }

    case "queue_priority": {
      const task = taskQueue.setPriority(parsed.taskId, parsed.priority);
      return task ? { task } : { error: "unknown task" };
    }

    case "model_list":
      return modelSelection.describe();

    case "model_set": {
      if (parsed.scope === "device") {
        const denied = deviceAccessError(parsed.scopeId, operator);
        if (denied) return { error: denied };
      }
      if (parsed.scope === "workspace"
        && !operator.allowedResearchWorkspaces?.includes(parsed.scopeId)) {
        return { error: "not authorized for that research workspace" };
      }
      if (parsed.scope === "task") {
        const task = taskQueue.getTask(parsed.scopeId);
        if (!task) return { error: "unknown task" };
        const deviceId = task.deviceSelector?.deviceId;
        if (deviceId && !canAccessDevice(operator, deviceId)) return { error: "not authorized for that task's device" };
      }
      try {
        const selection = modelSelection.set(parsed.providerName, { scope: parsed.scope, scopeId: parsed.scopeId });
        auditLog.logEvent({ operator: operator.username, type: "model_provider_selected", deviceId: parsed.scope === "device" ? parsed.scopeId : null,
          detail: selection });
        return { selection };
      } catch (error) {
        return { error: error.message };
      }
    }

    // Read-only oversight inside the admin-only command console. The command
    // itself does not need a second device-RBAC gate because reaching this
    // switch already requires the admin role at /api/queue/command.
    case "device_health": {
      if (parsed.deviceId) {
        if (!devices.has(parsed.deviceId)) return { error: "unknown device" };
        return { health: summary(devices.get(parsed.deviceId)) };
      }
      return { health: [...devices.values()].map(summary) };
    }

    case "audit": {
      const events = auditLog.listEvents({
        deviceId: parsed.filterType === "device" ? parsed.value : undefined,
        operator: parsed.filterType === "operator" ? parsed.value : undefined,
        limit: parsed.limit ?? undefined,
      });
      return { events };
    }

    case "mode": {
      const denied = deviceAccessError(parsed.deviceId, operator);
      if (denied) return { error: denied };
      if (parsed.mode === "ai") {
        const target = devices.get(parsed.deviceId);
        if (target.status !== "idle") {
          return { error: `${target.label} must be idle before switching it to AI mode.` };
        }
        try {
          deviceLease.switchToAI(parsed.deviceId);
        } catch (e) {
          return { error: e.message };
        }
        auditLog.logEvent({ operator: operator.username, type: "switched_to_ai", deviceId: parsed.deviceId });
      } else {
        await taskQueue.takeoverDevice(parsed.deviceId);
        auditLog.logEvent({ operator: operator.username, type: "takeover", deviceId: parsed.deviceId });
      }
      // Explicit, not left to a taskQueue event: the "ai" branch above never
      // touches taskQueue at all, and takeoverDevice() (the "human" branch)
      // doesn't emit dispatched/completed either — see the comment on the
      // taskQueue.on(...) registrations near its creation for why relying on
      // those two events alone would miss every command-console mode change.
      broadcastDeviceList();
      return { ok: true, controllerMode: deviceLease.getMode(parsed.deviceId) };
    }

    case "ai_pause": {
      const denied = deviceAccessError(parsed.deviceId, operator);
      if (denied) return { error: denied };
      const task = taskQueue.pauseDevice(parsed.deviceId);
      if (task) broadcastDeviceList();
      return task ? { task } : { error: "no running task on that device" };
    }

    case "ai_resume": {
      const denied = deviceAccessError(parsed.deviceId, operator);
      if (denied) return { error: denied };
      const task = taskQueue.resumeDevice(parsed.deviceId);
      if (task) broadcastDeviceList();
      return task ? { task } : { error: "no paused task on that device" };
    }

    case "ai_stop": {
      const denied = deviceAccessError(parsed.deviceId, operator);
      if (denied) return { error: denied };
      const task = taskQueue.stopDevice(parsed.deviceId);
      auditLog.logEvent({ operator: operator.username, type: "ai_stop", deviceId: parsed.deviceId });
      broadcastDeviceList();
      return { task: task ?? null };
    }

    case "ai_takeover": {
      const denied = deviceAccessError(parsed.deviceId, operator);
      if (denied) return { error: denied };
      const task = await taskQueue.takeoverDevice(parsed.deviceId);
      auditLog.logEvent({ operator: operator.username, type: "takeover", deviceId: parsed.deviceId });
      broadcastDeviceList();
      return { task: task ?? null, controllerMode: deviceLease.getMode(parsed.deviceId) };
    }

    default:
      return { error: `unhandled command type: ${parsed.type}` };
  }
}

app.post("/api/queue/command", requireAdmin, async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "text is required" });
  }
  const parsed = parseCommand(text);
  const result = await executeCommand(parsed, req.currentOperator);
  res.status(result.error ? 400 : 200).json(result);
});

app.get("/api/queue", requireAdmin, (req, res) => {
  res.json({ tasks: taskQueue.listTasks(), paused: taskQueue.isPaused() });
});

// Without this, a multer failure (oversized file, invalid filename/device id
// from the storage callbacks) falls through to Express's default HTML error
// page instead of the JSON the client expects.
app.use((err, req, res, next) => {
  if (!err) return next();
  const message = err.code === "LIMIT_FILE_SIZE" ? "file too large" : err.message || "upload failed";
  res.status(400).json({ error: message });
});

function broadcastDeviceList() {
  const payload = JSON.stringify({
    type: "device_list",
    devices: [...devices.values()].map(summary),
  });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

// Without this, a VA's connection going dark without a clean TCP close
// (laptop sleep, WiFi dropping association — no FIN, no RST, just silence)
// never fires a "close" event, so their device stays "in-use" forever with
// nobody actually able to release it short of restarting the server.
const HEARTBEAT_INTERVAL_MS = 15000;
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate(); // fires this connection's "close" handler, which releases its device
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
wss.on("close", () => clearInterval(heartbeatTimer));

wss.on("connection", (ws, request) => {
  // Set once, at handshake time, by the session check in the "upgrade"
  // handler above — this connection would never have been accepted
  // otherwise, so `operator` is always populated here. Kept for the
  // connection's lifetime purely as a stable identity (its `.username` for
  // audit logging never changes); every actual authorization decision below
  // instead calls currentOperator(), which re-resolves live on each call.
  // Real bug this fixes: a WS connection can live for hours or days (auto-
  // reconnect notwithstanding), so caching a role/allowedDevices decision at
  // handshake time was the single largest instance of the staleness bug
  // fixed throughout this file — see resolveOperator's comment in
  // authStore.js and requireAuth's comment above.
  const operator = request.session.operator;
  const currentOperator = () => resolveOperator(operator);

  // Direct WebSocket mode-management messages are admin/dev controls just
  // like the HTTP command console. Device RBAC still applies after this
  // feature-role gate, so admin does not imply access to every phone.
  const requireAdminWs = (deviceId, action) => {
    if (hasRole(currentOperator(), OPERATOR_ROLES.ADMIN)) return true;
    auditLog.logEvent({
      operator: operator.username,
      type: "admin_access_denied",
      deviceId: deviceId ?? null,
      detail: { action },
    });
    ws.send(JSON.stringify({
      type: "error",
      deviceId: deviceId ?? undefined,
      message: "Admin role required for AI-mode controls.",
    }));
    return false;
  };

  let selected = null;
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.send(JSON.stringify({ type: "device_list", devices: [...devices.values()].map(summary) }));

  // A real device is a network call that can fail (phone locked, iproxy not
  // running, WDA crashed). Never let that take the whole relay server down —
  // report it to the VA every time, but only flip the device's *status* to
  // offline (which is what other VAs see in their device list) after a run
  // of consecutive failures, not one blip. This is the single funnel for
  // every failure below — success is recorded separately, in sendFrame.
  const reportError = (message) => {
    ws.send(JSON.stringify({ type: "error", deviceId: selected?.id, message }));
    if (selected) {
      const failures = recordFailure(selected.id);
      if (failures >= OFFLINE_AFTER_FAILURES && selected.status !== "offline") {
        selected.status = "offline";
        broadcastDeviceList();
      }
    }
  };

  const sendFrame = async () => {
    if (!selected) return;
    try {
      const frame = await selected.render();
      const recovered = recordSuccess(selected.id);
      // Health fields (lastSeenAt/consecutiveFailures) update on every
      // success without a broadcast — that's a lot of noise to push to every
      // connected VA for every tap. Only broadcast when status itself
      // actually changes, matching how every other status transition here
      // already only broadcasts on real change, not on every action.
      if (recovered && selected.status === "offline") {
        selected.status = "in-use";
        broadcastDeviceList();
      }
      ws.send(JSON.stringify({ type: "frame", deviceId: selected.id, ...frame }));
    } catch (err) {
      reportError(`Couldn't reach ${selected.label}: ${err.message}`);
    }
  };

  // Shared by select_device's success path and takeover's post-handoff
  // claim — releasing whatever this connection had before, then claiming
  // `target` for it, sending a frame, and telling everyone else.
  const claimDevice = async (target) => {
    if (selected) releaseDevice(selected);
    selected = target;
    selected.status = "in-use";
    auditLog.logEvent({
      operator: operator.username,
      type: "device_selected",
      deviceId: selected.id,
      detail: withNetworkEgress(selected.id),
    });
    await sendFrame();
    broadcastDeviceList();
  };

  // Without this, two messages arriving close together (a fast double-click,
  // or just network jitter) start their async handlers concurrently — their
  // requests to the device can complete out of order, and the frames they
  // send back can arrive out of order too, showing the VA stale state after
  // a newer action. Chaining every message onto one promise per connection
  // forces strict in-order, one-at-a-time processing without blocking other
  // connections. The catch here matters: an uncaught rejection would poison
  // this chain permanently, silently breaking all future messages on this
  // connection — every handler below already catches its own errors, but
  // this is the backstop for anything that doesn't.
  let actionQueue = Promise.resolve();
  const enqueue = (fn) => {
    actionQueue = actionQueue.then(fn).catch((err) => {
      console.error("Unexpected error in connection message queue:", err);
    });
  };

  ws.on("message", (raw) => enqueue(async () => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "select_device") {
      const target = devices.get(msg.deviceId) || null;
      if (!target) {
        ws.send(JSON.stringify({ type: "error", deviceId: msg.deviceId, message: "Unknown device." }));
        return;
      }
      if (!canAccessDevice(currentOperator(), msg.deviceId)) {
        auditLog.logEvent({ operator: operator.username, type: "device_select_denied", deviceId: msg.deviceId });
        ws.send(JSON.stringify({
          type: "error",
          deviceId: msg.deviceId,
          message: "You are not authorized for this device.",
        }));
        return;
      }
      // An AI worker currently holds this device's input lease — a human
      // must take over explicitly (see "takeover" below) rather than
      // silently interrupting whatever the AI is mid-task on.
      if (!deviceLease.canHumanSelect(msg.deviceId)) {
        ws.send(JSON.stringify({
          type: "error",
          deviceId: msg.deviceId,
          message: `${target.label} is in AI mode — take over first.`,
        }));
        return;
      }
      // Another VA already has this one — don't silently steal control of a
      // phone someone else is mid-task on.
      if (target !== selected && target.status === "in-use") {
        auditLog.logEvent({ operator: operator.username, type: "device_select_conflict", deviceId: msg.deviceId });
        ws.send(JSON.stringify({
          type: "error",
          deviceId: msg.deviceId,
          message: `${target.label} is already in use by another VA.`,
        }));
        return;
      }
      await claimDevice(target);
      return;
    }

    // Human/AI mode switching (Architecture Baseline.md §3-4). Switching to
    // AI mode moves the device to AI_IDLE; the scheduler acquires it only
    // when an eligible task is ready.
    if (msg.type === "switch_to_ai") {
      if (!requireAdminWs(msg.deviceId, "switch_to_ai")) return;
      const target = devices.get(msg.deviceId) || null;
      if (!target) {
        ws.send(JSON.stringify({ type: "error", deviceId: msg.deviceId, message: "Unknown device." }));
        return;
      }
      if (!canAccessDevice(currentOperator(), msg.deviceId)) {
        ws.send(JSON.stringify({
          type: "error",
          deviceId: msg.deviceId,
          message: "You are not authorized for this device.",
        }));
        return;
      }
      if (target.status !== "idle") {
        ws.send(JSON.stringify({
          type: "error",
          deviceId: msg.deviceId,
          message: `${target.label} must be idle before switching it to AI mode.`,
        }));
        return;
      }
      try {
        deviceLease.switchToAI(msg.deviceId);
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", deviceId: msg.deviceId, message: err.message }));
        return;
      }
      auditLog.logEvent({ operator: operator.username, type: "switched_to_ai", deviceId: msg.deviceId });
      broadcastDeviceList();
      return;
    }

    // Stops whatever AI control exists on the device (gracefully finishing
    // any in-flight action first) and claims it for the caller in one step —
    // this is the "STOP AI / TAKE OVER" control (MS6.3.2), meant to work
    // through the same simple interaction as a normal device click.
    if (msg.type === "takeover") {
      if (!requireAdminWs(msg.deviceId, "takeover")) return;
      const target = devices.get(msg.deviceId) || null;
      if (!target) {
        ws.send(JSON.stringify({ type: "error", deviceId: msg.deviceId, message: "Unknown device." }));
        return;
      }
      if (!canAccessDevice(currentOperator(), msg.deviceId)) {
        ws.send(JSON.stringify({
          type: "error",
          deviceId: msg.deviceId,
          message: "You are not authorized for this device.",
        }));
        return;
      }
      // taskQueue.takeoverDevice, not a bare deviceLease.switchToHuman: if an
      // AI task is actively running on this device, it must be cancelled
      // here too — otherwise it would keep believing it holds a device that
      // just became HUMAN, an inconsistency between the queue and reality
      // that only this single entry point (also used by the /takeover
      // command) can reliably prevent.
      await taskQueue.takeoverDevice(msg.deviceId);
      auditLog.logEvent({ operator: operator.username, type: "takeover", deviceId: msg.deviceId });
      await claimDevice(target);
      return;
    }

    // Unlike takeover, never waits on anything and never claims the device
    // for the caller — the only job here is making AI input stop, right now,
    // from whatever state things are in (Architecture Baseline.md §3,
    // CLAUDE.md §4's "control-plane boundary" requirement).
    if (msg.type === "emergency_stop") {
      if (!requireAdminWs(msg.deviceId, "emergency_stop")) return;
      const target = devices.get(msg.deviceId) || null;
      if (!target) {
        ws.send(JSON.stringify({ type: "error", deviceId: msg.deviceId, message: "Unknown device." }));
        return;
      }
      if (!canAccessDevice(currentOperator(), msg.deviceId)) {
        ws.send(JSON.stringify({
          type: "error",
          deviceId: msg.deviceId,
          message: "You are not authorized for this device.",
        }));
        return;
      }
      // Goes through the queue (which itself calls deviceLease.emergencyStop
      // synchronously — see its own comment) rather than deviceLease
      // directly, so a RUNNING task doesn't get left behind believing it
      // still holds a device that just got yanked back to HUMAN underneath
      // it — the same zombie-task class of bug the `takeover` handler above
      // was already fixed for.
      taskQueue.emergencyStopDevice(msg.deviceId);
      auditLog.logEvent({ operator: operator.username, type: "emergency_stop", deviceId: msg.deviceId });
      broadcastDeviceList();
      return;
    }

    if (msg.type === "tap" && selected) {
      // Never forward unvalidated coordinates to a device — for a real WDA
      // device this becomes an actual pixel tap on an actual phone, so a
      // malformed message (NaN, missing, out of range) must stop here
      // rather than silently propagate.
      const isUnitCoord = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
      if (!isUnitCoord(msg.x) || !isUnitCoord(msg.y)) return;

      try {
        await selected.tap(msg.x, msg.y);
        auditLog.logEvent({
          operator: operator.username,
          type: "action_tap",
          deviceId: selected.id,
          detail: withNetworkEgress(selected.id, { x: msg.x, y: msg.y }),
        });
        await sendFrame();
      } catch (err) {
        reportError(`Couldn't reach ${selected.label}: ${err.message}`);
      }
      return;
    }

    if (msg.type === "swipe" && selected) {
      const directions = ["up", "down", "left", "right"];
      if (!directions.includes(msg.direction)) return;

      try {
        await selected.swipe(msg.direction);
        auditLog.logEvent({
          operator: operator.username,
          type: "action_swipe",
          deviceId: selected.id,
          detail: withNetworkEgress(selected.id, { direction: msg.direction }),
        });
        await sendFrame();
      } catch (err) {
        reportError(`Couldn't reach ${selected.label}: ${err.message}`);
      }
      return;
    }

    if (msg.type === "home" && selected) {
      try {
        await selected.pressHome();
        auditLog.logEvent({
          operator: operator.username,
          type: "action_home",
          deviceId: selected.id,
          detail: withNetworkEgress(selected.id),
        });
        await sendFrame();
      } catch (err) {
        reportError(`Couldn't reach ${selected.label}: ${err.message}`);
      }
      return;
    }

    if (msg.type === "type_text" && selected) {
      // Cap length — this goes straight to the keyboard on a real device;
      // no reason to accept an unbounded payload.
      if (typeof msg.text !== "string" || msg.text.length === 0 || msg.text.length > 1000) return;

      try {
        await selected.typeText(msg.text);
        // Length only, never the text itself — this goes straight to a
        // real keyboard and the audit log isn't the place to retain that.
        auditLog.logEvent({
          operator: operator.username,
          type: "action_type_text",
          deviceId: selected.id,
          detail: withNetworkEgress(selected.id, { length: msg.text.length }),
        });
        await sendFrame();
      } catch (err) {
        reportError(`Couldn't reach ${selected.label}: ${err.message}`);
      }
      return;
    }

    if (msg.type === "release_device" && selected) {
      auditLog.logEvent({
        operator: operator.username,
        type: "device_released",
        deviceId: selected.id,
        detail: withNetworkEgress(selected.id),
      });
      releaseDevice(selected);
      selected = null;
      broadcastDeviceList();
    }
  }));

  ws.on("close", () => {
    if (selected) {
      releaseDevice(selected);
      selected = null;
      broadcastDeviceList();
    }
  });
});

// Guarded so integration tests can `import` this module (to get `server` and
// start it on an ephemeral port) without also triggering a real listen on the
// default port — importing must be side-effect-free with respect to networking.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
let queueTickTimer;
if (isMain) {
  researchTaskRunner.start();
  // Dispatch only after the worker and UI listeners exist. Dispatching from
  // createTaskQueue() would emit recovered work before either subscriber can
  // see it, leaving a restarted research task RUNNING with no consumer.
  taskQueue.tick(new Date());
  const PORT = process.env.PORT || 4173;
  server.listen(PORT, () => {
    // server.address().port (not the raw PORT var) so this is still correct
    // when PORT=0 asks the OS for an ephemeral port.
    console.log(`Phone Farm control server running at http://localhost:${server.address().port}`);
  });
  // Only when actually running as the server, not on import — tests drive
  // taskQueue.tick() explicitly with controlled timestamps, and a real
  // wall-clock timer running in the background during those tests would
  // make window-timing assertions nondeterministic.
  const QUEUE_TICK_INTERVAL_MS = 5000;
  queueTickTimer = setInterval(() => taskQueue.tick(new Date()), QUEUE_TICK_INTERVAL_MS);
}

export {
  app,
  server,
  wss,
  devices,
  deviceHealth,
  heartbeatTimer,
  auditLog,
  deviceLease,
  taskQueue,
  queueTickTimer,
  deviceNetwork,
  networkVerifier,
  deviceHost,
  researchTaskRunner,
  modelSelection,
};
