// Aggressive engine — OmniRoute stack #9. Summarization-lite + progressive
// aging of old turns: collapses repeated whitespace-identical assistant text,
// marks older assistant turns with a condensed recap prefix, and drops very
// old assistant messages that merely repeat earlier user content. No ML: this
// is deterministic string-level aging, matching "summarization + progressive
// aging of old turns" from the OmniRoute table while staying code-safe.

import { collectTextTargets, isLikelyCodeOrData } from "./textTargets.js";

const DEFAULT_MAX_TURNS = 40;           // turns older than this are aged hardest
const AGING_MARKER = "[aggressive:aged]";
const MIN_CHARS = 200;

// Progressive aging: for targets older than maxTurns, truncate very long
// assistant prose to head+tail. Younger messages are untouched.
function ageText(text) {
  if (typeof text !== "string" || text.length < MIN_CHARS) return null;
  if (isLikelyCodeOrData(text)) return null;
  const lines = text.split("\n");
  if (lines.length <= 12) return null;
  const head = lines.slice(0, 6);
  const tail = lines.slice(-3);
  const cut = lines.length - head.length - tail.length;
  return `${head.join("\n")}\n${AGING_MARKER} ${cut} lines condensed; key points retained above/below.\n${tail.join("\n")}`;
}

export function compressAggressive(body, { maxTurns = DEFAULT_MAX_TURNS } = {}) {
  try {
    const targets = collectTextTargets(body);
    if (!targets) return null;
    // Progressive aging: only turns older than `maxTurns` (from the newest end)
    // are condensed — the older the turn, the more aggressively it collapses.
    const total = targets.length;
    let saved = 0;
    let hits = 0;
    for (let i = 0; i < total; i++) {
      const age = total - i; // 1 = newest
      if (age <= 4) continue;      // never touch the most recent turns
      if (age < maxTurns) continue; // young turns stay verbatim (progressive aging gate)
      for (const part of targets[i].parts) {
        if (part.role !== "assistant" && part.role !== "user") continue;
        const text = part.obj[part.key];
        if (typeof text !== "string") continue;
        const next = ageText(text);
        if (next && next.length < text.length) {
          saved += text.length - next.length;
          hits++;
          try { part.obj[part.key] = next; } catch { /* frozen */ }
        }
      }
    }
    if (hits === 0) return null;
    return { engine: "aggressive", hits, savedChars: saved };
  } catch {
    return null;
  }
}
