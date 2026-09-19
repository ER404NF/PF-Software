// /time reads wall-clock input in an EXPLICIT IANA timezone (the deployment's
// scheduling zone), never the OS/process timezone. A Mac mini left on a US
// zone used to turn "/time 09:00-10:00" into a different window — and flip
// the "already passed" decision — than the same command on a Rome-zoned
// machine, because timeToDate() used the process-local Date accessors.
// These tests pin the semantics with hard-coded UTC expectations, so they
// hold regardless of the machine running them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCommand } from "../../src/commandParser.js";

const window = (result) => [result.earliestStart, result.latestEnd];

test("the same /time input resolves per the explicit zone, including which calendar day 'today' is", () => {
  const now = new Date("2026-06-15T06:00:00Z");
  const cases = [
    // zone, expected window (null => rejected as already passed)
    ["Europe/Rome", ["2026-06-15T07:00:00.000Z", "2026-06-15T08:00:00.000Z"]],
    ["Europe/Bucharest", ["2026-06-15T06:00:00.000Z", "2026-06-15T07:00:00.000Z"]],
    ["UTC", ["2026-06-15T09:00:00.000Z", "2026-06-15T10:00:00.000Z"]],
    // In these zones 06:00Z is already the afternoon/evening (or the previous
    // evening) locally, so the 09:00-10:00 window for THEIR today is over.
    ["America/Los_Angeles", null], // 2026-06-14 23:00 local
    ["Asia/Tokyo", null],          // 2026-06-15 15:00 local
    ["Pacific/Kiritimati", null],  // 2026-06-15 20:00 local (UTC+14)
  ];
  for (const [timeZone, expected] of cases) {
    const result = parseCommand("/time 09:00-10:00 zone test", now, { timeZone });
    if (expected === null) {
      assert.match(result.error ?? "", /already passed/, `${timeZone} should reject a window that ended locally`);
    } else {
      assert.equal(result.type, "time", `${timeZone}: ${result.error}`);
      assert.deepEqual(window(result), expected, timeZone);
    }
  }
});

test("an explicit date is wall-clock time in the zone, not in UTC or the host zone", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const expected = {
    "Europe/Rome": ["2026-09-05T07:00:00.000Z", "2026-09-05T08:30:00.000Z"],
    "America/Los_Angeles": ["2026-09-05T16:00:00.000Z", "2026-09-05T17:30:00.000Z"],
    "Asia/Tokyo": ["2026-09-05T00:00:00.000Z", "2026-09-05T01:30:00.000Z"],
    "Pacific/Kiritimati": ["2026-09-04T19:00:00.000Z", "2026-09-04T20:30:00.000Z"],
    UTC: ["2026-09-05T09:00:00.000Z", "2026-09-05T10:30:00.000Z"],
  };
  for (const [timeZone, want] of Object.entries(expected)) {
    const result = parseCommand("/time 2026-09-05 09:00-10:30 explicit date", now, { timeZone });
    assert.equal(result.type, "time", `${timeZone}: ${result.error}`);
    assert.deepEqual(window(result), want, timeZone);
  }
});

test("'today' is the calendar date IN the zone when it differs from the UTC date", () => {
  // 22:30Z on the 15th is already 00:30 on the 16th in Rome (CEST).
  const now = new Date("2026-06-15T22:30:00Z");
  const result = parseCommand("/time 01:00-02:00 after midnight", now, { timeZone: "Europe/Rome" });
  assert.equal(result.type, "time", result.error);
  assert.deepEqual(window(result), ["2026-06-15T23:00:00.000Z", "2026-06-16T00:00:00.000Z"]);
});

test("Europe/Rome applies the correct DST offset on either side of the transitions", () => {
  const now = new Date("2025-12-01T00:00:00Z");
  const winter = parseCommand("/time 2026-01-15 09:00-10:00 winter", now, { timeZone: "Europe/Rome" });
  const summer = parseCommand("/time 2026-07-15 09:00-10:00 summer", now, { timeZone: "Europe/Rome" });
  assert.deepEqual(window(winter), ["2026-01-15T08:00:00.000Z", "2026-01-15T09:00:00.000Z"]); // CET  UTC+1
  assert.deepEqual(window(summer), ["2026-07-15T07:00:00.000Z", "2026-07-15T08:00:00.000Z"]); // CEST UTC+2
});

test("spring-forward (2026-03-29 in Rome): a window spanning the jump is one real hour; a window that is entirely the skipped hour is rejected", () => {
  const now = new Date("2026-03-01T00:00:00Z");
  const spanning = parseCommand("/time 2026-03-29 01:30-03:30 across the jump", now, { timeZone: "Europe/Rome" });
  assert.equal(spanning.type, "time", spanning.error);
  // 01:30 is CET (00:30Z); 03:30 is CEST (01:30Z) — the 02:00-03:00 hour does not exist.
  assert.deepEqual(window(spanning), ["2026-03-29T00:30:00.000Z", "2026-03-29T01:30:00.000Z"]);

  // 02:00-03:00 is exactly the hour that does not exist: both ends resolve to 03:00 CEST.
  const wholeGap = parseCommand("/time 2026-03-29 02:00-03:00 nonexistent", now, { timeZone: "Europe/Rome" });
  assert.match(wholeGap.error, /does not exist in Europe\/Rome/);
});

test("spring-forward: a wall time inside the skipped hour is shifted forward by the gap, keeping the window's length", () => {
  const now = new Date("2026-03-01T00:00:00Z");
  // 02:15 and 02:45 do not exist; they resolve to 03:15 and 03:45 CEST (01:15Z / 01:45Z).
  const shifted = parseCommand("/time 2026-03-29 02:15-02:45 shifted", now, { timeZone: "Europe/Rome" });
  assert.equal(shifted.type, "time", shifted.error);
  assert.deepEqual(window(shifted), ["2026-03-29T01:15:00.000Z", "2026-03-29T01:45:00.000Z"]);
});

test("fall-back (2026-10-25 in Rome): repeated local times resolve deterministically to the earlier occurrence", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  const across = parseCommand("/time 2026-10-25 01:30-03:30 across the repeat", now, { timeZone: "Europe/Rome" });
  // 01:30 is CEST (23:30Z the day before); 03:30 is CET (02:30Z) — three real hours.
  assert.deepEqual(window(across), ["2026-10-24T23:30:00.000Z", "2026-10-25T02:30:00.000Z"]);

  const ambiguous = parseCommand("/time 2026-10-25 02:30-03:30 repeated hour", now, { timeZone: "Europe/Rome" });
  // 02:30 happens twice; the first (CEST, 00:30Z) is used. End 03:30 is CET (02:30Z).
  assert.deepEqual(window(ambiguous), ["2026-10-25T00:30:00.000Z", "2026-10-25T02:30:00.000Z"]);
});

test("existing validation is unchanged under an explicit zone", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const options = { timeZone: "Europe/Rome" };
  assert.match(parseCommand("/time 2026-02-30 09:00-10:00 nope", now, options).error, /invalid calendar date/);
  assert.match(parseCommand("/time 2026-13-01 09:00-10:00 nope", now, options).error, /invalid calendar date/);
  assert.match(parseCommand("/time 10:00-09:00 nope", now, options).error, /start time must be before end time/);
  assert.match(parseCommand("/time 09:00-09:00 nope", now, options).error, /start time must be before end time/);
  assert.match(parseCommand("/time 25:00-26:00 nope", now, options).error, /invalid time range/);
  assert.match(parseCommand("/time 09:00-10:00", now, options).error, /^usage: \/time/);
  assert.match(parseCommand("/time 2026-02-01 09:00-10:00", now, options).error, /task description is required/);
  assert.equal(parseCommand("/time 2026-02-01 09:00-10:00 future ok", now, options).type, "time");
});

test("an invalid injected timezone is reported as an error, not thrown", () => {
  const result = parseCommand("/time 09:00-10:00 nope", new Date("2026-06-15T06:00:00Z"), { timeZone: "Not/AZone" });
  assert.match(result.error, /valid IANA timezone/);
});

// ---- process-timezone independence -------------------------------------

const fixture = fileURLToPath(new URL("../../fixtures/print-time-command.mjs", import.meta.url));

function runUnderProcessTimeZone(processTz, schedulingTz) {
  const args = [fixture, processTz, ...(schedulingTz ? [schedulingTz] : [])];
  const run = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const ROME_EXPECTED = {
  sameDay: {
    type: "time", goal: "same day",
    earliestStart: "2026-06-15T07:00:00.000Z", latestEnd: "2026-06-15T08:00:00.000Z",
  },
  sameDayWinter: {
    type: "time", goal: "far future",
    earliestStart: "2030-01-01T08:00:00.000Z", latestEnd: "2030-01-01T09:00:00.000Z",
  },
  explicitDate: {
    type: "time", goal: "explicit",
    earliestStart: "2026-09-05T07:00:00.000Z", latestEnd: "2026-09-05T08:30:00.000Z",
  },
  passed: { error: "that window has already passed (ended 2026-09-05T08:30:00.000Z) — reschedule it" },
  springForward: {
    type: "time", goal: "dst",
    earliestStart: "2026-03-29T00:30:00.000Z", latestEnd: "2026-03-29T01:30:00.000Z",
  },
  fallBack: {
    type: "time", goal: "dst",
    earliestStart: "2026-10-24T23:30:00.000Z", latestEnd: "2026-10-25T02:30:00.000Z",
  },
};

// [process timezone, expected Date#getTimezoneOffset() at 2026-06-15]
const PROCESS_ZONES = [
  ["America/Los_Angeles", 420],
  ["Pacific/Pago_Pago", 660],
  ["Pacific/Kiritimati", -840],
  ["Asia/Kolkata", -330],
  ["Europe/Rome", -120],
  ["UTC", 0],
];

test("/time yields identical results whatever timezone the host process runs in", () => {
  const seenOffsets = new Set();
  for (const [processTz, expectedOffset] of PROCESS_ZONES) {
    const output = runUnderProcessTimeZone(processTz, "Europe/Rome");
    // Guard against a silent no-op: the process really was in that zone.
    assert.equal(output.processOffsetMinutesAtJune15, expectedOffset, `process TZ ${processTz} did not take effect`);
    seenOffsets.add(output.processOffsetMinutesAtJune15);
    assert.deepEqual(output.cases, ROME_EXPECTED, `Europe/Rome scheduling result changed under process TZ ${processTz}`);
  }
  assert.equal(seenOffsets.size, PROCESS_ZONES.length, "the matrix must exercise genuinely different host timezones");
});

// The product default is California. Whatever zone the host OS is in, the SAME
// input means the SAME window: 09:00-10:00 on the California calendar day.
const CALIFORNIA_EXPECTED = {
  sameDay: { error: "that window has already passed (ended 2026-06-14T17:00:00.000Z) — reschedule it" }, // 06:00Z is 23:00 the previous evening in California
  sameDayWinter: { error: "that window has already passed (ended 2029-12-31T18:00:00.000Z) — reschedule it" },
  explicitDate: { type: "time", goal: "explicit", earliestStart: "2026-09-05T16:00:00.000Z", latestEnd: "2026-09-05T17:30:00.000Z" }, // PDT, UTC-7
  passed: { type: "time", goal: "over", earliestStart: "2026-09-05T16:00:00.000Z", latestEnd: "2026-09-05T17:30:00.000Z" }, // 12:00Z is only 05:00 PDT: not passed yet
  springForward: { type: "time", goal: "dst", earliestStart: "2026-03-29T08:30:00.000Z", latestEnd: "2026-03-29T10:30:00.000Z" },
  fallBack: { type: "time", goal: "dst", earliestStart: "2026-10-25T08:30:00.000Z", latestEnd: "2026-10-25T10:30:00.000Z" },
};

test("with no configuration the scheduling zone is California in every process timezone", () => {
  for (const [processTz] of PROCESS_ZONES) {
    const output = runUnderProcessTimeZone(processTz);
    assert.deepEqual(output.cases, CALIFORNIA_EXPECTED, `default zone result changed under process TZ ${processTz}`);
  }
});

test("California DST is applied by the IANA rules (2026-03-08 spring-forward, 2026-11-01 fall-back)", () => {
  const now = new Date("2026-02-01T00:00:00Z");
  const options = { timeZone: "America/Los_Angeles" };
  const gap = parseCommand("/time 2026-03-08 02:00-03:00 nonexistent hour", now, options);
  assert.match(gap.error, /does not exist in America\/Los_Angeles/);
  const across = parseCommand("/time 2026-03-08 01:30-03:30 across the jump", now, options);
  assert.deepEqual(window(across), ["2026-03-08T09:30:00.000Z", "2026-03-08T10:30:00.000Z"]); // 01:30 PST, 03:30 PDT
  const repeated = parseCommand("/time 2026-11-01 01:30-02:30 repeated hour", now, options);
  assert.deepEqual(window(repeated), ["2026-11-01T08:30:00.000Z", "2026-11-01T10:30:00.000Z"]); // earlier 01:30 (PDT) -> 02:30 PST
});

test("an injected scheduling zone wins over the host zone in every process timezone", () => {
  const outputs = PROCESS_ZONES.map(([processTz]) => runUnderProcessTimeZone(processTz, "America/New_York").cases);
  for (const cases of outputs) {
    assert.deepEqual(cases, outputs[0]);
    // 09:00-10:00 EDT (UTC-4) on the New York calendar day of 2026-06-15T06:00Z (02:00 local).
    assert.deepEqual([cases.sameDay.earliestStart, cases.sameDay.latestEnd],
      ["2026-06-15T13:00:00.000Z", "2026-06-15T14:00:00.000Z"]);
  }
});

test("commandParser.js never uses process-local Date accessors for wall-clock logic", () => {
  // Static guard for the original bug class (setHours/getDate/local-time
  // `${date}T00:00:00` strings). UTC accessors (getUTC*) are fine.
  const source = readFileSync(fileURLToPath(new URL("../../src/commandParser.js", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\.(get|set)(Hours|Minutes|Seconds|Milliseconds|Date|Day|Month|FullYear)\(/);
  assert.doesNotMatch(source, /T00:00:00`/);
  assert.doesNotMatch(source, /getTimezoneOffset/);
});
