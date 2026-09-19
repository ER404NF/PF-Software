import { test } from "node:test";
import assert from "node:assert/strict";
import { readAgentConfig } from "../../src/agentMain.js";

const base = { HUB_URL: "https://phones.example.com", SITE_ID: "bucharest", SITE_TOKEN: "pfs_abc" };

test("a complete, secure configuration is accepted and trimmed", () => {
  assert.deepEqual(readAgentConfig({ ...base, SITE_ID: " bucharest ", SITE_TOKEN: " pfs_abc " }),
    { hubUrl: "https://phones.example.com", siteId: "bucharest", token: "pfs_abc" });
});

test("missing values are named so the operator knows what to copy from the Sites page", () => {
  assert.throws(() => readAgentConfig({ HUB_URL: base.HUB_URL }), /Missing SITE_ID, SITE_TOKEN/);
  assert.throws(() => readAgentConfig({}), /Missing HUB_URL, SITE_ID, SITE_TOKEN/);
});

test("the site token never travels over plain http across the internet", () => {
  assert.throws(() => readAgentConfig({ ...base, HUB_URL: "http://phones.example.com" }), /https/);
  assert.throws(() => readAgentConfig({ ...base, HUB_URL: "ws://phones.example.com" }), /https/);
  assert.doesNotThrow(() => readAgentConfig({ ...base, HUB_URL: "http://localhost:4173" }));
  assert.doesNotThrow(() => readAgentConfig({ ...base, HUB_URL: "http://127.0.0.1:4173" }));
  assert.doesNotThrow(() => readAgentConfig({ ...base, HUB_URL: "http://10.0.0.5:4173", ALLOW_INSECURE_HUB: "true" }), "explicit opt-in for a private network");
});

test("a hub address that is not a URL is rejected", () => {
  assert.throws(() => readAgentConfig({ ...base, HUB_URL: "phones.example.com" }), /must start with/);
});
