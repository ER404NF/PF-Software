import { test } from "node:test";
import assert from "node:assert/strict";
import { allocatePort, resolvePortRange } from "../../src/portAllocator.js";

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

test("resolvePortRange falls back to the default when env vars are missing or invalid", () => {
  assert.deepEqual(resolvePortRange({}), { start: 8100, end: 8199 });
  assert.deepEqual(resolvePortRange({ WDA_PORT_RANGE_START: "9000", WDA_PORT_RANGE_END: "8000" }), { start: 8100, end: 8199 });
});

test("resolvePortRange honors a valid configured range", () => {
  assert.deepEqual(resolvePortRange({ WDA_PORT_RANGE_START: "9000", WDA_PORT_RANGE_END: "9050" }), { start: 9000, end: 9050 });
});
