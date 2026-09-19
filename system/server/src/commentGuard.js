// Comment safety enforced in application logic, never left to a model prompt
// (roadmap MS10.2/MS10.3). Every comment is checked here before it can reach a
// phone, and is recorded exactly as sent afterwards.
//
//  - duplicates: the same account never posts the same text again inside the window,
//    nor a near-duplicate of it (word-bigram similarity), nor a second comment on the
//    same piece of content;
//  - rate: hourly and daily caps per account;
//  - grounding: a model-generated comment must actually refer to the content it sits
//    under (shares a meaningful word with the caption/text/tags/author);
//  - presets must be an approved template, word for word.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STOP_WORDS = new Set(("that this with have from they will your what when where which their about there would could should " +
  "been were just like really very much more some than then them these those into over also only such because").split(" "));

export const DEFAULT_COMMENT_POLICY = Object.freeze({
  maxLength: 500,
  duplicateWindowMs: 7 * DAY,
  nearDuplicateThreshold: 0.8,
  perHour: 6,
  perDay: 40,
});

export function normalizeComment(text) {
  return String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}

function shingles(normalized) {
  const words = normalized.split(" ").filter(Boolean);
  if (words.length < 2) return new Set(words);
  const set = new Set();
  for (let index = 0; index < words.length - 1; index += 1) set.add(`${words[index]} ${words[index + 1]}`);
  return set;
}

// Jaccard similarity of word bigrams: 1 = identical wording, 0 = nothing in common.
export function similarity(a, b) {
  const left = shingles(normalizeComment(a));
  const right = shingles(normalizeComment(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function significantWords(text) {
  return new Set(normalizeComment(text).split(" ").filter(word => word.length >= 4 && !STOP_WORDS.has(word)));
}

// Persistent record of what each account has actually posted.
export class CommentLedger {
  constructor({ filePath = null, now = () => Date.now(), retentionMs = 30 * DAY } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.retentionMs = retentionMs;
    this.entries = [];
    if (filePath && fs.existsSync(filePath)) {
      try { this.entries = JSON.parse(fs.readFileSync(filePath, "utf8")).entries ?? []; } catch { this.entries = []; }
    }
  }

  _save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ entries: this.entries }));
    fs.renameSync(temporary, this.filePath);
  }

  // `text` is stored exactly as it was sent (CLAUDE.md §9).
  record({ workspaceId, accountId, platform, contentKey, text, source, taskId = null }) {
    const entry = { id: crypto.randomUUID(), workspaceId, accountId, platform, contentKey: contentKey ?? null,
      text, normalized: normalizeComment(text), source, taskId, at: this.now() };
    this.entries.push(entry);
    const cutoff = this.now() - this.retentionMs;
    this.entries = this.entries.filter(item => item.at >= cutoff);
    this._save();
    return entry;
  }

  forAccount(workspaceId, accountId, sinceMs = Infinity) {
    const since = this.now() - sinceMs; // -Infinity when no window is given: everything on record
    return this.entries.filter(item => item.workspaceId === workspaceId && item.accountId === accountId && item.at >= since);
  }
}

// Returns { ok, reasons[] }. Never throws for a rejected comment; the caller decides
// whether that stops the task or just this action.
export function checkComment({
  text, source, contentKey = null, workspaceId, accountId, ledger, groundingText = "", template = null,
  policy = DEFAULT_COMMENT_POLICY,
} = {}) {
  const limits = { ...DEFAULT_COMMENT_POLICY, ...policy };
  const reasons = [];
  const body = typeof text === "string" ? text.trim() : "";
  if (!body) return { ok: false, reasons: ["empty"] };
  if (body.length > limits.maxLength) reasons.push("too_long");
  const normalized = normalizeComment(body);
  if (!normalized) reasons.push("no_words");

  const urls = body.match(/https?:\/\/\S+/g) ?? [];
  if (urls.some(url => !String(groundingText).includes(url))) reasons.push("unexpected_link");

  if (source === "preset") {
    if (!template || normalizeComment(template.text) !== normalized) reasons.push("unknown_template");
  } else if (source === "generated") {
    const wanted = significantWords(groundingText);
    const mine = significantWords(body);
    if (!wanted.size || ![...mine].some(word => wanted.has(word))) reasons.push("not_grounded");
  } else {
    reasons.push("unknown_source");
  }

  if (ledger) {
    const previous = ledger.forAccount(workspaceId, accountId, limits.duplicateWindowMs);
    if (contentKey && previous.some(item => item.contentKey === contentKey)) reasons.push("already_commented");
    if (previous.some(item => item.normalized === normalized)) reasons.push("duplicate_exact");
    else if (previous.some(item => similarity(item.text, body) >= limits.nearDuplicateThreshold)) reasons.push("duplicate_near");
    const lastHour = ledger.forAccount(workspaceId, accountId, HOUR).length;
    const lastDay = ledger.forAccount(workspaceId, accountId, DAY).length;
    if (lastHour >= limits.perHour || lastDay >= limits.perDay) reasons.push("rate_limited");
  }
  return { ok: reasons.length === 0, reasons };
}

export const COMMENT_REJECTION_TEXT = Object.freeze({
  empty: "the comment is empty",
  too_long: "the comment is too long",
  no_words: "the comment has no words",
  unexpected_link: "the comment contains a link that is not in the content",
  unknown_template: "the preset does not match an approved template",
  not_grounded: "the comment does not refer to the content it is under",
  unknown_source: "the comment source is not recognised",
  already_commented: "this account already commented on this content",
  duplicate_exact: "this account already posted this exact comment recently",
  duplicate_near: "this comment is almost identical to a recent one",
  rate_limited: "this account reached its comment limit for now",
});
