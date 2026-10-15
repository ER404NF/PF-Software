const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 15 * 60_000;
const DEFAULT_LEASE_MS = 60_000;

export function retryDelay(attempt, { baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS } = {}) {
  return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

export function notificationFailureCategory(error) {
  const code = String(error?.code || error?.name || "").toUpperCase();
  const responseCode = Number(error?.responseCode);
  if (["EAUTH", "AUTHENTICATIONFAILED"].includes(code) || responseCode === 535) return "authentication_rejected";
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNECTION"].includes(code)) return "connection_timeout";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "provider_unavailable";
  if (responseCode === 429 || responseCode === 421 || code === "ERATELIMIT") return "rate_limited";
  if (responseCode >= 500) return "provider_unavailable";
  if (responseCode >= 400) return "recipient_rejected";
  if (["ENOENT", "EACCES", "ENOSPC", "EROFS"].includes(code)) return "storage_unavailable";
  return "unknown_delivery_failure";
}

export function createNotificationOutbox({
  store,
  mailSender,
  now = () => new Date(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  leaseMs = DEFAULT_LEASE_MS,
  onFailure = () => {},
} = {}) {
  if (!store?.claimNext || !store?.completeClaim) throw new Error("notification store does not support durable delivery claims");
  let drainOperation = null;

  async function sendClaim(claim) {
    try {
      await mailSender.send({ to: claim.to, from: claim.from, subject: claim.subject, body: claim.body });
      return await store.completeClaim(claim.id, claim.claimToken, {
        sent: true, workerOrganizationId: claim.workerOrganizationId,
      });
    } catch (error) {
      onFailure(error);
      const permanent = (claim.attemptCycleCount ?? claim.attemptCount) >= maxAttempts;
      const nextAttemptAt = permanent ? null : new Date(
        now().getTime() + retryDelay(claim.attemptCount, { baseDelayMs, maxDelayMs }),
      ).toISOString();
      return await store.completeClaim(claim.id, claim.claimToken, {
        sent: false, permanent, nextAttemptAt, failureCategory: notificationFailureCategory(error),
        workerOrganizationId: claim.workerOrganizationId,
      });
    }
  }

  async function run({ id = null, organizationId = null } = {}) {
    if (!mailSender.isConfigured()) return id ? store.deliveryContent(id) : [];
    const outcomes = [];
    do {
      const claim = await store.claimNext({ now: now(), maxAttempts, leaseMs, id, organizationId });
      if (!claim) break;
      outcomes.push(await sendClaim(claim));
      if (id) break;
    } while (true);
    return id ? outcomes[0] ?? await store.deliveryContent(id) : outcomes;
  }

  return {
    drain(options = {}) {
      if (drainOperation) return drainOperation;
      const operation = run(options);
      drainOperation = operation;
      operation.finally(() => { if (drainOperation === operation) drainOperation = null; }).catch(() => {});
      return operation;
    },
    deliver(id, options = {}) { return run({ id, ...options }); },
  };
}
