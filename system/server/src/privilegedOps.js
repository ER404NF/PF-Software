import { execFile as nodeExecFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

// The narrow, typed privileged boundary (Automation Architecture guide
// §4.9 PrivilegedHelper: "expose only typed operations, not arbitrary
// shell execution"). Chosen over a separate always-running root helper
// process: no idle daemon, no IPC round-trip for what are rare, one-shot
// operations — each call here shells out to exactly one allowlisted
// binary via an argv array (never a shell string), gated by a `sudo -n`
// (non-interactive) invocation. The main server process itself never runs
// as root.
//
// Host prerequisite (configured out-of-band, not by this app — modifying
// /etc/sudoers programmatically is exactly the kind of privileged,
// hard-to-reverse system change CLAUDE.md's execution-care rules require a
// human to do deliberately): a NOPASSWD sudoers rule scoped to exactly the
// binaries this module (and its siblings tunManager.js, usbIpDiscovery.js)
// invoke, e.g. in /etc/sudoers.d/phone-farm:
//
//   admin ALL=(root) NOPASSWD: /opt/homebrew/bin/tun2proxy-bin, /sbin/pfctl, /usr/sbin/tcpdump, /sbin/ifconfig
//
// Use the real resolved paths for this host (`which pfctl tun2proxy
// tcpdump ifconfig`), not bare names, so the rule can't be satisfied by a different
// binary earlier on PATH. `sudo -n` fails closed (nonzero exit, no
// password prompt) if that rule is missing or the paths don't match
// exactly.

function privilegedOpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function run(execFile, sudoBin, args, { timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(sudoBin, ["-n", ...args], { timeout, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(privilegedOpError(`${args[0]} failed: ${(stderr || error.message || "").trim().slice(0, 500)}`, 502));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function canonicalPrivilegePath(binary) {
  if (typeof binary !== "string" || !binary.startsWith("/")
    || /[\u0000-\u001f\u007f,\s]/.test(binary)) return null;
  const normalized = path.posix.normalize(binary);
  return normalized === binary ? normalized : null;
}

function listedCommandsByPasswordTag(output) {
  const commands = { NOPASSWD: [], PASSWD: [] };
  const text = typeof output === "string" && output.length <= 64 * 1024 ? output : "";
  let continuation = null;
  for (const line of text.split(/\r?\n/)) {
    const tags = [...line.matchAll(/(?:^|[\s,)])(NOPASSWD|PASSWD):\s*/g)];
    if (tags.length === 0) {
      if (continuation && /^\s+\//.test(line)) {
        for (const entry of line.trim().split(",")) {
          const command = entry.trim();
          if (command) commands[continuation.tag].push({ command, rootAllowed: continuation.rootAllowed });
        }
      } else {
        continuation = null;
      }
      continue;
    }
    for (let index = 0; index < tags.length; index += 1) {
      const match = tags[index];
      const prefix = line.slice(0, match.index + 1);
      const runAs = [...prefix.matchAll(/\(([^)]*)\)/g)].at(-1)?.[1] ?? "";
      const runAsUsers = runAs.split(":", 1)[0].split(",").map(value => value.trim().toLowerCase());
      const rootAllowed = runAsUsers.includes("root") || runAsUsers.includes("all");
      const start = match.index + match[0].length;
      const end = tags[index + 1]?.index ?? line.length;
      for (const entry of line.slice(start, end).split(",")) {
        const command = entry.trim();
        if (command) commands[match[1]].push({ command, rootAllowed });
      }
      continuation = { tag: match[1], rootAllowed };
    }
  }
  return commands;
}

function checkSudoPermission(execFile, sudoBin, binary, { timeout = 5_000 } = {}) {
  return new Promise((resolve) => {
    const canonicalBinary = canonicalPrivilegePath(binary);
    if (!canonicalBinary) {
      resolve(false);
      return;
    }
    // `sudo -n -l <command>` only asks sudo whether this exact executable is
    // allowed without a password. It does not execute the privileged command.
    // Exit status alone is insufficient: sudo may successfully print a PASSWD
    // rule or a broader/different command. Accept exactly one bare canonical
    // executable under NOPASSWD and reject missing, malformed or conflicting
    // listings. Arguments are deliberately rejected because the production
    // callers use several dynamic, validated argv shapes for these binaries.
    execFile(sudoBin, ["-n", "-l", canonicalBinary],
      { timeout, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        const listed = listedCommandsByPasswordTag(stdout);
        const allowed = listed.NOPASSWD.filter(entry => entry.command === canonicalBinary && entry.rootAllowed);
        const passwordRequired = listed.PASSWD.some(entry => entry.command === canonicalBinary && entry.rootAllowed);
        resolve(allowed.length === 1 && !passwordRequired);
      });
  });
}

// Writes the ruleset to a private temp file first — pfctl reads rules from
// a file path, not stdin-as-argv, and this keeps the (non-secret, but
// still not something to embed in a process argv visible via `ps`) rule
// text out of argv entirely.
function writeTempRuleFile(rulesetText) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pf-ruleset-"));
  const file = path.join(dir, `${randomUUID()}.pf`);
  fs.writeFileSync(file, rulesetText, { encoding: "utf8", mode: 0o600 });
  return file;
}

export class PrivilegedOps {
  constructor({ execFile = nodeExecFile, sudoBin = "sudo",
    pfctlBin = process.env.PFCTL_BIN || (process.platform === "darwin" ? "/sbin/pfctl" : "pfctl"),
    tun2proxyBin = process.env.TUN2PROXY_BIN || "tun2proxy",
    tcpdumpBin = process.env.TCPDUMP_BIN || (process.platform === "darwin" ? "/usr/sbin/tcpdump" : "tcpdump"),
    ifconfigBin = process.env.IFCONFIG_BIN || (process.platform === "darwin" ? "/sbin/ifconfig" : "ifconfig"), anchor } = {}) {
    if (typeof anchor !== "string" || !/^[a-zA-Z0-9_./-]{1,200}$/.test(anchor)) {
      throw new Error("a valid PF anchor path is required (e.g. com.apple/phonefarm)");
    }
    this.execFile = execFile;
    this.sudoBin = sudoBin;
    this.pfctlBin = pfctlBin;
    this.tun2proxyBin = tun2proxyBin;
    this.tcpdumpBin = tcpdumpBin;
    this.ifconfigBin = ifconfigBin;
    this.anchor = anchor;
  }

  async assertRoutingPermissions() {
    const required = [
      ["tun2proxy", this.tun2proxyBin],
      ["pfctl", this.pfctlBin],
      ["tcpdump", this.tcpdumpBin],
      ["ifconfig", this.ifconfigBin],
    ];
    const checks = await Promise.all(required.map(async ([name, binary]) => ({
      name,
      allowed: await checkSudoPermission(this.execFile, this.sudoBin, binary),
    })));
    const missing = checks.filter(check => !check.allowed).map(check => check.name);
    if (missing.length) {
      const error = privilegedOpError(
        `Protected routing is blocked because macOS permission is missing for: ${missing.join(", ")}. Install the documented scoped sudoers rule, then restart Bodun.`,
        503,
      );
      error.code = "ROUTING_SUDO_PERMISSION_MISSING";
      error.expose = true;
      error.missingCapabilities = missing;
      throw error;
    }
    return { ok: true };
  }

  // Syntax-only check (`-n`) — never loads anything. Architecture guide
  // §4.8 step 2: always test before replacing the live ruleset.
  async testRuleset(rulesetText) {
    const file = writeTempRuleFile(rulesetText);
    try {
      await run(this.execFile, this.sudoBin, [this.pfctlBin, "-nf", file]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }

  // Loads into THIS APP'S PRIVATE ANCHOR ONLY — never `-f` on the main
  // ruleset (guide §4.8/§12: "loading with -f on the main ruleset can
  // overwrite system rules"). Callers must call testRuleset() first;
  // loading an untested ruleset is the caller's mistake, not guarded here,
  // since pfctl itself will refuse a syntactically invalid one anyway.
  async loadRuleset(rulesetText) {
    const file = writeTempRuleFile(rulesetText);
    try {
      await run(this.execFile, this.sudoBin, [this.pfctlBin, "-a", this.anchor, "-f", file]);
      return { ok: true };
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }

  // Read-only — what's actually loaded in the app's anchor right now.
  async inspectRules() {
    const { stdout } = await run(this.execFile, this.sudoBin, [this.pfctlBin, "-a", this.anchor, "-vvs", "rules"]);
    return stdout;
  }

  // Clears stale PF state for exactly one device's USB-side IP (guide
  // §4.8/§17 "clear stale states for the affected device source IP") — not
  // a global flush. `sourceIp` is validated here too, defense-in-depth on
  // top of pfRuleGenerator.js's own validation of the same shape of value.
  async clearState(sourceIp) {
    if (!/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(sourceIp || "")) {
      throw new Error("clearState requires a valid IPv4 address");
    }
    await run(this.execFile, this.sudoBin, [this.pfctlBin, "-k", sourceIp]);
    return { ok: true };
  }

  // Removes only this app's anchor rules (guide §4.8: "Never use `pfctl -F
  // all` on the main ruleset. To remove only app rules: `pfctl -a <anchor>
  // -F all`") — used when the last device's tunnel is torn down.
  async clearAnchor() {
    await run(this.execFile, this.sudoBin, [this.pfctlBin, "-a", this.anchor, "-F", "all"]);
    return { ok: true };
  }

  // Last-resort network kill switch. PF is the normal per-phone authority;
  // when PF itself cannot enforce a block, taking Bodun's configured Internet
  // Sharing bridge down prevents every attached phone from falling through to
  // the Mac's direct uplink. This intentionally needs manual recovery.
  async quarantineBridge(bridgeIface) {
    if (typeof bridgeIface !== "string" || !/^[A-Za-z0-9_.-]{1,32}$/.test(bridgeIface)) {
      throw new Error("bridge quarantine requires a valid interface name");
    }
    await run(this.execFile, this.sudoBin, [this.ifconfigBin, bridgeIface, "down"]);
    const { stdout } = await run(this.execFile, this.sudoBin, [this.ifconfigBin, bridgeIface]);
    if (/flags=.*<[^>]*\bUP\b/i.test(stdout) || /^\s*status:\s*active\s*$/im.test(stdout)) {
      throw new Error("bridge quarantine could not be verified");
    }
    return { ok: true };
  }

  async inspectBridge(bridgeIface) {
    if (typeof bridgeIface !== "string" || !/^[A-Za-z0-9_.-]{1,32}$/.test(bridgeIface)) {
      throw new Error("bridge inspection requires a valid interface name");
    }
    try {
      const { stdout } = await run(this.execFile, this.sudoBin, [this.ifconfigBin, bridgeIface]);
      return {
        available: true,
        up: /flags=.*<[^>]*\bUP\b/i.test(stdout) && !/^\s*status:\s*inactive\s*$/im.test(stdout),
      };
    } catch (error) {
      if (/does not exist|not found|no such interface/i.test(String(error?.message || ""))) {
        return { available: false, up: false };
      }
      throw error;
    }
  }
}
