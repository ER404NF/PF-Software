import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("../", import.meta.url));

export const EXTERNAL_TEST_EXIT = Object.freeze({
  TEST_FAILURE: 1,
  CONFIGURATION_MISSING: 2,
  SERVICE_UNAVAILABLE: 3,
});

const CONFIG = Object.freeze({
  postgres: {
    envName: "TEST_DATABASE_URL",
    directory: path.join(serverRoot, "test", "integration", "db"),
  },
  redis: {
    envName: "TEST_REDIS_URL",
    directory: path.join(serverRoot, "test", "integration", "redis"),
  },
});

function configFor(kind) {
  const config = CONFIG[kind];
  if (!config) throw new Error("external integration kind must be postgres or redis");
  return config;
}

export function collectExternalIntegrationTests(kind) {
  const { directory } = configFor(kind);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".test.js"))
    .map(entry => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function runExternalIntegration({ kind, env = process.env, probe, run }) {
  const config = configFor(kind);
  if (typeof env[config.envName] !== "string" || !env[config.envName].trim()) {
    return { ok: false, category: "configuration_missing", exitCode: EXTERNAL_TEST_EXIT.CONFIGURATION_MISSING };
  }
  try { await probe(env[config.envName]); }
  catch {
    return { ok: false, category: "service_unavailable", exitCode: EXTERNAL_TEST_EXIT.SERVICE_UNAVAILABLE };
  }
  const files = collectExternalIntegrationTests(kind);
  const status = run(files);
  if (status !== 0) return { ok: false, category: "test_failure", exitCode: EXTERNAL_TEST_EXIT.TEST_FAILURE };
  return { ok: true, category: "passed", exitCode: 0 };
}
