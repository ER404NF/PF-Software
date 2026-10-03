import fs from "fs";
import path from "path";
import { DeterministicProxyProvider, assertProxyProviderContract } from "./proxyProvider.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

function readConfig(configPath) {
  const stat = fs.statSync(configPath);
  if (!stat.isFile()) throw new Error("proxy provider config path is not a file");
  if (stat.size > MAX_CONFIG_BYTES) throw new Error("proxy provider config exceeds 1 MiB");
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.providers)) {
    throw new Error("proxy provider config must contain a providers array");
  }
  return parsed.providers;
}

export function loadProxyProviderRegistry({ env = process.env } = {}) {
  const configuredPath = env.PROXY_PROVIDER_CONFIG_PATH?.trim();
  if (!configuredPath) return new Map();
  const configPath = path.resolve(configuredPath);
  if (!fs.existsSync(configPath)) throw new Error(`proxy provider config does not exist: ${configPath}`);

  const registry = new Map();
  for (const definition of readConfig(configPath)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error("every proxy provider definition must be an object");
    }
    if (definition.kind !== "deterministic") {
      throw new Error(`unsupported proxy provider kind: ${String(definition.kind || "(missing)")}`);
    }
    if (env.ALLOW_DETERMINISTIC_PROXY_PROVIDER !== "true" && env.NODE_ENV !== "test") {
      throw new Error("the deterministic proxy provider is test-only; set ALLOW_DETERMINISTIC_PROXY_PROVIDER=true for an explicit local development run");
    }
    const provider = assertProxyProviderContract(new DeterministicProxyProvider({
      id: definition.id,
      label: definition.label,
      exits: definition.exits,
    }));
    if (registry.has(provider.id)) throw new Error(`duplicate proxy provider id: ${provider.id}`);
    registry.set(provider.id, provider);
  }
  return registry;
}
