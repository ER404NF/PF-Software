// Search and near-duplicate detection over recorded research candidates (roadmap MS13.4).
//
// Exact duplicates are already caught by URL/content id. This finds the rest: the same
// post re-shared under a new link, a repost with a different handle, a caption that is 90%
// the same. Search is a small in-memory inverted index with TF-IDF-style scoring; it is
// rebuilt from the account's own runs, so it can only ever return that account's records.

const STOP = new Set("the a an and or of to in on for with is are was were be been it this that at by from as but not you your we they i me my our".split(" "));

export function tokenize(text) {
  return String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9#@]+/).filter(word => word.length >= 3 && !STOP.has(word));
}

function candidateTokens(candidate) {
  return tokenize([candidate.text_extract, candidate.ai_summary, candidate.selection_reason, candidate.source_handle,
    candidate.niche, ...(candidate.tags ?? [])].filter(Boolean).join(" "));
}

// What a post actually SAYS. Tags and handles differ between a repost and the original.
function contentTokens(candidate) {
  return tokenize([candidate.text_extract, candidate.ai_summary].filter(Boolean).join(" "));
}

function shingles(tokens, size = 3) {
  const set = new Set();
  if (tokens.length < size) { if (tokens.length) set.add(tokens.join(" ")); return set; }
  for (let index = 0; index <= tokens.length - size; index += 1) set.add(tokens.slice(index, index + size).join(" "));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export class ResearchIndex {
  constructor() {
    this.docs = new Map();      // id -> { candidate, tokens, shingles }
    this.postings = new Map();  // token -> Set(id)
  }

  static fromRuns(runs = []) {
    const index = new ResearchIndex();
    for (const run of runs) for (const candidate of run.candidates ?? []) index.add({ ...candidate, run_id: candidate.run_id ?? run.id });
    return index;
  }

  add(candidate) {
    if (!candidate?.id) return;
    const tokens = candidateTokens(candidate);
    this.docs.set(candidate.id, { candidate, tokens, shingles: shingles(contentTokens(candidate)) });
    for (const token of new Set(tokens)) {
      if (!this.postings.has(token)) this.postings.set(token, new Set());
      this.postings.get(token).add(candidate.id);
    }
  }

  get size() {
    return this.docs.size;
  }

  search(query, { limit = 20 } = {}) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const total = this.docs.size || 1;
    const scores = new Map();
    for (const term of terms) {
      const ids = this.postings.get(term);
      if (!ids) continue;
      const idf = Math.log(1 + total / ids.size);
      for (const id of ids) {
        const doc = this.docs.get(id);
        const frequency = doc.tokens.filter(token => token === term).length / Math.max(1, doc.tokens.length);
        scores.set(id, (scores.get(id) ?? 0) + idf * (0.5 + frequency));
      }
    }
    return [...scores].map(([id, score]) => ({ score: Math.round(score * 1000) / 1000, candidate: this.docs.get(id).candidate }))
      .sort((a, b) => b.score - a.score || String(a.candidate.id).localeCompare(String(b.candidate.id))).slice(0, limit);
  }

  // Other candidates whose text is substantially the same as this one.
  findNearDuplicates(candidate, { threshold = 0.6 } = {}) {
    const mine = shingles(contentTokens(candidate));
    return [...this.docs.values()]
      .filter(doc => doc.candidate.id !== candidate.id)
      .map(doc => ({ similarity: Math.round(jaccard(mine, doc.shingles) * 1000) / 1000, candidate: doc.candidate }))
      .filter(match => match.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity);
  }
}
