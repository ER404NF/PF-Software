// The same check at launch: before Bodun starts its server, a damaged record that cannot be proven stale is offered for
// moving aside. Declining leaves every byte where it was and the server does not start; nothing is ever deleted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadMain } = require("./helpers/mainHarness.js");

const DAMAGED = "{\"version\":1,\"chil";
const app = loadMain({
  // As on a Mac, where the app can look at processes; nothing is running, so there is nothing to look at.
  processInfo: { supported: true, describe: async () => null },
  prepare: ({ userData }) => {
    fs.mkdirSync(path.join(userData, "host-storage"), { recursive: true });
    fs.writeFileSync(path.join(userData, "host-storage", "desktop-children.json"), DAMAGED);
  },
});
const { handlers, shown, userData, trusted, until, spawned } = app;
const childrenFile = path.join(userData, "host-storage", "desktop-children.json");
const copies = () => fs.readdirSync(path.dirname(childrenFile)).filter(name => name.startsWith("desktop-children.json.damaged-"));

test.before(() => until(() => app.windows.length > 0, { what: "the setup window" }));
test.after(() => app.cleanup());

test("a damaged record that is not provably stale is offered for moving aside before the server starts; declining changes nothing", async () => {
  const before = shown.length;
  const result = await handlers.get("desktop:start-host-setup")(trusted()); // the stand-in answers Cancel
  const asked = shown.slice(before);
  assert.equal(asked.length, 1, "the person is asked exactly once");
  assert.deepEqual([...asked[0].buttons], ["Cancel", "Move aside"]);
  assert.equal(asked[0].defaultId, 0);
  assert.match(asked[0].detail, /Nothing is deleted/);
  assert.equal(fs.readFileSync(childrenFile, "utf8"), DAMAGED);
  assert.deepEqual(copies(), []);
  assert.equal(result.ok, false, "the server does not start on a record it cannot read");
  assert.match(result.error, /Quit Bodun and open it again/);
  assert.equal(spawned.length, 0, "no child process was started");
});

test("asking again in the same launch does not repeat the question", async () => {
  const before = shown.length;
  const result = await handlers.get("desktop:start-host-setup")(trusted());
  assert.equal(shown.length, before);
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(childrenFile, "utf8"), DAMAGED);
});
