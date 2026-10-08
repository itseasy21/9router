// Session-Dedup engine — OmniRoute stack #1. Content-addressed cross-turn dedup:
// elides text in later messages that already appeared verbatim in earlier turns.
// The earlier turn is still in context, so the model can recover the content —
// matching OmniRoute's TokenMizer-inspired behavior.

import { collectTextTargets } from "./textTargets.js";

const MIN_CHUNK_CHARS = 80; // ignore tiny fragments (headers, short lines)

function hashText(s) {
  // 32-bit FNV-1a over the chunk text — cheap and stable per process.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Split a message's text into chunks (paragraph level), then dedupe later
// occurrences. First occurrence per session stays verbatim; later repeats get
// replaced by a marker pointing back.
function dedupeText(text, seen) {
  if (typeof text !== "string" || text.length < MIN_CHUNK_CHARS) return null;
  const paras = text.split(/\n\n+/);
  let changed = false;
  const out = paras.map((p) => {
    const trimmed = p.trim();
    if (trimmed.length < MIN_CHUNK_CHARS) return p;
    const h = hashText(trimmed);
    if (seen.has(h)) {
      changed = true;
      // Marker must be much shorter than the elided chunk or there is no saving.
      return `[session-dedup:ref sha=${h}]`;
    }
    seen.add(h);
    return p;
  });
  return changed ? out.join("\n\n") : null;
}

// Walk targets in request order (earlier → later). Each target may hold several
// text parts; parts of one message share one "turn".
export function compressSessionDedup(body, { minChunkChars = MIN_CHUNK_CHARS } = {}) {
  try {
    const targets = collectTextTargets(body);
    if (!targets) return null;
    const seen = new Set();
    let saved = 0;
    let hits = 0;
    for (const t of targets) {
      for (const part of t.parts) {
        const before = part.obj[part.key];
        if (typeof before !== "string") continue;
        const next = dedupeText(before, seen);
        if (next && next.length < before.length) {
          saved += before.length - next.length;
          hits++;
          try { part.obj[part.key] = next; } catch { /* frozen — skip */ }
        }
      }
    }
    if (hits === 0) return null;
    return { engine: "session-dedup", hits, savedChars: saved };
  } catch {
    return null; // fail-open
  }
}
