import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { loadProxyProviderRegistry } from "../../src/proxyProviderRegistry.js";

function configFile(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-proxy-provider-registry-"));
  const file = path.join(root, "providers.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return { root, file };
}

test("no provider configuration is a valid disabled state", () => {
  assert.equal(loadProxyProviderRegistry({ env: {} }).size, 0);
});

test("an explicitly enabled deterministic provider loads safe exit inventory", async t => {
  const fixture = configFile({ providers: [{
    kind: "deterministic", id: "fixture", label: "Fixture provider",
    exits: [{ id: "rome-1", region: "IT", capacity: 3, health: { status: "healthy", checkedAt: "2026-09-28T12:00:00Z" } }],
  }] });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const registry = loadProxyProviderRegistry({ env: {
    PROXY_PROVIDER_CONFIG_PATH: fixture.file,
    ALLOW_DETERMINISTIC_PROXY_PROVIDER: "true",
  } });
  assert.deepEqual([...registry.keys()], ["fixture"]);
  assert.equal((await registry.get("fixture").listExits())[0].availableCapacity, 3);
});

test("test adapter requires an explicit non-production gate", t => {
  const fixture = configFile({ providers: [{ kind: "deterministic", id: "fixture", label: "Fixture", exits: [] }] });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.throws(() => loadProxyProviderRegistry({ env: { PROXY_PROVIDER_CONFIG_PATH: fixture.file } }), /test-only/);
});

test("missing, malformed, unsupported, duplicate, and oversized configuration fails startup", t => {
  assert.throws(() => loadProxyProviderRegistry({ env: {
    PROXY_PROVIDER_CONFIG_PATH: path.join(os.tmpdir(), `missing-${Date.now()}.json`), NODE_ENV: "test",
  } }), /does not exist/);

  const malformed = configFile({ providers: [{ kind: "unknown" }] });
  const duplicate = configFile({ providers: [
    { kind: "deterministic", id: "same", label: "One", exits: [] },
    { kind: "deterministic", id: "same", label: "Two", exits: [] },
  ] });
  const oversized = configFile({ providers: [], padding: "x".repeat(1024 * 1024) });
  t.after(() => {
    for (const item of [malformed, duplicate, oversized]) fs.rmSync(item.root, { recursive: true, force: true });
  });
  assert.throws(() => loadProxyProviderRegistry({ env: { PROXY_PROVIDER_CONFIG_PATH: malformed.file, NODE_ENV: "test" } }), /unsupported/);
  assert.throws(() => loadProxyProviderRegistry({ env: { PROXY_PROVIDER_CONFIG_PATH: duplicate.file, NODE_ENV: "test" } }), /duplicate/);
  assert.throws(() => loadProxyProviderRegistry({ env: { PROXY_PROVIDER_CONFIG_PATH: oversized.file, NODE_ENV: "test" } }), /exceeds/);
});
