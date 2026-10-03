import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-provider-registry-"));

function writeConfig(config) {
  const file = path.join(root, `models-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

// providerRegistry.js loads its config at import time (same pattern as
// authStore.js/devices), so each scenario needs a fresh module instance
// pointed at its own config file via the env var — a bare `import` would
// reuse Node's module cache and only ever see the first config loaded.
async function loadRegistry(config) {
  const configPath = writeConfig(config);
  const previousPath = process.env.MODELS_CONFIG_PATH;
  process.env.MODELS_CONFIG_PATH = configPath;
  try {
    return await import(`../../src/providerRegistry.js?${encodeURIComponent(configPath)}`);
  } finally {
    if (previousPath === undefined) delete process.env.MODELS_CONFIG_PATH;
    else process.env.MODELS_CONFIG_PATH = previousPath;
  }
}

async function loadRegistryText(text) {
  const configPath = path.join(root, `models-raw-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(configPath, text);
  const previousPath = process.env.MODELS_CONFIG_PATH;
  process.env.MODELS_CONFIG_PATH = configPath;
  try {
    return await import(`../../src/providerRegistry.js?${encodeURIComponent(configPath)}`);
  } finally {
    if (previousPath === undefined) delete process.env.MODELS_CONFIG_PATH;
    else process.env.MODELS_CONFIG_PATH = previousPath;
  }
}

test("loads a configured anthropic and openai-compatible provider, resolving credentials from env vars", async () => {
  process.env.TEST_ANTHROPIC_KEY = "anthropic-secret";
  process.env.TEST_DEEPSEEK_KEY = "deepseek-secret";
  const registry = await loadRegistry({
    providers: [
      { name: "claude", kind: "anthropic", model: "claude-test", credentialEnv: "TEST_ANTHROPIC_KEY" },
      { name: "deepseek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", credentialEnv: "TEST_DEEPSEEK_KEY" },
    ],
  });
  assert.equal(registry.providers.size, 2);
  assert.equal(registry.getProvider("claude").apiKey, "anthropic-secret");
  assert.equal(registry.getProvider("deepseek").apiKey, "deepseek-secret");
  assert.equal(registry.getProvider("nonexistent"), null);
});

test("the first configured provider is the default unless one is explicitly marked default", async () => {
  const registry = await loadRegistry({
    providers: [
      { name: "first", kind: "anthropic", model: "x" },
      { name: "second", kind: "anthropic", model: "y", default: true },
    ],
  });
  assert.equal(registry.defaultProviderName, "second");
  assert.equal(registry.getDefaultProvider().name, "second");
});

test("falls back to the first configured provider when none is marked default", async () => {
  const registry = await loadRegistry({
    providers: [
      { name: "first", kind: "anthropic", model: "x" },
      { name: "second", kind: "anthropic", model: "y" },
    ],
  });
  assert.equal(registry.defaultProviderName, "first");
});

test("no config file at all is a valid empty state, not an error", async () => {
  const missingPath = path.join(root, "does-not-exist.json");
  process.env.MODELS_CONFIG_PATH = missingPath;
  try {
    const registry = await import(`../../src/providerRegistry.js?${encodeURIComponent(missingPath)}`);
    assert.equal(registry.providers.size, 0);
    assert.equal(registry.getDefaultProvider(), null);
  } finally { delete process.env.MODELS_CONFIG_PATH; }
});

test("an unknown provider kind is skipped with a warning instead of crashing the whole registry", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const registry = await loadRegistry({
      providers: [
        { name: "bad-kind", kind: "some-future-vendor", model: "x" },
        { name: "good", kind: "anthropic", model: "y" },
      ],
    });
    assert.equal(registry.providers.size, 1);
    assert.equal(registry.getProvider("good").name, "good");
    assert.ok(warn.mock.calls.some((c) => c.arguments[0].includes("bad-kind")));
  } finally { warn.mock.restore(); }
});

test("a missing credential env var registers the provider but warns, rather than silently having no key or crashing", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const registry = await loadRegistry({
      providers: [{ name: "claude", kind: "anthropic", model: "x", credentialEnv: "TEST_TOTALLY_UNSET_VAR_XYZ" }],
    });
    assert.equal(registry.getProvider("claude").apiKey, null);
    assert.ok(warn.mock.calls.some((c) => c.arguments[0].includes("TEST_TOTALLY_UNSET_VAR_XYZ")));
  } finally { warn.mock.restore(); }
});

test("a duplicate provider name keeps the first entry and warns about the rest", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const registry = await loadRegistry({
      providers: [
        { name: "dup", kind: "anthropic", model: "first-model" },
        { name: "dup", kind: "anthropic", model: "second-model" },
      ],
    });
    assert.equal(registry.providers.size, 1);
    assert.equal(registry.getProvider("dup").model, "first-model");
    assert.ok(warn.mock.calls.some((c) => c.arguments[0].includes("duplicate provider name")));
  } finally { warn.mock.restore(); }
});

test("openai-compatible entry missing baseUrl is skipped with a warning, not a crash", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const registry = await loadRegistry({
      providers: [{ name: "broken", kind: "openai-compatible", model: "x" }],
    });
    assert.equal(registry.providers.size, 0);
    assert.ok(warn.mock.calls.some((c) => c.arguments[0].includes("broken")));
  } finally { warn.mock.restore(); }
});

test("malformed configuration fails closed without logging parser input", async () => {
  const privateMarker = "PRIVATE_CONFIG_MARKER";
  const warn = mock.method(console, "warn", () => {});
  try {
    const registry = await loadRegistryText(`{ "providers": [${privateMarker}`);
    assert.equal(registry.providers.size, 0);
    const output = warn.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.match(output, /unable to read provider configuration/);
    assert.doesNotMatch(output, new RegExp(privateMarker));
  } finally { warn.mock.restore(); }
});

test("a non-array providers value fails closed instead of aborting registry load", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const registry = await loadRegistry({ providers: { name: "not-an-array" } });
    assert.equal(registry.providers.size, 0);
    assert.ok(warn.mock.calls.some((call) => call.arguments[0].includes("providers must be an array")));
  } finally { warn.mock.restore(); }
});

test("unsafe provider fields are rejected without echoing their contents", async () => {
  const privateName = "PRIVATE_NAME\nINJECTED";
  const privateEnv = "PRIVATE_ENV=SECRET_VALUE";
  const privateUrl = "https://user:PRIVATE_PASSWORD@example.test";
  const warn = mock.method(console, "warn", () => {});
  try {
    const registry = await loadRegistry({
      providers: [
        null,
        { name: privateName, kind: "anthropic", model: "x" },
        { name: "bad-env", kind: "anthropic", model: "x", credentialEnv: privateEnv },
        { name: "bad-url", kind: "openai-compatible", model: "x", baseUrl: privateUrl },
        { name: "good", kind: "anthropic", model: "x" },
      ],
    });
    assert.deepEqual([...registry.providers.keys()], ["good"]);
    const output = warn.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.match(output, /invalid-provider/);
    assert.doesNotMatch(output, /PRIVATE_NAME|PRIVATE_ENV|SECRET_VALUE|PRIVATE_PASSWORD/);
  } finally { warn.mock.restore(); }
});
