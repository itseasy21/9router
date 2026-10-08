// Lite engine — OmniRoute stack #3. Latency-light baseline: strip trailing
// whitespace, collapse runs of 3+ blank lines to one, and trim whitespace-only
// text. Never reflows code or structured data (only safe whitespace edits that
// survive inside fenced blocks too — those blocks are skipped entirely anyway).

import { collectTextTargets, isLikelyCodeOrData } from "./textTargets.js";

const TRAILING_WS = /[ \t]+$/gm;

function liteText(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  // Fence-aware: only whitespace-normalize non-fenced segments; code blocks
  // stay byte-perfect (OmniRoute preservation contract).
  const segments = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  let changed = false;
  const out = segments.map((seg) => {
    if (seg.startsWith("```") || seg.startsWith("~~~")) return seg;
    let next = seg.replace(TRAILING_WS, "");
    next = next.replace(/\n{3,}/g, "\n\n");
    if (next !== seg) changed = true;
    return next;
  });
  if (!changed) return null;
  const next = out.join("");
  if (next.length >= text.length) return null;
  return next;
}

export function compressLite(body) {
  try {
    const targets = collectTextTargets(body);
    if (!targets) return null;
    let saved = 0;
    let hits = 0;
    for (const t of targets) {
      for (const part of t.parts) {
        const text = part.obj[part.key];
        if (typeof text !== "string") continue;
        if (isLikelyCodeOrData(text)) continue;
        const next = liteText(text);
        if (next) {
          saved += text.length - next.length;
          hits++;
          try { part.obj[part.key] = next; } catch { /* frozen — skip */ }
        }
      }
    }
    if (hits === 0) return null;
    return { engine: "lite", hits, savedChars: saved };
  } catch {
    return null;
  }
}
