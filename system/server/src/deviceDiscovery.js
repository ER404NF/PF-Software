import crypto from "crypto";
import { execFileSync } from "child_process";

function run(command, args, execFile) {
  try {
    return execFile(command, args, { encoding: "utf8", timeout: 3000, windowsHide: true }).trim();
  } catch {
    return "";
  }
}

export function discoveredDeviceId(udid) {
  return `ios-${crypto.createHash("sha256").update(udid).digest("hex").slice(0, 16)}`;
}

export function discoverIosDevices({
  platform = process.platform,
  execFile = execFileSync,
  ideviceIdBin = process.env.IDEVICE_ID_BIN || "idevice_id",
  ideviceInfoBin = process.env.IDEVICEINFO_BIN || "ideviceinfo",
} = {}) {
  if (platform !== "darwin") return [];
  const output = run(ideviceIdBin, ["-l"], execFile);
  if (!output) return [];
  const seen = new Set();
  const devices = [];
  for (const line of output.split(/\r?\n/)) {
    const udid = line.trim();
    if (!/^[A-Za-z0-9-]{8,100}$/.test(udid) || seen.has(udid)) continue;
    seen.add(udid);
    const detectedName = run(ideviceInfoBin, ["-u", udid, "-k", "DeviceName"], execFile);
    devices.push({
      id: discoveredDeviceId(udid),
      udid,
      label: detectedName || `Connected iPhone ${udid.slice(-6)}`,
    });
  }
  return devices;
}

export class DiscoveredIosDevice {
  constructor({ id, label, udid }) {
    this.id = id;
    this.label = label;
    this.udid = udid;
    this.status = "offline";
    this.discoveryState = "detected_unconfigured";
  }

  async render() { throw new Error("configure a WDA tunnel for this detected device before opening it"); }
  async tap() { throw new Error("detected device is not configured for control"); }
  async swipe() { throw new Error("detected device is not configured for control"); }
  async typeText() { throw new Error("detected device is not configured for control"); }
  async pressHome() { throw new Error("detected device is not configured for control"); }
  async getUiTree() { throw new Error("detected device is not configured for control"); }
}
