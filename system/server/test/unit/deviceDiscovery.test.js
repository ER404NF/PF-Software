import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverIosDevices, discoveredDeviceId } from "../../src/deviceDiscovery.js";

test("Mac discovery reads connected UDIDs and their current iPhone names", () => {
  const calls = [];
  const execFile = (command, args) => {
    calls.push([command, args]);
    if (command === "idevice_id") return "00008110-ABCDEF1234567890\n00008110-ABCDEF1234567890\n00008120-1111222233334444\n";
    return args[1].includes("ABCDEF") ? "Studio iPhone\n" : "Travel iPhone\n";
  };
  const devices = discoverIosDevices({ platform: "darwin", execFile });
  assert.deepEqual(devices, [
    { id: discoveredDeviceId("00008110-ABCDEF1234567890"), udid: "00008110-ABCDEF1234567890", label: "Studio iPhone" },
    { id: discoveredDeviceId("00008120-1111222233334444"), udid: "00008120-1111222233334444", label: "Travel iPhone" },
  ]);
  assert.equal(calls.filter(([command]) => command === "ideviceinfo").length, 2);
});

test("discovery is empty away from macOS or when libimobiledevice is unavailable", () => {
  assert.deepEqual(discoverIosDevices({ platform: "win32", execFile: () => { throw new Error("must not run"); } }), []);
  assert.deepEqual(discoverIosDevices({ platform: "darwin", execFile: () => { throw new Error("missing"); } }), []);
});

test("discovery uses resolved absolute libimobiledevice binaries", () => {
  const calls = [];
  const devices = discoverIosDevices({
    platform: "darwin",
    ideviceIdBin: "/opt/homebrew/bin/idevice_id",
    ideviceInfoBin: "/opt/homebrew/bin/ideviceinfo",
    execFile: (command, args) => {
      calls.push([command, args]);
      return args[0] === "-l" ? "UDID-00000001\n" : "Phone\n";
    },
  });
  assert.equal(devices.length, 1);
  assert.equal(calls[0][0], "/opt/homebrew/bin/idevice_id");
  assert.equal(calls[1][0], "/opt/homebrew/bin/ideviceinfo");
});
