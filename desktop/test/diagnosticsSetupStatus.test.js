"use strict";

// Copy Diagnostics says whether automatic phone setup is running or paused and why, and names the record file and its folder
// inside Bodun's own storage (never a full path), and whether the desktop's own process record is intact.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildDiagnosticsReport, describeAutomaticSetup, readSetupStatusFile } = require("../diagnostics.js");

const paused = {
  state: "paused", code: "setup_paused_record_damaged",
  message: "Automatic phone setup is paused. The record of Bodun's earlier phone connections is damaged. Quit Bodun and open it again. Bodun will then offer to move the damaged record aside.",
  recordFile: "process-ownership.json", folder: "host-storage", pid: 4100, writtenAt: "2026-10-07T09:30:00.000Z",
};

test("a paused setup is described with its code, its plain message and the record file and folder, never a full path", () => {
  const lines = describeAutomaticSetup({ ...paused, current: true }).join("\n");
  assert.match(lines, /Automatic phone setup: paused \(setup_paused_record_damaged\)/);
  assert.match(lines, /damaged/);
  assert.match(lines, /Record file: process-ownership\.json, in the folder host-storage/);
  assert.match(lines, /reported by the running Bodun server/);
  assert.doesNotMatch(lines, /[A-Za-z]:\|\/Users\//);
});

test("a status from a server that is no longer running is labelled as the last report", () => {
  const lines = describeAutomaticSetup({ ...paused, current: false }).join("\n");
  assert.match(lines, /last reported at 2026-10-07T09:30:00\.000Z; the server is not running/);
});

test("with no status the report says so plainly", () => {
  assert.match(describeAutomaticSetup(null).join("\n"), /no report yet/);
});

test("the report carries the status and the desktop record's health, and still hides secrets", () => {
  const report = buildDiagnosticsReport({
    appVersion: "0.3.1", mode: "host", serverState: "running",
    automaticSetup: { ...paused, current: true }, processRecords: "moved aside",
    config: { sessionSecret: "SHOULD-NOT-APPEAR-123456" }, logLines: [], logFile: "/x/log",
  });
  assert.match(report, /Automatic phone setup: paused/);
  assert.match(report, /Process record of Bodun's own server and site agent: moved aside/);
  assert.doesNotMatch(report, /SHOULD-NOT-APPEAR/);
});

test("the status file is read only for the fields that belong in a report, and a broken file is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-status-"));
  const file = path.join(dir, "automatic-setup-status.json");
  assert.equal(readSetupStatusFile(file, [4100]), null, "no file");
  fs.writeFileSync(file, JSON.stringify({ ...paused, secret: "NOT-A-FIELD" }));
  const read = readSetupStatusFile(file, [4100]);
  assert.equal(read.current, true);
  assert.equal(read.secret, undefined);
  assert.equal(readSetupStatusFile(file, [999]).current, false, "written by a process that is not running");
  assert.equal(readSetupStatusFile(file, []).current, false);
  fs.writeFileSync(file, "{broken");
  assert.equal(readSetupStatusFile(file, [4100]), null);
  fs.writeFileSync(file, JSON.stringify({ state: 5 }));
  assert.equal(readSetupStatusFile(file, [4100]), null, "wrong shape");
  fs.rmSync(dir, { recursive: true, force: true });
});
