import { test as baseTest } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { DeviceProvisioner } from "../../src/deviceProvisioner.js";
import { LifecycleError } from "../../src/provisioningResults.js";

// A regression that makes one of these steps wait for something that never happens must fail this test, not stall the run.
const test = (name, run) => baseTest(name, { timeout: 20_000 }, run);

// What happens at start-up when Bodun has to check its earlier phone connections first. A check that cannot be completed
// pauses automatic setup (it never silently disappears), says why, re-checks by itself when waiting can help, and can be
// re-run on demand. A re-check only looks and reclaims under the same exact-match rules; it never signals anything new.

class FakeProcessManager extends EventEmitter {
  constructor() { super(); this.starts = []; this.stops = []; }
  start(options) { this.starts.push(options); return "started"; }
  stop(udid) { this.stops.push(udid); return Promise.resolve(); }
  stopAll() { return Promise.resolve(); }
  ownsMapping() { return false; }
}

const settle = async (turns = 12) => { for (let turn = 0; turn < turns; turn += 1) await new Promise(resolve => setImmediate(resolve)); };

function fakeTimers() {
  const pending = new Map();
  let next = 0;
  return {
    pending,
    setTimeout(fn, ms) { next += 1; pending.set(next, { fn, ms }); return next; },
    clearTimeout(id) { pending.delete(id); },
    waits() { return [...pending.values()].map(entry => entry.ms); },
    async fire(ms) {
      const found = [...pending.entries()].find(([, entry]) => entry.ms === ms);
      assert.ok(found, `a ${ms} ms timer is pending (have: ${JSON.stringify([...pending.values()].map(entry => entry.ms))})`);
      pending.delete(found[0]);
      found[1].fn();
      await settle();
    },
  };
}

const OWNER = { pid: 900, startTime: "owner-start" };
const OLD_OWNER_PID = 800;
const RECORD = {
  kind: "iproxy", udid: "UDID-1", pid: 4121, startTime: "leftover-start", command: "iproxy -u UDID-1 9000:8100 9100:9100",
  unverified: false, ports: [9000, 9100], ownerServerPid: OLD_OWNER_PID, ownerServerStartTime: "old-owner-start",
};

// A tiny world: what the operating system says about each process, per look. A script entry is used once, in order; the
// last entry repeats. `undefined` means "could not look", `null` means "gone".
function world({ processScript = [], ownerScript = [], store: storeOptions = {} } = {}) {
  const looks = { process: 0, owner: 0 };
  const take = (script, key) => { const value = script[Math.min(looks[key], script.length - 1)]; looks[key] += 1; return value; };
  const leftover = { pid: 4121, program: "iproxy", startTime: RECORD.startTime, command: RECORD.command, pgid: 4121, ppid: 1 };
  const runningOwner = { pid: OLD_OWNER_PID, program: "Bodun", startTime: "old-owner-start", command: "bodun", pgid: 1, ppid: 1 };
  const inspector = {
    supported: true,
    describe: async pid => {
      if (pid === 4121) { const step = take(processScript, "process"); return step === "same" ? leftover : step; }
      if (pid === OLD_OWNER_PID) { const step = take(ownerScript, "owner"); return step === "alive" ? runningOwner : step; }
      if (pid === OWNER.pid) return { pid: OWNER.pid, startTime: OWNER.startTime, command: "bodun", program: "Bodun", pgid: 1, ppid: 1 };
      return null;
    },
  };
  const dropped = [];
  const reclaims = [];
  const store = {
    reloads: 0,
    list: () => (dropped.length ? [] : [{ ...RECORD }]),
    drop: async (kind, udid) => { dropped.push([kind, udid]); return true; },
    flush: async () => {},
    reload() {
      this.reloads += 1;
      if (storeOptions.reload) return storeOptions.reload(this.reloads);
      return { recovered: false };
    },
  };
  const reclaimer = {
    inspector,
    reclaim: async args => {
      reclaims.push(args);
      return storeOptions.reclaimResult ? storeOptions.reclaimResult(reclaims.length) : { ok: true };
    },
  };
  return { inspector, store, reclaimer, dropped, reclaims, looks };
}

function build({ w = world(), extra = {} } = {}) {
  const timers = fakeTimers();
  const wda = new FakeProcessManager();
  const iproxy = new FakeProcessManager();
  const events = [];
  const polls = [];
  const provisioner = new DeviceProvisioner({
    devices: new Map(), discoverIosDevices: () => { polls.push(true); return []; }, manualUdids: new Set(),
    wdaProcessManager: wda, iproxyManager: iproxy, provisioningStorePath: "unused.json", derivedDataRoot: "/tmp/derived",
    portRange: { start: 9000, end: 9010 }, isPortAvailable: async () => true,
    ownershipStore: w.store, portReclaimer: w.reclaimer, ownerServer: { ...OWNER },
    timers, onSetupStatusChanged: status => events.push(status.code),
    ...extra,
  });
  return { provisioner, timers, events, polls, w };
}

const quietly = async work => {
  const original = console.error;
  console.error = () => {};
  try { return await work(); } finally { console.error = original; }
};

// ---- the basic shapes ------------------------------------------------------------------------------------------

test("with nothing to check, setup is running at once and polling begins", async () => {
  const provisioner = new DeviceProvisioner({
    devices: new Map(), discoverIosDevices: () => [], manualUdids: new Set(), wdaProcessManager: new FakeProcessManager(),
    iproxyManager: new FakeProcessManager(), provisioningStorePath: "x.json", derivedDataRoot: "/tmp/d", isPortAvailable: async () => true,
  });
  assert.equal(provisioner.getSetupStatus().code, "setup_running");
  await provisioner.start();
  assert.equal(provisioner.getSetupStatus().code, "setup_running");
  assert.ok(provisioner.timer, "polling is armed");
  await provisioner.stop();
});

test("a transient failure then success: checking, one 2 second wait, then running with polling", async () => {
  const w = world({ processScript: [undefined, null] });
  const { provisioner, timers, events, polls } = build({ w });
  const started = provisioner.start();
  await settle();
  assert.equal(provisioner.getSetupStatus().code, "setup_checking");
  assert.deepEqual(timers.waits(), [2000]);
  assert.equal(polls.length, 0, "no discovery during the check");
  await timers.fire(2000);
  await started;
  assert.equal(provisioner.getSetupStatus().code, "setup_running");
  assert.deepEqual(events, ["setup_checking", "setup_running"]);
  assert.ok(polls.length >= 1 && provisioner.timer);
  assert.deepEqual(w.dropped, [["iproxy", "UDID-1"]]);
  await provisioner.stop();
});

test("three failed looks pause setup as 'could not check' with two waits and a 30 second re-check", async () => {
  const w = world({ processScript: [undefined] });
  const { provisioner, timers, events, polls } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  assert.equal(w.looks.process, 3, "exactly three tries");
  const status = provisioner.getSetupStatus();
  assert.equal(status.code, "setup_paused_cannot_check");
  assert.equal(status.state, "paused");
  assert.deepEqual(events, ["setup_checking", "setup_paused_cannot_check"]);
  assert.deepEqual(timers.waits(), [30_000]);
  assert.equal(polls.length, 0);
  assert.equal(provisioner.timer, null);
  await provisioner.stop();
});

test("an earlier Bodun session that is still running pauses setup, and nothing is signalled", async () => {
  const w = world({ processScript: ["same"], ownerScript: ["alive"] });
  const { provisioner, timers } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  assert.equal(provisioner.getSetupStatus().code, "setup_paused_earlier_session");
  assert.equal(w.reclaims.length, 0, "a live owner means the leftover is not ours to stop");
  await provisioner.stop();
});

// ---- the 30 second re-check -----------------------------------------------------------------------------------

test("owner appears then disappears: the 30 second re-check clears the pause and then reclaims only under the exact-match rule", async () => {
  const w = world({ processScript: ["same"], ownerScript: ["alive", "alive", "alive", "alive", null] });
  const { provisioner, timers, events, polls } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  assert.equal(provisioner.getSetupStatus().code, "setup_paused_earlier_session");
  // first re-check: the owner is still alive
  await timers.fire(30_000);
  assert.equal(provisioner.getSetupStatus().code, "setup_paused_earlier_session");
  assert.equal(w.reclaims.length, 0);
  assert.deepEqual(timers.waits(), [30_000], "it keeps checking");
  // second re-check: the owner is gone, the leftover is reclaimed
  await timers.fire(30_000);
  assert.equal(provisioner.getSetupStatus().code, "setup_running");
  assert.equal(w.reclaims.length, 1);
  assert.equal(w.reclaims[0].description.pid, 4121, "only the exactly matching leftover");
  assert.deepEqual(w.dropped, [["iproxy", "UDID-1"]]);
  assert.deepEqual(events, ["setup_checking", "setup_paused_earlier_session", "setup_running"], "an unchanged pause is not announced again");
  assert.ok(polls.length >= 1 && provisioner.timer, "discovery and polling begin");
  assert.equal(timers.waits().length, 0, "no more re-checks once running");
  await provisioner.stop();
});

test("a re-check never invents a signal: it does not even look for the leftover again once the record is gone", async () => {
  const w = world({ processScript: [null] });
  const { provisioner } = build({ w });
  await provisioner.start();
  const before = w.looks.process;
  await provisioner.recheckNow();
  assert.equal(w.looks.process, before, "running: nothing to re-check");
  assert.equal(w.reclaims.length, 0);
  await provisioner.stop();
});

test("a stubborn leftover is reclaimed at most three times, then only looked at", async () => {
  const w = world({ processScript: ["same"], ownerScript: [null], store: { reclaimResult: () => ({ ok: false }) } });
  const { provisioner, timers } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  assert.equal(provisioner.getSetupStatus().code, "setup_paused_earlier_session");
  for (let round = 0; round < 4; round += 1) await timers.fire(30_000);
  assert.equal(w.reclaims.length, 3, "three attempts in all, never more");
  assert.equal(provisioner.getSetupStatus().code, "setup_paused_earlier_session");
  await provisioner.stop();
});

test("the file is re-read from disk before every check", async () => {
  const w = world({ processScript: [undefined] });
  const { provisioner, timers } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  assert.equal(w.store.reloads, 3);
  await timers.fire(30_000);
  assert.equal(w.store.reloads, 4);
  await provisioner.stop();
});

// ---- a damaged or unreadable record ---------------------------------------------------------------------------

function storeError(reason) {
  const error = new Error("record problem");
  error.code = "PROCESS_OWNERSHIP_STORE_UNAVAILABLE";
  error.reason = reason;
  return error;
}

test("a damaged record pauses setup at once, is not retried, and is not re-checked by itself", async () => {
  const w = world({ store: { reload: () => { throw storeError("damaged"); } } });
  const { provisioner, timers, events } = build({ w });
  await quietly(() => provisioner.start());
  assert.equal(provisioner.getSetupStatus().code, "setup_paused_record_damaged");
  assert.deepEqual(events, ["setup_checking", "setup_paused_record_damaged"]);
  assert.equal(w.store.reloads, 1, "no retries");
  assert.equal(timers.waits().length, 0, "no automatic re-check");
  await provisioner.stop();
});

test("an unreadable record is treated as 'could not check' and is retried", async () => {
  const w = world({ store: { reload: count => { if (count < 3) throw storeError("unreadable"); return { recovered: false }; } }, processScript: [null] });
  const { provisioner, timers } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await started;
  assert.equal(provisioner.getSetupStatus().code, "setup_running");
  await provisioner.stop();
});

test("a damaged record that Check again finds repaired clears the pause", async () => {
  let damaged = true;
  const w = world({ store: { reload: () => { if (damaged) throw storeError("damaged"); return { recovered: true }; } }, processScript: [null] });
  const { provisioner } = build({ w });
  await quietly(() => provisioner.start());
  assert.equal(provisioner.getSetupStatus().code, "setup_paused_record_damaged");
  damaged = false;
  const status = await provisioner.recheckNow();
  assert.equal(status.code, "setup_running");
  assert.ok(provisioner.timer);
  await provisioner.stop();
});

test("an unexpected error while checking is 'could not check', never a crash", async () => {
  const w = world();
  const { provisioner, timers } = build({ w });
  provisioner.sweepStaleOwnership = async () => { throw new Error("something odd"); };
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  assert.equal(provisioner.getSetupStatus().code, "setup_paused_cannot_check");
  await provisioner.stop();
});

// ---- Check again ---------------------------------------------------------------------------------------------

test("pressing Check again twice at once runs one check and both get the same answer", async () => {
  const w = world({ processScript: [undefined, undefined, undefined, null] });
  const { provisioner, timers } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  const before = w.looks.process;
  const first = provisioner.recheckNow();
  const second = provisioner.recheckNow();
  assert.equal(first, second, "the same in-flight check");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(w.looks.process, before + 1, "one look, not two");
  assert.deepEqual(a, b);
  assert.equal(a.code, "setup_running");
  await provisioner.stop();
});

test("Check again while still paused answers with the paused status and keeps checking by itself", async () => {
  const w = world({ processScript: [undefined] });
  const { provisioner, timers } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  const status = await provisioner.recheckNow();
  assert.equal(status.code, "setup_paused_cannot_check");
  assert.deepEqual(timers.waits(), [30_000]);
  await provisioner.stop();
});

test("Check again when setup is already running does nothing", async () => {
  const w = world({ processScript: [null] });
  const { provisioner } = build({ w });
  await provisioner.start();
  const looks = w.looks.process;
  const status = await provisioner.recheckNow();
  assert.equal(status.code, "setup_running");
  assert.equal(w.looks.process, looks);
  await provisioner.stop();
});

// ---- shutdown --------------------------------------------------------------------------------------------------

test("Check again is refused while Bodun is shutting down", async () => {
  const { provisioner } = build();
  await provisioner.stop();
  await assert.rejects(() => provisioner.recheckNow(), error => error instanceof LifecycleError && error.code === "shutting_down");
});

test("shutdown during a check ends it without clearing the pause or starting polling", async () => {
  const w = world({ processScript: [undefined] });
  const { provisioner, timers, polls } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  // the next look will succeed, but only after shutdown has begun
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  w.inspector.describe = async pid => { await gate; return pid === 4121 ? null : null; };
  const check = provisioner.recheckNow();
  await settle();
  const stopping = provisioner.stop();
  release();
  await check;
  await stopping;
  assert.equal(provisioner.timer, null, "no polling was started");
  assert.equal(polls.length, 0);
  assert.equal(timers.waits().length, 0, "the re-check timer is cleared");
});

test("shutdown during the retry wait wakes it at once, starts nothing, and leaves no timer behind", async () => {
  const w = world({ processScript: [undefined] });
  const { provisioner, timers, polls } = build({ w });
  const started = provisioner.start();
  await settle();
  assert.deepEqual(timers.waits(), [2000]);
  const stopping = provisioner.stop();
  await started;
  await stopping;
  assert.equal(polls.length, 0);
  assert.equal(provisioner.timer, null);
  assert.equal(timers.waits().length, 0);
});

test("the periodic re-check stops when the provisioner stops", async () => {
  const w = world({ processScript: [undefined] });
  const { provisioner, timers } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  assert.deepEqual(timers.waits(), [30_000]);
  await provisioner.stop();
  assert.equal(timers.waits().length, 0);
});

// ---- the status shape -------------------------------------------------------------------------------------------

test("the status carries the state, a code and a plain message, and says whether a check can change it", async () => {
  const w = world({ processScript: [undefined] });
  const { provisioner, timers } = build({ w });
  const started = provisioner.start();
  await settle();
  await timers.fire(2000);
  await timers.fire(2000);
  await quietly(() => started);
  const status = provisioner.getSetupStatus();
  assert.deepEqual(Object.keys(status).sort(), ["changesByItself", "code", "message", "state"]);
  assert.equal(status.changesByItself, true);
  assert.doesNotMatch(status.message, /[\\/]|4121|iproxy|UDID/);
  await provisioner.stop();
});
