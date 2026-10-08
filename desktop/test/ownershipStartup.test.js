"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadMain } = require("./helpers/mainHarness.js");

const app = loadMain({
  processInfo: { supported: true, describe: async () => null },
  internetSharingBridges: ["bridge100"],
});

test.before(async () => { await app.wait(50); });
test.after(() => app.cleanup());

test("desktop startup refuses to launch a child when its ownership record is malformed", async () => {
  const ownershipPath = path.join(app.userData, "host-storage", "desktop-children.json");
  const damaged = "{ not json\nPRIVATE-DATA";
  fs.mkdirSync(path.dirname(ownershipPath), { recursive: true });
  fs.writeFileSync(ownershipPath, damaged);
  const before = app.spawned.length;

  const result = await app.handlers.get("desktop:start-host-setup")(app.trusted());

  assert.equal(result.ok, false);
  assert.equal(app.spawned.length, before, "no replacement server is launched");
  assert.equal(fs.readFileSync(ownershipPath, "utf8"), damaged, "the damaged record remains available for repair or quarantine");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-DATA|desktop-children\.json|phonefarm-userdata/i);
});
