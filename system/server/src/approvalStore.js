// Approval gate for actions whose policy is REQUIRE_APPROVAL (roadmap MS10.4).
//
// The AI asks; a human decides; the approval is bound to the exact action, target and
// comment wording, so an approved comment cannot be swapped for a different one, and
// it is single-use. States:
//
//   PENDING -> APPROVED -> CONSUMED        (executed once)
//      |           \-> EXPIRED             (not used in time)
//      \-> REJECTED | EXPIRED

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeComment } from "./commentGuard.js";

export const APPROVAL_STATES = Object.freeze({
  PENDING: "PENDING", APPROVED: "APPROVED", REJECTED: "REJECTED", EXPIRED: "EXPIRED", CONSUMED: "CONSUMED",
});

export class ApprovalError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

export function approvalFingerprint({ workspaceId, accountId, action, target, commentText }) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([workspaceId, accountId, action, target ?? "", commentText == null ? "" : normalizeComment(commentText)]))
    .digest("hex");
}

export class ApprovalStore {
  constructor({ filePath = null, now = () => Date.now(), ttlMs = 24 * 3_600_000 } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.ttlMs = ttlMs;
    this.items = [];
    if (filePath && fs.existsSync(filePath)) {
      try { this.items = JSON.parse(fs.readFileSync(filePath, "utf8")).approvals ?? []; } catch { this.items = []; }
    }
  }

  _save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ approvals: this.items }, null, 2));
    fs.renameSync(temporary, this.filePath);
  }

  _expire() {
    const at = this.now();
    let changed = false;
    for (const item of this.items) {
      if ([APPROVAL_STATES.PENDING, APPROVAL_STATES.APPROVED].includes(item.state) && at > item.expiresAt) {
        item.state = APPROVAL_STATES.EXPIRED;
        item.decidedAt = at;
        changed = true;
      }
    }
    if (changed) this._save();
  }

  // Asking twice for the same thing returns the same open request instead of a pile of them.
  request({ workspaceId, accountId, taskId = null, deviceId = null, action, target = null, commentText = null, requestedBy = null, context = null }) {
    this._expire();
    const fingerprint = approvalFingerprint({ workspaceId, accountId, action, target, commentText });
    const open = this.items.find(item => item.fingerprint === fingerprint
      && [APPROVAL_STATES.PENDING, APPROVAL_STATES.APPROVED].includes(item.state));
    if (open) return open;
    const at = this.now();
    const approval = {
      id: `apr-${crypto.randomUUID()}`, fingerprint, workspaceId, accountId, taskId, deviceId, action, target,
      commentText, requestedBy, context, state: APPROVAL_STATES.PENDING,
      requestedAt: at, expiresAt: at + this.ttlMs, decidedAt: null, decidedBy: null, reason: null,
    };
    this.items.push(approval);
    this._save();
    return approval;
  }

  decide(id, { decision, decidedBy, reason = null }) {
    this._expire();
    const approval = this.items.find(item => item.id === id);
    if (!approval) throw new ApprovalError("Unknown approval.", "unknown_approval");
    if (approval.state !== APPROVAL_STATES.PENDING) {
      throw new ApprovalError(`This request is already ${approval.state.toLowerCase()}.`, "not_pending");
    }
    if (!["approve", "reject"].includes(decision)) throw new ApprovalError("Decision must be approve or reject.", "bad_decision");
    approval.state = decision === "approve" ? APPROVAL_STATES.APPROVED : APPROVAL_STATES.REJECTED;
    approval.decidedAt = this.now();
    approval.decidedBy = decidedBy ?? null;
    approval.reason = typeof reason === "string" ? reason.slice(0, 300) : null;
    // Approval starts a fresh window to actually use it.
    if (approval.state === APPROVAL_STATES.APPROVED) approval.expiresAt = this.now() + this.ttlMs;
    this._save();
    return approval;
  }

  // Is there an unused approval for exactly this? (Does not use it up.)
  findApproved(subject) {
    this._expire();
    const fingerprint = approvalFingerprint(subject);
    return this.items.find(item => item.fingerprint === fingerprint && item.state === APPROVAL_STATES.APPROVED) ?? null;
  }

  // Single use: called after the action executed and verified.
  consume(id) {
    this._expire();
    const approval = this.items.find(item => item.id === id);
    if (!approval || approval.state !== APPROVAL_STATES.APPROVED) return null;
    approval.state = APPROVAL_STATES.CONSUMED;
    approval.consumedAt = this.now();
    this._save();
    return approval;
  }

  get(id) {
    this._expire();
    return this.items.find(item => item.id === id) ?? null;
  }

  list({ workspaceId = null, states = null } = {}) {
    this._expire();
    return this.items
      .filter(item => (!workspaceId || item.workspaceId === workspaceId) && (!states || states.includes(item.state)))
      .sort((a, b) => b.requestedAt - a.requestedAt);
  }
}
