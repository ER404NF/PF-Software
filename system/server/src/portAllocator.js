// Assigns each device UDID a stable local WDA port, reused across restarts
// and replugs. Never touches the OS or the filesystem directly, so it's
// trivially unit-tested; deviceProvisioner.js is the only caller that pairs
// an allocation with a real OS-level iproxy bind.

const DEFAULT_RANGE = { start: 8100, end: 8199 };

// Local ports for each phone's forwarded MJPEG video feed (device port 9100).
const DEFAULT_MJPEG_RANGE = { start: 9100, end: 9199 };

export function resolveMjpegPortRange(env = process.env) {
  const start = Number.parseInt(env.WDA_MJPEG_PORT_RANGE_START, 10);
  const end = Number.parseInt(env.WDA_MJPEG_PORT_RANGE_END, 10);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 1 || end > 65535 || start > end) {
    return { ...DEFAULT_MJPEG_RANGE };
  }
  return { start, end };
}

export function resolvePortRange(env = process.env) {
  const start = Number.parseInt(env.WDA_PORT_RANGE_START, 10);
  const end = Number.parseInt(env.WDA_PORT_RANGE_END, 10);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 1 || end > 65535 || start > end) {
    return { ...DEFAULT_RANGE };
  }
  return { start, end };
}

// `preferred` is the port persisted from a previous run for this exact UDID
// (deviceProvisioningStore.js). Reused as-is when it's still inside the
// configured range and not already claimed this run by a different UDID.
export function allocatePort({ range = DEFAULT_RANGE, used = new Set(), preferred = null } = {}) {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start > range.end) {
    throw new Error("invalid port range");
  }
  if (Number.isSafeInteger(preferred) && preferred >= range.start && preferred <= range.end && !used.has(preferred)) {
    return preferred;
  }
  for (let port = range.start; port <= range.end; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`no free WDA local port in range ${range.start}-${range.end}`);
}
