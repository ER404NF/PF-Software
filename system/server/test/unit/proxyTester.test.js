import { test } from "node:test";
import assert from "node:assert/strict";
import { ProxyTestError, testProxy, validateProxyForTest, verificationProviders } from "../../src/proxyTester.js";

function proxy(overrides = {}) {
  return {
    protocol: "socks5", host: "proxy.example.com", port: 1080,
    username: "operator", password: "secret", country: "US", ...overrides,
  };
}

test("proxy validation rejects malformed fields and invalid hostnames with stable codes", () => {
  assert.throws(() => validateProxyForTest(proxy({ protocol: "ftp" })), error => error.code === "P108");
  assert.throws(() => validateProxyForTest(proxy({ host: "bad host/with-path" })), error => error.code === "P101");
});

test("DNS failure is classified separately before a connection is attempted", async () => {
  let probes = 0;
  await assert.rejects(() => testProxy(proxy(), {
    lookup: async () => { throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); },
    probe: async () => { probes += 1; },
  }), error => error.code === "P102");
  assert.equal(probes, 0);
});

test("connection, protocol, and authentication failures retain their specific codes", async () => {
  for (const code of ["P104", "P105", "P106", "P107"]) {
    await assert.rejects(() => testProxy(proxy(), {
      lookup: async () => ({ address: "203.0.113.10" }),
      providers: [{ id: "fixture", url: "http://example.test/ip" }],
      probe: async () => { throw new ProxyTestError(code); },
    }), error => error.code === code);
  }
});

test("verification providers fail over and a passing result records safe health metadata", async () => {
  const seen = [];
  let clock = 1000;
  const result = await testProxy(proxy(), {
    lookup: async () => ({ address: "203.0.113.10" }),
    providers: [{ id: "first", url: "http://first.test/ip" }, { id: "second", url: "http://second.test/ip" }],
    probe: async (_proxy, provider) => {
      seen.push(provider.id);
      if (provider.id === "first") throw new ProxyTestError("P109");
      clock += 42;
      return { publicIpv4: "198.51.100.20", country: "US" };
    },
    now: () => clock,
  });
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(result.status, "healthy");
  assert.equal(result.publicIpv4, "198.51.100.20");
  assert.equal(result.country, "US");
  assert.equal(result.latencyMs, 42);
  assert.equal(result.stages.authentication, "passed");
});

test("a country mismatch is specific and does not fall through as a service outage", async () => {
  await assert.rejects(() => testProxy(proxy({ country: "US" }), {
    lookup: async () => ({ address: "203.0.113.10" }),
    providers: [{ id: "fixture", url: "http://example.test/ip" }],
    probe: async () => ({ publicIpv4: "198.51.100.20", country: "DE" }),
  }), error => error.code === "P110" && error.diagnostic.technical.expectedCountry === "US");
});

test("normal verification has built-in fallback providers while deployments can override them", () => {
  assert.ok(verificationProviders({}).length >= 2);
  assert.deepEqual(verificationProviders({ NETWORK_VERIFICATION_URLS: "http://one.test/ip, http://two.test/ip" }), [
    { id: "configured-1", url: "http://one.test/ip" },
    { id: "configured-2", url: "http://two.test/ip" },
  ]);
});
