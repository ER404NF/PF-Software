// Cached platform-state detection (roadmap MS13.3). Deciding which screen the app is on
// means parsing the whole accessibility tree, and the same screen is observed again
// and again (a paused feed, a step that changed nothing). Detection is a pure function
// of the tree, so identical trees can share one answer.
//
// A cache like this must never be able to make the AI act on a stale belief, so:
//  - the key is a hash of the COMPLETE tree, not a summary of it: any visible change is a miss;
//  - a challenge screen ("security_challenge") is never served from cache;
//  - detection errors are never cached.

import crypto from "node:crypto";

export function observationFingerprint(observation) {
  const source = observation?.ui_tree ?? observation?.screenshot?.data ?? null;
  if (source === null || source === undefined) return null;
  const text = typeof source === "string" ? source : JSON.stringify(source);
  return crypto.createHash("sha256").update(text).digest("hex");
}

export class StateCache {
  constructor({ maxEntries = 64 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map(); // fingerprint -> state (insertion order = recency)
    this.hits = 0;
    this.misses = 0;
  }

  get(fingerprint) {
    if (!this.entries.has(fingerprint)) return undefined;
    const state = this.entries.get(fingerprint);
    this.entries.delete(fingerprint);
    this.entries.set(fingerprint, state); // most recently used
    return state;
  }

  set(fingerprint, state) {
    this.entries.set(fingerprint, state);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }

  get hitRate() {
    const total = this.hits + this.misses;
    return total ? this.hits / total : 0;
  }
}

const NEVER_CACHED = new Set(["security_challenge"]);

// Returns a skill whose detectState() consults the cache. Everything else is untouched.
export function withStateCache(skill, cache = new StateCache()) {
  return {
    ...skill,
    stateCache: cache,
    async detectState(observation) {
      const fingerprint = observationFingerprint(observation);
      if (fingerprint) {
        const cached = cache.get(fingerprint);
        if (cached !== undefined) {
          cache.hits += 1;
          return cached;
        }
      }
      cache.misses += 1;
      const state = await skill.detectState(observation); // throws are not cached
      if (fingerprint && !NEVER_CACHED.has(state)) cache.set(fingerprint, state);
      return state;
    },
    // The wrapped methods call this.detectState in some skills; keep them bound to the base skill.
    availableActions: (...args) => skill.availableActions(...args),
    execute: (...args) => skill.execute(...args),
    verify: (...args) => skill.verify(...args),
    recover: (...args) => skill.recover(...args),
  };
}
