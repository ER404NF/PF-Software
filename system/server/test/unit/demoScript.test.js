// Regression: the demo script never set TWO_FACTOR_MASTER_KEY, so the proxy pool (which requires it, or
// PROXY_CREDENTIAL_ENCRYPTION_KEY, to encrypt stored proxy passwords — see index.js) silently 503'd on every
// add. The packaged desktop app always generates a real one per install (main.js's hostSecrets()), so this
// was invisible there; `npm run demo` was the one place a person could try the app and this feature would
// always fail. Found by reproducing the report "added a proxy, never saw it" directly against the demo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/demo.js"), "utf8");
const systemRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("the demo server is started with a two-factor master key, so the proxy pool actually works when tried", () => {
  assert.match(source, /TWO_FACTOR_MASTER_KEY:\s*crypto\.randomBytes/,
    "without this, every POST /api/admin/proxies in the demo 503s (see index.js's proxyCredentialEncryptionKey check)");
});

test("the tracked fleet is empty and simulation exists only in the explicit demo fixture", () => {
  const config = JSON.parse(fs.readFileSync(path.join(systemRoot, "devices.config.json"), "utf8"));
  assert.deepEqual(config, { devices: [] });
  assert.match(source, /type:\s*"mock"/);
  assert.match(source, /phonefarm-demo-/);
});
