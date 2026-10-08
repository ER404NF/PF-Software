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
  assert.match(result.reason, /did not see a new network connection appear/);
});

test("diffBridgeMembers is ambiguous when multiple members appeared at once", () => {
  const result = diffBridgeMembers([], ["en5", "en6"]);
  assert.equal(result.state, "ambiguous");
  assert.match(result.reason, /More than one new network connection appeared \(en5, en6\)/);
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
  const execFile = (bin, args, options, callback) => callback(new Error("permission denied"), "", "ifconfig: permission denied");
  await assert.rejects(() => listBridgeMembers({ bridgeIface: "bridge0", execFile }), error => error.code === "IFCONFIG_FAILED" && /permission denied/.test(error.message));
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


// ---- C4: how Confirm behaves against macOS-shaped output (real macOS 26 output is checked on the Mac) ----

// Internet Sharing's own bridge, as `ifconfig bridge100` prints it once a phone is shared: members carry
// extra attribute lines, and a Wi-Fi sharing member can appear next to the USB ones.
const BRIDGE100_ONE_PHONE = `bridge100: flags=8963<UP,BROADCAST,SMART,RUNNING,PROMISC,SIMPLEX,MULTICAST> mtu 1500
\toptions=3<RXCSUM,TXCSUM>
\tether be:d0:74:12:34:64
\tinet 192.168.2.1 netmask 0xffffff00 broadcast 192.168.2.255
\tinet6 fe80::bcd0:74ff:fe12:3464%bridge100 prefixlen 64 scopeid 0x13
\tConfiguration:
\t\tid 0:0:0:0:0:0 priority 0 hellotime 0 fwddelay 0
\t\tmaxage 0 holdcnt 0 proto stp maxaddr 100 timeout 1200
\t\troot id 0:0:0:0:0:0 priority 0 ifcost 0 port 0
\t\tipfilter disabled flags 0x0
\tmember: en7 flags=3<LEARNING,DISCOVER>
\t        ifmaxaddr 0 port 12 priority 0 path cost 0
\tnd6 options=201<PERFORMNUD,DAD>
\tmedia: autoselect
\tstatus: active
`;
const BRIDGE100_TWO_PHONES = BRIDGE100_ONE_PHONE.replace("\tnd6 options", "\tmember: en8 flags=3<LEARNING,DISCOVER>\n\t        ifmaxaddr 0 port 14 priority 0 path cost 0\n\tnd6 options");
const BRIDGE100_WITH_WIFI = BRIDGE100_ONE_PHONE.replace("\tnd6 options", "\tmember: ap1 flags=3<LEARNING,DISCOVER>\n\t        ifmaxaddr 0 port 15 priority 0 path cost 0\n\tnd6 options");

test("macOS-shaped bridge100 output: members are found past the attribute lines, and the bridge's own address is not a member", () => {
  assert.deepEqual(parseBridgeMembers(BRIDGE100_ONE_PHONE), ["en7"]);
  assert.deepEqual(parseBridgeMembers(BRIDGE100_TWO_PHONES), ["en7", "en8"]);
  assert.deepEqual(parseBridgeMembers(BRIDGE100_WITH_WIFI), ["en7", "ap1"]);
  assert.equal(parseInterfaceIp(BRIDGE100_ONE_PHONE), "192.168.2.1");
});

test("enrollment diff: one new phone, no change, several changes", () => {
  assert.deepEqual(diffBridgeMembers(parseBridgeMembers(BRIDGE100_ONE_PHONE), parseBridgeMembers(BRIDGE100_TWO_PHONES)),
    { state: "assigned", iface: "en8", newMembers: ["en8"] });
  const none = diffBridgeMembers(parseBridgeMembers(BRIDGE100_ONE_PHONE), parseBridgeMembers(BRIDGE100_ONE_PHONE));
  assert.equal(none.state, "ambiguous");
  assert.equal(none.newMembers.length, 0);
  const several = diffBridgeMembers([], parseBridgeMembers(BRIDGE100_TWO_PHONES));
  assert.deepEqual(several.newMembers, ["en7", "en8"]);
});

test("before the first phone is shared the bridge does not exist: that is an empty 'before' list, not a failure", async () => {
  const execFile = (bin, args, options, callback) => callback(
    Object.assign(new Error("Command failed: ifconfig bridge100"), { code: 1 }), "", "ifconfig: interface bridge100 does not exist");
  assert.deepEqual(await listBridgeMembers({ bridgeIface: "bridge100", execFile }), []);
});

test("the whole Start → share one phone → Confirm flow works even though the bridge only appears at sharing time", async () => {
  let sharing = false;
  const execFile = (bin, args, options, callback) => (sharing
    ? callback(null, BRIDGE100_ONE_PHONE, "")
    : callback(Object.assign(new Error("failed"), { code: 1 }), "", "ifconfig: interface bridge100 does not exist"));
  const before = await listBridgeMembers({ bridgeIface: "bridge100", execFile });
  sharing = true;
  const after = await listBridgeMembers({ bridgeIface: "bridge100", execFile });
  assert.deepEqual(diffBridgeMembers(before, after), { state: "assigned", iface: "en7", newMembers: ["en7"] });
});

test("if sharing was never turned on, Confirm sees no change and says what to do in plain words", async () => {
  const execFile = (bin, args, options, callback) => callback(Object.assign(new Error("failed"), { code: 1 }), "", "ifconfig: interface bridge100 does not exist");
  const result = diffBridgeMembers(await listBridgeMembers({ bridgeIface: "bridge100", execFile }), await listBridgeMembers({ bridgeIface: "bridge100", execFile }));
  assert.equal(result.state, "ambiguous");
  assert.match(result.reason, /Turn on Internet Sharing/);
});

test("other ifconfig failures (permission, timeout) are still errors, flagged so the route can explain them", async () => {
  for (const stderr of ["ifconfig: permission denied", "ifconfig: operation not permitted"]) {
    const execFile = (bin, args, options, callback) => callback(Object.assign(new Error("failed"), { code: 1 }), "", stderr);
    await assert.rejects(() => listBridgeMembers({ bridgeIface: "bridge100", execFile }), error => error.code === "IFCONFIG_FAILED" && error.missingInterface === false);
  }
});

test("the plain reasons contain no developer wording", async () => {
  const { assertPlainOperatorText } = await import("../helpers/plainText.js");
  assertPlainOperatorText(diffBridgeMembers(["en5"], ["en5"]).reason, "no change");
  assertPlainOperatorText(diffBridgeMembers([], ["en5", "en6"]).reason, "several changes");
});
