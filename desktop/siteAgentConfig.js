// "Site" mode: this Mac mini is one location of a multi-site Phone Farm. It runs no
// operator UI; it links its USB phones to the hub. Everything here is pure (no
// Electron, no filesystem) so it can be tested without a GUI.

const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Validates what the operator typed into the setup screen. The site token must
// never cross the internet in clear text, so http:// is refused except to the
// local machine.
function validateSiteSettings({ hubUrl, siteId, siteToken } = {}) {
  let parsed;
  try {
    parsed = new URL(String(hubUrl ?? "").trim());
  } catch {
    return { ok: false, error: "Enter the hub address exactly as shown on the hub's Sites page (for example https://phones.example.com)." };
  }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    return { ok: false, error: "The hub address must start with https:// and must not contain a username or password." };
  }
  if (parsed.protocol !== "https:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: false, error: "The hub address must use https:// so the site token is encrypted on its way to the hub." };
  }
  const id = String(siteId ?? "").trim();
  if (!SITE_ID_PATTERN.test(id)) {
    return { ok: false, error: "The site ID uses lowercase letters, digits and hyphens (for example bucharest)." };
  }
  const token = String(siteToken ?? "").trim();
  if (!/^pfs_[A-Za-z0-9_-]{20,200}$/.test(token)) {
    return { ok: false, error: "The site token starts with pfs_ and is shown once on the hub's Sites page. Create a new one there if it was lost." };
  }
  return { ok: true, settings: { hubUrl: parsed.origin, siteId: id, siteToken: token } };
}

// Environment for the packaged agent process (Electron running as plain Node).
function siteAgentEnvironment(settings, { storageRoot, path }) {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    HUB_URL: settings.hubUrl,
    SITE_ID: settings.siteId,
    SITE_TOKEN: settings.siteToken,
    AUTO_PROVISION_WDA: "true",
    DEVICE_PROVISIONING_STORE_PATH: path.join(storageRoot, "device-provisioning.json"),
    WDA_DERIVED_DATA_ROOT: path.join(storageRoot, "wda-derived-data"),
  };
}

function agentEntryPath({ packaged, resourcesPath, dirname, path }) {
  return packaged
    ? path.join(resourcesPath, "system", "server", "src", "agentMain.js")
    : path.join(dirname, "..", "system", "server", "src", "agentMain.js");
}

// What the agent's log lines mean for the status shown to the person at the Mac.
function parseAgentStatus(line) {
  const text = String(line);
  if (/hub refused the link: HTTP 401/.test(text)) return { state: "refused", detail: "The hub does not accept this site's token. Create a new token on the hub's Sites page." };
  if (/hub refused the link/.test(text)) return { state: "error", detail: text.trim() };
  if (/linked to /.test(text)) return { state: "linked", detail: "Linked to the hub." };
  if (/link error: .*(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)/.test(text)) return { state: "reconnecting", detail: "Cannot reach the hub. Retrying automatically." };
  return null;
}

module.exports = { SITE_ID_PATTERN, validateSiteSettings, siteAgentEnvironment, agentEntryPath, parseAgentStatus };
