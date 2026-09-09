import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNetworkConfig, loadDeviceNetworkMap, egressIdentity } from "../../src/deviceNetworkConfig.js";

test("parseNetworkConfig returns null for a device with no network block yet", () => {
  assert.equal(parseNetworkConfig(undefined, "mock-1"), null);
  assert.equal(parseNetworkConfig(null, "mock-1"), null);
});

test("parseNetworkConfig accepts a valid cellular-sim assignment", () => {
  const parsed = parseNetworkConfig({ egress: "cellular-sim", simIccid: "8901410...", controlIface: "usb" }, "d1");
  assert.deepEqual(parsed, { egress: "cellular-sim", vlanId: null, simIccid: "8901410...", controlIface: "usb" });
});

test("parseNetworkConfig accepts a valid vlan-proxy assignment", () => {
  const parsed = parseNetworkConfig({ egress: "vlan-proxy", vlanId: "vlan-7", controlIface: "usb" }, "d1");
  assert.deepEqual(parsed, { egress: "vlan-proxy", vlanId: "vlan-7", simIccid: null, controlIface: "usb" });
});

test("parseNetworkConfig rejects a non-object network block", () => {
  assert.throws(() => parseNetworkConfig("cellular-sim", "d1"), /must be an object/);
  assert.throws(() => parseNetworkConfig(["cellular-sim"], "d1"), /must be an object/);
});

test("parseNetworkConfig rejects an unknown egress value", () => {
  assert.throws(
    () => parseNetworkConfig({ egress: "wifi-shared", controlIface: "usb" }, "d1"),
    /invalid network\.egress "wifi-shared"/
  );
});

test("parseNetworkConfig requires simIccid for cellular-sim", () => {
  assert.throws(
    () => parseNetworkConfig({ egress: "cellular-sim", controlIface: "usb" }, "d1"),
    /egress "cellular-sim" but no simIccid/
  );
  assert.throws(
    () => parseNetworkConfig({ egress: "cellular-sim", simIccid: "  ", controlIface: "usb" }, "d1"),
    /egress "cellular-sim" but no simIccid/
  );
});

test("parseNetworkConfig requires vlanId for vlan-proxy", () => {
  assert.throws(
    () => parseNetworkConfig({ egress: "vlan-proxy", controlIface: "usb" }, "d1"),
    /egress "vlan-proxy" but no vlanId/
  );
});

test("parseNetworkConfig requires controlIface to be exactly \"usb\"", () => {
  assert.throws(
    () => parseNetworkConfig({ egress: "vlan-proxy", vlanId: "vlan-7" }, "d1"),
    /network\.controlIface "undefined"/
  );
  assert.throws(
    () => parseNetworkConfig({ egress: "vlan-proxy", vlanId: "vlan-7", controlIface: "wifi" }, "d1"),
    /network\.controlIface "wifi"/
  );
});

test("parseNetworkConfig error messages name the offending device id", () => {
  assert.throws(() => parseNetworkConfig({ egress: "bogus" }, "bench-3"), /device "bench-3"/);
});

test("loadDeviceNetworkMap builds one entry per device, defaulting to null when unassigned", () => {
  const map = loadDeviceNetworkMap({
    devices: [
      { id: "mock-1", label: "A", type: "mock" },
      { id: "mock-2", label: "B", type: "mock", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } },
    ],
  });
  assert.equal(map.get("mock-1"), null);
  assert.equal(map.get("mock-2").egress, "cellular-sim");
});

test("loadDeviceNetworkMap propagates a validation error with the offending device id", () => {
  assert.throws(
    () =>
      loadDeviceNetworkMap({
        devices: [{ id: "mock-1", label: "A", type: "mock", network: { egress: "bogus", controlIface: "usb" } }],
      }),
    /device "mock-1"/
  );
});

test("loadDeviceNetworkMap treats a missing devices array as empty, matching loadDevices()'s own fallback", () => {
  const map = loadDeviceNetworkMap({});
  assert.equal(map.size, 0);
});

test("egressIdentity is null for an unassigned device", () => {
  assert.equal(egressIdentity(null), null);
});

test("egressIdentity keys cellular-sim by simIccid and vlan-proxy by vlanId", () => {
  assert.equal(egressIdentity({ egress: "cellular-sim", simIccid: "111", vlanId: null, controlIface: "usb" }), "sim:111");
  assert.equal(egressIdentity({ egress: "vlan-proxy", vlanId: "vlan-7", simIccid: null, controlIface: "usb" }), "vlan:vlan-7");
});

test("egressIdentity treats two different simIccids (or vlanIds) as different identities", () => {
  const a = egressIdentity({ egress: "cellular-sim", simIccid: "111", vlanId: null, controlIface: "usb" });
  const b = egressIdentity({ egress: "cellular-sim", simIccid: "222", vlanId: null, controlIface: "usb" });
  assert.notEqual(a, b);
});
