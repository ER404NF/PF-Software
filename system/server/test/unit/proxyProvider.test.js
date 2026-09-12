import { test } from "node:test";
import assert from "node:assert/strict";
import { ProxyProvider, assertProxyProviderContract, normalizeProxyHealth } from "../../src/proxyProvider.js";

test("base proxy provider declares honest unsupported behavior", async () => {
  const provider = assertProxyProviderContract(new ProxyProvider({ id: "future-provider", label: "Future provider" }));
  await assert.rejects(provider.getHealth(), /not implemented/);
  await assert.rejects(provider.rotateExit(), /not supported/);
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
