const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 15 * 60_000;
const DEFAULT_LEASE_MS = 60_000;

export function retryDelay(attempt, { baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS } = {}) {
  return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
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
      return store.completeClaim(claim.id, claim.claimToken, { sent: true });
    } catch (error) {
      onFailure(error);
      const permanent = claim.attemptCount >= maxAttempts;
      const nextAttemptAt = permanent ? null : new Date(
        now().getTime() + retryDelay(claim.attemptCount, { baseDelayMs, maxDelayMs }),
      ).toISOString();
      return store.completeClaim(claim.id, claim.claimToken, { sent: false, permanent, nextAttemptAt });
    }
  }

  async function run({ id = null } = {}) {
    if (!mailSender.isConfigured()) return id ? store.deliveryContent(id) : [];
    const outcomes = [];
    do {
      const claim = store.claimNext({ now: now(), maxAttempts, leaseMs, id });
      if (!claim) break;
      outcomes.push(await sendClaim(claim));
      if (id) break;
    } while (true);
    return id ? outcomes[0] ?? store.deliveryContent(id) : outcomes;
  }

  return {
    drain(options = {}) {
      if (drainOperation) return drainOperation;
      const operation = run(options);
      drainOperation = operation;
      operation.finally(() => { if (drainOperation === operation) drainOperation = null; }).catch(() => {});
      return operation;
    },
    deliver(id) { return run({ id }); },
  };
}
