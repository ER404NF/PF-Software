// Timed autonomous research sessions (roadmap MS11): scoring profiles, quotas and stop
// conditions, cost/latency tracking, and the session report a supervisor reads
// afterwards. Pure logic with no clock or I/O of its own, so it is fully testable and a
// restart can rebuild a session's budget from the task's checkpoints (MS11.4).

const clamp01 = value => Math.min(1, Math.max(0, value));

// ---- scoring profiles (FUTURE_AI_VA_SPEC §12) ----------------------------------------

export const DEFAULT_SCORING_PROFILE = Object.freeze({
  name: "default",
  weights: { relevance: 0.5, engagement: 0.3, recency: 0.2 },
  keywords: [],
  engagementReference: 10_000, // interactions that count as "very engaging"
  recencyHours: 48,            // older than this scores 0 for recency
  minScore: 0.4,               // below this a candidate is not worth keeping
});

function candidateText(candidate) {
  return [candidate.text_extract, candidate.ai_summary, candidate.selection_reason, candidate.source_handle, candidate.niche,
    ...(candidate.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
}

// Returns { score: 0..1, parts } so a reviewer can see WHY something scored what it did.
export function scoreCandidate(candidate, profile = DEFAULT_SCORING_PROFILE) {
  const settings = { ...DEFAULT_SCORING_PROFILE, ...profile, weights: { ...DEFAULT_SCORING_PROFILE.weights, ...profile?.weights } };
  const keywords = (settings.keywords ?? []).map(word => String(word).toLowerCase()).filter(Boolean);
  const text = candidateText(candidate);
  const relevance = keywords.length ? keywords.filter(word => text.includes(word)).length / keywords.length : 0.5;

  const metrics = candidate.metrics ?? {};
  const interactions = Number(metrics.likes ?? 0) + 2 * Number(metrics.comments ?? 0) + 3 * Number(metrics.shares ?? metrics.reposts ?? 0);
  const engagement = interactions > 0 ? clamp01(Math.log10(1 + interactions) / Math.log10(1 + settings.engagementReference)) : 0;

  const ageHours = Number(metrics.age_hours);
  const recency = Number.isFinite(ageHours) ? clamp01(1 - ageHours / settings.recencyHours) : 0.5;

  const parts = { relevance, engagement, recency };
  const totalWeight = Object.values(settings.weights).reduce((sum, weight) => sum + weight, 0) || 1;
  const score = Object.entries(parts).reduce((sum, [name, value]) => sum + value * (settings.weights[name] ?? 0), 0) / totalWeight;
  return { score: Math.round(clamp01(score) * 1000) / 1000, parts, keep: score >= settings.minScore };
}

// ---- budget, quotas and stop conditions -----------------------------------------------

export const SESSION_OUTCOMES = Object.freeze({ SUCCEEDED: "SUCCEEDED", PARTIAL: "PARTIAL", EXPIRED: "EXPIRED", FAILED: "FAILED_FINAL" });

export const DEFAULT_SESSION_QUOTA = Object.freeze({
  maxCandidates: 20,        // enough good candidates found: the session has done its job
  maxSteps: 200,            // hard ceiling on device/model steps
  maxCostUsd: 5,            // model spend ceiling for one session
  maxMinutes: 60,           // wall-clock ceiling measured from the session's first step
  maxConsecutiveFailures: 5, // something is broken; stop and report instead of hammering the phone
});

export class SessionBudget {
  constructor({ quota = {}, now = () => Date.now(), state = null } = {}) {
    this.quota = { ...DEFAULT_SESSION_QUOTA, ...quota };
    this.now = now;
    this.state = {
      startedAt: null, steps: 0, candidates: 0, keptCandidates: 0, costUsd: 0, consecutiveFailures: 0,
      actions: {}, latencies: [], failures: [], recoveries: [], ...(state ?? {}),
    };
  }

  // A restart resumes from what was checkpointed, so a session never gets a fresh budget by crashing.
  static fromCheckpoints(checkpoints = [], options = {}) {
    const last = [...checkpoints].reverse().find(entry => entry?.data?.recordType === "session_budget");
    return new SessionBudget({ ...options, state: last?.data?.state ?? null });
  }

  toCheckpoint() {
    return { recordType: "session_budget", state: structuredClone(this.state) };
  }

  start() {
    if (this.state.startedAt === null) this.state.startedAt = this.now();
  }

  recordStep({ action = null, ok = true, latencyMs = 0, costUsd = 0, candidate = null, keep = false, error = null } = {}) {
    this.start();
    this.state.steps += 1;
    this.state.costUsd = Math.round((this.state.costUsd + Math.max(0, Number(costUsd) || 0)) * 1e6) / 1e6;
    if (Number.isFinite(latencyMs) && latencyMs >= 0) this.state.latencies.push(Math.round(latencyMs));
    if (this.state.latencies.length > 1000) this.state.latencies.shift();
    if (action) this.state.actions[action] = (this.state.actions[action] ?? 0) + 1;
    if (candidate) {
      this.state.candidates += 1;
      if (keep) this.state.keptCandidates += 1;
    }
    if (ok) this.state.consecutiveFailures = 0;
    else {
      this.state.consecutiveFailures += 1;
      this.state.failures.push({ at: this.now(), action, error: String(error ?? "step failed").slice(0, 200) });
      if (this.state.failures.length > 50) this.state.failures.shift();
    }
  }

  // A candidate recorded during a step that was already counted.
  recordCandidate({ keep = false } = {}) {
    this.start();
    this.state.candidates += 1;
    if (keep) this.state.keptCandidates += 1;
  }

  recordRecovery(kind, detail = null) {
    this.state.recoveries.push({ at: this.now(), kind, detail });
    if (this.state.recoveries.length > 50) this.state.recoveries.shift();
  }

  minutesElapsed() {
    return this.state.startedAt === null ? 0 : (this.now() - this.state.startedAt) / 60_000;
  }

  // Should the session stop now, and how should it be recorded?
  check() {
    const { quota, state } = this;
    if (state.keptCandidates >= quota.maxCandidates) return { stop: true, outcome: SESSION_OUTCOMES.SUCCEEDED, reason: `candidate quota reached (${state.keptCandidates})` };
    if (state.consecutiveFailures >= quota.maxConsecutiveFailures) return { stop: true, outcome: SESSION_OUTCOMES.PARTIAL, reason: `${state.consecutiveFailures} failures in a row` };
    if (state.costUsd >= quota.maxCostUsd) return { stop: true, outcome: SESSION_OUTCOMES.PARTIAL, reason: `cost budget reached ($${state.costUsd.toFixed(2)})` };
    if (state.steps >= quota.maxSteps) return { stop: true, outcome: SESSION_OUTCOMES.PARTIAL, reason: `step budget reached (${state.steps})` };
    if (this.minutesElapsed() >= quota.maxMinutes) return { stop: true, outcome: state.steps > 0 ? SESSION_OUTCOMES.PARTIAL : SESSION_OUTCOMES.EXPIRED, reason: `time budget reached (${quota.maxMinutes} min)` };
    return { stop: false };
  }
}

// ---- reports (MS11.3) -----------------------------------------------------------------

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

// Everything a supervisor needs after an unattended window: what was found, what was
// done to the account, what it cost, how it went, and where a human was needed.
export function buildSessionReport({ run = null, task = null, budget, interventions = [], now = () => Date.now() } = {}) {
  const state = budget.state;
  const sorted = [...state.latencies].sort((a, b) => a - b);
  const candidates = (run?.candidates ?? []).map(candidate => ({
    id: candidate.id, url: candidate.canonical_url ?? candidate.url ?? null, handle: candidate.source_handle ?? null,
    score: candidate.score ?? null, reason: candidate.selection_reason ?? null,
    review: candidate.review_state ?? null, actions: (candidate.platform_actions ?? []).map(action => action.action),
  })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const platformActions = {};
  for (const candidate of run?.candidates ?? []) {
    for (const action of candidate.platform_actions ?? []) {
      const key = `${action.action}:${action.status ?? "unknown"}`;
      platformActions[key] = (platformActions[key] ?? 0) + 1;
    }
  }
  const verdict = budget.check();
  return {
    runId: run?.id ?? null,
    taskId: task?.id ?? null,
    platform: run?.platform ?? task?.accountSelector?.platform ?? null,
    outcome: run?.outcome ?? task?.state ?? (verdict.stop ? verdict.outcome : "RUNNING"),
    stoppedBecause: verdict.stop ? verdict.reason : null,
    startedAt: state.startedAt,
    minutes: Math.round(budget.minutesElapsed() * 10) / 10,
    steps: state.steps,
    candidates: { recorded: candidates.length, kept: state.keptCandidates, top: candidates.slice(0, 10) },
    actions: { byType: { ...state.actions }, platformVisible: platformActions },
    cost: {
      totalUsd: Math.round(state.costUsd * 10000) / 10000,
      perCandidateUsd: state.keptCandidates ? Math.round((state.costUsd / state.keptCandidates) * 10000) / 10000 : null,
      perStepUsd: state.steps ? Math.round((state.costUsd / state.steps) * 10000) / 10000 : null,
    },
    latencyMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), average: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null },
    failures: state.failures.slice(-10),
    recoveries: state.recoveries.slice(-10),
    interventions: interventions.map(item => ({ kind: item.kind, reason: item.reason, state: item.state, at: item.createdAt })),
    generatedAt: now(),
  };
}
