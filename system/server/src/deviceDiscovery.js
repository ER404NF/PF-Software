import crypto from "crypto";
import { execFileSync } from "child_process";

function run(command, args, execFile) {
  try {
    return { ok: true, output: execFile(command, args, { encoding: "utf8", timeout: 3000, windowsHide: true }).trim() };
  } catch (error) {
    return { ok: false, output: "", error };
  }
}

export function discoveredDeviceId(udid) {
  return `ios-${crypto.createHash("sha256").update(udid).digest("hex").slice(0, 16)}`;
}

export function discoverIosDevicesResult({
  platform = process.platform,
  execFile = execFileSync,
  ideviceIdBin = process.env.IDEVICE_ID_BIN || "idevice_id",
  ideviceInfoBin = process.env.IDEVICEINFO_BIN || "ideviceinfo",
} = {}) {
  if (platform !== "darwin") return { ok: true, devices: [] };
  const listed = run(ideviceIdBin, ["-l"], execFile);
  if (!listed.ok) {
    return {
      ok: false,
      devices: [],
      error: {
        code: "D102",
        command: "idevice_id",
        reason: listed.error?.code || listed.error?.name || "command_failed",
        message: "iPhone discovery temporarily unavailable",
      },
    };
  }
  const output = listed.output;
  if (!output) return { ok: true, devices: [] };
  const seen = new Set();
  const devices = [];
  for (const line of output.split(/\r?\n/)) {
    const udid = line.trim();
    if (!/^[A-Za-z0-9-]{8,100}$/.test(udid) || seen.has(udid)) continue;
    seen.add(udid);
    const info = run(ideviceInfoBin, ["-u", udid, "-k", "DeviceName"], execFile);
    const detectedName = info.ok ? info.output : "";
    devices.push({
      id: discoveredDeviceId(udid),
      udid,
      label: detectedName || `Connected iPhone ${udid.slice(-6)}`,
    });
  }
  return { ok: true, devices };
}

// Compatibility helper for callers that only need a best-effort snapshot.
// Reconciliation loops should call discoverIosDevicesResult() so a failed
// command is never mistaken for a successful zero-device observation.
export function discoverIosDevices(options = {}) {
  return discoverIosDevicesResult(options).devices;
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
