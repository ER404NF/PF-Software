import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { TunManager, buildProxyUrl, redactProxyCredentials, parseTunPeer, discoverTunPeer, listAllInterfaces, allocateTunIface } from "../../src/tunManager.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

const SAMPLE_PROXY = { protocol: "socks5", host: "proxy.example.com", port: 7000, username: "user1", password: "p@ss/word" };

test("buildProxyUrl percent-encodes credentials with special characters", () => {
  const url = buildProxyUrl(SAMPLE_PROXY);
  assert.equal(url, "socks5://user1:p%40ss%2Fword@proxy.example.com:7000");
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
