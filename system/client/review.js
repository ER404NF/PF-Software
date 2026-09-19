// Review panel: the three things a person does around AI research that are not the phone itself.
//   Approvals        decide actions the AI wants to take on an account (MS10.4)
//   Needs a person   the queue of everything the AI stopped on and handed back (MS12.3)
//   Action policy    which actions each account may do on its own, with approval, or never (MS10.1)
// It never sends device input. Every button only calls the same authorized HTTP routes the server
// checks again; what is shown or hidden here is convenience, not the security boundary.

const reviewPanel = document.getElementById("review-panel");
const reviewToggle = document.getElementById("review-toggle");
const reviewTabs = [...document.querySelectorAll("[data-review-tab]")];
const reviewAccount = document.getElementById("review-account");
const reviewAccountRow = document.getElementById("review-account-row");
const reviewMessage = document.getElementById("review-message");
const reviewBody = document.getElementById("review-body");
let reviewEpoch = 0;
let reviewTab = "approvals";

const REVIEW_CAPS = Object.freeze({ VIEW: "research:view", APPROVE: "research:approve", POLICY: "research:policy", QUEUE: "queue:manage" });
const canReview = capability => typeof window.phoneFarmCan === "function" && window.phoneFarmCan(capability) === true;

const KIND_LABELS = Object.freeze({
  challenge: "Security check (captcha, code or review)",
  low_confidence: "The AI was not sure what it was looking at",
  approval: "Waiting for an approval",
  comment_rejected: "A comment was not sent",
  unconfirmed_action: "An action could not be confirmed",
  lease_revoked: "A person took the phone over",
  other: "Needs attention",
});
const ACTION_LABELS = Object.freeze({
  observe: "Look at the screen", open_feed: "Open the feed", search: "Search", open_post: "Open a post", open_profile: "Open a profile",
  open_thread: "Open a thread", scroll_next: "Scroll to the next post", scroll_previous: "Scroll back", open_comments: "Open comments",
  capture: "Record what it sees", capture_screenshot: "Take a screenshot", copy_link: "Copy a link", extract_visible: "Read visible text",
  platform_save: "Save / bookmark (private)", platform_unsave: "Remove save / bookmark",
  like: "Like", unlike: "Remove like", upvote: "Upvote", downvote: "Downvote", clear_vote: "Clear vote",
  repost: "Repost", undo_repost: "Undo repost",
  comment_preset: "Comment (saved wording)", comment_generated: "Comment (AI-written)",
  reply_preset: "Reply (saved wording)", reply_generated: "Reply (AI-written)",
});
// The same groups the server's action catalog uses; anything new lands in "Other".
const ACTION_GROUPS = Object.freeze([
  ["Looking around (nothing is changed)", ["observe", "open_feed", "search", "open_post", "open_profile", "open_thread", "scroll_next", "scroll_previous", "open_comments", "capture", "capture_screenshot", "copy_link", "extract_visible"]],
  ["Private markers (only this account sees them)", ["platform_save", "platform_unsave"]],
  ["Visible to other people", ["like", "unlike", "upvote", "downvote", "clear_vote", "repost", "undo_repost"]],
  ["Comments and replies (visible to other people)", ["comment_preset", "comment_generated", "reply_preset", "reply_generated"]],
]);
const POLICY_LABELS = Object.freeze({ ALLOW_AUTONOMOUS: "AI may do this on its own", REQUIRE_APPROVAL: "Ask a person first", DISABLED: "Never" });

const actionLabel = action => ACTION_LABELS[action] ?? String(action).replace(/_/g, " ");

function el(parent, tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function ago(timestamp) {
  const value = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(value)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - value) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

async function reviewFetch(url, options) {
  if (typeof window.phoneFarmRequestJson !== "function") throw new Error("Phone Farm request service is unavailable. Refresh and try again.");
  const { body } = await window.phoneFarmRequestJson(url, options, {
    timeoutMs: 10_000,
    uncertain: ["POST", "PATCH", "PUT", "DELETE"].includes(options?.method),
  });
  return body;
}

const jsonBody = (method, payload) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload ?? {}) });

function reviewReset() {
  reviewEpoch += 1;
  reviewPanel.hidden = true;
  reviewToggle.setAttribute("aria-expanded", "false");
  reviewAccount.replaceChildren();
  reviewBody.replaceChildren();
  reviewMessage.textContent = "";
}

function visibleTabs() {
  return { approvals: canReview(REVIEW_CAPS.VIEW), queue: canReview(REVIEW_CAPS.QUEUE), policy: canReview(REVIEW_CAPS.VIEW) };
}

function refreshToggle() {
  const tabs = visibleTabs();
  reviewToggle.hidden = !(tabs.approvals || tabs.queue);
  for (const button of reviewTabs) button.hidden = !tabs[button.dataset.reviewTab];
  if (reviewToggle.hidden && !reviewPanel.hidden) reviewReset();
}

// The event fires before app.js has stored the new profile, so check on the next turn.
window.addEventListener("operator-profile-changed", () => { reviewReset(); setTimeout(refreshToggle, 0); });

function selectTab(name) {
  reviewTab = name;
  for (const button of reviewTabs) button.setAttribute("aria-selected", String(button.dataset.reviewTab === name));
  reviewAccountRow.hidden = name === "queue";
  return loadReviewTab();
}

async function loadAccounts(epoch) {
  const { accounts } = await reviewFetch("/api/research");
  if (epoch !== reviewEpoch) return false;
  const previous = reviewAccount.value;
  reviewAccount.replaceChildren();
  for (const account of accounts) {
    const option = el(reviewAccount, "option", `${account.workspaceId} / ${account.id}`);
    option.value = account.id;
  }
  if (previous && accounts.some(account => account.id === previous)) reviewAccount.value = previous;
  return accounts.length > 0;
}

async function loadReviewTab() {
  const epoch = ++reviewEpoch;
  reviewBody.replaceChildren();
  reviewMessage.textContent = "Loading…";
  try {
    if (reviewTab === "queue") return await renderQueue(epoch);
    if (!reviewAccount.options.length && !(await loadAccounts(epoch))) {
      if (epoch === reviewEpoch) reviewMessage.textContent = "No research accounts are assigned to you. Ask an administrator to give you access.";
      return undefined;
    }
    return reviewTab === "policy" ? await renderPolicy(epoch) : await renderApprovals(epoch);
  } catch (error) {
    if (epoch === reviewEpoch) reviewMessage.textContent = error.message;
    return undefined;
  }
}

// ---- Approvals ---------------------------------------------------------------------------------

async function renderApprovals(epoch) {
  const account = reviewAccount.value;
  const { approvals } = await reviewFetch(`/api/research/${encodeURIComponent(account)}/approvals?state=PENDING`);
  if (epoch !== reviewEpoch) return;
  reviewMessage.textContent = approvals.length
    ? `${approvals.length} waiting for a decision.` : "Nothing is waiting for approval on this account.";
  const mayDecide = canReview(REVIEW_CAPS.APPROVE);
  for (const approval of approvals) {
    const card = el(reviewBody, "article", null, "review-card");
    el(card, "h3", actionLabel(approval.action));
    if (approval.target) el(card, "p", `On: ${approval.target}`);
    if (approval.commentText) {
      el(card, "p", "Exact wording that will be posted:", "review-label");
      el(card, "blockquote", approval.commentText);
    }
    if (approval.context?.reason) el(card, "p", `Why the AI wants to: ${approval.context.reason}`);
    el(card, "p", `Asked ${ago(approval.requestedAt)}${approval.requestedBy ? ` for ${approval.requestedBy}` : ""}.`, "review-meta");
    if (!mayDecide) {
      el(card, "p", "A manager or administrator decides this.", "review-meta");
      continue;
    }
    const reason = el(card, "input");
    reason.type = "text";
    reason.maxLength = 300;
    reason.placeholder = "Reason (optional)";
    reason.setAttribute("aria-label", "Reason for the decision");
    const controls = el(card, "div", null, "review-controls");
    for (const decision of ["approve", "reject"]) {
      const button = el(controls, "button", decision === "approve" ? "Approve" : "Reject");
      button.type = "button";
      button.addEventListener("click", () => decide(approval, decision, reason.value, controls));
    }
  }
}

async function decide(approval, decision, reason, controls) {
  const epoch = reviewEpoch;
  for (const button of controls.children) button.disabled = true;
  reviewMessage.textContent = "Saving decision…";
  try {
    const route = `/api/research/${encodeURIComponent(approval.accountId)}/approvals/${encodeURIComponent(approval.id)}/${decision}`;
    const result = await reviewFetch(route, jsonBody("POST", { reason: reason || undefined }));
    if (epoch !== reviewEpoch) return;
    await loadReviewTab();
    reviewMessage.textContent = result.note || "Decision saved.";
  } catch (error) {
    if (epoch !== reviewEpoch) return;
    reviewMessage.textContent = error.message;
    for (const button of controls.children) button.disabled = false;
  }
}

// ---- Needs a person ----------------------------------------------------------------------------

async function renderQueue(epoch) {
  const { interventions } = await reviewFetch("/api/fleet/interventions");
  if (epoch !== reviewEpoch) return;
  reviewMessage.textContent = interventions.length
    ? `${interventions.length} item(s) the AI has handed back to a person.` : "Nothing needs a person right now.";
  const me = window.phoneFarmUsername?.() ?? null;
  for (const item of interventions) {
    const card = el(reviewBody, "article", null, "review-card");
    el(card, "h3", KIND_LABELS[item.kind] ?? KIND_LABELS.other);
    if (item.reason) el(card, "p", item.reason);
    const where = [item.platform, item.accountId, item.deviceId].filter(Boolean).join(" · ");
    el(card, "p", `${where ? `${where} · ` : ""}${ago(item.createdAt)}`, "review-meta");
    if (item.state === "CLAIMED") el(card, "p", `Being handled by ${item.claimedBy}.`, "review-meta");
    const controls = el(card, "div", null, "review-controls");
    if (item.state === "OPEN" || (item.state === "CLAIMED" && item.claimedBy !== me)) {
      const claim = el(controls, "button", item.state === "OPEN" ? "I'll handle this" : "Take over");
      claim.type = "button";
      claim.addEventListener("click", () => act(item, "claim", null, controls));
    }
    const note = el(card, "input");
    note.type = "text";
    note.maxLength = 300;
    note.placeholder = "What you did (optional)";
    note.setAttribute("aria-label", "What you did to resolve this");
    const done = el(controls, "button", "Mark as done");
    done.type = "button";
    done.addEventListener("click", () => act(item, "resolve", note.value, controls));
  }
}

async function act(item, action, resolution, controls) {
  const epoch = reviewEpoch;
  for (const button of controls.children) button.disabled = true;
  reviewMessage.textContent = "Saving…";
  try {
    await reviewFetch(`/api/fleet/interventions/${encodeURIComponent(item.id)}/${action}`,
      jsonBody("POST", action === "resolve" ? { resolution: resolution || undefined } : {}));
    if (epoch !== reviewEpoch) return;
    await loadReviewTab();
  } catch (error) {
    if (epoch !== reviewEpoch) return;
    reviewMessage.textContent = error.message;
    for (const button of controls.children) button.disabled = false;
  }
}

// ---- Action policy -----------------------------------------------------------------------------

async function renderPolicy(epoch) {
  const account = reviewAccount.value;
  const { policies } = await reviewFetch(`/api/research/${encodeURIComponent(account)}/policies`);
  if (epoch !== reviewEpoch) return;
  const mayEdit = canReview(REVIEW_CAPS.POLICY);
  reviewMessage.textContent = mayEdit
    ? "Choose what the AI may do on this account. Every action starts as Never. Changes apply immediately."
    : "What the AI may do on this account. Only an administrator can change this.";
  const byAction = new Map(policies.map(entry => [entry.action, entry]));
  const grouped = new Set(ACTION_GROUPS.flatMap(([, actions]) => actions));
  const groups = [...ACTION_GROUPS, ["Other", policies.map(entry => entry.action).filter(action => !grouped.has(action))]];
  for (const [heading, actions] of groups) {
    const entries = actions.map(action => byAction.get(action)).filter(Boolean);
    if (!entries.length) continue;
    const list = el(reviewBody, "div", null, "review-policy");
    el(list, "h3", heading);
    for (const entry of entries) renderPolicyRow(list, entry, account, epoch, mayEdit);
  }
}

function renderPolicyRow(list, entry, account, epoch, mayEdit) {
  const row = el(list, "label", null, "review-policy-row");
  el(row, "span", actionLabel(entry.action));
  if (!mayEdit) {
    el(row, "strong", POLICY_LABELS[entry.policy] ?? entry.policy);
    return;
  }
  const select = el(row, "select");
  for (const [value, label] of Object.entries(POLICY_LABELS)) {
    const option = el(select, "option", label);
    option.value = value;
  }
  select.value = entry.policy;
  select.addEventListener("change", async () => {
    const wanted = select.value;
    select.disabled = true;
    reviewMessage.textContent = `Saving ${actionLabel(entry.action)}…`;
    try {
      const saved = await reviewFetch(`/api/research/${encodeURIComponent(account)}/policies/${encodeURIComponent(entry.action)}`,
        jsonBody("PUT", { policy: wanted }));
      if (epoch !== reviewEpoch) return;
      entry.policy = saved.policy.policy;
      select.value = entry.policy;
      reviewMessage.textContent = `${actionLabel(entry.action)}: ${POLICY_LABELS[entry.policy]}.`;
    } catch (error) {
      if (epoch !== reviewEpoch) return;
      select.value = entry.policy;
      reviewMessage.textContent = error.message;
    } finally {
      select.disabled = false;
    }
  });
}

// ---- wiring ------------------------------------------------------------------------------------

reviewToggle.addEventListener("click", async () => {
  if (!reviewPanel.hidden) return reviewReset();
  reviewPanel.hidden = false;
  reviewToggle.setAttribute("aria-expanded", "true");
  const tabs = visibleTabs();
  return selectTab(tabs.approvals ? "approvals" : "queue");
});
for (const button of reviewTabs) button.addEventListener("click", () => selectTab(button.dataset.reviewTab));
reviewAccount.addEventListener("change", loadReviewTab);
document.getElementById("review-refresh").addEventListener("click", loadReviewTab);
document.getElementById("review-close").addEventListener("click", reviewReset);
document.getElementById("logout-button").addEventListener("click", reviewReset);
