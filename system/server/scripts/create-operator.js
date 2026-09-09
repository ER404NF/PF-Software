// Adds or updates an operator in operators.config.json with a securely
// hashed password (never touch that file by hand — there's nowhere to type
// a plaintext password into it).
//
// Usage:
//   node server/scripts/create-operator.js <username> <password> [device1,device2,...] [--role=va|admin] [--research-workspaces=client-a,client-b]
//
// Omit the device list to grant access to every device. Role defaults to
// `va` when omitted. Role and device access are independent: an admin can be
// device-restricted, and a VA can be allowed every device.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { hashPassword, normalizeRole, OPERATOR_ROLES } from "../src/authStore.js";
import { validResearchId } from "../src/researchId.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "../../operators.config.json");

const [, , username, password, ...rest] = process.argv;
if (!username || !password) {
  console.error(
    "Usage: node server/scripts/create-operator.js <username> <password> [device1,device2,...] [--role=va|admin] [--research-workspaces=client-a,client-b]"
  );
  process.exit(1);
}

let role = OPERATOR_ROLES.VA;
let deviceList = null;
let researchWorkspaces;
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
    if (![OPERATOR_ROLES.VA, OPERATOR_ROLES.ADMIN].includes(requested)) {
      console.error('role must be "va" or "admin"');
      process.exit(1);
    }
    role = normalizeRole(requested);
  } else if (!arg.startsWith("--") && deviceList === null) {
    deviceList = arg;
  } else {
    console.error(`Unexpected argument: ${arg}`);
    process.exit(1);
  }
}

const data = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : { operators: [] };
const allowedDevices = deviceList ? deviceList.split(",").map((s) => s.trim()).filter(Boolean) : null;
const passwordHash = hashPassword(password);

const existing = data.operators.find((o) => o.username === username);
if (existing) {
  existing.passwordHash = passwordHash;
  existing.allowedDevices = allowedDevices;
  existing.role = role;
  if (researchWorkspaces !== undefined) existing.allowedResearchWorkspaces = researchWorkspaces;
  console.log(`Updated operator "${username}".`);
} else {
  data.operators.push({ username, passwordHash, allowedDevices, role, allowedResearchWorkspaces: researchWorkspaces ?? [] });
  console.log(`Created operator "${username}".`);
}

fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
console.log(`role: ${role}`);
console.log(`allowedDevices: ${allowedDevices ? allowedDevices.join(", ") : "(all devices)"}`);
