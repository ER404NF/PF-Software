import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSiteRepository } from "../../src/persistence/siteRepository.js";
import { createFileSiteRepository } from "../../src/persistence/fileSiteRepository.js";

test("site repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertSiteRepository(null), /must be an object/);
  assert.throws(() => assertSiteRepository({}), /requires list/);
  assert.throws(() => assertSiteRepository({ list() {}, get() {}, create() {}, rotate() {}, update() {},
    remove() {}, verifyToken() {} }), /requires markSeen/);
});

test("file site adapter satisfies the contract and preserves SiteStore behavior", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-site-adapter-"));
  const filePath = path.join(directory, "sites.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = createFileSiteRepository(filePath, { defaultTimeZone: "America/Los_Angeles" });
  assertSiteRepository(repository);

  const { site, token } = repository.create({ name: "Downtown Office" });
  assert.equal(site.id, "downtown-office");
  assert.equal(site.timeZone, "America/Los_Angeles");
  assert.equal(site.tokenHash, undefined, "public view never includes the token hash");
  assert.match(token, /^pfs_/);

  assert.deepEqual(repository.list().map((entry) => entry.id), ["downtown-office"]);
  assert.equal(repository.get("downtown-office")?.name, "Downtown Office");

  const verified = repository.verifyToken("downtown-office", token);
  assert.equal(verified?.id, "downtown-office");
  assert.equal(repository.verifyToken("downtown-office", "pfs_wrong"), null);

  repository.markSeen("downtown-office", "2026-09-25T00:00:00.000Z");
  assert.equal(repository.get("downtown-office").lastSeenAt, "2026-09-25T00:00:00.000Z");

  const updated = repository.update("downtown-office", { name: "Uptown Office" });
  assert.equal(updated.name, "Uptown Office");

  const rotated = repository.rotate("downtown-office");
  assert.notEqual(rotated.token, token);
  assert.equal(repository.verifyToken("downtown-office", token), null, "old token is invalid after rotation");
  assert.equal(repository.verifyToken("downtown-office", rotated.token)?.id, "downtown-office");

  assert.equal(repository.remove("downtown-office"), true);
  assert.equal(repository.get("downtown-office"), null);

  // Persisted to the real file, so a fresh adapter over the same path sees prior writes.
  repository.create({ name: "Second Site" });
  const reopened = createFileSiteRepository(filePath, { defaultTimeZone: "America/Los_Angeles" });
  assert.deepEqual(reopened.list().map((entry) => entry.id), ["second-site"]);
});

test("file site adapter can wrap an already-constructed store for injection", async () => {
  const { SiteStore } = await import("../../src/siteStore.js");
  const store = new SiteStore(null); // no filePath: in-memory only, matches how tests inject stores elsewhere
  const repository = createFileSiteRepository(store);
  assertSiteRepository(repository);
  repository.create({ name: "Injected Site" });
  assert.deepEqual(repository.list().map((entry) => entry.id), ["injected-site"]);
});
