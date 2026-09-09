// ModelProvider interface (CLAUDE.md §6, docs/CODING_ROADMAP.md MS8.1,
// docs/FUTURE_AI_VA_SPEC.md §3/§14): the only way the future AI VA worker
// reaches a language/vision model. Every adapter (Anthropic,
// OpenAI-compatible, a future local model, ...) implements this same shape
// so the scheduler, action validator, and platform-skill layer never see a
// vendor-specific request/response shape — swapping providers is a config
// change (providerRegistry.js / models.config.json), not a code change.
//
// No implementation lives here — see anthropicProvider.js and
// openAiCompatibleProvider.js for the two adapters this milestone requires
// (MS8.1.4). This module only defines the contract:
//
//   interface ModelProvider {
//     name: string;
//     observeAndPlan(observation: object): Promise<StructuredDecision>;
//   }
//
// `observation` is intentionally provider-agnostic: whatever MS8.2's
// observation package eventually produces (accessibility tree preferred,
// screenshot fallback per Architecture Baseline.md's stated order) plus the
// task's goal text. This module does not depend on MS8.2 existing yet — the
// contract only cares about the shape of what comes back, not what goes in.

const REQUIRED_STRING_FIELDS = ["screen_state", "goal_progress", "action", "reason"];

function validCandidate(candidate, providerName) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`${providerName} decision "candidate" must be an object`);
  }
  const contentId = candidate.platform_content_id;
  const canonicalUrl = candidate.canonical_url;
  if ((typeof contentId !== "string" || !contentId.trim())
    && (typeof canonicalUrl !== "string" || !canonicalUrl.trim())) {
    throw new Error(`${providerName} decision candidate requires platform_content_id or canonical_url`);
  }
  if (contentId != null && (typeof contentId !== "string" || !contentId.trim() || contentId.length > 500)) {
    throw new Error(`${providerName} decision candidate has invalid platform_content_id`);
  }
  if (canonicalUrl != null) {
    try {
      const url = new URL(canonicalUrl);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || canonicalUrl.length > 2048) throw new Error();
    } catch {
      throw new Error(`${providerName} decision candidate has invalid canonical_url`);
    }
  }
  for (const field of ["source_handle", "text_extract", "ai_summary", "selection_reason"]) {
    if (candidate[field] != null && typeof candidate[field] !== "string") {
      throw new Error(`${providerName} decision candidate "${field}" must be a string or null`);
    }
  }
  if (candidate.score != null && (typeof candidate.score !== "number" || !Number.isFinite(candidate.score)
    || candidate.score < 0 || candidate.score > 1)) {
    throw new Error(`${providerName} decision candidate "score" must be between 0 and 1`);
  }
  for (const field of ["tags", "evidence_refs"]) {
    if (candidate[field] != null && (!Array.isArray(candidate[field])
      || !candidate[field].every((value) => typeof value === "string" && value.trim()))) {
      throw new Error(`${providerName} decision candidate "${field}" must be an array of non-empty strings`);
    }
  }
}

// docs/FUTURE_AI_VA_SPEC.md §3's example decision, used as the fixture input
// for provider-adapter contract tests. Never send this to a real vendor
// outside of a test against fixtures/fake-model-server.js — it's not a real
// task and burns a real API call for nothing.
export const FIXTURE_OBSERVATION = Object.freeze({
  goal: "Find strong short-form hooks in the last 24 hours",
  screen_state: "instagram_reel",
  ui_tree: null,
  screenshot_ref: null,
  platform: "instagram",
});

// Throws with a specific, actionable message rather than returning a bool —
// a provider returning a malformed decision is a bug in that adapter (or in
// the model's output), not a recoverable condition callers should silently
// branch on. Downstream (MS8.3's action validator) can assume that any
// StructuredDecision it sees already passed this.
export function assertValidStructuredDecision(decision, providerName = "provider") {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error(`${providerName} returned a non-object decision`);
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof decision[field] !== "string" || decision[field].trim() === "") {
      throw new Error(`${providerName} decision missing required string field "${field}"`);
    }
  }
  if (decision.target !== null && typeof decision.target !== "string") {
    throw new Error(`${providerName} decision "target" must be a string or null`);
  }
  if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence)
    || decision.confidence < 0 || decision.confidence > 1) {
    throw new Error(`${providerName} decision "confidence" must be a number between 0 and 1`);
  }
  if (decision.candidate != null) validCandidate(decision.candidate, providerName);
  if (decision.goal_progress.trim().toLowerCase() === "candidate_found" && decision.candidate == null) {
    throw new Error(`${providerName} decision with goal_progress "candidate_found" requires candidate details`);
  }
  if (decision.candidate != null && !["observe", "capture", "capture_screenshot", "extract_visible"].includes(decision.action)) {
    throw new Error(`${providerName} decision candidates require a non-navigating observation action`);
  }
  return decision;
}

// Shared response parsing: both adapters instruct the model to reply with
// raw JSON text (no markdown fences) and this turns that into a decision
// object, with one error message shape regardless of vendor — kept here
// rather than duplicated per adapter so the two copies can't drift.
export function parseDecisionJson(text, providerName) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${providerName}: response was not valid JSON: ${String(text).slice(0, 200)}`);
  }
}

// MS8.1.6's "minimum contract test every provider adapter must pass" — each
// adapter's own test file calls this against a real instance (talking to
// fixtures/fake-model-server.js, never a live vendor) so a fifth vendor can
// be added later just by passing this, without touching anything upstream.
export async function assertProviderContract(provider) {
  if (typeof provider.name !== "string" || !provider.name) {
    throw new Error("provider must expose a non-empty string .name");
  }
  if (typeof provider.observeAndPlan !== "function") {
    throw new Error(`${provider.name} must implement observeAndPlan(observation)`);
  }
  const decision = await provider.observeAndPlan(FIXTURE_OBSERVATION);
  return assertValidStructuredDecision(decision, provider.name);
}
