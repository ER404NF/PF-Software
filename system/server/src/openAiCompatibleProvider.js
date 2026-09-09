// One adapter for every OpenAI-compatible chat-completions vendor. OpenAI
// (GPT), DeepSeek, Kimi (Moonshot), and NVIDIA NIM all expose the same
// request/response shape, differing only in base URL, model id, and API
// key — docs/CODING_ROADMAP.md MS8.1.4's "practical shortcut": one
// implementation covers all of them, configured per vendor via
// models.config.json (providerRegistry.js), not coded per vendor.

import { assertValidStructuredDecision, parseDecisionJson } from "./modelProvider.js";
import { observationForText } from "./observationPackage.js";

const DEFAULT_TIMEOUT_MS = 30000;

// Kept minimal and instructional rather than embedding real task/research
// context here — that belongs to MS8.2's observation package, not this
// adapter. This adapter's only job is "call the vendor, get JSON back."
const SYSTEM_PROMPT = `You are the perception/planning step of an authorized, supervised phone-farm content-research assistant. Given an observation of the current device screen, respond with ONLY a JSON object matching this exact shape and nothing else:
{"screen_state": string, "goal_progress": string, "action": string, "target": string|null, "reason": string, "confidence": number between 0 and 1, "candidate"?: {"platform_content_id"?: string, "canonical_url"?: string, "source_handle"?: string, "text_extract"?: string, "ai_summary"?: string, "selection_reason"?: string, "score"?: number between 0 and 1, "tags"?: string[], "evidence_refs"?: string[]}}
Include candidate only for a verified visible discovery; goal_progress "candidate_found" requires it and it must contain platform_content_id or canonical_url. Do not invent other fields. Do not wrap the JSON in markdown code fences or add commentary.`;

export class OpenAiCompatibleProvider {
  constructor({ name, model, baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!baseUrl) {
      throw new Error(`${name || "openai-compatible provider"}: baseUrl is required (e.g. https://api.openai.com/v1, https://api.deepseek.com, https://api.moonshot.cn/v1, an NVIDIA NIM endpoint)`);
    }
    this.name = name || "openai-compatible";
    this.model = model;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async observeAndPlan(observation) {
    if (!this.apiKey) throw new Error(`${this.name}: no API key configured`);
    const content = [{ type: "text", text: JSON.stringify(observationForText(observation)) }];
    if (observation?.screenshot) {
      content.push({ type: "image_url", image_url: { url: `data:${observation.screenshot.mime};base64,${observation.screenshot.data}` } });
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: observation?.screenshot ? content : content[0].text },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status}`);
    const body = await res.json();
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${this.name}: response had no message content`);
    return assertValidStructuredDecision(parseDecisionJson(text, this.name), this.name);
  }
}
