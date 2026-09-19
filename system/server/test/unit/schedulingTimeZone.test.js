import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCHEDULING_TIME_ZONE, resolveSchedulingTimeZone } from "../../src/schedulingTimeZone.js";

test("the scheduling timezone defaults to California, independent of the OS zone", () => {
  assert.equal(DEFAULT_SCHEDULING_TIME_ZONE, "America/Los_Angeles");
  assert.equal(resolveSchedulingTimeZone({}), "America/Los_Angeles");
  assert.equal(resolveSchedulingTimeZone({ PHONE_FARM_TIMEZONE: "" }), "America/Los_Angeles");
});

test("PHONE_FARM_TIMEZONE overrides the default with any valid IANA zone", () => {
  assert.equal(resolveSchedulingTimeZone({ PHONE_FARM_TIMEZONE: "Europe/Bucharest" }), "Europe/Bucharest");
  assert.equal(resolveSchedulingTimeZone({ PHONE_FARM_TIMEZONE: "America/Los_Angeles" }), "America/Los_Angeles");
  assert.equal(resolveSchedulingTimeZone({ PHONE_FARM_TIMEZONE: "UTC" }), "UTC");
});

test("an invalid PHONE_FARM_TIMEZONE fails loudly instead of silently falling back", () => {
  for (const bad of ["Mars/Olympus", "Rome", "not a zone", "x".repeat(200)]) {
    assert.throws(() => resolveSchedulingTimeZone({ PHONE_FARM_TIMEZONE: bad }), /PHONE_FARM_TIMEZONE must be a valid IANA timezone/);
  }
});
