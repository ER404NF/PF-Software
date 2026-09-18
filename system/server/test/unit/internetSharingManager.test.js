import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEnableCommands, buildDisableCommands, parseDefaultRouteInterface, detectPrimaryInterface,
  enableInternetSharing, disableInternetSharing,
} from "../../src/internetSharingManager.js";

test("buildEnableCommands produces a Delete-then-Add sequence, idempotent regardless of prior plist state", () => {
  const commands = buildEnableCommands({ primaryInterface: "en0" });
  assert.deepEqual(commands, [
    "Delete :NAT",
    "Add :NAT dict",
    "Add :NAT:Enabled integer 1",
    "Add :NAT:PrimaryInterface dict",
    "Add :NAT:PrimaryInterface:Device string en0",
    "Add :NAT:PrimaryInterface:Enabled integer 1",
    "Add :NAT:SharingDevices array",
    "Add :NAT:SharingDevices:0 string USB",
  ]);
});

test("buildEnableCommands honors a custom sharingDevice", () => {
  const commands = buildEnableCommands({ primaryInterface: "en0", sharingDevice: "Ethernet" });
  assert.ok(commands.includes("Add :NAT:SharingDevices:0 string Ethernet"));
});

test("buildEnableCommands rejects an invalid interface name — the same rule-injection boundary as pfRuleGenerator.js", () => {
  assert.throws(() => buildEnableCommands({ primaryInterface: "en0; rm -rf /" }), /valid interface name/);
  assert.throws(() => buildEnableCommands({ primaryInterface: "" }), /valid interface name/);
});

test("buildEnableCommands rejects an empty or oversized sharingDevice", () => {
  assert.throws(() => buildEnableCommands({ primaryInterface: "en0", sharingDevice: "" }), /sharingDevice/);
  assert.throws(() => buildEnableCommands({ primaryInterface: "en0", sharingDevice: "x".repeat(41) }), /sharingDevice/);
});

test("buildDisableCommands just flips Enabled to 0", () => {
  assert.deepEqual(buildDisableCommands(), ["Delete :NAT", "Add :NAT dict", "Add :NAT:Enabled integer 0"]);
});

test("parseDefaultRouteInterface extracts the interface from real `route get default` output", () => {
  const sample = [
    "   route to: default",
    "destination: default",
    "    gateway: 192.168.1.1",
    "  interface: en0",
    "      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>",
  ].join("\n");
  assert.equal(parseDefaultRouteInterface(sample), "en0");
});

test("parseDefaultRouteInterface returns null when there is no default route", () => {
  assert.equal(parseDefaultRouteInterface("route to host: default\nHost is not reachable\n"), null);
  assert.equal(parseDefaultRouteInterface(""), null);
});

test("detectPrimaryInterface shells out to `route -n get default` and parses the result", async () => {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args });
    callback(null, "  interface: en0\n", "");
  };
  const iface = await detectPrimaryInterface({ execFile });
  assert.equal(iface, "en0");
  assert.deepEqual(calls[0], { bin: "route", args: ["-n", "get", "default"] });
});

test("detectPrimaryInterface throws a clear error when no interface can be parsed", async () => {
  const execFile = (bin, args, options, callback) => callback(null, "not reachable\n", "");
  await assert.rejects(() => detectPrimaryInterface({ execFile }), /could not determine the default-route interface/);
});

test("enableInternetSharing runs PlistBuddy through sudo -n, then kickstarts the service", async () => {
  const calls = [];
  const execFile = (bin, args, options, callback) => { calls.push({ bin, args }); callback(null, "", ""); };
  await enableInternetSharing({ primaryInterface: "en0", execFile });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].bin, "sudo");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-n", "/usr/libexec/PlistBuddy"]);
  assert.ok(calls[0].args.includes("-c"));
  assert.ok(calls[0].args.includes("Add :NAT:PrimaryInterface:Device string en0"));
  assert.equal(calls[0].args[calls[0].args.length - 1], "/Library/Preferences/SystemConfiguration/com.apple.nat.plist");
  assert.deepEqual(calls[1].args, ["-n", "launchctl", "kickstart", "-k", "system/com.apple.InternetSharing"]);
});

test("enableInternetSharing surfaces a PlistBuddy failure without attempting the kickstart", async () => {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push(args);
    if (args.includes("/usr/libexec/PlistBuddy")) callback(new Error("boom"), "", "permission denied");
    else callback(null, "", "");
  };
  await assert.rejects(() => enableInternetSharing({ primaryInterface: "en0", execFile }), /permission denied/);
  assert.equal(calls.length, 1, "must not kickstart the service after a failed plist write");
});

test("disableInternetSharing also runs through sudo -n and kickstarts afterward", async () => {
  const calls = [];
  const execFile = (bin, args, options, callback) => { calls.push(args); callback(null, "", ""); };
  await disableInternetSharing({ execFile });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("Add :NAT:Enabled integer 0"));
});
