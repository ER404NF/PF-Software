// The real main.js, driven against a stand-in for Electron: the "Move Aside Damaged Process Records" menu action and Copy
// Diagnostics. Bodun is in site mode with no usable saved settings, so no server or agent runs and the action is allowed;
// the module test (damagedRecords.test.js) covers the refusal while one runs, and damagedRecordsLaunch.test.js covers the
// same check at launch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadMain } = require("./helpers/mainHarness.js");

const app = loadMain({
  prepare: ({ userData }) => {
    fs.mkdirSync(path.join(userData, "host-storage"), { recursive: true });
    fs.writeFileSync(path.join(userData, "desktop-config.json"), JSON.stringify({ mode: "site" }));
  },
});
const { handlers, menus, shown, clipboardWrites, relaunchCalls, quitCalls, userData, trusted, until, dialogResponses } = app;
const storage = path.join(userData, "host-storage");
const childrenFile = path.join(storage, "desktop-children.json");
const ownershipFile = path.join(storage, "process-ownership.json");
const statusFile = path.join(storage, "automatic-setup-status.json");

test.before(() => until(() => menus.length > 0 && app.windows.length > 0, { what: "the menu and the setup window" }));
test.after(() => app.cleanup());

const menuItem = () => menus.at(-1).find(item => item.label === "Bodun").submenu.find(item => item.label === "Move Aside Damaged Process Records…");
const copies = () => fs.readdirSync(storage).filter(name => name.includes(".damaged-"));

// Clicks the item and waits for the dialogs this click is going to show (`expected`).
async function click(expected, ...responses) {
  const before = shown.length;
  dialogResponses.push(...responses);
  menuItem().click();
  await until(() => shown.length - before >= expected, { what: `${expected} dialog(s)` });
  await app.wait(50);
  return shown.slice(before);
}

async function diagnostics() {
  assert.deepEqual(await handlers.get("desktop:copy-diagnostics")(trusted()), { ok: true });
  return clipboardWrites.at(-1);
}

test("the menu item is there on a site Mac", () => {
  assert.ok(menuItem(), "the Bodun menu has Move Aside Damaged Process Records…");
});

test("with nothing damaged it says so and changes nothing", async () => {
  fs.writeFileSync(childrenFile, JSON.stringify({ version: 1, children: {} }));
  fs.writeFileSync(ownershipFile, JSON.stringify({ version: 1, processes: {} }));
  const dialogs = await click(1);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /No damaged process records were found/);
  assert.deepEqual(copies(), []);
  assert.equal(fs.existsSync(childrenFile), true);
});

test("Copy Diagnostics reports a damaged record and the setup status, with names and folders but no full path", async () => {
  fs.writeFileSync(childrenFile, "{\"version\":1,\"chil");
  fs.writeFileSync(statusFile, JSON.stringify({
    state: "paused", code: "setup_paused_cannot_check", message: "Automatic phone setup is paused. Bodun could not check its earlier phone connections.",
    recordFile: "process-ownership.json", folder: "host-storage", pid: 424242, writtenAt: "2026-10-07T09:30:00.000Z",
  }));
  const report = await diagnostics();
  assert.match(report, /Automatic phone setup: paused \(setup_paused_cannot_check\)/);
  assert.match(report, /Record file: process-ownership\.json, in the folder host-storage/);
  assert.match(report, /last reported at 2026-10-07T09:30:00\.000Z; the server is not running/);
  assert.match(report, /Process record of Bodun's own server and site agent: damaged/);
  assert.ok(!report.includes(storage), "the storage path is not in the report");
});

test("a damaged record is moved only after a confirmation that defaults to Cancel; Cancel leaves every byte where it was", async () => {
  const dialogs = await click(1); // nothing queued: the stand-in answers Cancel
  assert.equal(dialogs.length, 1);
  assert.deepEqual([...dialogs[0].buttons], ["Cancel", "Move aside"]);
  assert.equal(dialogs[0].defaultId, 0);
  assert.match(dialogs[0].detail, /Nothing is deleted/);
  assert.equal(fs.readFileSync(childrenFile, "utf8"), "{\"version\":1,\"chil");
  assert.deepEqual(copies(), []);
});

test("Move aside keeps every byte in a safe copy, leaves the valid record alone, and Restart now restarts Bodun", async () => {
  const dialogs = await click(2, { response: 1 }, { response: 0 });
  assert.equal(dialogs.length, 2);
  assert.match(dialogs[1].message, /moved aside/);
  assert.deepEqual([...dialogs[1].buttons], ["Restart now", "Later"]);
  assert.equal(fs.existsSync(childrenFile), false);
  const [copy, ...others] = copies();
  assert.deepEqual(others, []);
  assert.ok(copy.startsWith("desktop-children.json.damaged-"));
  assert.equal(fs.readFileSync(path.join(storage, copy), "utf8"), "{\"version\":1,\"chil");
  assert.equal(fs.readFileSync(ownershipFile, "utf8"), JSON.stringify({ version: 1, processes: {} }), "the valid record is untouched");
  assert.equal(relaunchCalls.length, 1);
  assert.equal(quitCalls.length, 1);
});

test("choosing Later moves the record but does not restart", async () => {
  fs.writeFileSync(ownershipFile, "[]"); // a wrong shape counts as damaged too
  const restarts = relaunchCalls.length;
  const dialogs = await click(2, { response: 1 }, { response: 1 });
  assert.equal(dialogs.length, 2);
  assert.equal(fs.existsSync(ownershipFile), false);
  assert.equal(copies().filter(name => name.startsWith("process-ownership.json.damaged-")).length, 1);
  assert.equal(relaunchCalls.length, restarts);
});

test("Copy Diagnostics says plainly when the record is fine and when there is no status yet", async () => {
  fs.rmSync(statusFile, { force: true });
  const report = await diagnostics();
  assert.match(report, /Automatic phone setup: no report yet/);
  assert.match(report, /Process record of Bodun's own server and site agent: intact/);
});

test("main.js checks the records at launch before anything starts, and the action refuses while a server or agent runs", () => {
  const main = fs.readFileSync(path.join(app.desktopDir, "main.js"), "utf8");
  assert.match(main, /async function ensureNoOrphans\(\) \{\s*await checkProcessRecordsAtLaunch\(\);\s*if \(!processInfo\.supported\) return;/);
  assert.match(main, /if \(serverProcess \|\| agentProcess\) \{ await dialog\.showMessageBox\(refusalDialog\(\)\); return; \}/);
  assert.match(main, /async function checkProcessRecordsAtLaunch\(\) \{\s*try \{ childrenStore\.recover\(\); \}/, "the desktop's own record recovers through its store, so Copy Diagnostics can say it was moved aside");
  assert.match(main, /createChildrenStore\(\{[^}]*log: line => logger\.info\(`\[recovery\] \$\{line\}`\)/);
  assert.match(main, /moveAsideDamagedRecords: \(\) => \{ void moveAsideDamagedRecordsFromMenu\(\); \}/);
});

test("the damaged-record modules ship inside the installer", () => {
  const files = require("../package.json").build.files;
  for (const file of ["damagedRecords.js", "damagedRecordRecovery.js"]) assert.ok(files.includes(file), file);
});
