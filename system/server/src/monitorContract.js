// Honest pre-hardware monitor contract. Real frames, viewer tracking, and
// start/stop endpoints are deliberately absent until physical WDA validation
// proves that passive capture does not claim or interrupt the input lease.

export const MONITOR_UNAVAILABLE = Object.freeze({
  available: false,
  state: "unavailable",
  readOnly: true,
  claimsInputLease: false,
  refreshIntervalMs: null,
  activeViewers: 0,
  privacyPolicy: "required-before-production",
  reason: "Physical iPhone and WebDriverAgent passive-capture validation is required.",
});

export function monitorState() {
  return { ...MONITOR_UNAVAILABLE };
}
