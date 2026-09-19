const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  validateSiteSettings, siteAgentEnvironment, agentEntryPath, parseAgentStatus,
} = require("../siteAgentConfig");

const good = { hubUrl: "https://phones.example.com/", siteId: "bucharest", siteToken: "pfs_" + "A".repeat(43) };

test("valid site settings are normalised (origin only, trimmed)", () => {
  const result = validateSiteSettings({ ...good, hubUrl: "  https://phones.example.com/some/page?x=1  ", siteId: " bucharest " });
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings, { hubUrl: "https://phones.example.com", siteId: "bucharest", siteToken: good.siteToken });
});

test("the site token is never allowed to travel to a remote hub over plain http", () => {
  for (const hubUrl of ["http://phones.example.com", "http://203.0.113.5:4173"]) {
    const result = validateSiteSettings({ ...good, hubUrl });
    assert.equal(result.ok, false, hubUrl);
    assert.match(result.error, /https/);
  }
  assert.equal(validateSiteSettings({ ...good, hubUrl: "http://localhost:4173" }).ok, true, "a hub on this machine is fine");
  assert.equal(validateSiteSettings({ ...good, hubUrl: "http://127.0.0.1:4173" }).ok, true);
});

test("credentials in the address, other schemes and junk are rejected with a plain-language message", () => {
  for (const hubUrl of ["https://user:pass@phones.example.com", "ftp://phones.example.com", "phones.example.com", "", undefined]) {
    const result = validateSiteSettings({ ...good, hubUrl });
    assert.equal(result.ok, false, String(hubUrl));
    assert.ok(result.error.length > 20);
  }
});

test("site id and token formats are checked", () => {
  for (const siteId of ["", "Bucharest", "buc harest", "-bad", "a".repeat(40), "x__y"]) {
    assert.equal(validateSiteSettings({ ...good, siteId }).ok, false, siteId);
  }
  for (const siteToken of ["", "abc", "pfs_short", "pfs_" + "!".repeat(30), "token_" + "A".repeat(43)]) {
    assert.equal(validateSiteSettings({ ...good, siteToken }).ok, false, siteToken);
  }
});

test("the agent environment carries the site identity and turns on automatic iPhone setup", () => {
  const env = siteAgentEnvironment({ hubUrl: "https://phones.example.com", siteId: "bucharest", siteToken: good.siteToken }, { storageRoot: "/store", path: path.posix });
  assert.equal(env.HUB_URL, "https://phones.example.com");
  assert.equal(env.SITE_ID, "bucharest");
  assert.equal(env.SITE_TOKEN, good.siteToken);
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1", "the packaged app runs the agent with Electron as plain Node");
  assert.equal(env.AUTO_PROVISION_WDA, "true");
  assert.equal(env.DEVICE_PROVISIONING_STORE_PATH, "/store/device-provisioning.json");
});

test("the agent entry point is found inside the packaged resources and in the repo during development", () => {
  assert.equal(agentEntryPath({ packaged: true, resourcesPath: "/App/Resources", dirname: "/x", path: path.posix }), "/App/Resources/system/server/src/agentMain.js");
  assert.equal(agentEntryPath({ packaged: false, resourcesPath: "/nope", dirname: "/repo/desktop", path: path.posix }), "/repo/system/server/src/agentMain.js");
});

test("agent log lines map to a status a non-technical person can act on", () => {
  assert.equal(parseAgentStatus("[agent] linked to ws://phones.example.com/agent-link").state, "linked");
  const refused = parseAgentStatus("[agent] hub refused the link: HTTP 401");
  assert.equal(refused.state, "refused");
  assert.match(refused.detail, /new token/);
  assert.equal(parseAgentStatus("[agent] link error: connect ECONNREFUSED 1.2.3.4:443").state, "reconnecting");
  assert.equal(parseAgentStatus("[agent] link error: getaddrinfo ENOTFOUND phones.example.com").state, "reconnecting");
  assert.equal(parseAgentStatus("something unrelated"), null);
});
