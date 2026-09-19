import { safeDeviceId } from "./fileStore.js";
import { MockDevice } from "./mockDevice.js";
import { WdaDevice } from "./wdaDevice.js";
import { DiscoveredIosDevice } from "./deviceDiscovery.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function requiredLabel(value, id) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
    throw new Error(`Device ${id} requires a non-empty label of at most 100 characters`);
  }
  return value.trim();
}

function wdaOptions(device) {
  const host = typeof device.host === "string" ? device.host.trim().toLowerCase() : "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`WDA device ${device.id} host must be loopback`);
  if (!Number.isSafeInteger(device.port) || device.port < 1 || device.port > 65535) {
    throw new Error(`WDA device ${device.id} port must be an integer from 1 to 65535`);
  }
  if (device.timeoutMs !== undefined
    && (!Number.isSafeInteger(device.timeoutMs) || device.timeoutMs < 500 || device.timeoutMs > 60_000)) {
    throw new Error(`WDA device ${device.id} timeoutMs must be an integer from 500 to 60000`);
  }
  if (device.mjpegPort !== undefined
    && (!Number.isSafeInteger(device.mjpegPort) || device.mjpegPort < 1 || device.mjpegPort > 65535
      || device.mjpegPort === device.port)) {
    throw new Error(`WDA device ${device.id} mjpegPort must be an integer from 1 to 65535, different from its port`);
  }
  if (typeof device.udid !== "string" || !/^[A-Za-z0-9-]{8,100}$/.test(device.udid)) {
    throw new Error(`WDA device ${device.id} requires a valid UDID`);
  }
  // mjpegPort is the local end of the iproxy forward to WDA's video server (device
  // port 9100). Optional: without it the phone works but streams no live video.
  return { host, port: device.port, mjpegPort: device.mjpegPort ?? null, timeoutMs: device.timeoutMs };
}

export function loadDevices(raw, discoveries = []) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.devices)) {
    throw new Error("device configuration requires a devices array");
  }
  const map = new Map();
  const seenUdids = new Set();
  const seenEndpoints = new Set();
  const discoveryByUdid = new Map(discoveries.map(device => [device.udid, device]));
  for (const device of raw.devices) {
    if (!device || typeof device !== "object" || Array.isArray(device)) throw new Error("device entries must be objects");
    if (!safeDeviceId(device.id)) throw new Error(`Invalid or reserved device id: ${device.id}`);
    if (map.has(device.id)) throw new Error(`Duplicate device id: ${device.id}`);
    if (!new Set(["mock", "wda"]).has(device.type)) throw new Error(`Unsupported device type for ${device.id}: ${device.type}`);
    const discovered = typeof device.udid === "string" ? discoveryByUdid.get(device.udid) : null;
    const label = requiredLabel(discovered?.label || device.label, device.id);
    if (device.type === "mock") {
      map.set(device.id, new MockDevice(device.id, label));
      continue;
    }

    const options = wdaOptions(device);
    const endpoint = `loopback:${options.port}`;
    const videoEndpoint = options.mjpegPort === null ? null : `loopback:${options.mjpegPort}`;
    if (seenUdids.has(device.udid)) throw new Error(`Duplicate WDA UDID: ${device.udid}`);
    if (seenEndpoints.has(endpoint)) throw new Error(`Duplicate WDA endpoint: ${options.host}:${options.port}`);
    if (videoEndpoint !== null && (seenEndpoints.has(videoEndpoint) || videoEndpoint === endpoint)) {
      throw new Error(`Duplicate WDA endpoint: ${options.host}:${options.mjpegPort}`);
    }
    seenUdids.add(device.udid);
    seenEndpoints.add(endpoint);
    if (videoEndpoint !== null) seenEndpoints.add(videoEndpoint);
    map.set(device.id, new WdaDevice(device.id, label, options));
    if (discovered) discoveryByUdid.delete(device.udid);
  }
  for (const discovered of discoveryByUdid.values()) {
    if (map.has(discovered.id)) throw new Error(`Duplicate discovered device id: ${discovered.id}`);
    map.set(discovered.id, new DiscoveredIosDevice(discovered));
  }
  return map;
}
