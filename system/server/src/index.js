import express from "express";
import session from "express-session";
import multer from "multer";
import { WebSocketServer } from "ws";
import { createServer, ServerResponse } from "http";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import { MockDevice } from "./mockDevice.js";
import { WdaDevice } from "./wdaDevice.js";
import { ensureDeviceDir, listFiles, resolveFile, deleteFile, safeFilename, safeDeviceId, assertMediaStorageIsolated } from "./fileStore.js";
import { listRuns, getRun, createRun, setCandidateStatus } from "./researchStore.js";
import {
  canAccessDevice, publicOperator, resolveOperator, hasCapability, operators, verifyPassword,
  listOperatorAccounts, createOperatorAccount, updateOperatorAccount, operatorByUsername,
  invalidateOperatorSessions, createSignupAccount, setOperatorAccountStatus, renameOperatorAccount,
  configureOperatorTwoFactor, verifyOperatorSecondFactor, createEmailRecoveryToken, completeEmailRecovery,
  assertValidUsername,
  resetOperatorSecondFactor,
} from "./authStore.js";
import { CAPABILITIES } from "./roleCapabilities.js";
import { researchWorkspaceFor, researchAccounts, researchAccountDefinitions, researchActionPolicies } from "./researchAccess.js";
import { createAuditLog } from "./auditLog.js";
import { FileSessionStore } from "./fileSessionStore.js";
import * as deviceLease from "./deviceLease.js";
import { createTaskQueue } from "./taskQueue.js";
import { parseCommand } from "./commandParser.js";
import { loadDeviceNetworkMap, publicNetworkConfig } from "./deviceNetworkConfig.js";
import { isProxyEgress, setDeviceProxyEnabled } from "./deviceNetworkStore.js";
import { createNetworkVerifier } from "./networkVerifier.js";
import { networkAccessDecision, networkVerificationMaxAge } from "./networkPolicy.js";
import { providers, defaultProviderName, getProvider } from "./providerRegistry.js";
import { getPlatformSkill } from "./platformSkillRegistry.js";
import { createResearchTaskRunner } from "./researchTaskRunner.js";
import { createModelSelection } from "./modelSelection.js";
import { resolveResearchEvidence } from "./researchEvidenceStore.js";
import { createPresenceStore } from "./presenceStore.js";
import { createAssignmentStore, ASSIGNMENT_STATUSES } from "./assignmentStore.js";
import { OPERATOR_ROLES } from "./roleCapabilities.js";
import { monitorState } from "./monitorContract.js";
import { createAccountNotificationStore } from "./accountNotificationStore.js";
import { decryptTotpSecret, encryptTotpSecret, generateRecoveryCodes, generateTotpSecret, otpauthUri, recoveryCodeDigest, verifyTotp } from "./twoFactor.js";
import { discoverIosDevices, DiscoveredIosDevice } from "./deviceDiscovery.js";
import {
  createMediaQuotaManager, createQuotaStorage, mediaByteSetting,
  DEFAULT_DEVICE_MEDIA_QUOTA_BYTES, DEFAULT_GLOBAL_MEDIA_QUOTA_BYTES, DEFAULT_MEDIA_MIN_FREE_BYTES,
} from "./mediaUploadQuota.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, "../../client");
const configPath = process.env.DEVICE_CONFIG_PATH || path.join(__dirname, "../../devices.config.json");
const rawDeviceConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : { devices: [] };
const discoveredIosDevices = process.env.AUTO_DISCOVER_IOS_DEVICES === "false" ? [] : discoverIosDevices();

const app = express();
app.use(express.static(clientDir));
app.use(express.json());

// Env-overridable (not just a fixed path like fileStore.js/researchStore.js)
// so tests can point these at a disposable temp location instead of the real
// storage/ tree — see server/test/integration/persistence.test.js.
const sessionStoreDir = process.env.SESSION_STORE_DIR || path.join(__dirname, "../../storage/sessions");
const auditLogPath = process.env.AUDIT_LOG_PATH || path.join(__dirname, "../../storage/audit/events.log");
assertMediaStorageIsolated([
  sessionStoreDir, auditLogPath,
  process.env.QUEUE_STORE_PATH || path.join(__dirname, "../../storage/queue/tasks.json"),
  process.env.MODEL_SELECTION_STORE_PATH || path.join(__dirname, "../../storage/models/selection.json"),
  process.env.ASSIGNMENT_STORE_PATH || path.join(__dirname, "../../storage/assignments/assignments.json"),
  process.env.RESEARCH_STORE_DIR || path.join(__dirname, "../../storage/research"),
  process.env.RESEARCH_EVIDENCE_DIR || path.join(__dirname, "../../storage/research-evidence"),
]);
const auditLog = createAuditLog(auditLogPath);
const accountNotificationStore = createAccountNotificationStore({
  storePath: process.env.ACCOUNT_NOTIFICATION_STORE_PATH || path.join(__dirname, "../../storage/notifications/accounts.json"),
  companyEmail: process.env.COMPANY_FROM_EMAIL || null,
});
const twoFactorMasterKey = process.env.TWO_FACTOR_MASTER_KEY || null;

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me";
if (!process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET not set — using an insecure default. Set it before running beyond local dev.");
}
const sessionStore = new FileSessionStore(sessionStoreDir);
const presenceStore = createPresenceStore();
const sessionParser = session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // 24h, not a browser-session cookie: now that sessions survive a relay
  // restart, there's no reason to also force a re-login on every browser close.
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 },
});
app.use(sessionParser);

function completeLogin(req, res, operator, { secondFactor = null } = {}) {
  req.session.operator = { username: operator.username, authVersion: operator.authVersion ?? 0 };
  delete req.session.pendingAuth;
  delete req.session.twoFactorEnrollmentSecret;
  delete req.session.twoFactorRecoveryReceipt;
  presenceStore.touchSession({
    sessionId: req.sessionID,
    username: operator.username,
    expiresAt: req.session.cookie.expires,
  });
  auditLog.logEvent({ operator: operator.username, type: "login_success", detail: secondFactor ? { secondFactor } : {} });
  res.json(publicOperator(operator));
}

function pendingAuthOperator(req) {
  const challenge = req.session?.pendingAuth;
  if (!challenge || Date.parse(challenge.expiresAt) <= Date.now()) return null;
  const operator = operators.get(challenge.username);
  if (!operator || operator.active === false || (operator.accountStatus ?? "approved") !== "approved"
    || operator.authVersion !== challenge.authVersion) return null;
  return operator;
}

function rejectSecondFactorAttempt(req, res, message) {
  const challenge = req.session?.pendingAuth;
  if (!challenge) return res.status(401).json({ error: "password verification has expired" });
  challenge.failedAttempts = (Number(challenge.failedAttempts) || 0) + 1;
  if (challenge.failedAttempts >= 5) {
    delete req.session.pendingAuth;
    delete req.session.twoFactorEnrollmentSecret;
    return res.status(429).json({ error: "too many two-factor attempts; sign in again" });
  }
  return res.status(401).json({ error: message });
}

app.post("/api/signup", (req, res, next) => {
  try {
    const operator = createSignupAccount(req.body);
    auditLog.logEvent({ operator: operator.username, type: "signup_submitted" });
    res.status(201).json({
      status: "pending",
      message: "Application received. An administrator must accept it before sign-in.",
      operator,
    });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string" || username.length > 100) {
    return res.status(400).json({ error: "username and password are required" });
  }
  const operator = operators.get(username);
  if (!operator || !verifyPassword(password, operator.passwordHash)) {
    auditLog.logEvent({ operator: username, type: "login_failed" });
    return res.status(401).json({ error: "invalid credentials" });
  }
  if (operator.accountStatus === "pending") return res.status(403).json({ code: "approval_pending", error: "account approval is pending" });
  if (operator.accountStatus === "rejected") return res.status(403).json({ code: "account_rejected", error: "account application was not accepted" });
  if (operator.active === false) return res.status(401).json({ error: "invalid credentials" });
  if (operator.twoFactorRequired) {
    req.session.pendingAuth = {
      username: operator.username,
      authVersion: operator.authVersion ?? 0,
      failedAttempts: 0,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    return res.status(202).json(operator.twoFactorSecret
      ? { requiresTwoFactor: true }
      : { requiresTwoFactorSetup: true });
  }
  completeLogin(req, res, operator);
});

app.post("/api/2fa/setup", (req, res) => {
  const operator = pendingAuthOperator(req);
  if (!operator) return res.status(401).json({ error: "password verification has expired" });
  if (operator.twoFactorSecret) return res.status(409).json({ error: "2FA is already configured" });
  if (!twoFactorMasterKey) return res.status(503).json({ error: "2FA enrollment is unavailable until TWO_FACTOR_MASTER_KEY is configured" });
  const secret = generateTotpSecret();
  req.session.twoFactorEnrollmentSecret = secret;
  res.json({ secret, otpauthUri: otpauthUri({ secret, email: operator.email || operator.username }) });
});

app.post("/api/2fa/confirm", (req, res, next) => {
  try {
    const operator = pendingAuthOperator(req);
    const secret = req.session?.twoFactorEnrollmentSecret;
    if (!operator || !secret) return res.status(401).json({ error: "2FA enrollment has expired" });
    if (!verifyTotp(secret, req.body?.code)) return rejectSecondFactorAttempt(req, res, "invalid authenticator code");
    const recoveryCodes = generateRecoveryCodes();
    configureOperatorTwoFactor(
      operator.username,
      encryptTotpSecret(secret, twoFactorMasterKey),
      recoveryCodes.map(recoveryCodeDigest),
    );
    auditLog.logEvent({ operator: operator.username, type: "two_factor_enabled" });
    const current = operators.get(operator.username);
    req.session.twoFactorRecoveryReceipt = encryptTotpSecret(JSON.stringify(recoveryCodes), twoFactorMasterKey);
    delete req.session.twoFactorEnrollmentSecret;
    res.json({ operator: publicOperator(current), recoveryCodes });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.get("/api/2fa/recovery-receipt", (req, res) => {
  const operator = pendingAuthOperator(req);
  const encrypted = req.session?.twoFactorRecoveryReceipt;
  if (!operator || !encrypted || !twoFactorMasterKey) return res.status(401).json({ error: "2FA recovery-code receipt has expired" });
  try {
    const recoveryCodes = JSON.parse(decryptTotpSecret(encrypted, twoFactorMasterKey));
    if (!Array.isArray(recoveryCodes)) throw new Error("invalid receipt");
    res.json({ operator: publicOperator(operator), recoveryCodes });
  } catch {
    res.status(401).json({ error: "2FA recovery-code receipt is unavailable; sign in and restart enrollment" });
  }
});

app.post("/api/2fa/acknowledge-recovery", (req, res) => {
  const operator = pendingAuthOperator(req);
  if (!operator || !req.session?.twoFactorRecoveryReceipt) {
    return res.status(401).json({ error: "2FA recovery-code receipt has expired" });
  }
  auditLog.logEvent({ operator: operator.username, type: "two_factor_recovery_acknowledged" });
  completeLogin(req, res, operator, { secondFactor: "enrollment" });
});

app.post("/api/2fa/verify", (req, res, next) => {
  try {
    const operator = pendingAuthOperator(req);
    if (!operator) return res.status(401).json({ error: "password verification has expired" });
    const result = verifyOperatorSecondFactor(operator.username, req.body?.code, twoFactorMasterKey);
    if (!result) return rejectSecondFactorAttempt(req, res, "invalid two-factor code");
    completeLogin(req, res, operators.get(operator.username), { secondFactor: result.method });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.post("/api/recovery/request", (req, res) => {
  const recovery = createEmailRecoveryToken(req.body?.identifier);
  if (recovery) accountNotificationStore.queue({
    to: recovery.operator.email,
    fullName: recovery.operator.fullName || recovery.operator.username,
    username: recovery.operator.username,
    status: "recovery",
    recoveryToken: recovery.token,
  });
  res.json({ ok: true, message: "If the account is eligible, recovery instructions have been queued." });
});

app.post("/api/recovery/complete", (req, res, next) => {
  try {
    const operator = completeEmailRecovery(req.body?.token, req.body?.password, req.body?.passwordConfirmation);
    auditLog.logEvent({ operator: operator.username, type: "account_recovered" });
    revokeLiveOperatorSessions(operator.username);
    res.json({ ok: true, requiresTwoFactorSetup: true });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.post("/api/logout", (req, res) => {
  const username = req.session.operator?.username ?? null;
  presenceStore.removeSession(req.sessionID);
  broadcastPresence();
  // Revoke synchronously before destroying storage, so queued commands and
  // an in-flight session lookup cannot authorize another action.
  for (const ws of wss.clients) {
    if (ws.sessionId === req.sessionID) ws.invalidateSession();
  }
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: "Could not destroy session" });
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
  presenceStore.touchSession({ sessionId: req.sessionID, username: current.username, expiresAt: req.session.cookie.expires });
  next();
}

// Feature-role authorization is separate from device RBAC. A route protected
// here may still perform canAccessDevice() checks when it acts on a specific
// phone. Missing/legacy roles normalize to VA in authStore.js, so old session
// data never gains admin rights by accident.
function requireCapability(capability) {
  return (req, res, next) => {
    if (!req.session?.operator) return res.status(401).json({ error: "not logged in" });
    const current = resolveOperator(req.session.operator);
    if (!current) return res.status(401).json({ error: "not logged in" });
    req.currentOperator = current;
    if (!hasCapability(current, capability)) {
      auditLog.logEvent({
        operator: req.session.operator.username,
        type: "capability_access_denied",
        detail: { method: req.method, path: req.path, capability },
      });
      return res.status(403).json({ error: `${capability} capability required` });
    }
    presenceStore.touchSession({ sessionId: req.sessionID, username: current.username, expiresAt: req.session.cookie.expires });
    next();
  };
}

function requireAnyCapability(...capabilities) {
  return (req, res, next) => {
    if (!req.session?.operator) return res.status(401).json({ error: "not logged in" });
    const current = resolveOperator(req.session.operator);
    if (!current) return res.status(401).json({ error: "not logged in" });
    req.currentOperator = current;
    if (!capabilities.some(capability => hasCapability(current, capability))) {
      auditLog.logEvent({
        operator: current.username,
        type: "capability_access_denied",
        detail: { method: req.method, path: req.path, capabilities },
      });
      return res.status(403).json({ error: "user-management capability required" });
    }
    presenceStore.touchSession({ sessionId: req.sessionID, username: current.username, expiresAt: req.session.cookie.expires });
    next();
  };
}

// Login/logout/me stay open; every device and research route below requires
// an authenticated session.
app.use("/api/devices", requireAuth);
app.use("/api/research", requireAuth);

// Raw audit history is an admin/dev oversight surface. VAs still generate
// audit events through normal device work but cannot read the global log.
app.get("/api/audit", requireCapability(CAPABILITIES.VIEW_AUDIT), (req, res) => {
  const { operator, deviceId, limit } = req.query;
  const requestedLimit = limit ? Math.min(Number(limit) || 200, 1000) : 200;
  res.json({
    events: auditLog.listEvents({
      operator: typeof operator === "string" ? operator : undefined,
      deviceId: typeof deviceId === "string" ? deviceId : undefined,
      limit: 1000,
    }).filter(event => !event.deviceId || canAccessDevice(req.currentOperator, event.deviceId)).slice(0, requestedLimit),
  });
});

function publicPeople(viewer = null) {
  const visibleAssignments = assignmentStore.list().filter(item => !viewer || assignmentScopeAllowed(item, viewer));
  return presenceStore.listPeople(operators.values()).map(person => {
    const assignment = visibleAssignments.find(item => item.assignee === person.username
      && ["assigned", "in_progress"].includes(item.status)) ?? null;
    return {
      ...person,
      canAssign: Boolean(viewer && hasCapability(viewer, CAPABILITIES.MANAGE_ASSIGNMENTS)
        && canManagePerson(viewer, person.username)),
      currentDeviceIds: person.currentDeviceIds.filter(id => !viewer || canAccessDevice(viewer, id)),
      currentPhones: person.currentDeviceIds
        .filter(id => !viewer || canAccessDevice(viewer, id))
        .map(id => ({ id, label: devices.get(id)?.label ?? id })),
      assignment: assignment ? {
        id: assignment.id,
        deviceId: assignment.deviceId,
        status: assignment.status,
        startAt: assignment.startAt ?? null,
        endAt: assignment.endAt ?? null,
      } : null,
    };
  });
}

app.get("/api/people", requireCapability(CAPABILITIES.VIEW_PEOPLE), (req, res) => {
  res.json({ people: publicPeople(req.currentOperator) });
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
    if (!request.session?.operator || !resolveOperator(request.session.operator)) {
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
function loadDevices(raw, discoveries = []) {
  const map = new Map();
  const discoveryByUdid = new Map(discoveries.map(device => [device.udid, device]));
  for (const d of raw.devices) {
    if (!safeDeviceId(d.id)) throw new Error(`Invalid or reserved device id: ${d.id}`);
    const discovered = typeof d.udid === "string" ? discoveryByUdid.get(d.udid) : null;
    const label = discovered?.label || d.label;
    if (d.type === "wda") {
      map.set(d.id, new WdaDevice(d.id, label, { host: d.host, port: d.port, timeoutMs: d.timeoutMs }));
    } else {
      map.set(d.id, new MockDevice(d.id, label));
    }
    if (discovered) discoveryByUdid.delete(d.udid);
  }
  for (const discovered of discoveryByUdid.values()) map.set(discovered.id, new DiscoveredIosDevice(discovered));
  return map;
}

const devices = loadDevices(rawDeviceConfig, discoveredIosDevices);
const deviceMonitorConfig = new Map();
for (const configured of rawDeviceConfig.devices ?? []) {
  if (configured.monitorPhysicallyValidated !== undefined
    && typeof configured.monitorPhysicallyValidated !== "boolean") {
    throw new Error(`monitorPhysicallyValidated must be boolean for device ${configured.id}`);
  }
  if (configured.monitorPhysicallyValidated === true && configured.type !== "wda") {
    throw new Error(`Only a WDA device can be marked monitorPhysicallyValidated: ${configured.id}`);
  }
  deviceMonitorConfig.set(configured.id, {
    adapter: configured.type === "wda" ? "wda" : "mock",
    physicallyValidated: configured.monitorPhysicallyValidated === true,
  });
}
for (const discovered of discoveredIosDevices) {
  if (!deviceMonitorConfig.has(discovered.id)) {
    deviceMonitorConfig.set(discovered.id, { adapter: "unconfigured", physicallyValidated: false });
  }
}

function validateOperatorResources(input) {
  if (Object.hasOwn(input ?? {}, "allowedDevices") && input.allowedDevices !== null) {
    const unknown = input.allowedDevices?.find?.(id => !devices.has(id));
    if (unknown) return `unknown device: ${unknown}`;
  }
  if (Object.hasOwn(input ?? {}, "allowedResearchWorkspaces")) {
    const workspaces = new Set(researchAccounts.values());
    const unknown = input.allowedResearchWorkspaces?.find?.(id => !workspaces.has(id));
    if (unknown) return `unknown research workspace: ${unknown}`;
  }
  return null;
}

function revokeLiveOperatorSessions(username) {
  for (const ws of wss.clients) {
    if (ws.operatorUsername !== username) continue;
    presenceStore.removeSession(ws.sessionId);
    ws.invalidateSession?.();
  }
  broadcastPresence();
}

function reconcileLiveOperatorAccess(username) {
  for (const ws of wss.clients) {
    if (ws.operatorUsername !== username) continue;
    const current = ws.currentOperator?.();
    if (current && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "operator_profile", operator: publicOperator(current) }));
    }
    ws.releaseUnauthorizedSelection?.("operator_updated");
  }
}

app.get("/api/admin/users", requireAnyCapability(CAPABILITIES.MANAGE_USERS, CAPABILITIES.MANAGE_TEAM_MEMBERS), (req, res) => {
  expireAssignments();
  const people = new Map(publicPeople(req.currentOperator).map(person => [person.username, person]));
  const visibleAssignments = assignmentStore.list().filter(item => canViewAssignment(item, req.currentOperator));
  const allUsers = listOperatorAccounts();
  const activeAdminCount = allUsers.filter(user => user.active !== false
    && (user.accountStatus ?? "approved") === "approved"
    && user.role === OPERATOR_ROLES.ADMIN).length;
  const visibleUsers = allUsers.filter(user => canManagePerson(req.currentOperator, user.username));
  res.json({ users: visibleUsers.map(user => ({
    ...user,
    canRename: req.currentOperator.role === OPERATOR_ROLES.ADMIN || user.username !== req.currentOperator.username,
    canReview: user.username !== req.currentOperator.username
      && !(user.role === OPERATOR_ROLES.ADMIN && user.active !== false
        && (user.accountStatus ?? "approved") === "approved" && activeAdminCount === 1),
    actionReason: user.username === req.currentOperator.username
      ? req.currentOperator.role === OPERATOR_ROLES.MANAGER
        ? "You cannot rename or review the account you are currently using."
        : "You cannot reject the account you are currently using."
      : user.role === OPERATOR_ROLES.ADMIN && user.active !== false
          && (user.accountStatus ?? "approved") === "approved" && activeAdminCount === 1
        ? "This is the last active admin account. Create or activate another admin first."
        : null,
    presence: people.get(user.username) ?? { online: false, activeSessions: 0, currentPhones: [], lastSeenAt: null },
    assignments: visibleAssignments.filter(item => item.assignee === user.username || item.createdBy === user.username),
    recentAudit: hasCapability(req.currentOperator, CAPABILITIES.VIEW_AUDIT)
      ? auditLog.listEvents({ operator: user.username, limit: 200 })
        .filter(event => !event.deviceId || canAccessDevice(req.currentOperator, event.deviceId)).slice(0, 10)
      : [],
  })) });
});

app.patch("/api/admin/users/:username/status", requireAnyCapability(CAPABILITIES.MANAGE_USERS, CAPABILITIES.MANAGE_TEAM_MEMBERS), (req, res, next) => {
  try {
    if (!canManagePerson(req.currentOperator, req.params.username)) {
      return res.status(403).json({ error: "not authorized to review this account" });
    }
    if (req.currentOperator.role === OPERATOR_ROLES.MANAGER && req.params.username === req.currentOperator.username) {
      return res.status(403).json({ error: "a manager cannot review their own account" });
    }
    if (req.body?.status === "rejected" && req.params.username === req.currentOperator.username) {
      return res.status(403).json({ error: "you cannot reject the account you are currently using" });
    }
    const target = operators.get(req.params.username);
    if (!target?.email) return res.status(409).json({ error: "account must have a Gmail address before review" });
    const operator = setOperatorAccountStatus(req.params.username, req.body?.status);
    const notification = accountNotificationStore.queue({
      to: operator.email,
      fullName: operator.fullName || operator.username,
      username: operator.username,
      status: req.body.status,
    });
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: `operator_${req.body.status}`,
      detail: { target: operator.username, teamId: operator.teamId || null, notificationState: notification.deliveryState },
    });
    revokeLiveOperatorSessions(operator.username);
    broadcastPresence();
    res.json({ operator, notification: { deliveryState: notification.deliveryState } });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.patch("/api/admin/users/:username/rename", requireAnyCapability(CAPABILITIES.MANAGE_USERS, CAPABILITIES.MANAGE_TEAM_MEMBERS), (req, res, next) => {
  const previousUsername = req.params.username;
  try {
    if (!canManagePerson(req.currentOperator, previousUsername)) {
      return res.status(403).json({ error: "not authorized to rename this account" });
    }
    if (req.currentOperator.role === OPERATOR_ROLES.MANAGER && previousUsername === req.currentOperator.username) {
      return res.status(403).json({ error: "a manager cannot rename their own account" });
    }
    assertValidUsername(req.body?.username);
    if (operators.has(req.body?.username)) return res.status(409).json({ error: "username already exists" });
    assignmentStore.renamePrincipal(previousUsername, req.body?.username, req.currentOperator.username);
    const operator = renameOperatorAccount(previousUsername, req.body?.username);
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "operator_renamed",
      detail: { previousUsername, username: operator.username },
    });
    revokeLiveOperatorSessions(previousUsername);
    broadcastPresence();
    broadcastDeviceList();
    res.json({ operator });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    if (/username|required/.test(error.message)) return res.status(400).json({ error: error.message });
    next(error);
  }
});

app.get("/api/admin/account-notifications", requireCapability(CAPABILITIES.MANAGE_USERS), (req, res) => {
  res.json({ notifications: accountNotificationStore.list().map(item => ({
    id: item.id,
    to: item.to,
    from: item.from,
    subject: item.subject,
    kind: item.kind,
    deliveryState: item.deliveryState,
    createdAt: item.createdAt,
  })) });
});

app.post("/api/admin/users", requireCapability(CAPABILITIES.MANAGE_USERS), (req, res, next) => {
  try {
    const resourceError = validateOperatorResources(req.body);
    if (resourceError) return res.status(400).json({ error: resourceError });
    const operator = createOperatorAccount(req.body);
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "operator_created",
      detail: { target: operator.username, role: operator.role, active: operator.active },
    });
    broadcastPresence();
    broadcastDeviceList();
    res.status(201).json({ operator });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.patch("/api/admin/users/:username", requireCapability(CAPABILITIES.MANAGE_USERS), (req, res, next) => {
  try {
    const resourceError = validateOperatorResources(req.body);
    if (resourceError) return res.status(400).json({ error: resourceError });
    const result = updateOperatorAccount(req.params.username, req.body);
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "operator_updated",
      detail: { target: result.operator.username, fields: Object.keys(req.body).sort() },
    });
    if (result.invalidatesSessions) revokeLiveOperatorSessions(result.operator.username);
    else {
      reconcileLiveOperatorAccess(result.operator.username);
      broadcastPresence();
    }
    broadcastDeviceList();
    res.json({ operator: result.operator });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.post("/api/admin/users/:username/revoke-sessions", requireCapability(CAPABILITIES.MANAGE_USERS), (req, res, next) => {
  try {
    const operator = invalidateOperatorSessions(req.params.username);
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "operator_sessions_revoked",
      detail: { target: operator.username },
    });
    revokeLiveOperatorSessions(operator.username);
    res.json({ operator });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.post("/api/admin/users/:username/2fa/reset", requireCapability(CAPABILITIES.MANAGE_USERS), (req, res, next) => {
  try {
    const operator = resetOperatorSecondFactor(req.params.username);
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "operator_two_factor_reset",
      detail: { target: operator.username },
    });
    revokeLiveOperatorSessions(operator.username);
    res.json({ operator });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

// Phase 0 of per-phone network isolation (source-material/Client Account
// Separation — Technical Reference (REDACTED).md §3.5) — see
// deviceNetworkConfig.js/networkVerifier.js for the full rationale. Kept as
// separate control-plane metadata alongside `devices`, not a field on the
// device objects themselves, for the same reason `deviceHealth` below is:
// the device adapter executes deterministic primitives and shouldn't also
// carry control-plane bookkeeping about its own network assignment.
const deviceNetwork = loadDeviceNetworkMap(rawDeviceConfig);
const networkVerifier = createNetworkVerifier({ deviceNetwork });
const networkMaxAgeMs = networkVerificationMaxAge();
const networkDecision = (deviceId, now = new Date()) => networkAccessDecision({
  network: deviceNetwork.get(deviceId),
  status: networkVerifier.getStatus(deviceId),
  now,
  maxAgeMs: networkMaxAgeMs,
});

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
for (const discovered of discoveredIosDevices) {
  if (!deviceHost.has(discovered.id)) deviceHost.set(discovered.id, DEFAULT_HOST_LABEL);
}

// Env-overridable like auditLogPath/sessionStoreDir above, for the same
// reason — tests need an isolated queue file, not the real one under
// storage/queue/.
const queueStorePath = process.env.QUEUE_STORE_PATH || path.join(__dirname, "../../storage/queue/tasks.json");
const taskQueue = createTaskQueue({ devices, deviceLease, auditLog, storePath: queueStorePath, dispatchOnCreate: false,
  canDispatch: (task, deviceId) => {
    const operator = operatorByUsername(task.createdBy);
    return canAccessDevice(operator, deviceId)
      && networkDecision(deviceId).allowed
      && (task.kind !== "research" || !!researchWorkspaceFor(operator, task.accountSelector?.accountId));
  } });
const modelSelectionStorePath = process.env.MODEL_SELECTION_STORE_PATH
  || path.join(__dirname, "../../storage/models/selection.json");
const modelSelection = createModelSelection({ providers, defaultProviderName, storePath: modelSelectionStorePath });
const assignmentStorePath = process.env.ASSIGNMENT_STORE_PATH
  || path.join(__dirname, "../../storage/assignments/assignments.json");
const assignmentStore = createAssignmentStore({ storePath: assignmentStorePath });

function expireAssignments(at = new Date()) {
  const expired = assignmentStore.expireDue(at);
  for (const assignment of expired) {
    auditLog.logEvent({
      operator: "system",
      type: assignment.status === "expired" ? "assignment_expired" : "assignment_recurrence_advanced",
      deviceId: assignment.deviceId,
      detail: {
        assignmentId: assignment.id,
        assignee: assignment.assignee,
        recurrence: assignment.recurrence ?? "once",
        occurrence: assignment.occurrence ?? 1,
      },
    });
  }
  if (expired.length) {
    broadcastDeviceList();
    broadcastPresence();
  }
  return expired;
}

const MANAGER_ASSIGNABLE_ROLES = new Set([
  OPERATOR_ROLES.VA,
  OPERATOR_ROLES.CONTENT_CREATOR,
  OPERATOR_ROLES.EDITOR,
]);

function canManagePerson(operator, username) {
  const target = operators.get(username);
  if (!target) return false;
  if (operator.role === OPERATOR_ROLES.ADMIN) return true;
  return operator.role === OPERATOR_ROLES.MANAGER
    && Boolean(operator.teamId)
    && target.teamId === operator.teamId
    && (username === operator.username || MANAGER_ASSIGNABLE_ROLES.has(target.role));
}

function assignmentScopeAllowed(assignment, operator) {
  if (assignment.deviceId && !canAccessDevice(operator, assignment.deviceId)) return false;
  if (assignment.accountId && !researchWorkspaceFor(operator, assignment.accountId)) return false;
  return true;
}

function assigneeScopeAllowed(assignment, username) {
  const assignee = operatorByUsername(username);
  return Boolean(assignee) && assignmentScopeAllowed(assignment, assignee);
}

function canViewAssignment(assignment, operator) {
  if (assignment.assignee === operator.username || assignment.createdBy === operator.username) {
    return assignmentScopeAllowed(assignment, operator);
  }
  return hasCapability(operator, CAPABILITIES.MANAGE_ASSIGNMENTS)
    && canManagePerson(operator, assignment.assignee)
    && assignmentScopeAllowed(assignment, operator);
}

function validateAssignmentScope(body, operator) {
  const deviceId = body.deviceId ?? null;
  const accountId = body.accountId ?? null;
  if (deviceId !== null) {
    if (typeof deviceId !== "string" || !devices.has(deviceId)) return { error: "unknown device", status: 400 };
    if (!canAccessDevice(operator, deviceId)) return { error: "not authorized for this device", status: 403 };
  }
  if (accountId !== null) {
    if (typeof accountId !== "string" || !researchAccounts.has(accountId)) return { error: "unknown research account", status: 400 };
    if (!researchWorkspaceFor(operator, accountId)) return { error: "not authorized for this research account", status: 403 };
  }
  return { deviceId, accountId };
}

app.get("/api/assignments", requireCapability(CAPABILITIES.VIEW_ASSIGNMENTS), (req, res) => {
  expireAssignments();
  res.json({ assignments: assignmentStore.list().filter(item => canViewAssignment(item, req.currentOperator)) });
});

app.post("/api/assignments", requireCapability(CAPABILITIES.MANAGE_ASSIGNMENTS), (req, res, next) => {
  try {
    expireAssignments();
    const { assignee, instructions } = req.body || {};
    if (typeof assignee !== "string" || !operatorByUsername(assignee)) return res.status(400).json({ error: "unknown or inactive assignee" });
    if (!canManagePerson(req.currentOperator, assignee)) return res.status(403).json({ error: "not authorized to assign this person" });
    const scope = validateAssignmentScope(req.body || {}, req.currentOperator);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    if (!assigneeScopeAllowed(scope, assignee)) {
      return res.status(403).json({ error: "assignee is not authorized for the referenced phone or account" });
    }
    const assignment = assignmentStore.create({
      instructions,
      assignee,
      createdBy: req.currentOperator.username,
      deviceId: scope.deviceId,
      accountId: scope.accountId,
      startAt: req.body?.startAt ?? null,
      endAt: req.body?.endAt ?? null,
      exclusive: req.body?.exclusive ?? true,
      recurrence: req.body?.recurrence ?? "once",
    });
    auditLog.logEvent({ operator: req.currentOperator.username, type: "assignment_created",
      deviceId: assignment.deviceId, detail: {
        assignmentId: assignment.id, assignee: assignment.assignee, accountId: assignment.accountId,
        startAt: assignment.startAt, endAt: assignment.endAt, exclusive: assignment.exclusive,
        recurrence: assignment.recurrence, occurrence: assignment.occurrence,
      } });
    broadcastDeviceList();
    broadcastPresence();
    res.status(201).json({ assignment });
  } catch (error) {
    if (/overlaps/.test(error.message)) return res.status(409).json({ error: error.message });
    if (/instructions|deviceId|accountId|schedule|startAt|endAt|exclusive|recurrence/.test(error.message)) return res.status(400).json({ error: error.message });
    next(error);
  }
});

app.patch("/api/assignments/:assignmentId", requireCapability(CAPABILITIES.VIEW_ASSIGNMENTS), (req, res, next) => {
  try {
    expireAssignments();
    const current = assignmentStore.get(req.params.assignmentId);
    if (!current) return res.status(404).json({ error: "unknown assignment" });
    if (!canViewAssignment(current, req.currentOperator)) return res.status(403).json({ error: "not authorized for this assignment" });
    const hasManage = hasCapability(req.currentOperator, CAPABILITIES.MANAGE_ASSIGNMENTS)
      && canManagePerson(req.currentOperator, current.assignee)
      && assignmentScopeAllowed(current, req.currentOperator);
    const wantsReassign = Object.prototype.hasOwnProperty.call(req.body || {}, "assignee");
    const wantsStatus = Object.prototype.hasOwnProperty.call(req.body || {}, "status");
    const wantsSchedule = ["startAt", "endAt", "exclusive"].some(key => Object.prototype.hasOwnProperty.call(req.body || {}, key));
    if ([wantsReassign, wantsStatus, wantsSchedule].filter(Boolean).length > 1) {
      return res.status(400).json({ error: "change assignee, status, or schedule separately" });
    }
    if (!wantsReassign && !wantsStatus && !wantsSchedule) return res.status(400).json({ error: "status, assignee, or schedule is required" });

    let assignment;
    if (wantsReassign) {
      if (!hasManage) return res.status(403).json({ error: "assignment management capability required" });
      if (typeof req.body.assignee !== "string" || !operatorByUsername(req.body.assignee)) return res.status(400).json({ error: "unknown or inactive assignee" });
      if (!canManagePerson(req.currentOperator, req.body.assignee)) return res.status(403).json({ error: "not authorized to assign this person" });
      if (!assigneeScopeAllowed(current, req.body.assignee)) {
        return res.status(403).json({ error: "assignee is not authorized for the referenced phone or account" });
      }
      assignment = assignmentStore.reassign(current.id, req.body.assignee, req.currentOperator.username);
    } else if (wantsStatus) {
      if (!ASSIGNMENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: "invalid assignment status" });
      const ownVaProgress = req.currentOperator.role === OPERATOR_ROLES.VA
        && current.assignee === req.currentOperator.username
        && ((current.status === "assigned" && req.body.status === "in_progress")
          || (current.status === "in_progress" && req.body.status === "completed"));
      if (!hasManage && !ownVaProgress) return res.status(403).json({ error: "assignment management capability required" });
      assignment = assignmentStore.setStatus(current.id, req.body.status, req.currentOperator.username);
    } else {
      if (!hasManage) return res.status(403).json({ error: "assignment management capability required" });
      assignment = assignmentStore.reschedule(current.id, {
        startAt: Object.hasOwn(req.body, "startAt") ? req.body.startAt : current.startAt ?? null,
        endAt: Object.hasOwn(req.body, "endAt") ? req.body.endAt : current.endAt ?? null,
        exclusive: Object.hasOwn(req.body, "exclusive") ? req.body.exclusive : current.exclusive !== false,
      }, req.currentOperator.username);
    }
    auditLog.logEvent({ operator: req.currentOperator.username, type: "assignment_updated",
      deviceId: assignment.deviceId, detail: { assignmentId: assignment.id, assignee: assignment.assignee, status: assignment.status } });
    broadcastDeviceList();
    broadcastPresence();
    res.json({ assignment });
  } catch (error) {
    if (/cannot move|cannot start|in-progress|terminal|invalid assignment|overlaps/.test(error.message)) return res.status(409).json({ error: error.message });
    if (/schedule|startAt|endAt|exclusive|recurrence/.test(error.message)) return res.status(400).json({ error: error.message });
    next(error);
  }
});
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
  operatorForUsername: operatorByUsername,
  workspaceForOperatorAccount: researchWorkspaceFor,
  canUseDevice: (deviceId) => networkDecision(deviceId).allowed,
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

const humanOwners = new Map(); // device id -> owning WebSocket; independent of health

function relevantAssignment(deviceId) {
  return assignmentStore.list()
    .filter(item => item.deviceId === deviceId && ["assigned", "in_progress"].includes(item.status))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "in_progress" ? -1 : 1;
      return (a.startAt ?? a.createdAt).localeCompare(b.startAt ?? b.createdAt);
    })[0] ?? null;
}

function deviceOpenDecision(d, viewer, viewerSocket = null) {
  const assignedToViewer = canAccessDevice(viewer, d.id);
  if (!viewer || !hasCapability(viewer, CAPABILITIES.VIEW_FLEET)) {
    return { assignedToViewer: false, canOpen: false, accessState: "fleet_hidden", openReason: "Fleet access is not permitted for this role." };
  }
  if (!assignedToViewer) {
    return { assignedToViewer: false, canOpen: false, accessState: "not_assigned", openReason: "This phone is not assigned to you." };
  }
  if (!hasCapability(viewer, CAPABILITIES.CONTROL_DEVICE)) {
    return { assignedToViewer: true, canOpen: false, accessState: "role_read_only", openReason: "Your role can view this phone but cannot control it." };
  }
  if (d.discoveryState === "detected_unconfigured") {
    return { assignedToViewer: true, canOpen: false, accessState: "wda_unconfigured", openReason: "Detected on this Mac. Configure its WDA tunnel before opening it." };
  }
  if (d.status === "offline") {
    return { assignedToViewer: true, canOpen: false, accessState: "offline", openReason: "This assigned phone is offline." };
  }
  const networkAccess = networkDecision(d.id);
  if (!networkAccess.allowed) {
    return { assignedToViewer: true, canOpen: false, accessState: networkAccess.state, openReason: networkAccess.reason };
  }
  if (deviceLease.getMode(d.id) !== "HUMAN") {
    return { assignedToViewer: true, canOpen: false, accessState: "ai_controlled", openReason: "An authorized operations user must return this phone to Human mode." };
  }
  const owner = humanOwners.get(d.id);
  if (owner && owner !== viewerSocket) {
    return { assignedToViewer: true, canOpen: false, accessState: "in_use", openReason: "This assigned phone is already in use." };
  }
  if (d.status === "in-use" && owner !== viewerSocket) {
    return { assignedToViewer: true, canOpen: false, accessState: "in_use", openReason: "This assigned phone is already in use." };
  }
  if (!deviceLease.canHumanSelect(d.id)) {
    return { assignedToViewer: true, canOpen: false, accessState: "unavailable", openReason: "This phone is not available for human control." };
  }
  if (owner === viewerSocket) {
    return { assignedToViewer: true, canOpen: true, accessState: "assigned_in_use_by_you", openReason: "You currently control this phone." };
  }
  if (d.status !== "idle") {
    return { assignedToViewer: true, canOpen: false, accessState: "unavailable", openReason: "This assigned phone is not currently available." };
  }
  return { assignedToViewer: true, canOpen: true, accessState: "assigned_available", openReason: "Assigned to you and available." };
}

function deviceWatchDecision(d, viewer, viewerSocket = null) {
  if (!viewer || !hasCapability(viewer, CAPABILITIES.MONITOR_DEVICE)) {
    return { canWatch: false, watchState: "role_not_permitted", watchReason: "Live watching is available to authorized Admins and Managers." };
  }
  if (!canAccessDevice(viewer, d.id)) {
    return { canWatch: false, watchState: "device_not_permitted", watchReason: "This phone is outside your device access." };
  }
  const monitor = runtimeMonitorState(d.id);
  if (!monitor.available) {
    return { canWatch: false, watchState: "monitor_unavailable", watchReason: monitor.reason };
  }
  const controllerMode = deviceLease.getMode(d.id);
  if (controllerMode !== "HUMAN") {
    if (!hasCapability(viewer, CAPABILITIES.MANAGE_AI_CONTROLLER)) {
      return { canWatch: false, watchState: "ai_not_permitted", watchReason: "AI device inspection is not permitted for this role." };
    }
    if (d.status === "offline") {
      return { canWatch: false, watchState: "offline", watchReason: "This AI-controlled phone is offline." };
    }
    return { canWatch: true, watchState: "ai_read_only", watchReason: "Open this AI-controlled phone in a read-only command workspace." };
  }
  const ownerSocket = humanOwners.get(d.id);
  const owner = ownerSocket?.currentOperator?.() ?? null;
  if (!ownerSocket || !owner || d.status !== "in-use") {
    return { canWatch: false, watchState: "not_in_use", watchReason: "No VA is currently operating this phone." };
  }
  if (ownerSocket === viewerSocket) {
    return { canWatch: false, watchState: "own_session", watchReason: "You are operating this phone." };
  }
  if (owner.role !== OPERATOR_ROLES.VA) {
    return { canWatch: false, watchState: "operator_not_va", watchReason: "The active operator is not a VA." };
  }
  if (viewer.role === OPERATOR_ROLES.MANAGER && !canManagePerson(viewer, owner.username)) {
    return { canWatch: false, watchState: "outside_team", watchReason: "This VA is outside your team." };
  }
  return { canWatch: true, watchState: "va_active", watchReason: `Watch ${owner.username}'s read-only live screen.` };
}

const summary = (d, viewer = null, viewerSocket = null) => {
  const assignment = relevantAssignment(d.id);
  const mayManageAssignments = hasCapability(viewer, CAPABILITIES.MANAGE_ASSIGNMENTS);
  const mayManageAccess = hasCapability(viewer, CAPABILITIES.MANAGE_ACCESS);
  const mayAccessMedia = Boolean(viewer && hasCapability(viewer, CAPABILITIES.ACCESS_MEDIA)
    && canAccessDevice(viewer, d.id));
  return {
    id: d.id,
    label: d.label,
    status: d.status,
    discoveryState: d.discoveryState ?? null,
    hostLabel: deviceHost.get(d.id) ?? DEFAULT_HOST_LABEL,
    ...getHealth(d.id),
    controllerMode: deviceLease.getMode(d.id),
    currentOperator: humanOwners.get(d.id)?.operatorUsername ?? null,
    ...deviceOpenDecision(d, viewer, viewerSocket),
    ...deviceWatchDecision(d, viewer, viewerSocket),
    mediaActions: {
      list: mayAccessMedia,
      download: mayAccessMedia,
      upload: mayAccessMedia,
      delete: mayAccessMedia,
    },
    assignment: assignment && mayManageAssignments && canViewAssignment(assignment, viewer) ? {
      id: assignment.id,
      assignee: assignment.assignee,
      status: assignment.status,
      startAt: assignment.startAt ?? null,
      endAt: assignment.endAt ?? null,
      exclusive: assignment.exclusive !== false,
      recurrence: assignment.recurrence ?? "once",
      occurrence: assignment.occurrence ?? 1,
    } : null,
    authorizedOperators: mayManageAccess ? [...operators.values()]
      .filter(operator => operator.active !== false && canAccessDevice(operator, d.id))
      .map(operator => ({ username: operator.username, role: operator.role }))
      .sort((a, b) => a.username.localeCompare(b.username)) : [],
    monitor: runtimeMonitorState(d.id),
    network: publicNetworkConfig(deviceNetwork.get(d.id)),
    ...networkVerifier.getStatus(d.id),
  };
};
const knownDevice = (id) => devices.has(id);

app.get("/api/devices/:deviceId/monitor", (req, res) => {
  if (!hasCapability(req.currentOperator, CAPABILITIES.MONITOR_DEVICE)) {
    return res.status(403).json({ error: "monitoring is not permitted for this role" });
  }
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  res.json({ monitor: runtimeMonitorState(req.params.deviceId) });
});

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
const mediaQuota = createMediaQuotaManager({
  mediaRoot: path.join(path.resolve(process.env.FILE_STORE_DIR || path.join(__dirname, "../../storage")), "devices"),
  perDeviceBytes: mediaByteSetting("MEDIA_DEVICE_QUOTA_BYTES", DEFAULT_DEVICE_MEDIA_QUOTA_BYTES),
  globalBytes: mediaByteSetting("MEDIA_GLOBAL_QUOTA_BYTES", DEFAULT_GLOBAL_MEDIA_QUOTA_BYTES),
  minFreeBytes: mediaByteSetting("MEDIA_MIN_FREE_BYTES", DEFAULT_MEDIA_MIN_FREE_BYTES),
});
const upload = multer({
  storage: createQuotaStorage({ ensureDeviceDir, safeFilename, quotaManager: mediaQuota }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB — generous for source video
});

// requireAuth (above) already guarantees req.currentOperator exists here
// (freshly re-resolved from the live registry, not the stale session
// snapshot — see requireAuth's own comment); each check below only asks
// whether THAT operator may reach THIS device.
app.get("/api/devices/:deviceId/files", (req, res) => {
  if (!hasCapability(req.currentOperator, CAPABILITIES.ACCESS_MEDIA)) return res.status(403).json({ error: "media access is not permitted for this role" });
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  res.json({ files: listFiles(req.params.deviceId) });
});

app.post("/api/devices/:deviceId/files", (req, res, next) => {
  if (!hasCapability(req.currentOperator, CAPABILITIES.ACCESS_MEDIA)) return res.status(403).json({ error: "media access is not permitted for this role" });
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  next();
}, upload.single("file"), (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: "no file, or invalid filename" });
  const name = safeFilename(req.file.originalname);
  try {
    if (!name) throw new Error("invalid filename");
    // Same-directory rename commits only a fully validated multipart upload.
    // A failed replacement preserves the old file; never unlink it first.
    fs.renameSync(req.file.path, path.join(req.file.destination, name));
    mediaQuota.commit(req.file.quotaReservation);
  } catch (error) {
    mediaQuota.abort(req.file.quotaReservation);
    fs.rmSync(req.file.path, { force: true });
    return next(error);
  }
  auditLog.logEvent({
    operator: req.session.operator.username,
    type: "file_uploaded",
    deviceId: req.params.deviceId,
    detail: withNetworkEgress(req.params.deviceId, { name, size: req.file.size }),
  });
  res.json({ ok: true, name, size: req.file.size });
});

app.get("/api/devices/:deviceId/files/:filename", (req, res) => {
  if (!hasCapability(req.currentOperator, CAPABILITIES.ACCESS_MEDIA)) return res.status(403).end();
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
  if (!hasCapability(req.currentOperator, CAPABILITIES.ACCESS_MEDIA)) return res.status(403).end();
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

// Production checks use the server-side configured URL. Tests may opt into a
// disposable caller URL explicitly; accepting arbitrary URLs in normal mode
// would turn this privileged feature into a server-side request forgery path.
app.post("/api/devices/:deviceId/network-check", (req, res) => {
  if (!hasCapability(req.currentOperator, CAPABILITIES.RUN_NETWORK_CHECK)) {
    return res.status(403).json({ error: "network verification is not permitted for this role" });
  }
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  const configuredNetwork = deviceNetwork.get(req.params.deviceId);
  if (isProxyEgress(configuredNetwork?.egress) && configuredNetwork?.enabled === false) {
    return res.status(409).json({ error: "network verification is unavailable while this proxy assignment is disabled" });
  }
  const overrideAllowed = process.env.ALLOW_NETWORK_CHECK_URL_OVERRIDE === "true";
  if (req.body?.checkUrl && !overrideAllowed) {
    return res.status(400).json({ error: "caller-supplied checkUrl is disabled" });
  }
  const checkUrl = overrideAllowed && req.body?.checkUrl ? req.body.checkUrl : configuredNetwork?.checkUrl;
  if (typeof checkUrl !== "string" || checkUrl.length === 0) {
    return res.status(409).json({ error: "network verification endpoint is not configured" });
  }
  networkVerifier
    .checkDevice(req.params.deviceId, checkUrl)
    .then((result) => {
      const access = networkDecision(req.params.deviceId);
      if (!access.allowed) {
        taskQueue.stopDevice(req.params.deviceId, "network_policy");
        for (const client of wss.clients) client.releaseUnauthorizedSelection?.("network_policy");
      } else {
        taskQueue.tick(new Date());
      }
      broadcastDeviceList();
      // A network probe may take seconds. Resolve the current account again
      // after that await and before returning IP/region/health data or writing
      // requester-attributed audit detail. A stale request snapshot is not
      // authority to receive the result.
      const current = resolveOperator(req.session?.operator);
      if (!current) return res.status(401).json({ error: "authentication required" });
      if (!hasCapability(current, CAPABILITIES.RUN_NETWORK_CHECK)) {
        return res.status(403).json({ error: "network verification is not permitted for this role" });
      }
      if (!canAccessDevice(current, req.params.deviceId)) {
        return res.status(403).json({ error: "not authorized for this device" });
      }
      auditLog.logEvent({
        operator: current.username,
        type: "network_check",
        deviceId: req.params.deviceId,
        detail: withNetworkEgress(req.params.deviceId, {
          observedIp: result.networkObservedIp,
          verified: result.networkVerified,
          mismatch: result.networkMismatch,
          mismatchReason: result.networkMismatchReason,
        }),
      });
      res.json({ network: { ...(publicNetworkConfig(configuredNetwork) ?? {}), ...result } });
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

app.patch("/api/admin/devices/:deviceId/proxy", requireCapability(CAPABILITIES.MANAGE_PROXY), (req, res, next) => {
  try {
    if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
    if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
      return res.status(403).json({ error: "not authorized for this device" });
    }
    const network = setDeviceProxyEnabled({
      configPath,
      deviceId: req.params.deviceId,
      enabled: req.body?.enabled,
    });
    deviceNetwork.set(req.params.deviceId, network);
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "proxy_setting_changed",
      deviceId: req.params.deviceId,
      detail: { enabled: network.enabled, networkEgress: network.egress },
    });
    broadcastDeviceList();
    res.json({ network: publicNetworkConfig(network) });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

// AI research findings (the /cresearch command's output). One account =
// one model's content research history. No screenshots — url + metadata,
// per direction. The candidate list is what a VA reviews afterward:
// PATCH a candidate to "confirmed" or "removed". Nothing here ever touches
// the platform itself — this is purely our own record of what was found.
app.get("/api/research", (req, res) => {
  if (!hasCapability(req.currentOperator, CAPABILITIES.VIEW_RESEARCH)) return res.status(403).json({ error: "research access is not permitted for this role" });
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
  if (!hasCapability(req.currentOperator, CAPABILITIES.VIEW_RESEARCH)) return res.status(403).json({ error: "research access is not permitted for this role" });
  const evidence = resolveResearchEvidence(req.researchWorkspaceId, req.params.account, req.params.evidenceId);
  if (!evidence) return res.status(404).json({ error: "evidence not found" });
  res.type(evidence.mime).sendFile(evidence.file);
});

app.get("/api/research/:account/runs", (req, res) => {
  if (!hasCapability(req.currentOperator, CAPABILITIES.VIEW_RESEARCH)) return res.status(403).json({ error: "research access is not permitted for this role" });
  const runs = listRuns(req.researchWorkspaceId, req.params.account);
  if (runs === null) return res.status(404).json({ error: "unknown account" });
  res.json({ runs });
});

app.get("/api/research/:account/runs/:runId", (req, res) => {
  if (!hasCapability(req.currentOperator, CAPABILITIES.VIEW_RESEARCH)) return res.status(403).json({ error: "research access is not permitted for this role" });
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
  if (!hasCapability(req.currentOperator, CAPABILITIES.OPERATE_RESEARCH)) return res.status(403).json({ error: "research operation is not permitted for this role" });
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
  if (!hasCapability(req.currentOperator, CAPABILITIES.REVIEW_RESEARCH)) return res.status(403).json({ error: "research review is not permitted for this role" });
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

function taskAccessError(taskId, operator) {
  const task = taskQueue.getTask(taskId);
  if (!task) return "unknown task";
  const id = task.deviceSelector?.deviceId;
  const allowed = task.deviceSelector?.allowedDeviceIds;
  if (id ? !canAccessDevice(operator, id)
    : Array.isArray(allowed) ? allowed.some(device => !canAccessDevice(operator, device))
      : operator.allowedDevices !== null && operator.allowedDevices !== undefined) {
    return "not authorized for that task's device";
  }
  const account = task.accountSelector?.accountId;
  if (account && !researchWorkspaceFor(operator, account)) return "not authorized for that research account";
  return null;
}

function scopeWorkspaceCommand(parsed, deviceId) {
  if (!deviceId || parsed.error) return parsed;
  if (["time", "cresearch", "natural_language"].includes(parsed.type)) return parsed;
  if (parsed.type === "queue_add") return parsed;
  if (["mode", "ai_pause", "ai_resume", "ai_stop", "device_health"].includes(parsed.type)) {
    if (parsed.deviceId && parsed.deviceId !== deviceId) {
      return { error: "a device workspace command cannot target another phone" };
    }
    return { ...parsed, deviceId };
  }
  return { error: "that command is not available inside a device workspace" };
}

async function executeCommand(parsed, operator, workspaceDeviceId = null) {
  parsed = scopeWorkspaceCommand(parsed, workspaceDeviceId);
  if (parsed.error) return { error: parsed.error };

  switch (parsed.type) {
    case "natural_language":
      // MS7.1.3: proposed only, never silently queued (COMMAND_QUEUE_SPEC.md
      // §12) — turning this into a real TaskSpec is the model layer's job
      // (docs/CODING_ROADMAP.md MS8), not this parser's.
      return {
        proposed: { goal: parsed.goal },
        note: "Natural-language goals are proposed only — use /cresearch to queue supported research work.",
      };

    case "time":
      // The scheduler must never grant a device lease to work that has no
      // executor. Generic /time tasks are parsed for forward compatibility,
      // but only research tasks have a registered production worker today.
      return {
        error: "General scheduled tasks are not available yet. Use /cresearch for supported research work.",
      };

    case "cresearch": {
      const resolvedAccount = resolveResearchAccountSelector(parsed.accountSelector, operator);
      if (resolvedAccount.error) return resolvedAccount;
      const task = taskQueue.addTask({
        kind: "research",
        goal: parsed.goal,
        // A restricted admin may use the queue, but the scheduler must still
        // obey that operator's device allow-list. An unrestricted operator
        // leaves this selector open exactly as before.
        deviceSelector: workspaceDeviceId
          ? { deviceId: workspaceDeviceId }
          : operator.allowedDevices
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
      return executeCommand(inner, operator, workspaceDeviceId);
    }

    case "queue_list":
      return { tasks: taskQueue.listTasks().filter(task => !taskAccessError(task.id, operator)) };

    case "queue_pause":
      if (!hasCapability(operator, CAPABILITIES.MANAGE_GLOBAL_QUEUE)) {
        return { error: "global queue control requires an administrator", status: 403 };
      }
      taskQueue.pauseQueue();
      return { ok: true, paused: true };

    case "queue_resume":
      if (!hasCapability(operator, CAPABILITIES.MANAGE_GLOBAL_QUEUE)) {
        return { error: "global queue control requires an administrator", status: 403 };
      }
      taskQueue.resumeQueue();
      return { ok: true, paused: false };

    case "queue_cancel": {
      const denied = taskAccessError(parsed.taskId, operator);
      if (denied) return { error: denied };
      const task = taskQueue.cancelTask(parsed.taskId);
      return task ? { task } : { error: "unknown task" };
    }

    case "queue_move": {
      const denied = taskAccessError(parsed.taskId, operator);
      if (denied) return { error: denied };
      const targetDenied = taskAccessError(parsed.targetId, operator);
      if (targetDenied) return { error: targetDenied };
      const ok = taskQueue.moveTask(parsed.taskId, parsed.relation, parsed.targetId);
      return ok ? { ok: true } : { error: "unknown task id(s)" };
    }

    case "queue_priority": {
      const denied = taskAccessError(parsed.taskId, operator);
      if (denied) return { error: denied };
      const task = taskQueue.setPriority(parsed.taskId, parsed.priority);
      return task ? { task } : { error: "unknown task" };
    }

    case "model_list":
      return modelSelection.describe();

    case "model_set": {
      if (!hasCapability(operator, CAPABILITIES.MANAGE_MODELS)) {
        return { error: "model configuration requires an administrator", status: 403 };
      }
      if (parsed.scope === "device") {
        const denied = deviceAccessError(parsed.scopeId, operator);
        if (denied) return { error: denied };
      }
      if (parsed.scope === "workspace"
        && !operator.allowedResearchWorkspaces?.includes(parsed.scopeId)) {
        return { error: "not authorized for that research workspace" };
      }
      if (parsed.scope === "task") {
        const denied = taskAccessError(parsed.scopeId, operator);
        if (denied) return { error: denied };
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

    // Read-only operational health still obeys the operator's device grants.
    case "device_health": {
      if (parsed.deviceId) {
        if (!devices.has(parsed.deviceId)) return { error: "unknown device" };
        if (!canAccessDevice(operator, parsed.deviceId)) return { error: "not authorized for this device" };
        return { health: summary(devices.get(parsed.deviceId), operator) };
      }
      return { health: [...devices.values()].filter(device => canAccessDevice(operator, device.id))
        .map(device => summary(device, operator)) };
    }

    case "audit": {
      if (!hasCapability(operator, CAPABILITIES.VIEW_AUDIT)) {
        return { error: "sensitive audit access requires an administrator", status: 403 };
      }
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
        if (humanOwners.has(target.id) || target.status !== "idle") {
          return { error: `${target.label} must be idle before switching it to AI mode.` };
        }
        try {
          deviceLease.switchToAI(parsed.deviceId);
          taskQueue.allowAiDispatch(parsed.deviceId);
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

app.post("/api/queue/command", requireCapability(CAPABILITIES.MANAGE_QUEUE), async (req, res, next) => {
  try {
    const text = req.body?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "text is required" });
    }
    const workspaceDeviceId = req.body?.deviceId ?? null;
    if (workspaceDeviceId !== null) {
      if (typeof workspaceDeviceId !== "string" || !devices.has(workspaceDeviceId)) {
        return res.status(400).json({ error: "a valid deviceId is required for a device workspace command" });
      }
      const decision = deviceWatchDecision(devices.get(workspaceDeviceId), req.currentOperator);
      if (!decision.canWatch || decision.watchState !== "ai_read_only") {
        auditLog.logEvent({ operator: req.currentOperator.username, type: "device_workspace_command_denied",
          deviceId: workspaceDeviceId, detail: { reason: decision.watchState } });
        return res.status(403).json({ error: decision.watchReason });
      }
    }
    const parsed = parseCommand(text);
    const result = await executeCommand(parsed, req.currentOperator, workspaceDeviceId);
    res.status(result.status ?? (result.error ? 400 : 200)).json(result);
  } catch (error) { next(error); }
});

app.get("/api/queue", requireCapability(CAPABILITIES.MANAGE_QUEUE), (req, res) => {
  res.json({ tasks: taskQueue.listTasks().filter(task => !taskAccessError(task.id, req.currentOperator)), paused: taskQueue.isPaused() });
});

// Without this, a multer failure (oversized file, invalid filename/device id
// from the storage callbacks) falls through to Express's default HTML error
// page instead of the JSON the client expects.
app.use((err, req, res, next) => {
  if (!err) return next();
  const message = err.code === "LIMIT_FILE_SIZE" ? "file too large" : err.message || "upload failed";
  const status = err.code === "LIMIT_FILE_SIZE" ? 413 : err.statusCode ?? 400;
  res.status(status).json({ error: message,
    ...(err.code?.startsWith("MEDIA_") ? { code: err.code, ...err.detail } : {}) });
});

function broadcastDeviceList() {
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    client.releaseUnauthorizedWatch?.("fleet_updated");
    const operator = client.currentOperator?.();
    const visibleDevices = operator && hasCapability(operator, CAPABILITIES.VIEW_FLEET)
      ? [...devices.values()].map(device => summary(device, operator, client))
      : [];
    client.send(JSON.stringify({ type: "device_list", devices: visibleDevices }));
  }
}

function runtimeMonitorState(deviceId) {
  const configured = deviceMonitorConfig.get(deviceId)
    ?? { adapter: "unconfigured", physicallyValidated: false };
  let activeViewers = 0;
  for (const client of wss.clients) if (client.watchedDeviceId === deviceId) activeViewers++;
  return monitorState({ ...configured, activeViewers });
}

function broadcastPresence() {
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    client.send(JSON.stringify({ type: "presence_list", people: publicPeople(client.currentOperator?.()) }));
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
    void ws.validateSession();
    ws.isAlive = false;
    ws.ping();
  }
  if (presenceStore.cleanup()) broadcastPresence();
}, HEARTBEAT_INTERVAL_MS);
wss.on("close", () => clearInterval(heartbeatTimer));

wss.on("connection", (ws, request) => {
  // Protocol/payload failures are connection-local. An unhandled EventEmitter
  // error would otherwise terminate the entire relay.
  ws.on("error", () => ws.terminate());
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
  ws.sessionId = request.sessionID;
  ws.operatorUsername = operator.username;
  ws.presenceConnectionId = randomUUID();
  let sessionActive = true;
  let expiresAt = Date.parse(request.session.cookie.expires);
  presenceStore.connect({
    sessionId: ws.sessionId,
    connectionId: ws.presenceConnectionId,
    username: operator.username,
    expiresAt,
  });
  ws.invalidateSession = () => {
    sessionActive = false;
    ws.close(1008, "Session is no longer active");
  };
  ws.validateSession = () => new Promise(resolve => {
    if (!sessionActive || ws.readyState !== ws.OPEN) return resolve(false);
    sessionStore.get(ws.sessionId, (error, stored) => {
      const expiry = Date.parse(stored?.cookie?.expires);
      if (error || !sessionActive || stored?.operator?.username !== operator.username
        || !Number.isFinite(expiry) || expiry <= Date.now()) {
        ws.invalidateSession();
        return resolve(false);
      }
      expiresAt = expiry;
      presenceStore.touchSession({ sessionId: ws.sessionId, username: operator.username, expiresAt });
      resolve(ws.readyState === ws.OPEN);
    });
  });
  const currentOperator = () => sessionActive && expiresAt > Date.now() ? resolveOperator(operator) : null;
  ws.currentOperator = currentOperator;

  // Direct WebSocket mode-management messages are admin/dev controls just
  // like the HTTP command console. Device RBAC still applies after this
  // feature-role gate, so admin does not imply access to every phone.
  const requireAiManagerWs = (deviceId, action) => {
    if (hasCapability(currentOperator(), CAPABILITIES.MANAGE_AI_CONTROLLER)) return true;
    auditLog.logEvent({
      operator: operator.username,
      type: "capability_access_denied",
      deviceId: deviceId ?? null,
      detail: { action, capability: CAPABILITIES.MANAGE_AI_CONTROLLER },
    });
    ws.send(JSON.stringify({
      type: "error",
      deviceId: deviceId ?? undefined,
      message: "AI-controller management capability required.",
    }));
    return false;
  };

  let selected = null;
  let watched = null;
  const releaseSelection = () => {
    if (selected && humanOwners.get(selected.id) === ws) {
      humanOwners.delete(selected.id);
      releaseDevice(selected);
    }
    selected = null;
    presenceStore.setDevice(ws.presenceConnectionId, null);
  };
  const selectedAccessActive = (target = selected) => Boolean(target)
    && hasCapability(currentOperator(), CAPABILITIES.CONTROL_DEVICE)
    && canAccessDevice(currentOperator(), target.id)
    && humanOwners.get(target.id) === ws
    && deviceLease.canHumanSelect(target.id)
    && networkDecision(target.id).allowed;
  const revokeSelectedAccess = (action) => {
    if (!selected) return;
    const revokedId = selected.id;
    auditLog.logEvent({ operator: operator.username, type: "device_access_revoked", deviceId: revokedId,
      detail: { action } });
    releaseSelection();
    broadcastDeviceList();
    broadcastPresence();
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", code: "device_access_revoked", deviceId: revokedId,
        message: "Your access to this phone is no longer active. It has been released." }));
    }
  };
  ws.releaseUnauthorizedSelection = (action = "operator_updated") => {
    if (!selected || selectedAccessActive(selected)) return false;
    revokeSelectedAccess(action);
    return true;
  };
  const watchAccessActive = (target = watched) => Boolean(target)
    && deviceWatchDecision(target, currentOperator(), ws).canWatch;
  const clearWatch = (action = "stopped", { notify = false } = {}) => {
    if (!watched) return false;
    const watchedId = watched.id;
    watched = null;
    ws.watchedDeviceId = null;
    auditLog.logEvent({ operator: operator.username, type: "device_watch_stopped", deviceId: watchedId,
      detail: { action } });
    if (notify && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "watch_stopped", deviceId: watchedId,
        message: "This read-only device session is no longer available." }));
    }
    return true;
  };
  ws.releaseUnauthorizedWatch = (action = "operator_updated") => {
    if (!watched || watchAccessActive(watched)) return false;
    return clearWatch(action, { notify: true });
  };
  ws.deliverWatchedFrame = async (target, frame) => {
    if (watched !== target || ws.readyState !== ws.OPEN) return;
    if (!await ws.validateSession()) return;
    if (watched !== target || !watchAccessActive(target)) {
      clearWatch("frame_delivery", { notify: true });
      return;
    }
    ws.send(JSON.stringify({ type: "watch_frame", deviceId: target.id,
      operator: humanOwners.get(target.id)?.operatorUsername ?? null, ...frame }));
  };
  const claimConflict = (target) => {
    if (!humanOwners.has(target.id) || humanOwners.get(target.id) === ws) return false;
    ws.send(JSON.stringify({ type: "error", deviceId: target.id,
      message: `${target.label} is already in use by another VA.` }));
    return true;
  };
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
    presenceStore.heartbeat(ws.presenceConnectionId);
  });

  const initialViewer = currentOperator();
  ws.send(JSON.stringify({ type: "operator_profile", operator: publicOperator(initialViewer) }));
  ws.send(JSON.stringify({ type: "device_list", devices: initialViewer
    && hasCapability(initialViewer, CAPABILITIES.VIEW_FLEET)
    ? [...devices.values()].map(device => summary(device, initialViewer, ws)) : [] }));
  broadcastPresence();

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
        const offlineId = selected.id;
        selected.status = "offline";
        auditLog.logEvent({ operator: operator.username, type: "device_became_offline", deviceId: offlineId,
          detail: { consecutiveFailures: failures } });
        releaseSelection();
        broadcastDeviceList();
        broadcastPresence();
      }
    }
  };

  const sendFrame = async () => {
    if (!selected || ws.readyState !== ws.OPEN) return;
    const target = selected;
    if (!await ws.validateSession()) return;
    if (selected !== target || !selectedAccessActive(target)) {
      revokeSelectedAccess("render");
      return;
    }
    try {
      const frame = await target.render();
      if (!await ws.validateSession()) return;
      if (selected !== target || !selectedAccessActive(target)) {
        revokeSelectedAccess("render_result");
        return;
      }
      const recovered = recordSuccess(target.id);
      // Health fields (lastSeenAt/consecutiveFailures) update on every
      // success without a broadcast — that's a lot of noise to push to every
      // connected VA for every tap. Only broadcast when status itself
      // actually changes, matching how every other status transition here
      // already only broadcasts on real change, not on every action.
      if (recovered && target.status === "offline") {
        target.status = "in-use";
        broadcastDeviceList();
      }
      ws.send(JSON.stringify({ type: "frame", deviceId: target.id, ...frame }));
      for (const client of wss.clients) {
        if (client === ws) continue;
        const delivery = client.deliverWatchedFrame?.(target, frame);
        delivery?.catch?.(() => {});
      }
    } catch (err) {
      reportError(`Couldn't reach ${target.label}: ${err.message}`);
    }
  };

  // Shared by select_device's success path and takeover's post-handoff
  // claim — releasing whatever this connection had before, then claiming
  // `target` for it, sending a frame, and telling everyone else.
  const claimDevice = async (target) => {
    if (!await ws.validateSession()) return;
    const decision = deviceOpenDecision(target, currentOperator(), ws);
    if (!decision.canOpen) {
      auditLog.logEvent({ operator: operator.username, type: "device_select_denied", deviceId: target.id,
        detail: { reason: decision.accessState } });
      ws.send(JSON.stringify({ type: "error", code: "device_open_denied", deviceId: target.id, message: decision.openReason }));
      return;
    }
    if (claimConflict(target)) return;
    if (watched) clearWatch("claimed_device");
    releaseSelection();
    selected = target;
    humanOwners.set(target.id, ws);
    presenceStore.setDevice(ws.presenceConnectionId, target.id);
    selected.status = "in-use";
    auditLog.logEvent({
      operator: operator.username,
      type: "device_selected",
      deviceId: selected.id,
      detail: withNetworkEgress(selected.id),
    });
    await sendFrame();
    broadcastDeviceList();
    broadcastPresence();
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

  const handleMessage = async (raw) => {
    if (!await ws.validateSession()) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (["pause", "resume", "stop", "pause_task", "resume_task", "stop_task"].includes(msg.type)) {
      if (!hasCapability(currentOperator(), CAPABILITIES.MANAGE_QUEUE)) {
        auditLog.logEvent({ operator: operator.username, type: "capability_access_denied",
          deviceId: msg.deviceId ?? null, detail: { action: msg.type, capability: CAPABILITIES.MANAGE_QUEUE } });
        ws.send(JSON.stringify({ type: "error", code: "capability_denied", deviceId: msg.deviceId,
          message: "Queue management capability required." }));
        return;
      }
      ws.send(JSON.stringify({ type: "error", code: "unsupported_message", deviceId: msg.deviceId,
        message: "Use the Operations command console for queue management." }));
      return;
    }

    if (msg.type === "select_device") {
      const target = devices.get(msg.deviceId) || null;
      if (!target) {
        ws.send(JSON.stringify({ type: "error", deviceId: msg.deviceId, message: "Unknown device." }));
        return;
      }
      const decision = deviceOpenDecision(target, currentOperator(), ws);
      if (!decision.canOpen) {
        auditLog.logEvent({ operator: operator.username, type: "device_select_denied", deviceId: msg.deviceId,
          detail: { reason: decision.accessState } });
        ws.send(JSON.stringify({
          type: "error",
          code: "device_open_denied",
          deviceId: msg.deviceId,
          message: decision.openReason,
        }));
        return;
      }
      await claimDevice(target);
      return;
    }

    if (msg.type === "watch_device") {
      const target = devices.get(msg.deviceId) || null;
      if (!target) {
        ws.send(JSON.stringify({ type: "error", code: "watch_denied", deviceId: msg.deviceId, message: "Unknown device." }));
        return;
      }
      if (selected) {
        ws.send(JSON.stringify({ type: "error", code: "watch_denied", deviceId: target.id,
          message: "Release the phone you control before watching another VA." }));
        return;
      }
      const decision = deviceWatchDecision(target, currentOperator(), ws);
      if (!decision.canWatch) {
        auditLog.logEvent({ operator: operator.username, type: "device_watch_denied", deviceId: target.id,
          detail: { reason: decision.watchState } });
        ws.send(JSON.stringify({ type: "error", code: "watch_denied", deviceId: target.id, message: decision.watchReason }));
        return;
      }
      if (watched && watched !== target) clearWatch("switched_device");
      watched = target;
      ws.watchedDeviceId = target.id;
      auditLog.logEvent({ operator: operator.username, type: "device_watch_started", deviceId: target.id,
        detail: { activeOperator: humanOwners.get(target.id)?.operatorUsername ?? null, watchState: decision.watchState } });
      ws.send(JSON.stringify({ type: "watch_started", deviceId: target.id,
        operator: humanOwners.get(target.id)?.operatorUsername ?? null, watchState: decision.watchState }));
      try {
        const frame = await target.render();
        if (!await ws.validateSession()) return;
        if (watched !== target || !watchAccessActive(target)) {
          clearWatch("initial_render", { notify: true });
          return;
        }
        await ws.deliverWatchedFrame(target, frame);
      } catch (error) {
        clearWatch("render_failed");
        ws.send(JSON.stringify({ type: "error", code: "watch_start_failed", deviceId: target.id,
          message: `Could not load the live screen: ${error.message}` }));
      }
      return;
    }

    if (msg.type === "refresh_watch") {
      if (!watched || msg.deviceId !== watched.id) {
        ws.send(JSON.stringify({ type: "error", code: "watch_denied", deviceId: msg.deviceId,
          message: "No matching live watch session is active." }));
        return;
      }
      if (!watchAccessActive(watched)) {
        clearWatch("refresh", { notify: true });
        return;
      }
      const target = watched;
      try {
        const frame = await target.render();
        if (!await ws.validateSession()) return;
        await ws.deliverWatchedFrame(target, frame);
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", code: "watch_refresh_failed", deviceId: target.id,
          message: `Could not refresh the live screen: ${error.message}` }));
      }
      return;
    }

    if (msg.type === "stop_watching") {
      if (watched && (msg.deviceId === undefined || msg.deviceId === watched.id)) clearWatch("viewer_stopped");
      return;
    }

    // Human/AI mode switching (Architecture Baseline.md §3-4). Switching to
    // AI mode moves the device to AI_IDLE; the scheduler acquires it only
    // when an eligible task is ready.
    if (msg.type === "switch_to_ai") {
      if (!requireAiManagerWs(msg.deviceId, "switch_to_ai")) return;
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
      if (humanOwners.has(target.id) || target.status !== "idle") {
        ws.send(JSON.stringify({
          type: "error",
          deviceId: msg.deviceId,
          message: `${target.label} must be idle before switching it to AI mode.`,
        }));
        return;
      }
      try {
        deviceLease.switchToAI(msg.deviceId);
        taskQueue.allowAiDispatch(msg.deviceId);
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
      if (!requireAiManagerWs(msg.deviceId, "takeover")) return;
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
      if (claimConflict(target)) return;
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
      if (!requireAiManagerWs(msg.deviceId, "emergency_stop")) return;
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

    if (["tap", "swipe", "home", "type_text", "release_device"].includes(msg.type) && watched && !selected) {
      auditLog.logEvent({ operator: operator.username, type: "device_watch_input_denied", deviceId: msg.deviceId ?? watched.id,
        detail: { action: msg.type } });
      ws.send(JSON.stringify({ type: "error", code: "watch_read_only", deviceId: msg.deviceId ?? watched.id,
        message: "Live watching is read-only." }));
      return;
    }

    if (["tap", "swipe", "home", "type_text"].includes(msg.type) && selected) {
      if (msg.deviceId !== undefined && msg.deviceId !== selected.id) {
        ws.send(JSON.stringify({ type: "error", deviceId: msg.deviceId, message: "Stale device input rejected." }));
        return;
      }
      if (!hasCapability(currentOperator(), CAPABILITIES.CONTROL_DEVICE)
        || !canAccessDevice(currentOperator(), selected.id)
        || humanOwners.get(selected.id) !== ws || !deviceLease.canHumanSelect(selected.id)) {
        revokeSelectedAccess(msg.type);
        return;
      }
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
      if (msg.deviceId !== undefined && msg.deviceId !== selected.id) {
        ws.send(JSON.stringify({ type: "error", deviceId: msg.deviceId, message: "Stale device release rejected." }));
        return;
      }
      const releasedId = selected.id;
      const releaseWasAuthorized = hasCapability(currentOperator(), CAPABILITIES.CONTROL_DEVICE)
        && canAccessDevice(currentOperator(), releasedId)
        && humanOwners.get(releasedId) === ws && deviceLease.canHumanSelect(releasedId);
      auditLog.logEvent({
        operator: operator.username,
        type: releaseWasAuthorized ? "device_released" : "device_access_revoked",
        deviceId: releasedId,
        detail: withNetworkEgress(releasedId, releaseWasAuthorized ? {} : { action: "release_device" }),
      });
      releaseSelection();
      broadcastDeviceList();
      broadcastPresence();
      if (!releaseWasAuthorized) {
        ws.send(JSON.stringify({ type: "error", code: "device_access_revoked", deviceId: releasedId,
          message: "Your access to this phone is no longer active. It has been released." }));
      }
      return;
    }
  };
  ws.on("message", raw => {
    let emergency = false;
    try { emergency = JSON.parse(raw.toString())?.type === "emergency_stop"; } catch { return; }
    if (emergency) void handleMessage(raw).catch(error => {
      console.error("Emergency control failed:", error);
    });
    else enqueue(() => handleMessage(raw));
  });

  ws.on("close", () => {
    presenceStore.disconnect(ws.presenceConnectionId);
    clearWatch("connection_closed");
    broadcastPresence();
    // Closure prevents queued commands from passing validateSession, but an
    // input already sent to the device cannot be cancelled by closing TCP.
    // Keep the claim (and selected reference) until that action settles.
    void actionQueue.then(() => {
      if (selected) {
        releaseSelection();
        broadcastDeviceList();
        broadcastPresence();
      }
    });
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
  expireAssignments();
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
  queueTickTimer = setInterval(() => {
    const now = new Date();
    taskQueue.tick(now);
    expireAssignments(now);
  }, QUEUE_TICK_INTERVAL_MS);
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
  presenceStore,
  assignmentStore,
};
