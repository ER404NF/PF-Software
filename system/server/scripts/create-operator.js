// Adds or updates an operator in operators.config.json with a securely
// hashed password (never touch that file by hand — there's nowhere to type
// a plaintext password into it).
//
// Usage:
//   node server/scripts/create-operator.js <username> <password> [device1,device2,...] [--role=<role>] [--full-name="Name"] [--email=name@gmail.com] [--team=team-a] [--research-workspaces=client-a,client-b]
//
// Omit the device list to grant every device to non-VA roles. Role defaults
// to `va`; a VA with no list gets no devices and must receive explicit grants.

import {
  normalizeRole, OPERATOR_ROLES, operators, createOperatorAccount, updateOperatorAccount,
} from "../src/authStore.js";
import { validResearchId } from "../src/researchId.js";

const [, , username, password, ...rest] = process.argv;
if (!username || !password) {
  console.error(
    "Usage: node server/scripts/create-operator.js <username> <password> [device1,device2,...] [--role=admin|manager|va|content_creator|editor] [--full-name=Name] [--email=name@gmail.com] [--team=team-a] [--research-workspaces=client-a,client-b]"
  );
  process.exit(1);
}

let role = OPERATOR_ROLES.VA;
let deviceList = null;
let researchWorkspaces;
let fullName;
let email;
let teamId;
for (const arg of rest) {
  if (arg.startsWith("--research-workspaces=")) {
    const value = arg.slice("--research-workspaces=".length);
    researchWorkspaces = value ? value.split(",").map((id) => id.trim()) : [];
    // validResearchId (the same check researchAccess.js and authStore.js
    // use), not a looser inline pattern — a previous, more permissive regex
    // here let an uppercase id like "Client-A" through, silently and
    // permanently mismatching the real, always-lowercase "client-a"
    // workspace at request time with no error anywhere. Rejecting it here,
    // at creation time, is the earliest and clearest point to catch it.
    const invalid = researchWorkspaces.filter((id) => !validResearchId(id));
    if (invalid.length) {
      console.error(
        `research workspace IDs must be lowercase, start with a letter/digit, and contain only letters, numbers, underscores or dashes: ${invalid.join(", ")}`
      );
      process.exit(1);
    }
  } else if (arg.startsWith("--role=")) {
    const requested = arg.slice("--role=".length);
    if (!Object.values(OPERATOR_ROLES).includes(requested)) {
      console.error(`role must be one of: ${Object.values(OPERATOR_ROLES).join(", ")}`);
      process.exit(1);
    }
    role = normalizeRole(requested);
  } else if (arg.startsWith("--full-name=")) {
    fullName = arg.slice("--full-name=".length);
  } else if (arg.startsWith("--email=")) {
    email = arg.slice("--email=".length);
  } else if (arg.startsWith("--team=")) {
    teamId = arg.slice("--team=".length);
  } else if (!arg.startsWith("--") && deviceList === null) {
    deviceList = arg;
  } else {
    console.error(`Unexpected argument: ${arg}`);
    process.exit(1);
  }
}

const allowedDevices = deviceList ? deviceList.split(",").map((s) => s.trim()).filter(Boolean) : null;
try {
  if (operators.has(username)) {
    updateOperatorAccount(username, {
      password,
      allowedDevices,
      role,
      ...(fullName !== undefined ? { fullName } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(teamId !== undefined ? { teamId } : {}),
      ...(researchWorkspaces !== undefined ? { allowedResearchWorkspaces: researchWorkspaces } : {}),
    });
    console.log(`Updated operator "${username}" and revoked its previous sessions.`);
  } else {
    createOperatorAccount({
      username,
      password,
      allowedDevices,
      role,
      fullName,
      email,
      teamId,
      allowedResearchWorkspaces: researchWorkspaces ?? [],
      twoFactorRequired: true,
    });
    console.log(`Created operator "${username}".`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
console.log(`role: ${role}`);
console.log(`team: ${operators.get(username)?.teamId || "(none)"}`);
const effectiveDevices = operators.get(username)?.allowedDevices;
console.log(`allowedDevices: ${Array.isArray(effectiveDevices)
  ? effectiveDevices.length ? effectiveDevices.join(", ") : "(no devices; explicit VA grants required)"
  : "(all devices)"}`);
