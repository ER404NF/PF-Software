import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SiteStore, SiteError } from "../../src/siteStore.js";

function tempPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-sites-")), "sites.json");
}

test("creating a site returns its token exactly once and derives a safe id from the name", () => {
  const store = new SiteStore(tempPath());
  const { site, token } = store.create({ name: "Bucharest Office #2", timeZone: "Europe/Bucharest" });
  assert.equal(site.id, "bucharest-office-2");
  assert.equal(site.timeZone, "Europe/Bucharest");
  assert.match(token, /^pfs_[A-Za-z0-9_-]{40,}$/);
  assert.equal("tokenHash" in site, false, "the public view never carries the token hash");
  assert.equal("token" in store.get(site.id), false);
});

test("the default time zone is California", () => {
  const store = new SiteStore(tempPath());
  assert.equal(store.create({ name: "Los Angeles" }).site.timeZone, "America/Los_Angeles");
});

test("only the SHA-256 of the token is written to disk", () => {
  const file = tempPath();
  const store = new SiteStore(file);
  const { token } = store.create({ name: "Rome" });
  const onDisk = fs.readFileSync(file, "utf8");
  assert.equal(onDisk.includes(token), false, "the plain token must not be persisted");
  assert.match(onDisk, /"tokenHash": "[0-9a-f]{64}"/);
});

test("verifyToken accepts the right token and rejects everything else", () => {
  const store = new SiteStore(tempPath());
  const { site, token } = store.create({ name: "Rome" });
  const other = store.create({ name: "Milan" });
  assert.equal(store.verifyToken(site.id, token).id, "rome");
  assert.equal(store.verifyToken(site.id, other.token), null, "another site's token");
  assert.equal(store.verifyToken(site.id, token + "x"), null);
  assert.equal(store.verifyToken(site.id, ""), null);
  assert.equal(store.verifyToken(site.id, undefined), null);
  assert.equal(store.verifyToken("nope", token), null);
  assert.equal(store.verifyToken(site.id, "pfs_" + "A".repeat(500)), null, "absurdly long input");
});

test("rotating a token invalidates the old one at once", () => {
  const store = new SiteStore(tempPath());
  const { site, token: oldToken } = store.create({ name: "Rome" });
  const { token: newToken } = store.rotate(site.id);
  assert.equal(store.verifyToken(site.id, oldToken), null);
  assert.ok(store.verifyToken(site.id, newToken));
  assert.throws(() => store.rotate("ghost"), SiteError);
});

test("sites survive a restart, tokens keep working, and a corrupt entry is ignored", () => {
  const file = tempPath();
  const first = new SiteStore(file);
  const { token } = first.create({ name: "Rome" });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.sites.push({ id: "Bad Id!", tokenHash: "x" }, { id: "no-hash" });
  fs.writeFileSync(file, JSON.stringify(raw));
  const second = new SiteStore(file);
  assert.deepEqual(second.list().map(site => site.id), ["rome"]);
  assert.ok(second.verifyToken("rome", token));
});

test("bad input is rejected with clear errors", () => {
  const store = new SiteStore(tempPath());
  assert.throws(() => store.create({ name: "x" }), /2 to 60/);
  assert.throws(() => store.create({ name: "Valid name", id: "Not Valid" }), /lowercase/);
  assert.throws(() => store.create({ name: "Valid name", timeZone: "Mars/Olympus" }), /time zone/);
  store.create({ name: "Rome" });
  assert.throws(() => store.create({ name: "Rome" }), error => error.code === "duplicate_site");
});

test("update and remove work, and lastSeenAt is recorded", () => {
  const store = new SiteStore(tempPath());
  const { site } = store.create({ name: "Rome" });
  assert.equal(store.update(site.id, { name: "Rome Office", timeZone: "Europe/Rome" }).timeZone, "Europe/Rome");
  store.markSeen(site.id, "2026-09-19T01:00:00.000Z");
  assert.equal(store.get(site.id).lastSeenAt, "2026-09-19T01:00:00.000Z");
  assert.equal(store.remove(site.id), true);
  assert.equal(store.remove(site.id), false);
  assert.equal(store.list().length, 0);
});
