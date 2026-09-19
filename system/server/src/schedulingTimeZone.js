import { validTimeZone } from "./zonedRecurrence.js";

// The one timezone in which operators' wall-clock scheduling input ("/time
// 09:00-10:00 ...") is interpreted. It is deliberately NOT the operating
// system's zone: a Mac mini left on a US zone would otherwise silently shift
// every window by hours, and results would differ from one host to the next.
// Configure it per deployment with PHONE_FARM_TIMEZONE (an IANA name such as
// America/New_York or Europe/Rome); DST is applied by the IANA rules. The
// product default is California (America/Los_Angeles), the operating hours of
// the organization that runs the fleet, even when a host sits elsewhere.
export const DEFAULT_SCHEDULING_TIME_ZONE = "America/Los_Angeles";

export function resolveSchedulingTimeZone(env = process.env) {
  const configured = env.PHONE_FARM_TIMEZONE;
  if (configured === undefined || configured === "") return DEFAULT_SCHEDULING_TIME_ZONE;
  if (!validTimeZone(configured)) {
    throw new Error(`PHONE_FARM_TIMEZONE must be a valid IANA timezone such as America/Los_Angeles, got: ${JSON.stringify(configured)}`);
  }
  return configured;
}
