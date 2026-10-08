// Demo only (never packaged, never started unless `npm run demo -- --broken-phones` was asked for).
//
// Puts two phones in the Fleet in the states seen in the screen recording, reached by the REAL provisioner code over
// pretend processes and a pretend operating system:
//   Phone A  the phone connection (port) is held by another program: "port blocked"
//   Phone B  control was stopped by an operator, and a network enrollment is pending on it
// Nothing here opens a socket, runs a command or looks at a real process.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceProvisioner } from "../src/deviceProvisioner.js";
import { discoveredDeviceId } from "../src/deviceDiscovery.js";
import { createPortReclaimer } from "../src/portReclaimer.js";
import { DEMO_CONTROL_PORT_RANGE, DEMO_VIDEO_PORT_RANGE } from "./demoOptions.js";
import { STORE_UNAVAILABLE } from "../src/processOwnershipStore.js";

// Stands in for the WDA / iproxy process managers: same shape, nothing is ever started.
export class PretendProcessManager {
  constructor() {
    this.emitter = new EventEmitter();
    this.starts = [];
    this.running = new Set();
  }
  on(...args) { this.emitter.on(...args); return this; }
  start(options) { this.starts.push(options); this.running.add(options.udid); this.emitter.emit("starting", { key: options.udid }); return "started"; }
  stop(udid) { this.running.delete(udid); return { ok: true }; }
  stopAll() { for (const udid of [...this.running]) this.stop(udid); }
  getStatus(udid) { return { state: this.running.has(udid) ? "running" : "stopped", restartCount: 0 }; }
  ownsMapping(udid, { localPort, mjpegLocalPort }) {
    const last = [...this.starts].reverse().find(start => start.udid === udid);
    return this.running.has(udid) && last?.localPort === localPort && last?.mjpegLocalPort === mjpegLocalPort;
  }
  emitExit(udid, log = []) { this.emitter.emit("exit", { key: udid, code: 1, signal: null, log }); }
}

// A pretend operating system: which program listens on which port. Read-only for the code that uses it.
export function createPretendSystem() {
  const processes = new Map();
  const listeners = new Map(); // port -> [pid]
  return {
    inspector: {
      supported: true,
      describe: async pid => processes.get(pid) ?? null,
      findListeners: async port => ({ supported: true, listeners: (listeners.get(port) ?? []).map(pid => ({ pid })) }),
    },
    isPortAvailable: async port => (listeners.get(port) ?? []).length === 0,
    holdPort(port, pid, description) {
      processes.set(pid, { pid, ppid: 3333, pgid: pid, startTime: "Tue Oct 6 19:00:00 2026", ...description });
      listeners.set(port, [...(listeners.get(port) ?? []), pid]);
    },
  };
}

export const PHONE_A = Object.freeze({ id: "demo-phone-a", udid: "DEMO-PHONE-A-0000", label: "Demo phone A (port blocked)" });
export const PHONE_B = Object.freeze({ id: "demo-phone-b", udid: "DEMO-PHONE-B-0000", label: "Demo phone B (control stopped)" });
export const FOREIGN_PROGRAM = Object.freeze({ program: "proxy-tool", pid: 7421 });

// Builds the provisioner and brings the two phones to their states. `devices` is the server's own device map and
// `onDeviceListChanged` is the server's broadcast, so the Fleet page updates exactly as it would for a real phone.
// With `pausedSetup`, the record of earlier phone connections reads as damaged, so the real provisioner pauses and says so.
export function createDamagedRecordStore() {
  return {
    flush: async () => {},
    reload: () => { throw Object.assign(new Error("the record is damaged"), { code: STORE_UNAVAILABLE, reason: "damaged" }); },
    list: () => [],
    get: () => null,
  };
}

export async function installBrokenPhones({ devices, onDeviceListChanged = () => {}, storeDir, pausedSetup = false } = {}) {
  const folder = storeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-demo-phones-"));
  const world = createPretendSystem();
  const wdaProcessManager = new PretendProcessManager();
  const iproxyManager = new PretendProcessManager();
  const attached = [PHONE_A, PHONE_B].map(phone => ({ id: phone.id, udid: phone.udid, label: phone.label }));
  const provisioner = new DeviceProvisioner({
    devices,
    discoverIosDevices: () => attached,
    manualUdids: new Set(),
    wdaProcessManager,
    iproxyManager,
    provisioningStorePath: path.join(folder, "device-provisioning.json"),
    derivedDataRoot: path.join(folder, "derived"),
    portRange: { ...DEMO_CONTROL_PORT_RANGE },
    mjpegPortRange: { ...DEMO_VIDEO_PORT_RANGE },
    isPortAvailable: world.isPortAvailable,
    portReclaimer: createPortReclaimer({ inspector: world.inspector, kill: () => { throw new Error("the demo never signals a process"); }, sleep: async () => {} }),
    onDeviceListChanged,
    ...(pausedSetup ? { ownershipStore: createDamagedRecordStore() } : {}),
    // Only the demo's own two phones, polled slowly: nothing changes by itself once they are in their states.
    pollIntervalMs: 60_000,
  });

  await provisioner.pollOnce();
  const idA = discoveredDeviceId(PHONE_A.udid);
  const idB = discoveredDeviceId(PHONE_B.udid);

  // Phone A: another program takes the phone's connection port, then its tunnel fails with "address already in use".
  const tunnel = iproxyManager.starts.find(start => start.udid === PHONE_A.udid);
  for (const port of [tunnel.localPort, tunnel.mjpegLocalPort]) {
    world.holdPort(port, FOREIGN_PROGRAM.pid, { program: FOREIGN_PROGRAM.program, command: `${FOREIGN_PROGRAM.program} --listen ${port}` });
  }
  iproxyManager.emitExit(PHONE_A.udid, ["bind: Address already in use"]);
  for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setImmediate(resolve));

  // Phone B: an operator stopped its control service.
  await provisioner.stopDevice(idB, { authorize: async () => {} });

  await provisioner.start(); // settles the setup status (running, or paused when asked for) before the page can ask for it
  onDeviceListChanged();
  return { provisioner, world, wdaProcessManager, iproxyManager, ids: { a: idA, b: idB }, folder };
}

// Starts a network enrollment on phone B through the real route, exactly as an operator would from the card.
// Signs in again and retries a few times: the server may still be settling right after it starts listening.
export async function startEnrollmentOnB({ baseUrl, username, password, deviceId, fetchImpl = fetch, attempts = 5, pauseMs = 400 }) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const login = await fetchImpl(`${baseUrl}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
    });
    if (login.ok) {
      // The server sends the headers before the session is saved and only the last byte after it: read the whole
      // answer first, or the next request can arrive before the session exists and be refused.
      await login.text();
      const cookies = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie")];
      const cookie = cookies.filter(Boolean).map(value => value.split(";")[0]).join("; ");
      const started = await fetchImpl(`${baseUrl}/api/admin/devices/${encodeURIComponent(deviceId)}/network-enrollment/start`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}",
      });
      if (started.ok) return started.json();
      lastStatus = started.status;
    } else {
      lastStatus = login.status;
    }
    await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  throw new Error(`The demo could not start the enrollment (HTTP ${lastStatus}).`);
}
