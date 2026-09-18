import { execFile as execFileCb } from "child_process";

// Turns on macOS Internet Sharing (Mac's own connection -> USB) without a
// human opening System Settings. Apple publishes NO supported API for
// this — networksetup does not cover Internet Sharing at all — so this
// uses the same undocumented mechanism System Settings itself is known to
// drive: /Library/Preferences/SystemConfiguration/com.apple.nat.plist,
// applied via PlistBuddy (Apple's own plist-editing tool — a wrong key
// path fails loudly instead of corrupting the file, unlike hand-writing
// XML) and a restart of the com.apple.InternetSharing launchd job.
//
// This is explicitly best-effort: the plist schema below is reconstructed
// from long-standing community documentation, not from an Apple spec, and
// could differ on a macOS version this hasn't been tested against. Every
// call site in this codebase that uses this module MUST verify the result
// independently (e.g. the shared bridge actually getting an IP) and fall
// back to the existing manual-instruction banner rather than trusting
// success blindly or retrying forever against a broken mechanism.

const NAT_PLIST = "/Library/Preferences/SystemConfiguration/com.apple.nat.plist";
const PLISTBUDDY = "/usr/libexec/PlistBuddy";
const IFACE_RE = /^[a-zA-Z0-9._-]{1,15}$/;

function assertIface(value, label) {
  if (typeof value !== "string" || !IFACE_RE.test(value)) {
    throw new Error(`${label} must be a valid interface name, got: ${JSON.stringify(value)}`);
  }
  return value;
}

// Pure — the exact PlistBuddy -c command sequence, so the logic here is
// fully unit-testable without ever touching a real plist. Delete-then-Add
// (rather than Set) makes this idempotent regardless of whatever state the
// file was already in — including not existing yet, or holding a stale
// manual configuration.
export function buildEnableCommands({ primaryInterface, sharingDevice = "USB" }) {
  assertIface(primaryInterface, "primaryInterface");
  if (typeof sharingDevice !== "string" || !sharingDevice.trim() || sharingDevice.length > 40) {
    throw new Error("sharingDevice must be a non-empty string");
  }
  return [
    "Delete :NAT",
    "Add :NAT dict",
    "Add :NAT:Enabled integer 1",
    "Add :NAT:PrimaryInterface dict",
    `Add :NAT:PrimaryInterface:Device string ${primaryInterface}`,
    "Add :NAT:PrimaryInterface:Enabled integer 1",
    "Add :NAT:SharingDevices array",
    `Add :NAT:SharingDevices:0 string ${sharingDevice}`,
  ];
}

export function buildDisableCommands() {
  return ["Delete :NAT", "Add :NAT dict", "Add :NAT:Enabled integer 0"];
}

function run(execFile, sudoBin, args, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    execFile(sudoBin, ["-n", ...args], { timeout, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${args[0]} failed: ${(stderr || error.message || "").trim().slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

// The Mac's own internet-facing interface, auto-detected from the default
// route rather than requiring the admin to know/configure it — `route get
// default` is a stable, long-standing BSD utility (unlike the NAT plist
// itself). INTERNET_SHARING_PRIMARY_INTERFACE remains available as an
// override for a host where this doesn't resolve correctly.
const ROUTE_INTERFACE_RE = /^\s*interface:\s*(\S+)/m;

export function parseDefaultRouteInterface(routeOutput) {
  const match = ROUTE_INTERFACE_RE.exec(String(routeOutput || ""));
  return match ? match[1] : null;
}

export async function detectPrimaryInterface({ execFile = execFileCb, timeoutMs = 5000 } = {}) {
  const output = await new Promise((resolve, reject) => {
    execFile("route", ["-n", "get", "default"], { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`route get default failed: ${(stderr || error.message || "").trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
  const iface = parseDefaultRouteInterface(output);
  if (!iface) throw new Error("could not determine the default-route interface from `route get default`");
  return iface;
}

// Applies buildEnableCommands() via PlistBuddy (one invocation, multiple -c
// flags) then restarts the sharing service. Does NOT verify the bridge
// actually came up — that requires usbNetworkMapper.js's bridge-member/IP
// checks, deliberately kept out of this module so it stays a narrow "make
// the OS calls" concern; callers own the verify-or-fall-back decision.
export async function enableInternetSharing({ primaryInterface, sharingDevice = "USB", sudoBin = "sudo", execFile = execFileCb } = {}) {
  const commands = buildEnableCommands({ primaryInterface, sharingDevice });
  const args = [PLISTBUDDY, ...commands.flatMap(c => ["-c", c]), NAT_PLIST];
  await run(execFile, sudoBin, args);
  await run(execFile, sudoBin, ["launchctl", "kickstart", "-k", "system/com.apple.InternetSharing"]);
}

export async function disableInternetSharing({ sudoBin = "sudo", execFile = execFileCb } = {}) {
  const args = [PLISTBUDDY, ...buildDisableCommands().flatMap(c => ["-c", c]), NAT_PLIST];
  await run(execFile, sudoBin, args);
  await run(execFile, sudoBin, ["launchctl", "kickstart", "-k", "system/com.apple.InternetSharing"]);
}
