const SUPPORTED_BACKENDS = new Set(["file", "postgres"]);

function repositoryBackend(env, name) {
  const key = `${name.toUpperCase()}_REPOSITORY_BACKEND`;
  const value = String(env[key] ?? "file").trim().toLowerCase();
  if (!SUPPORTED_BACKENDS.has(value)) {
    throw new Error(`${key} must be either file or postgres`);
  }
  return value;
}

// Domain cutovers are deliberately independent. A deployment can move one
// repository at a time, observe it, and roll that domain back to the still-
// readable file source without changing unrelated authorities.
export function resolveDurableRepositoryConfig(env = process.env) {
  const sites = repositoryBackend(env, "site");
  const requiresDatabase = sites === "postgres" || env.CLOUD_API_ENABLED === "true";
  if (requiresDatabase && !env.DATABASE_URL) {
    throw new Error("PostgreSQL-backed identity or repositories require DATABASE_URL to be set");
  }
  return Object.freeze({ sites, requiresDatabase });
}

