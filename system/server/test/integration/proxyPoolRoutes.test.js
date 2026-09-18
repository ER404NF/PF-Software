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
process.env.TWO_FACTOR_MASTER_KEY = "a".repeat(32);
process.env.NODE_ENV = "test";

const { server, wss } = await import("../../src/index.js");
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
