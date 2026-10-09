import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProcessInspector,
  parseLsofListeners,
  parsePsCommand,
  parsePsComm,
  parsePsStat,
} from "../../src/processInspector.js";

test("lsof output: one listener, two listeners, IPv6, and none", () => {
  assert.deepEqual(parseLsofListeners("p4121\ncproxy-tool\nn*:8101\n"), [{ pid: 4121 }]);
  assert.deepEqual(parseLsofListeners("p4121\ncA\nn127.0.0.1:8101\np88\ncB\nn[::1]:8101\n"), [{ pid: 4121 }, { pid: 88 }]);
  assert.deepEqual(parseLsofListeners("p4121\nn*:8101\np4121\nn[::]:8101\n"), [{ pid: 4121 }], "the same pid is listed once");
  assert.deepEqual(parseLsofListeners(""), []);
  assert.deepEqual(parseLsofListeners(null), []);
});

test("ps start/parent fields", () => {
  assert.deepEqual(parsePsStat("    1   742 Tue Oct  6 20:20:28 2026\n"), { ppid: 1, pgid: 742, startTime: "Tue Oct 6 20:20:28 2026" });
  assert.equal(parsePsStat(""), null);
  assert.equal(parsePsStat("garbage"), null);
});

test("program name keeps spaces and drops the directory", () => {
  assert.equal(parsePsComm("/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper\n"), "Google Chrome Helper");
  assert.equal(parsePsComm("/opt/homebrew/bin/iproxy\n"), "iproxy");
  assert.equal(parsePsComm("iproxy\n"), "iproxy");
  assert.equal(parsePsComm("\n"), null);
});

test("the command line is kept whole, with spaces and quotes", () => {
  const line = '  /Users/Some User/bin/iproxy -u 00008110-ABC "8101:8100" 9101:9100\n';
  assert.equal(parsePsCommand(line), '/Users/Some User/bin/iproxy -u 00008110-ABC "8101:8100" 9101:9100');
  assert.equal(parsePsCommand("\n"), null);
});

function fakeExecFile(table, calls = []) {
  return (bin, args, _options, callback) => {
    calls.push([bin, ...args]);
    const key = [bin, ...args].join(" ");
    const entry = Object.entries(table).find(([pattern]) => key.startsWith(pattern));
    if (!entry) return callback(Object.assign(new Error("not found"), { code: "ENOENT" }), "", "");
    const [, value] = entry;
    if (value === null) return callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "");
    callback(null, value, "");
  };
}

test("findListeners asks lsof for exactly this port and parses the pids", async () => {
  const calls = [];
  const inspector = createProcessInspector({
    platform: "darwin",
    execFile: fakeExecFile({ "lsof -nP -iTCP:8101": "p4121\ncx\nn*:8101\n" }, calls),
  });
  assert.deepEqual(await inspector.findListeners(8101), { supported: true, listeners: [{ pid: 4121 }] });
  assert.deepEqual(calls[0], ["lsof", "-nP", "-iTCP:8101", "-sTCP:LISTEN", "-F", "pcn"]);
});

test("findProcesses resolves matching process descriptions without exposing them itself", async () => {
  const inspector = createProcessInspector({
    platform: "darwin",
    execFile: fakeExecFile({
      "pgrep -x xcodebuild": "4121\n",
      "ps -ww -o ppid=,pgid=,lstart= -p 4121": "1 4121 Tue Oct  6 20:20:28 2026\n",
      "ps -o comm= -p 4121": "/usr/bin/xcodebuild\n",
      "ps -ww -o command= -p 4121": "/usr/bin/xcodebuild -scheme WebDriverAgentRunner -destination id=PRIVATE\n",
    }),
  });
  const found = await inspector.findProcesses("xcodebuild");
  assert.equal(found.supported, true);
  assert.equal(found.processes.length, 1);
  assert.equal(found.processes[0].program, "xcodebuild");
});

test("findListeners: lsof exits 1 with nothing printed means nobody is listening", async () => {
  const inspector = createProcessInspector({ platform: "darwin", execFile: fakeExecFile({ "lsof": null }) });
  assert.deepEqual(await inspector.findListeners(8101), { supported: true, listeners: [] });
});

test("findListeners rejects a bad port before running anything", async () => {
  const calls = [];
  const inspector = createProcessInspector({ platform: "darwin", execFile: fakeExecFile({}, calls) });
  await assert.rejects(() => inspector.findListeners(0), /valid port/);
  await assert.rejects(() => inspector.findListeners("8101; rm -rf /"), /valid port/);
  assert.equal(calls.length, 0);
});

test("describe uses three separate ps calls and returns the whole command", async () => {
  const calls = [];
  const inspector = createProcessInspector({
    platform: "darwin",
    execFile: fakeExecFile({
      "ps -ww -o ppid=,pgid=,lstart= -p 4121": "    1  4121 Tue Oct  6 20:20:28 2026\n",
      "ps -o comm= -p 4121": "/opt/homebrew/bin/iproxy\n",
      "ps -ww -o command= -p 4121": "/opt/homebrew/bin/iproxy -u UDID-1 8101:8100\n",
    }, calls),
  });
  assert.deepEqual(await inspector.describe(4121), {
    pid: 4121, ppid: 1, pgid: 4121, startTime: "Tue Oct 6 20:20:28 2026",
    program: "iproxy", command: "/opt/homebrew/bin/iproxy -u UDID-1 8101:8100",
  });
  assert.equal(calls.length, 3);
});

test("describe returns null when the process has vanished", async () => {
  const inspector = createProcessInspector({ platform: "darwin", execFile: fakeExecFile({ "ps": null }) });
  assert.equal(await inspector.describe(4121), null);
});

test("describe returns undefined when ps times out or cannot be executed", async () => {
  for (const code of ["ETIMEDOUT", "EACCES", "ENOENT"]) {
    const inspector = createProcessInspector({
      platform: "darwin",
      execFile: (_bin, _args, _options, callback) => callback(Object.assign(new Error("inspection failed"), { code }), "", ""),
    });
    assert.equal(await inspector.describe(4121), undefined, code);
  }
  const permissionDenied = createProcessInspector({
    platform: "darwin",
    execFile: (_bin, _args, _options, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "permission denied"),
  });
  assert.equal(await permissionDenied.describe(4121), undefined);
});

test("describe refuses anything that is not a positive integer pid", async () => {
  const calls = [];
  const inspector = createProcessInspector({ platform: "darwin", execFile: fakeExecFile({}, calls) });
  for (const pid of [0, -1, 1.5, "12", null, undefined, NaN]) assert.equal(await inspector.describe(pid), null);
  assert.equal(calls.length, 0);
});

test("isAlive is a ps lookup, never a signal", async () => {
  const calls = [];
  const inspector = createProcessInspector({
    platform: "darwin",
    execFile: fakeExecFile({ "ps -p 4121 -o pid=": "  4121\n", "ps -p 99 -o pid=": null }, calls),
  });
  assert.equal(await inspector.isAlive(4121), true);
  assert.equal(await inspector.isAlive(99), false);
  assert.ok(calls.every(call => call[0] === "ps"));
});

test("on a platform without lsof/ps the inspector says unsupported and runs nothing", async () => {
  const calls = [];
  const inspector = createProcessInspector({ platform: "win32", execFile: fakeExecFile({}, calls) });
  assert.equal(inspector.supported, false);
  assert.deepEqual(await inspector.findListeners(8101), { supported: false, listeners: [] });
  assert.equal(await inspector.describe(4121), undefined);
  assert.equal(await inspector.isAlive(4121), undefined);
  assert.equal(calls.length, 0);
});

test("a missing lsof binary is reported as unsupported, not as 'nobody listens'", async () => {
  const inspector = createProcessInspector({ platform: "darwin", execFile: fakeExecFile({}) });
  assert.deepEqual(await inspector.findListeners(8101), { supported: false, listeners: [] });
});

test("an lsof execution failure is unavailable, not an empty listener list", async () => {
  const inspector = createProcessInspector({
    platform: "darwin",
    execFile: (_bin, _args, _options, callback) => callback(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), "", ""),
  });
  assert.deepEqual(await inspector.findListeners(8101), { supported: false, listeners: [] });
});
