import crypto from "node:crypto";

const MAX_IDENTIFIER_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 512;
const CONFIRMATION = "DELETE MY ACCOUNT";
const GENERIC_PUBLIC_MESSAGE = "If the account can be matched, the deletion request has been recorded for identity verification.";

function normalizedIdentifier(value, normalizeEmail) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) return null;
  if (normalized.includes("@")) {
    try { return normalizeEmail(normalized); }
    catch { return null; }
  }
  return /^[a-z0-9][a-z0-9_.-]{0,99}$/.test(normalized) ? normalized : null;
}

function identifierDigest(identifier, hmacKey) {
  return crypto.createHmac("sha256", hmacKey).update(identifier).digest("hex");
}

function findAccount(accounts, identifier) {
  return accounts.find(account => account.username.toLowerCase() === identifier
    || account.email?.toLowerCase() === identifier) ?? null;
}

export function registerPrivacyRoutes({
  app,
  requireAuth,
  accountService,
  requestStore,
  hmacKey,
  resolveCurrentSession,
  revokeAccountAccess,
  destroyCurrentSession,
  recordAudit,
  logFailure,
  allowPublicRequest,
  buildDataExport,
  normalizeEmail,
  deletionProcessor = null,
  requirePrivacyAdmin = null,
  authorizePrivacyAdmin = null,
  // Deleting SOMEONE ELSE's account (a higher role, in order): decides who may, throwing a status error otherwise.
  authorizeAccountDeletion = null,
  afterAccountsChanged = () => {},
}) {
  if (!app || typeof app.post !== "function" || typeof app.get !== "function") throw new TypeError("privacy routes require app");
  if (typeof requireAuth !== "function") throw new TypeError("privacy routes require requireAuth");
  if (!accountService || typeof accountService.listAccounts !== "function"
    || typeof accountService.validateDeletion !== "function"
    || typeof accountService.requestDeletion !== "function") {
    throw new TypeError("privacy routes require accountService");
  }
  if (!requestStore || typeof requestStore.createPublic !== "function"
    || typeof requestStore.createVerified !== "function") {
    throw new TypeError("privacy routes require requestStore");
  }
  if (typeof hmacKey !== "string" || hmacKey.length < 16) throw new TypeError("privacy routes require an HMAC key");
  if (typeof resolveCurrentSession !== "function" || typeof revokeAccountAccess !== "function"
    || typeof destroyCurrentSession !== "function") {
    throw new TypeError("privacy routes require account revocation dependencies");
  }
  if (typeof allowPublicRequest !== "function") throw new TypeError("privacy routes require a public-request throttle");
  if (typeof buildDataExport !== "function") throw new TypeError("privacy routes require a data-export builder");
  if (typeof normalizeEmail !== "function") throw new TypeError("privacy routes require an email normalizer");
  if ((deletionProcessor && (typeof requirePrivacyAdmin !== "function" || typeof authorizePrivacyAdmin !== "function"))
    || (requirePrivacyAdmin && (!deletionProcessor?.plan || !deletionProcessor?.process))) {
    throw new TypeError("privacy processing routes require a processor and admin authorization");
  }

  app.post("/api/privacy/deletion-requests", async (req, res, next) => {
    try {
      const identifier = normalizedIdentifier(req.body?.identifier, normalizeEmail);
      if (!identifier) return res.status(400).json({ error: "A valid account username or email is required." });
      if (!allowPublicRequest({ identifier, ip: req.ip })) {
        return res.status(429).json({ error: "Too many deletion requests. Try again later.", code: "RATE_LIMITED" });
      }
      const account = findAccount(await accountService.listAccounts(), identifier);
      requestStore.createPublic({
        lookupDigest: identifierDigest(identifier, hmacKey),
        accountUsername: account?.username ?? null,
      });
      res.status(202).json({ ok: true, message: GENERIC_PUBLIC_MESSAGE });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/me/deletion-request", requireAuth, async (req, res, next) => {
    const username = req.currentOperator.username;
    const password = req.body?.password;
    if (typeof password !== "string" || !password || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ error: "Your current password is required." });
    }
    if (req.body?.confirmation !== CONFIRMATION) {
      return res.status(400).json({ error: `Type ${CONFIRMATION} to confirm this request.` });
    }

    let request;
    let accountLocked = false;
    try {
      const authorize = async () => {
        const current = await resolveCurrentSession(req);
        if (!current || current.username !== username) {
          const error = new Error("not logged in");
          error.status = 401;
          throw error;
        }
      };
      // Reject a bad password or protected-account invariant before creating
      // a verified privacy request. The mutation repeats both checks below.
      await accountService.validateDeletion(username, password, { authorize });
      request = requestStore.createVerified({
        lookupDigest: identifierDigest(username.toLowerCase(), hmacKey),
        accountUsername: username,
      });
      await accountService.requestDeletion(username, password, {
        // The request object's snapshot can outlive a concurrent logout.
        // Re-read the authoritative session store at the commit point.
        authorize,
      });
      accountLocked = true;

      try { revokeAccountAccess(username, req.sessionID); }
      catch (error) { logFailure?.("Privacy request live-access revocation failed", error); }
      try { requestStore.markAccountLocked(request.id); }
      catch (error) { logFailure?.("Privacy request completion-state write failed", error); }
      try { recordAudit?.({ operator: username, type: "account_deletion_requested" }); }
      catch (error) { logFailure?.("Privacy request audit write failed", error); }
      try { await destroyCurrentSession(req); }
      catch (error) { logFailure?.("Privacy request session-destroy failed", error); }
      res.status(202).json({ ok: true, requestId: request.id, status: "account_locked" });
    } catch (error) {
      if (accountLocked) {
        logFailure?.("Privacy request post-commit handling failed", error);
        return res.status(202).json({ ok: true, requestId: request?.id ?? null, status: "account_locked" });
      }
      if (request) {
        try { requestStore.markFailed(request.id); }
        catch (storeError) { logFailure?.("Privacy request failure-state write failed", storeError); }
      }
      if (error?.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  // Delete an account that is below yours (Host over Admin, Admin over Manager, a manager over their own team's
  // members). The account is locked at once exactly as if its owner had asked, and the privacy process then removes
  // its data. Typing the username confirms it; the rules themselves are enforced by `authorizeAccountDeletion`.
  if (typeof authorizeAccountDeletion === "function" && typeof accountService.requestDeletionByAuthority === "function") {
    app.delete("/api/admin/users/:username", requireAuth, async (req, res, next) => {
      const username = req.params.username;
      let request = null;
      let accountLocked = false;
      try {
        if (req.body?.confirmUsername !== username) {
          return res.status(400).json({ error: "Type the person's username to confirm.", code: "CONFIRMATION_REQUIRED" });
        }
        const actor = await authorizeAccountDeletion(req, username);
        request = requestStore.createVerified({
          lookupDigest: identifierDigest(username.toLowerCase(), hmacKey),
          accountUsername: username,
        });
        await accountService.requestDeletionByAuthority(username, {
          actor: actor.username,
          // The commit point: the same rules are checked again against the stored accounts.
          authorize: () => authorizeAccountDeletion(req, username),
        });
        accountLocked = true;
        try { revokeAccountAccess(username, null); }
        catch (error) { logFailure?.("Account deletion live-access revocation failed", error); }
        try { requestStore.markAccountLocked(request.id); }
        catch (error) { logFailure?.("Account deletion request-state write failed", error); }
        try { recordAudit?.({ operator: actor.username, type: "account_deleted_by_authority", detail: { target: username, requestId: request.id } }); }
        catch (error) { logFailure?.("Account deletion audit write failed", error); }
        try { afterAccountsChanged(); }
        catch (error) { logFailure?.("Account deletion refresh failed", error); }
        return res.json({ ok: true, requestId: request.id, status: "account_locked" });
      } catch (error) {
        if (accountLocked) {
          logFailure?.("Account deletion post-commit handling failed", error);
          return res.json({ ok: true, requestId: request?.id ?? null, status: "account_locked" });
        }
        if (request) {
          try { requestStore.markFailed(request.id); }
          catch (storeError) { logFailure?.("Account deletion failure-state write failed", storeError); }
        }
        if (error?.status) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
        next(error);
      }
    });
  }

  app.get("/api/me/data-export", requireAuth, async (req, res, next) => {
    const username = req.currentOperator.username;
    try {
      const data = await buildDataExport(username);
      // Collection can cross repository boundaries. Recheck the stored
      // session after that work and before publishing private account data.
      const current = await resolveCurrentSession(req);
      if (!current || current.username !== username) {
        return res.status(401).json({ error: "not logged in" });
      }
      try { recordAudit?.({ operator: username, type: "account_data_exported" }); }
      catch (error) { logFailure?.("Privacy export audit write failed", error); }
      res.setHeader("Content-Disposition", `attachment; filename="phone-farm-${username}-data.json"`);
      res.setHeader("Cache-Control", "no-store");
      return res.json(data);
    } catch (error) {
      next(error);
    }
  });

  if (deletionProcessor) {
    app.get("/api/admin/privacy/deletion-requests/:requestId/plan", requirePrivacyAdmin, async (req, res, next) => {
      try {
        const plan = await deletionProcessor.plan(req.params.requestId, {
          authorize: () => authorizePrivacyAdmin(req),
        });
        await authorizePrivacyAdmin(req);
        return res.json(plan);
      } catch (error) {
        if (error?.code === "policy_missing") return res.status(503).json({ error: "Privacy deletion policy is not configured.", code: "POLICY_MISSING" });
        if (error?.code === "tombstone_collision") return res.status(409).json({
          error: "Privacy deletion cannot proceed because its anonymized identity is unavailable.",
          code: "TOMBSTONE_COLLISION",
        });
        next(error);
      }
    });
    app.post("/api/admin/privacy/deletion-requests/:requestId/process", requirePrivacyAdmin, async (req, res, next) => {
      try {
        // The processor owns durable checkpoints and rechecks this callback
        // immediately before its claim and each destructive category.
        const result = await deletionProcessor.process(req.params.requestId, {
          dryRun: req.body?.dryRun === true,
          authorize: () => authorizePrivacyAdmin(req),
        });
        return res.status(result.status === "retryable_failed" ? 503 : 200).json(result);
      } catch (error) {
        if (error?.code === "policy_missing") return res.status(503).json({ error: "Privacy deletion policy is not configured.", code: "POLICY_MISSING" });
        if (error?.code === "tombstone_collision") return res.status(409).json({
          error: "Privacy deletion cannot proceed because its anonymized identity is unavailable.",
          code: "TOMBSTONE_COLLISION",
        });
        next(error);
      }
    });
  }

  return { confirmationText: CONFIRMATION, genericPublicMessage: GENERIC_PUBLIC_MESSAGE };
}
