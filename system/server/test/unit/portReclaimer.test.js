import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHolder, createPortReclaimer, expectedIproxyCommand } from "../../src/portReclaimer.js";

// A tiny fake operating system: a table of processes, who listens on which port,
// and a `kill` that records every signal. Nothing here touches a real process.
function world({ onSignal = () => {} } = {}) {
  const processes = new Map();
  const listeners = new Map();
  const signals = [];
  const inspector = {
    supported: true,
    describe: async pid => processes.get(pid) ?? null,
    findListeners: async port => ({ supported: true, listeners: (listeners.get(port) ?? []).map(pid => ({ pid })) }),
  };
  const kill = (pid, signal) => {
    signals.push([pid, signal]);
    onSignal({ pid, signal, processes });
  };
  return { processes, listeners, signals, inspector, kill };
}

const BIN = "/opt/homebrew/bin/iproxy";
const UDID = "00008110-001A2B3C4D5E6F70";
const OTHER_UDID = "00008110-FFFFFFFFFFFFFFFF";
const SERVER = { pid: 900, startTime: "Tue Oct 6 20:00:00 2026" };
const PERSISTED = [{ udid: UDID, wdaPort: 8101, mjpegPort: 9101 }];
const COMMAND = `${BIN} -u ${UDID} 8101:8100 9101:9100`;

function iproxy(pid, overrides = {}) {
  return { pid, ppid: 1, pgid: pid, startTime: "Tue Oct 6 19:00:00 2026", program: "iproxy", command: COMMAND, ...overrides };
}

function record(pid, overrides = {}) {
  return {
    kind: "iproxy", udid: UDID, pid, startTime: "Tue Oct 6 19:00:00 2026", command: COMMAND, unverified: false,
    ports: [8101, 9101], ownerServerPid: 555, ownerServerStartTime: "Tue Oct 6 18:00:00 2026", ...overrides,
  };
}

const noSleep = () => Promise.resolve();
const dieOn = which => ({ pid, signal, processes }) => { if (which.includes(signal)) processes.delete(pid); };

function reclaimerFor(w, extra = {}) {
  const audits = [];
  const reclaimer = createPortReclaimer({ inspector: w.inspector, kill: w.kill, sleep: noSleep, onAudit: event => audits.push(event), termWaitMs: 300, killWaitMs: 300, pollMs: 100, ...extra });
  return { reclaimer, audits };
}

async function resolve(w, extra = {}, args = {}) {
  const { reclaimer, audits } = reclaimerFor(w, extra);
  const result = await reclaimer.resolvePort({
    port: 8101, deviceId: "ios-1", records: [], persisted: PERSISTED, iproxyBin: BIN, ownerServer: SERVER, ...args,
  });
  return { result, audits };
}

test("a leftover that matches a Bodun record whose server is gone is stopped (SIGTERM only when it obeys)", async () => {
  const w = world({ onSignal: dieOn(["SIGTERM"]) });
  w.processes.set(4121, iproxy(4121));
  w.listeners.set(8101, [4121]);
  const { result, audits } = await resolve(w, {}, { records: [record(4121)] });
  assert.equal(result.status, "reclaimed");
  assert.deepEqual(w.signals, [[4121, "SIGTERM"]]);
  assert.equal(audits.at(-1).type, "stale_tunnel_reclaimed");
  assert.equal(audits.at(-1).outcome, "stopped");
});

test("a record owned by THIS server is also provably ours", async () => {
  const w = world({ onSignal: dieOn(["SIGTERM"]) });
  w.processes.set(4121, iproxy(4121, { ppid: 900 }));
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w, {}, { records: [record(4121, { ownerServerPid: SERVER.pid, ownerServerStartTime: SERVER.startTime })] });
  assert.equal(result.status, "reclaimed");
});

test("a record owned by a different, still-alive Bodun server is never signalled", async () => {
  const w = world();
  w.processes.set(4121, iproxy(4121, { ppid: 555 }));
  w.processes.set(555, { pid: 555, ppid: 1, pgid: 555, startTime: "Tue Oct 6 18:00:00 2026", program: "Bodun", command: "Bodun server" });
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w, {}, { records: [record(4121)] });
  assert.equal(result.status, "foreign");
  assert.equal(w.signals.length, 0);
});

test("an owner pid that was reused by another process counts as a dead owner", async () => {
  const w = world({ onSignal: dieOn(["SIGTERM"]) });
  w.processes.set(4121, iproxy(4121));
  w.processes.set(555, { pid: 555, ppid: 1, pgid: 555, startTime: "Tue Oct 6 21:30:00 2026", program: "something", command: "something else" });
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w, {}, { records: [record(4121)] });
  assert.equal(result.status, "reclaimed");
});

test("an alive owner whose start time was never recorded is treated as someone else's (safe default)", async () => {
  const w = world();
  w.processes.set(4121, iproxy(4121));
  w.processes.set(555, { pid: 555, ppid: 1, pgid: 555, startTime: "whenever", program: "Bodun", command: "Bodun server" });
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w, {}, { records: [record(4121, { ownerServerStartTime: null })] });
  assert.equal(result.status, "foreign");
  assert.equal(w.signals.length, 0);
});

test("the exact iproxy pattern with this phone's persisted ports, as an orphan, is reclaimed", async () => {
  const w = world({ onSignal: dieOn(["SIGTERM"]) });
  w.processes.set(4121, iproxy(4121));
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w);
  assert.equal(result.status, "reclaimed");
  assert.deepEqual(w.signals, [[4121, "SIGTERM"]]);
});

test("the same pattern with a live parent (not an orphan) is never signalled", async () => {
  const w = world();
  w.processes.set(4121, iproxy(4121, { ppid: 3333 }));
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w);
  assert.equal(result.status, "foreign");
  assert.equal(w.signals.length, 0);
});

test("the same ports but another phone's UDID are not ours", async () => {
  const w = world();
  w.processes.set(4121, iproxy(4121, { command: `${BIN} -u ${OTHER_UDID} 8101:8100 9101:9100` }));
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w);
  assert.equal(result.status, "foreign");
  assert.equal(w.signals.length, 0);
});

test("our UDID on a different port pair than Bodun persisted is not ours", async () => {
  const w = world();
  w.processes.set(4121, iproxy(4121, { command: `${BIN} -u ${UDID} 8101:8100 9150:9100` }));
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w);
  assert.equal(result.status, "foreign");
  assert.equal(w.signals.length, 0);
});

test("a different iproxy binary path is not Bodun's", async () => {
  const w = world();
  w.processes.set(4121, iproxy(4121, { command: `/usr/local/bin/iproxy -u ${UDID} 8101:8100 9101:9100` }));
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w);
  assert.equal(result.status, "foreign");
  assert.equal(w.signals.length, 0);
});

test("a record without a start time can never authorise a signal", async () => {
  const w = world();
  w.processes.set(4121, iproxy(4121, { ppid: 3333 })); // not an orphan, so only the record rule could apply
  w.listeners.set(8101, [4121]);
  for (const bad of [record(4121, { startTime: null }), record(4121, { unverified: true })]) {
    const { result } = await resolve(w, {}, { records: [bad] });
    assert.equal(result.status, "foreign");
  }
  assert.equal(w.signals.length, 0);
});

test("a recycled pid (start time differs from the record) is not ours", async () => {
  const w = world();
  w.processes.set(4121, iproxy(4121, { ppid: 3333, startTime: "Tue Oct 6 22:00:00 2026" }));
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w, {}, { records: [record(4121)] });
  assert.equal(result.status, "foreign");
  assert.equal(w.signals.length, 0);
});

test("a command line containing spaces is matched exactly, not split", async () => {
  const bin = "/Users/Some User/bin/iproxy";
  const command = expectedIproxyCommand({ bin, udid: UDID, wdaPort: 8101, mjpegPort: 9101 });
  const w = world({ onSignal: dieOn(["SIGTERM"]) });
  w.processes.set(4121, iproxy(4121, { command }));
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w, {}, { iproxyBin: bin });
  assert.equal(result.status, "reclaimed");
  // …and the same words in a different arrangement are not a match
  const w2 = world();
  w2.processes.set(4121, iproxy(4121, { command: `${bin} 9101:9100 -u ${UDID} 8101:8100` }));
  w2.listeners.set(8101, [4121]);
  assert.equal((await resolve(w2, {}, { iproxyBin: bin })).result.status, "foreign");
  assert.equal(w2.signals.length, 0);
});

test("a process that ignores SIGTERM is forced with SIGKILL after the grace period", async () => {
  const w = world({ onSignal: dieOn(["SIGKILL"]) });
  w.processes.set(4121, iproxy(4121));
  w.listeners.set(8101, [4121]);
  const { result, audits } = await resolve(w);
  assert.equal(result.status, "reclaimed");
  assert.deepEqual(w.signals, [[4121, "SIGTERM"], [4121, "SIGKILL"]]);
  assert.equal(audits.at(-1).outcome, "stopped");
});

test("a pid reused by another process during the wait is never sent SIGKILL", async () => {
  let polls = 0;
  const w = world();
  w.processes.set(4121, iproxy(4121));
  w.listeners.set(8101, [4121]);
  const realDescribe = w.inspector.describe;
  w.inspector.describe = async pid => {
    polls += 1;
    if (polls > 2) return { ...(await realDescribe(pid)), startTime: "Tue Oct 6 23:00:00 2026", command: "some other program" };
    return realDescribe(pid);
  };
  const { result } = await resolve(w);
  assert.equal(result.status, "reclaimed", "the old process is gone; the pid now belongs to someone else");
  assert.deepEqual(w.signals, [[4121, "SIGTERM"]], "only the SIGTERM that went to the verified process");
});

test("a process that survives SIGKILL is reported as would_not_stop", async () => {
  const w = world();
  w.processes.set(4121, iproxy(4121));
  w.listeners.set(8101, [4121]);
  const { result, audits } = await resolve(w);
  assert.equal(result.status, "would_not_stop");
  assert.deepEqual(w.signals, [[4121, "SIGTERM"], [4121, "SIGKILL"]]);
  assert.equal(audits.at(-1).outcome, "would_not_stop");
});

test("a listener the inspector cannot describe is 'unidentified' and is never signalled", async () => {
  const w = world();
  w.listeners.set(8101, [4121]); // no process entry: the owner is not visible to this user
  const { result } = await resolve(w);
  assert.equal(result.status, "unidentified");
  assert.equal(w.signals.length, 0);
});

test("an inspector that cannot look at all proves nothing and signals nothing", async () => {
  const w = world();
  w.inspector.findListeners = async () => ({ supported: false, listeners: [] });
  const { result } = await resolve(w);
  assert.equal(result.status, "unknown");
  assert.equal(w.signals.length, 0);
});

test("a free port is simply free", async () => {
  const w = world();
  assert.equal((await resolve(w)).result.status, "free");
});

test("if any holder is foreign, nothing at all is signalled — not even the Bodun-owned holder", async () => {
  const w = world({ onSignal: dieOn(["SIGTERM"]) });
  w.processes.set(4121, iproxy(4121));
  w.processes.set(777, { pid: 777, ppid: 3333, pgid: 777, startTime: "t", program: "proxy-tool", command: "proxy-tool --listen 8101" });
  w.listeners.set(8101, [4121, 777]);
  const { result, audits } = await resolve(w);
  assert.equal(result.status, "foreign");
  assert.deepEqual(result.holder, { program: "proxy-tool", pid: 777 });
  assert.equal(w.signals.length, 0);
  assert.equal(audits.at(-1).type, "port_conflict_foreign");
});

test("shutting down aborts a reclaim at once", async () => {
  const w = world();
  w.processes.set(4121, iproxy(4121));
  w.listeners.set(8101, [4121]);
  const { result } = await resolve(w, { isStopping: () => true });
  assert.equal(result.status, "shutting_down");
  assert.deepEqual(w.signals, [[4121, "SIGTERM"]]);
});

test("reclaim() itself refuses a process that was not classified as Bodun's", async () => {
  const w = world();
  const { reclaimer } = reclaimerFor(w);
  await assert.rejects(() => reclaimer.reclaim({ description: iproxy(1), classification: { kind: "foreign" } }), /proven to be Bodun's own/);
  await assert.rejects(() => reclaimer.reclaim({ description: iproxy(1), classification: null }), /proven to be Bodun's own/);
  assert.equal(w.signals.length, 0);
});

test("audit and log payloads carry only program, pid, port, device and outcome — never a command line", async () => {
  const w = world({ onSignal: dieOn(["SIGTERM"]) });
  w.processes.set(4121, iproxy(4121));
  w.listeners.set(8101, [4121]);
  const { audits } = await resolve(w);
  for (const event of audits) {
    assert.deepEqual(Object.keys(event).sort(), ["deviceId", "outcome", "pid", "port", "program", "type"]);
    assert.ok(!JSON.stringify(event).includes(UDID));
  }
});

test("classifyHolder: no description means unidentified", async () => {
  const w = world();
  assert.deepEqual(await classifyHolder({ description: null, inspector: w.inspector }), { kind: "unidentified" });
});
