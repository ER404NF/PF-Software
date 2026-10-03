export function operationalErrorKind(error) {
  for (const value of [error?.code, error?.name]) {
    if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)) return value;
  }
  return "Error";
}

export function logOperationalFailure(context, error, log = console.error) {
  // Transport and repository messages can contain credentials, email
  // addresses, filesystem paths, remote response bodies, or typed text.
  // Retain a bounded error kind for operations while keeping that data out
  // of stdout/stderr and centralized log collectors.
  log(`${context}:`, operationalErrorKind(error));
}
