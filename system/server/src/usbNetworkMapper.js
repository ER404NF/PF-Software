import { execFile as execFileCb } from "child_process";

// Binds a stable UDID to the transient USB Internet-Sharing bridge member
// (Automation Architecture guide §4.4). "Do not equate physical
// Thunderbolt/USB-C ports with enX network interfaces" — the only reliable
// signal is a before/after diff of bridge membership around one phone's
// enrollment, sequential per phone (§7's enrollment workflow), never
// inferred from port position.

// macOS `ifconfig <bridge>` lists each member as its own "member: enX ..."
// line, e.g. "\tmember: en5 flags=3<LEARNING,DISCOVER>". Pure parsing —
// exercised directly in tests against real captured `ifconfig` output
// shapes, no OS call.
export function parseBridgeMembers(ifconfigOutput) {
  const members = [];
  for (const line of String(ifconfigOutput || "").split(/\r?\n/)) {
    const match = /^\s*member:\s*(\S+)/.exec(line);
    if (match) members.push(match[1]);
  }
  return members;
}

// The guide's exact enrollment algorithm (§4.4 steps 4-6): exactly one new
// member is an assignment; zero or several is ambiguous and must stop for
// a human rather than guess. Pure — no OS call, so every branch is
// deterministically testable.
export function diffBridgeMembers(before, after) {
  const beforeSet = new Set(before);
  const newMembers = after.filter(iface => !beforeSet.has(iface));
  if (newMembers.length === 1) return { state: "assigned", iface: newMembers[0], newMembers };
  if (newMembers.length === 0) {
    return {
      state: "ambiguous", newMembers,
      reason: "Bodun did not see a new network connection appear. Turn on Internet Sharing for this phone's USB connection in System Settings, then press Confirm again.",
    };
  }
  return {
    state: "ambiguous", newMembers,
    reason: `More than one new network connection appeared (${newMembers.join(", ")}). Set up one phone at a time: turn off sharing for the others, cancel, and start again.`,
  };
}

// The Mac's own address on the shared bridge — needed to exclude it from
// usbIpDiscovery.js's candidate set (otherwise the Mac's own bridge IP
// looks like just another "candidate" address and discovery reports
// ambiguous instead of resolving the phone). Plain (non-point-to-point)
// `ifconfig` inet line: "inet 192.168.2.1 netmask 0xffffff00 broadcast ...".
const BRIDGE_INET_RE = /^\s*inet\s+(\d{1,3}(?:\.\d{1,3}){3})\s+netmask/m;

// Pure — no OS call.
export function parseInterfaceIp(ifconfigOutput) {
  const match = BRIDGE_INET_RE.exec(String(ifconfigOutput || ""));
  return match ? match[1] : null;
}

// macOS only creates the shared bridge (bridge100) once Internet Sharing is turned on, so before the first
// phone is shared `ifconfig bridge100` answers "interface bridge100 does not exist". That is not a failure:
// it is simply a bridge with no members yet, and the "before" list is empty.
const MISSING_INTERFACE = /does not exist|no such (?:device|interface)|interface .* not found/i;

async function runIfconfig(iface, execFile) {
  return new Promise((resolve, reject) => {
    execFile("ifconfig", [iface], { timeout: 5000, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message || "").trim().slice(0, 300);
        reject(Object.assign(new Error(`ifconfig ${iface} failed: ${detail}`), {
          code: "IFCONFIG_FAILED", missingInterface: MISSING_INTERFACE.test(`${stderr} ${error.message}`),
        }));
      } else resolve(stdout);
    });
  });
}

// Thin OS-shell wrapper around the pure parser above — the only part that
// actually needs a Mac; `execFile` is injectable so callers/tests never
// need a real bridge.
export async function listBridgeMembers({ bridgeIface, execFile = execFileCb } = {}) {
  if (typeof bridgeIface !== "string" || !bridgeIface) throw new Error("bridgeIface is required");
  let output;
  try {
    output = await runIfconfig(bridgeIface, execFile);
  } catch (error) {
    if (error?.missingInterface) return [];
    throw error;
  }
  return parseBridgeMembers(output);
}

export async function discoverBridgeOwnIp({ bridgeIface, execFile = execFileCb } = {}) {
  if (typeof bridgeIface !== "string" || !bridgeIface) throw new Error("bridgeIface is required");
  const output = await runIfconfig(bridgeIface, execFile);
  const ip = parseInterfaceIp(output);
  if (!ip) throw new Error(`${bridgeIface} has no IPv4 address configured yet`);
  return ip;
}
