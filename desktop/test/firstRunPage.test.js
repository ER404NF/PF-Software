// The setup page's own logic, run without a browser: the "Fix it" button must never leave a row stuck.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rawHtml = fs.readFileSync(path.join(__dirname, "..", "first-run.html"), "utf8");

// The page's own function, cut out by matching braces (not by a pattern that assumes a line-ending style: a Windows
// checkout gives the file CRLF line endings, which broke an earlier version of this test on Windows CI).
function extractFunction(html, name) {
  const source = html.replace(/\r\n?/g, "\n");
  const start = source.search(new RegExp(`(?:async )?function ${name}\\b`));
  if (start < 0) return null;
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

const source = extractFunction(rawHtml, "runFix");

function buildRunFix(api) {
  assert.ok(source, "runFix is in the page");
  return new Function("window", `${source}\nreturn runFix;`)({ desktopApi: api });
}

test("the function is found whatever line endings the checkout used (LF, CRLF or old-Mac CR)", () => {
  const lf = rawHtml.replace(/\r\n?/g, "\n");
  for (const variant of [lf, lf.replace(/\n/g, "\r\n"), lf.replace(/\n/g, "\r")]) {
    const found = extractFunction(variant, "runFix");
    assert.ok(found, "runFix is found");
    assert.match(found, /^async function runFix\(id, buttons, progressEl, afterFix\) \{/);
    assert.match(found, /\}$/);
    assert.equal(found, source, "the same function text regardless of line endings");
  }
  assert.equal(extractFunction(lf, "notInThePage"), null);
});

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
