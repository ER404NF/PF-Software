import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { parseNetworkConfig } from "./deviceNetworkConfig.js";

const PROXY_EGRESS_TYPES = new Set(["commercial-proxy", "self-hosted-proxy", "vlan-proxy"]);

function networkConfigError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function isProxyEgress(egress) {
  return PROXY_EGRESS_TYPES.has(egress);
}

// Persist the control-plane switch before changing the server's live network
// map. The network gateway/provider remains responsible for applying the
// configured route to real phone traffic; this store never handles proxy
// credentials or sends them to the browser.
export function setDeviceProxyEnabled({ configPath, deviceId, enabled }) {
  if (typeof configPath !== "string" || !configPath) throw new Error("device config path is required");
  if (typeof enabled !== "boolean") throw networkConfigError("enabled must be a boolean", 400);

  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : { devices: [] };
  if (!Array.isArray(raw.devices)) throw new Error("devices.config.json must contain a devices array");

  const index = raw.devices.findIndex(device => device?.id === deviceId);
  if (index < 0) throw networkConfigError("unknown device", 404);
  const current = parseNetworkConfig(raw.devices[index].network, deviceId);
  if (!current || !isProxyEgress(current.egress)) {
    throw networkConfigError("this device does not have a proxy egress assignment", 409);
  }

  const nextDevice = {
    ...raw.devices[index],
    network: { ...raw.devices[index].network, enabled },
  };
  const parsed = parseNetworkConfig(nextDevice.network, deviceId);
  if (current.enabled === parsed.enabled) return parsed;

  const next = { ...raw, devices: [...raw.devices] };
  next.devices[index] = nextDevice;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return parsed;
}
