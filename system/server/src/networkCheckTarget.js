const TEST_LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function resolveNetworkCheckTarget({ configuredUrl, requestedUrl, env = process.env } = {}) {
  if (requestedUrl === undefined || requestedUrl === null || requestedUrl === "") return configuredUrl;
  if (env.NODE_ENV !== "test" || env.ALLOW_NETWORK_CHECK_URL_OVERRIDE !== "true") {
    throw badRequest("caller-supplied checkUrl is disabled");
  }
  let parsed;
  try { parsed = new URL(requestedUrl); }
  catch { throw badRequest("test checkUrl must be a valid loopback URL"); }
  if (parsed.protocol !== "http:" || !TEST_LOOPBACK_HOSTS.has(parsed.hostname)
    || !parsed.port || parsed.username || parsed.password) {
    throw badRequest("test checkUrl must be an explicit loopback HTTP endpoint");
  }
  return parsed.href;
}

export { resolveNetworkCheckTarget };
