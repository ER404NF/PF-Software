// Operator accounts, UI roles, and device authorization for Human VA Mode.
// Loaded from operators.config.json at startup — same config-driven philosophy
// as devices.config.json, except passwords obviously can't be hand-typed into
// that file: use server/scripts/create-operator.js to add/update one.
//
// `role` answers "which management features may this operator use?"
// `allowedDevices` answers "which devices may this operator control?"
// Keep those two questions separate: an admin can still be restricted to a
// subset of devices, and a VA can still be allowed every device.
//
// Research grants are separate again: researchAccess.js resolves account
// ownership and checks allowedResearchWorkspaces against this live registry.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { validResearchId } from "./researchId.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Env-overridable so a spawned relay process under test can point at a
// disposable temp config instead of the real operators.config.json — see
// server/test/integration/persistence.test.js.
const configPath = process.env.OPERATORS_CONFIG_PATH
  ? path.resolve(process.env.OPERATORS_CONFIG_PATH)
  : path.join(__dirname, "../../operators.config.json");

const SCRYPT_KEYLEN = 64;

export const OPERATOR_ROLES = Object.freeze({
  VA: "va",
  ADMIN: "admin",
});

// Backward-compatible and fail-closed for management permissions: old config
// entries that pre-date roles become ordinary VAs rather than silently gaining
// admin access. Unknown/typo roles behave the same way.
export function normalizeRole(role) {
  return role === OPERATOR_ROLES.ADMIN ? OPERATOR_ROLES.ADMIN : OPERATOR_ROLES.VA;
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

function loadOperators() {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : { operators: [] };
  const map = new Map();
  for (const o of raw.operators) {
    // allowedDevices: null/absent means "every device"; an array restricts to
    // exactly those device ids. This is independent from the operator role.
    map.set(o.username, {
      username: o.username,
      passwordHash: o.passwordHash,
      allowedDevices: o.allowedDevices ?? null,
      role: normalizeRole(o.role),
      // validResearchId, not a looser inline pattern: workspace ids are
      // canonically lowercase (researchAccess.js), so a grant like
      // "Client-A" — accidentally uppercase, meant to reference the real
      // lowercase "client-a" workspace — must be rejected here, loudly, not
      // silently accepted and then simply never match anything at request
      // time. Real bug this fixes: it used to be accepted by a looser regex
      // and denied access forever with zero diagnostic anywhere in the stack.
      allowedResearchWorkspaces: filterValidResearchGrants(o.username, o.allowedResearchWorkspaces),
    });
  }
  return map;
}

// Exported live, like index.js's `devices` Map, so tests can inject/remove
// an operator without writing to the real config file on disk.
export const operators = loadOperators();

export function authenticate(username, password) {
  if (typeof username !== "string") return null;
  const operator = operators.get(username);
  if (!operator) return null;
  if (!verifyPassword(password, operator.passwordHash)) return null;
  return {
    username: operator.username,
    allowedDevices: operator.allowedDevices ?? null,
    role: normalizeRole(operator.role),
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
    allowedDevices: operator.allowedDevices ?? null,
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
  return operators.get(sessionOperator.username) ?? null;
}

export function canAccessDevice(operator, deviceId) {
  if (!operator) return false;
  if (!operator.allowedDevices) return true;
  return operator.allowedDevices.includes(deviceId);
}
