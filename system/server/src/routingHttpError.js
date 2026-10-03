import { diagnosticError } from "./errorCatalog.js";
import { operationalErrorKind } from "./safeOperationalLog.js";

const EXPOSED_STATUSES = new Set([400, 401, 403, 404, 409]);
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function routingHttpFailure(error, { code, status = 502 } = {}) {
  if (error?.expose === true && EXPOSED_STATUSES.has(error.status)) {
    return {
      status: error.status,
      body: {
        error: error.message,
        ...(typeof error.code === "string" && SAFE_CODE_RE.test(error.code) ? { code: error.code } : {}),
      },
    };
  }

  const detail = diagnosticError(code, {
    technical: { errorKind: operationalErrorKind(error) },
  });
  return {
    status,
    body: { error: detail.publicMessage, code: detail.code },
  };
}

export function sendRoutingHttpFailure(res, error, options) {
  const failure = routingHttpFailure(error, options);
  return res.status(failure.status).json(failure.body);
}
