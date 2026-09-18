import test from "node:test";
import assert from "node:assert/strict";
import { loadDeviceConfig } from "../../src/deviceConfigLoader.js";

test("desktop automatic mode ignores the repository default device fixture", () => {
  const config = loadDeviceConfig({
    env: { DESKTOP_AUTO_DEVICE_MODE: "true" },
    defaultPath: "/repo/system/devices.config.json",
    existsSync: () => true,
    readFileSync: () => { throw new Error("default fixture must not be read"); },
  });
  assert.deepEqual(config, { devices: [] });
});

test("an explicit manual device config remains supported in desktop automatic mode", () => {
  const config = loadDeviceConfig({
    env: { DESKTOP_AUTO_DEVICE_MODE: "true", DEVICE_CONFIG_PATH: "/private/manual.json" },
    defaultPath: "/repo/system/devices.config.json",
    existsSync: candidate => candidate === "/private/manual.json",
    readFileSync: () => JSON.stringify({ devices: [{ id: "phone-1", type: "wda" }] }),
  });
  assert.equal(config.devices[0].id, "phone-1");
});

test("ordinary server startup still loads the default device config", () => {
  const config = loadDeviceConfig({
    env: {},
    defaultPath: "/repo/system/devices.config.json",
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ devices: [{ id: "mock-1", type: "mock" }] }),
  });
  assert.equal(config.devices[0].id, "mock-1");
});
