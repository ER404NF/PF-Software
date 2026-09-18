import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTcpdumpAddresses, discoverDeviceIp, captureDeviceTraffic } from "../../src/usbIpDiscovery.js";

// Real `tcpdump -ni en5 -nn ip` line shapes.
const CAPTURE_SAMPLE = [
  "12:34:56.789012 IP 192.168.2.10.54321 > 192.168.2.1.443: Flags [S], seq 123, win 65535, length 0",
  "12:34:56.789200 IP 192.168.2.1.443 > 192.168.2.10.54321: Flags [S.], seq 456, ack 124, win 65535, length 0",
  "12:34:56.790000 IP 192.168.2.10.54321 > 192.168.2.1.443: Flags [.], ack 457, win 2058, length 0",
].join("\n");

test("parseTcpdumpAddresses extracts the address only, never the trailing port", () => {
  const addresses = parseTcpdumpAddresses(CAPTURE_SAMPLE);
  assert.deepEqual([...addresses].sort(), ["192.168.2.1", "192.168.2.10"]);
  assert.ok(!addresses.some(ip => ip.includes(":") || ip.split(".").length > 4));
});

test("parseTcpdumpAddresses ignores non-IP lines and tolerates empty input", () => {
  assert.deepEqual(parseTcpdumpAddresses("reading from file -, link-type EN10MB\n\n"), []);
  assert.deepEqual(parseTcpdumpAddresses(""), []);
  assert.deepEqual(parseTcpdumpAddresses(undefined), []);
});

test("discoverDeviceIp resolves the phone's address once the Mac's own address is excluded", () => {
  const result = discoverDeviceIp(CAPTURE_SAMPLE, { excludeIps: ["192.168.2.1"] });
  assert.deepEqual(result, { state: "resolved", ip: "192.168.2.10" });
});

test("discoverDeviceIp reports no_traffic when nothing survives the exclusion list", () => {
  const result = discoverDeviceIp(CAPTURE_SAMPLE, { excludeIps: ["192.168.2.1", "192.168.2.10"] });
  assert.equal(result.state, "no_traffic");
  assert.equal(result.ip, null);
});

test("discoverDeviceIp is ambiguous — never guesses — when more than one candidate remains", () => {
  const result = discoverDeviceIp(CAPTURE_SAMPLE, { excludeIps: [] });
  assert.equal(result.state, "ambiguous");
  assert.deepEqual([...result.candidates].sort(), ["192.168.2.1", "192.168.2.10"]);
});

test("discoverDeviceIp with no traffic at all reports no_traffic, not a false resolution", () => {
  const result = discoverDeviceIp("reading from file -, link-type EN10MB\n");
  assert.equal(result.state, "no_traffic");
});

test("captureDeviceTraffic runs tcpdump through sudo -n (packet capture requires root)", async () => {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args });
    callback(null, CAPTURE_SAMPLE, "");
  };
  const output = await captureDeviceTraffic({ iface: "en5", packetCount: 10, execFile });
  assert.equal(output, CAPTURE_SAMPLE);
  assert.equal(calls[0].bin, "sudo");
  assert.deepEqual(calls[0].args, ["-n", "tcpdump", "-ni", "en5", "-c", "10", "-nn", "ip"]);
});

test("captureDeviceTraffic requires an iface", async () => {
  await assert.rejects(() => captureDeviceTraffic({ execFile: () => {} }), /iface is required/);
});

test("captureDeviceTraffic treats a nonzero exit WITH output as a legitimate empty/short capture, not a failure", async () => {
  const execFile = (bin, args, options, callback) => callback(new Error("timeout"), "", "");
  await assert.rejects(() => captureDeviceTraffic({ iface: "en5", execFile }), /tcpdump on en5 failed/);

  const execFileWithOutput = (bin, args, options, callback) => callback(new Error("exit 1"), CAPTURE_SAMPLE, "");
  const output = await captureDeviceTraffic({ iface: "en5", execFile: execFileWithOutput });
  assert.equal(output, CAPTURE_SAMPLE);
});
