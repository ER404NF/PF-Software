// Automatic phone setup reports its status three ways without needing a page: one plain log line per change (the site agent
// has no page), and a small status file in Bodun's own storage that the desktop app reads for Copy Diagnostics. The file names
// the record file and its folder, never a full path, and is removed when setup stops cleanly.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAutoProvisioning } from "../../src/provisioningBoot.js";
import { STATUS_FILE_NAME, statusFilePathFor, writeStatusFile } from "../../src/automaticSetupStatusFile.js";
import { buildSetupStatus } from "../../src/setupStatus.js";

function boot({ storage, createProvisioner } = {}) {
  const folder = storage ?? fs.mkdtempSync(path.join(os.tmpdir(), "host-storage-"));
  const env = {
    AUTO_PROVISION_WDA: "true", PROCESS_OWNERSHIP_PATH: path.join(folder, "process-ownership.json"),
    DEVICE_PROVISIONING_STORE_PATH: path.join(folder, "device-provisioning.json"),
  };
  const seen = {};
  const deps = {
    runPreflight: () => ({ ok: true, checks: [] }), discover: () => [],
    createWdaManager: () => ({}), createIproxyManager: () => ({}),
    createProvisioner: createProvisioner ?? (options => {
      seen.options = options;
      return { start() {}, async stop() { seen.stopped = true; } };
    }),
  };
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  let provisioner;
  try { provisioner = startAutoProvisioning({ env, devices: new Map(), manualUdids: new Set(), deps }); } finally { console.log = original; }
  return { folder, provisioner, seen, lines, file: path.join(folder, STATUS_FILE_NAME), env };
}

function report(seen, code) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try { seen.options.onSetupStatusChanged(buildSetupStatus(code)); } finally { console.log = original; }
  return lines;
}

test("the status file lives next to the ownership record", () => {
  assert.equal(statusFilePathFor("/a/host-storage/process-ownership.json"), path.join("/a/host-storage", STATUS_FILE_NAME));
});

test("each change writes the status file, naming the record file and its folder but never a full path", () => {
  const { folder, seen, file } = boot();
  report(seen, "setup_paused_record_damaged");
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.state, "paused");
  assert.equal(written.code, "setup_paused_record_damaged");
  assert.match(written.message, /damaged/);
  assert.equal(written.recordFile, "process-ownership.json");
  assert.equal(written.folder, path.basename(folder));
  assert.equal(written.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(written.writtenAt)));
  assert.ok(!JSON.stringify(written).includes(folder), "the full path is not in the file");
  assert.deepEqual(Object.keys(written).sort(), ["code", "folder", "message", "pid", "recordFile", "state", "writtenAt"]);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a later status replaces the earlier one", () => {
  const { folder, seen, file } = boot();
  report(seen, "setup_checking");
  report(seen, "setup_running");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).code, "setup_running");
  assert.deepEqual(fs.readdirSync(folder).filter(name => name.endsWith(".tmp")), [], "no temporary file is left");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("every change is one plain log line without a path", () => {
  const { folder, seen } = boot();
  const lines = report(seen, "setup_paused_cannot_check");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[setup\] Automatic phone setup is paused/);
  assert.doesNotMatch(lines[0], /[\\/]/);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a clean stop removes the status file, and the real stop still runs", async () => {
  const { folder, provisioner, seen, file } = boot();
  report(seen, "setup_running");
  assert.ok(fs.existsSync(file));
  await provisioner.stop();
  assert.equal(seen.stopped, true);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a provisioner without a stop is still accepted", () => {
  const { folder, provisioner } = boot({ createProvisioner: () => ({ start() {} }) });
  assert.ok(provisioner);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a status file that cannot be written never breaks setup", () => {
  const { folder, seen } = boot();
  fs.rmSync(folder, { recursive: true, force: true });
  fs.writeFileSync(folder, "a file where the folder should be");
  assert.doesNotThrow(() => report(seen, "setup_running"));
  fs.rmSync(folder, { force: true });
});

test("writeStatusFile alone: the same shape, atomically", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "host-storage-"));
  writeStatusFile({ ownershipPath: path.join(folder, "process-ownership.json"), status: buildSetupStatus("setup_off"), pid: 77, now: () => Date.UTC(2026, 9, 7) });
  const written = JSON.parse(fs.readFileSync(path.join(folder, STATUS_FILE_NAME), "utf8"));
  assert.equal(written.pid, 77);
  assert.equal(written.writtenAt, "2026-10-07T00:00:00.000Z");
  fs.rmSync(folder, { recursive: true, force: true });
});
