import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBridgeMembers, diffBridgeMembers, listBridgeMembers, parseInterfaceIp, discoverBridgeOwnIp } from "../../src/usbNetworkMapper.js";

// A real `ifconfig bridge0` sample shape, trimmed to the relevant lines.
const IFCONFIG_SAMPLE = `bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\toptions=3<RXCSUM,TXCSUM>
\tether 6e:0a:1b:2c:3d:4e
\tinet 192.168.2.1 netmask 0xffffff00 broadcast 192.168.2.255
\tConfiguration:
\t\tid 6e:0a:1b:2c:3d:4e priority 0 hellotime 0 fwddelay 0
\tmember: en5 flags=3<LEARNING,DISCOVER>
\t        ifmaxaddr 0 port 8 priority 0 path cost 0
\tmember: en6 flags=3<LEARNING,DISCOVER>
\t        ifmaxaddr 0 port 9 priority 0 path cost 0
\tnd6 options=201<PERFORMNUD,DAD>
`;

test("parseBridgeMembers extracts every member interface from real ifconfig output", () => {
  assert.deepEqual(parseBridgeMembers(IFCONFIG_SAMPLE), ["en5", "en6"]);
});

test("parseBridgeMembers returns an empty list for a bridge with no members", () => {
  assert.deepEqual(parseBridgeMembers("bridge0: flags=8863<UP> mtu 1500\n\tether 6e:0a:1b:2c:3d:4e\n"), []);
});

test("parseBridgeMembers tolerates empty/undefined input", () => {
  assert.deepEqual(parseBridgeMembers(""), []);
  assert.deepEqual(parseBridgeMembers(undefined), []);
});

test("diffBridgeMembers assigns the single new member", () => {
  const result = diffBridgeMembers(["en5"], ["en5", "en6"]);
  assert.deepEqual(result, { state: "assigned", iface: "en6", newMembers: ["en6"] });
});

test("diffBridgeMembers is ambiguous when nothing new appeared", () => {
  const result = diffBridgeMembers(["en5"], ["en5"]);
  assert.equal(result.state, "ambiguous");
  assert.match(result.reason, /no new bridge member/);
});

test("diffBridgeMembers is ambiguous when multiple members appeared at once", () => {
  const result = diffBridgeMembers([], ["en5", "en6"]);
  assert.equal(result.state, "ambiguous");
  assert.match(result.reason, /multiple new bridge members/);
  assert.deepEqual(result.newMembers, ["en5", "en6"]);
});

test("diffBridgeMembers never re-flags an already-known member as a new assignment", () => {
  const result = diffBridgeMembers(["en5", "en6"], ["en5", "en6"]);
  assert.equal(result.state, "ambiguous");
});

test("listBridgeMembers shells out to `ifconfig <bridge>` and parses the result", async () => {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args });
    callback(null, IFCONFIG_SAMPLE, "");
  };
  const members = await listBridgeMembers({ bridgeIface: "bridge0", execFile });
  assert.deepEqual(members, ["en5", "en6"]);
  assert.equal(calls[0].bin, "ifconfig");
  assert.deepEqual(calls[0].args, ["bridge0"]);
});

test("listBridgeMembers requires a bridgeIface and surfaces a clear error on failure", async () => {
  await assert.rejects(() => listBridgeMembers({ execFile: () => {} }), /bridgeIface is required/);
  const execFile = (bin, args, options, callback) => callback(new Error("no such interface"), "", "ifconfig: bridge0: no such interface");
  await assert.rejects(() => listBridgeMembers({ bridgeIface: "bridge0", execFile }), /no such interface/);
});

test("parseInterfaceIp extracts the plain (non-point-to-point) inet address", () => {
  assert.equal(parseInterfaceIp(IFCONFIG_SAMPLE), "192.168.2.1");
});

test("parseInterfaceIp returns null when the interface has no address yet", () => {
  assert.equal(parseInterfaceIp("bridge0: flags=8863<UP> mtu 1500\n\tether 6e:0a:1b:2c:3d:4e\n"), null);
  assert.equal(parseInterfaceIp(""), null);
});

test("parseInterfaceIp never matches a point-to-point tunnel's inet/peer line (that's tunManager.js's parseTunPeer)", () => {
  assert.equal(parseInterfaceIp("utun7: flags=8051<UP> mtu 1500\n\tinet 10.0.0.2 --> 10.0.0.1 netmask 0xffffffff\n"), null);
});

test("discoverBridgeOwnIp shells out to ifconfig <bridge> and parses the result", async () => {
  const calls = [];
  const execFile = (bin, args, options, callback) => { calls.push({ bin, args }); callback(null, IFCONFIG_SAMPLE, ""); };
  const ip = await discoverBridgeOwnIp({ bridgeIface: "bridge0", execFile });
  assert.equal(ip, "192.168.2.1");
  assert.deepEqual(calls[0], { bin: "ifconfig", args: ["bridge0"] });
});

test("discoverBridgeOwnIp requires a bridgeIface and throws clearly when no address is configured", async () => {
  await assert.rejects(() => discoverBridgeOwnIp({ execFile: () => {} }), /bridgeIface is required/);
  const execFile = (bin, args, options, callback) => callback(null, "bridge0: flags=8863<UP> mtu 1500\n", "");
  await assert.rejects(() => discoverBridgeOwnIp({ bridgeIface: "bridge0", execFile }), /no IPv4 address configured yet/);
});
