// The one plain status for automatic phone setup, shared by the server, the Fleet page banner, the phone cards and
// Copy Diagnostics. A state ("running", "checking", "paused", "off") plus a machine code and a message an operator can
// read: never a file path, a process number or a program name.
//
// "changesByItself" marks the pauses a new check can clear without a person doing anything (the check could not look,
// or an earlier Bodun session was still running); those are re-checked every 30 seconds. A damaged record needs a person.

export const SETUP_CODES = Object.freeze({
  setup_running: { state: "running", changesByItself: false, message: "Automatic phone setup is running." },
  setup_checking: {
    state: "checking", changesByItself: false,
    message: "Bodun is checking its earlier phone connections. Phone setup starts as soon as that is done.",
  },
  setup_paused_cannot_check: {
    state: "paused", changesByItself: true,
    message: "Automatic phone setup is paused. Bodun could not check its earlier phone connections. It will try again by itself every 30 seconds.",
  },
  setup_paused_earlier_session: {
    state: "paused", changesByItself: true,
    message: "Automatic phone setup is paused. An earlier Bodun session is still running. Bodun will check again by itself every 30 seconds.",
  },
  setup_paused_record_damaged: {
    state: "paused", changesByItself: false,
    message: "Automatic phone setup is paused. The record of Bodun's earlier phone connections is damaged. Quit Bodun and open it again. Bodun will then offer to move the damaged record aside.",
  },
  setup_off: { state: "off", changesByItself: false, message: "Automatic phone setup is turned off on this Mac." },
});

// What a phone that automatic setup has not adopted yet says about why its control service cannot be started, while setup
// is paused or still checking. null when setup is running or off (the phone's own wording then applies).
export function phoneReasonForStatus(status) {
  if (status?.state === "paused") return "Automatic phone setup is paused. See the notice at the top of this page.";
  if (status?.state === "checking") return "Automatic phone setup is checking its earlier phone connections. Try again in a moment.";
  return null;
}

export function setupCodes() {
  return Object.keys(SETUP_CODES);
}

export function buildSetupStatus(code) {
  const definition = SETUP_CODES[code];
  if (!definition) throw new Error(`unknown automatic setup status: ${code}`);
  return { state: definition.state, code, message: definition.message, changesByItself: definition.changesByItself };
}
