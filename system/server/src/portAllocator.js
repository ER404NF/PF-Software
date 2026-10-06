import net from "node:net";

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

function canBindLocalHost(port, host, createServer = net.createServer) {
  return new Promise(resolve => {
    const server = createServer();
    server.unref();
    server.once("error", error => {
      if (host.includes(":") && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error?.code)) return resolve(true);
      resolve(false);
    });
    server.listen({ port, host, exclusive: true, ipv6Only: host.includes(":") }, () => server.close(() => resolve(true)));
  });
}

function hasLocalListener(port, host) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host });
    socket.unref();
    const finish = listening => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

// Probe wildcard addresses first: on some platforms a loopback bind can
// succeed alongside an existing wildcard listener due to socket reuse.
// iproxy may bind either family, so any occupied address makes this port
// unavailable. IPv6-unavailable hosts are handled by canBindLocalHost.
export async function isLocalPortAvailable(port, hosts = ["0.0.0.0", "::"], probeHost = canBindLocalHost) {
  // Windows can permit a wildcard bind beside a non-exclusive loopback
  // listener. A connection probe catches that case before the bind probes.
  if (await hasLocalListener(port, "127.0.0.1") || await hasLocalListener(port, "::1")) return false;
  const candidates = Array.isArray(hosts) ? hosts : [hosts];
  for (const host of candidates) {
    try {
      if (!await probeHost(port, host)) return false;
    } catch (error) {
      if (host.includes(":") && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error?.code)) continue;
      return false;
    }
  }
  return true;
}

export async function allocateAvailablePort({ range = DEFAULT_RANGE, used = new Set(), preferred = null,
  isAvailable = isLocalPortAvailable } = {}) {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 1 || range.end > 65535 || range.start > range.end) throw new Error("invalid port range");
  const candidates = [];
  if (Number.isSafeInteger(preferred) && preferred >= range.start && preferred <= range.end) candidates.push(preferred);
  for (let port = range.start; port <= range.end; port++) if (port !== preferred) candidates.push(port);
  for (const port of candidates) {
    if (!used.has(port) && await isAvailable(port)) return port;
  }
  throw new Error(`no available local port in range ${range.start}-${range.end}`);
}

const localReservations = new Set();
let reservationQueue = Promise.resolve();

function serializeReservation(work) {
  const operation = reservationQueue.catch(() => {}).then(work);
  reservationQueue = operation.catch(() => {});
  return operation;
}

// Reserves the pair against every other allocator in this process until the
// caller has handed the ports to iproxy. This closes the two-phone local race;
// OS availability is still checked immediately before the reservation is
// published, and foreign listeners are never killed or adopted.
export function reserveAvailablePortPair({ controlRange = DEFAULT_RANGE, mjpegRange = DEFAULT_MJPEG_RANGE,
  used = new Set(), preferredControl = null, preferredMjpeg = null,
  isAvailable = isLocalPortAvailable } = {}) {
  return serializeReservation(async () => {
    const unavailable = new Set([...used, ...localReservations]);
    const controlPort = await allocateAvailablePort({
      range: controlRange, used: unavailable, preferred: preferredControl, isAvailable,
    });
    unavailable.add(controlPort);
    const mjpegPort = await allocateAvailablePort({
      range: mjpegRange, used: unavailable, preferred: preferredMjpeg, isAvailable,
    });
    localReservations.add(controlPort);
    localReservations.add(mjpegPort);
    let released = false;
    return {
      controlPort,
      mjpegPort,
      release() {
        if (released) return;
        released = true;
        localReservations.delete(controlPort);
        localReservations.delete(mjpegPort);
      },
    };
  });
}
