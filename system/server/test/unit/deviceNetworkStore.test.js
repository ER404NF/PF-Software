import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { setDeviceProxyEnabled } from "../../src/deviceNetworkStore.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-proxy-store-"));
  const configPath = path.join(root, "devices.config.json");
  const config = {
    devices: [
      { id: "proxy-phone", label: "Proxy phone", type: "mock", network: { egress: "vlan-proxy", vlanId: "vlan-1", controlIface: "usb" } },
      { id: "sim-phone", label: "SIM phone", type: "mock", network: { egress: "cellular-sim", simIccid: "8901", controlIface: "usb" } },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return configPath;
}

test("proxy assignment switch persists without exposing or rewriting unrelated device configuration", (t) => {
  const configPath = fixture(t);
  const disabled = setDeviceProxyEnabled({ configPath, deviceId: "proxy-phone", enabled: false });
  assert.equal(disabled.enabled, false);

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(saved.devices[0].network.enabled, false);
  assert.equal(saved.devices[0].network.vlanId, "vlan-1");
  assert.equal(saved.devices[1].network.simIccid, "8901");

  const enabled = setDeviceProxyEnabled({ configPath, deviceId: "proxy-phone", enabled: true });
  assert.equal(enabled.enabled, true);
});

test("proxy assignment switch rejects invalid values, unknown devices, and non-proxy egress", (t) => {
  const configPath = fixture(t);
  assert.throws(
    () => setDeviceProxyEnabled({ configPath, deviceId: "proxy-phone", enabled: "yes" }),
    error => error.status === 400 && /boolean/.test(error.message),
  );
  assert.throws(
    () => setDeviceProxyEnabled({ configPath, deviceId: "missing", enabled: true }),
    error => error.status === 404 && /unknown device/.test(error.message),
  );
  assert.throws(
    () => setDeviceProxyEnabled({ configPath, deviceId: "sim-phone", enabled: false }),
    error => error.status === 409 && /does not have a proxy/.test(error.message),
  );
});
