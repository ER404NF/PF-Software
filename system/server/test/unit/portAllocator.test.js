import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { allocateAvailablePort, allocatePort, isLocalPortAvailable, reserveAvailablePortPair, resolvePortRange } from "../../src/portAllocator.js";

test("allocatePort reuses a preferred port still inside range and unclaimed", () => {
  const port = allocatePort({ range: { start: 8100, end: 8110 }, used: new Set([8100, 8101]), preferred: 8105 });
  assert.equal(port, 8105);
});

test("allocatePort ignores a preferred port already claimed this run", () => {
  const port = allocatePort({ range: { start: 8100, end: 8102 }, used: new Set([8100, 8101]), preferred: 8101 });
  assert.equal(port, 8102);
});

test("allocatePort ignores a preferred port outside the configured range", () => {
  const port = allocatePort({ range: { start: 8100, end: 8102 }, used: new Set(), preferred: 9000 });
  assert.equal(port, 8100);
});

test("allocatePort picks the first free port when there is no preference", () => {
  const port = allocatePort({ range: { start: 8100, end: 8105 }, used: new Set([8100, 8102]) });
  assert.equal(port, 8101);
});

test("allocatePort throws once the range is exhausted", () => {
  assert.throws(
    () => allocatePort({ range: { start: 8100, end: 8101 }, used: new Set([8100, 8101]) }),
    /no free WDA local port/
  );
});

test("allocatePort rejects an invalid range", () => {
  assert.throws(() => allocatePort({ range: { start: 8110, end: 8100 } }), /invalid port range/);
});

test("allocateAvailablePort skips a real operating-system listener", async () => {
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const occupied = blocker.address().port;
  try {
    assert.equal(await isLocalPortAvailable(occupied), false);
    const selected = await allocateAvailablePort({ range: { start: occupied, end: occupied + 2 }, preferred: occupied });
    assert.notEqual(selected, occupied);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
});

test("allocateAvailablePort fails deterministically instead of retrying an occupied range", async () => {
  await assert.rejects(
    allocateAvailablePort({ range: { start: 8100, end: 8101 }, isAvailable: async () => false }),
    /no available local port/,
  );
});

test("isLocalPortAvailable detects an IPv6 loopback listener", async (t) => {
  const blocker = net.createServer();
  try {
    await new Promise((resolve, reject) => blocker.once("error", reject).listen(0, "::1", resolve));
  } catch (error) {
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) return t.skip("IPv6 loopback unavailable on this host");
    throw error;
  }
  try {
    assert.equal(await isLocalPortAvailable(blocker.address().port), false);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
});

test("isLocalPortAvailable detects an IPv4 wildcard listener", async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => blocker.once("error", reject).listen(0, "0.0.0.0", resolve));
  try {
    assert.equal(await isLocalPortAvailable(blocker.address().port), false);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
});

test("isLocalPortAvailable detects an IPv6 wildcard listener", async (t) => {
  const blocker = net.createServer();
  try {
    await new Promise((resolve, reject) => blocker.once("error", reject).listen(0, "::", resolve));
  } catch (error) {
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) return t.skip("IPv6 wildcard unavailable on this host");
    throw error;
  }
  try {
    assert.equal(await isLocalPortAvailable(blocker.address().port), false);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
});

test("isLocalPortAvailable tolerates hosts without IPv6 support", async () => {
  const available = await isLocalPortAvailable(8080, ["0.0.0.0", "::", "127.0.0.1", "::1"], async (_port, host) => {
    if (host.includes(":")) throw Object.assign(new Error("IPv6 unavailable"), { code: "EAFNOSUPPORT" });
    return true;
  });
  assert.equal(available, true);
});

test("concurrent pair reservations cannot select the same control or video ports", async () => {
  const options = {
    controlRange: { start: 18100, end: 18102 },
    mjpegRange: { start: 19100, end: 19102 },
    isAvailable: async () => true,
  };
  const [first, second] = await Promise.all([
    reserveAvailablePortPair(options), reserveAvailablePortPair(options),
  ]);
  try {
    assert.notEqual(first.controlPort, second.controlPort);
    assert.notEqual(first.mjpegPort, second.mjpegPort);
  } finally {
    first.release();
    second.release();
  }
});

test("resolvePortRange falls back to the default when env vars are missing or invalid", () => {
  assert.deepEqual(resolvePortRange({}), { start: 8100, end: 8199 });
  assert.deepEqual(resolvePortRange({ WDA_PORT_RANGE_START: "9000", WDA_PORT_RANGE_END: "8000" }), { start: 8100, end: 8199 });
});

test("resolvePortRange honors a valid configured range", () => {
  assert.deepEqual(resolvePortRange({ WDA_PORT_RANGE_START: "9000", WDA_PORT_RANGE_END: "9050" }), { start: 9000, end: 9050 });
});

test("resolveMjpegPortRange defaults to 9100-9199 and honours a valid override", async () => {
  const { resolveMjpegPortRange } = await import("../../src/portAllocator.js");
  assert.deepEqual(resolveMjpegPortRange({}), { start: 9100, end: 9199 });
  assert.deepEqual(resolveMjpegPortRange({ WDA_MJPEG_PORT_RANGE_START: "9300", WDA_MJPEG_PORT_RANGE_END: "9310" }), { start: 9300, end: 9310 });
  assert.deepEqual(resolveMjpegPortRange({ WDA_MJPEG_PORT_RANGE_START: "9310", WDA_MJPEG_PORT_RANGE_END: "9300" }), { start: 9100, end: 9199 }, "inverted range falls back");
  assert.deepEqual(resolveMjpegPortRange({ WDA_MJPEG_PORT_RANGE_START: "x" }), { start: 9100, end: 9199 });
});
