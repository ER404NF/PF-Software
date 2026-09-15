import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceRecurringWindow, validTimeZone } from "../../src/zonedRecurrence.js";

test("daily Europe/Rome recurrence preserves wall time across both DST transitions", () => {
  const spring = advanceRecurringWindow({
    startAt: "2026-03-28T08:00:00.000Z", endAt: "2026-03-28T09:00:00.000Z",
    recurrence: "daily", timeZone: "Europe/Rome", after: "2026-03-28T08:30:00.000Z",
  });
  assert.equal(spring.startAt, "2026-03-29T07:00:00.000Z");
  assert.equal(spring.endAt, "2026-03-29T08:00:00.000Z");

  const fall = advanceRecurringWindow({
    startAt: "2026-10-24T07:00:00.000Z", endAt: "2026-10-24T08:00:00.000Z",
    recurrence: "daily", timeZone: "Europe/Rome", after: "2026-10-24T07:30:00.000Z",
  });
  assert.equal(fall.startAt, "2026-10-25T08:00:00.000Z");
  assert.equal(fall.endAt, "2026-10-25T09:00:00.000Z");
});

test("Europe/Rome skipped and duplicated local times resolve deterministically", () => {
  const skipped = advanceRecurringWindow({
    startAt: "2026-03-28T01:30:00.000Z", endAt: "2026-03-28T02:30:00.000Z",
    recurrence: "daily", timeZone: "Europe/Rome", after: "2026-03-28T02:00:00.000Z",
  });
  assert.equal(skipped.startAt, "2026-03-29T01:30:00.000Z");
  assert.ok(Date.parse(skipped.endAt) > Date.parse(skipped.startAt));

  const duplicated = advanceRecurringWindow({
    startAt: "2026-10-24T00:30:00.000Z", endAt: "2026-10-24T01:30:00.000Z",
    recurrence: "daily", timeZone: "Europe/Rome", after: "2026-10-24T01:00:00.000Z",
  });
  assert.equal(duplicated.startAt, "2026-10-25T00:30:00.000Z");
});

test("recurrence rejects invalid timezone identifiers", () => {
  assert.equal(validTimeZone("Europe/Rome"), true);
  assert.equal(validTimeZone("not/a-zone"), false);
  assert.throws(() => advanceRecurringWindow({ startAt: "2026-01-01T00:00:00Z", endAt: "2026-01-01T01:00:00Z",
    recurrence: "weekly", timeZone: "not/a-zone", after: "2026-01-01T00:30:00Z" }), /IANA timezone/);
});
