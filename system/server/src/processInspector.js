import { execFile as nodeExecFile } from "child_process";

// Read-only look at the operating system's process table: "who is listening on
// port N" and "what exactly is process P". It never sends a signal — not even
// signal 0 — because probing a pid that is not provably Bodun's own is exactly
// what the shared-Mac rule forbids. Everything goes through an injected
// `execFile` so tests never touch a real process.

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

// `lsof -F pcn` prints one field per line: "p<pid>", "c<command>", "n<name>".
// Only the pids are used; lsof's own command name is truncated, so the program
// name comes from `ps` instead.
export function parseLsofListeners(output) {
  const pids = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = /^p(\d+)$/.exec(line.trim());
    if (match) {
      const pid = Number.parseInt(match[1], 10);
      if (!pids.includes(pid)) pids.push(pid);
    }
  }
  return pids.map(pid => ({ pid }));
}

// `ps -ww -o ppid=,pgid=,lstart= -p <pid>` → "    1   742 Tue Oct  6 20:20:28 2026".
export function parsePsStat(output) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(String(output || "").split(/\r?\n/).find(line => line.trim()) ?? "");
  if (!match) return null;
  return {
    ppid: Number.parseInt(match[1], 10),
    pgid: Number.parseInt(match[2], 10),
    startTime: match[3].replace(/\s+/g, " "),
  };
}

// `ps -o comm= -p <pid>` is a path whose last part may contain spaces
// ("/Applications/Google Chrome.app/…/Google Chrome Helper").
export function parsePsComm(output) {
  const line = String(output || "").split(/\r?\n/).find(candidate => candidate.trim());
  if (!line) return null;
  const trimmed = line.trim();
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || null;
}

// `ps -ww -o command= -p <pid>` — the whole command line, kept exactly as printed
// (only the line ending is removed) so it can be compared as one string.
export function parsePsCommand(output) {
  const line = String(output || "").split(/\r?\n/).find(candidate => candidate.trim());
  return line ? line.replace(/^\s+/, "") : null;
}

export function createProcessInspector({ execFile = nodeExecFile, platform = process.platform, timeoutMs = 3000 } = {}) {
  const supported = SUPPORTED_PLATFORMS.has(platform);

  function run(bin, args) {
    return new Promise(resolve => {
      execFile(bin, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) {
          const output = String(stdout ?? "");
          const status = error.code === "ENOENT" ? "unsupported"
            : error.code === 1 && !error.killed && !error.signal
              && !output.trim() && !String(stderr ?? "").trim() ? "missing" : "unavailable";
          resolve({ status, stdout: output });
          return;
        }
        resolve({ status: "ok", stdout: String(stdout ?? "") });
      });
    });
  }

  return {
    supported,

    async findProcesses(program) {
      if (!supported) return { supported: false, processes: [] };
      if (typeof program !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(program)) throw new Error("a valid program name is required");
      const result = await run("pgrep", ["-x", program]);
      if (result.status === "unsupported" || result.status === "unavailable") return { supported: false, processes: [] };
      if (result.status === "missing") return { supported: true, processes: [] };
      const pids = result.stdout.split(/\s+/).filter(Boolean).map(Number).filter(validPid);
      const described = await Promise.all(pids.map(pid => this.describe(pid).catch(() => undefined)));
      return { supported: true, processes: described.filter(Boolean) };
    },

    async findListeners(port) {
      if (!supported) return { supported: false, listeners: [] };
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("a valid port is required");
      const result = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pcn"]);
      if (result.status === "unsupported" || result.status === "unavailable") return { supported: false, listeners: [] };
      return { supported: true, listeners: parseLsofListeners(result.stdout) };
    },

    // Three separate `ps` calls so no field boundary is ambiguous (the program
    // name can contain spaces). Returns null only when the process is confirmed
    // gone and undefined when operating-system inspection is unavailable.
    async describe(pid) {
      if (!supported) return undefined;
      if (!validPid(pid)) return null;
      const stat = await run("ps", ["-ww", "-o", "ppid=,pgid=,lstart=", "-p", String(pid)]);
      if (stat.status === "missing") return null;
      if (stat.status !== "ok") return undefined;
      const parsedStat = parsePsStat(stat.stdout);
      if (!parsedStat) return undefined;
      const [comm, command] = await Promise.all([
        run("ps", ["-o", "comm=", "-p", String(pid)]),
        run("ps", ["-ww", "-o", "command=", "-p", String(pid)]),
      ]);
      if (comm.status === "missing" || command.status === "missing") return null;
      if (comm.status !== "ok" || command.status !== "ok") return undefined;
      const program = parsePsComm(comm.stdout);
      const fullCommand = parsePsCommand(command.stdout);
      if (!program || !fullCommand) return undefined;
      return { pid, ppid: parsedStat.ppid, pgid: parsedStat.pgid, startTime: parsedStat.startTime, program, command: fullCommand };
    },

    // Never `process.kill(pid, 0)`: that would send a signal to a pid that may
    // belong to somebody else.
    async isAlive(pid) {
      if (!supported) return undefined;
      if (!validPid(pid)) return false;
      const result = await run("ps", ["-p", String(pid), "-o", "pid="]);
      if (result.status === "missing") return false;
      if (result.status !== "ok") return undefined;
      return result.stdout.trim() === String(pid);
    },
  };
}
