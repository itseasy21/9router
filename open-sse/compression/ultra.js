// Ultra engine — OmniRoute stack #11. Heuristic token pruning (deterministic
// tier — no optional SLM dependency): drops filler/hedging phrases, collapses
// boilerplate lead-ins ("Certainly!", "Here's what I found:"), and trims
// redundant connective phrases from prose. Code fences, URLs and structured
// data are preserved. Fail-open.

import { collectTextTargets, isLikelyCodeOrData } from "./textTargets.js";

const FILLER_PATTERNS = [
  /\b(certainly|of course|sure thing|happily|gladly)\b[,!.]*/gi,
  /\b(i'd be happy to|i would be happy to|let me know if you(?:'d| would) (?:like|want)|don't hesitate to ask)\b[^.!?]*[.!?]/gi,
  /\b(basically|actually|simply|really|literally|essentially|obviously|clearly)\b[,;]?\s/gi,
  /\b(it (?:is|'s) (?:worth|important) (?:noting|mentioning) that|it should be noted that|please note that)\b\s*/gi,
  /\b(in order to)\b/gi,          // → "to"
  /\b(due to the fact that)\b/gi, // → "because"
  /\b(at this point in time|at the present moment)\b/gi, // → "now"
  /\b(a (?:large )?number of)\b/gi, // → "many"
  /\b(here(?:'s| is) (?:what|the) (?:i found|result|summary)[: ]*)/gi,
];

const MIN_TEXT_CHARS = 100;

function ultraText(text) {
  if (typeof text !== "string" || text.length < MIN_TEXT_CHARS) return null;
  if (isLikelyCodeOrData(text)) return null;

  // Process non-fenced segments only: fenced code is preserved byte-perfect.
  const segments = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  let changed = false;
  const out = segments.map((seg) => {
    if (seg.startsWith("```") || seg.startsWith("~~~")) return seg;
    let s = seg;
    for (const re of FILLER_PATTERNS) {
      const next = s.replace(re, (match, ...rest) => {
        // phrase-level replacements keep a minimal connecting word
        const src = re.source;
        if (src.includes("in order to")) return "to";
        if (src.includes("due to the fact")) return "because";
        if (src.includes("at this point") || src.includes("at the present")) return "now";
        if (src.includes("number of")) return "many";
        return "";
      });
      if (next !== s) { changed = true; s = next; }
    }
    // collapse whitespace left by removals
    const cleaned = s.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
    if (cleaned !== s) { changed = true; s = cleaned; }
    return s;
  });
  if (!changed) return null;
  const next = out.join("");
  if (next.length >= text.length) return null;
  return next;
}

export function compressUltra(body) {
  try {
    const targets = collectTextTargets(body);
    if (!targets) return null;
    let saved = 0;
    let hits = 0;
    for (const t of targets) {
      for (const part of t.parts) {
        const text = part.obj[part.key];
        const next = ultraText(text);
        if (next) {
          saved += text.length - next.length;
          hits++;
          try { part.obj[part.key] = next; } catch { /* frozen */ }
        }
      }
    }
    if (hits === 0) return null;
    return { engine: "ultra", hits, savedChars: saved };
  } catch {
    return null;
  }
}
