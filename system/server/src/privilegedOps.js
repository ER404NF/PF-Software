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
//   phonefarm ALL=(root) NOPASSWD: /opt/homebrew/bin/pfctl, /opt/homebrew/bin/tun2proxy, /usr/sbin/tcpdump
//
// Use the real resolved paths for this host (`which pfctl tun2proxy
// tcpdump`), not bare names, so the rule can't be satisfied by a different
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
  constructor({ execFile = nodeExecFile, sudoBin = "sudo", pfctlBin = process.env.PFCTL_BIN || "pfctl", anchor } = {}) {
    if (typeof anchor !== "string" || !/^[a-zA-Z0-9_./-]{1,200}$/.test(anchor)) {
      throw new Error("a valid PF anchor path is required (e.g. com.apple/phonefarm)");
    }
    this.execFile = execFile;
    this.sudoBin = sudoBin;
    this.pfctlBin = pfctlBin;
    this.anchor = anchor;
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
}
