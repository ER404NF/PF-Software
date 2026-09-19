// The setup page's own logic, run without a browser: the "Fix it" button must never leave a row stuck.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "first-run.html"), "utf8");
const source = /  async function runFix[\s\S]*?\n  }\n/.exec(html)?.[0];

function buildRunFix(api) {
  assert.ok(source, "runFix is in the page");
  return new Function("window", `${source}\nreturn runFix;`)({ desktopApi: api });
}

function harness({ result, throws = null }) {
  const events = { listening: 0, stopped: 0, fixed: 0 };
  const api = {
    onFixProgress: () => { events.listening += 1; return () => { events.stopped += 1; }; },
    fixPrerequisite: async id => { events.id = id; if (throws) throw throws; return result; },
  };
  const buttons = [{ disabled: false }, { disabled: false }];
  const progress = { textContent: "" };
  const runFix = buildRunFix(api);
  return { events, buttons, progress, run: () => runFix("ios-tools", buttons, progress, async () => { events.fixed += 1; }) };
}

test("a fix that works re-checks everything and stops listening for progress", async () => {
  const t = harness({ result: { ok: true, message: "The iPhone tools are installed." } });
  await t.run();
  assert.equal(t.events.id, "ios-tools");
  assert.equal(t.events.fixed, 1);
  assert.equal(t.events.stopped, 1);
  assert.equal(t.progress.textContent, "The iPhone tools are installed.");
});

test("a fix that fails says why and gives the buttons back", async () => {
  const t = harness({ result: { ok: false, message: "The password prompt was cancelled." } });
  await t.run();
  assert.equal(t.events.fixed, 0);
  assert.equal(t.progress.textContent, "The password prompt was cancelled.");
  assert.deepEqual(t.buttons.map(button => button.disabled), [false, false]);
  assert.equal(t.events.stopped, 1);
});

test("a fix whose request itself fails does not leave the row stuck on Working", async () => {
  const t = harness({ throws: new Error("Error invoking remote method") });
  await assert.doesNotReject(t.run());
  assert.match(t.progress.textContent, /That did not work: Error invoking remote method/);
  assert.deepEqual(t.buttons.map(button => button.disabled), [false, false]);
  assert.equal(t.events.stopped, 1);
});

test("an answer with no message still tells the person something", async () => {
  const t = harness({ result: { ok: false, error: "Unauthorized desktop setup request." } });
  await t.run();
  assert.equal(t.progress.textContent, "Unauthorized desktop setup request.");
  const empty = harness({ result: undefined });
  await empty.run();
  assert.match(empty.progress.textContent, /did not work/);
});
