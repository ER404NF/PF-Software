import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TunManager, buildProxyUrl, redactProxyCredentials, parseTunPeer, discoverTunPeer, listAllInterfaces, allocateTunIface } from "../../src/tunManager.js";
import { createProcessOwnershipStore } from "../../src/processOwnershipStore.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function ownedChild(pid = 4100) {
  const child = fakeChild();
  child.pid = pid;
  child.signals = [];
  child.kill = signal => { child.signals.push(signal || "SIGTERM"); };
  return child;
}

const SAMPLE_PROXY = { protocol: "socks5", host: "proxy.example.com", port: 7000, username: "user1", password: "p@ss/word" };

test("buildProxyUrl percent-encodes credentials with special characters", () => {
  const url = buildProxyUrl(SAMPLE_PROXY);
  assert.equal(url, "socks5://user1:p%40ss%2Fword@proxy.example.com:7000");
});

test("buildProxyUrl preserves provider username syntax and surrounding whitespace through percent-encoding", () => {
  const proxy = { ...SAMPLE_PROXY, username: " customer-country-US-session-abc ", password: " p@ss:/?#[] " };
  assert.equal(buildProxyUrl(proxy), `socks5://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@proxy.example.com:7000`);
});

test("buildProxyUrl omits the auth segment entirely when there is no username", () => {
  const url = buildProxyUrl({ protocol: "http", host: "proxy.example.com", port: 8080, username: "", password: "" });
  assert.equal(url, "http://proxy.example.com:8080");
});

test("buildProxyUrl rejects an invalid protocol", () => {
  assert.throws(() => buildProxyUrl({ ...SAMPLE_PROXY, protocol: "ftp" }), /invalid proxy protocol/);
});

test("buildProxyUrl rejects a missing host or out-of-range port", () => {
  assert.throws(() => buildProxyUrl({ ...SAMPLE_PROXY, host: "" }), /host is required/);
  assert.throws(() => buildProxyUrl({ ...SAMPLE_PROXY, port: 0 }), /port must be/);
  assert.throws(() => buildProxyUrl({ ...SAMPLE_PROXY, port: 70000 }), /port must be/);
});

test("redactProxyCredentials strips only the credential segment, keeping host:port visible", () => {
  assert.equal(
    redactProxyCredentials("connecting to socks5://user1:p%40ss@proxy.example.com:7000 ..."),
    "connecting to socks5://***@proxy.example.com:7000 ..."
  );
});

test("redactProxyCredentials leaves ordinary text untouched", () => {
  assert.equal(redactProxyCredentials("tun2proxy: bound utun7"), "tun2proxy: bound utun7");
});

test("start() runs through sudo -n, never --setup, and the argv is never a shell string", () => {
  const calls = [];
  const spawn = (bin, args) => { calls.push({ bin, args }); return fakeChild(); };
  const manager = new TunManager({ spawn, sudoBin: "sudo", tun2proxyBin: "tun2proxy" });
  manager.start({ deviceId: "mock-1", tunIface: "utun7", proxy: SAMPLE_PROXY });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "sudo");
  assert.deepEqual(calls[0].args, [
    "-n", "tun2proxy", "--tun", "utun7", "--proxy", buildProxyUrl(SAMPLE_PROXY), "--dns", "virtual", "--verbosity", "info",
  ]);
  assert.equal(calls[0].args.includes("--setup"), false);
});

test("start() requires deviceId and tunIface", () => {
  const manager = new TunManager({ spawn: () => fakeChild() });
  assert.throws(() => manager.start({ tunIface: "utun7", proxy: SAMPLE_PROXY }), /requires a deviceId/);
  assert.throws(() => manager.start({ deviceId: "mock-1", proxy: SAMPLE_PROXY }), /requires a tunIface/);
});

test("stdout/stderr and exit/restart-limit log lines are redacted before any listener sees them", async () => {
  let child;
  const spawn = () => { child = fakeChild(); return child; };
  const manager = new TunManager({ spawn, restartBackoffMs: [] });
  const logLines = [];
  const exits = [];
  manager.on("log", (event) => logLines.push(event.line));
  manager.on("exit", (event) => exits.push(event.log));
  manager.start({ deviceId: "mock-1", tunIface: "utun7", proxy: SAMPLE_PROXY });
  child.stderr.emit("data", Buffer.from(`connecting via ${buildProxyUrl(SAMPLE_PROXY)}`));
  child.emit("exit", 1, null);

  assert.equal(logLines.length, 1);
  assert.equal(logLines[0].includes("p%40ss"), false);
  assert.equal(logLines[0].includes("user1"), false);
  assert.match(logLines[0], /socks5:\/\/\*\*\*@proxy\.example\.com:7000/);
  assert.equal(exits[0].some(line => line.includes("user1")), false);
});

const IFCONFIG_TUN_SAMPLE = "utun7: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500\n\tinet 10.0.0.2 --> 10.0.0.1 netmask 0xffffffff\n";

test("parseTunPeer extracts the local and peer point-to-point addresses", () => {
  assert.deepEqual(parseTunPeer(IFCONFIG_TUN_SAMPLE), { localIp: "10.0.0.2", peerIp: "10.0.0.1" });
});

test("parseTunPeer returns null when the interface has no point-to-point peer yet", () => {
  assert.equal(parseTunPeer("utun7: flags=8010<POINTOPOINT,MULTICAST> mtu 1500\n"), null);
  assert.equal(parseTunPeer(""), null);
});

test("discoverTunPeer shells out to ifconfig <tunIface> and parses the result", async () => {
  const calls = [];
  const execFile = (bin, args, options, callback) => { calls.push({ bin, args }); callback(null, IFCONFIG_TUN_SAMPLE, ""); };
  const peer = await discoverTunPeer({ tunIface: "utun7", execFile });
  assert.deepEqual(peer, { localIp: "10.0.0.2", peerIp: "10.0.0.1" });
  assert.equal(calls[0].bin, "ifconfig");
  assert.deepEqual(calls[0].args, ["utun7"]);
});

test("discoverTunPeer requires a tunIface and throws clearly when no peer is found", async () => {
  await assert.rejects(() => discoverTunPeer({ execFile: () => {} }), /tunIface is required/);
  const execFile = (bin, args, options, callback) => callback(null, "utun7: flags=8010<POINTOPOINT> mtu 1500\n", "");
  await assert.rejects(() => discoverTunPeer({ tunIface: "utun7", execFile }), /no point-to-point peer address/);
});

test("listAllInterfaces parses ifconfig -l's space-separated interface list", async () => {
  const calls = [];
  const execFile = (bin, args, options, callback) => { calls.push({ bin, args }); callback(null, "lo0 en0 en1 bridge0 utun0 utun1\n", ""); };
  const ifaces = await listAllInterfaces({ execFile });
  assert.deepEqual(ifaces, ["lo0", "en0", "en1", "bridge0", "utun0", "utun1"]);
  assert.deepEqual(calls[0], { bin: "ifconfig", args: ["-l"] });
});

test("allocateTunIface picks the first free utunN when there is no preference", () => {
  assert.equal(allocateTunIface({ existingIfaces: ["lo0", "en0", "utun0", "utun1"] }), "utun2");
});

test("allocateTunIface reuses a persisted preference when it is still free", () => {
  assert.equal(allocateTunIface({ existingIfaces: ["utun0"], preferred: "utun5" }), "utun5");
});

test("allocateTunIface ignores a preference that is currently occupied", () => {
  assert.equal(allocateTunIface({ existingIfaces: ["utun0", "utun5"], preferred: "utun5" }), "utun1");
});

test("allocateTunIface throws once the range is exhausted", () => {
  const existingIfaces = Array.from({ length: 3 }, (_, n) => `utun${n}`);
  assert.throws(() => allocateTunIface({ existingIfaces, rangeStart: 0, rangeEnd: 2 }), /no free utun interface/);
});

test("getLog() also returns redacted lines", () => {
  let child;
  const spawn = () => { child = fakeChild(); return child; };
  const manager = new TunManager({ spawn });
  manager.start({ deviceId: "mock-1", tunIface: "utun7", proxy: SAMPLE_PROXY });
  child.stdout.emit("data", Buffer.from(buildProxyUrl(SAMPLE_PROXY)));
  assert.equal(manager.getLog("mock-1")[0].includes("user1"), false);
});

test("stop() returns the supervisor result and managed IDs remain enumerable", async () => {
  const manager = new TunManager({ spawn: () => fakeChild() });
  manager.start({ deviceId: "mock-1", tunIface: "utun7", proxy: SAMPLE_PROXY });
  assert.deepEqual(manager.listManagedDeviceIds(), ["mock-1"]);
  manager.group.stop = () => Promise.resolve({ ok: false, error: "unconfirmed exit" });
  assert.deepEqual(await manager.stop("mock-1"), { ok: false, error: "unconfirmed exit" });
});

test("stopAll waits for durable ownership cleanup before shutdown completes", async () => {
  const order = [];
  const ownershipStore = {
    list: () => [],
    flush: async () => { order.push("flushed"); },
  };
  const manager = new TunManager({ spawn: () => fakeChild(), ownershipStore });
  manager.group.stopAll = async () => { order.push("stopped"); return [{ ok: true }]; };

  assert.deepEqual(await manager.stopAll(), [{ ok: true }]);
  assert.deepEqual(order, ["stopped", "flushed"]);
});

test("tun2proxy ownership is durable and never persists proxy credentials", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "tun-owner-"));
  const file = path.join(folder, "processes.json");
  const command = `sudo -n tun2proxy --tun utun7 --proxy ${buildProxyUrl(SAMPLE_PROXY)} --dns virtual --verbosity info`;
  const inspector = { supported: true, describe: async pid => ({
    pid, ppid: 1, startTime: "start-a", program: "sudo", command,
  }) };
  const store = createProcessOwnershipStore({ filePath: file, inspector, owner: { pid: 22, startTime: "server-a" }, sleep: async () => {} });
  const child = ownedChild();
  const manager = new TunManager({ spawn: () => child, ownershipStore: store });

  manager.start({ deviceId: "phone-a", tunIface: "utun7", proxy: SAMPLE_PROXY });
  assert.equal(await manager.waitForOwnership("phone-a"), true);
  await store.flush();
  const raw = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /user1|p%40ss|p@ss|proxy\.example\.com|socks5:\/\//);
  const record = store.get("tun2proxy", "phone-a");
  assert.equal(record.tunIface, "utun7");
  assert.equal(record.executableIdentity, "sudo");
  assert.equal(record.command.includes("--proxy <redacted>"), true);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("ownership registration failure kills tun2proxy and blocks replacement", async () => {
  const child = ownedChild();
  const ownershipStore = {
    record: async () => { throw new Error("disk unavailable"); },
    release: async () => false,
    confirmGone: async () => false,
    list: () => [],
  };
  const manager = new TunManager({ spawn: () => child, ownershipStore });
  manager.start({ deviceId: "phone-a", tunIface: "utun7", proxy: SAMPLE_PROXY });
  assert.equal(await manager.waitForOwnership("phone-a"), false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(manager.getStatus("phone-a").state, "stop_failed");
  assert.equal(manager.start({ deviceId: "phone-a", tunIface: "utun7", proxy: SAMPLE_PROXY }), "blocked");
});

test("restart recovery stops only the exact persisted tun2proxy process", async () => {
  const records = [{
    kind: "tun2proxy", udid: "phone-a", pid: 5100, startTime: "start-a",
    command: "sudo -n tun2proxy --tun utun9 --proxy socks5://***@proxy.example.com:7000 --dns virtual --verbosity info",
    executableIdentity: "sudo", tunIface: "utun9", unverified: false,
    ownerServerPid: 20, ownerServerStartTime: "old-server",
  }];
  let processDescription = {
    pid: 5100, ppid: 1, startTime: "start-a", program: "sudo",
    command: `sudo -n tun2proxy --tun utun9 --proxy ${buildProxyUrl(SAMPLE_PROXY)} --dns virtual --verbosity info`,
  };
  const dropped = [];
  const store = {
    list: () => records,
    inspectCurrent: async () => processDescription ? { status: "owned", record: records[0] } : { status: "gone", record: records[0] },
    drop: async (kind, id) => { dropped.push([kind, id]); },
  };
  const signals = [];
  const manager = new TunManager({ ownershipStore: store, spawn: () => ownedChild(),
    killProcess: (pid, signal) => { signals.push([pid, signal]); processDescription = null; }, sleep: async () => {} });
  assert.deepEqual(manager.listManagedDeviceIds(), ["phone-a"]);
  assert.deepEqual(await manager.recoverPersistedOwnership(), { recovered: 1 });
  assert.deepEqual(signals, [[5100, "SIGTERM"]]);
  assert.deepEqual(dropped, [["tun2proxy", "phone-a"]]);
});

test("restart recovery preserves a reused or unverifiable foreign pid", async () => {
  for (const status of ["reused", "foreign", "unknown"]) {
    const record = { kind: "tun2proxy", udid: `phone-${status}`, pid: 6100, startTime: "old", unverified: false };
    const signals = [];
    const dropped = [];
    const store = {
      list: () => [record],
      inspectCurrent: async () => ({ status, record }),
      drop: async (...args) => { dropped.push(args); },
    };
    const manager = new TunManager({ ownershipStore: store, spawn: () => ownedChild(),
      killProcess: (...args) => signals.push(args), sleep: async () => {} });
    if (status === "reused") {
      assert.deepEqual(await manager.recoverPersistedOwnership(), { recovered: 0 });
      assert.deepEqual(dropped, [["tun2proxy", `phone-${status}`]]);
    } else {
      await assert.rejects(manager.recoverPersistedOwnership(), /cannot prove ownership/);
      assert.deepEqual(dropped, []);
    }
    assert.deepEqual(signals, []);
  }
});
