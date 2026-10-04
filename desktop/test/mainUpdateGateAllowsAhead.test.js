const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMain } = require("./helpers/mainHarness");

test("a packaged build newer than the latest release opens normally", async t => {
  let checks = 0;
  const app = loadMain({
    isPackaged: true,
    version: "0.2.4",
    autoUpdate: {
      enforceReleaseVersion: async () => {
        checks += 1;
        return { allowed: true, status: "ahead", version: "0.2.4", availableVersion: "0.2.2" };
      },
    },
  });
  t.after(() => app.cleanup());

  await app.until(() => app.windows.length === 1, { what: "the first-run window" });
  assert.equal(checks, 1);
  assert.match(app.windows[0].file, /first-run\.html$/);
  assert.equal(app.quitCalls.length, 0);
});
