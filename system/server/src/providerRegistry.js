// Config-driven model-provider registry — mirrors the pattern
// devices.config.json already established for hardware (CLAUDE.md §6:
// "never hard-code the system to a single model provider"; MS8.1.2/8.1.3).
// models.config.json lists every configured provider by name/kind/model/
// base URL; credentials are a secret *reference* (an environment variable
// name), never a plaintext key, per Architecture Baseline.md §13 — the same
// pattern operators.config.json uses for password hashes rather than raw
// passwords. This means models.config.json itself is safe to keep in
// version control, same as devices.config.json.
//
// Example entry:
//   { "name": "claude", "kind": "anthropic", "model": "claude-...",
//     "credentialEnv": "ANTHROPIC_API_KEY", "default": true }
//   { "name": "deepseek", "kind": "openai-compatible",
//     "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat",
//     "credentialEnv": "DEEPSEEK_API_KEY" }

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Env-overridable so tests can point at a disposable temp config instead of
// the real models.config.json — same convention as OPERATORS_CONFIG_PATH/
// RESEARCH_CONFIG_PATH.
const configPath = process.env.MODELS_CONFIG_PATH
  ? path.resolve(process.env.MODELS_CONFIG_PATH)
  : path.join(__dirname, "../../models.config.json");

const ADAPTER_KINDS = {
  anthropic: AnthropicProvider,
  "openai-compatible": OpenAiCompatibleProvider,
};

function readConfig() {
  if (!fs.existsSync(configPath)) return { providers: [] };
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

// Config names an *environment variable* holding the real key, never the
// key itself. A missing variable is not a load-time error — the provider
// still registers (so `providers`/`getProvider` reflect what's configured),
// it will simply fail with a clear message the first time something tries
// to actually use it, same fail-loud-not-silent spirit as
// filterValidResearchGrants's dropped-grant warning.
function resolveCredential(name, credentialEnv) {
  if (!credentialEnv) return null;
  const value = process.env[credentialEnv];
  if (!value) {
    console.warn(`models.config.json: provider "${name}" references environment variable "${credentialEnv}", which is not set — it will fail on first use`);
  }
  return value ?? null;
}

function buildProvider(entry) {
  const Adapter = ADAPTER_KINDS[entry.kind];
  if (!Adapter) {
    throw new Error(`unknown provider kind "${entry.kind}" — expected one of ${Object.keys(ADAPTER_KINDS).join(", ")}`);
  }
  return new Adapter({
    name: entry.name,
    model: entry.model,
    baseUrl: entry.baseUrl,
    apiKey: resolveCredential(entry.name, entry.credentialEnv),
  });
}

function loadProviders() {
  const raw = readConfig();
  const map = new Map();
  let defaultName = null;
  for (const entry of raw.providers || []) {
    if (!entry || typeof entry.name !== "string" || !entry.name) {
      console.warn("models.config.json: skipping a provider entry with no name");
      continue;
    }
    if (map.has(entry.name)) {
      console.warn(`models.config.json: duplicate provider name "${entry.name}" — keeping the first, ignoring the rest`);
      continue;
    }
    try {
      map.set(entry.name, buildProvider(entry));
      // First entry wins as the fallback default unless a later one is
      // explicitly marked `"default": true` — mirrors devices.config.json's
      // "first configured wins" convention rather than requiring every
      // config to name a default explicitly.
      if (entry.default || !defaultName) defaultName = entry.name;
    } catch (err) {
      console.warn(`models.config.json: failed to load provider "${entry.name}": ${err.message}`);
    }
  }
  return { map, defaultName };
}

// Exported live, like index.js's `devices` and authStore.js's `operators`,
// so tests can inject/remove a provider without writing to the real config
// file on disk.
const loaded = loadProviders();
export const providers = loaded.map;
export const defaultProviderName = loaded.defaultName;

export function getProvider(name) {
  return providers.get(name) ?? null;
}

// No default configured is a valid fail-closed state. The production research
// runner handles null rather than assuming a provider always exists.
export function getDefaultProvider() {
  return defaultProviderName ? getProvider(defaultProviderName) : null;
}
