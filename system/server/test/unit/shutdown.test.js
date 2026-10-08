import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createShutdownHandler } from "../../src/shutdown.js";
import { DeviceProvisioner } from "../../src/deviceProvisioner.js";

async function serverWithOpenSocket() {
  const server = http.createServer((_req, res) => res.end("ok"));
  const wss = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  return { server, wss, client };
}

test("G10: server.close(callback) alone never completes while a WebSocket stays open", async () => {
  const { server, wss, client } = await serverWithOpenSocket();
  let closed = false;
  server.close(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(closed, false, "this is why the old handler's cleanup callback could be delayed until the hard timeout");
  client.terminate();
  wss.close();
  server.closeAllConnections();
});

test("the handler runs cleanup and exits 0 even with a WebSocket open", async () => {
  const { server, wss, client } = await serverWithOpenSocket();
  const events = [];
  let exited;
  const done = new Promise(resolve => { exited = resolve; });
  const handle = createShutdownHandler({
    server,
    cleanupRuntime: async () => { events.push("cleanup"); },
    exit: code => { events.push(`exit ${code}`); exited(code); },
    hardStopMs: 2000,
  });
  const started = Date.now();
  handle();
  assert.equal(await done, 0);
  assert.deepEqual(events, ["cleanup", "exit 0"]);
  assert.ok(Date.now() - started < 1500, "well inside the bound");
  client.terminate();
  wss.close();
});

test("cleanup starts before connections are dropped", async () => {
  const order = [];
  const server = { closeAllConnections: () => order.push("drop connections"), close: () => order.push("close") };
  const handle = createShutdownHandler({
    server, cleanupRuntime: () => { order.push("cleanup started"); return new Promise(() => {}); },
    exit: () => {}, hardStopMs: 50,
  });
  handle();
  assert.deepEqual(order, ["cleanup started", "drop connections", "close"]);
});

test("a hung cleanup is cut off at the hard stop with a failure code", async () => {
  let exitCode = null;
  const handle = createShutdownHandler({
    cleanupRuntime: () => new Promise(() => {}), exit: code => { exitCode = code; }, hardStopMs: 30,
  });
  handle();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(exitCode, 1);
});

test("a second signal is a no-op", async () => {
  let cleanups = 0;
  const handle = createShutdownHandler({ cleanupRuntime: async () => { cleanups += 1; }, exit: () => {}, hardStopMs: 100 });
  handle();
  handle();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(cleanups, 1);
});

test("a failing cleanup still exits 0 after logging (the processes are the priority, not the report)", async () => {
  const logs = [];
  let exitCode = null;
  const handle = createShutdownHandler({
    cleanupRuntime: async () => { throw new Error("boom"); }, exit: code => { exitCode = code; }, log: line => logs.push(line), hardStopMs: 200,
  });
  handle();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(exitCode, 0);
  assert.ok(logs.some(line => /cleanup failed/.test(line)));
});

test("DeviceProvisioner.stop() terminates the managed processes before a hung discovery pass settles", async () => {
  const calls = [];
  const manager = name => ({
    on() { return this; }, stopAll: () => { calls.push(`${name}.stopAll`); return Promise.resolve([]); },
  });
  const provisioner = new DeviceProvisioner({
    devices: new Map(), discoverIosDevices: () => [], wdaProcessManager: manager("wda"), iproxyManager: manager("iproxy"),
    provisioningStorePath: "/tmp/none.json", derivedDataRoot: "/tmp/d",
  });
  let releasePoll;
  provisioner.pollOperation = new Promise(resolve => { releasePoll = resolve; });
  const stopping = provisioner.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(0, 2).sort(), ["iproxy.stopAll", "wda.stopAll"], "issued while the poll is still hung");
  releasePoll();
  await stopping;
  assert.ok(calls.length >= 4, "and once more afterwards for anything started late");
});

test("the site agent awaits the provisioner's stop before exiting (it used to start it and exit at once)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../src/agentMain.js", import.meta.url), "utf8");
  assert.match(source, /createShutdownHandler\(/);
  assert.match(source, /await provisioner\?\.stop\?\.\(\)/);
  assert.doesNotMatch(source, /provisioner\?\.stop\?\.\(\);\s*process\.exit\(0\)/);
});
