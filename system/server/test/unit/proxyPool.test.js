import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createProxy, deleteProxy, assignProxyToDevice, proxyForDevice,
  publicProxy, publicProxies, decryptProxyPassword, flagForCountry, loadProxyRecords,
} from "../../src/proxyPool.js";

const MASTER_KEY = "a".repeat(32);

function tempStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-proxypool-")), "proxy-pool.json");
}

function sampleFields(overrides = {}) {
  return {
    provider: "Oxylabs", protocol: "socks5", host: "proxy.example.com", port: 7000,
    username: "user1", password: "s3cret-pass", country: "us", label: "US pool 1",
    ...overrides,
  };
}

test("flagForCountry derives a regional-indicator emoji from a 2-letter code", () => {
  assert.equal(flagForCountry("US"), "🇺🇸");
  assert.equal(flagForCountry("gb"), null); // must already be uppercase — caller normalizes on write
  assert.equal(flagForCountry("USA"), null);
  assert.equal(flagForCountry(""), null);
});

test("createProxy persists a record and encrypts the password at rest", () => {
  const storePath = tempStorePath();
  const record = createProxy(storePath, sampleFields(), MASTER_KEY);
  assert.match(record.id, /^px_/);
  assert.equal(record.country, "US"); // normalized to uppercase
  assert.equal(record.leasedToDeviceId, null);
  assert.notEqual(record.passwordEncrypted, "s3cret-pass");
  assert.equal(decryptProxyPassword(record, MASTER_KEY), "s3cret-pass");

  const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.ok(!JSON.stringify(onDisk).includes("s3cret-pass"), "plaintext password must never hit disk");
});

test("createProxy defaults the label from provider + country when omitted", () => {
  const storePath = tempStorePath();
  const record = createProxy(storePath, sampleFields({ label: undefined }), MASTER_KEY);
  assert.equal(record.label, "Oxylabs US");
});

test("createProxy rejects invalid fields", () => {
  const storePath = tempStorePath();
  assert.throws(() => createProxy(storePath, sampleFields({ protocol: "ftp" }), MASTER_KEY), /protocol must be one of/);
  assert.throws(() => createProxy(storePath, sampleFields({ port: 0 }), MASTER_KEY), /port must be/);
  assert.throws(() => createProxy(storePath, sampleFields({ country: "USA" }), MASTER_KEY), /2-letter ISO code/);
  assert.throws(() => createProxy(storePath, sampleFields({ provider: "" }), MASTER_KEY), /provider is required/);
});

test("createProxy requires a password instead of persisting an unusable credential", () => {
  const storePath = tempStorePath();
  assert.throws(() => createProxy(storePath, sampleFields({ password: "" }), MASTER_KEY), /password is required/);
});

test("publicProxy never exposes host, port, username, or password", () => {
  const storePath = tempStorePath();
  const record = createProxy(storePath, sampleFields(), MASTER_KEY);
  const pub = publicProxy(record);
  assert.deepEqual(Object.keys(pub).sort(), ["country", "createdAt", "flag", "health", "id", "label", "leasedToDeviceId", "protocol", "provider", "updatedAt"]);
  assert.equal(pub.flag, "🇺🇸");
});

test("publicProxies lists every proxy sorted by label", () => {
  const storePath = tempStorePath();
  createProxy(storePath, sampleFields({ label: "Zulu" }), MASTER_KEY);
  createProxy(storePath, sampleFields({ label: "Alpha" }), MASTER_KEY);
  const labels = publicProxies(storePath).map(p => p.label);
  assert.deepEqual(labels, ["Alpha", "Zulu"]);
});

test("assignProxyToDevice leases a proxy and blocks it from a second device", () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, sampleFields(), MASTER_KEY);
  const leased = assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  assert.equal(leased.leasedToDeviceId, "mock-1");
  assert.equal(proxyForDevice(storePath, "mock-1").id, proxy.id);

  assert.throws(
    () => assignProxyToDevice(storePath, { deviceId: "mock-2", proxyId: proxy.id }),
    /already assigned to another device/
  );
});

test("assignProxyToDevice re-leasing the same device to the same proxy is a no-op success", () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, sampleFields(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const again = assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  assert.equal(again.leasedToDeviceId, "mock-1");
});

test("assignProxyToDevice with proxyId null releases the device's current lease", () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, sampleFields(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const released = assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: null });
  assert.equal(released, null);
  assert.equal(proxyForDevice(storePath, "mock-1"), null);
  assert.equal(loadProxyRecords(storePath)[proxy.id].leasedToDeviceId, null);
});

test("assignProxyToDevice switches a device from one proxy to another, freeing the old one", () => {
  const storePath = tempStorePath();
  const a = createProxy(storePath, sampleFields({ label: "A" }), MASTER_KEY);
  const b = createProxy(storePath, sampleFields({ label: "B" }), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: a.id });
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: b.id });
  assert.equal(loadProxyRecords(storePath)[a.id].leasedToDeviceId, null);
  assert.equal(loadProxyRecords(storePath)[b.id].leasedToDeviceId, "mock-1");
});

test("assignProxyToDevice rejects an unknown proxy id", () => {
  const storePath = tempStorePath();
  assert.throws(() => assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: "px_nope" }), /unknown proxy/);
});

test("deleteProxy refuses to delete a leased proxy, and reports absence for an unknown one", () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, sampleFields(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  assert.throws(() => deleteProxy(storePath, proxy.id), /release this proxy/);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: null });
  assert.equal(deleteProxy(storePath, proxy.id), true);
  assert.equal(deleteProxy(storePath, proxy.id), false);
});

test("a corrupt store surfaces an explicit error instead of silently resetting", () => {
  const storePath = tempStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({ proxies: ["not-an-object"] }));
  assert.throws(() => loadProxyRecords(storePath), /corrupt/);
});
