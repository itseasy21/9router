// Stacked compression pipeline for 9Router (OmniRoute-inspired subset).
//
// Runs the kept engines in stack order, mixing this dir's engines with
// 9Router's existing RTK / Headroom / Caveman savers. Every engine is
// independently toggleable and fail-open — a thrown error anywhere leaves
// the body untouched and just skips that engine.
//
// Kept engines (in stack order):
//   1 session-dedup → 3 lite → 5 responses-tool-output
//   (4 rtk*, 6 headroom*, 8 caveman* are invoked by chatCore as today.)
//
// Removed engines (formerly OmniRoute stacks #2 ccr, #7 relevance, #9
// aggressive, #11 ultra) — all deleted on quality grounds:
//   - ccr: elideMiddle() permanently discarded the middle of large prose
//     blocks (the "archive" in the marker was hash-only; no store, no
//     retrieval) — unattributed information loss on exactly the prose where
//     answers live.
//   - relevance: extractive sentence dropping against the last user query —
//     dropped unrecoverable facts that later turns depend on; RTK already
//     compresses the real bulk (tool results).
//   - aggressive: truncated assistant turns older than ~40 messages — the
//     long sessions where context matters most.
//   - ultra: filler-phrase rewriting with no recency guard — could mutate the
//     live user message (e.g. quoted phrases inside instructions).
// If a destructive engine is ever reintroduced it needs a real archive +
// retrieval path (ccr) or recency guards + an outcome eval (the others).

import { compressSessionDedup } from "./sessionDedup.js";
import { compressLite } from "./lite.js";
import { compressResponsesToolOutput } from "./responsesToolOutput.js";

const ENGINE_ORDER = [
  { id: "session-dedup", key: "sessionDedupEnabled", fn: compressSessionDedup },
  { id: "lite", key: "liteEnabled", fn: compressLite },
  { id: "responses-tool-output", key: "responsesToolOutputEnabled", fn: compressResponsesToolOutput },
];

// Runs the enabled engines in stack order over `body` (mutated in place).
// Returns an array of engine stats { engine, hits, savedChars } for logging.
export async function runCompressionPipeline(body, enabledMap = {}) {
  const stats = [];
  if (!body || typeof body !== "object") return stats;
  for (const e of ENGINE_ORDER) {
    if (!enabledMap[e.key]) continue; // off by default; each engine individually toggleable
    try {
      const s = e.fn(body);
      if (s && s.hits > 0) stats.push(s);
    } catch (err) {
      // fail-open: log-and-continue, body stays whatever prior engines left
      try { console.warn(`[compression:${e.id}] skipped:`, err?.message || String(err)); } catch { /* logger off */ }
    }
  }
  return stats;
}

// Single log line for the "⚙" token-saver accumulator in chatCore.
export function formatCompressionLog(stats) {
  if (!stats || stats.length === 0) return null;
  const total = stats.reduce((a, s) => a + (s.savedChars || 0), 0);
  const hits = stats.reduce((a, s) => a + (s.hits || 0), 0);
  const engines = stats.map((s) => s.engine).join(",");
  return `saved ${total} chars via [${engines}] hits=${hits}`;
}

export { ENGINE_ORDER };
