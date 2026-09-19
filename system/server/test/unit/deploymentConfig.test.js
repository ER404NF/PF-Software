import test from "node:test";
import assert from "node:assert/strict";
import { DEVELOPMENT_SESSION_SECRET, resolveDeploymentConfig } from "../../src/deploymentConfig.js";

test("deployment defaults to loopback but production startup requires a strong session secret", () => {
  const imported = resolveDeploymentConfig({}, { enforceStartup: false });
  assert.equal(imported.host, "127.0.0.1");
  assert.equal(imported.sessionSecret, DEVELOPMENT_SESSION_SECRET);
  assert.throws(() => resolveDeploymentConfig({}, { enforceStartup: true }), /SESSION_SECRET/);
});

test("explicit local development permits the mock fixture fleet", () => {
  const config = resolveDeploymentConfig({ PHONE_FARM_LOCAL_DEV: "true" }, {
    enforceStartup: true,
    hasMockDevices: true,
  });
  assert.equal(config.localDevelopment, true);
  assert.equal(config.host, "127.0.0.1");
});

test("production startup rejects mock devices and short secrets", () => {
  assert.throws(() => resolveDeploymentConfig({ SESSION_SECRET: "short" }, { enforceStartup: true }), /32 characters/);
  assert.throws(() => resolveDeploymentConfig({ SESSION_SECRET: "x".repeat(32) }, {
    enforceStartup: true,
    hasMockDevices: true,
  }), /mock devices require/);
});

test("non-loopback exposure requires secure cookies", () => {
  const base = { HOST: "0.0.0.0", SESSION_SECRET: "x".repeat(32) };
  assert.throws(() => resolveDeploymentConfig(base, { enforceStartup: true }), /requires HTTPS/);
  assert.equal(resolveDeploymentConfig({ ...base, PUBLIC_BASE_URL: "https://farm.example" }, {
    enforceStartup: true,
  }).secureCookies, true);
  assert.equal(resolveDeploymentConfig({ ...base, SESSION_COOKIE_SECURE: "true" }, {
    enforceStartup: true,
  }).trustProxy, true);
});

test("bind host and public URL parsing fail closed", () => {
  assert.throws(() => resolveDeploymentConfig({ HOST: "farm.internal" }), /HOST/);
  assert.throws(() => resolveDeploymentConfig({ PUBLIC_BASE_URL: "ftp://farm.example" }), /http or https/);
});

test("the configured public URL is exposed as an origin, so site enrollment shows the address operators really use", () => {
  assert.equal(resolveDeploymentConfig({ PUBLIC_BASE_URL: "https://phones.example.com/some/path?x=1", SESSION_SECRET: "x".repeat(40) }).publicUrl, "https://phones.example.com");
  assert.equal(resolveDeploymentConfig({}).publicUrl, null);
});
