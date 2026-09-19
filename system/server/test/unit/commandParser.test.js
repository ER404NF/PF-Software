import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand as parse } from "../../src/commandParser.js";

// These /time inputs (injected `now` instants like 06:00Z) were written for a
// UTC+1/+2 wall clock. The scheduling zone is a deployment setting (default
// America/Los_Angeles), so they say which zone they mean instead of relying on
// whatever the default happens to be.
const ROME = { timeZone: "Europe/Rome" };
const parseCommand = (text, now) => parse(text, now, ROME);

test("plain text with no leading slash is treated as a natural-language goal", () => {
  const result = parseCommand("Research AI coding posts for a while");
  assert.deepEqual(result, { type: "natural_language", goal: "Research AI coding posts for a while" });
});

test("an unknown slash command is an error, not silently treated as natural language", () => {
  const result = parseCommand("/nonsense foo bar");
  assert.ok(result.error);
});

test("/mode parses human and ai, with an optional device id", () => {
  assert.deepEqual(parseCommand("/mode human"), { type: "mode", mode: "human", deviceId: null });
  assert.deepEqual(parseCommand("/mode ai mock-1"), { type: "mode", mode: "ai", deviceId: "mock-1" });
  assert.ok(parseCommand("/mode sideways").error);
});

test("/time parses a same-day HH:MM-HH:MM range and the task text", () => {
  const now = new Date("2026-06-15T06:00:00Z"); // before the window below, on the same day
  const result = parseCommand("/time 09:00-10:00 Research AI coding reels on Instagram", now);
  assert.equal(result.type, "time");
  assert.equal(result.goal, "Research AI coding reels on Instagram");
  assert.ok(result.earliestStart);
  assert.ok(result.latestEnd);
  assert.ok(new Date(result.earliestStart) < new Date(result.latestEnd));
  assert.equal(new Date(result.earliestStart).toISOString().slice(0, 10), "2026-06-15");
});

test("/time's same-day window is computed relative to the injected `now`, not the real clock", () => {
  // A regression guard: timeToDate() must never call the real Date()
  // internally for the same-day case — if it did, this would flakily pass
  // or fail depending on what day the test suite happens to run on.
  const now = new Date("2030-01-01T06:00:00Z");
  const result = parseCommand("/time 09:00-10:00 far future same-day task", now);
  assert.equal(result.type, "time");
  assert.equal(new Date(result.earliestStart).toISOString().slice(0, 10), "2030-01-01");
});

test("/time accepts an explicit (future) date", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const result = parseCommand("/time 2026-09-05 09:00-10:30 Search Reddit for AI agent discussions", now);
  assert.equal(result.type, "time");
  assert.equal(new Date(result.earliestStart).toISOString().slice(0, 10), "2026-09-05");
});

test("/time rejects a window that has already fully passed, even with an explicit date", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  const result = parseCommand("/time 2026-09-05 09:00-10:30 already over", now);
  assert.ok(result.error);
  assert.match(result.error, /already passed/);
});

test("/time rejects a malformed range, a missing task, and start >= end", () => {
  assert.ok(parseCommand("/time 9am-10am do something").error);
  assert.ok(parseCommand("/time 09:00-10:00").error);
  assert.ok(parseCommand("/time 10:00-09:00 do something").error);
});

test("/time rejects calendar dates that JavaScript would otherwise normalize", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.match(parseCommand("/time 2026-02-30 09:00-10:00 impossible", now).error, /invalid calendar date/);
  assert.match(parseCommand("/time 2026-13-01 09:00-10:00 impossible", now).error, /invalid calendar date/);
});

test("/cresearch compiles to a time-windowed goal with an accountSelector", () => {
  const now = new Date("2026-06-15T09:00:00.000Z");
  const result = parseCommand("/cresearch instagram 30 Find strong AI coding reels", now);
  assert.equal(result.type, "cresearch");
  assert.equal(result.goal, "Find strong AI coding reels");
  assert.deepEqual(result.accountSelector, { platform: "instagram" });
  assert.equal(result.earliestStart, "2026-06-15T09:00:00.000Z");
  assert.equal(result.latestEnd, "2026-06-15T09:30:00.000Z");

  const explicit = parseCommand("/cresearch reddit client-a-reddit 15 Find useful threads", now);
  assert.deepEqual(explicit.accountSelector, { platform: "reddit", accountId: "client-a-reddit" });
  assert.equal(explicit.goal, "Find useful threads");
});

test("/cresearch rejects a non-numeric or non-positive duration, and a missing goal", () => {
  assert.ok(parseCommand("/cresearch instagram soon Find reels").error);
  assert.ok(parseCommand("/cresearch instagram -5 Find reels").error);
  assert.ok(parseCommand("/cresearch instagram 30").error);
  assert.ok(parseCommand("/cresearch instagram 1e300 Find reels").error);
});

test("/cresearch supports numeric account IDs only through unambiguous flags", () => {
  const now = new Date("2026-09-05T12:00:00.000Z");
  const result = parseCommand("/cresearch instagram --account 123 --minutes 30 inspect numeric account", now);
  assert.deepEqual(result.accountSelector, { platform: "instagram", accountId: "123" });
  assert.equal(result.goal, "inspect numeric account");
  assert.match(parseCommand("/cresearch instagram 123 30 inspect numeric account", now).error, /ambiguous numeric account/);
  assert.equal(parseCommand("/cresearch instagram --minutes 30 2026 trends", now).goal, "2026 trends");
});

test("/queue add captures the remaining text verbatim for re-parsing", () => {
  const result = parseCommand("/queue add /time 09:00-10:00 Do the thing");
  assert.deepEqual(result, { type: "queue_add", commandText: "/time 09:00-10:00 Do the thing" });
});

test("/queue list|pause|resume take no arguments", () => {
  assert.deepEqual(parseCommand("/queue list"), { type: "queue_list" });
  assert.deepEqual(parseCommand("/queue pause"), { type: "queue_pause" });
  assert.deepEqual(parseCommand("/queue resume"), { type: "queue_resume" });
  for (const command of ["/queue list extra", "/queue pause extra", "/queue resume extra"]) {
    assert.match(parseCommand(command).error, /^usage:/);
  }
});

test("/queue cancel requires a task id", () => {
  assert.deepEqual(parseCommand("/queue cancel task_abc"), { type: "queue_cancel", taskId: "task_abc" });
  assert.ok(parseCommand("/queue cancel").error);
  assert.match(parseCommand("/queue cancel task_abc extra").error, /^usage:/);
});

test("/queue move requires task id, before|after, and target id", () => {
  assert.deepEqual(parseCommand("/queue move task_a before task_b"), {
    type: "queue_move",
    taskId: "task_a",
    relation: "before",
    targetId: "task_b",
  });
  assert.ok(parseCommand("/queue move task_a sideways task_b").error);
  assert.ok(parseCommand("/queue move task_a before").error);
  assert.match(parseCommand("/queue move task_a before task_b extra").error, /^usage:/);
});

test("/queue priority requires a valid priority value", () => {
  assert.deepEqual(parseCommand("/queue priority task_a high"), {
    type: "queue_priority",
    taskId: "task_a",
    priority: "high",
  });
  assert.ok(parseCommand("/queue priority task_a extreme").error);
  assert.match(parseCommand("/queue priority task_a high extra").error, /^usage:/);
});

test("/queue with an unknown subcommand is an error", () => {
  assert.ok(parseCommand("/queue teleport").error);
});

test("/pause, /resume, /stop take an optional device id, like /takeover", () => {
  assert.deepEqual(parseCommand("/pause"), { type: "ai_pause", deviceId: null });
  assert.deepEqual(parseCommand("/pause mock-1"), { type: "ai_pause", deviceId: "mock-1" });
  assert.deepEqual(parseCommand("/resume"), { type: "ai_resume", deviceId: null });
  assert.deepEqual(parseCommand("/resume mock-1"), { type: "ai_resume", deviceId: "mock-1" });
  assert.deepEqual(parseCommand("/stop"), { type: "ai_stop", deviceId: null });
  assert.deepEqual(parseCommand("/stop mock-1"), { type: "ai_stop", deviceId: "mock-1" });
  for (const command of ["/pause mock-1 extra", "/resume mock-1 extra", "/stop mock-1 extra"]) {
    assert.match(parseCommand(command).error, /^usage:/);
  }
});

test("/takeover parses an optional device id", () => {
  assert.deepEqual(parseCommand("/takeover"), { type: "ai_takeover", deviceId: null });
  assert.deepEqual(parseCommand("/takeover mock-1"), { type: "ai_takeover", deviceId: "mock-1" });
  assert.match(parseCommand("/takeover mock-1 extra").error, /^usage:/);
});

test("/mode rejects trailing arguments before execution", () => {
  assert.match(parseCommand("/mode ai mock-1 extra").error, /^usage:/);
});

test("/device health parses an optional device id", () => {
  assert.deepEqual(parseCommand("/device health"), { type: "device_health", deviceId: null });
  assert.deepEqual(parseCommand("/device health mock-1"), { type: "device_health", deviceId: "mock-1" });
  assert.match(parseCommand("/device health mock-1 extra").error, /^usage:/);
});

test("/device with an unknown subcommand is an error", () => {
  assert.ok(parseCommand("/device teleport").error);
  assert.ok(parseCommand("/device").error);
});

test("/audit with no arguments means no filter", () => {
  assert.deepEqual(parseCommand("/audit"), { type: "audit", filterType: null, value: null, limit: null });
});

test("/model parses list and explicit provider scopes", () => {
  assert.deepEqual(parseCommand("/model list"), { type: "model_list" });
  assert.deepEqual(parseCommand("/model set claude"),
    { type: "model_set", providerName: "claude", scope: "global", scopeId: null });
  assert.deepEqual(parseCommand("/model set gpt workspace client-a"),
    { type: "model_set", providerName: "gpt", scope: "workspace", scopeId: "client-a" });
  assert.deepEqual(parseCommand("/model set kimi device mock-1"),
    { type: "model_set", providerName: "kimi", scope: "device", scopeId: "mock-1" });
  assert.deepEqual(parseCommand("/model set nim task task_1"),
    { type: "model_set", providerName: "nim", scope: "task", scopeId: "task_1" });
  assert.ok(parseCommand("/model set").error);
  assert.ok(parseCommand("/model set one workspace").error);
});

test("/audit device|operator requires a value, and accepts an optional numeric limit", () => {
  assert.deepEqual(parseCommand("/audit device mock-1"), {
    type: "audit",
    filterType: "device",
    value: "mock-1",
    limit: null,
  });
  assert.deepEqual(parseCommand("/audit operator va1 10"), {
    type: "audit",
    filterType: "operator",
    value: "va1",
    limit: 10,
  });
  assert.ok(parseCommand("/audit device").error);
  assert.ok(parseCommand("/audit sideways mock-1").error);
  assert.ok(parseCommand("/audit device mock-1 not-a-number").error);
  assert.ok(parseCommand("/audit device mock-1 0").error);
});
