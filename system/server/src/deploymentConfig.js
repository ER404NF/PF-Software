import { isIP } from "node:net";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEVELOPMENT_SESSION_SECRET = "dev-only-insecure-secret-change-me";

function enabled(value) {
  return value === "true";
}

function validateBindHost(value) {
  const host = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "127.0.0.1";
  if (host === "localhost" || isIP(host)) return host;
  throw new Error("HOST must be localhost or an IP address");
}

function resolveDeploymentConfig(env = process.env, { enforceStartup = false, hasMockDevices = false } = {}) {
  const host = validateBindHost(env.HOST);
  const localDevelopment = enabled(env.PHONE_FARM_LOCAL_DEV);
  const publicUrl = env.PUBLIC_BASE_URL ? new URL(env.PUBLIC_BASE_URL) : null;
  if (publicUrl && !new Set(["http:", "https:"]).has(publicUrl.protocol)) {
    throw new Error("PUBLIC_BASE_URL must use http or https");
  }
  const secureCookies = enabled(env.SESSION_COOKIE_SECURE) || publicUrl?.protocol === "https:";
  const configuredSecret = typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : "";

  if (enforceStartup && !LOOPBACK_HOSTS.has(host) && !secureCookies) {
    throw new Error("non-loopback HOST requires HTTPS cookie configuration");
  }
  if (enforceStartup && !localDevelopment) {
    if (configuredSecret.length < 32) {
      throw new Error("SESSION_SECRET must contain at least 32 characters outside PHONE_FARM_LOCAL_DEV mode");
    }
    if (hasMockDevices) {
      throw new Error("mock devices require PHONE_FARM_LOCAL_DEV=true; use DEVICE_CONFIG_PATH for a live fleet");
    }
  }

  return {
    host,
    publicUrl: publicUrl ? publicUrl.origin : null,
    localDevelopment,
    secureCookies,
    trustProxy: secureCookies,
    sessionSecret: configuredSecret || DEVELOPMENT_SESSION_SECRET,
  };
}

export { DEVELOPMENT_SESSION_SECRET, resolveDeploymentConfig };
