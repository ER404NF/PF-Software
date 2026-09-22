import express from "express";
import session from "express-session";
import multer from "multer";
import { WebSocketServer } from "ws";
import { createServer, ServerResponse } from "http";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { isDirectExecution } from "./directExecution.js";
import { WdaDevice } from "./wdaDevice.js";
import { StreamHub } from "./streamHub.js";
import { frameKind } from "./mjpegParser.js";
import { SiteStore, SiteError } from "./siteStore.js";
import { SiteLinkHub } from "./siteLink.js";
import { ApprovalStore, ApprovalError } from "./approvalStore.js";
import { CommentLedger } from "./commentGuard.js";
import { TemplateLibrary } from "./commentTemplates.js";
import { PolicyStore } from "./policyStore.js";
import { InterventionQueue } from "./interventionQueue.js";
import { createFleetPolicy, fleetConfigFromEnv, SpendTracker } from "./fleetPolicy.js";
import { ACTIONS as ALL_ACTIONS } from "./actionCatalog.js";
import { ensureDeviceDir, STORAGE_ROOT, listFiles, resolveFile, deleteFile, safeFilename, safeDeviceId, assertMediaStorageIsolated } from "./fileStore.js";
import { listRuns, getRun, createRun, setCandidateStatus } from "./researchStore.js";
import { parseOptimizationConfig, createOptimizationRuntime } from "./optimizationRuntime.js";
import { ResearchIndex } from "./optimization/researchIndex.js";
import { analyzeInterventions } from "./optimization/interventionAnalytics.js";
import {
  canAccessDevice, publicOperator, resolveOperator, hasCapability, operators, verifyPassword,
  listOperatorAccounts, createOperatorAccount, updateOperatorAccount, operatorByUsername,
  invalidateOperatorSessions, createSignupAccount, setOperatorAccountStatus, renameOperatorAccount,
  configureOperatorTwoFactor, verifyOperatorSecondFactor, createEmailRecoveryToken, completeEmailRecovery,
  assertValidUsername,
  resetOperatorSecondFactor,
  prunePendingSignupAccounts,
  flagAndDeactivateOperator,
} from "./authStore.js";
import { CAPABILITIES } from "./roleCapabilities.js";
import { researchWorkspaceFor, researchAccounts, researchAccountDefinitions, researchActionPolicies } from "./researchAccess.js";
import { createAuditLog } from "./auditLog.js";
import { FileSessionStore } from "./fileSessionStore.js";
import * as deviceLease from "./deviceLease.js";
import { createTaskQueue } from "./taskQueue.js";
import { parseCommand } from "./commandParser.js";
import { resolveSchedulingTimeZone } from "./schedulingTimeZone.js";
import { loadDeviceNetworkMap, publicNetworkConfig } from "./deviceNetworkConfig.js";
import { isProxyEgress, setDeviceProxyEnabled } from "./deviceNetworkStore.js";
import {
  createProxy, deleteProxy, assignProxyToDevice, publicProxy, publicProxies,
  getProxyRecord, decryptProxyPassword, updateProxyHealth,
} from "./proxyPool.js";
import { testProxy } from "./proxyTester.js";
import { createNetworkVerifier } from "./networkVerifier.js";
import { resolveNetworkCheckTarget } from "./networkCheckTarget.js";
import { resolveDeploymentConfig } from "./deploymentConfig.js";
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
import { createMailSender } from "./mailSender.js";
import { createAuthenticationThrottle, createRecoveryThrottle } from "./recoveryThrottle.js";
import { createSchedulerGuard } from "./schedulerGuard.js";
import { decryptTotpSecret, encryptTotpSecret, generateRecoveryCodes, generateTotpSecret, otpauthUri, recoveryCodeDigest, verifyTotp } from "./twoFactor.js";
import { discoverIosDevices } from "./deviceDiscovery.js";
import { loadDeviceConfig } from "./deviceConfigLoader.js";
import { loadDevices } from "./deviceRegistry.js";
import { startAutoProvisioning } from "./provisioningBoot.js";
import { TunManager } from "./tunManager.js";
import { PrivilegedOps } from "./privilegedOps.js";
import { NetworkRoutingOrchestrator } from "./networkRoutingOrchestrator.js";
import { listBridgeMembers, diffBridgeMembers, discoverBridgeOwnIp } from "./usbNetworkMapper.js";
import { captureDeviceTraffic, discoverDeviceIp } from "./usbIpDiscovery.js";
import { getUsbNetworkRecord, setUsbIface, setUsbIp, loadUsbNetworkRecords } from "./usbNetworkStore.js";
import { enableInternetSharing, detectPrimaryInterface } from "./internetSharingManager.js";
import { AutoNetworkEnrollment } from "./autoNetworkEnrollment.js";
import {
  createMediaQuotaManager, createQuotaStorage, mediaByteSetting,
  DEFAULT_DEVICE_MEDIA_QUOTA_BYTES, DEFAULT_GLOBAL_MEDIA_QUOTA_BYTES, DEFAULT_MEDIA_MIN_FREE_BYTES,
} from "./mediaUploadQuota.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, "../../client");
const configPath = process.env.DEVICE_CONFIG_PATH || path.join(__dirname, "../../devices.config.json");
const rawDeviceConfig = loadDeviceConfig({ env: process.env, defaultPath: configPath });
const discoveredIosDevices = process.env.AUTO_DISCOVER_IOS_DEVICES === "false" ? [] : discoverIosDevices();
const isMain = isDirectExecution(import.meta.url);
const deployment = resolveDeploymentConfig(process.env, {
  enforceStartup: Boolean(isMain),
  hasMockDevices: rawDeviceConfig.devices?.some(device => device?.type === "mock"),
});

// One explicit scheduling timezone for /time wall-clock input (PHONE_FARM_TIMEZONE,
// default America/Los_Angeles) — never whatever zone the OS/process happens to be in.
// An invalid value fails startup instead of silently falling back.
const schedulingTimeZone = resolveSchedulingTimeZone(process.env);

const app = express();
if (deployment.trustProxy) app.set("trust proxy", 1);
app.use(express.static(clientDir));
// Liveness probe for Docker / uptime monitors. Deliberately unauthenticated and
// revealing nothing but "the process is answering".
app.get("/healthz", (req, res) => res.json({ ok: true }));
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
const twoFactorMasterKey = process.env.TWO_FACTOR_MASTER_KEY || null;
const accountNotificationStore = createAccountNotificationStore({
  storePath: process.env.ACCOUNT_NOTIFICATION_STORE_PATH || path.join(__dirname, "../../storage/notifications/accounts.json"),
  companyEmail: process.env.COMPANY_FROM_EMAIL || null,
  encryptionKey: process.env.ACCOUNT_NOTIFICATION_ENCRYPTION_KEY || twoFactorMasterKey,
});
const mailSender = createMailSender({
  host: process.env.SMTP_HOST || null,
  port: process.env.SMTP_PORT || null,
  user: process.env.SMTP_USER || null,
  pass: process.env.SMTP_PASS || null,
  secure: process.env.SMTP_SECURE === "true",
});
if (isMain && !mailSender.isConfigured()) {
  console.warn("SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS not fully set — account notification emails will stay queued, not sent.");
}
// Sends one already-queued notification and advances its deliveryState to
// "sent"/"failed". A failed send is swallowed here (logged, not thrown) —
// the account action that triggered the notification (approve/reject,
// recovery request) must never fail because outbound mail did.
async function deliverAccountNotification(id) {
  if (!mailSender.isConfigured()) return null;
  try {
    const content = accountNotificationStore.deliveryContent(id);
    if (!content || content.deliveryState !== "queued") return content;
    await mailSender.send({ to: content.to, from: content.from, subject: content.subject, body: content.body });
    return accountNotificationStore.markSent(id);
  } catch (error) {
    console.error("Account notification email send failed:", error);
    return accountNotificationStore.markFailed(id);
  }
}
// Same "default to the shared 2FA master key, allow a dedicated override"
// convention as accountNotificationStore above.
const proxyPoolStorePath = process.env.PROXY_POOL_STORE_PATH || path.join(__dirname, "../../storage/proxy-pool.json");
const proxyCredentialEncryptionKey = process.env.PROXY_CREDENTIAL_ENCRYPTION_KEY || twoFactorMasterKey;
// Cached like `deviceNetwork` below, not re-read from disk on every
// summary() call — refreshed explicitly after each pool mutation route.
let proxyPoolCache = publicProxies(proxyPoolStorePath);
function refreshProxyPoolCache() { proxyPoolCache = publicProxies(proxyPoolStorePath); }
function poolProxyForDevice(deviceId) { return proxyPoolCache.find(p => p.leasedToDeviceId === deviceId) ?? null; }
const usbNetworkStorePath = process.env.USB_NETWORK_STORE_PATH || path.join(__dirname, "../../storage/usb-network.json");
// Ephemeral, not persisted: the "before" bridge-member snapshot only needs
// to survive the short window between an admin starting enrollment and
// confirming it (after manually enabling Internet Sharing for that phone
// in between) — a relay restart mid-enrollment just means starting over,
// which is fine and matches the guide's own "stop for a human, never
// guess" philosophy for this inherently manual step.
const networkEnrollmentSnapshots = new Map(); // deviceId -> string[] (bridge members before)
// Same "cache in memory, refresh explicitly after mutation" convention as
// proxyPoolCache above — summary() would otherwise do a synchronous disk
// read per device per connected client on every device_list broadcast.
// Pre-populated from disk once at startup (unlike proxyPoolCache's
// find-scan shape, this is a direct per-device lookup, so a Map is the
// natural fit) so already-persisted enrollment/IP data isn't lost until
// the first mutation after a relay restart.
const usbNetworkCache = new Map(Object.entries(loadUsbNetworkRecords(usbNetworkStorePath)));
function refreshUsbNetworkCache(deviceId) { usbNetworkCache.set(deviceId, getUsbNetworkRecord(usbNetworkStorePath, deviceId)); }
function usbNetworkForDevice(deviceId) { return usbNetworkCache.get(deviceId) ?? null; }
const recoveryThrottle = createRecoveryThrottle();
const passwordLoginThrottle = createAuthenticationThrottle({ accountLimit: 5, ipLimit: 25 });
const secondFactorThrottle = createAuthenticationThrottle({ accountLimit: 5, ipLimit: 25 });
const signupThrottle = createAuthenticationThrottle({ windowMs: 60 * 60_000, accountLimit: 2, ipLimit: 10 });
function positiveIntegerSetting(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const maxPendingSignups = positiveIntegerSetting(process.env.MAX_PENDING_SIGNUPS, 500);
const pendingSignupMaxAgeMs = positiveIntegerSetting(process.env.PENDING_SIGNUP_MAX_AGE_MS, 30 * 24 * 60 * 60_000);

const SESSION_SECRET = deployment.sessionSecret;
if (!process.env.SESSION_SECRET && !isMain) {
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
  cookie: { httpOnly: true, sameSite: "lax", secure: deployment.secureCookies, maxAge: 24 * 60 * 60 * 1000 },
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
  passwordLoginThrottle.succeed({ identifier: operator.username });
  secondFactorThrottle.succeed({ identifier: operator.username });
  res.json(publicOperator(operator));
}

function saveSessionThenRespond(req, res, next, status, body) {
  req.session.save(error => {
    if (error) return next(error);
    res.status(status).json(body);
  });
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
  const blocked = secondFactorThrottle.fail({ identifier: challenge.username, ip: req.ip });
  if (blocked) {
    delete req.session.pendingAuth;
    delete req.session.twoFactorEnrollmentSecret;
    auditLog.logEvent({ operator: challenge.username, type: "two_factor_rate_limited" });
    return res.status(429).json({ error: "too many two-factor attempts; try again later" });
  }
  return res.status(401).json({ error: message });
}

app.post("/api/signup", (req, res, next) => {
  try {
    const identifier = req.body?.email || req.body?.username;
    if (signupThrottle.blocked({ identifier, ip: req.ip })) {
      return res.status(429).json({ error: "too many account applications; try again later" });
    }
    const capacity = prunePendingSignupAccounts({ maxAgeMs: pendingSignupMaxAgeMs, maxPending: maxPendingSignups });
    if (capacity.atCapacity) return res.status(503).json({ error: "account applications are temporarily closed" });
    const operator = createSignupAccount(req.body);
    signupThrottle.fail({ identifier, ip: req.ip });
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

// Loopback-only, self-disabling host bootstrap: creates the very first admin
// account for a freshly-set-up host (the desktop app's "set up a new host"
// first-run screen calls this). Deliberately not behind requireAuth — there
// is no admin yet to authenticate as. Two independent locks keep this from
// ever being a real remote attack surface: (1) req.socket.remoteAddress must
// be loopback, so no network client — however the requester's own app
// behaves — can ever reach it; (2) it permanently refuses once any approved
// admin exists, with the exact same 404 shape as a route that never existed,
// so there's nothing to probe for. If an already-authenticated non-admin
// operator hits it after that lockout, that's a self-escalation attempt —
// flag and force them out via the same mechanism as the account-management
// routes above, rather than just a quiet 404.
function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const normalized = address.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

app.post("/api/setup/create-admin", (req, res, next) => {
  try {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      return res.status(404).json({ error: "not found" });
    }
    const hasApprovedAdmin = listOperatorAccounts().some(user => user.role === OPERATOR_ROLES.ADMIN
      && user.active !== false && (user.accountStatus ?? "approved") === "approved");
    if (hasApprovedAdmin) {
      const current = req.session?.operator ? resolveOperator(req.session.operator) : null;
      if (current && current.role !== OPERATOR_ROLES.ADMIN) {
        const flagged = flagAndDeactivateOperator(
          current.username,
          "attempted the host bootstrap endpoint after an admin already existed"
        );
        if (flagged) {
          auditLog.logEvent({
            operator: current.username,
            type: "self_escalation_attempt_blocked",
            detail: { method: req.method, path: req.path },
          });
        }
      }
      return res.status(404).json({ error: "not found" });
    }
    const operator = createOperatorAccount({
      username: req.body?.username,
      password: req.body?.password,
      role: OPERATOR_ROLES.ADMIN,
      allowedDevices: null,
      fullName: req.body?.fullName ?? null,
      email: req.body?.email ?? null,
      twoFactorRequired: true,
    });
    auditLog.logEvent({ operator: operator.username, type: "host_bootstrap_admin_created" });
    res.status(201).json({ operator });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.post("/api/login", (req, res, next) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string" || username.length > 100) {
    return res.status(400).json({ error: "username and password are required" });
  }
  if (passwordLoginThrottle.blocked({ identifier: username, ip: req.ip })) {
    auditLog.logEvent({ operator: username, type: "login_rate_limited" });
    return res.status(429).json({ error: "too many sign-in attempts; try again later" });
  }
  const operator = operators.get(username);
  if (!operator || !verifyPassword(password, operator.passwordHash)) {
    auditLog.logEvent({ operator: username, type: "login_failed" });
    if (passwordLoginThrottle.fail({ identifier: username, ip: req.ip })) {
      return res.status(429).json({ error: "too many sign-in attempts; try again later" });
    }
    return res.status(401).json({ error: "invalid credentials" });
  }
  passwordLoginThrottle.succeed({ identifier: username });
  if (operator.accountStatus === "pending") return res.status(403).json({ code: "approval_pending", error: "account approval is pending" });
  if (operator.accountStatus === "rejected") return res.status(403).json({ code: "account_rejected", error: "account application was not accepted" });
  if (operator.active === false) return res.status(401).json({ error: "invalid credentials" });
  if (operator.twoFactorRequired) {
    if (secondFactorThrottle.blocked({ identifier: operator.username, ip: req.ip })) {
      return res.status(429).json({ error: "too many two-factor attempts; try again later" });
    }
    req.session.pendingAuth = {
      username: operator.username,
      authVersion: operator.authVersion ?? 0,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    return saveSessionThenRespond(req, res, next, 202, operator.twoFactorSecret
      ? { requiresTwoFactor: true }
      : { requiresTwoFactorSetup: true });
  }
  completeLogin(req, res, operator);
});

app.post("/api/2fa/setup", (req, res, next) => {
  const operator = pendingAuthOperator(req);
  if (!operator) return res.status(401).json({ error: "password verification has expired" });
  if (operator.twoFactorSecret) return res.status(409).json({ error: "2FA is already configured" });
  if (!twoFactorMasterKey) return res.status(503).json({ error: "2FA enrollment is unavailable until TWO_FACTOR_MASTER_KEY is configured" });
  const secret = generateTotpSecret();
  req.session.twoFactorEnrollmentSecret = secret;
  saveSessionThenRespond(req, res, next, 200,
    { secret, otpauthUri: otpauthUri({ secret, email: operator.email || operator.username }) });
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
    saveSessionThenRespond(req, res, next, 200, { operator: publicOperator(current), recoveryCodes });
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
  const identifier = req.body?.identifier;
  const allowed = recoveryThrottle.allow({ identifier, ip: req.ip });
  const recovery = allowed && accountNotificationStore.canSecureRecovery()
    ? createEmailRecoveryToken(identifier)
    : null;
  if (recovery?.token) {
    const item = accountNotificationStore.queue({
      to: recovery.operator.email,
      fullName: recovery.operator.fullName || recovery.operator.username,
      username: recovery.operator.username,
      status: "recovery",
      recoveryToken: recovery.token,
    });
    // Deliberately not awaited: awaiting a real SMTP round-trip here would
    // make a matching identifier's response measurably slower than a
    // non-matching one, turning this endpoint's identical response message
    // into an account-enumeration timing side channel. deliverAccountNotification
    // never rejects (its own try/catch marks the notification failed instead).
    deliverAccountNotification(item.id);
  }
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

function currentStoredOperator(req) {
  return new Promise((resolve, reject) => {
    if (!req.sessionID) return resolve(null);
    sessionStore.get(req.sessionID, (error, stored) => {
      if (error) return reject(error);
      if (!stored?.operator || stored.operator.username !== req.session?.operator?.username) return resolve(null);
      resolve(resolveOperator(stored.operator));
    });
  });
}

// A capability-gated route whose :username param can equal the caller's own
// username is a self-privilege-escalation vector (e.g. a VA trying to PATCH
// their own role to admin), not an ordinary permission failure. Routes that
// carry this risk opt in via { flagSelfEscalation: true } below; everything
// else (a denied /api/audit request, etc.) stays a plain 403.
function flagSelfEscalationIfTargeted(req, current, label) {
  if (req.params?.username !== current.username) return;
  const flagged = flagAndDeactivateOperator(
    current.username,
    `attempted to modify their own account via an admin-only route (${label})`
  );
  if (flagged) {
    auditLog.logEvent({
      operator: current.username,
      type: "self_escalation_attempt_blocked",
      detail: { method: req.method, path: req.path, capability: label },
    });
  }
}

// Feature-role authorization is separate from device RBAC. A route protected
// here may still perform canAccessDevice() checks when it acts on a specific
// phone. Missing/legacy roles normalize to VA in authStore.js, so old session
// data never gains admin rights by accident.
function requireCapability(capability, { flagSelfEscalation = false } = {}) {
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
      if (flagSelfEscalation) flagSelfEscalationIfTargeted(req, current, capability);
      return res.status(403).json({ error: `${capability} capability required` });
    }
    presenceStore.touchSession({ sessionId: req.sessionID, username: current.username, expiresAt: req.session.cookie.expires });
    next();
  };
}

function requireAnyCapability(...args) {
  const flagSelfEscalation = args.length && typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
  const capabilities = flagSelfEscalation ? args.slice(0, -1) : args;
  const options = flagSelfEscalation ? args[args.length - 1] : {};
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
      if (options.flagSelfEscalation) flagSelfEscalationIfTargeted(req, current, capabilities.join("|"));
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
function authorizedAuditEvents(operator, { operator: operatorFilter, deviceId, limit = 200 } = {}) {
  const boundedLimit = Math.min(Number(limit) || 200, 1000);
  return auditLog.listEvents({
    operator: typeof operatorFilter === "string" ? operatorFilter : undefined,
    deviceId: typeof deviceId === "string" ? deviceId : undefined,
    limit: 1000,
  }).filter(event => !event.deviceId || canAccessDevice(operator, event.deviceId)).slice(0, boundedLimit);
}

app.get("/api/audit", requireCapability(CAPABILITIES.VIEW_AUDIT), (req, res) => {
  const { operator, deviceId, limit } = req.query;
  res.json({ events: authorizedAuditEvents(req.currentOperator, { operator, deviceId, limit }) });
});

function publicPeople(viewer = null) {
  const visibleAssignments = viewer
    ? assignmentStore.list().filter(item => canViewAssignment(item, viewer))
    : [];
  return presenceStore.listPeople(operators.values()).map(person => {
    const assignment = visibleAssignments.find(item => item.assignee === person.username
      && ["assigned", "in_progress"].includes(item.status)) ?? null;
    return {
      ...person,
      canAssign: Boolean(viewer && hasCapability(viewer, CAPABILITIES.MANAGE_ASSIGNMENTS)
        && canManagePerson(viewer, person.username)),
      currentDeviceIds: person.currentDeviceIds.filter(id => viewer && canAccessDevice(viewer, id)),
      currentPhones: person.currentDeviceIds
        .filter(id => viewer && canAccessDevice(viewer, id))
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
  // Site agents (other locations' Mac minis) authenticate with a site token, not an
  // operator session.
  if (String(request.url ?? "").split("?")[0] === "/agent-link") {
    siteLinkHub.handleUpgrade(request, socket, head);
    return;
  }
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

const devices = loadDevices(rawDeviceConfig, discoveredIosDevices);
// Populated below, inside the `isMain` startup gate, only when
// AUTO_PROVISION_WDA is enabled and the host preflight passes. Declared
// here (not inside that gate) so the retry-provisioning route below can
// close over it before it's assigned — by the time any request arrives,
// startup has already finished.
let deviceProvisioner;
// Same reasoning as deviceProvisioner above — populated inside `isMain`
// only when AUTO_ROUTE_PROXY_TUNNELS is enabled, declared here so the
// start/stop-routing routes below can close over it.
let networkRoutingOrchestrator;
// Populated only when AUTO_NETWORK_ENROLLMENT is also enabled — automates
// the network-enrollment/discover-ip routes above instead of requiring an
// admin to click through them.
let autoNetworkEnrollment;
const manualWdaUdids = new Set(
  (rawDeviceConfig.devices ?? []).filter(device => device?.type === "wda" && device?.udid).map(device => device.udid)
);
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

// ---- sites: other locations that link their phones to this hub ----------------------
const siteStore = new SiteStore(process.env.SITE_STORE_PATH || path.join(STORAGE_ROOT, "sites.json"),
  { defaultTimeZone: schedulingTimeZone });
const siteLinkHub = new SiteLinkHub({
  siteStore,
  devices,
  onDevicesChanged: () => broadcastDeviceList(),
  registerRemoteDevice: (device, site) => {
    deviceHost.set(device.id, site.name);
    deviceMonitorConfig.set(device.id, {
      adapter: device.type === "mock" ? "mock" : device.type === "wda" ? "wda" : "unconfigured",
      physicallyValidated: false,
    });
  },
  unregisterRemoteDevice: device => {
    deviceHost.delete(device.id);
    deviceMonitorConfig.delete(device.id);
  },
  onSiteEvent: event => auditLog.logEvent({ operator: "system", type: event.type, detail: { siteId: event.siteId, ...event.detail } }),
});

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

app.patch("/api/admin/users/:username/status", requireAnyCapability(CAPABILITIES.MANAGE_USERS, CAPABILITIES.MANAGE_TEAM_MEMBERS, { flagSelfEscalation: true }), async (req, res, next) => {
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
    const notification = accountNotificationStore.queue({
      to: target.email,
      fullName: target.fullName || target.username,
      username: target.username,
      status: req.body.status,
      holdForCommit: true,
    });
    let operator;
    try { operator = setOperatorAccountStatus(req.params.username, req.body?.status); }
    catch (error) {
      try { accountNotificationStore.markAborted(notification.id); }
      catch (abortError) { console.error("Account review outbox abort failed:", abortError); }
      throw error;
    }
    let notificationState;
    try { notificationState = accountNotificationStore.markCommitted(notification.id)?.deliveryState; }
    catch (error) {
      notificationState = "pending_reconciliation";
      console.error("Account review outbox commit failed:", error);
    }
    if (notificationState === "queued") {
      notificationState = (await deliverAccountNotification(notification.id))?.deliveryState ?? notificationState;
    }
    revokeLiveOperatorSessions(operator.username);
    broadcastPresence();
    try {
      auditLog.logEvent({ operator: req.currentOperator.username, type: `operator_${req.body.status}`,
        detail: { target: operator.username, teamId: operator.teamId || null, notificationState } });
    } catch (error) { console.error("Account review audit failed:", error); }
    res.json({ operator, notification: { deliveryState: notificationState } });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.patch("/api/admin/users/:username/rename", requireAnyCapability(CAPABILITIES.MANAGE_USERS, CAPABILITIES.MANAGE_TEAM_MEMBERS), (req, res, next) => {
  const previousUsername = req.params.username;
  const nextUsername = req.body?.username;
  let tasksMigrated = false;
  let assignmentsMigrated = false;
  let accountMigrated = false;
  const rollbackReferences = () => {
    const failures = [];
    if (assignmentsMigrated) {
      try { assignmentStore.renamePrincipal(nextUsername, previousUsername, req.currentOperator.username); }
      catch (error) { failures.push(error); }
    }
    if (tasksMigrated) {
      try { taskQueue.renamePrincipal(nextUsername, previousUsername); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "username migration rollback failed");
  };
  try {
    if (!canManagePerson(req.currentOperator, previousUsername)) {
      return res.status(403).json({ error: "not authorized to rename this account" });
    }
    if (req.currentOperator.role === OPERATOR_ROLES.MANAGER && previousUsername === req.currentOperator.username) {
      return res.status(403).json({ error: "a manager cannot rename their own account" });
    }
    assertValidUsername(nextUsername);
    if (operators.has(nextUsername)) return res.status(409).json({ error: "username already exists" });
    taskQueue.renamePrincipal(previousUsername, nextUsername);
    tasksMigrated = true;
    assignmentStore.renamePrincipal(previousUsername, nextUsername, req.currentOperator.username);
    assignmentsMigrated = true;
    const operator = renameOperatorAccount(previousUsername, nextUsername);
    accountMigrated = true;
    try {
      auditLog.logEvent({ operator: req.currentOperator.username, type: "operator_renamed",
        detail: { previousUsername, username: operator.username } });
    } catch (error) { console.error("Operator rename audit failed:", error); }
    revokeLiveOperatorSessions(previousUsername);
    broadcastPresence();
    broadcastDeviceList();
    res.json({ operator });
  } catch (error) {
    if (!accountMigrated && (assignmentsMigrated || tasksMigrated)) {
      try { rollbackReferences(); }
      catch (rollbackError) { return next(new AggregateError([error, rollbackError], "username migration rollback failed")); }
    }
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
    const operator = createOperatorAccount({ ...req.body, twoFactorRequired: true });
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

app.patch("/api/admin/users/:username", requireCapability(CAPABILITIES.MANAGE_USERS, { flagSelfEscalation: true }), (req, res, next) => {
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
// ---- AI research: approvals, comment safety, policy overrides, fleet (MS9-MS12) -----------------
const researchStoreFile = (envName, name) => process.env[envName] || path.join(STORAGE_ROOT, name);
const approvalStore = new ApprovalStore({ filePath: researchStoreFile("APPROVAL_STORE_PATH", "research-approvals.json") });
const commentLedger = new CommentLedger({ filePath: researchStoreFile("COMMENT_LEDGER_PATH", "comment-ledger.json") });
const templateLibrary = new TemplateLibrary({ filePath: researchStoreFile("COMMENT_TEMPLATES_PATH", "comment-templates.json") });
const policyStore = new PolicyStore({ filePath: researchStoreFile("ACTION_POLICY_OVERRIDES_PATH", "action-policy-overrides.json") });
const interventionQueue = new InterventionQueue({ filePath: researchStoreFile("INTERVENTION_STORE_PATH", "interventions.json") });
const spendTracker = new SpendTracker();
// The validator sees configured policy with any runtime override applied on top, looked up
// afresh for every action so a change takes effect on the very next step.
const effectiveActionPolicies = { get: accountId => policyStore.effective(researchActionPolicies).get(accountId) };
let fleetPolicy = null; // created below, once the queue exists

const queueStorePath = process.env.QUEUE_STORE_PATH || path.join(__dirname, "../../storage/queue/tasks.json");
const taskQueue = createTaskQueue({ devices, deviceLease, auditLog, storePath: queueStorePath, dispatchOnCreate: false,
  canDispatch: (task, deviceId) => {
    const operator = operatorByUsername(task.createdBy);
    return canAccessDevice(operator, deviceId)
      && networkDecision(deviceId).allowed
      && (task.kind !== "research" || !!researchWorkspaceFor(operator, task.accountSelector?.accountId))
      && (fleetPolicy?.canDispatch(task, deviceId) ?? true);
  } });
const modelSelectionStorePath = process.env.MODEL_SELECTION_STORE_PATH
  || path.join(__dirname, "../../storage/models/selection.json");
const modelSelection = createModelSelection({ providers, defaultProviderName, storePath: modelSelectionStorePath });
fleetPolicy = createFleetPolicy({
  runningTasks: () => taskQueue.listTasks().filter(task => task.state === "RUNNING"),
  workspaceOf: accountId => researchAccounts.get(accountId) ?? null,
  providerOf: task => modelSelection.resolve({ taskId: task.id, workspaceId: researchAccounts.get(task.accountSelector?.accountId), deviceId: task.deviceSelector?.deviceId }) ?? null,
  spentLastHourUsd: () => spendTracker.totalUsd(),
  config: fleetConfigFromEnv(process.env, researchAccountDefinitions),
});
const assignmentStorePath = process.env.ASSIGNMENT_STORE_PATH
  || path.join(__dirname, "../../storage/assignments/assignments.json");
const assignmentStore = createAssignmentStore({ storePath: assignmentStorePath });

function expireAssignments(at = new Date()) {
  const expired = assignmentStore.expireDue(at);
  for (const assignment of expired) {
    const lastAction = assignment.history.at(-1)?.action;
    auditLog.logEvent({
      operator: "system",
      type: lastAction === "recurrence_conflict" ? "assignment_recurrence_conflict"
        : assignment.status === "expired" ? "assignment_expired" : "assignment_recurrence_advanced",
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

const schedulerGuard = createSchedulerGuard({ taskQueue, expireAssignments, auditLog });

const MANAGER_ASSIGNABLE_ROLES = new Set([
  OPERATOR_ROLES.VA,
  OPERATOR_ROLES.CONTENT_CREATOR,
  OPERATOR_ROLES.EDITOR,
]);
const SELF_PROGRESS_ROLES = new Set([
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

function publicAssignmentFor(assignment, operator) {
  const canProgress = SELF_PROGRESS_ROLES.has(operator.role)
    && assignment.assignee === operator.username
    && ((assignment.status === "assigned") || (assignment.status === "in_progress"));
  return { ...assignment, canProgress };
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
  res.json({ assignments: assignmentStore.list().filter(item => canViewAssignment(item, req.currentOperator))
    .map(item => publicAssignmentFor(item, req.currentOperator)) });
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
      timezone: req.body?.timezone ?? "UTC",
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
      const ownWorkerProgress = SELF_PROGRESS_ROLES.has(req.currentOperator.role)
        && current.assignee === req.currentOperator.username
        && ((current.status === "assigned" && req.body.status === "in_progress")
          || (current.status === "in_progress" && req.body.status === "completed"));
      if (!hasManage && !ownWorkerProgress) return res.status(403).json({ error: "assignment management capability required" });
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
    res.json({ assignment: publicAssignmentFor(assignment, req.currentOperator) });
  } catch (error) {
    if (/cannot move|cannot start|in-progress|terminal|invalid assignment|overlaps/.test(error.message)) return res.status(409).json({ error: error.message });
    if (/schedule|startAt|endAt|exclusive|recurrence/.test(error.message)) return res.status(400).json({ error: error.message });
    next(error);
  }
});
// MS13: opt-in optimizations (model routing, state cache, adaptive pacing). Off unless
// PHONE_FARM_OPTIMIZATIONS says otherwise; see optimizationRuntime.js.
const optimizationRuntime = createOptimizationRuntime({
  config: parseOptimizationConfig(process.env),
  getProvider,
  getPlatformSkill,
});
const researchTaskRunner = createResearchTaskRunner({
  taskQueue,
  devices,
  deviceLease,
  auditLog,
  accountWorkspaces: researchAccounts,
  accountPolicies: effectiveActionPolicies,
  approvals: approvalStore,
  commentLedger,
  templates: templateLibrary,
  interventions: interventionQueue,
  spend: spendTracker,
  providerForTask: (task, { workspaceId, deviceId }) => {
    const name = modelSelection.resolve({ taskId: task.id, workspaceId, deviceId });
    return name ? optimizationRuntime.providerFor(name, task.accountSelector?.platform) : null;
  },
  skillForPlatform: (platform) => optimizationRuntime.skillFor(platform),
  pacingForTask: () => optimizationRuntime.pacingFor(),
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
const LIVE_FRAME_MIN_INTERVAL_MS = 1000;
const MAX_CONCURRENT_LIVE_FRAMES = 4;
const liveFrameNextByDevice = new Map();
const liveFrameNextByOperator = new Map();
let activeLiveFrames = 0;

// Live video. One upstream MJPEG connection per phone, shared by the controlling
// operator and any watchers (see streamHub.js). A viewer whose socket has more
// than STREAM_BACKPRESSURE_BYTES queued (slow mobile link) skips frames instead
// of buffering them, so latency stays low rather than growing without bound.
const streamHub = new StreamHub({ idleCloseMs: Number(process.env.STREAM_IDLE_CLOSE_MS) || 3000 });
// One megabyte could hold many half-size JPEGs and make the operator watch old
// input results. Start dropping while roughly one large frame is queued; the
// newest skipped frame is retained below and replaces older skipped frames.
const STREAM_BACKPRESSURE_BYTES = 128 * 1024;
const STREAM_FLUSH_RETRY_MS = 120;
const STREAM_SESSION_RECHECK_MS = 5000;
// Input messages one connection may have waiting behind the phone. A wheel-happy
// or hostile client must not be able to build an unbounded backlog of gestures.
const MAX_QUEUED_INPUT_MESSAGES = 60;

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
  if (d.discoveryState === "provisioning") {
    return { assignedToViewer: true, canOpen: false, accessState: "wda_provisioning", openReason: d.discoveryStateMessage || "Setting up WDA and the device tunnel automatically." };
  }
  if (d.discoveryState === "user_action_required") {
    return { assignedToViewer: true, canOpen: false, accessState: "wda_user_action_required", openReason: d.discoveryStateMessage || "This phone needs a manual action before it can come online." };
  }
  if (d.discoveryState === "provisioning_error") {
    return { assignedToViewer: true, canOpen: false, accessState: "wda_provisioning_error", openReason: d.discoveryStateMessage || "Automatic setup failed for this phone. An admin can retry." };
  }
  if (d.discoveryState === "disconnected") {
    return { assignedToViewer: true, canOpen: false, accessState: "disconnected", openReason: d.discoveryStateMessage || "Unplugged." };
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
    // Read-only AI-phone inspection only needs the same monitor capability as
    // watching a human-controlled screen below — MANAGE_AI_CONTROLLER gates
    // acting on the device (switch_to_ai/takeover/emergency_stop), which is
    // deliberately admin-only and must not also decide who can merely look.
    if (!hasCapability(viewer, CAPABILITIES.MONITOR_DEVICE)) {
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
    discoveryStateMessage: d.discoveryStateMessage ?? null,
    hostLabel: deviceHost.get(d.id) ?? DEFAULT_HOST_LABEL,
    siteId: d.siteId ?? null,
    siteName: d.siteName ?? null,
    siteOnline: d.isRemote ? d.siteOnline : null,
    timeZone: d.timeZone ?? null,
    ...getHealth(d.id),
    componentHealth: typeof d.healthSnapshot === "function" ? d.healthSnapshot() : null,
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
    poolProxy: hasCapability(viewer, CAPABILITIES.VIEW_PROXY_POOL) ? poolProxyForDevice(d.id) : null,
    routing: hasCapability(viewer, CAPABILITIES.MANAGE_ROUTING) ? (networkRoutingOrchestrator?.getRoute(d.id) ?? null) : null,
    networkRouteHealth: (() => {
      const route = networkRoutingOrchestrator?.getRoute(d.id);
      return route ? {
        state: route.state,
        protected: route.protected === true,
        internetBlocked: route.internetBlocked === true,
      } : null;
    })(),
    usbNetwork: hasCapability(viewer, CAPABILITIES.MANAGE_ROUTING) ? usbNetworkForDevice(d.id) : null,
    autoEnrollment: hasCapability(viewer, CAPABILITIES.MANAGE_ROUTING) ? (autoNetworkEnrollment?.getStatus(d.id) ?? null) : null,
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

app.get("/api/admin/devices/:deviceId/diagnostics", requireCapability(CAPABILITIES.MANAGE_DEVICES), (req, res) => {
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  const device = devices.get(req.params.deviceId);
  res.json({
    deviceId: device.id,
    health: typeof device.healthSnapshot === "function" ? device.healthSnapshot() : null,
    routing: networkRoutingOrchestrator?.getRoute(device.id) ?? null,
    network: networkVerifier.getStatus(device.id),
  });
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
}, upload.single("file"), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: "no file, or invalid filename" });
  const name = safeFilename(req.file.originalname);
  const discardStagedUpload = () => {
    mediaQuota.abort(req.file.quotaReservation);
    fs.rmSync(req.file.path, { force: true });
  };
  try {
    if (!name) throw new Error("invalid filename");
    const current = await currentStoredOperator(req);
    if (!current) {
      discardStagedUpload();
      return res.status(401).json({ error: "not logged in" });
    }
    if (!hasCapability(current, CAPABILITIES.ACCESS_MEDIA)
      || !canAccessDevice(current, req.params.deviceId)) {
      discardStagedUpload();
      return res.status(403).json({ error: "media access is no longer permitted for this device" });
    }
    req.currentOperator = current;
    // Same-directory rename commits only a fully validated multipart upload.
    // A failed replacement preserves the old file; never unlink it first.
    fs.renameSync(req.file.path, path.join(req.file.destination, name));
    mediaQuota.commit(req.file.quotaReservation);
  } catch (error) {
    discardStagedUpload();
    return next(error);
  }
  auditLog.logEvent({
    operator: req.currentOperator.username,
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
  let checkUrl;
  try {
    checkUrl = resolveNetworkCheckTarget({
      configuredUrl: configuredNetwork?.checkUrl,
      requestedUrl: req.body?.checkUrl,
    });
  } catch (error) {
    return res.status(error.status ?? 400).json({ error: error.message });
  }
  if (typeof checkUrl !== "string" || checkUrl.length === 0) {
    const assigned = poolProxyForDevice(req.params.deviceId);
    if (!assigned) {
      return res.status(409).json({
        error: "No automatic network verification path is available until a saved proxy is assigned to this phone.",
        code: "V201",
      });
    }
    if (!proxyCredentialEncryptionKey) {
      return res.status(503).json({ error: "proxy verification is unavailable until the credential encryption key is configured", code: "V201" });
    }
    const record = getProxyRecord(proxyPoolStorePath, assigned.id);
    if (!record) return res.status(409).json({ error: "the assigned proxy no longer exists", code: "V201" });
    checkUrl = null;
    void (async () => {
      const proxyResult = await testProxy({
        protocol: record.protocol, host: record.host, port: record.port, username: record.username,
        password: decryptProxyPassword(record, proxyCredentialEncryptionKey), country: record.country,
      });
      updateProxyHealth(proxyPoolStorePath, record.id, proxyResult);
      refreshProxyPoolCache();
      await networkRoutingOrchestrator?.checkHealth();
      return networkVerifier.recordInfrastructureCheck(req.params.deviceId, {
        proxyResult,
        route: networkRoutingOrchestrator?.getRoute(req.params.deviceId) ?? null,
      });
    })().then((result) => {
      const access = networkDecision(req.params.deviceId);
      if (!access.allowed) {
        taskQueue.stopDevice(req.params.deviceId, "network_policy");
        for (const client of wss.clients) client.releaseUnauthorizedSelection?.("network_policy");
      }
      broadcastDeviceList();
      const current = resolveOperator(req.session?.operator);
      if (!current) return res.status(401).json({ error: "authentication required" });
      if (!hasCapability(current, CAPABILITIES.RUN_NETWORK_CHECK)
        || !canAccessDevice(current, req.params.deviceId)) return res.status(403).json({ error: "network verification is not permitted" });
      auditLog.logEvent({ operator: current.username, type: "network_check", deviceId: req.params.deviceId,
        detail: { proxyId: record.id, level: result.networkVerificationLevel, protected: false } });
      res.json({ network: { ...(publicNetworkConfig(configuredNetwork) ?? {}), ...result } });
    }).catch(error => {
      console.error("Automatic proxy verification failed:", error?.code || error?.name || "Error");
      const diagnostic = error?.diagnostic;
      res.status(error?.status || 502).json({ error: diagnostic?.name || "network verification failed",
        code: diagnostic?.code || "V201", diagnostic: diagnostic || null });
    });
    return;
  }
  networkVerifier
    .checkDevice(req.params.deviceId, checkUrl)
    .then(async (result) => {
      if (result.networkMismatch && isProxyEgress(configuredNetwork?.egress)) {
        await networkRoutingOrchestrator?.quarantineRoute(req.params.deviceId, {
          code: result.networkLatestError?.code || "V204",
          why: result.networkMismatchReason || "End-to-end verification detected an unexpected route.",
        });
      }
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
    .catch((error) => {
      console.error("Network verification failed:", error?.code || error?.name || "Error");
      res.status(502).json({ error: "network verification failed", code: "NETWORK_CHECK_FAILED" });
    });
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

// Manual recovery for a device stuck in `user_action_required` (e.g. a
// trust/developer-certificate prompt was just resolved on the phone) or
// `provisioning_error` (WDA/iproxy exhausted its restart budget). No-op
// route (409) when automatic provisioning isn't enabled on this relay.
app.post("/api/admin/devices/:deviceId/retry-provisioning", requireCapability(CAPABILITIES.MANAGE_DEVICES), (req, res) => {
  if (!deviceProvisioner) return res.status(409).json({ error: "automatic device provisioning is not enabled on this relay" });
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  const ok = deviceProvisioner.retryDevice(req.params.deviceId);
  if (!ok) return res.status(409).json({ error: "this device is not currently managed by automatic provisioning" });
  auditLog.logEvent({
    operator: req.currentOperator.username,
    type: "provisioning_retry",
    deviceId: req.params.deviceId,
  });
  res.json({ ok: true });
});

// Shared proxy pool (Phase B, Phone_Farm_Automation_Architecture.md §4.6):
// an Admin enters provider credentials once; assigning a pool entry to a
// device is a separate, lighter action Admin and Manager can both do from
// the fleet card. Credentials are encrypted at rest (proxyPool.js) and
// publicProxy()/publicProxies() strictly never return host/port/username/
// password to the browser. Actually starting a tunnel for a leased proxy
// (TUN/PF) is a later step and does not exist yet — this is the pool and
// exclusive per-device lease only.
// ---- sites ------------------------------------------------------------------------
const publicSite = site => ({ ...site, ...siteLinkHub.siteStatus(site.id) });
const siteError = (res, error) => {
  if (error instanceof SiteError) {
    return res.status(error.code === "unknown_site" ? 404 : error.code === "duplicate_site" ? 409 : 400)
      .json({ error: error.message, code: error.code });
  }
  throw error;
};
function hubOrigin(req) {
  return deployment.publicUrl ? String(deployment.publicUrl).replace(/\/+$/, "") : `${req.protocol}://${req.get("host")}`;
}

app.get("/api/admin/sites", requireCapability(CAPABILITIES.MANAGE_SITES), (req, res) => {
  res.json({ sites: siteStore.list().map(publicSite), defaultTimeZone: schedulingTimeZone });
});

app.post("/api/admin/sites", requireCapability(CAPABILITIES.MANAGE_SITES), (req, res) => {
  try {
    const { site, token } = siteStore.create({ name: req.body?.name, timeZone: req.body?.timeZone || undefined });
    auditLog.logEvent({ operator: req.currentOperator.username, type: "site_created", detail: { siteId: site.id, name: site.name, timeZone: site.timeZone } });
    // The token is shown this once; only its hash is stored.
    res.status(201).json({ site: publicSite(site), token, hubUrl: hubOrigin(req) });
  } catch (error) {
    siteError(res, error);
  }
});

app.patch("/api/admin/sites/:siteId", requireCapability(CAPABILITIES.MANAGE_SITES), (req, res) => {
  try {
    const site = siteStore.update(req.params.siteId, { name: req.body?.name, timeZone: req.body?.timeZone });
    auditLog.logEvent({ operator: req.currentOperator.username, type: "site_updated", detail: { siteId: site.id, name: site.name, timeZone: site.timeZone } });
    broadcastDeviceList();
    res.json({ site: publicSite(site) });
  } catch (error) {
    siteError(res, error);
  }
});

app.post("/api/admin/sites/:siteId/rotate-token", requireCapability(CAPABILITIES.MANAGE_SITES), (req, res) => {
  try {
    const { site, token } = siteStore.rotate(req.params.siteId);
    siteLinkHub.disconnect(site.id); // the agent holding the old token is cut off at once
    auditLog.logEvent({ operator: req.currentOperator.username, type: "site_token_rotated", detail: { siteId: site.id } });
    res.json({ site: publicSite(site), token, hubUrl: hubOrigin(req) });
  } catch (error) {
    siteError(res, error);
  }
});

app.delete("/api/admin/sites/:siteId", requireCapability(CAPABILITIES.MANAGE_SITES), (req, res) => {
  const site = siteStore.get(req.params.siteId);
  if (!site) return res.status(404).json({ error: "Unknown site.", code: "unknown_site" });
  siteLinkHub.removeSite(site.id);
  siteStore.remove(site.id);
  auditLog.logEvent({ operator: req.currentOperator.username, type: "site_removed", detail: { siteId: site.id, name: site.name } });
  res.json({ ok: true });
});

app.get("/api/admin/proxies", requireCapability(CAPABILITIES.VIEW_PROXY_POOL), (req, res) => {
  res.json({ proxies: proxyPoolCache });
});

app.post("/api/admin/proxies", requireCapability(CAPABILITIES.MANAGE_PROXY), (req, res) => {
  if (!proxyCredentialEncryptionKey) {
    return res.status(503).json({ error: "the proxy pool is unavailable until TWO_FACTOR_MASTER_KEY (or PROXY_CREDENTIAL_ENCRYPTION_KEY) is configured" });
  }
  try {
    const record = createProxy(proxyPoolStorePath, {
      provider: req.body?.provider,
      protocol: req.body?.protocol,
      host: req.body?.host,
      port: req.body?.port,
      username: req.body?.username,
      password: req.body?.password,
      country: req.body?.country,
      label: req.body?.label,
    }, proxyCredentialEncryptionKey);
    refreshProxyPoolCache();
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "proxy_pool_created",
      detail: { proxyId: record.id, provider: record.provider, country: record.country },
    });
    res.status(201).json({ proxy: publicProxy(record) });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

function proxyTestFields(body = {}) {
  return {
    protocol: body.protocol,
    host: body.host,
    port: body.port,
    username: body.username,
    password: body.password,
    country: body.country,
  };
}

function proxyTestFailure(res, error) {
  const diagnostic = error?.diagnostic;
  return res.status(error?.status || 502).json({
    error: diagnostic?.name || "Proxy test failed",
    code: diagnostic?.code || "P111",
    diagnostic: diagnostic || null,
  });
}

app.post("/api/admin/proxies/test", requireCapability(CAPABILITIES.MANAGE_PROXY), async (req, res) => {
  try {
    const result = await testProxy(proxyTestFields(req.body));
    res.json({ result });
  } catch (error) {
    proxyTestFailure(res, error);
  }
});

app.post("/api/admin/proxies/:proxyId/test", requireCapability(CAPABILITIES.MANAGE_PROXY), async (req, res) => {
  if (!proxyCredentialEncryptionKey) {
    return res.status(503).json({ error: "proxy testing is unavailable until the credential encryption key is configured" });
  }
  const record = getProxyRecord(proxyPoolStorePath, req.params.proxyId);
  if (!record) return res.status(404).json({ error: "unknown proxy" });
  try {
    const result = await testProxy({
      protocol: record.protocol, host: record.host, port: record.port, username: record.username,
      password: decryptProxyPassword(record, proxyCredentialEncryptionKey), country: record.country,
    });
    updateProxyHealth(proxyPoolStorePath, record.id, result);
    refreshProxyPoolCache();
    auditLog.logEvent({ operator: req.currentOperator.username, type: "proxy_test_succeeded",
      detail: { proxyId: record.id, publicIpv4: result.publicIpv4, country: result.country, latencyMs: result.latencyMs } });
    res.json({ result, proxy: publicProxy(getProxyRecord(proxyPoolStorePath, record.id)) });
  } catch (error) {
    const diagnostic = error?.diagnostic;
    updateProxyHealth(proxyPoolStorePath, record.id, {
      status: "failed", checkedAt: new Date().toISOString(),
      errorCode: diagnostic?.code || "P111", errorName: diagnostic?.name || "Proxy test failed",
    });
    refreshProxyPoolCache();
    auditLog.logEvent({ operator: req.currentOperator.username, type: "proxy_test_failed",
      detail: { proxyId: record.id, errorCode: diagnostic?.code || "P111" } });
    proxyTestFailure(res, error);
  }
});

app.delete("/api/admin/proxies/:proxyId", requireCapability(CAPABILITIES.MANAGE_PROXY), (req, res) => {
  try {
    const deleted = deleteProxy(proxyPoolStorePath, req.params.proxyId);
    if (!deleted) return res.status(404).json({ error: "unknown proxy" });
    refreshProxyPoolCache();
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "proxy_pool_deleted",
      detail: { proxyId: req.params.proxyId },
    });
    res.json({ ok: true });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

app.patch("/api/admin/devices/:deviceId/proxy-assignment", requireCapability(CAPABILITIES.ASSIGN_PROXY), (req, res) => {
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  const proxyId = req.body?.proxyId;
  if (proxyId !== null && typeof proxyId !== "string") {
    return res.status(400).json({ error: "proxyId must be a string or null" });
  }
  try {
    assignProxyToDevice(proxyPoolStorePath, { deviceId: req.params.deviceId, proxyId });
    refreshProxyPoolCache();
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "proxy_pool_assignment_changed",
      deviceId: req.params.deviceId,
      detail: { proxyId },
    });
    broadcastDeviceList();
    res.json({ proxy: poolProxyForDevice(req.params.deviceId) });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

// Network enrollment (Automation Architecture guide §4.4): binding this
// device's UDID to its transient USB Internet-Sharing bridge member. This
// is inherently a two-step, human-paced action — the admin enables
// Internet Sharing for ONE phone at a time BETWEEN these two calls — never
// something a continuous background loop could safely do (guide §7:
// enrollment is sequential per phone precisely so the diff is
// unambiguous). All three enrollment/discovery routes share the routing
// feature's gate (`networkRoutingOrchestrator` existing) since their
// output only matters once that feature is actually configured.
app.post("/api/admin/devices/:deviceId/network-enrollment/start", requireCapability(CAPABILITIES.MANAGE_ROUTING), async (req, res) => {
  if (!networkRoutingOrchestrator) return res.status(409).json({ error: "automatic proxy tunnel routing is not enabled on this relay" });
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  try {
    const before = await listBridgeMembers({ bridgeIface: networkRoutingOrchestrator.bridgeIface });
    networkEnrollmentSnapshots.set(req.params.deviceId, before);
    res.json({ ok: true, before });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/admin/devices/:deviceId/network-enrollment/confirm", requireCapability(CAPABILITIES.MANAGE_ROUTING), async (req, res) => {
  if (!networkRoutingOrchestrator) return res.status(409).json({ error: "automatic proxy tunnel routing is not enabled on this relay" });
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  if (networkRoutingOrchestrator.getRoute(req.params.deviceId)) {
    return res.status(409).json({ error: "stop routing for this device before changing its network identity" });
  }
  const before = networkEnrollmentSnapshots.get(req.params.deviceId);
  if (!before) return res.status(409).json({ error: "call network-enrollment/start first, then enable Internet Sharing for this phone" });
  try {
    const after = await listBridgeMembers({ bridgeIface: networkRoutingOrchestrator.bridgeIface });
    const diff = diffBridgeMembers(before, after);
    if (diff.state !== "assigned") return res.status(409).json({ error: diff.reason, newMembers: diff.newMembers });
    const record = setUsbIface(usbNetworkStorePath, req.params.deviceId, diff.iface);
    refreshUsbNetworkCache(req.params.deviceId);
    networkEnrollmentSnapshots.delete(req.params.deviceId);
    auditLog.logEvent({
      operator: req.currentOperator.username, type: "network_enrollment_confirmed",
      deviceId: req.params.deviceId, detail: { usbIface: diff.iface },
    });
    broadcastDeviceList();
    res.json({ network: record });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/admin/devices/:deviceId/discover-ip", requireCapability(CAPABILITIES.MANAGE_ROUTING), async (req, res) => {
  if (!networkRoutingOrchestrator) return res.status(409).json({ error: "automatic proxy tunnel routing is not enabled on this relay" });
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  if (networkRoutingOrchestrator.getRoute(req.params.deviceId)) {
    return res.status(409).json({ error: "stop routing for this device before changing its network identity" });
  }
  const enrolled = getUsbNetworkRecord(usbNetworkStorePath, req.params.deviceId);
  if (!enrolled) return res.status(409).json({ error: "complete network enrollment for this device first" });
  try {
    const ownIp = await discoverBridgeOwnIp({ bridgeIface: networkRoutingOrchestrator.bridgeIface });
    const capture = await captureDeviceTraffic({ iface: enrolled.usbIface });
    const result = discoverDeviceIp(capture, { excludeIps: [ownIp] });
    if (result.state !== "resolved") return res.status(409).json({ error: result.reason, state: result.state, candidates: result.candidates });
    const record = setUsbIp(usbNetworkStorePath, req.params.deviceId, result.ip);
    refreshUsbNetworkCache(req.params.deviceId);
    auditLog.logEvent({
      operator: req.currentOperator.username, type: "usb_ip_discovered",
      deviceId: req.params.deviceId, detail: { usbIp: result.ip },
    });
    broadcastDeviceList();
    res.json({ network: record });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// The admin supplies the device's already-discovered USB-side IPv4 (or, if
// omitted, this falls back to whatever network-enrollment/discover-ip
// already resolved and persisted above). This route just drives the
// already-built PROXY_LEASED -> TUN_STARTING -> PF_APPLYING -> ROUTED
// state machine for a device that already has a pool proxy leased.
app.post("/api/admin/devices/:deviceId/start-routing", requireCapability(CAPABILITIES.MANAGE_ROUTING), async (req, res) => {
  if (!networkRoutingOrchestrator) return res.status(409).json({ error: "automatic proxy tunnel routing is not enabled on this relay" });
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  const usbIp = req.body?.usbIp || getUsbNetworkRecord(usbNetworkStorePath, req.params.deviceId)?.usbIp;
  if (typeof usbIp !== "string" || !usbIp) {
    return res.status(400).json({ error: "usbIp is required (supply it, or run network enrollment + IP discovery for this device first)" });
  }
  try {
    const route = await networkRoutingOrchestrator.startRouting(req.params.deviceId, { usbIp });
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "routing_started",
      deviceId: req.params.deviceId,
      detail: { state: route.state, tunIface: route.tunIface },
    });
    broadcastDeviceList();
    res.json({ routing: route });
  } catch (error) {
    auditLog.logEvent({
      operator: req.currentOperator.username,
      type: "routing_start_failed",
      deviceId: req.params.deviceId,
      detail: { error: error.message },
    });
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.post("/api/admin/devices/:deviceId/stop-routing", requireCapability(CAPABILITIES.MANAGE_ROUTING), async (req, res) => {
  if (!networkRoutingOrchestrator) return res.status(409).json({ error: "automatic proxy tunnel routing is not enabled on this relay" });
  if (!knownDevice(req.params.deviceId)) return res.status(404).json({ error: "unknown device" });
  if (!canAccessDevice(req.currentOperator, req.params.deviceId)) {
    return res.status(403).json({ error: "not authorized for this device" });
  }
  try {
    await networkRoutingOrchestrator.stopRouting(req.params.deviceId);
    auditLog.logEvent({ operator: req.currentOperator.username, type: "routing_stopped", deviceId: req.params.deviceId });
    broadcastDeviceList();
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: error.message });
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

// ---- MS10: action policy, preset comments, approvals; MS11: session reports ----------------------
const denyUnless = (req, res, capability, message) => {
  if (hasCapability(req.currentOperator, capability)) return false;
  res.status(403).json({ error: message });
  return true;
};

app.get("/api/research/:account/policies", (req, res) => {
  if (denyUnless(req, res, CAPABILITIES.VIEW_RESEARCH, "research access is not permitted for this role")) return;
  res.json({ policies: policyStore.describe(req.params.account, researchActionPolicies) });
});

app.put("/api/research/:account/policies/:action", (req, res) => {
  if (denyUnless(req, res, CAPABILITIES.MANAGE_ACTION_POLICY, "changing action policy requires an administrator")) return;
  try {
    const entry = policyStore.set(req.params.account, req.params.action, req.body?.policy, req.currentOperator.username);
    auditLog.logEvent({ operator: req.currentOperator.username, type: "action_policy_changed",
      detail: { workspaceId: req.researchWorkspaceId, account: req.params.account, action: req.params.action, policy: entry.value } });
    res.json({ policy: { action: req.params.action, policy: entry.value, source: "runtime" } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/research/:account/templates", (req, res) => {
  if (denyUnless(req, res, CAPABILITIES.VIEW_RESEARCH, "research access is not permitted for this role")) return;
  res.json({ templates: templateLibrary.list(req.researchWorkspaceId) });
});

app.post("/api/research/:account/templates", (req, res) => {
  if (denyUnless(req, res, CAPABILITIES.MANAGE_ACTION_POLICY, "managing preset comments requires an administrator")) return;
  try {
    const template = templateLibrary.add({ workspaceId: req.researchWorkspaceId, text: req.body?.text, tags: req.body?.tags, createdBy: req.currentOperator.username });
    auditLog.logEvent({ operator: req.currentOperator.username, type: "comment_template_added",
      detail: { workspaceId: req.researchWorkspaceId, templateId: template.id } });
    res.status(201).json({ template });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/research/:account/templates/:templateId", (req, res) => {
  if (denyUnless(req, res, CAPABILITIES.MANAGE_ACTION_POLICY, "managing preset comments requires an administrator")) return;
  if (!templateLibrary.remove(req.researchWorkspaceId, req.params.templateId)) return res.status(404).json({ error: "template not found" });
  auditLog.logEvent({ operator: req.currentOperator.username, type: "comment_template_removed",
    detail: { workspaceId: req.researchWorkspaceId, templateId: req.params.templateId } });
  res.json({ ok: true });
});

const ownApproval = (req, id) => {
  const approval = approvalStore.get(id);
  return approval && approval.workspaceId === req.researchWorkspaceId && approval.accountId === req.params.account ? approval : null;
};

app.get("/api/research/:account/approvals", (req, res) => {
  if (denyUnless(req, res, CAPABILITIES.VIEW_RESEARCH, "research access is not permitted for this role")) return;
  const states = typeof req.query.state === "string" ? req.query.state.split(",").map(value => value.trim().toUpperCase()) : null;
  res.json({ approvals: approvalStore.list({ workspaceId: req.researchWorkspaceId, states })
    .filter(approval => approval.accountId === req.params.account) });
});

app.post("/api/research/:account/approvals/:id/:decision(approve|reject)", (req, res) => {
  if (denyUnless(req, res, CAPABILITIES.APPROVE_ACTIONS, "approving AI actions requires a manager or administrator")) return;
  if (!ownApproval(req, req.params.id)) return res.status(404).json({ error: "approval not found" });
  try {
    const approval = approvalStore.decide(req.params.id, { decision: req.params.decision, decidedBy: req.currentOperator.username, reason: req.body?.reason });
    try {
      auditLog.logEvent({ operator: req.currentOperator.username, type: "approval_decided",
        detail: { workspaceId: approval.workspaceId, account: approval.accountId, approvalId: approval.id, action: approval.action,
          target: approval.target, decision: approval.state, taskId: approval.taskId } });
    } catch (error) {
      // The approval decision is already durably committed. Do not turn an
      // audit-disk problem into a misleading failed response (or an
      // unhandled Express 4 async rejection) that invites a conflicting
      // retry of the now-final decision.
      console.error("Approval decision audit failed:", error);
    }
    res.json({ approval, note: approval.state === "APPROVED"
      ? "Approved. The action runs the next time the paused task is resumed and reaches this step." : "Rejected." });
  } catch (error) {
    if (error instanceof ApprovalError) return res.status(error.code === "unknown_approval" ? 404 : 409).json({ error: error.message, code: error.code });
    throw error;
  }
});

// MS13.4: search and near-duplicate lookup over this account's own recorded candidates.
app.get("/api/research/:account/search", (req, res) => {
  if (denyUnless(req, res, CAPABILITIES.VIEW_RESEARCH, "research access is not permitted for this role")) return;
  const runs = listRuns(req.researchWorkspaceId, req.params.account);
  if (runs === null) return res.status(404).json({ error: "unknown account" });
  const index = ResearchIndex.fromRuns(runs);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  if (typeof req.query.similarTo === "string" && req.query.similarTo) {
    const anchor = [...index.docs.values()].map(doc => doc.candidate).find(candidate => candidate.id === req.query.similarTo);
    if (!anchor) return res.status(404).json({ error: "candidate not found" });
    return res.json({ similarTo: anchor.id, matches: index.findNearDuplicates(anchor).slice(0, limit) });
  }
  const query = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
  if (!query.trim()) return res.status(400).json({ error: "a search query (q) or similarTo is required" });
  res.json({ query, indexed: index.size, results: index.search(query, { limit }) });
});

app.get("/api/research/:account/runs/:runId/report", (req, res) => {
  if (denyUnless(req, res, CAPABILITIES.VIEW_RESEARCH, "research access is not permitted for this role")) return;
  const run = getRun(req.researchWorkspaceId, req.params.account, req.params.runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json({ report: run.session ?? null, outcome: run.outcome ?? null, finished: Boolean(run.completedAt) });
});

// ---- MS12: centralised AI-fleet monitoring and the human intervention queue ------------------------
const visibleAccount = (req, accountId) => Boolean(accountId) && Boolean(researchWorkspaceFor(req.currentOperator, accountId));

app.get("/api/fleet/ai", requireCapability(CAPABILITIES.MANAGE_QUEUE), (req, res) => {
  const snapshot = fleetPolicy.snapshot();
  const workers = snapshot.workers.filter(worker => visibleAccount(req, worker.accountId)).map(worker => {
    const budget = researchTaskRunner.sessionBudget(worker.taskId);
    return { ...worker, session: budget ? { steps: budget.state.steps, keptCandidates: budget.state.keptCandidates,
      costUsd: budget.state.costUsd, minutes: Math.round(budget.minutesElapsed() * 10) / 10, failuresInARow: budget.state.consecutiveFailures } : null };
  });
  const open = interventionQueue.list({ states: ["OPEN", "CLAIMED"] }).filter(item => visibleAccount(req, item.accountId));
  res.json({ workers, activeWorkers: workers.length, limits: snapshot.limits, spentLastHourUsd: snapshot.spentLastHourUsd,
    interventions: { open: open.filter(item => item.state === "OPEN").length, claimed: open.filter(item => item.state === "CLAIMED").length } });
});

// MS13.4: why people were needed, how fast they were picked up, and what optimization saved.
app.get("/api/fleet/analytics", requireCapability(CAPABILITIES.MANAGE_QUEUE), (req, res) => {
  const items = interventionQueue.list().filter(item => visibleAccount(req, item.accountId));
  const steps = researchTaskRunner.sessionSummaries()
    .filter(summary => visibleAccount(req, taskQueue.getTask(summary.taskId)?.accountSelector?.accountId))
    .reduce((total, summary) => total + summary.steps, 0);
  res.json({ interventions: analyzeInterventions(items, { steps: steps || null }), optimizations: optimizationRuntime.describe() });
});

app.get("/api/fleet/interventions", requireCapability(CAPABILITIES.MANAGE_QUEUE), (req, res) => {
  const states = typeof req.query.state === "string" ? req.query.state.split(",").map(value => value.trim().toUpperCase()) : ["OPEN", "CLAIMED"];
  res.json({ interventions: interventionQueue.list({ states }).filter(item => visibleAccount(req, item.accountId)) });
});

function interventionAction(action) {
  return (req, res) => {
    const item = interventionQueue.list().find(entry => entry.id === req.params.id);
    if (!item || !visibleAccount(req, item.accountId)) return res.status(404).json({ error: "intervention not found" });
    try {
      const updated = action === "claim"
        ? interventionQueue.claim(item.id, req.currentOperator.username)
        : interventionQueue.resolve(item.id, { by: req.currentOperator.username, resolution: req.body?.resolution });
      auditLog.logEvent({ operator: req.currentOperator.username, type: `intervention_${action}`, deviceId: item.deviceId,
        detail: { interventionId: item.id, taskId: item.taskId, accountId: item.accountId, kind: item.kind } });
      res.json({ intervention: updated });
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  };
}
app.post("/api/fleet/interventions/:id/claim", requireCapability(CAPABILITIES.MANAGE_QUEUE), interventionAction("claim"));
app.post("/api/fleet/interventions/:id/resolve", requireCapability(CAPABILITIES.MANAGE_QUEUE), interventionAction("resolve"));

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
  if (operator.role !== OPERATOR_ROLES.ADMIN && task.createdBy !== operator.username) {
    const creator = operatorByUsername(task.createdBy);
    if (operator.role !== OPERATOR_ROLES.MANAGER || !operator.teamId
      || !creator?.teamId || creator.teamId !== operator.teamId) {
      return "not authorized for that task's team";
    }
  }
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

function taskAccessResult(error) {
  return { error, status: error === "unknown task" ? 400 : 403 };
}

// The direct WebSocket actions (switch_to_ai/takeover/emergency_stop) already
// gate on this via requireAiManagerWs; the command-console equivalents below
// (mode/ai_pause/ai_resume/ai_stop/ai_takeover) must enforce the same
// capability themselves — the route only requires MANAGE_QUEUE, which is not
// the same grant, so without this a manager could reach every AI-controller
// action through the console even though the client hides those controls.
function aiControllerCapabilityError(operator) {
  return hasCapability(operator, CAPABILITIES.MANAGE_AI_CONTROLLER)
    ? null
    : { error: "AI-controller management capability required.", status: 403 };
}

function activeDeviceTaskAccessError(deviceId, operator) {
  const task = taskQueue.listTasks().find(candidate => candidate.deviceSelector?.deviceId === deviceId
    && ["RUNNING", "PAUSED"].includes(candidate.state));
  return task ? taskAccessError(task.id, operator) : null;
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

async function executeCommand(parsed, operator, workspaceDeviceId = null, clientRequestId = null) {
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
        clientRequestId,
      });
      return { task };
    }

    case "queue_add": {
      const inner = parseCommand(parsed.commandText, new Date(), { timeZone: schedulingTimeZone });
      if (inner.error) return { error: inner.error };
      if (inner.type !== "time" && inner.type !== "cresearch") {
        return { error: "/queue add requires a /time or /cresearch command" };
      }
      return executeCommand(inner, operator, workspaceDeviceId, clientRequestId);
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
      if (denied) return taskAccessResult(denied);
      const task = taskQueue.cancelTask(parsed.taskId);
      return task ? { task } : { error: "unknown task" };
    }

    case "queue_move": {
      const denied = taskAccessError(parsed.taskId, operator);
      if (denied) return taskAccessResult(denied);
      const targetDenied = taskAccessError(parsed.targetId, operator);
      if (targetDenied) return taskAccessResult(targetDenied);
      const ok = taskQueue.moveTask(parsed.taskId, parsed.relation, parsed.targetId);
      return ok ? { ok: true } : { error: "unknown task id(s)" };
    }

    case "queue_priority": {
      const denied = taskAccessError(parsed.taskId, operator);
      if (denied) return taskAccessResult(denied);
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
        if (denied) return taskAccessResult(denied);
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
      const events = authorizedAuditEvents(operator, {
        deviceId: parsed.filterType === "device" ? parsed.value : undefined,
        operator: parsed.filterType === "operator" ? parsed.value : undefined,
        limit: parsed.limit ?? undefined,
      });
      return { events };
    }

    case "mode": {
      const denied = deviceAccessError(parsed.deviceId, operator);
      if (denied) return { error: denied };
      const capabilityDenied = aiControllerCapabilityError(operator);
      if (capabilityDenied) return capabilityDenied;
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
        const taskDenied = activeDeviceTaskAccessError(parsed.deviceId, operator);
        if (taskDenied) return taskAccessResult(taskDenied);
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
      const capabilityDenied = aiControllerCapabilityError(operator);
      if (capabilityDenied) return capabilityDenied;
      const taskDenied = activeDeviceTaskAccessError(parsed.deviceId, operator);
      if (taskDenied) return taskAccessResult(taskDenied);
      const task = taskQueue.pauseDevice(parsed.deviceId);
      if (task) broadcastDeviceList();
      return task ? { task } : { error: "no running task on that device" };
    }

    case "ai_resume": {
      const denied = deviceAccessError(parsed.deviceId, operator);
      if (denied) return { error: denied };
      const capabilityDenied = aiControllerCapabilityError(operator);
      if (capabilityDenied) return capabilityDenied;
      const taskDenied = activeDeviceTaskAccessError(parsed.deviceId, operator);
      if (taskDenied) return taskAccessResult(taskDenied);
      const task = taskQueue.resumeDevice(parsed.deviceId);
      if (task) broadcastDeviceList();
      return task ? { task } : { error: "no paused task on that device" };
    }

    case "ai_stop": {
      const denied = deviceAccessError(parsed.deviceId, operator);
      if (denied) return { error: denied };
      const capabilityDenied = aiControllerCapabilityError(operator);
      if (capabilityDenied) return capabilityDenied;
      const taskDenied = activeDeviceTaskAccessError(parsed.deviceId, operator);
      if (taskDenied) return taskAccessResult(taskDenied);
      const task = taskQueue.stopDevice(parsed.deviceId);
      auditLog.logEvent({ operator: operator.username, type: "ai_stop", deviceId: parsed.deviceId });
      broadcastDeviceList();
      return { task: task ?? null };
    }

    case "ai_takeover": {
      const denied = deviceAccessError(parsed.deviceId, operator);
      if (denied) return { error: denied };
      const capabilityDenied = aiControllerCapabilityError(operator);
      if (capabilityDenied) return capabilityDenied;
      const taskDenied = activeDeviceTaskAccessError(parsed.deviceId, operator);
      if (taskDenied) return taskAccessResult(taskDenied);
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
    const clientRequestId = req.body?.requestId ?? null;
    if (clientRequestId !== null
      && (typeof clientRequestId !== "string" || !/^[A-Za-z0-9_.:-]{8,200}$/.test(clientRequestId))) {
      return res.status(400).json({ error: "requestId must be 8-200 safe characters" });
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
    const parsed = parseCommand(text, new Date(), { timeZone: schedulingTimeZone });
    const result = await executeCommand(parsed, req.currentOperator, workspaceDeviceId, clientRequestId);
    res.status(result.status ?? (result.error ? 400 : 200)).json(result);
  } catch (error) { next(error); }
});

app.get("/api/queue", requireCapability(CAPABILITIES.MANAGE_QUEUE), (req, res) => {
  res.json({ tasks: taskQueue.listTasks().filter(task => !taskAccessError(task.id, req.currentOperator)),
    paused: taskQueue.isPaused(), scheduler: schedulerGuard.status() });
});

// Without this, a multer failure (oversized file, invalid filename/device id
// from the storage callbacks) falls through to Express's default HTML error
// page instead of the JSON the client expects.
app.use((err, req, res, next) => {
  if (!err) return next();
  // The client sent something the JSON body parser cannot use. That is the caller's mistake (400/413), not a
  // server failure: without these branches every such request was reported as a 500 "request failed".
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "the request body is not valid JSON", code: "INVALID_JSON" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "the request body is too large", code: "PAYLOAD_TOO_LARGE" });
  if (["encoding.unsupported", "charset.unsupported", "request.aborted", "request.size.invalid"].includes(err.type)) {
    return res.status(Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 400)
      .json({ error: "the request could not be read", code: "BAD_REQUEST" });
  }
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "file too large" });
  if (err.code?.startsWith("MEDIA_")) {
    return res.status(err.statusCode ?? 400).json({ error: err.message, code: err.code, ...err.detail });
  }
  if (err.name === "MulterError" || new Set(["invalid filename", "invalid device id"]).has(err.message)) {
    return res.status(400).json({ error: "invalid upload" });
  }
  console.error("Request failed:", err?.code || err?.name || "Error");
  res.status(500).json({ error: "request failed", code: "INTERNAL_ERROR" });
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

async function refreshWdaReadiness() {
  const candidates = [...devices.values()].filter(device => device instanceof WdaDevice && device.status !== "in-use");
  const previous = new Map(candidates.map(device => [device.id,
    `${device.status}:${device.readiness?.state}:${device.readiness?.consecutiveFailures}`]));
  await Promise.all(candidates.map(device => device.checkReadiness()));
  if (candidates.some(device => previous.get(device.id)
    !== `${device.status}:${device.readiness?.state}:${device.readiness?.consecutiveFailures}`)) broadcastDeviceList();
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
// The listening HTTP server is the process-lifetime authority. Keeping this
// maintenance timer referenced makes import-based tools and tests hang if a
// WebSocketServer close event is delayed or never emitted.
heartbeatTimer.unref?.();
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
  let liveFramePending = false;
  let selectionGeneration = 0;

  // ---- live video subscription (at most one per connection) -------------------
  let streamSubscription = null;
  let streamTarget = null;
  let streamSeq = 0; // stamped into every binary frame so a stale stream's frames can be ignored
  let streamSessionTimer = null;
  let streamPendingFrame = null; // newest frame skipped for backpressure
  let streamFlushTimer = null;
  const stopStream = ({ notify = false, reason = "stopped" } = {}) => {
    if (!streamSubscription && !streamTarget) return false;
    const stoppedId = streamTarget?.id;
    streamSubscription?.unsubscribe();
    streamSubscription = null;
    streamTarget = null;
    clearInterval(streamSessionTimer);
    clearTimeout(streamFlushTimer);
    streamSessionTimer = null;
    streamFlushTimer = null;
    streamPendingFrame = null;
    if (notify && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "stream_stopped", deviceId: stoppedId, reason }));
    }
    return true;
  };
  const sendStreamPacket = (streamId, frame) => {
    const kind = frameKind(frame);
    if (kind === 0 || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > STREAM_BACKPRESSURE_BYTES) {
      // Keep only the newest skipped frame and retry shortly, so a screen that
      // then goes still still ends on its final picture.
      streamPendingFrame = frame;
      if (!streamFlushTimer) {
        streamFlushTimer = setTimeout(() => {
          streamFlushTimer = null;
          const pending = streamPendingFrame;
          streamPendingFrame = null;
          if (pending && streamSubscription && streamSeq === streamId) sendStreamPacket(streamId, pending);
        }, STREAM_FLUSH_RETRY_MS);
        streamFlushTimer.unref?.();
      }
      return;
    }
    streamPendingFrame = null;
    const packet = Buffer.allocUnsafe(frame.length + 5);
    packet[0] = kind;
    packet.writeUInt32BE(streamId, 1);
    frame.copy(packet, 5);
    ws.send(packet, { binary: true });
  };

  const releaseSelection = () => {
    if (streamTarget && streamTarget === selected) stopStream();
    const hadSelection = Boolean(selected);
    if (selected && humanOwners.get(selected.id) === ws) {
      humanOwners.delete(selected.id);
      releaseDevice(selected);
    }
    selected = null;
    if (hadSelection) selectionGeneration += 1;
    presenceStore.setDevice(ws.presenceConnectionId, null);
  };
  const selectedAccessActive = (target = selected) => Boolean(target)
    && hasCapability(currentOperator(), CAPABILITIES.CONTROL_DEVICE)
    && canAccessDevice(currentOperator(), target.id)
    && humanOwners.get(target.id) === ws
    && deviceLease.canHumanSelect(target.id)
    && networkDecision(target.id).allowed;
  const selectionAccessActive = (target, generation) => selected === target
    && selectionGeneration === generation && selectedAccessActive(target);
  const revokeSelectedAccess = (action, target = selected, generation = selectionGeneration) => {
    if (!selected || selected !== target || selectionGeneration !== generation) return false;
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
    return true;
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
    if (streamTarget && streamTarget === watched) stopStream();
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
  const reportError = (message, target = selected, generation = selectionGeneration, { code, requestId } = {}) => {
    if (!target || selected !== target || selectionGeneration !== generation) return;
    if (!selectedAccessActive(target)) {
      revokeSelectedAccess("device_error", target, generation);
      return;
    }
    ws.send(JSON.stringify({ type: "error", deviceId: target.id, message,
      ...(code ? { code } : {}), ...(Number.isSafeInteger(requestId) ? { requestId } : {}) }));
    const failures = recordFailure(target.id);
    if (failures >= OFFLINE_AFTER_FAILURES && target.status !== "offline") {
        const offlineId = target.id;
        target.status = "offline";
        auditLog.logEvent({ operator: operator.username, type: "device_became_offline", deviceId: offlineId,
          detail: { consecutiveFailures: failures } });
        releaseSelection();
        broadcastDeviceList();
        broadcastPresence();
    }
  };
  const reportTransportError = (error, target, generation) => {
    console.error(`Device transport failed for ${target.id}:`, error?.code || error?.name || "Error");
    reportError(`Couldn't reach ${target.label}.`, target, generation);
  };
  const reportInputTransportError = (error, target, generation, msg) => {
    if (error?.code === "SITE_OFFLINE") {
      // RemoteDevice rejects before sending an RPC when the site link is
      // already down, so this case is definite rather than uncertain.
      reportTransportError(error, target, generation);
      return;
    }
    console.error(`Device input result uncertain for ${target.id}:`, error?.code || error?.name || "Error");
    reportError(
      `The connection to ${target.label} was lost while sending this action. It may have reached the phone. Refresh the screen before deciding whether to repeat it.`,
      target,
      generation,
      { code: "action_result_uncertain", requestId: msg?.requestId },
    );
  };

  const sendFrame = async ({ appliedAction = null, requestId = null } = {}) => {
    if (!selected || ws.readyState !== ws.OPEN) return;
    const target = selected;
    const generation = selectionGeneration;
    const authorize = () => selectionAccessActive(target, generation);
    if (!await ws.validateSession()) return;
    if (!authorize()) {
      revokeSelectedAccess("render", target, generation);
      return;
    }
    try {
      const frame = await target.render({ authorize });
      if (!await ws.validateSession()) return;
      if (!authorize()) {
        revokeSelectedAccess("render_result", target, generation);
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
      if (err?.code === "DEVICE_ACCESS_REVOKED") {
        revokeSelectedAccess("render", target, generation);
        return;
      }
      if (appliedAction) {
        console.error(`Screen refresh failed after ${appliedAction} for ${target.id}:`, err?.code || err?.name || "Error");
        ws.send(JSON.stringify({ type: "error", code: "action_applied_refresh_failed",
          deviceId: target.id, requestId, action: appliedAction, actionApplied: true,
          message: `${appliedAction} reached ${target.label}, but the updated screen could not be loaded. Refresh the screen before deciding whether to repeat it.` }));
        const failures = recordFailure(target.id);
        if (failures >= OFFLINE_AFTER_FAILURES && target.status !== "offline") {
          target.status = "offline";
          releaseSelection();
          broadcastDeviceList();
          broadcastPresence();
        }
      } else reportTransportError(err, target, generation);
    }
  };

  // Live view is intentionally outside the per-connection input queue. A
  // slow WDA screenshot must not sit in front of a tap, swipe, Home, or text
  // command. The client also suppresses overlapping polls, but this guard is
  // required at the trust boundary in case a stale or custom client sends
  // another refresh while the first one is still running.
  const handleLiveFrame = async (msg) => {
    const requestId = Number.isSafeInteger(msg.requestId) && msg.requestId > 0 ? msg.requestId : null;
    if (requestId === null) return;
    if (!await ws.validateSession()) return;
    if (!selected || msg.deviceId !== selected.id) {
      ws.send(JSON.stringify({ type: "live_frame_error", code: "live_view_inactive",
        deviceId: msg.deviceId, requestId, message: "No matching controlled device is active." }));
      return;
    }
    const target = selected;
    if (!(target instanceof WdaDevice) && !(target.isRemote === true && target.type === "wda")) {
      ws.send(JSON.stringify({ type: "live_frame_error", code: "live_view_unsupported",
        deviceId: target.id, requestId, message: "Live view is available only for WDA devices." }));
      return;
    }
    const generation = selectionGeneration;
    const authorize = () => selectionAccessActive(target, generation);
    if (!authorize()) {
      revokeSelectedAccess("refresh_live_frame", target, generation);
      return;
    }

    const now = Date.now();
    const nextAllowedAt = Math.max(
      liveFrameNextByDevice.get(target.id) ?? 0,
      liveFrameNextByOperator.get(operator.username) ?? 0
    );
    if (now < nextAllowedAt || activeLiveFrames >= MAX_CONCURRENT_LIVE_FRAMES) {
      ws.send(JSON.stringify({ type: "live_frame_delayed", deviceId: target.id, requestId,
        retryAfterMs: Math.max(1, nextAllowedAt - now) }));
      return;
    }
    liveFrameNextByDevice.set(target.id, now + LIVE_FRAME_MIN_INTERVAL_MS);
    liveFrameNextByOperator.set(operator.username, now + LIVE_FRAME_MIN_INTERVAL_MS);
    activeLiveFrames += 1;
    try {
      const frame = await target.render({ authorize });
      if (!await ws.validateSession()) return;
      if (!authorize()) {
        revokeSelectedAccess("live_frame_result", target, generation);
        return;
      }
      ws.send(JSON.stringify({ type: "live_frame", deviceId: target.id, requestId, ...frame }));
      for (const client of wss.clients) {
        if (client === ws) continue;
        const delivery = client.deliverWatchedFrame?.(target, frame);
        delivery?.catch?.(() => {});
      }
    } catch (error) {
      if (!await ws.validateSession()) return;
      if (!authorize()) {
        revokeSelectedAccess("live_frame_failure", target, generation);
        return;
      }
      console.error(`Live frame capture failed for ${target.id}:`, error?.code || error?.name || "Error");
      ws.send(JSON.stringify({ type: "live_frame_error", code: "live_frame_failed",
        deviceId: target.id, requestId, message: "Could not refresh the live screen. Manual controls remain available." }));
    } finally {
      activeLiveFrames -= 1;
    }
  };

  // Per-frame gate for live video. Cheap and synchronous on purpose (it runs at
  // the stream frame rate); the slower session-store check runs on a timer.
  const deliverStreamFrame = (target, streamId, frame) => {
    if (streamSeq !== streamId || ws.readyState !== ws.OPEN) return;
    if (selected === target) {
      if (!selectedAccessActive(target)) {
        revokeSelectedAccess("stream_frame", target, selectionGeneration);
        return;
      }
    } else if (watched === target) {
      if (!watchAccessActive(target)) {
        clearWatch("stream_frame", { notify: true });
        return;
      }
    } else {
      stopStream();
      return;
    }
    sendStreamPacket(streamId, frame);
  };

  // With live video running the phone's new state is already on its way to the
  // operator, so an input is just acknowledged; without it (older client, device
  // that cannot stream) the classic follow-up screenshot is sent.
  const afterAction = async (label, msg) => {
    const requestId = Number.isSafeInteger(msg.requestId) ? msg.requestId : null;
    if (streamSubscription && streamTarget && streamTarget === selected) {
      ws.send(JSON.stringify({ type: "action_ack", deviceId: selected.id, requestId, action: label }));
      return;
    }
    await sendFrame({ appliedAction: label, requestId });
  };

  // One authorised device input (used by the gesture messages). Same contract as
  // the tap/swipe handlers: authorise before and after the device call, audit,
  // record health, then acknowledge or refresh the picture.
  const performInput = async (msg, { label, auditType, detail = {}, run }) => {
    const target = selected;
    const generation = selectionGeneration;
    const authorize = () => selectionAccessActive(target, generation);
    try {
      await run(target, authorize);
      if (!await ws.validateSession()) return;
      if (!authorize()) {
        revokeSelectedAccess(`${msg.type}_result`, target, generation);
        return;
      }
      auditLog.logEvent({
        operator: operator.username,
        type: auditType,
        deviceId: target.id,
        detail: withNetworkEgress(target.id, detail),
      });
      recordSuccess(target.id);
      await afterAction(label, msg);
    } catch (err) {
      if (err?.code === "DEVICE_ACCESS_REVOKED") revokeSelectedAccess(msg.type, target, generation);
      else reportInputTransportError(err, target, generation, msg);
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
    selectionGeneration += 1;
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
  let queuedMessages = 0;
  const enqueue = (fn) => {
    queuedMessages += 1;
    actionQueue = actionQueue.then(fn).catch((err) => {
      console.error("Unexpected error in connection message queue:", err);
    }).finally(() => { queuedMessages -= 1; });
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
        console.error("Initial watch render failed:", error?.code || error?.name || "Error");
        ws.send(JSON.stringify({ type: "error", code: "watch_start_failed", deviceId: target.id,
          message: "Could not load the live screen." }));
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
        console.error("Watch refresh failed:", error?.code || error?.name || "Error");
        ws.send(JSON.stringify({ type: "error", code: "watch_refresh_failed", deviceId: target.id,
          message: "Could not refresh the live screen." }));
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
      const taskDenied = activeDeviceTaskAccessError(msg.deviceId, currentOperator());
      if (taskDenied) {
        ws.send(JSON.stringify({ type: "error", code: "task_scope_denied", deviceId: msg.deviceId,
          message: taskDenied }));
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
      const taskDenied = activeDeviceTaskAccessError(msg.deviceId, currentOperator());
      if (taskDenied) {
        ws.send(JSON.stringify({ type: "error", code: "task_scope_denied", deviceId: msg.deviceId,
          message: taskDenied }));
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

    // Live video for whichever phone this connection controls or watches.
    if (msg.type === "start_stream") {
      const target = selected && msg.deviceId === selected.id ? selected
        : watched && msg.deviceId === watched.id ? watched : null;
      if (!target) {
        ws.send(JSON.stringify({ type: "error", code: "stream_denied", deviceId: msg.deviceId,
          message: "Select or watch this phone before starting its live view." }));
        return;
      }
      if (target === selected ? !selectedAccessActive(target) : !watchAccessActive(target)) {
        if (target === selected) revokeSelectedAccess("start_stream");
        else clearWatch("start_stream", { notify: true });
        return;
      }
      if (!streamHub.supports(target)) {
        ws.send(JSON.stringify({ type: "stream_unsupported", deviceId: target.id }));
        return;
      }
      stopStream();
      streamSeq += 1;
      const streamId = streamSeq;
      ws.send(JSON.stringify({ type: "stream_started", deviceId: target.id, streamId,
        mode: target === selected ? "control" : "watch" }));
      streamTarget = target;
      let subscription;
      try {
        subscription = streamHub.subscribe(target, {
          onFrame: frame => deliverStreamFrame(target, streamId, frame),
          onState: (state, detail) => {
            if (streamSeq !== streamId || ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ type: "stream_state", deviceId: target.id, streamId, state, detail: detail ?? null }));
          },
        });
      } catch (error) {
        if (streamTarget === target && streamSeq === streamId) streamTarget = null;
        console.error("Live stream open failed:", error?.code || error?.name || "Error");
        ws.send(JSON.stringify({ type: "stream_state", deviceId: target.id, streamId,
          state: "error", detail: "Could not start live video. Try again." }));
        return;
      }
      if (!subscription || streamSeq !== streamId || (selected !== target && watched !== target)) {
        subscription?.unsubscribe();
        if (streamTarget === target && streamSeq === streamId) streamTarget = null;
        return;
      }
      streamSubscription = subscription;
      streamSessionTimer = setInterval(() => {
        void ws.validateSession().then(valid => { if (!valid) stopStream(); }).catch(() => {});
      }, STREAM_SESSION_RECHECK_MS);
      streamSessionTimer.unref?.();
      return;
    }

    if (msg.type === "stop_stream") {
      stopStream();
      return;
    }

    if (["tap", "swipe", "home", "type_text", "release_device", "drag", "long_press", "double_tap"].includes(msg.type) && watched && !selected) {
      auditLog.logEvent({ operator: operator.username, type: "device_watch_input_denied", deviceId: msg.deviceId ?? watched.id,
        detail: { action: msg.type } });
      ws.send(JSON.stringify({ type: "error", code: "watch_read_only", deviceId: msg.deviceId ?? watched.id,
        message: "Live watching is read-only." }));
      return;
    }

    if (["tap", "swipe", "home", "type_text", "refresh_screen", "drag", "long_press", "double_tap"].includes(msg.type) && selected) {
      if (msg.deviceId !== undefined && msg.deviceId !== selected.id) {
        ws.send(JSON.stringify({ type: "error", deviceId: msg.deviceId, message: "Stale device input rejected." }));
        return;
      }
      if (!selectedAccessActive(selected)) {
        revokeSelectedAccess(msg.type);
        return;
      }
    }

    const rejectInvalidInput = (message) => {
      ws.send(JSON.stringify({ type: "error", code: "invalid_input", deviceId: selected?.id,
        requestId: Number.isSafeInteger(msg.requestId) ? msg.requestId : undefined, message }));
    };

    if (msg.type === "refresh_screen" && selected) {
      await sendFrame({ requestId: Number.isSafeInteger(msg.requestId) ? msg.requestId : null });
      return;
    }

    if (msg.type === "tap" && selected) {
      // Never forward unvalidated coordinates to a device — for a real WDA
      // device this becomes an actual pixel tap on an actual phone, so a
      // malformed message (NaN, missing, out of range) must stop here
      // rather than silently propagate.
      const isUnitCoord = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
      if (!isUnitCoord(msg.x) || !isUnitCoord(msg.y)) {
        rejectInvalidInput("Tap coordinates must be within the visible phone screen.");
        return;
      }

      const target = selected;
      const generation = selectionGeneration;
      const authorize = () => selectionAccessActive(target, generation);
      try {
        await target.tap(msg.x, msg.y, { authorize });
        if (!await ws.validateSession()) return;
        if (!authorize()) {
          revokeSelectedAccess("tap_result", target, generation);
          return;
        }
        auditLog.logEvent({
          operator: operator.username,
          type: "action_tap",
          deviceId: target.id,
          detail: withNetworkEgress(target.id, { x: msg.x, y: msg.y }),
        });
        recordSuccess(target.id);
        await afterAction("Tap", msg);
      } catch (err) {
        if (err?.code === "DEVICE_ACCESS_REVOKED") revokeSelectedAccess("tap", target, generation);
        else reportInputTransportError(err, target, generation, msg);
      }
      return;
    }

    if (msg.type === "swipe" && selected) {
      const directions = ["up", "down", "left", "right"];
      if (!directions.includes(msg.direction)) {
        rejectInvalidInput("Swipe direction must be up, down, left, or right.");
        return;
      }

      const target = selected;
      const generation = selectionGeneration;
      const authorize = () => selectionAccessActive(target, generation);
      try {
        await target.swipe(msg.direction, { authorize });
        if (!await ws.validateSession()) return;
        if (!authorize()) {
          revokeSelectedAccess("swipe_result", target, generation);
          return;
        }
        auditLog.logEvent({
          operator: operator.username,
          type: "action_swipe",
          deviceId: target.id,
          detail: withNetworkEgress(target.id, { direction: msg.direction }),
        });
        recordSuccess(target.id);
        await afterAction("Swipe", msg);
      } catch (err) {
        if (err?.code === "DEVICE_ACCESS_REVOKED") revokeSelectedAccess("swipe", target, generation);
        else reportInputTransportError(err, target, generation, msg);
      }
      return;
    }

    if (msg.type === "home" && selected) {
      const target = selected;
      const generation = selectionGeneration;
      const authorize = () => selectionAccessActive(target, generation);
      try {
        await target.pressHome({ authorize });
        if (!await ws.validateSession()) return;
        if (!authorize()) {
          revokeSelectedAccess("home_result", target, generation);
          return;
        }
        auditLog.logEvent({
          operator: operator.username,
          type: "action_home",
          deviceId: target.id,
          detail: withNetworkEgress(target.id),
        });
        recordSuccess(target.id);
        await afterAction("Home", msg);
      } catch (err) {
        if (err?.code === "DEVICE_ACCESS_REVOKED") revokeSelectedAccess("home", target, generation);
        else reportInputTransportError(err, target, generation, msg);
      }
      return;
    }

    if (msg.type === "type_text" && selected) {
      // Cap length — this goes straight to the keyboard on a real device;
      // no reason to accept an unbounded payload.
      if (typeof msg.text !== "string" || msg.text.length === 0 || msg.text.length > 1000) {
        rejectInvalidInput("Text input must contain between 1 and 1,000 characters.");
        return;
      }

      const target = selected;
      const generation = selectionGeneration;
      const authorize = () => selectionAccessActive(target, generation);
      try {
        await target.typeText(msg.text, { authorize });
        if (!await ws.validateSession()) return;
        if (!authorize()) {
          revokeSelectedAccess("type_text_result", target, generation);
          return;
        }
        // Length only, never the text itself — this goes straight to a
        // real keyboard and the audit log isn't the place to retain that.
        auditLog.logEvent({
          operator: operator.username,
          type: "action_type_text",
          deviceId: target.id,
          detail: withNetworkEgress(target.id, { length: msg.text.length }),
        });
        recordSuccess(target.id);
        await afterAction("Text input", msg);
      } catch (err) {
        if (err?.code === "DEVICE_ACCESS_REVOKED") revokeSelectedAccess("type_text", target, generation);
        else reportInputTransportError(err, target, generation, msg);
      }
      return;
    }

    // Mouse/touch gestures from the phone-shaped control surface. Coordinates are
    // 0..1 of the phone screen and are validated here, at the trust boundary,
    // because a real WDA device turns them into real touches.
    if (["drag", "long_press", "double_tap"].includes(msg.type) && selected) {
      const isUnit = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
      const boundedMs = (value, fallback, min, max) => typeof value === "number" && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value)) : fallback;

      if (msg.type === "drag") {
        if (![msg.x1, msg.y1, msg.x2, msg.y2].every(isUnit)) {
          rejectInvalidInput("Drag coordinates must be within the visible phone screen.");
          return;
        }
        if (msg.x1 === msg.x2 && msg.y1 === msg.y2) {
          rejectInvalidInput("Drag start and end points must be different.");
          return;
        }
        const holdSec = boundedMs(msg.holdMs, 50, 0, 3000) / 1000;
        await performInput(msg, {
          label: "Scroll",
          auditType: "action_drag",
          detail: { x1: msg.x1, y1: msg.y1, x2: msg.x2, y2: msg.y2, holdMs: Math.round(holdSec * 1000) },
          run: (target, authorize) => target.drag(msg.x1, msg.y1, msg.x2, msg.y2, holdSec, { authorize }),
        });
        return;
      }

      if (!isUnit(msg.x) || !isUnit(msg.y)) {
        rejectInvalidInput(`${msg.type === "long_press" ? "Long-press" : "Double-tap"} coordinates must be within the visible phone screen.`);
        return;
      }
      if (msg.type === "long_press") {
        const durationSec = boundedMs(msg.durationMs, 800, 300, 5000) / 1000;
        await performInput(msg, {
          label: "Long press",
          auditType: "action_long_press",
          detail: { x: msg.x, y: msg.y, durationMs: Math.round(durationSec * 1000) },
          run: (target, authorize) => target.longPress(msg.x, msg.y, durationSec, { authorize }),
        });
        return;
      }
      await performInput(msg, {
        label: "Double tap",
        auditType: "action_double_tap",
        detail: { x: msg.x, y: msg.y },
        run: (target, authorize) => target.doubleTap(msg.x, msg.y, { authorize }),
      });
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
    let parsed;
    try { parsed = JSON.parse(raw.toString()); } catch { return; }
    const messageType = parsed?.type;
    if (messageType === "refresh_live_frame") {
      const requestId = Number.isSafeInteger(parsed.requestId) && parsed.requestId > 0 ? parsed.requestId : null;
      if (liveFramePending) {
        if (requestId !== null) ws.send(JSON.stringify({ type: "live_frame_delayed",
          deviceId: parsed.deviceId, requestId }));
        return;
      }
      liveFramePending = true;
      void handleLiveFrame(parsed)
        .catch(error => console.error("Live frame refresh failed:", error))
        .finally(() => { liveFramePending = false; });
      return;
    }
    const emergency = messageType === "emergency_stop";
    if (emergency) void handleMessage(raw).catch(error => {
      console.error("Emergency control failed:", error);
    });
    else if (queuedMessages >= MAX_QUEUED_INPUT_MESSAGES) {
      ws.send(JSON.stringify({ type: "error", code: "input_backlog",
        message: "The phone is still catching up. Slow down and try again." }));
    } else enqueue(() => handleMessage(raw));
  });

  ws.on("close", () => {
    stopStream();
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
let queueTickTimer;
let wdaReadinessTimer;
if (isMain) {
  researchTaskRunner.start();
  // Dispatch only after the worker and UI listeners exist. Dispatching from
  // createTaskQueue() would emit recovered work before either subscriber can
  // see it, leaving a restarted research task RUNNING with no consumer.
  schedulerGuard.run(new Date());
  void refreshWdaReadiness();
  const PORT = process.env.PORT || 4173;
  server.listen(PORT, deployment.host, () => {
    // server.address().port (not the raw PORT var) so this is still correct
    // when PORT=0 asks the OS for an ephemeral port.
    const displayHost = deployment.host.includes(":") ? `[${deployment.host}]` : deployment.host;
    console.log(`Phone Farm control server running at http://${displayHost}:${server.address().port}`);
    console.log(`Scheduling timezone for /time: ${schedulingTimeZone} (set PHONE_FARM_TIMEZONE to change)`);
  });
  // Only when actually running as the server, not on import — tests drive
  // taskQueue.tick() explicitly with controlled timestamps, and a real
  // wall-clock timer running in the background during those tests would
  // make window-timing assertions nondeterministic.
  const QUEUE_TICK_INTERVAL_MS = 5000;
  queueTickTimer = setInterval(() => {
    schedulerGuard.run(new Date());
  }, QUEUE_TICK_INTERVAL_MS);
  const WDA_READINESS_INTERVAL_MS = 10_000;
  wdaReadinessTimer = setInterval(() => {
    void refreshWdaReadiness().catch(error => console.error("WDA readiness refresh failed:", error));
  }, WDA_READINESS_INTERVAL_MS);

  // Opt-in (AUTO_PROVISION_WDA=true): find USB iPhones and set up WebDriverAgent on
  // each. Manually pinned devices.config.json WDA entries are left untouched. Shared
  // with the site agent; see provisioningBoot.js.
  deviceProvisioner = startAutoProvisioning({
    devices,
    manualUdids: manualWdaUdids,
    onDeviceListChanged: broadcastDeviceList,
  });

  // Opt-in, independent of AUTO_PROVISION_WDA above (a device can be
  // manually configured in devices.config.json and still get automatic
  // proxy routing). Requires TWO_FACTOR_MASTER_KEY (or
  // PROXY_CREDENTIAL_ENCRYPTION_KEY) for pool credential decryption and
  // SHARED_BRIDGE_IFACE naming the Mac's Internet-Sharing bridge — neither
  // has a safe default, so both are required explicitly rather than
  // guessed.
  if (process.env.AUTO_ROUTE_PROXY_TUNNELS === "true") {
    const bridgeIface = process.env.SHARED_BRIDGE_IFACE;
    if (!bridgeIface) {
      console.error("Automatic proxy tunnel routing is disabled — SHARED_BRIDGE_IFACE is not configured.");
    } else if (!proxyCredentialEncryptionKey) {
      console.error("Automatic proxy tunnel routing is disabled — TWO_FACTOR_MASTER_KEY (or PROXY_CREDENTIAL_ENCRYPTION_KEY) is not configured.");
    } else {
      try {
        networkRoutingOrchestrator = new NetworkRoutingOrchestrator({
          proxyPoolStorePath,
          proxyCredentialEncryptionKey,
          tunManager: new TunManager(),
          privilegedOps: new PrivilegedOps({ anchor: process.env.PF_ANCHOR || "com.apple/phonefarm" }),
          bridgeIface,
          onStateChanged: () => broadcastDeviceList(),
        });
        networkRoutingOrchestrator.startHealthChecks({
          intervalMs: Number(process.env.ROUTING_HEALTH_CHECK_INTERVAL_MS) || undefined,
        });

        // Opt-in and independent of each other: an admin can enable
        // auto-pairing (AUTO_NETWORK_ENROLLMENT) while still flipping
        // Internet Sharing on themselves, or enable the automatic toggle
        // (AUTO_ENABLE_INTERNET_SHARING) while keeping enrollment manual.
        // Neither blocks the other — the enrollment loop below just waits
        // for evidence of a shared bridge either way, matching the
        // "verify, never guess" rule this whole feature already follows.
        if (process.env.AUTO_ENABLE_INTERNET_SHARING === "true") {
          void (async () => {
            try {
              const primaryInterface = process.env.INTERNET_SHARING_PRIMARY_INTERFACE || await detectPrimaryInterface();
              await enableInternetSharing({ primaryInterface });
              console.log(`Internet Sharing enabled automatically (${primaryInterface} -> USB). This uses an undocumented macOS mechanism — verify it actually worked via the fleet UI's network enrollment status.`);
            } catch (error) {
              console.error("Automatic Internet Sharing setup failed — enable it manually in System Settings > General > Sharing > Internet Sharing:", error.message);
            }
          })();
        }

        if (process.env.AUTO_NETWORK_ENROLLMENT === "true") {
          autoNetworkEnrollment = new AutoNetworkEnrollment({
            bridgeIface,
            usbNetworkStorePath,
            proxyPoolStorePath,
            manualUdids: manualWdaUdids,
            startRouting: (deviceId, opts) => networkRoutingOrchestrator.startRouting(deviceId, opts),
            pollIntervalMs: Number(process.env.NETWORK_ENROLLMENT_POLL_INTERVAL_MS) || undefined,
            onStatusChanged: () => broadcastDeviceList(),
          });
          autoNetworkEnrollment.start();
        }
      } catch (error) {
        console.error("Automatic proxy tunnel routing is disabled:", error.message);
      }
    }
  }
}

server.on("close", () => { streamHub.closeAll(); siteLinkHub.closeAll(); });

export {
  app,
  server,
  streamHub,
  siteStore,
  siteLinkHub,
  approvalStore,
  commentLedger,
  templateLibrary,
  policyStore,
  interventionQueue,
  fleetPolicy,
  deviceMonitorConfig,
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
  optimizationRuntime,
  modelSelection,
  presenceStore,
  assignmentStore,
  schedulerGuard,
  wdaReadinessTimer,
  deviceProvisioner,
  networkRoutingOrchestrator,
  autoNetworkEnrollment,
  publicPeople,
  isLoopbackAddress,
};
