// The distinct, truthful outcomes of Retry / Start / Restart / Stop for a phone's
// control service. Each has a plain-language message for the operator, a machine
// code for the client and the logs, and the HTTP status a route should answer
// with. Failures are thrown as LifecycleError; only success is returned.

const DEFINITIONS = {
  started: { status: 200, message: () => "Phone control is starting." },
  device_not_attached: { status: 409, message: () => "This phone is not plugged in or not set up yet." },
  device_unknown: { status: 404, message: () => "Bodun does not know this phone." },
  port_held_by_other_program: {
    status: 409,
    message: ({ program, pid, port }) => `Another program (${program || "unknown program"}, process ${pid}) is using port ${port}. Close it, then try again. Bodun will not stop other programs.`,
  },
  port_held_by_unidentified_program: {
    status: 409,
    message: ({ port }) => `Another program is using port ${port}. Bodun could not tell which one, and will not stop it. Close it, then try again.`,
  },
  old_process_would_not_stop: {
    status: 409,
    message: () => "Bodun could not stop its old connection process. Restart Bodun, then try again.",
  },
  process_replacement_pending: {
    status: 409,
    message: () => "The previous phone control process is still stopping. Wait a moment, then try again.",
  },
  shutting_down: { status: 503, message: () => "Bodun is shutting down. Try again after it has restarted." },
  wda_stop_unconfirmed: {
    status: 409,
    message: () => "Bodun could not confirm that the phone control process stopped. Restart Bodun to clear it.",
  },
  device_not_managed: { status: 409, message: () => "Bodun is not managing this phone's control service." },
  phone_in_use: {
    status: 409,
    message: ({ phoneLabel = "This phone", operatorLabel = "another operator" }) =>
      `${phoneLabel} is in use by ${operatorLabel}. Ask them to release it before stopping or restarting its control service.`,
  },
  wda_not_running: { status: 409, message: () => "Phone control is stopped. Use Start WDA instead." },
  running_not_responding: { status: 409, message: () => "Control is running but not responding. Use Restart WDA." },
  provisioning_off: { status: 409, message: () => "Automatic phone setup is turned off on this Mac." },
  lifecycle_state_changed: { status: 409, message: () => "The phone control state changed. Review the current action and try again." },
  external_wda_running: { status: 409, message: () => "Another program is already running WDA for this phone. Stop the Xcode run, then use Start WDA in Bodun." },
  wda_ownership_unavailable: { status: 503, message: () => "Bodun could not verify who owns the existing WDA process. It will not start a duplicate. Review diagnostics and try again." },
};

export function resultDefinition(code) {
  return DEFINITIONS[code] ?? null;
}

export function resultCodes() {
  return Object.keys(DEFINITIONS);
}

export function resultMessage(code, details = {}) {
  const definition = DEFINITIONS[code];
  if (!definition) throw new Error(`unknown provisioning result: ${code}`);
  return definition.message(details);
}

export function resultStatus(code) {
  const definition = DEFINITIONS[code];
  if (!definition) throw new Error(`unknown provisioning result: ${code}`);
  return definition.status;
}

// Adds a definition from another module (the lifecycle errors of S15) without
// letting it silently replace an existing one.
export function registerResult(code, definition) {
  if (DEFINITIONS[code]) throw new Error(`provisioning result already defined: ${code}`);
  DEFINITIONS[code] = definition;
}

export class LifecycleError extends Error {
  constructor(code, details = {}) {
    super(resultMessage(code, details));
    this.name = "LifecycleError";
    this.code = code;
    this.status = resultStatus(code);
    this.details = details;
  }
}

export function lifecycleSuccess() {
  return { ok: true, code: "started", message: resultMessage("started") };
}

// What a route answers for a thrown LifecycleError.
export function lifecycleErrorBody(error) {
  return { ok: false, error: error.message, code: error.code };
}
