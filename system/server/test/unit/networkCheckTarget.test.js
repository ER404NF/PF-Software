import test from "node:test";
import assert from "node:assert/strict";
import { resolveNetworkCheckTarget } from "../../src/networkCheckTarget.js";

test("configured network endpoints remain server-controlled", () => {
  assert.equal(resolveNetworkCheckTarget({ configuredUrl: "https://check.example/ip" }), "https://check.example/ip");
});

test("caller network endpoint overrides are disabled outside explicit tests", () => {
  assert.throws(() => resolveNetworkCheckTarget({
    requestedUrl: "http://127.0.0.1:1234/ip",
    env: { NODE_ENV: "production", ALLOW_NETWORK_CHECK_URL_OVERRIDE: "true" },
  }), /disabled/);
  assert.throws(() => resolveNetworkCheckTarget({
    requestedUrl: "http://127.0.0.1:1234/ip",
    env: { NODE_ENV: "test" },
  }), /disabled/);
});

test("test overrides allow only explicit credential-free loopback HTTP endpoints", () => {
  const env = { NODE_ENV: "test", ALLOW_NETWORK_CHECK_URL_OVERRIDE: "true" };
  assert.equal(resolveNetworkCheckTarget({ requestedUrl: "http://127.0.0.1:1234/ip", env }), "http://127.0.0.1:1234/ip");
  for (const requestedUrl of [
    "https://127.0.0.1:1234/ip",
    "http://localhost:1234/ip",
    "http://10.0.0.1:1234/ip",
    "http://user:pass@127.0.0.1:1234/ip",
    "http://127.0.0.1/ip",
    "not-a-url",
  ]) assert.throws(() => resolveNetworkCheckTarget({ requestedUrl, env }), /loopback/);
});
