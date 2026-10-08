// OmniRoute-style stacked compression pipeline for 9Router.
//
// Runs the 12-engine stack subset in OmniRoute's documented pipeline order,
// mixing the new engines (this dir) with 9Router's existing RTK / Headroom /
// Caveman savers. Every engine is independently toggleable and fail-open —
// a thrown error anywhere leaves the body untouched and just skips that engine.
//
// Order follows OmniRoute's stack numbering:
//   1 session-dedup → 2 ccr → 3 lite → 4 rtk* → 5 responses-tool-output
//   → 6 headroom* → 7 relevance → 8 caveman* → 9 aggressive → 11 ultra
//   (* = existing 9Router savers, invoked by chatCore as today;
//    #10 LLMLingua-2 and #12 OmniGlyph are intentionally not implemented —
//    they need ONNX / image-wire support and are left as future work.)
//
// This module only handles engines 1,2,3,5,7,9,11. chatCore keeps invoking
// RTK/headroom/caveman/ponytail/pxpipe itself so existing logging + stats
// accumulation stays byte-for-byte identical for existing users.

import { compressSessionDedup } from "./sessionDedup.js";
import { compressCcr } from "./ccr.js";
import { compressLite } from "./lite.js";
import { compressResponsesToolOutput } from "./responsesToolOutput.js";
import { compressRelevance } from "./relevance.js";
import { compressAggressive } from "./aggressive.js";
import { compressUltra } from "./ultra.js";

const ENGINE_ORDER = [
  { id: "session-dedup", key: "sessionDedupEnabled", fn: compressSessionDedup },
  { id: "ccr", key: "ccrEnabled", fn: compressCcr },
  { id: "lite", key: "liteEnabled", fn: compressLite },
  { id: "responses-tool-output", key: "responsesToolOutputEnabled", fn: compressResponsesToolOutput },
  { id: "relevance", key: "relevanceEnabled", fn: compressRelevance },
  { id: "aggressive", key: "aggressiveEnabled", fn: compressAggressive },
  { id: "ultra", key: "ultraEnabled", fn: compressUltra },
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
