// Child-process fixture for commandParser's process-timezone regression test.
// Sets the OS/process timezone BEFORE anything else loads (a runtime
// process.env.TZ assignment is honored by Node on Windows, macOS and Linux —
// a TZ variable in the launching environment alone is not, on Windows), then
// prints what /time resolves for fixed inputs so the parent can compare runs
// made under wildly different host timezones.
//
// usage: node print-time-command.mjs <process-tz> [scheduling-tz]

const [, , processTz, schedulingTz] = process.argv;
process.env.TZ = processTz;

const { parseCommand } = await import("../src/commandParser.js");
const options = schedulingTz ? { timeZone: schedulingTz } : undefined;

const cases = {
  sameDay: parseCommand("/time 09:00-10:00 same day", new Date("2026-06-15T06:00:00Z"), options),
  sameDayWinter: parseCommand("/time 09:00-10:00 far future", new Date("2030-01-01T06:00:00Z"), options),
  explicitDate: parseCommand("/time 2026-09-05 09:00-10:30 explicit", new Date("2026-06-15T12:00:00Z"), options),
  passed: parseCommand("/time 2026-09-05 09:00-10:30 over", new Date("2026-09-05T12:00:00Z"), options),
  springForward: parseCommand("/time 2026-03-29 01:30-03:30 dst", new Date("2026-03-01T00:00:00Z"), options),
  fallBack: parseCommand("/time 2026-10-25 01:30-03:30 dst", new Date("2026-10-01T00:00:00Z"), options),
};

console.log(JSON.stringify({
  // Proves the requested process timezone really took effect, so the parent
  // can't be fooled by a platform that silently ignored it.
  processOffsetMinutesAtJune15: new Date("2026-06-15T06:00:00Z").getTimezoneOffset(),
  cases,
}));
