import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertProxyPoolRepository } from "../../src/persistence/proxyPoolRepository.js";
import { createFileProxyPoolRepository } from "../../src/persistence/fileProxyPoolRepository.js";
import { decryptProxyPassword } from "../../src/proxyPool.js";

const MASTER_KEY = "test-master-key-at-least-32-characters-long";

function fields(overrides = {}) {
  return { provider: "Bright Data", protocol: "socks5", host: "proxy.example.com", port: 1080,
    username: "user1", password: "s3cret", country: "us", ...overrides };
}

test("proxy pool repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertProxyPoolRepository(null), /must be an object/);
  assert.throws(() => assertProxyPoolRepository({}), /requires load/);
  assert.throws(
    () => assertProxyPoolRepository({ load() {}, get() {}, create() {}, remove() {}, assignToDevice() {}, forDevice() {} }),
    /requires updateHealth/,
  );
});

test("file proxy pool adapter requires a storePath", () => {
  assert.throws(() => createFileProxyPoolRepository(), /requires a storePath/);
});

test("file proxy pool adapter satisfies the contract and preserves storage behavior", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-proxy-pool-adapter-"));
  const storePath = path.join(directory, "proxy-pool.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = createFileProxyPoolRepository(storePath);
  assertProxyPoolRepository(repository);

  const record = repository.create(fields(), MASTER_KEY);
  assert.equal(record.country, "US");
  assert.equal(decryptProxyPassword(record, MASTER_KEY), "s3cret");
  assert.equal(repository.publicList().length, 1);
  assert.equal(repository.get(record.id)?.id, record.id);

  const assigned = repository.assignToDevice({ deviceId: "device-1", proxyId: record.id });
  assert.equal(assigned.leasedToDeviceId, "device-1");
  assert.equal(repository.forDevice("device-1")?.id, record.id);

  const healthy = repository.updateHealth(record.id, { status: "ok", checkedAt: "2026-09-25T00:00:00.000Z" });
  assert.equal(healthy.health.status, "ok");

  repository.assignToDevice({ deviceId: "device-1", proxyId: null });
  assert.equal(repository.forDevice("device-1"), null);
  assert.equal(repository.remove(record.id), true);
  assert.equal(repository.get(record.id), null);
});
