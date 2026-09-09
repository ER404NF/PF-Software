import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createAuditLog } from "../../src/auditLog.js";

let tmpFile;
let auditLog;

before(() => {
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-audit-")), "events.log");
  auditLog = createAuditLog(tmpFile);
});

after(() => {
  fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
});

test("logEvent appends and listEvents returns newest first", () => {
  auditLog.logEvent({ operator: "va1", type: "device_selected", deviceId: "mock-1" });
  auditLog.logEvent({ operator: "va1", type: "action_tap", deviceId: "mock-1", detail: { x: 0.5, y: 0.5 } });
  auditLog.logEvent({ operator: "va1", type: "device_released", deviceId: "mock-1" });

  const events = auditLog.listEvents();
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.type),
    ["device_released", "action_tap", "device_selected"]
  );
  assert.ok(events.every((e) => typeof e.id === "string" && typeof e.at === "string"));
});

test("listEvents filters by operator and deviceId", () => {
  const log2 = createAuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-audit-")), "events.log"));
  log2.logEvent({ operator: "va1", type: "device_selected", deviceId: "mock-1" });
  log2.logEvent({ operator: "va2", type: "device_selected", deviceId: "mock-2" });
  log2.logEvent({ operator: "va1", type: "device_selected", deviceId: "mock-2" });

  assert.equal(log2.listEvents({ operator: "va1" }).length, 2);
  assert.equal(log2.listEvents({ deviceId: "mock-2" }).length, 2);
  assert.equal(log2.listEvents({ operator: "va1", deviceId: "mock-2" }).length, 1);
});

test("listEvents respects limit", () => {
  const log3 = createAuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-audit-")), "events.log"));
  for (let i = 0; i < 10; i++) log3.logEvent({ operator: "va1", type: "action_tap" });
  assert.equal(log3.listEvents({ limit: 3 }).length, 3);
});

test("listEvents on a log file that doesn't exist yet returns an empty list", () => {
  const missingPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-audit-")), "never-written.log");
  const log4 = createAuditLog(missingPath);
  assert.deepEqual(log4.listEvents(), []);
});

test("a torn/partial last line (crash mid-write) is skipped, not fatal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-audit-"));
  const file = path.join(dir, "events.log");
  const log5 = createAuditLog(file);
  log5.logEvent({ operator: "va1", type: "device_selected" });
  fs.appendFileSync(file, '{"id":"broken", "at":'); // simulate a write cut off mid-line

  const events = log5.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "device_selected");
});

test("type_text audit detail never contains the actual typed text (caller's responsibility)", () => {
  // This documents the contract auditLog itself doesn't enforce — the
  // caller in index.js is responsible for passing { length } instead of the
  // text. What auditLog guarantees is that whatever detail object it's
  // given round-trips exactly, so index.js's redaction isn't silently undone.
  const log6 = createAuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-audit-")), "events.log"));
  const entry = log6.logEvent({ operator: "va1", type: "action_type_text", detail: { length: 42 } });
  assert.deepEqual(entry.detail, { length: 42 });
  assert.deepEqual(log6.listEvents()[0].detail, { length: 42 });
});
