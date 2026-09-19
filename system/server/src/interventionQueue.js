// The human intervention queue (roadmap MS12.3): everything an AI worker has stopped
// and needs a person for, in one list a supervisor can work through. Items come from
// tasks that hand off (a challenge, low confidence, an unconfirmed action), from
// comments the guard refused, and from approvals waiting for a decision.
//
//   OPEN -> CLAIMED (someone is on it) -> RESOLVED
//
// Resolved items are kept: they are the raw material for the intervention analytics.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const INTERVENTION_STATES = Object.freeze({ OPEN: "OPEN", CLAIMED: "CLAIMED", RESOLVED: "RESOLVED" });
export const INTERVENTION_KINDS = Object.freeze({
  CHALLENGE: "challenge",            // captcha / MFA / security review: a person must handle it
  LOW_CONFIDENCE: "low_confidence",
  APPROVAL: "approval",              // an action waits for a decision
  COMMENT_REJECTED: "comment_rejected",
  UNCONFIRMED_ACTION: "unconfirmed_action",
  LEASE_REVOKED: "lease_revoked",    // a human took the phone over
  OTHER: "other",
});

// Best-effort classification of a worker's hand-off message into a kind.
export function classifyIntervention(detail = "") {
  const text = String(detail).toLowerCase();
  if (/security or account challenge|captcha|mfa|challenge/.test(text)) return INTERVENTION_KINDS.CHALLENGE;
  if (/confidence/.test(text)) return INTERVENTION_KINDS.LOW_CONFIDENCE;
  if (/waiting for approval|requires explicit approval/.test(text)) return INTERVENTION_KINDS.APPROVAL;
  if (/comment not sent/.test(text)) return INTERVENTION_KINDS.COMMENT_REJECTED;
  if (/could not be confirmed|check the account/.test(text)) return INTERVENTION_KINDS.UNCONFIRMED_ACTION;
  if (/lease was revoked|took over|takeover/.test(text)) return INTERVENTION_KINDS.LEASE_REVOKED;
  return INTERVENTION_KINDS.OTHER;
}

export class InterventionQueue {
  constructor({ filePath = null, now = () => Date.now(), maxResolved = 2000 } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.maxResolved = maxResolved;
    this.items = [];
    if (filePath && fs.existsSync(filePath)) {
      try { this.items = JSON.parse(fs.readFileSync(filePath, "utf8")).items ?? []; } catch { this.items = []; }
    }
  }

  _save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ items: this.items }));
    fs.renameSync(temporary, this.filePath);
  }

  // One open item per task and kind: a worker that keeps handing off the same problem
  // does not bury the queue.
  open({ taskId, deviceId = null, accountId = null, workspaceId = null, platform = null, kind = null, reason = "", ref = null }) {
    const resolvedKind = kind ?? classifyIntervention(reason);
    const existing = this.items.find(item => item.taskId === taskId && item.kind === resolvedKind && item.state !== INTERVENTION_STATES.RESOLVED);
    if (existing) return existing;
    const item = { id: `int-${crypto.randomUUID()}`, taskId, deviceId, accountId, workspaceId, platform, kind: resolvedKind,
      reason: String(reason).slice(0, 300), ref, state: INTERVENTION_STATES.OPEN, createdAt: this.now(),
      claimedBy: null, claimedAt: null, resolvedBy: null, resolvedAt: null, resolution: null };
    this.items.push(item);
    this._trim();
    this._save();
    return item;
  }

  claim(id, by) {
    const item = this.items.find(entry => entry.id === id);
    if (!item) throw new Error("Unknown intervention.");
    if (item.state === INTERVENTION_STATES.RESOLVED) throw new Error("That intervention is already resolved.");
    if (item.state === INTERVENTION_STATES.CLAIMED && item.claimedBy !== by) throw new Error(`Already claimed by ${item.claimedBy}.`);
    item.state = INTERVENTION_STATES.CLAIMED;
    item.claimedBy = by;
    item.claimedAt = this.now();
    this._save();
    return item;
  }

  resolve(id, { by = "system", resolution = null } = {}) {
    const item = this.items.find(entry => entry.id === id);
    if (!item) throw new Error("Unknown intervention.");
    if (item.state === INTERVENTION_STATES.RESOLVED) return item;
    item.state = INTERVENTION_STATES.RESOLVED;
    item.resolvedBy = by;
    item.resolvedAt = this.now();
    item.resolution = resolution ? String(resolution).slice(0, 300) : null;
    this._trim();
    this._save();
    return item;
  }

  // When a task moves on by itself (resumed, cancelled, finished) its open items close.
  resolveForTask(taskId, { by = "system", resolution = "task moved on" } = {}) {
    let changed = 0;
    for (const item of this.items) {
      if (item.taskId === taskId && item.state !== INTERVENTION_STATES.RESOLVED) {
        item.state = INTERVENTION_STATES.RESOLVED;
        item.resolvedBy = by;
        item.resolvedAt = this.now();
        item.resolution = resolution;
        changed += 1;
      }
    }
    if (changed) { this._trim(); this._save(); }
    return changed;
  }

  list({ states = null, workspaceId = null, workspaceIds = null } = {}) {
    return this.items
      .filter(item => (!states || states.includes(item.state))
        && (!workspaceId || item.workspaceId === workspaceId)
        && (!workspaceIds || workspaceIds.includes(item.workspaceId)))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  counts() {
    const counts = { OPEN: 0, CLAIMED: 0, RESOLVED: 0 };
    for (const item of this.items) counts[item.state] += 1;
    return counts;
  }

  _trim() {
    const resolved = this.items.filter(item => item.state === INTERVENTION_STATES.RESOLVED);
    if (resolved.length > this.maxResolved) {
      const drop = new Set(resolved.slice(0, resolved.length - this.maxResolved).map(item => item.id));
      this.items = this.items.filter(item => !drop.has(item.id));
    }
  }
}
