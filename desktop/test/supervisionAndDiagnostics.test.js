const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { createRestartPolicy, findFreePort, isPortFree } = require("../serverSupervisor");
const { buildDiagnosticsReport, createLogger, describeConfig, redact } = require("../diagnostics");

// ---- restart policy -------------------------------------------------------------------------------

test("restarts back off, then stop: a server that keeps dying is reported, not restarted forever", () => {
  let clock = 0;
  const policy = createRestartPolicy({ maxRestarts: 4, baseDelayMs: 1000, maxDelayMs: 5000, windowMs: 60_000, now: () => clock });
  assert.deepEqual([policy.next(), policy.next(), policy.next(), policy.next()], [1000, 2000, 4000, 5000]);
  assert.equal(policy.next(), null);
  assert.equal(policy.recentRestarts(), 4);
});

test("a server that has been stable for a while gets a fresh allowance", () => {
  let clock = 0;
  const policy = createRestartPolicy({ maxRestarts: 2, windowMs: 60_000, now: () => clock });
  assert.notEqual(policy.next(), null);
  assert.notEqual(policy.next(), null);
  assert.equal(policy.next(), null);
  clock = 61_000;
  assert.equal(policy.next(), 1000, "old crashes have aged out of the window");
});

test("reset forgets earlier crashes", () => {
  const policy = createRestartPolicy({ maxRestarts: 1 });
  policy.next();
  assert.equal(policy.next(), null);
  policy.reset();
  assert.equal(policy.next(), 1000);
});

// ---- redaction ------------------------------------------------------------------------------------

test("known secret shapes are removed from anything that is logged or reported", () => {
  const token = "pfs_" + "a1B2c3D4e5F6g7H8";
  const hex = "0123456789abcdef".repeat(4);
  assert.equal(redact(`linked with ${token}`), "linked with pfs_[hidden]");
  assert.equal(redact("Authorization: Bearer abcdefghijklmnop123456"), "Authorization: Bearer [hidden]");
  assert.equal(redact('{"sessionSecret":"topsecretvalue1"}'), '{"sessionSecret":"[hidden]"}');
  assert.equal(redact("password=hunter2hunter2"), "password=[hidden]");
  assert.equal(redact(`key ${hex}`), "key [hidden]");
  assert.equal(redact("port 4173 started in 320 ms"), "port 4173 started in 320 ms", "ordinary lines are untouched");
});

// ---- log file -------------------------------------------------------------------------------------

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-log-"));
}

test("the logger writes owner-only lines, never a secret, and can return the recent tail", () => {
  const dir = tempDir();
  try {
    const logger = createLogger({ dir, now: () => new Date("2026-09-19T05:00:00Z") });
    logger.info("server running on port 4173");
    logger.error("linking failed for pfs_ABCDEFGH12345678");
    const text = fs.readFileSync(logger.file, "utf8");
    assert.match(text, /^2026-09-19T05:00:00\.000Z INFO  server running on port 4173$/m);
    assert.match(text, /ERROR linking failed for pfs_\[hidden\]/);
    assert.doesNotMatch(text, /ABCDEFGH12345678/);
    assert.deepEqual(logger.tail(1), [text.trim().split("\n").at(-1)]);
    if (process.platform !== "win32") assert.equal(fs.statSync(logger.file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the log rotates instead of growing forever", () => {
  const dir = tempDir();
  try {
    const logger = createLogger({ dir, maxBytes: 300, keep: 2 });
    for (let index = 0; index < 40; index += 1) logger.info(`line number ${index} with some padding to grow the file`);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ["phone-farm.log", "phone-farm.log.1"]);
    assert.ok(fs.statSync(path.join(dir, "phone-farm.log")).size < 600);
    assert.match(logger.tail(1)[0], /line number 39/, "the newest line is in the current file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("logging never throws, even when the folder cannot be created", () => {
  const dir = tempDir();
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  try {
    const logger = createLogger({ dir: path.join(blocker, "nested") });
    assert.doesNotThrow(() => { logger.info("hello"); logger.error("boom"); });
    assert.deepEqual(logger.tail(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- report ---------------------------------------------------------------------------------------

test("the diagnostics report says what is wrong and where, and contains no secret values", () => {
  const report = buildDiagnosticsReport({
    appVersion: "0.1.0", electronVersion: "44.4.2", nodeVersion: "24.1.0", mode: "host",
    preflight: { checks: [
      { id: "xcode", label: "Xcode", ok: true, message: "Ready" },
      { id: "iproxy", label: "iproxy", ok: false, message: "Install libusbmuxd" },
      { id: "tun2proxy", label: "tun2proxy", ok: false, optional: true, message: "not used" },
    ] },
    config: { mode: "host", sessionSecret: "SHOULD-NOT-APPEAR-123456", twoFactorMasterKey: "ALSO-SECRET-654321", siteToken: "pfs_SECRETSECRETSECRET", port: 4173 },
    wda: { source: "managed", path: "/Users/x/Library/Application Support/Phone Farm/wda-source/16.12.1/WebDriverAgent" },
    tools: { iproxy: null, xcodebuild: "/usr/bin/xcodebuild" },
    serverState: "running", agentState: null,
    logLines: ["2026-09-19 INFO started", "2026-09-19 WARN retry with token=abcdef123456789"], logFile: "/Users/x/Library/Logs/Phone Farm/phone-farm.log",
    platform: "darwin", arch: "arm64", osRelease: "24.0.0", now: new Date("2026-09-19T05:00:00Z"),
  });
  assert.match(report, /App version: 0\.1\.0 \(Electron 44\.4\.2, Node 24\.1\.0\)/);
  assert.match(report, /\[PROBLEM\] iproxy: Install libusbmuxd/);
  assert.match(report, /\[n\/a\] tun2proxy/);
  assert.match(report, /iproxy: not found/);
  assert.match(report, /managed at \/Users\/x\/Library\/Application Support\/Phone Farm\/wda-source/);
  assert.match(report, /Saved settings: mode, port, sessionSecret, siteToken, twoFactorMasterKey/);
  for (const secret of ["SHOULD-NOT-APPEAR", "ALSO-SECRET", "SECRETSECRET", "abcdef123456789"]) assert.doesNotMatch(report, new RegExp(secret));
});

test("settings are described by name only", () => {
  assert.equal(describeConfig(null), "none saved yet");
  assert.equal(describeConfig({}), "empty");
  assert.equal(describeConfig({ b: 1, a: 2, c: undefined }), "a, b");
});

// ---- free port ------------------------------------------------------------------------------------

test("the usual port is used when it is free, and the next free one when it is not", async () => {
  assert.equal(await findFreePort(4173, { isFree: async () => true }), 4173);
  const taken = new Set([4173, 4174]);
  assert.equal(await findFreePort(4173, { isFree: async port => !taken.has(port) }), 4175);
  await assert.rejects(findFreePort(4173, { tries: 3, isFree: async () => false }), /No free port was found between 4173 and 4175/);
});

test("a port that something is really listening on is reported busy", async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    assert.equal(await isPortFree(port), false);
    const next = await findFreePort(port);
    assert.notEqual(next, port);
    assert.equal(await isPortFree(next), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(await isPortFree(port), true, "free again once released");
});
