// Relevance engine — OmniRoute stack #7. Extractive sentence scoring: rank
// sentence/paragraph units against the last user query (term-overlap, BM25-lite
// with light IDF) and drop low-scoring units from older messages. Code fences,
// URLs and the most recent messages are always protected. Fail-open.

import { collectTextTargets, splitSentences } from "./textTargets.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are",
  "was", "were", "be", "been", "at", "by", "it", "this", "that", "as", "from", "but",
  "not", "do", "does", "did", "so", "if", "then", "than", "too", "very", "can",
  "will", "just", "should", "now", "you", "your", "we", "our", "they", "their",
  "he", "she", "his", "her", "its", "about", "into", "over", "after",
]);

const DEFAULT_LAST_USER_PROTECTED = 2;  // never touch the most recent N messages
const DEFAULT_THRESHOLD = 0.08;         // min normalized score to keep a unit
const MIN_TEXT_CHARS = 400;             // only prune texts long enough to matter

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function lastUserQuery(targets) {
  const parts = targets.flatMap((t) => t.parts);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].role === "user") return String(parts[i].obj[parts[i].key] || "");
  }
  return "";
}

function scoreUnits(units, queryTokens) {
  const qSet = new Set(queryTokens);
  if (qSet.size === 0) return null; // no query → cannot score → fail-open
  // Document frequency over units for a light IDF term.
  const df = new Map();
  for (const u of units) {
    const seen = new Set(tokenize(u));
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const nUnits = Math.max(units.length, 1);
  return units.map((u) => {
    const toks = tokenize(u);
    if (toks.length === 0) return 0;
    let score = 0;
    const seen = new Set(toks);
    for (const t of seen) {
      const idf = Math.log(1 + nUnits / (1 + (df.get(t) || 0)));
      if (qSet.has(t)) score += idf;
    }
    // normalize by length so long sentences don't win via sheer mass
    return score / Math.sqrt(toks.length);
  });
}

export function compressRelevance(body, { lastUserProtected = DEFAULT_LAST_USER_PROTECTED, threshold = DEFAULT_THRESHOLD, minChars = MIN_TEXT_CHARS } = {}) {
  try {
    const targets = collectTextTargets(body);
    if (!targets) return null;
    const queryTokens = tokenize(lastUserQuery(targets));
    if (queryTokens.length === 0) return null;

    let saved = 0;
    let hits = 0;
    let protectedCount = 0;
    for (let ti = targets.length - 1; ti >= 0; ti--) {
      const t = targets[ti];
      protectedCount++; // one message group per target
      if (protectedCount <= lastUserProtected) continue;
      for (const part of t.parts) {
        const text = part.obj[part.key];
        if (typeof text !== "string" || text.length < minChars) continue;
        if (/^```|^~~~/.test(text.trim())) continue; // fenced code preserved

        const units = splitSentences(text);
        if (units.length < 3) continue;
        const scores = scoreUnits(units, queryTokens);
        if (!scores) continue;

        const kept = units.map((_, i) => (scores[i] >= threshold ? units[i] : null));
        // Never drop the first unit (topic anchor) or final unit (resolution).
        kept[0] = units[0];
        kept[kept.length - 1] = units[units.length - 1];
        const next = kept.filter(Boolean).join(" ");
        // Must shrink materially (>2%) or we leave the text alone.
        if (next.length >= text.length * 0.98) continue;
        saved += text.length - next.length;
        hits++;
        try { part.obj[part.key] = next; } catch { /* frozen */ }
      }
    }
    if (hits === 0) return null;
    return { engine: "relevance", hits, savedChars: saved };
  } catch {
    return null;
  }
}
