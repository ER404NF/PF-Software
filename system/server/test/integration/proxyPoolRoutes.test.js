// Integration coverage for the Phase B shared proxy pool (proxyPool.js) —
// HTTP route -> RBAC -> encrypted storage -> device_list, against the real
// running server and real auth/RBAC, mirroring networkCheckRoute.test.js's
// approach for the older Phase 0 network-isolation routes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_PASSWORD = "test-password";

const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-proxypool-"));
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.PROXY_POOL_STORE_PATH = path.join(tmpStorageRoot, "proxy-pool.json");
process.env.PROXY_PROVIDER_CONFIG_PATH = path.join(tmpStorageRoot, "proxy-providers.json");
process.env.DEVICE_CONFIG_PATH = path.resolve("server/fixtures/network-devices.config.json");
process.env.TWO_FACTOR_MASTER_KEY = "a".repeat(32);
process.env.NODE_ENV = "test";
fs.writeFileSync(process.env.PROXY_PROVIDER_CONFIG_PATH, JSON.stringify({ providers: [{
  kind: "deterministic", id: "fixture-provider", label: "Fixture provider",
  exits: [{
    id: "it-1", region: "IT", capacity: 2,
    health: { status: "healthy", checkedAt: "2026-09-28T12:00:00Z", publicIpv4: "198.51.100.10" },
  }, {
    id: "it-2", region: "IT", capacity: 2,
    health: { status: "healthy", checkedAt: "2026-09-28T12:00:00Z", publicIpv4: "198.51.100.11" },
  }],
}, {
  kind: "deterministic", id: "fixture-provider-b", label: "Fixture provider B",
  exits: [{
    id: "ro-1", region: "RO", capacity: 2,
    health: { status: "healthy", checkedAt: "2026-09-28T12:00:00Z", publicIpv4: "198.51.100.20" },
  }],
}] }));

const { server, wss, auditLog } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");

let httpUrl;

async function loginCookie(username, password) {
  const res = await fetch(`${httpUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  await res.json();
  return setCookie.split(";")[0];
}

async function fleetSnapshot(sessionCookie) {
  const ws = new (await import("ws")).WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: sessionCookie } });
  const message = await new Promise((resolve, reject) => {
    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type === "device_list") resolve(parsed);
    });
    ws.on("error", reject);
  });
  ws.close();
  return message.devices;
}

function samplePayload(overrides = {}) {
  return {
    provider: "Oxylabs", protocol: "socks5", host: "proxy.example.com", port: 7000,
    username: "pooluser", password: "s3cret-pass", country: "us", label: "US pool 1",
    ...overrides,
  };
}

let adminCookie;
let managerCookie;
let vaCookie;

before(async () => {
  operators.set("proxypool-test-admin", {
    username: "proxypool-test-admin", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "admin",
  });
  operators.set("proxypool-test-manager", {
    username: "proxypool-test-manager", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: ["mock-1"], role: "manager",
  });
  operators.set("proxypool-test-va", {
    username: "proxypool-test-va", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: ["mock-1", "mock-2"], role: "va",
  });

  await new Promise((resolve) => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await loginCookie("proxypool-test-admin", TEST_PASSWORD);
  managerCookie = await loginCookie("proxypool-test-manager", TEST_PASSWORD);
  vaCookie = await loginCookie("proxypool-test-va", TEST_PASSWORD);
});

after(async () => {
  operators.delete("proxypool-test-admin");
  operators.delete("proxypool-test-manager");
  operators.delete("proxypool-test-va");
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

test("every proxy-pool route requires authentication", async () => {
  const get = await fetch(`${httpUrl}/api/admin/proxies`);
  assert.equal(get.status, 401);
  const post = await fetch(`${httpUrl}/api/admin/proxies`, { method: "POST" });
  assert.equal(post.status, 401);
  const patch = await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, { method: "PATCH" });
  assert.equal(patch.status, 401);
  const testUnsaved = await fetch(`${httpUrl}/api/admin/proxies/test`, { method: "POST" });
  assert.equal(testUnsaved.status, 401);
  const testSaved = await fetch(`${httpUrl}/api/admin/proxies/missing/test`, { method: "POST" });
  assert.equal(testSaved.status, 401);
  const providers = await fetch(`${httpUrl}/api/admin/proxy-providers`);
  assert.equal(providers.status, 401);
});

test("provider inventory is role-gated, safe, and does not claim phone routing", async () => {
  const denied = await fetch(`${httpUrl}/api/admin/proxy-providers`, { headers: { Cookie: vaCookie } });
  assert.equal(denied.status, 403);

  const visible = await fetch(`${httpUrl}/api/admin/proxy-providers`, { headers: { Cookie: managerCookie } });
  assert.equal(visible.status, 200);
  const body = await visible.json();
  assert.deepEqual(body.providers.map(provider => provider.id), ["fixture-provider", "fixture-provider-b"]);
  assert.equal(body.providers[0].exits[0].region, "IT");
  assert.equal(body.providers[0].exits[0].availableCapacity, 2);
  assert.equal(JSON.stringify(body).includes("password"), false);
  assert.equal(JSON.stringify(body).includes("username"), false);

  const managerMutation = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/exits/it-1`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(managerMutation.status, 403);

  const changed = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/exits/it-1`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), {
    exit: {
      id: "it-1", region: "IT", enabled: false, capacity: 2, activeLeases: 0, availableCapacity: 0,
      health: {
        status: "healthy", checkedAt: "2026-09-28T12:00:00.000Z", region: "IT",
        publicIpv4: "198.51.100.10", latencyMs: null,
      },
    },
    routingApplied: false,
    routingVerified: false,
  });
  const restored = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/exits/it-1`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(restored.status, 200);
});

test("provider leases, rotation, and release are device-scoped, audited controls without routing claims", async () => {
  const denied = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-2/lease`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({ region: "IT" }),
  });
  assert.equal(denied.status, 403);

  const leased = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/lease`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({ region: "IT" }),
  });
  assert.equal(leased.status, 200);
  const leaseBody = await leased.json();
  assert.equal(leaseBody.exit.id, "it-1");
  assert.equal(leaseBody.routingApplied, false);
  assert.equal(leaseBody.routingVerified, false);

  const rotated = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/rotate`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({ region: "IT" }),
  });
  assert.equal(rotated.status, 200);
  assert.equal((await rotated.json()).exit.id, "it-2");

  const released = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/lease`, {
    method: "DELETE", headers: { Cookie: managerCookie },
  });
  assert.equal(released.status, 200);
  assert.deepEqual(await released.json(), { released: true, routingApplied: false, routingVerified: false });

  const rotateAgain = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/rotate`, {
    method: "POST", headers: { Cookie: managerCookie },
  });
  assert.equal(rotateAgain.status, 409);
});

test("concurrent leases cannot orphan the same device across two providers", async () => {
  const options = providerId => fetch(`${httpUrl}/api/admin/proxy-providers/${providerId}/devices/mock-1/lease`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({}),
  });
  const responses = await Promise.all([options("fixture-provider"), options("fixture-provider-b")]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);

  const inventory = await fetch(`${httpUrl}/api/admin/proxy-providers`, { headers: { Cookie: adminCookie } }).then(response => response.json());
  const activeLeases = inventory.providers.flatMap(provider => provider.exits)
    .reduce((sum, exit) => sum + exit.activeLeases, 0);
  assert.equal(activeLeases, 1);

  const winner = responses[0].status === 200 ? "fixture-provider" : "fixture-provider-b";
  await fetch(`${httpUrl}/api/admin/proxy-providers/${winner}/devices/mock-1/lease`, {
    method: "DELETE", headers: { Cookie: managerCookie },
  });
});

test("provider lease authority survives loss of the route's in-memory cache", async () => {
  const leased = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/lease`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: "{}",
  });
  assert.equal(leased.status, 200);

  const { proxyProviderLeaseByDevice } = await import("../../src/index.js");
  proxyProviderLeaseByDevice.clear();

  const conflict = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider-b/devices/mock-1/lease`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: "{}",
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "PROXY_PROVIDER_LEASE_CONFLICT");

  const rotated = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/rotate`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: "{}",
  });
  assert.equal(rotated.status, 200, "rotation must recover ownership from the provider after cache loss");

  proxyProviderLeaseByDevice.clear();
  const released = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/lease`, {
    method: "DELETE", headers: { Cookie: managerCookie },
  });
  assert.equal(released.status, 200, "release must recover ownership from the provider after cache loss");
});

test("exit enablement is refused if admin authority is revoked before provider commit", async () => {
  const provider = (await import("../../src/index.js")).proxyProviderRegistry.get("fixture-provider");
  const original = provider.setExitEnabled.bind(provider);
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const releasePromise = new Promise(resolve => { release = resolve; });
  provider.setExitEnabled = async options => {
    entered();
    await releasePromise;
    return original(options);
  };
  const previous = operators.get("proxypool-test-admin");
  try {
    const pending = fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/exits/it-1`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ enabled: false }),
    });
    await enteredPromise;
    operators.set("proxypool-test-admin", { ...previous, role: "va" });
    release();
    const response = await pending;
    assert.equal(response.status, 403);
    const exits = await provider.listExits();
    assert.equal(exits.find(exit => exit.id === "it-1").enabled, true);
  } finally {
    operators.set("proxypool-test-admin", previous);
    provider.setExitEnabled = original;
  }
});

test("a provider mutation authorized at commit is not reported as failed if access changes after commit", async () => {
  const provider = (await import("../../src/index.js")).proxyProviderRegistry.get("fixture-provider");
  const original = provider.setExitEnabled.bind(provider);
  let release;
  let committed;
  const committedPromise = new Promise(resolve => { committed = resolve; });
  const releasePromise = new Promise(resolve => { release = resolve; });
  provider.setExitEnabled = async options => {
    const result = await original(options);
    committed();
    await releasePromise;
    return result;
  };
  const previous = operators.get("proxypool-test-admin");
  try {
    const pending = fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/exits/it-1`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ enabled: false }),
    });
    await committedPromise;
    operators.set("proxypool-test-admin", { ...previous, role: "va" });
    release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).exit.enabled, false);
  } finally {
    operators.set("proxypool-test-admin", previous);
    provider.setExitEnabled = original;
    await provider.setExitEnabled({ exitId: "it-1", enabled: true });
  }
});

test("proxy-test routes enforce role access and return stable validation errors before any connection", async () => {
  const manager = await fetch(`${httpUrl}/api/admin/proxies/test`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: "{}",
  });
  assert.equal(manager.status, 403);
  const invalid = await fetch(`${httpUrl}/api/admin/proxies/test`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(samplePayload({ host: "bad host name" })),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "P101");
  const missing = await fetch(`${httpUrl}/api/admin/proxies/not-here/test`, {
    method: "POST", headers: { Cookie: adminCookie },
  });
  assert.equal(missing.status, 404);
});

test("only Admin/Manager may view the pool; only Admin may create or delete entries", async () => {
  const vaGet = await fetch(`${httpUrl}/api/admin/proxies`, { headers: { Cookie: vaCookie } });
  assert.equal(vaGet.status, 403);

  const managerGet = await fetch(`${httpUrl}/api/admin/proxies`, { headers: { Cookie: managerCookie } });
  assert.equal(managerGet.status, 200);

  const managerCreate = await fetch(`${httpUrl}/api/admin/proxies`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify(samplePayload()),
  });
  assert.equal(managerCreate.status, 403);
});

test("creating a proxy never returns host, port, username, or password", async () => {
  const res = await fetch(`${httpUrl}/api/admin/proxies`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(samplePayload()),
  });
  assert.equal(res.status, 201);
  const text = await res.text();
  assert.equal(text.includes("s3cret-pass"), false);
  const { proxy } = JSON.parse(text);
  assert.match(proxy.id, /^px_/);
  assert.equal(proxy.flag, "🇺🇸");
  assert.equal(proxy.leasedToDeviceId, null);
  for (const secretField of ["host", "port", "username", "password", "passwordEncrypted"]) {
    assert.equal(secretField in proxy, false, `${secretField} must never be returned`);
  }
});

test("invalid fields are rejected with 400 and nothing is persisted", async () => {
  const before = await (await fetch(`${httpUrl}/api/admin/proxies`, { headers: { Cookie: adminCookie } })).json();
  const res = await fetch(`${httpUrl}/api/admin/proxies`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(samplePayload({ country: "USA" })),
  });
  assert.equal(res.status, 400);
  const after = await (await fetch(`${httpUrl}/api/admin/proxies`, { headers: { Cookie: adminCookie } })).json();
  assert.equal(after.proxies.length, before.proxies.length);
});

test("Admin and Manager can both assign a pool proxy to a device they're authorized for", async () => {
  const created = await fetch(`${httpUrl}/api/admin/proxies`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(samplePayload({ label: "Assignable" })),
  }).then((r) => r.json());
  const proxyId = created.proxy.id;

  const assigned = await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({ proxyId }),
  });
  assert.equal(assigned.status, 200);
  assert.equal((await assigned.json()).proxy.id, proxyId);

  const list = await fetch(`${httpUrl}/api/admin/proxies`, { headers: { Cookie: adminCookie } }).then((r) => r.json());
  assert.equal(list.proxies.find((p) => p.id === proxyId).leasedToDeviceId, "mock-1");

  // release
  const released = await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ proxyId: null }),
  });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).proxy, null);
});

test("a proxy already leased to one device cannot be assigned to another", async () => {
  const created = await fetch(`${httpUrl}/api/admin/proxies`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(samplePayload({ label: "Exclusive" })),
  }).then((r) => r.json());
  const proxyId = created.proxy.id;

  const first = await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ proxyId }),
  });
  assert.equal(first.status, 200);

  const second = await fetch(`${httpUrl}/api/admin/devices/mock-2/proxy-assignment`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ proxyId }),
  });
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /already assigned to another device/);

  await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ proxyId: null }),
  });
});

test("device RBAC applies to the assignment route like every other device route", async () => {
  const created = await fetch(`${httpUrl}/api/admin/proxies`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(samplePayload({ label: "RBAC test" })),
  }).then((r) => r.json());

  // manager's grant is ["mock-1"] only — mock-2 must be refused
  const denied = await fetch(`${httpUrl}/api/admin/devices/mock-2/proxy-assignment`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({ proxyId: created.proxy.id }),
  });
  assert.equal(denied.status, 403);
});

test("device_list only exposes poolProxy to a viewer with the view capability", async () => {
  const created = await fetch(`${httpUrl}/api/admin/proxies`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(samplePayload({ label: "Visible in fleet" })),
  }).then((r) => r.json());
  await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ proxyId: created.proxy.id }),
  });

  const asAdmin = (await fleetSnapshot(adminCookie)).find((d) => d.id === "mock-1");
  assert.equal(asAdmin.poolProxy.id, created.proxy.id);

  const asVa = (await fleetSnapshot(vaCookie)).find((d) => d.id === "mock-1");
  assert.equal(asVa.poolProxy, null); // VA lacks proxy:view-pool — never leaks the assignment

  await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ proxyId: null }),
  });
});

test("deleting a leased proxy is refused until it is released, then succeeds", async () => {
  const created = await fetch(`${httpUrl}/api/admin/proxies`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(samplePayload({ label: "Delete test" })),
  }).then((r) => r.json());
  const proxyId = created.proxy.id;
  await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ proxyId }),
  });

  const blocked = await fetch(`${httpUrl}/api/admin/proxies/${proxyId}`, { method: "DELETE", headers: { Cookie: adminCookie } });
  assert.equal(blocked.status, 409);

  await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ proxyId: null }),
  });
  const deleted = await fetch(`${httpUrl}/api/admin/proxies/${proxyId}`, { method: "DELETE", headers: { Cookie: adminCookie } });
  assert.equal(deleted.status, 200);

  const managerDelete = await fetch(`${httpUrl}/api/admin/proxies/${proxyId}`, { method: "DELETE", headers: { Cookie: managerCookie } });
  assert.equal(managerDelete.status, 403);
});

test("pool mutations are audited by an admin-visible event, never containing the plaintext password", async () => {
  const created = await fetch(`${httpUrl}/api/admin/proxies`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(samplePayload({ label: "Audited" })),
  }).then((r) => r.json());

  const audit = await fetch(`${httpUrl}/api/audit?limit=20`, { headers: { Cookie: adminCookie } }).then((r) => r.json());
  const createdEvent = audit.events.find((e) => e.type === "proxy_pool_created" && e.detail?.proxyId === created.proxy.id);
  assert.ok(createdEvent, "expected a proxy_pool_created audit event");
  assert.equal(JSON.stringify(audit).includes("s3cret-pass"), false);
});

test("committed pool and provider lease mutations remain successful when audit storage fails", async () => {
  const originalAuditWrite = auditLog.logEvent;
  let proxyId = null;
  let providerLeaseActive = false;
  try {
    auditLog.logEvent = () => { throw new Error("injected proxy audit failure"); };
    const createdResponse = await fetch(`${httpUrl}/api/admin/proxies`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify(samplePayload({ label: "Audit outage cleanup" })),
    });
    assert.equal(createdResponse.status, 201, "a committed proxy record must not be reported as failed");
    proxyId = (await createdResponse.json()).proxy.id;

    const assigned = await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ proxyId }),
    });
    assert.equal(assigned.status, 200, "a committed pool lease must not be reported as failed");
    const released = await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ proxyId: null }),
    });
    assert.equal(released.status, 200);
    const deleted = await fetch(`${httpUrl}/api/admin/proxies/${proxyId}`, {
      method: "DELETE", headers: { Cookie: adminCookie },
    });
    assert.equal(deleted.status, 200, "a committed pool deletion must not be reported as failed");
    proxyId = null;

    const leased = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/lease`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ region: "IT" }),
    });
    assert.equal(leased.status, 200, "a committed provider lease must not be reported as failed");
    providerLeaseActive = true;
    const rotated = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/rotate`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ region: "IT" }),
    });
    assert.equal(rotated.status, 200, "a committed provider rotation must not be reported as failed");
    const providerReleased = await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/lease`, {
      method: "DELETE", headers: { Cookie: adminCookie },
    });
    assert.equal(providerReleased.status, 200, "a committed provider release must not be reported as failed");
    providerLeaseActive = false;
  } finally {
    auditLog.logEvent = originalAuditWrite;
    if (providerLeaseActive) {
      await fetch(`${httpUrl}/api/admin/proxy-providers/fixture-provider/devices/mock-1/lease`, {
        method: "DELETE", headers: { Cookie: adminCookie },
      });
    }
    if (proxyId) {
      await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy-assignment`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ proxyId: null }),
      });
      await fetch(`${httpUrl}/api/admin/proxies/${proxyId}`, { method: "DELETE", headers: { Cookie: adminCookie } });
    }
  }
});
