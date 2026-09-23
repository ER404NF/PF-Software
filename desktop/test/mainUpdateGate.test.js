const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMain } = require("./helpers/mainHarness");

test("a packaged app cannot create a window when the release gate denies startup", async t => {
  let checks = 0;
  const app = loadMain({
    isPackaged: true,
    autoUpdate: {
      enforceReleaseVersion: async ({ app: electronApp }) => {
        checks += 1;
        electronApp.quit();
        return { allowed: false, status: "declined" };
      },
    },
  });
  t.after(() => app.cleanup());
  await app.until(() => checks === 1, { what: "version gate" });
  assert.equal(app.windows.length, 0);
  assert.equal(app.spawned.length, 0);
  assert.equal(app.quitCalls.length, 1);

  app.appEvents.get("activate")();
  app.appEvents.get("second-instance")();
  await app.wait(10);
  assert.equal(app.windows.length, 0, "lifecycle events cannot bypass a denied update gate");
});
