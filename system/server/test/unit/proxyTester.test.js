import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  ProxyTestError, httpConnectTunnel, probeProxy, proxyAuthorization, socks5Connect,
  testProxy, validateProxyForTest, verificationProviders,
} from "../../src/proxyTester.js";

function proxy(overrides = {}) {
  return {
    protocol: "socks5", host: "proxy.example.com", port: 1080,
    username: "operator", password: "secret", country: "US", ...overrides,
  };
}

class ScriptedSocket extends EventEmitter {
  constructor(onWrite) {
    super();
    this.onWrite = onWrite;
    this.writes = [];
  }
  write(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.writes.push(bytes);
    this.onWrite?.(bytes, this.writes.length, this);
    return true;
  }
  setTimeout() {}
  destroy() { this.destroyed = true; }
}

test("proxy validation rejects malformed fields and invalid hostnames with stable codes", () => {
  assert.throws(() => validateProxyForTest(proxy({ protocol: "ftp" })), error => error.code === "P108");
  assert.throws(() => validateProxyForTest(proxy({ host: "bad host/with-path" })), error => error.code === "P101");
});

test("proxy validation preserves username and password exactly, including surrounding whitespace", () => {
  const input = proxy({ username: " customer-country-US-session-abc ", password: " p@ss:/?#[] " });
  const validated = validateProxyForTest(input);
  assert.equal(validated.username, input.username);
  assert.equal(validated.password, input.password);
});

test("HTTP CONNECT sends exact Basic authentication and classifies an actual 407 without leaking it", async () => {
  const credentials = proxy({ protocol: "http", username: "customer-country-US-session-abc", password: "p@ss:/word" });
  const socket = new ScriptedSocket((_bytes, writeNumber, current) => {
    if (writeNumber === 1) queueMicrotask(() => current.emit("data", Buffer.from("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")));
  });
  await assert.rejects(
    () => httpConnectTunnel(socket, credentials, { hostname: "example.test", port: 443 }),
    error => {
      assert.equal(error.code, "P107");
      assert.equal(error.diagnostic.technical.httpStatus, 407);
      assert.equal(error.diagnostic.technical.phase, "connect");
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /customer-country|p@ss/);
      return true;
    },
  );
  const request = socket.writes[0].toString("latin1");
  assert.match(request, /CONNECT example\.test:443 HTTP\/1\.1/);
  assert.equal(request.includes(proxyAuthorization(credentials).trim()), true);
  assert.equal(Buffer.from(/Basic ([^\r\n]+)/.exec(request)[1], "base64").toString(), `${credentials.username}:${credentials.password}`);
});

test("HTTPS proxy selection opens a TLS transport before sending the HTTP request", async () => {
  let connectOptions = null;
  const socket = new ScriptedSocket((_bytes, writeNumber, current) => {
    if (writeNumber === 1) queueMicrotask(() => {
      current.emit("data", Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{\"ip\":\"203.0.113.8\"}"));
      current.emit("end");
    });
  });
  const result = await probeProxy(proxy({ protocol: "https" }), { id: "fixture", url: "http://identity.test/ip" }, {
    connectFn: async options => { connectOptions = options; return socket; },
  });
  assert.equal(connectOptions.secure, true);
  assert.equal(connectOptions.host, "proxy.example.com");
  assert.equal(result.publicIpv4, "203.0.113.8");
});

test("SOCKS5 authentication uses UTF-8 byte lengths and preserves provider credential bytes", async () => {
  const credentials = proxy({ username: "customer-country-US-session-å", password: "päss:/?#" });
  const socket = new ScriptedSocket((_bytes, writeNumber, current) => queueMicrotask(() => {
    if (writeNumber === 1) current.emit("data", Buffer.from([5, 2]));
    if (writeNumber === 2) current.emit("data", Buffer.from([1, 0]));
    if (writeNumber === 3) current.emit("data", Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 187]));
  }));
  await socks5Connect(socket, credentials, { hostname: "identity.test", port: 443 });
  const auth = socket.writes[1];
  const userBytes = Buffer.from(credentials.username);
  const passwordBytes = Buffer.from(credentials.password);
  assert.equal(auth[1], userBytes.length);
  assert.deepEqual(auth.subarray(2, 2 + userBytes.length), userBytes);
  const passwordOffset = 2 + userBytes.length;
  assert.equal(auth[passwordOffset], passwordBytes.length);
  assert.deepEqual(auth.subarray(passwordOffset + 1), passwordBytes);
});

test("SOCKS5 rejects a server-selected method the client did not offer", async () => {
  const credentials = proxy({ username: "provider-user", password: "provider-password" });
  const socket = new ScriptedSocket((_bytes, writeNumber, current) => {
    if (writeNumber === 1) queueMicrotask(() => current.emit("data", Buffer.from([5, 0])));
  });
  await assert.rejects(
    () => socks5Connect(socket, credentials, { hostname: "identity.test", port: 443 }),
    error => error.code === "P106" && error.diagnostic.technical.phase === "method",
  );
});

test("SOCKS5 CONNECT ruleset rejection is not mislabeled as bad credentials", async () => {
  const credentials = proxy({ username: "provider-user", password: "provider-password" });
  const socket = new ScriptedSocket((_bytes, writeNumber, current) => queueMicrotask(() => {
    if (writeNumber === 1) current.emit("data", Buffer.from([5, 2]));
    if (writeNumber === 2) current.emit("data", Buffer.from([1, 0]));
    if (writeNumber === 3) current.emit("data", Buffer.from([5, 2, 0, 1]));
  }));
  await assert.rejects(
    () => socks5Connect(socket, credentials, { hostname: "identity.test", port: 443 }),
    error => error.code === "P109"
      && error.diagnostic.technical.phase === "connect"
      && error.diagnostic.technical.socksReply === 2,
  );
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
