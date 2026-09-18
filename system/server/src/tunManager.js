import { spawn as nodeSpawn, execFile as execFileCb } from "child_process";
import { EventEmitter } from "events";
import { SupervisedProcessGroup } from "./processSupervisor.js";

const PROTOCOLS = new Set(["http", "https", "socks5"]);

// tun2proxy's own CLI takes the full authenticated proxy URL as a single
// argument (Automation Architecture guide §4.7). That argument is never
// passed through a shell (argv array, per the guide's own guardrail), so
// there is no shell-injection surface here — the risk this module actually
// guards against is different: tun2proxy's *own* stdout/stderr may echo
// that URL back out (a "connecting to <url>" style line), and this
// process's stdout/stderr is captured into a shared log ring for
// diagnostics. "Never log the complete command" (guide §4.7) applies
// equally to output we didn't write ourselves — so every log line/event
// this module exposes is redacted before anything (a caller, a future UI)
// ever sees it.
const CREDENTIAL_URL_RE = /((?:socks5|https?):\/\/)[^@\s]+@/gi;

export function redactProxyCredentials(text) {
  return typeof text === "string" ? text.replace(CREDENTIAL_URL_RE, "$1***@") : text;
}

// Percent-encodes username/password as tun2proxy's URL parsing requires
// (guide §4.7). Built once here rather than left to each caller, so every
// tunnel launch encodes consistently.
export function buildProxyUrl({ protocol, host, port, username, password }) {
  if (!PROTOCOLS.has(protocol)) throw new Error(`invalid proxy protocol: ${protocol}`);
  if (typeof host !== "string" || !host.trim()) throw new Error("proxy host is required");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("proxy port must be an integer from 1 to 65535");
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || "")}@` : "";
  return `${protocol}://${auth}${host}:${port}`;
}

// One tun2proxy per device, run through `sudo -n` (unattended — the host
// must have a NOPASSWD sudoers rule scoped to exactly this binary; see
// privilegedOps.js's module comment for the exact line). Deliberately never
// passes `--setup`: that rewrites the system's default route globally,
// while this architecture relies on PfManager's per-device `route-to` rules
// for selective routing (guide §4.7's explicit guardrail).
export class TunManager {
  constructor({ spawn = nodeSpawn, sudoBin = "sudo", tun2proxyBin = process.env.TUN2PROXY_BIN || "tun2proxy", restartBackoffMs } = {}) {
    this.sudoBin = sudoBin;
    this.tun2proxyBin = tun2proxyBin;
    this.group = new SupervisedProcessGroup({ spawn, restartBackoffMs, logRingSize: 100 });
    this.emitter = new EventEmitter();
    this.group.on("starting", (event) => this.emitter.emit("starting", event));
    this.group.on("log", (event) => this.emitter.emit("log", { ...event, line: redactProxyCredentials(event.line) }));
    this.group.on("exit", (event) => this.emitter.emit("exit", { ...event, log: event.log.map(redactProxyCredentials) }));
    this.group.on("restart-limit-exceeded", (event) =>
      this.emitter.emit("restart-limit-exceeded", { ...event, log: event.log?.map(redactProxyCredentials) }));
  }

  on(...args) { this.emitter.on(...args); return this; }
  isRunning(deviceId) { return this.group.isRunning(deviceId); }
  getLog(deviceId) { return this.group.getLog(deviceId).map(redactProxyCredentials); }
  stop(deviceId) { this.group.stop(deviceId); }
  stopAll() { this.group.stopAll(); }

  // `proxy` is the plaintext-decrypted credential object from
  // proxyPool.js's decryptProxyPassword — call sites must decrypt
  // immediately before this call and never persist or log the result.
  start({ deviceId, tunIface, proxy }) {
    if (!deviceId) throw new Error("tunnel requires a deviceId");
    if (!tunIface) throw new Error("tunnel requires a tunIface");
    const url = buildProxyUrl(proxy);
    this.group.start(deviceId, this.sudoBin, [
      "-n", this.tun2proxyBin,
      "--tun", tunIface,
      "--proxy", url,
      "--dns", "virtual",
      "--verbosity", "info",
    ]);
  }
}

// After tun2proxy brings the interface up, its point-to-point peer address
// is what pfRuleGenerator.js's `route-to (<iface> <peer>)` needs (guide
// §4.7: "the validated macOS PF grammar required the explicit peer in
// route-to"). `ifconfig <tunIface>` prints a line shaped like:
//   inet 10.0.0.2 --> 10.0.0.1 netmask 0xffffffff
const TUN_PEER_RE = /^\s*inet\s+(\d{1,3}(?:\.\d{1,3}){3})\s+-->\s+(\d{1,3}(?:\.\d{1,3}){3})/m;

// Pure — no OS call.
export function parseTunPeer(ifconfigOutput) {
  const match = TUN_PEER_RE.exec(String(ifconfigOutput || ""));
  return match ? { localIp: match[1], peerIp: match[2] } : null;
}

// Thin OS-shell wrapper. Allocating a NEW utunN when one is already
// occupied (guide §12's tun2proxy guardrail) is the caller's
// responsibility — this only reads back whatever interface tun2proxy
// actually bound, it never chooses one.
export async function discoverTunPeer({ tunIface, execFile = execFileCb, timeoutMs = 5000 } = {}) {
  if (typeof tunIface !== "string" || !tunIface) throw new Error("tunIface is required");
  const output = await new Promise((resolve, reject) => {
    execFile("ifconfig", [tunIface], { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`ifconfig ${tunIface} failed: ${(stderr || error.message || "").trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
  const peer = parseTunPeer(output);
  if (!peer) throw new Error(`no point-to-point peer address found for ${tunIface} yet`);
  return peer;
}

// tun2proxy's CLI takes an explicit `--tun <D_TUN_IFACE>` (guide §4.7's
// template) — it does not auto-pick one — so the caller must choose a free
// utunN first. Same shape of problem as portAllocator.js's allocatePort,
// applied to interface names: reuse a persisted preference when it's still
// free, otherwise scan for the first free utunN (guide §12: "if an
// allocated utunN is occupied, allocate another unused interface"). Pure —
// `existingIfaces` comes from listAllInterfaces() below.
export function allocateTunIface({ existingIfaces = [], preferred = null, rangeStart = 0, rangeEnd = 63 } = {}) {
  const used = new Set(existingIfaces);
  if (typeof preferred === "string" && preferred && !used.has(preferred)) return preferred;
  for (let n = rangeStart; n <= rangeEnd; n++) {
    const candidate = `utun${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`no free utun interface in range utun${rangeStart}-utun${rangeEnd}`);
}

// The current system interface list — what allocateTunIface() above checks
// a candidate utunN against before handing it to tun2proxy.
export async function listAllInterfaces({ execFile = execFileCb, timeoutMs = 5000 } = {}) {
  const output = await new Promise((resolve, reject) => {
    execFile("ifconfig", ["-l"], { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`ifconfig -l failed: ${(stderr || error.message || "").trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
  return output.trim().split(/\s+/).filter(Boolean);
}
