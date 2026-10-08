// Decides whether a program that is holding one of Bodun's local ports is
// PROVABLY Bodun's own leftover, and stops it only if so.
//
// Shared-Mac rule: another team's software runs on the same machine. Nothing here
// ever looks at a process by name, and nothing is signalled unless one of these
// holds, with the process re-inspected immediately before every signal:
//   (a) it matches a Bodun ownership record: pid AND start time (never null) AND
//       the full command string are all equal, and the server that owned the
//       record is gone (or is this server);
//   (b) it is an iproxy whose full command line is exactly
//       `<the iproxy path Bodun itself uses> -u <UDID> <wdaPort>:8100 [<mjpegPort>:9100]`
//       for a phone Bodun has persisted those very ports for, and it is an
//       orphan (parent pid 1), i.e. the server that started it is gone.
// Rule (b) cannot exclude a foreign tunnel for the same UDID on the same two ports
// (Bodun auto-provisions every USB phone it sees); that residual risk is why the
// match is this strict and why a live parent is never signalled.
//
// The caller must already have established that Bodun's own supervisor is not
// currently running this phone's tunnel (that tunnel is adopted, never reclaimed).

export const IPROXY_DEVICE_CONTROL_PORT = 8100;
export const IPROXY_DEVICE_VIDEO_PORT = 9100;

export function expectedIproxyCommand({ bin, udid, wdaPort, mjpegPort = null }) {
  const base = `${bin} -u ${udid} ${wdaPort}:${IPROXY_DEVICE_CONTROL_PORT}`;
  return mjpegPort === null || mjpegPort === undefined ? base : `${base} ${mjpegPort}:${IPROXY_DEVICE_VIDEO_PORT}`;
}

function sameProcess(description, other) {
  return Boolean(description && other)
    && description.pid === other.pid
    && description.startTime === other.startTime
    && description.command === other.command;
}

// "dead" | "reused" | "self" | "live_other" | "unknown"
export async function ownerStatus(record, ownerServer, inspector) {
  if (record.ownerServerPid === ownerServer?.pid
    && (record.ownerServerStartTime == null || record.ownerServerStartTime === ownerServer?.startTime)) return "self";
  if (!Number.isSafeInteger(record.ownerServerPid)) return "unknown";
  const owner = await inspector.describe(record.ownerServerPid).catch(() => undefined);
  if (owner === undefined) return "unknown";
  if (owner === null) return "dead";
  if (!record.ownerServerStartTime) return "live_other"; // cannot compare start times: safe default is "someone else's, alive"
  return owner.startTime !== record.ownerServerStartTime ? "reused" : "live_other";
}

// → { kind: "owned_by_record" | "owned_by_pattern" | "foreign" | "unidentified", ... }
export async function classifyHolder({ description, records = [], persisted = [], iproxyBin, ownerServer, inspector }) {
  if (!description) return { kind: "unidentified" };
  const holder = { program: description.program ?? null, pid: description.pid };

  const record = records.find(candidate => !candidate.unverified
    && candidate.startTime
    && candidate.pid === description.pid
    && candidate.startTime === description.startTime
    && candidate.command === description.command);
  if (record) {
    const owner = await ownerStatus(record, ownerServer, inspector);
    if (owner === "dead" || owner === "reused" || owner === "self") return { kind: "owned_by_record", record, holder };
    return { kind: "foreign", reason: owner === "live_other" ? "live_other_server" : "owner_unknown", holder };
  }

  if (description.ppid === 1 && iproxyBin) {
    const entry = persisted.find(candidate => Number.isSafeInteger(candidate.wdaPort)
      && description.command === expectedIproxyCommand({
        bin: iproxyBin, udid: candidate.udid, wdaPort: candidate.wdaPort, mjpegPort: candidate.mjpegPort ?? null,
      }));
    if (entry) return { kind: "owned_by_pattern", udid: entry.udid, holder };
  }
  return { kind: "foreign", reason: "not_provably_bodun", holder };
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createPortReclaimer({
  inspector,
  kill = (pid, signal) => process.kill(pid, signal),
  sleep = defaultSleep,
  onAudit = () => {},
  isStopping = () => false,
  termWaitMs = 3000,
  killWaitMs = 3000,
  pollMs = 100,
} = {}) {
  if (!inspector) throw new Error("a process inspector is required");

  // gone | same | changed — judged by a fresh look at the pid every time.
  async function look(classified) {
    const now = await inspector.describe(classified.pid).catch(() => undefined);
    if (now === undefined) return "unknown";
    if (now === null) return "gone";
    return sameProcess(now, classified) ? "same" : "changed";
  }

  async function wait(classified, timeoutMs, stopping) {
    const rounds = Math.max(1, Math.ceil(timeoutMs / pollMs));
    for (let round = 0; round < rounds; round += 1) {
      if (stopping()) return "shutting_down";
      const state = await look(classified);
      if (state === "gone" || state === "changed") return "exited";
      await sleep(pollMs);
    }
    return "timeout";
  }

  function send(pid, signal) {
    try {
      kill(pid, signal);
      return { sent: true };
    } catch (error) {
      if (error?.code === "ESRCH") return { sent: false, gone: true };
      return { sent: false, error };
    }
  }

  return {
    inspector,
    // `description` is what the classifier was given; the process is described
    // again right before each signal and nothing is sent if it is no longer that
    // exact process (it exited, or its pid was reused by something else).
    async reclaim({ description, classification, deviceId = null, port = null, isStopping: callStopping = null }) {
      const stopping = callStopping ?? isStopping;
      if (!classification || !["owned_by_record", "owned_by_pattern"].includes(classification.kind)) {
        throw new Error("only a process proven to be Bodun's own may be reclaimed");
      }
      const audit = outcome => onAudit({
        type: "stale_tunnel_reclaimed", deviceId, port, program: description.program ?? null, pid: description.pid, outcome,
      });

      const first = await look(description);
      if (first === "gone" || first === "changed") { audit("already_gone"); return { ok: true, reason: "already_gone" }; }
      if (first === "unknown") { audit("could_not_check"); return { ok: false, reason: "could_not_check" }; }

      const term = send(description.pid, "SIGTERM");
      if (term.error) { audit("not_permitted"); return { ok: false, reason: "not_permitted" }; }
      if (!term.gone) {
        const result = await wait(description, termWaitMs, stopping);
        if (result === "shutting_down") return { ok: false, reason: "shutting_down" };
        if (result === "exited") { audit("stopped"); return { ok: true, reason: "stopped" }; }
      } else { audit("stopped"); return { ok: true, reason: "stopped" }; }

      // Still there after the grace period: look again, and only then force it.
      const second = await look(description);
      if (second === "gone" || second === "changed") { audit("stopped"); return { ok: true, reason: "stopped" }; }
      if (second === "unknown") { audit("could_not_check"); return { ok: false, reason: "could_not_check" }; }
      const force = send(description.pid, "SIGKILL");
      if (force.error) { audit("not_permitted"); return { ok: false, reason: "not_permitted" }; }
      if (force.gone) { audit("stopped"); return { ok: true, reason: "stopped" }; }
      const result = await wait(description, killWaitMs, stopping);
      if (result === "shutting_down") return { ok: false, reason: "shutting_down" };
      if (result === "exited") { audit("stopped"); return { ok: true, reason: "stopped" }; }
      audit("would_not_stop");
      return { ok: false, reason: "would_not_stop" };
    },

    // Looks at who holds `port` and reclaims it only if EVERY holder is provably
    // Bodun's own. Returns a plain status the provisioner turns into an operator
    // message: free | reclaimed | foreign | unidentified | unknown | would_not_stop | ...
    async resolvePort({ port, deviceId = null, records = [], persisted = [], iproxyBin, ownerServer, isStopping: callStopping = null }) {
      const found = await inspector.findListeners(port);
      if (!found.supported) return { status: "unknown", port };
      if (found.listeners.length === 0) return { status: "free", port };

      const items = [];
      for (const { pid } of found.listeners) {
        const description = await inspector.describe(pid).catch(() => null);
        const classification = await classifyHolder({ description, records, persisted, iproxyBin, ownerServer, inspector });
        items.push({ pid, description, classification });
      }
      const blocker = items.find(item => !["owned_by_record", "owned_by_pattern"].includes(item.classification.kind));
      if (blocker) {
        const unidentified = blocker.classification.kind === "unidentified";
        onAudit({
          type: "port_conflict_foreign", deviceId, port,
          program: blocker.description?.program ?? null, pid: blocker.pid, outcome: unidentified ? "unidentified" : "foreign",
        });
        return {
          status: unidentified ? "unidentified" : "foreign",
          port,
          holder: { program: blocker.description?.program ?? null, pid: blocker.pid },
        };
      }
      for (const item of items) {
        const result = await this.reclaim({ description: item.description, classification: item.classification, deviceId, port, isStopping: callStopping });
        if (!result.ok) return { status: result.reason === "shutting_down" ? "shutting_down" : "would_not_stop", port, holder: { program: item.description.program ?? null, pid: item.pid }, reason: result.reason };
      }
      return { status: "reclaimed", port };
    },
  };
}
