// Operator accounts, UI roles, and device authorization for Human VA Mode.
// Loaded from operators.config.json at startup — same config-driven philosophy
// as devices.config.json, except passwords obviously can't be hand-typed into
// that file: use server/scripts/create-operator.js to add/update one.
//
// `role` answers "which management features may this operator use?"
// `allowedDevices` answers "which devices may this operator control?"
// Keep those two questions separate: an admin can still be restricted to a
// subset of devices. VAs always require an explicit device array; a missing
// or null VA grant fails closed to an empty array.
//
// Research grants are separate again: researchAccess.js resolves account
// ownership and checks allowedResearchWorkspaces against this live registry.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { validResearchId } from "./researchId.js";
import { OPERATOR_ROLES, normalizeRole, capabilitiesForRole, hasCapability } from "./roleCapabilities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Env-overridable so a spawned relay process under test can point at a
// disposable temp config instead of the real operators.config.json — see
// server/test/integration/persistence.test.js.
const configPath = process.env.OPERATORS_CONFIG_PATH
  ? path.resolve(process.env.OPERATORS_CONFIG_PATH)
  : path.join(__dirname, "../../operators.config.json");

const SCRYPT_KEYLEN = 64;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 512;
const roleSet = new Set(Object.values(OPERATOR_ROLES));

function accountError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

// Constant-time comparison via timingSafeEqual — a plain `===` on the derived
// hash would let response-time differences leak how many leading bytes
// matched, turning password verification into a timing side channel.
export function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const hashBuffer = Buffer.from(hash, "hex");
  let candidate;
  try {
    candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  if (candidate.length !== hashBuffer.length) return false;
  return crypto.timingSafeEqual(candidate, hashBuffer);
}

export function filterValidResearchGrants(username, raw) {
  if (!Array.isArray(raw)) return [];
  const valid = [];
  for (const id of raw) {
    if (validResearchId(id)) {
      valid.push(id);
    } else {
      // console.warn, not a thrown error: a bad grant on one operator
      // shouldn't take down every other operator's login at server startup
      // — but it must be visible, since the alternative (silently dropping
      // it) is exactly the bug this replaces: a grant that looks present in
      // the config forever denying access with no explanation anywhere.
      console.warn(
        `operators.config.json: operator "${username}" has an invalid research workspace grant "${id}" (ignored — workspace ids are lowercase-only; did you mean "${String(id).toLowerCase()}"?)`
      );
    }
  }
  return valid;
}

function readConfig() {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : { operators: [] };
  if (!raw || !Array.isArray(raw.operators)) throw new Error("operators config requires an operators array");
  return raw;
}

function internalOperator(o) {
  return {
    username: o.username,
    passwordHash: o.passwordHash,
    allowedDevices: o.allowedDevices ?? null,
    role: normalizeRole(o.role),
    allowedResearchWorkspaces: filterValidResearchGrants(o.username, o.allowedResearchWorkspaces),
    active: o.active !== false,
    authVersion: Number.isSafeInteger(o.authVersion) && o.authVersion >= 0 ? o.authVersion : 0,
  };
}

// Legacy configs used null/absence as "all devices" for every role. Keep
// that intentional behavior for Admin/Manager and other established roles,
// while making VA access explicit and fail-closed.
export function effectiveAllowedDevices(operator) {
  if (normalizeRole(operator?.role) === OPERATOR_ROLES.VA
    && !Array.isArray(operator?.allowedDevices)) return [];
  return operator?.allowedDevices ?? null;
}

function mapConfig(raw) {
  const map = new Map();
  for (const o of raw.operators) {
    // The raw value is preserved for durable config compatibility. Authorization
    // uses effectiveAllowedDevices(), where a VA null/absence means no devices.
    map.set(o.username, internalOperator(o));
  }
  return map;
}

function loadOperators() {
  return mapConfig(readConfig());
}

function writeConfig(raw) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, configPath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
}

function replaceLiveOperators(raw) {
  const next = mapConfig(raw);
  operators.clear();
  for (const [username, operator] of next) operators.set(username, operator);
}

function validateUsername(username) {
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
    throw accountError("username must be 1-100 characters using letters, numbers, dot, underscore, or hyphen");
  }
  return username;
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw accountError(`password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`);
  }
  return password;
}

function validateRole(role) {
  if (!roleSet.has(role)) throw accountError(`role must be one of: ${[...roleSet].join(", ")}`);
  return role;
}

function uniqueStringList(value, { field, validator }) {
  if (!Array.isArray(value) || value.length > 500) throw accountError(`${field} must be an array with at most 500 entries`);
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !validator(item)) throw accountError(`${field} contains an invalid id`);
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function validateAllowedDevices(value) {
  if (value === null) return null;
  return uniqueStringList(value, { field: "allowedDevices", validator: id => DEVICE_ID_PATTERN.test(id) });
}

function validateResearchGrants(value) {
  return uniqueStringList(value, { field: "allowedResearchWorkspaces", validator: validResearchId });
}

function publicOperatorAccount(operator) {
  return {
    username: operator.username,
    role: normalizeRole(operator.role),
    active: operator.active !== false,
    allowedDevices: effectiveAllowedDevices(operator),
    allowedResearchWorkspaces: [...(operator.allowedResearchWorkspaces ?? [])],
  };
}

// Exported live, like index.js's `devices` Map, so tests can inject/remove
// an operator without writing to the real config file on disk.
export const operators = loadOperators();

export function authenticate(username, password) {
  if (typeof username !== "string") return null;
  const operator = operators.get(username);
  if (!operator || operator.active === false) return null;
  if (!verifyPassword(password, operator.passwordHash)) return null;
  return {
    username: operator.username,
    allowedDevices: effectiveAllowedDevices(operator),
    role: normalizeRole(operator.role),
    authVersion: operator.authVersion ?? 0,
  };
}

// The only operator shape that should ever be returned to the browser. It is
// deliberately explicit so passwordHash (and any future secret config fields)
// cannot leak by accidentally serializing the internal operator object.
export function publicOperator(operator) {
  if (!operator) return null;
  return {
    username: operator.username,
    role: normalizeRole(operator.role),
    allowedDevices: effectiveAllowedDevices(operator),
    capabilities: capabilitiesForRole(operator.role),
  };
}

export function hasRole(operator, role) {
  return normalizeRole(operator?.role) === role;
}

// Real bug this fixes: `role` and `allowedDevices` were only ever read off
// the operator object express-session cached at LOGIN time — unlike
// researchAccess.js's researchWorkspaceFor(), which deliberately re-resolves
// grants "from the current operator registry, never a persisted session
// snapshot" for exactly this reason. An admin demoted to `va` (or an
// operator whose allowedDevices was tightened, or removed entirely) kept
// their OLD privileges for the full lifetime of every already-open session
// and WS connection — hours or days, since sessions are file-backed and
// survive a relay restart (MS4) — with no way for whoever revoked them to
// force it to take effect short of destroying that specific session file.
// Callers should resolve the *current* operator via this function at the
// point of every authorization decision (not just once at login), the same
// way researchWorkspaceFor already does — canAccessDevice/hasRole/etc. all
// already treat `null` as "deny," so a removed operator fails closed for
// free.
export function resolveOperator(sessionOperator) {
  if (!sessionOperator?.username) return null;
  const current = operatorByUsername(sessionOperator.username);
  if (!current) return null;
  if ((sessionOperator.authVersion ?? 0) !== (current.authVersion ?? 0)) return null;
  return current;
}

// Background tasks have a username but no login-session version. They still
// need live role/grant/activation checks, without pretending that a task is a
// browser session whose authVersion can be compared.
export function operatorByUsername(username) {
  const current = typeof username === "string" ? operators.get(username) : null;
  return current && current.active !== false ? current : null;
}

export function listOperatorAccounts() {
  return [...operators.values()].map(publicOperatorAccount)
    .sort((a, b) => a.username.localeCompare(b.username));
}

export function createOperatorAccount(input) {
  const username = validateUsername(input?.username);
  const password = validatePassword(input?.password);
  const role = validateRole(input?.role);
  const requestedDevices = validateAllowedDevices(input?.allowedDevices ?? null);
  const allowedDevices = role === OPERATOR_ROLES.VA && requestedDevices === null ? [] : requestedDevices;
  const allowedResearchWorkspaces = validateResearchGrants(input?.allowedResearchWorkspaces ?? []);
  const active = input?.active === undefined ? true : input.active;
  if (typeof active !== "boolean") throw accountError("active must be a boolean");

  const raw = readConfig();
  if (raw.operators.some(operator => operator?.username === username)) throw accountError("username already exists", 409);
  raw.operators.push({
    username,
    passwordHash: hashPassword(password),
    allowedDevices,
    role,
    allowedResearchWorkspaces,
    active,
    authVersion: 0,
  });
  writeConfig(raw);
  replaceLiveOperators(raw);
  return publicOperatorAccount(operators.get(username));
}

export function updateOperatorAccount(username, patch) {
  validateUsername(username);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw accountError("request body must be an object");
  const allowedKeys = new Set(["password", "role", "active", "allowedDevices", "allowedResearchWorkspaces"]);
  const keys = Object.keys(patch);
  if (keys.length === 0) throw accountError("at least one account field is required");
  if (keys.some(key => !allowedKeys.has(key))) throw accountError("request contains an unsupported account field");

  const raw = readConfig();
  const index = raw.operators.findIndex(operator => operator?.username === username);
  if (index < 0) throw accountError("operator not found", 404);
  const current = internalOperator(raw.operators[index]);
  const next = { ...raw.operators[index], username };

  if (Object.hasOwn(patch, "role")) next.role = validateRole(patch.role);
  if (Object.hasOwn(patch, "active")) {
    if (typeof patch.active !== "boolean") throw accountError("active must be a boolean");
    next.active = patch.active;
  }
  if (Object.hasOwn(patch, "allowedDevices")) next.allowedDevices = validateAllowedDevices(patch.allowedDevices);
  if (Object.hasOwn(patch, "allowedResearchWorkspaces")) {
    next.allowedResearchWorkspaces = validateResearchGrants(patch.allowedResearchWorkspaces);
  }
  if (Object.hasOwn(patch, "password")) next.passwordHash = hashPassword(validatePassword(patch.password));

  // Demoting an unrestricted account to VA must not carry the old null="all"
  // grant across the role boundary. Explicit arrays, including [], survive.
  if (normalizeRole(next.role) === OPERATOR_ROLES.VA && !Array.isArray(next.allowedDevices)) {
    next.allowedDevices = [];
  }

  const removesActiveAdmin = current.active !== false && current.role === OPERATOR_ROLES.ADMIN
    && (next.active === false || normalizeRole(next.role) !== OPERATOR_ROLES.ADMIN);
  if (removesActiveAdmin) {
    const hasAnother = raw.operators.some((operator, operatorIndex) => operatorIndex !== index
      && operator?.active !== false && normalizeRole(operator?.role) === OPERATOR_ROLES.ADMIN);
    if (!hasAnother) throw accountError("cannot deactivate or demote the last active admin", 409);
  }

  const invalidatesSessions = Object.hasOwn(patch, "password")
    || (Object.hasOwn(patch, "active") && patch.active !== current.active);
  next.authVersion = invalidatesSessions ? (current.authVersion + 1) : current.authVersion;
  raw.operators[index] = next;
  writeConfig(raw);
  replaceLiveOperators(raw);
  return { operator: publicOperatorAccount(operators.get(username)), invalidatesSessions };
}

export function invalidateOperatorSessions(username) {
  validateUsername(username);
  const raw = readConfig();
  const index = raw.operators.findIndex(operator => operator?.username === username);
  if (index < 0) throw accountError("operator not found", 404);
  const current = internalOperator(raw.operators[index]);
  raw.operators[index] = { ...raw.operators[index], authVersion: current.authVersion + 1 };
  writeConfig(raw);
  replaceLiveOperators(raw);
  return publicOperatorAccount(operators.get(username));
}

export function canAccessDevice(operator, deviceId) {
  if (!operator) return false;
  const allowedDevices = effectiveAllowedDevices(operator);
  if (allowedDevices === null) return true;
  return allowedDevices.includes(deviceId);
}

export { OPERATOR_ROLES, normalizeRole, capabilitiesForRole, hasCapability };
