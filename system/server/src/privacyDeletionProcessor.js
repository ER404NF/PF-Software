const CATEGORIES = Object.freeze(["access", "account", "assignments", "tasks", "media", "shared_records", "audit"]);
const POLICY_MODES = Object.freeze({
  access: new Set(["revoke"]),
  account: new Set(["anonymize"]),
  assignments: new Set(["anonymize_owned", "retain"]),
  tasks: new Set(["anonymize_owned", "retain"]),
  media: new Set(["delete_owned", "retain"]),
  shared_records: new Set(["retain"]),
  audit: new Set(["retain"]),
});
const FAILURE_CODES = new Set(["policy_missing", "access_revocation_failed", "account_cleanup_failed",
  "assignment_cleanup_failed", "task_cleanup_failed", "media_cleanup_failed", "shared_record_cleanup_failed",
  "audit_write_failed", "authorization_revoked", "processing_failed"]);

function boundedSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid privacy operation summary");
  const summary = {};
  for (const [key, count] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000) {
      throw new Error("invalid privacy operation summary");
    }
    summary[key] = count;
  }
  return summary;
}

export function validatePrivacyDeletionPolicy(policy) {
  if (!policy || policy.version !== 1 || policy.enabled !== true || !policy.categories
    || typeof policy.categories !== "object" || Array.isArray(policy.categories)) {
    const error = new Error("privacy deletion policy is missing or disabled");
    error.code = "policy_missing";
    throw error;
  }
  for (const category of CATEGORIES) {
    if (!POLICY_MODES[category].has(policy.categories[category])) {
      const error = new Error(`privacy deletion policy does not enable ${category}`);
      error.code = "policy_missing";
      throw error;
    }
  }
  return policy;
}

function failureCode(category, error) {
  if (FAILURE_CODES.has(error?.code)) return error.code;
  return ({ access: "access_revocation_failed", account: "account_cleanup_failed",
    assignments: "assignment_cleanup_failed", tasks: "task_cleanup_failed", media: "media_cleanup_failed",
    shared_records: "shared_record_cleanup_failed", audit: "audit_write_failed" })[category] ?? "processing_failed";
}

function defaultTombstone({ requestId }) {
  return `deleted-${requestId.replaceAll("-", "").slice(0, 24)}`;
}

export function createPrivacyDeletionProcessor({ requestStore, policy, operations,
  resolveTombstone = defaultTombstone }) {
  if (!requestStore?.claimProcessing || !requestStore?.checkpoint || !requestStore?.markProcessingFailed
    || !requestStore?.markCompleted) throw new TypeError("privacy processor requires request store processing methods");
  if (!operations || typeof operations !== "object") throw new TypeError("privacy processor requires operations");
  if (typeof resolveTombstone !== "function") throw new TypeError("privacy processor requires a tombstone resolver");

  async function plan(requestId, { authorize = null } = {}) {
    validatePrivacyDeletionPolicy(policy);
    if (authorize) await authorize();
    const request = requestStore.getForProcessing(requestId);
    if (!request || !["account_locked", "processing", "retryable_failed", "completed"].includes(request.status)) {
      throw new Error("privacy request is not ready for processing");
    }
    if (request.status === "completed") return { requestId, categories: structuredClone(request.progress ?? {}) };
    if (!request.accountUsername) throw new Error("privacy request is not ready for processing");
    const categories = {};
    for (const category of CATEGORIES) {
      const operation = operations[category];
      if (!operation?.plan || !operation?.apply) throw new TypeError(`privacy operation ${category} is incomplete`);
      categories[category] = boundedSummary(await operation.plan({ username: request.accountUsername,
        tombstone: request.tombstone ?? null, requestId, mode: policy.categories[category] }));
    }
    return { requestId, categories };
  }

  async function process(requestId, { dryRun = false, authorize = null } = {}) {
    const planned = await plan(requestId, { authorize });
    // Planning can await several repositories. Recheck before returning its
    // aggregate result or beginning the durable claim.
    if (authorize) await authorize();
    const current = requestStore.getForProcessing(requestId);
    if (current?.status === "completed") return { requestId, status: "completed", claimed: false };
    if (dryRun) return { ...planned, dryRun: true };
    const tombstone = await resolveTombstone({ requestId, username: current.accountUsername,
      tombstone: current.tombstone ?? null });
    const claim = requestStore.claimProcessing(requestId, tombstone);
    if (!claim) return { requestId, status: requestStore.getForProcessing(requestId)?.status ?? "unavailable", claimed: false };
    const { request, processingToken } = claim;
    try {
      for (const category of CATEGORIES) {
        if (request.progress?.[category]) continue;
        let result;
        try {
          // A deletion may span slow repositories. Re-check the initiating
          // principal immediately before every irreversible category rather
          // than allowing a revoked administrator to finish stale work.
          if (authorize) {
            try { await authorize(); }
            catch {
              requestStore.markProcessingFailed(requestId, processingToken, "authorization_revoked");
              return { requestId, status: "retryable_failed", failureCode: "authorization_revoked" };
            }
          }
          result = boundedSummary(await operations[category].apply({ username: request.accountUsername,
            tombstone: request.tombstone, requestId, mode: policy.categories[category], authorize }));
        } catch (error) {
          requestStore.markProcessingFailed(requestId, processingToken, failureCode(category, error));
          return { requestId, status: "retryable_failed", failureCode: failureCode(category, error) };
        }
        if (!requestStore.checkpoint(requestId, processingToken, category, result)) {
          return { requestId, status: "stale", claimed: false };
        }
      }
      const completed = requestStore.markCompleted(requestId, processingToken);
      return { requestId, status: completed?.status ?? "stale", claimed: Boolean(completed) };
    } catch {
      requestStore.markProcessingFailed(requestId, processingToken, "processing_failed");
      return { requestId, status: "retryable_failed", failureCode: "processing_failed" };
    }
  }

  return { plan, process, recoverInterrupted: () => requestStore.recoverInterrupted() };
}

export const PRIVACY_DELETION_CATEGORIES = CATEGORIES;
