// Site agent entry point:  npm run agent
//
// Run this on the Mac mini at a remote site. It needs no inbound port; it dials the
// hub. Configure with environment variables (or the desktop app's "Site" mode):
//
//   HUB_URL       https://phones.example.com          (the hub's public address)
//   SITE_ID       bucharest                           (from the hub's Sites page)
//   SITE_TOKEN    pfs_...                             (shown once when the site was created)
//   DEVICE_CONFIG_PATH   optional: devices.config.json with pinned phones
//   AUTO_PROVISION_WDA=true   optional: find USB iPhones and set up WDA automatically
//
// Everything else (operators, roles, the queue, audit) stays on the hub.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./directExecution.js";
import { loadDeviceConfig } from "./deviceConfigLoader.js";
import { loadDevices } from "./deviceRegistry.js";
import { discoverIosDevices } from "./deviceDiscovery.js";
import { startAutoProvisioning } from "./provisioningBoot.js";
import { SiteAgent } from "./siteAgent.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function readAgentConfig(env = process.env) {
  const missing = ["HUB_URL", "SITE_ID", "SITE_TOKEN"].filter(name => !env[name]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}. Create the site on the hub's Sites page and copy its values.`);
  const hubUrl = String(env.HUB_URL).trim();
  if (!/^(https?|wss?):\/\//i.test(hubUrl)) throw new Error("HUB_URL must start with https:// (or http:// on a trusted local network).");
  // A site token must never cross the internet in clear text.
  const url = new URL(hubUrl.replace(/^ws/i, "http"));
  const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLoopback && env.ALLOW_INSECURE_HUB !== "true") {
    throw new Error("HUB_URL must use https:// so the site token is encrypted in transit (set ALLOW_INSECURE_HUB=true only on a trusted private network).");
  }
  return { hubUrl, siteId: String(env.SITE_ID).trim(), token: String(env.SITE_TOKEN).trim() };
}

export function startAgent(env = process.env) {
  const config = readAgentConfig(env);
  const configPath = env.DEVICE_CONFIG_PATH || path.join(here, "../../devices.config.json");
  const raw = loadDeviceConfig({ env, defaultPath: configPath });
  const discovered = env.AUTO_DISCOVER_IOS_DEVICES === "false" ? [] : discoverIosDevices();
  const devices = loadDevices(raw, discovered);
  const manualUdids = new Set((raw.devices ?? []).filter(device => device?.type === "wda" && device?.udid).map(device => device.udid));
  const provisioner = startAutoProvisioning({ env, devices, manualUdids });
  const agent = new SiteAgent({ ...config, devices, log: message => console.log(`[agent] ${message}`) });
  agent.start();
  console.log(`Phone Farm site agent for "${config.siteId}" started, linking to ${config.hubUrl} with ${devices.size} phone(s).`);
  const shutdown = () => {
    agent.stop();
    provisioner?.stop?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { agent, devices, provisioner };
}

if (isDirectExecution(import.meta.url)) {
  try {
    startAgent();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
