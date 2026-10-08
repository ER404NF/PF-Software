"use strict";

// Read-only look at one process, through three separate `ps` calls so no field boundary is ambiguous
// (the program name can contain spaces). Never sends a signal. Same contract as the server's
// processInspector.describe(): a description when present, null only when `ps`
// confirms the process is gone, and undefined when inspection is unavailable.
const { execFile: nodeExecFile } = require("child_process");

function parseStat(output) {
  const line = String(output || "").split(/\r?\n/).find(text => text.trim()) ?? "";
  const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
  return match ? { ppid: Number(match[1]), pgid: Number(match[2]), startTime: match[3].replace(/\s+/g, " ") } : null;
}

function firstLine(output) {
  const line = String(output || "").split(/\r?\n/).find(text => text.trim());
  return line ? line.trim() : null;
}

function createProcessInfo({ execFile = nodeExecFile, platform = process.platform } = {}) {
  const supported = platform === "darwin" || platform === "linux";
  const run = args => new Promise(resolve => {
    execFile("ps", args, { timeout: 3000, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve({ status: "ok", stdout: String(stdout ?? "") });
      const confirmedMissing = error.code === 1 && !error.killed && !error.signal
        && !String(stdout ?? "").trim() && !String(stderr ?? "").trim();
      return resolve({ status: confirmedMissing ? "missing" : "unavailable", stdout: String(stdout ?? "") });
    });
  });
  return {
    supported,
    async describe(pid) {
      if (!supported) return undefined;
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      const statResult = await run(["-ww", "-o", "ppid=,pgid=,lstart=", "-p", String(pid)]);
      if (statResult.status === "missing") return null;
      if (statResult.status !== "ok") return undefined;
      const stat = parseStat(statResult.stdout);
      if (!stat) return undefined;
      const [comm, commandOutput] = await Promise.all([
        run(["-o", "comm=", "-p", String(pid)]),
        run(["-ww", "-o", "command=", "-p", String(pid)]),
      ]);
      if (comm.status === "missing" || commandOutput.status === "missing") return null;
      if (comm.status !== "ok" || commandOutput.status !== "ok") return undefined;
      const command = String(commandOutput.stdout).split(/\r?\n/).find(text => text.trim())?.replace(/^\s+/, "");
      const commLine = firstLine(comm.stdout);
      if (!command || !commLine) return undefined;
      return {
        pid, ppid: stat.ppid, pgid: stat.pgid, startTime: stat.startTime,
        program: commLine ? commLine.slice(commLine.lastIndexOf("/") + 1) : null, command,
      };
    },
  };
}

module.exports = { createProcessInfo, parseStat };
