import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { IProxyManager } from "../../src/iproxyManager.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test("start() always passes -u <udid> — never an unscoped iproxy", () => {
  const calls = [];
  const spawn = (bin, args) => { calls.push({ bin, args }); return fakeChild(); };
  const manager = new IProxyManager({ spawn, bin: "iproxy" });
  manager.start({ udid: "00008110-ABCDEF1234567890", localPort: 8101 });
  assert.equal(calls[0].bin, "iproxy");
  assert.deepEqual(calls[0].args, ["-u", "00008110-ABCDEF1234567890", "8101:8100"]);
});

test("start() honors a custom device-side port", () => {
  const calls = [];
  const spawn = (bin, args) => { calls.push(args); return fakeChild(); };
  const manager = new IProxyManager({ spawn, bin: "iproxy" });
  manager.start({ udid: "udid-1", localPort: 8102, devicePort: 8200 });
  assert.deepEqual(calls[0], ["-u", "udid-1", "8102:8200"]);
});

test("start() refuses to run without a UDID", () => {
  const manager = new IProxyManager({ spawn: () => fakeChild() });
  assert.throws(() => manager.start({ localPort: 8101 }), /requires a UDID/);
});

test("start() rejects an out-of-range local port", () => {
  const manager = new IProxyManager({ spawn: () => fakeChild() });
  assert.throws(() => manager.start({ udid: "udid-1", localPort: 0 }), /valid localPort/);
  assert.throws(() => manager.start({ udid: "udid-1", localPort: 70000 }), /valid localPort/);
});

test("start() forwards the MJPEG video port too when one is given, in the same iproxy process", () => {
  const calls = [];
  const spawn = (bin, args) => { calls.push(args); return fakeChild(); };
  const manager = new IProxyManager({ spawn, bin: "iproxy" });
  manager.start({ udid: "udid-1", localPort: 8101, mjpegLocalPort: 9101 });
  assert.deepEqual(calls[0], ["-u", "udid-1", "8101:8100", "9101:9100"]);
});

test("start() rejects an MJPEG port that is invalid or equal to the control port", () => {
  const manager = new IProxyManager({ spawn: () => fakeChild() });
  assert.throws(() => manager.start({ udid: "udid-1", localPort: 8101, mjpegLocalPort: 8101 }), /mjpegLocalPort/);
  assert.throws(() => manager.start({ udid: "udid-1", localPort: 8101, mjpegLocalPort: 70000 }), /mjpegLocalPort/);
});
