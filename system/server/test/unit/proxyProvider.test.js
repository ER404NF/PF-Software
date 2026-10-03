import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DeterministicProxyProvider, ProxyProvider, assertProxyProviderContract, normalizeProxyHealth,
} from "../../src/proxyProvider.js";

test("base proxy provider declares honest unsupported behavior", async () => {
  const provider = assertProxyProviderContract(new ProxyProvider({ id: "future-provider", label: "Future provider" }));
  await assert.rejects(provider.listExits(), /inventory is not implemented/);
  await assert.rejects(provider.getHealth(), /not implemented/);
  await assert.rejects(provider.rotateExit(), /not supported/);
  await assert.rejects(provider.leaseExit(), /leasing is not implemented/);
});

function localProvider() {
  const checkedAt = "2026-09-28T12:00:00.000Z";
  return new DeterministicProxyProvider({ exits: [
    { id: "de-1", region: "DE", capacity: 1, health: { status: "healthy", checkedAt } },
    { id: "it-1", region: "IT", capacity: 2, health: { status: "healthy", checkedAt } },
    { id: "it-2", region: "IT", capacity: 1, health: { status: "healthy", checkedAt } },
    { id: "it-offline", region: "IT", capacity: 10, health: { status: "offline", checkedAt } },
  ] });
}

test("deterministic provider exposes safe, region-sorted inventory and capacity", async () => {
  const provider = assertProxyProviderContract(localProvider());
  const exits = await provider.listExits();
  assert.deepEqual(exits.map(exit => exit.id), ["de-1", "it-1", "it-2", "it-offline"]);
  assert.deepEqual(exits[1], {
    id: "it-1", region: "IT", enabled: true, capacity: 2, activeLeases: 0, availableCapacity: 2,
    health: { status: "healthy", checkedAt: "2026-09-28T12:00:00.000Z", region: "IT", publicIpv4: null, latencyMs: null },
  });
  assert.equal("host" in exits[1], false);
  assert.equal("password" in exits[1], false);
});

test("leases are deterministic, idempotent, region-bound, and capacity-enforced", async () => {
  const provider = localProvider();
  assert.equal((await provider.leaseExit({ leaseId: "device-a", region: "IT" })).id, "it-1");
  assert.equal((await provider.leaseExit({ leaseId: "device-a", region: "DE" })).id, "it-1");
  assert.equal((await provider.leaseExit({ leaseId: "device-b", region: "IT" })).id, "it-1");
  assert.equal((await provider.leaseExit({ leaseId: "device-c", region: "IT" })).id, "it-2");
  await assert.rejects(
    provider.leaseExit({ leaseId: "device-d", region: "IT" }),
    error => error.code === "PROXY_CAPACITY_UNAVAILABLE" && error.status === 409,
  );
  assert.equal(await provider.releaseExit({ leaseId: "device-b" }), true);
  assert.equal((await provider.leaseExit({ leaseId: "device-d", region: "IT" })).id, "it-1");
});

test("disabled and unhealthy exits reject new leases without disrupting existing leases", async () => {
  const provider = localProvider();
  await provider.leaseExit({ leaseId: "device-a", region: "DE" });
  const disabled = await provider.setExitEnabled({ exitId: "de-1", enabled: false });
  assert.equal(disabled.activeLeases, 1);
  assert.equal(disabled.availableCapacity, 0);
  assert.equal((await provider.leaseExit({ leaseId: "device-a", region: "DE" })).id, "de-1");
  await assert.rejects(provider.leaseExit({ leaseId: "device-b", region: "DE" }), /no healthy enabled/);
  await provider.setExitHealth("it-1", { status: "offline", checkedAt: "2026-09-28T13:00:00Z" });
  assert.equal((await provider.leaseExit({ leaseId: "device-b", region: "IT" })).id, "it-2");
});

test("rotation is atomic and never returns the current, disabled, unhealthy, or full exit", async () => {
  const provider = localProvider();
  assert.equal((await provider.leaseExit({ leaseId: "device-a", region: "IT" })).id, "it-1");
  assert.equal((await provider.rotateExit({ leaseId: "device-a", region: "IT" })).id, "it-2");
  await provider.setExitEnabled({ exitId: "it-1", enabled: false });
  await assert.rejects(
    provider.rotateExit({ leaseId: "device-a", region: "IT" }),
    error => error.code === "PROXY_ROTATION_UNAVAILABLE" && error.status === 409,
  );
  const inventory = await provider.listExits();
  assert.equal(inventory.find(exit => exit.id === "it-2").activeLeases, 1);
});

test("provider definitions and control inputs fail closed", async () => {
  assert.throws(() => new DeterministicProxyProvider({ exits: [
    { id: "same", region: "IT", capacity: 1 }, { id: "same", region: "DE", capacity: 1 },
  ] }), /duplicate proxy exit/);
  assert.throws(() => new DeterministicProxyProvider({ exits: [{ id: "bad id", region: "IT", capacity: 1 }] }), /safe id/);
  const provider = localProvider();
  await assert.rejects(provider.setExitEnabled({ exitId: "it-1", enabled: "yes" }), /boolean/);
  await assert.rejects(provider.getHealth({ exitId: "missing" }), error => error.status === 404);
  await assert.rejects(provider.rotateExit({ leaseId: "missing" }), error => error.code === "PROXY_LEASE_NOT_FOUND");
});

test("rotation capability is explicit and still requires an implementation", async () => {
  const provider = new ProxyProvider({ id: "rotating-provider", label: "Rotating provider", supportsRotation: true });
  await assert.rejects(provider.rotateExit(), /not implemented/);
});

test("proxy health normalization returns only bounded operational fields", () => {
  assert.deepEqual(normalizeProxyHealth({
    status: "healthy",
    checkedAt: "2026-09-11T12:00:00Z",
    region: "Rome",
    publicIpv4: "198.51.100.10",
    latencyMs: 42,
    password: "must-not-leak",
  }), {
    status: "healthy",
    checkedAt: "2026-09-11T12:00:00.000Z",
    region: "Rome",
    publicIpv4: "198.51.100.10",
    latencyMs: 42,
  });
});
