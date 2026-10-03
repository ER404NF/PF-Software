import test from "node:test";
import assert from "node:assert/strict";
import { SiteLinkHub } from "../../src/siteLink.js";

test("site authorization checks are coalesced across concurrent frames", async (t) => {
  let resolveLookup;
  let lookups = 0;
  const repository = {
    get() {
      lookups += 1;
      return new Promise(resolve => { resolveLookup = resolve; });
    },
  };
  const hub = new SiteLinkHub({
    siteStore: repository,
    devices: new Map(),
    authorizationRecheckMs: 1_000,
  });
  t.after(() => hub.closeAll());

  const connection = {
    site: { id: "rome" },
    ws: { close() {} },
    authorizationCheckedAt: 0,
    authorizationCheck: null,
  };
  hub.connections.set("rome", connection);

  const first = hub._onMessage(connection, Buffer.from("{}"), false);
  const second = hub._onMessage(connection, Buffer.from("{}"), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookups, 1, "concurrent frames must share one database authorization query");
  resolveLookup({ id: "rome" });
  await Promise.all([first, second]);

  await hub._onMessage(connection, Buffer.from("{}"), false);
  assert.equal(lookups, 1, "frames inside the authorization TTL must not query PostgreSQL again");
});

test("a failed asynchronous site authorization check fails closed", async (t) => {
  const hub = new SiteLinkHub({
    siteStore: { get: async () => { throw new Error("database unavailable"); } },
    devices: new Map(),
    authorizationRecheckMs: 0,
  });
  t.after(() => hub.closeAll());
  const connection = {
    site: { id: "rome" },
    ws: { close() {} },
    authorizationCheckedAt: 0,
    authorizationCheck: null,
  };
  hub.connections.set("rome", connection);

  await assert.rejects(
    hub._onMessage(connection, Buffer.from("{}"), false),
    /database unavailable/,
  );
});

for (const operation of ["removeSite", "disconnect"]) {
  test(`${operation} rejects an upgrade authorized against stale site state`, async (t) => {
    let resolveVerification;
    const hub = new SiteLinkHub({
      siteStore: {
        verifyToken: () => new Promise(resolve => { resolveVerification = resolve; }),
      },
      devices: new Map(),
    });
    t.after(() => hub.closeAll());

    let accepted = false;
    hub.wss.handleUpgrade = () => { accepted = true; };
    const writes = [];
    let destroyed = false;
    const socket = {
      write(value) { writes.push(value); },
      destroy() { destroyed = true; },
    };
    const upgrade = hub.handleUpgrade({
      headers: { "x-site-id": "rome", authorization: "Bearer old-token" },
    }, socket, Buffer.alloc(0));

    await new Promise(resolve => setImmediate(resolve));
    hub[operation]("rome");
    resolveVerification({ id: "rome", name: "Rome" });

    assert.equal(await upgrade, false);
    assert.equal(accepted, false, "stale authorization must never reach WebSocket acceptance");
    assert.equal(destroyed, true);
    assert.match(writes.join(""), /401 Unauthorized/);
  });
}

test("site deletion prevents a buffered device message from repopulating the fleet", async (t) => {
  let resolveLookup;
  const devices = new Map();
  const hub = new SiteLinkHub({
    siteStore: {
      get: () => new Promise(resolve => { resolveLookup = resolve; }),
      markSeen() {},
    },
    devices,
    authorizationRecheckMs: 0,
  });
  t.after(() => hub.closeAll());
  const connection = {
    site: { id: "rome", name: "Rome" },
    ws: { close() {}, readyState: 1 },
    authorizationGeneration: 0,
    authorizationCheckedAt: 0,
    authorizationCheck: null,
  };
  hub.connections.set("rome", connection);

  const bufferedMessage = hub._onMessage(connection, Buffer.from(JSON.stringify({
    type: "devices",
    devices: [{ id: "phone-1", label: "Phone 1", type: "mock", ready: true }],
  })), false);
  await new Promise(resolve => setImmediate(resolve));
  hub.removeSite("rome");
  resolveLookup({ id: "rome" });
  await bufferedMessage;

  assert.equal(devices.size, 0);
});

