const formatters = new Map();

export function validTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 100) return false;
  try { new Intl.DateTimeFormat("en", { timeZone }).format(0); return true; }
  catch { return false; }
}

function formatter(timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat("en-CA-u-hc-h23", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }));
  return formatters.get(timeZone);
}

function partsAt(milliseconds, timeZone) {
  const values = Object.fromEntries(formatter(timeZone).formatToParts(new Date(milliseconds))
    .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day,
    hour: values.hour, minute: values.minute, second: values.second };
}

function serial(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function sameLocal(left, right) {
  return serial(left) === serial(right);
}

function shiftCalendar(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days,
    parts.hour, parts.minute, parts.second));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds() };
}

function instantForLocal(target, timeZone) {
  const targetSerial = serial(target);
  const offsets = new Set();
  for (let delta = -24 * 60; delta <= 24 * 60; delta += 15) {
    const probe = targetSerial + delta * 60_000;
    offsets.add(serial(partsAt(probe, timeZone)) - probe);
  }
  const exact = [...offsets].map(offset => targetSerial - offset)
    .filter(candidate => sameLocal(partsAt(candidate, timeZone), target));
  if (exact.length) return Math.min(...exact); // earlier instant for a duplicated local time

  const projected = [...offsets].map(offset => targetSerial - offset).map(candidate => ({
    candidate,
    local: partsAt(candidate, timeZone),
  })).filter(item => item.local.year === target.year && item.local.month === target.month && item.local.day === target.day)
    .map(item => ({ ...item, localDelta: serial(item.local) - targetSerial })).filter(item => item.localDelta >= 0)
    .sort((left, right) => left.localDelta - right.localDelta || left.candidate - right.candidate);
  if (projected.length) return projected[0].candidate;

  // A skipped wall time (spring-forward gap) advances to the first valid
  // local minute on the same calendar day, matching "compatible" calendar behavior.
  let best = null;
  for (let delta = -12 * 60; delta <= 12 * 60; delta += 1) {
    const candidate = targetSerial + delta * 60_000;
    const local = partsAt(candidate, timeZone);
    if (local.year !== target.year || local.month !== target.month || local.day !== target.day) continue;
    const localDelta = serial(local) - targetSerial;
    if (localDelta < 0) continue;
    if (!best || localDelta < best.localDelta || (localDelta === best.localDelta && candidate < best.candidate)) {
      best = { candidate, localDelta };
    }
  }
  if (!best) throw new Error("recurrence local time cannot be resolved");
  return best.candidate;
}

// Shared with commandParser.js so /time resolves wall-clock times with the
// exact DST rules recurring assignments already use, instead of a second
// timezone implementation:
//   zonedLocalParts(ms, zone)         -> the calendar/clock fields `zone` shows at that instant
//   zonedInstantForLocal(parts, zone) -> the instant a wall-clock reading occurs in `zone`;
//     a repeated fall-back time resolves to its EARLIER occurrence and a skipped
//     spring-forward time is shifted forward by the length of the gap.
export { partsAt as zonedLocalParts, instantForLocal as zonedInstantForLocal };

export function advanceRecurringWindow({ startAt, endAt, recurrence, timeZone, after }) {
  if (!validTimeZone(timeZone)) throw new Error("recurring assignment requires a valid IANA timezone");
  if (!new Set(["daily", "weekly"]).has(recurrence)) throw new Error("recurrence must be daily or weekly");
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  const cutoff = after instanceof Date ? after.getTime() : Date.parse(after);
  if (![start, end, cutoff].every(Number.isFinite)) throw new Error("recurrence timestamps must be valid");
  const startLocal = partsAt(start, timeZone);
  const endLocal = partsAt(end, timeZone);
  const stepDays = recurrence === "daily" ? 1 : 7;
  for (let advanced = 1; advanced <= 100_000; advanced += 1) {
    const days = advanced * stepDays;
    const nextStart = instantForLocal(shiftCalendar(startLocal, days), timeZone);
    let nextEnd = instantForLocal(shiftCalendar(endLocal, days), timeZone);
    if (nextEnd <= nextStart) nextEnd = nextStart + (end - start);
    if (nextEnd > cutoff) return {
      startAt: new Date(nextStart).toISOString(),
      endAt: new Date(nextEnd).toISOString(),
      advanced,
    };
  }
  throw new Error("recurrence advance exceeded its safety bound");
}
