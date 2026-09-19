// Try the Phone Farm UI without any phone: two simulated phones plus one "WDA"
// phone backed by the fake WebDriverAgent server, which serves a moving live video
// feed, records every gesture it receives and answers exactly like WDA does.
//
//   npm run demo          ->  http://127.0.0.1:4173   sign in as  demo-admin / demo-password
//
// It also starts a second "site" (Demo Site B, in its own process, linked to the hub
// the way a real remote Mac mini would be) so multi-site control can be tried too.
//
// Everything lives in a throwaway temp directory (never the real storage/ or
// operators.config.json) and is deleted when the demo stops.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SiteStore } from "../src/siteStore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const systemRoot = path.resolve(serverRoot, "..");

const PORT = process.env.PORT || "4173";
const WDA_PORT = 8199;
const VIDEO_PORT = 8200;
const PASSWORD = "demo-password";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-demo-"));
const salt = crypto.randomBytes(16).toString("hex");
const passwordHash = `${salt}:${crypto.scryptSync(PASSWORD, salt, 64).toString("hex")}`;

const devicesPath = path.join(root, "devices.config.json");
const operatorsPath = path.join(root, "operators.config.json");
fs.writeFileSync(devicesPath, JSON.stringify({
  devices: [
    { id: "mock-1", label: "Simulated iPhone 1", type: "mock" },
    { id: "mock-2", label: "Simulated iPhone 2", type: "mock" },
    { id: "demo-wda", label: "Demo iPhone (fake WDA, live video)", type: "wda", udid: "00008110-DEMO000000000001", port: WDA_PORT, mjpegPort: VIDEO_PORT },
  ],
}, null, 2));
fs.writeFileSync(operatorsPath, JSON.stringify({
  operators: [{ username: "demo-admin", passwordHash, allowedDevices: null, role: "admin", allowedResearchWorkspaces: ["demo-client"] }],
}, null, 2));

// One demo research account, with a comment waiting for approval and an item the AI handed back,
// so the Review panel has something to show. Nothing here ever reaches a real account or phone.
const researchConfigPath = path.join(root, "research.config.json");
fs.writeFileSync(researchConfigPath, JSON.stringify({ accounts: [{ id: "demo-account", workspaceId: "demo-client", platform: "instagram", deviceId: "mock-1" }] }));
const demoNow = Date.now();
fs.writeFileSync(path.join(root, "approvals.json"), JSON.stringify({ approvals: [{
  id: "apr-demo-1", fingerprint: "demo-1", workspaceId: "demo-client", accountId: "demo-account", taskId: "demo-task", deviceId: "mock-1",
  action: "comment_generated", target: "https://www.instagram.com/p/DEMO1/", commentText: "What a beautiful harbour at sunrise!",
  requestedBy: "demo-admin", context: { reason: "Strong post from a food account we follow", source: "generated" },
  state: "PENDING", requestedAt: demoNow - 4 * 60_000, expiresAt: demoNow + 60 * 60_000, decidedAt: null, decidedBy: null, reason: null,
}] }));
fs.writeFileSync(path.join(root, "interventions.json"), JSON.stringify({ items: [{
  id: "int-demo-1", taskId: "demo-task", deviceId: "mock-1", accountId: "demo-account", workspaceId: "demo-client", platform: "instagram",
  kind: "challenge", reason: "security or account challenge: captcha", ref: null, state: "OPEN", createdAt: demoNow - 9 * 60_000,
  claimedBy: null, claimedAt: null, resolvedBy: null, resolvedAt: null, resolution: null,
}] }));

// A second location, pre-registered on the hub: its own process, its own simulated phone.
const siteStore = new SiteStore(path.join(root, "sites.json"));
const { token: siteToken } = siteStore.create({ name: "Demo Site B", id: "demo-site", timeZone: "Europe/Bucharest" });
const siteDevicesPath = path.join(root, "site-devices.config.json");
fs.writeFileSync(siteDevicesPath, JSON.stringify({ devices: [{ id: "site-sim", label: "Site B simulated iPhone", type: "mock" }] }));

const children = [];
function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: systemRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", chunk => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", code => {
    console.log(`[${name}] exited (${code})`);
    shutdown();
  });
  children.push(child);
  return child;
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start("fake-wda", [path.join(serverRoot, "fixtures/fake-wda-server.js"), String(WDA_PORT), String(VIDEO_PORT)]);
start("server", [path.join(serverRoot, "src/index.js")], {
  PORT,
  DEVICE_CONFIG_PATH: devicesPath,
  OPERATORS_CONFIG_PATH: operatorsPath,
  FILE_STORE_DIR: path.join(root, "files"),
  SESSION_STORE_DIR: path.join(root, "sessions"),
  AUDIT_LOG_PATH: path.join(root, "audit.log"),
  QUEUE_STORE_PATH: path.join(root, "tasks.json"),
  MODEL_SELECTION_STORE_PATH: path.join(root, "model-selections.json"),
  ASSIGNMENT_STORE_PATH: path.join(root, "assignments.json"),
  SITE_STORE_PATH: path.join(root, "sites.json"),
  RESEARCH_CONFIG_PATH: researchConfigPath,
  RESEARCH_STORE_DIR: path.join(root, "research"),
  RESEARCH_EVIDENCE_DIR: path.join(root, "evidence"),
  APPROVAL_STORE_PATH: path.join(root, "approvals.json"),
  INTERVENTION_STORE_PATH: path.join(root, "interventions.json"),
  COMMENT_LEDGER_PATH: path.join(root, "comment-ledger.json"),
  COMMENT_TEMPLATES_PATH: path.join(root, "comment-templates.json"),
  ACTION_POLICY_OVERRIDES_PATH: path.join(root, "action-policy.json"),
  PHONE_FARM_LOCAL_DEV: "true",
});
start("site-b", [path.join(serverRoot, "src/agentMain.js")], {
  HUB_URL: `http://127.0.0.1:${PORT}`,
  SITE_ID: "demo-site",
  SITE_TOKEN: siteToken,
  DEVICE_CONFIG_PATH: siteDevicesPath,
  AUTO_DISCOVER_IOS_DEVICES: "false",
});
console.log(`\nPhone Farm demo: http://127.0.0.1:${PORT}   sign in as demo-admin / ${PASSWORD}\n`);
