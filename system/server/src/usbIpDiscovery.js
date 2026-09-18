import { execFile as execFileCb } from "child_process";

// Discovers a device's own private IPv4 on its USB-side interface (guide
// §4.5), by capturing live traffic while the phone talks and extracting
// the source address — matching the guide's explicit caution: "extract the
// private source IP belonging to the phone, not the TCP/UDP source port
// appended after it".

// tcpdump -ni <iface> -nn ip lines look like:
//   12:34:56.789012 IP 192.168.2.10.54321 > 192.168.2.1.443: Flags [S], ...
// The address is 4 dot-separated octets; everything after that is the
// port. Matching only that exact shape (not a looser "last dot" split) is
// what keeps this correct regardless of packet type/flags/length suffix.
// IPv4-only by design: the PF routing model below (pfRuleGenerator.js)
// explicitly blocks IPv6 on the shared bridge, so an IPv6-shaped address
// here is never the identity this discovery step is looking for — the
// pattern only ever matches "IP " (not "IP6") lines.
const TCPDUMP_LINE_RE = /\bIP\s+(\d{1,3}(?:\.\d{1,3}){3})\.\S+\s+>\s+(\d{1,3}(?:\.\d{1,3}){3})\.\S+:/;

// Pure — every distinct IPv4 address seen as either a source or a
// destination across the captured lines (both directions, since tcpdump on
// the Mac's own interface sees the phone's traffic both ways).
export function parseTcpdumpAddresses(tcpdumpOutput) {
  const seen = new Set();
  for (const line of String(tcpdumpOutput || "").split(/\r?\n/)) {
    const match = TCPDUMP_LINE_RE.exec(line);
    if (!match) continue;
    seen.add(match[1]);
    seen.add(match[2]);
  }
  return [...seen];
}

// The actual decision: every observed address MINUS the ones already known
// to belong to the Mac itself (its own address on that interface, any
// gateway) should leave exactly one candidate — the phone. Never guesses
// among several remaining candidates (guide: "the system should never
// silently guess when mapping is ambiguous").
export function discoverDeviceIp(tcpdumpOutput, { excludeIps = [] } = {}) {
  const exclude = new Set(excludeIps);
  const candidates = parseTcpdumpAddresses(tcpdumpOutput).filter(ip => !exclude.has(ip));
  if (candidates.length === 1) return { state: "resolved", ip: candidates[0] };
  if (candidates.length === 0) return { state: "no_traffic", ip: null, reason: "no non-excluded IPv4 source/destination seen in the capture window" };
  return { state: "ambiguous", ip: null, candidates, reason: `multiple candidate addresses seen (${candidates.join(", ")})` };
}

// Thin OS-shell wrapper — `execFile` injectable, no real tcpdump in tests.
// Packet capture requires root, so this runs through `sudo -n` just like
// tunManager.js's tun2proxy launch — the host's sudoers rule needs a third
// entry alongside pfctl/tun2proxy (see privilegedOps.js's module comment
// for the exact line shape; add tcpdump's resolved path there too).
export async function captureDeviceTraffic({ iface, packetCount = 10, sudoBin = "sudo", execFile = execFileCb, timeoutMs = 15_000 } = {}) {
  if (typeof iface !== "string" || !iface) throw new Error("iface is required");
  const output = await new Promise((resolve, reject) => {
    execFile(sudoBin, ["-n", "tcpdump", "-ni", iface, "-c", String(packetCount), "-nn", "ip"], { timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        // tcpdump exits nonzero on a capture timeout with 0 packets seen —
        // that's a legitimate "no traffic yet" outcome, not a hard failure.
        if (error && !stdout) reject(new Error(`tcpdump on ${iface} failed: ${(stderr || error.message || "").trim().slice(0, 300)}`));
        else resolve(stdout || "");
      });
  });
  return output;
}
