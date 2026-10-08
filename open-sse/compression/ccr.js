// CCR engine — OmniRoute stack #2 (Content-Compress-Retrieve, "H4"). Replaces
// very large contiguous text blocks with a content-addressed marker, so a big
// block is sent once instead of repeatedly. Unlike OmniRoute we cannot call a
// retrieve tool back (9Router does not own a ccr_retrieve tool), so the archive
// is bounded: we keep a head+tail window inline and elide only the safe middle.
// Fail-open; code blocks and URLs are never elided.

import { collectTextTargets, isLikelyCodeOrData } from "./textTargets.js";
import { createHash } from "node:crypto";

const DEFAULT_MIN_BLOCK_CHARS = 2000;   // only archive genuinely large blocks
const DEFAULT_KEEP_HEAD = 40;           // inline head lines kept
const DEFAULT_KEEP_TAIL = 15;           // inline tail lines kept

function sha24(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

// Elide the middle of a large prose block, keeping head and tail intact.
function elideMiddle(text, keepHead, keepTail) {
  const lines = text.split("\n");
  if (lines.length <= keepHead + keepTail + 3) return null; // nothing to elide
  const head = lines.slice(0, keepHead);
  const tail = lines.slice(lines.length - keepTail);
  const cut = lines.length - head.length - tail.length;
  const archived = lines.slice(keepHead, lines.length - keepTail).join("\n");
  const marker =
    `[ccr:archive sha=${sha24(archived)} lines=${cut}] ` +
    `middle of this block elided; ${head[0]?.trim().slice(0, 80) || "context"}… head/tail retained below.`;
  return [...head, marker, ...tail].join("\n");
}

export function compressCcr(body, { minBlockChars = DEFAULT_MIN_BLOCK_CHARS, keepHead = DEFAULT_KEEP_HEAD, keepTail = DEFAULT_KEEP_TAIL } = {}) {
  try {
    const targets = collectTextTargets(body);
    if (!targets) return null;
    let saved = 0;
    let hits = 0;
    for (const t of targets) {
      for (const part of t.parts) {
        const text = part.obj[part.key];
        if (typeof text !== "string" || text.length < minBlockChars) continue;
        if (isLikelyCodeOrData(text)) continue; // preserve code & structured data byte-perfect
        const next = elideMiddle(text, keepHead, keepTail);
        if (next && next.length < text.length) {
          saved += text.length - next.length;
          hits++;
          try { part.obj[part.key] = next; } catch { /* frozen — skip */ }
        }
      }
    }
    if (hits === 0) return null;
    return { engine: "ccr", hits, savedChars: saved };
  } catch {
    return null;
  }
}
