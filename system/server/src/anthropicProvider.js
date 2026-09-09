// Anthropic Messages API adapter — implements the ModelProvider contract
// (modelProvider.js). Needs its own adapter rather than reusing
// openAiCompatibleProvider.js because Anthropic's request/response shape
// genuinely differs: a top-level `system` field instead of a system-role
// message, and typed content blocks instead of a plain string in the
// response (docs/CODING_ROADMAP.md MS8.1.4).

import { assertValidStructuredDecision, parseDecisionJson } from "./modelProvider.js";
import { observationForText } from "./observationPackage.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 30000;
const ANTHROPIC_VERSION = "2023-06-01";

// Kept minimal and instructional rather than embedding real task/research
// context here — that belongs to MS8.2's observation package, not this
// adapter. This adapter's only job is "call the vendor, get JSON back."
const SYSTEM_PROMPT = `You are the perception/planning step of an authorized, supervised phone-farm content-research assistant. Given an observation of the current device screen, respond with ONLY a JSON object matching this exact shape and nothing else:
{"screen_state": string, "goal_progress": string, "action": string, "target": string|null, "reason": string, "confidence": number between 0 and 1, "candidate"?: {"platform_content_id"?: string, "canonical_url"?: string, "source_handle"?: string, "text_extract"?: string, "ai_summary"?: string, "selection_reason"?: string, "score"?: number between 0 and 1, "tags"?: string[], "evidence_refs"?: string[]}}
Include candidate only for a verified visible discovery; goal_progress "candidate_found" requires it and it must contain platform_content_id or canonical_url. Do not invent other fields. Do not wrap the JSON in markdown code fences or add commentary.`;

export class AnthropicProvider {
  constructor({ name = "anthropic", model, baseUrl = DEFAULT_BASE_URL, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.name = name;
    this.model = model;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async observeAndPlan(observation) {
    if (!this.apiKey) throw new Error(`${this.name}: no API key configured`);
    const content = [{ type: "text", text: JSON.stringify(observationForText(observation)) }];
    if (observation?.screenshot) {
      content.push({ type: "image", source: { type: "base64", media_type: observation.screenshot.mime, data: observation.screenshot.data } });
    }
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: observation?.screenshot ? content : content[0].text }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status}`);
    const body = await res.json();
    const text = body.content?.find((block) => block.type === "text")?.text;
    if (!text) throw new Error(`${this.name}: response had no text content block`);
    return assertValidStructuredDecision(parseDecisionJson(text, this.name), this.name);
  }
}
